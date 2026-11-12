import { ZeroAddress, getAddress, zeroPadValue } from 'ethers';
import { FACTORY } from './config.mjs';
import { CORLA_ABI } from './corla.mjs';
import { CORLA_LAUNCH_TOPIC, decodeLaunchCandidate, isRpcLimit } from './events.mjs';

const MINTED = CORLA_ABI.getEvent('Minted').topicHash;
const MAX_FILTERED_RANGE = 50_000;
const MAX_LOG_RESULTS = 4096;
const RESULT_LIMIT_TTL_MS = 120_000;
const HISTORY_DEPTH = 8;
const MAX_REMEMBERED = 1024;
const history = new WeakMap();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const height = n => Number.isSafeInteger(n) && n >= 0;
const unix = n => Number.isSafeInteger(n) && n > 0 && n < 10_000_000_000;
const sorted = (a, b) => a.createdAt - b.createdAt;
function lots(value) {
  if (!(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ||
      (typeof value === 'string' && /^\d{1,78}$/.test(value)))) return null;
  const n = BigInt(value);
  return n > 0n ? n : null;
}
function job(entry) {
  const { project, snapshot } = entry ?? {};
  if (!project || !snapshot || snapshot.error || !same(project.factory, FACTORY) ||
      !same(project.mint, snapshot.mint) || !same(project.token, snapshot.token) ||
      !unix(project.createdAt) || !unix(project.fundingDeadline) || project.createdAt > project.fundingDeadline ||
      !height(snapshot.block)) return null;
  const total = lots(project.totalLots);
  if (total === null || lots(snapshot.totalLots) !== total || lots(snapshot.mintedLots) !== total) return null;
  try {
    const mint = getAddress(project.mint);
    const token = getAddress(project.token);
    if (mint === token || mint === ZeroAddress || token === ZeroAddress) return null;
    const launched = snapshot.launched === true;
    const pool = launched ? getAddress(snapshot.pool) : null;
    if (launched && (pool === ZeroAddress || pool === mint || pool === token)) return null;
    return { ...project, mint, token, pool, total, top: snapshot.block, launched,
      key: [mint.toLowerCase(), token.toLowerCase(), project.createdAt, project.fundingDeadline, total, pool].join(':') };
  } catch { return null; }
}
function addressBatches(rows) {
  const batches = [];
  for (const row of [...rows].sort(sorted)) {
    const last = batches.at(-1);
    if (!last || last.length >= 12 || row.createdAt - last[0].createdAt > 90 * 60) batches.push([row]);
    else last.push(row);
  }
  return batches;
}

// We only need a safe bracket, not the exact creation block. Jump near the
// expected block, then interpolate against real timestamps. Using known
// before/after blocks (including equal-timestamp BSC blocks) never skips a fill.
async function bracket(second, ceiling, block, side) {
  if (ceiling.timestamp < second) return [ceiling, ceiling];
  let lo, hi = ceiling, step = Math.max(32, Math.ceil((hi.timestamp - second) * 2.5) + 32);
  for (let i = 0; i < 12; i++) {
    if (side === 'before' && lo && second - lo.timestamp <= 90 || side === 'after' && hi.timestamp - second <= 90) break;
    if (hi.number === 0 || (lo && (hi.number - lo.number <= 32 || hi.timestamp - lo.timestamp <= 60))) break;
    const ratio = lo ? Math.max(.12, Math.min(.88, (second - lo.timestamp) / (hi.timestamp - lo.timestamp))) : 0;
    const mid = lo ? lo.number + Math.floor((hi.number - lo.number) * ratio) : Math.max(0, hi.number - step);
    const read = await block(mid);
    if (read.timestamp < second) lo = read;
    else hi = read;
    step *= 2;
  }
  if (!lo && hi.number !== 0) {
    const first = await block(0);
    if (first.timestamp < second) lo = first;
  }
  return [lo, hi];
}
function validLog(log, row, from, to) {
  return log && log.removed !== true && same(log.address, row.mint) &&
    hash(log.transactionHash) && hash(log.blockHash) && height(log.blockNumber) &&
    log.blockNumber >= from && log.blockNumber <= to;
}
function finalMint(log, row) {
  if (!log || log.removed === true || !same(log.address, row.mint) || !same(log.topics?.[0], MINTED) ||
      log.topics?.length !== 2 || typeof log.data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(log.data)) return false;
  try {
    const parsed = CORLA_ABI.parseLog(log);
    return parsed?.args[0] !== ZeroAddress && parsed?.args[1] === row.total;
  } catch { return false; }
}
function sameLog(a, b) {
  return a && b && same(a.address, b.address) && same(a.data, b.data) &&
    Array.isArray(a.topics) && a.topics.length === b.topics.length && a.topics.every((t, i) => same(t, b.topics[i]));
}
const rpcMessage = error => [error?.message, error?.shortMessage, error?.info?.error?.message].join(' ');
const responseLimit = error => /query returned more than|too many results|response size/i.test(rpcMessage(error)) &&
  error?.status !== 429 && !/429|rate.?limit|too many requests/i.test(rpcMessage(error));
function rangeLimit(error, span) {
  const msg = rpcMessage(error);
  if (span <= 1 || error?.status === 429 || (isRpcLimit(error) && /429|rate.?limit|too many requests/i.test(msg))) return null;
  if (!/block range|block span|range.*blocks|maximum.*blocks|query returned more than|too many results|response size/i.test(msg)) return null;
  // Common limit strings include "maximum block range: 5000".
  const number = /(?:maximum|max(?:imum)? allowed|over|limit)[^\d]{0,35}([\d,]{1,7})/i.exec(msg)?.[1];
  const cap = number ? Number(number.replaceAll(',', '')) : 0;
  return Math.min(span - 1, cap > 0 && cap < span ? cap : Math.max(1, Math.floor(span / 2)));
}
async function prove(receiptOf, blockOf, row, log, signal) {
  const [receipt, header] = await Promise.all([
    receiptOf(log.transactionHash),
    // Read by height rather than hash: a hash lookup can return an orphaned block.
    blockOf(log.blockNumber),
  ]);
  signal?.throwIfAborted();
  if (!receipt || receipt.status !== 1 || receipt.blockNumber !== log.blockNumber || !same(receipt.hash, log.transactionHash) ||
      !same(receipt.blockHash, log.blockHash) || !Array.isArray(receipt.logs) || !header ||
      header.number !== log.blockNumber || !same(header.hash, log.blockHash) || !unix(header.timestamp) ||
      header.timestamp < row.createdAt || header.timestamp > row.fundingDeadline ||
      !receipt.logs.some(entry => entry?.removed !== true && sameLog(entry, log))) return { retry: true };
  if (!receipt.logs.some(entry => finalMint(entry, row))) return { fallback: true };
  return { value: { mint: row.mint, token: row.token, filledAt: header.timestamp, blockNumber: header.number, blockHash: header.hash } };
}

/** Exact, optional history for verified full registry rows. This is read-only.
 * A partial batch returns only positively verified rows. Failed/large queries
 * keep a bounded forward cursor for the next background refresh. */
export async function readCatalogFundingTimes(provider, rows, {
  blockProvider = provider, signal, maxLogQueries = 10, onResult,
} = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('筹资历史查询最多支持 32 个项目');
  const jobs = [...new Map(rows.map(job).filter(Boolean).map(row => [row.key, row])).values()];
  if (!jobs.length) return [];
  const state = history.get(provider) ?? { progress: new Map(), range: MAX_FILTERED_RANGE, resultLimits: new Map() };
  history.set(provider, state);
  const headers = new Map();
  const proofBlocks = new Map();
  const receipts = new Map();
  const proofBlock = number => {
    if (!proofBlocks.has(number)) proofBlocks.set(number, blockProvider.getBlock(number));
    return proofBlocks.get(number);
  };
  const receiptOf = hash => {
    if (!receipts.has(hash)) receipts.set(hash, Promise.resolve().then(async () => {
      if (blockProvider !== provider && typeof blockProvider.getTransactionReceipt === 'function') {
        try {
          const receipt = await blockProvider.getTransactionReceipt(hash);
          if (receipt) return receipt;
        } catch { signal?.throwIfAborted(); }
      }
      return provider.getTransactionReceipt(hash);
    }));
    return receipts.get(hash);
  };
  const block = number => {
    if (!headers.has(number)) headers.set(number, Promise.resolve().then(async () => {
      signal?.throwIfAborted();
      if (headers.size > 28) throw new Error('已达筹资历史区块查询上限');
      const value = await blockProvider.getBlock(number);
      if (!value || !height(value.number) || number !== 'latest' && value.number !== number ||
          !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) throw new Error('无法读取筹资历史区块');
      return value;
    }));
    return headers.get(number);
  };
  const head = await block('latest');
  const stable = head.number - HISTORY_DEPTH;
  if (stable < 0) return [];
  const out = [];
  let budget = Number.isSafeInteger(maxLogQueries) ? Math.max(1, Math.min(16, maxLogQueries)) : 10;
  const lookup = row => {
    const old = state.progress.get(row.key);
    if (old?.retryAfter && old.retryAfter <= Date.now()) {
      state.progress.delete(row.key);
      return undefined;
    }
    return old;
  };
  const update = (row, values) => {
    state.progress.delete(row.key);
    state.progress.set(row.key, values);
    if (state.progress.size > MAX_REMEMBERED) state.progress.delete(state.progress.keys().next().value);
  };
  // Recent cohorts first; one shared indexed query usually resolves a full
  // page. Older cohorts continue across refreshes without scanning from genesis.
  for (const group of addressBatches(jobs).reverse()) {
    if (!budget) break;
    const rows = group.map(row => {
      const old = lookup(row);
      const mode = !row.launched || old?.mode === 'mint' ? 'mint' : 'launch';
      return { ...row, mode, observedTop: row.top, top: Math.min(row.top, stable),
        through: old?.mode === mode ? old.through : -1 };
    }).filter(row => row.top > row.through);
    if (!rows.length) continue;
    let floor, roof, deadlineBound;
    try {
      const highest = await block(Math.max(...rows.map(row => row.top)));
      if (highest.timestamp < rows[0].createdAt) continue;
      const [before] = await bracket(rows[0].createdAt, highest, block, 'before');
      floor = before?.number ?? 0;
      const deadline = Math.max(...rows.map(row => row.fundingDeadline));
      deadlineBound = highest.timestamp > deadline;
      roof = deadlineBound ? (await bracket(deadline + 1, highest, block, 'after'))[1].number : highest.number;
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    for (const mode of ['launch', 'mint']) {
      let work = rows.filter(row => row.mode === mode).map(row => ({
        ...row, top: Math.min(row.top, roof), from: Math.max(floor, row.through + 1),
      })).filter(row => row.from <= row.top);
      const remembered = state.resultLimits.get(mode);
      const recent = remembered?.expires > Date.now() ? remembered : null;
      let range = Math.min(state.range, recent?.range ?? MAX_FILTERED_RANGE);
      let addresses = recent?.addresses ?? 12;
      const rememberResultLimit = () => state.resultLimits.set(mode, { range, addresses, expires: Date.now() + RESULT_LIMIT_TTL_MS });
      while (budget > 0 && work.length) {
        signal?.throwIfAborted();
        const from = Math.min(...work.map(row => row.from));
        const until = from + range - 1;
        const candidates = work.filter(row => row.from <= until).sort((a, b) => a.from - b.from).slice(0, addresses);
        const to = Math.min(Math.max(...candidates.map(row => row.top)), until);
        const byMint = new Map(candidates.map(row => [row.mint.toLowerCase(), row]));
        const topics = mode === 'launch'
          ? [CORLA_LAUNCH_TOPIC, candidates.map(row => zeroPadValue(row.token, 32))]
          : [MINTED];
        let logs;
        budget--;
        try {
          logs = await provider.getLogs({ address: candidates.map(row => row.mint), topics, fromBlock: from, toBlock: to });
          if (!Array.isArray(logs)) throw new Error('invalid funding log result');
          // Some RPCs return the whole oversized result instead of rejecting the query.
          if (logs.length > MAX_LOG_RESULTS) throw new Error('too many results in funding log response');
        } catch (error) {
          signal?.throwIfAborted();
          const cap = rangeLimit(error, to - from + 1);
          if (!cap) {
            if (!responseLimit(error) || to !== from) break;
            if (candidates.length === 1) {
              // The provider cannot return even a single address/block.
              // Preserve that row's cursor; other projects may still be provable.
              work = work.filter(row => row !== candidates[0]);
            } else {
              addresses = Math.max(1, Math.floor(candidates.length / 2));
              rememberResultLimit();
            }
            continue;
          }
          range = Math.min(range, cap);
          if (responseLimit(error)) rememberResultLimit();
          if (/block range|block span|range.*blocks|maximum.*blocks/i.test(rpcMessage(error))) {
            state.range = Math.min(state.range, range);
          }
          continue;
        }
        const matches = new Map();
        for (const log of logs) {
          const row = byMint.get(log?.address?.toLowerCase?.());
          if (!row || !validLog(log, row, row.from, Math.min(row.top, to))) continue;
          if (mode === 'launch') {
            const event = decodeLaunchCandidate(row, log, row.from, Math.min(row.top, to));
            if (!event || !same(event.pool, row.pool)) continue;
          } else if (!finalMint(log, row)) continue;
          const old = matches.get(row.key);
          if (old && !same(old.transactionHash, log.transactionHash)) matches.set(row.key, false);
          else if (old !== false) matches.set(row.key, log);
        }
        const handled = new Set();
        const verify = candidates.filter(row => matches.has(row.key));
        for (let i = 0; i < verify.length; i += 4) {
          await Promise.all(verify.slice(i, i + 4).map(async row => {
            const log = matches.get(row.key);
            handled.add(row.key);
            if (!log) return;
            try {
              const result = await prove(receiptOf, proofBlock, row, log, signal);
              if (result.value) {
                out.push(result.value);
                state.progress.delete(row.key);
                onResult?.(result.value);
              } else if (result.fallback && mode === 'launch') update(row, { mode: 'mint', through: -1 });
            } catch { signal?.throwIfAborted(); }
          }));
        }
        work = work.filter(row => {
          if (!byMint.has(row.mint.toLowerCase())) return true;
          if (handled.has(row.key)) return false;
          const through = Math.min(to, row.top);
          const complete = through >= row.top && (stable >= row.observedTop || deadlineBound && roof <= row.top);
          // Close an exhaustive launch pass with a direct Minted pass. This
          // also handles a launch protocol that did not mint in the same tx.
          if (complete && mode === 'launch') {
            update(row, { mode: 'mint', through: -1 });
          } else {
            // An empty log page is not proof of an absence on an inconsistent
            // public node. Give exhausted scans a later recheck.
            update(row, { mode, through, ...(complete ? { retryAfter: Date.now() + 120_000 } : {}) });
          }
          row.from = through + 1;
          return row.from <= row.top;
        });
      }
    }
  }
  signal?.throwIfAborted();
  return out;
}
