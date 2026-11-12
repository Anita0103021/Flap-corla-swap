import { Interface, ZeroAddress, getAddress } from 'ethers';
import { FACTORY } from './config.mjs';
import { CORLA_ABI } from './corla.mjs';
import { readDashboardProjects } from './dashboard-chain.mjs';
import { discoverProjects } from './events.mjs';

const ENTRY = '(address mint,address creator,address token,bytes32,bytes32,bytes32,uint256 createdAt,uint256 fundingDeadline,uint256 totalLots,uint256 pricePerLot)';
const REGISTRY = new Interface([
  'function deploymentCount() view returns(uint256)',
  'function getDeployments(uint256 offset,uint256 limit) view returns(' + ENTRY + '[])',
]);
const MINTED = CORLA_ABI.getEvent('Minted').topicHash;
const WINDOW = 60;
// PublicNode permits at most 10 addresses on the standard endpoint.
const ADDRESS_BATCH = 8;
const REGISTRY_BATCH = 100;
const RANGE = 180;
const MAX_LOGS = 2048;
const MAX_RANGE_LOGS = 16_384;
const MAX_ACTIVE = 20_000; // Fail visibly rather than silently dropping projects.
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const height = n => Number.isSafeInteger(n) && n >= 0;
const unix = n => Number.isSafeInteger(n) && n > 0 && n < 10_000_000_000;
const groups = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

async function strictAll(promises) {
  const settled = await Promise.allSettled(promises);
  const error = settled.find(row => row.status === 'rejected');
  if (error) throw error.reason;
  return settled.map(row => row.value);
}

async function readDeploymentCount(provider, blockTag) {
  const raw = await provider.call({ to: FACTORY, data: REGISTRY.encodeFunctionData('deploymentCount'), blockTag });
  const [total] = REGISTRY.decodeFunctionResult('deploymentCount', raw);
  if (!height(Number(total))) throw new Error('Corla 通知工厂索引无效');
  return Number(total);
}

async function readDeployments(provider, blockTag, offset, count) {
  const raw = await provider.call({ to: FACTORY, data: REGISTRY.encodeFunctionData('getDeployments', [offset, count]), blockTag });
  if (typeof raw !== 'string' || raw.length !== 2 + 64 * (2 + count * 10)) throw new Error('Corla 通知工厂分页不完整');
  const [rows] = REGISTRY.decodeFunctionResult('getDeployments', raw);
  if (rows.length !== count) throw new Error('Corla 通知工厂分页不完整');
  return rows.map(({ mint, token, createdAt, fundingDeadline, totalLots }) => {
    if (mint === token || mint === ZeroAddress || token === ZeroAddress || !unix(Number(createdAt)) ||
        !unix(Number(fundingDeadline)) || createdAt > fundingDeadline || totalLots <= 0n) {
      throw new Error('Corla 通知工厂记录无效');
    }
    return { mint, token, createdAt: Number(createdAt), fundingDeadline: Number(fundingDeadline), totalLots };
  });
}

function projectData(project) {
  const mint = getAddress(project.mint);
  const token = getAddress(project.token);
  const query = new URLSearchParams({ mint, factory: FACTORY, catalogVersion: '4', lang: 'zh' });
  return { mint, token, url: 'https://flap.sh/apps/corla/mint/' + token + '?' + query };
}

function rangeLimit(error) {
  const msg = [error?.message, error?.shortMessage, error?.info?.error?.message].join(' ');
  if (error?.status === 429 || /\b429\b|rate.?limit|too many requests|throttl/i.test(msg)) return '';
  if (/too many addresses|address (?:limit|range)|maximum of [\d,]+ addresses/i.test(msg)) return 'addresses';
  return /too many (?:results|logs)|range.*blocks|block range|response size|query returned more/i.test(msg) ? 'blocks' : '';
}

async function filteredLogs(provider, addresses, from, to, signal, budget = { left: 15 }) {
  signal?.throwIfAborted();
  if (--budget.left < 0) throw new Error('Corla 通知日志分段超出本轮预算');
  let limit = 'blocks';
  try {
    const rows = await provider.getLogs({ address: addresses, topics: [MINTED], fromBlock: from, toBlock: to });
    if (!Array.isArray(rows)) throw new Error('Corla 通知日志返回无效');
    if (rows.length <= MAX_LOGS) return rows;
  } catch (error) {
    limit = rangeLimit(error);
    if (!limit || (limit === 'addresses' && addresses.length < 2)) throw error;
  }
  // A result overflow is different from a gateway throttle. Split by block,
  // and then by address for a dense block. No broad topic-only query.
  if (from < to && limit !== 'addresses') {
    const mid = from + Math.floor((to - from) / 2);
    return [...await filteredLogs(provider, addresses, from, mid, signal, budget),
      ...await filteredLogs(provider, addresses, mid + 1, to, signal, budget)];
  }
  if (addresses.length < 2) throw new Error('Corla 通知日志单区块超出处理上限');
  const mid = Math.floor(addresses.length / 2);
  return [...await filteredLogs(provider, addresses.slice(0, mid), from, to, signal, budget),
    ...await filteredLogs(provider, addresses.slice(mid), from, to, signal, budget)];
}

function decodeMint(log, rows, from, to) {
  const row = rows.get(log?.address?.toLowerCase?.());
  const index = log?.index ?? log?.logIndex;
  if (!row || log.removed === true || !height(log.blockNumber) || log.blockNumber < from || log.blockNumber > to ||
      !height(index) || !hash(log.blockHash) || !hash(log.transactionHash) || log.topics?.length !== 2 ||
      !same(log.topics[0], MINTED) || !hash(log.data)) throw new Error('Corla 通知 Minted 日志无效');
  const parsed = CORLA_ABI.parseLog(log);
  const count = parsed?.args[1];
  if (!parsed || parsed.args[0] === ZeroAddress || count <= 0n || count > row.totalLots) {
    throw new Error('Corla 通知 Minted 批数无效');
  }
  return { row, height: log.blockNumber, hash: log.blockHash, index, tx: log.transactionHash.toLowerCase(), count };
}

function checkedHeader(value, tag) {
  if (!height(value?.number) || (tag !== 'latest' && tag !== value.number) || !unix(value.timestamp) || !hash(value.hash)) {
    throw new Error('Corla 通知无法校验主链区块');
  }
  return value;
}

// Find a verified lower bound immediately preceding cutoff (some extra old
// blocks are harmless). Avoid an exact binary search on the common path.
async function startOfWindow(block, tip, cutoff, signal) {
  let hi = tip, lo;
  for (let step = 160; ; step *= 2) {
    signal?.throwIfAborted();
    const previous = await block(Math.max(0, tip.number - step));
    if (previous.timestamp < cutoff) {
      if (cutoff - previous.timestamp <= 20) return previous.number;
      lo = previous;
      break;
    }
    hi = previous;
    if (hi.number === 0) return hi.number;
  }
  while (lo.number + 1 < hi.number && cutoff - lo.timestamp > 20) {
    signal?.throwIfAborted();
    const mid = await block(lo.number + Math.floor((hi.number - lo.number) / 2));
    if (mid.timestamp < cutoff) lo = mid;
    else hi = mid;
  }
  return lo.number;
}

function newBurst(arm, baseline = arm) {
  return { arm, baseline, cursor: null, start: undefined, registryCursor: 0, registryAnchor: null,
    registry: new Map(), windows: new Map(), range: null, span: RANGE };
}

/** Read-only and independent of trading/dashboard selection. Caller serializes
 * polling and owns its own RPC pool plus the lifetime of an AbortSignal. */
export function createNotificationFeed({ provider, services = {} }) {
  const svc = { discoverProjects, readDashboardProjects, readDeploymentCount, readDeployments, ...services };
  let whitelist, burst;
  const emitted = { whitelist: new Set(), burst: new Set() };
  const once = (events, event) => {
    const ids = emitted[event.kind];
    if (ids.has(event.id)) return;
    if (ids.size >= 2048) ids.delete(ids.values().next().value);
    ids.add(event.id);
    events.push(event);
  };

  async function pollWhitelist(head, block, signal) {
    if (!whitelist) { whitelist = { arm: head, cursor: head }; return { events: [] }; }
    const state = whitelist;
    if (head.number < state.cursor.number) throw new Error('Corla 通知 RPC 高度落后');
    if (!same((await block(state.cursor.number)).hash, state.cursor.hash)) {
      // Replay recent heights after a fork, never alert pre-arming history.
      state.cursor = await block(Math.max(state.arm.number, state.cursor.number - 32));
    }
    if (head.number === state.cursor.number) return { events: [] };
    const from = state.cursor.number + 1;
    const to = Math.min(head.number, from + RANGE - 1);
    const end = await block(to);
    const candidates = await svc.discoverProjects(provider, from, to);
    if (!Array.isArray(candidates) || candidates.length > 1024) throw new Error('Corla 通知创建日志超限');
    const byHeight = new Map();
    for (const row of candidates) {
      if (!same(row.factory, FACTORY) || !height(row.blockNumber) || row.blockNumber < from || row.blockNumber > to ||
          !hash(row.blockHash)) throw new Error('Corla 通知创建日志无效');
      if (!byHeight.has(row.blockNumber)) byHeight.set(row.blockNumber, []);
      byHeight.get(row.blockNumber).push(row);
    }
    const pending = [];
    for (const heights of groups([...byHeight], 4)) {
      for (const rows of await strictAll(heights.map(async ([n, entries]) => {
        const header = await block(n);
        if (entries.some(row => !same(row.blockHash, header.hash))) throw new Error('Corla 通知创建区块已重组');
        const results = [];
        for (const batch of groups(entries, 12)) {
          signal?.throwIfAborted();
          const states = await svc.readDashboardProjects(provider, batch, n);
          for (const row of batch) {
            const chain = states.get(row.mint.toLowerCase());
            if (chain?.error && /不支持|不一致|仅支持|未在/.test(chain.error)) continue;
            if (!chain || chain.error || chain.blockNumber !== n) throw new Error('Corla 通知未能核对新项目白名单');
            if (chain.whitelistEnabled === true && unix(Number(chain.whitelistDeadline)) &&
                Number(chain.whitelistDeadline) >= head.timestamp) {
              results.push({ id: 'whitelist:' + row.mint.toLowerCase(), kind: 'whitelist', ...projectData(row),
                at: header.timestamp, whitelistDeadline: Number(chain.whitelistDeadline) });
            }
          }
        }
        return results;
      }))) pending.push(...rows);
    }
    signal?.throwIfAborted();
    if (!same(checkedHeader(await provider.getBlock(to), to).hash, end.hash)) throw new Error('Corla 通知创建区块已重组');
    signal?.throwIfAborted();
    state.cursor = end;
    const events = [];
    for (const event of pending) once(events, event);
    return { events, syncing: to < head.number };
  }

  async function updateRegistry(state, tip, signal) {
    const total = await svc.readDeploymentCount(provider, tip.number);
    if (total < state.registryCursor) throw new Error('Corla 通知工厂数量回退');
    let scanned = 0;
    while (state.registryCursor < total && scanned < 800) {
      signal?.throwIfAborted();
      const requests = [];
      let next = state.registryCursor;
      for (let i = 0; i < 4 && next < total; i++) {
        const count = Math.min(REGISTRY_BATCH, total - next);
        const offset = next;
        requests.push(Promise.resolve().then(async () => {
          const rows = await svc.readDeployments(provider, tip.number, offset, count);
          if (!Array.isArray(rows) || rows.length !== count) throw new Error('Corla 通知工厂分页不完整');
          return rows;
        }));
        next += count;
      }
      const pages = await strictAll(requests);
      signal?.throwIfAborted();
      for (const row of pages.flat()) {
        if (row.fundingDeadline >= tip.timestamp - WINDOW * 2) state.registry.set(row.mint.toLowerCase(), row);
      }
      state.registryAnchor = tip;
      scanned += next - state.registryCursor;
      state.registryCursor = next;
    }
    for (const [key, row] of state.registry) {
      if (row.fundingDeadline < tip.timestamp - WINDOW * 2) state.registry.delete(key);
    }
    if (state.registry.size > MAX_ACTIVE) throw new Error('Corla 通知活跃项目超过处理上限');
    return state.registryCursor === total;
  }

  async function pollBurst(head, block, signal) {
    if (!burst) burst = newBurst(head);
    let state = burst;
    const anchor = state.range?.end ?? state.cursor;
    if ([anchor, state.registryAnchor].some(item => item?.number > head.number)) throw new Error('Corla 通知 RPC 高度落后');
    const newestAnchor = (anchor?.number ?? -1) >= (state.registryAnchor?.number ?? -1) ? anchor : state.registryAnchor;
    if (newestAnchor && !same((await block(newestAnchor.number)).hash, newestAnchor.hash)) {
      state = burst = newBurst(state.arm, head);
    } else if (head.timestamp - (state.cursor?.timestamp ?? state.baseline.timestamp) > WINDOW * 2) {
      state = burst = { ...newBurst(state.arm, head), registry: state.registry,
        registryCursor: state.registryCursor, registryAnchor: state.registryAnchor };
    }
    if (!state.range) {
      if (state.cursor?.number === head.number) return { events: [] };
      const [complete, from] = await strictAll([
        updateRegistry(state, head, signal),
        state.cursor ? state.cursor.number + 1 : state.start ??
          startOfWindow(block, state.baseline, state.baseline.timestamp - WINDOW, signal),
      ]);
      state.start ??= from;
      if (!complete) return { events: [], syncing: true };
      const to = Math.min(head.number, from + state.span - 1);
      const [first, end] = await strictAll([block(from), block(to)]);
      const addresses = [...state.registry.values()]
        .filter(row => row.createdAt <= end.timestamp && row.fundingDeadline >= first.timestamp)
        .map(row => row.mint);
      state.range = { from, to, end, batches: groups(addresses, ADDRESS_BATCH), next: 0, logs: [] };
    }
    const scan = state.range;
    // Partial address waves never advance the block cursor. Every applicable
    // deployment is scanned, even if there are more than the UI's page limit.
    for (let remaining = 8; scan.next < scan.batches.length && remaining > 0;) {
      const wave = scan.batches.slice(scan.next, scan.next + Math.min(4, remaining));
      const logs = await strictAll(wave.map(batch => filteredLogs(provider, batch, scan.from, scan.to, signal)));
      signal?.throwIfAborted();
      const decoded = logs.flatMap(list => list.map(log => decodeMint(log, state.registry, scan.from, scan.to)));
      for (const log of decoded) scan.logs.push(log);
      if (scan.logs.length > MAX_RANGE_LOGS) {
        state.range = null;
        if (state.span <= 1) throw new Error('Corla 通知单区块日志超过处理上限');
        state.span = Math.max(1, Math.floor(state.span / 2));
        return { events: [], syncing: true };
      }
      scan.next += wave.length;
      remaining -= wave.length;
    }
    if (scan.next < scan.batches.length) return { events: [], syncing: true };
    const headers = new Map();
    for (const wave of groups([...new Set(scan.logs.map(log => log.height))], 12)) {
      const read = await strictAll(wave.map(block));
      for (const header of read) headers.set(header.number, header);
    }
    if (scan.logs.some(log => !same(headers.get(log.height)?.hash, log.hash)) ||
        !same(checkedHeader(await provider.getBlock(scan.to), scan.to).hash, scan.end.hash)) {
      state.range = null;
      throw new Error('Corla 通知 Minted 日志所属区块已重组');
    }
    signal?.throwIfAborted();
    const events = [];
    for (const log of scan.logs.sort((a, b) => a.height - b.height || a.index - b.index)) {
      const at = headers.get(log.height).timestamp;
      if (at < log.row.createdAt || at > log.row.fundingDeadline || at < scan.end.timestamp - WINDOW * 2) continue;
      const key = log.row.mint.toLowerCase();
      const series = state.windows.get(key) ?? { values: [], count: 0n, at: 0 };
      if (log.count <= series.count) continue; // Cumulative counter, not a per-event quantity.
      let prefix = 0;
      while (prefix < series.values.length && at - series.values[prefix] > WINDOW) prefix++;
      if (prefix) series.values.splice(0, prefix);
      const wasOver = BigInt(series.values.length) * 3n > log.row.totalLots;
      series.values.push(at);
      series.at = at;
      series.count = log.count;
      state.windows.set(key, series);
      const lots = BigInt(series.values.length);
      if (!wasOver && lots * 3n > log.row.totalLots && log.height > state.arm.number && at >= head.timestamp - WINDOW) {
        once(events, { id: 'burst:' + key + ':' + log.tx + ':' + log.index, kind: 'burst', ...projectData(log.row),
          at, mintedLots: String(lots), totalLots: String(log.row.totalLots), windowSeconds: WINDOW });
      }
    }
    for (const [key, value] of state.windows) if (value.at < scan.end.timestamp - WINDOW) state.windows.delete(key);
    state.cursor = scan.end;
    state.range = null;
    return { events, syncing: scan.to < head.number };
  }

  return async function poll({ enabled, signal } = {}) {
    if (!enabled?.whitelist) whitelist = undefined;
    if (!enabled?.burst) burst = undefined;
    if (!enabled?.whitelist && !enabled?.burst) return { events: [] };
    signal?.throwIfAborted();
    const blocks = new Map();
    const block = tag => {
      if (!blocks.has(tag)) blocks.set(tag, Promise.resolve().then(() => provider.getBlock(tag)).then(row => checkedHeader(row, tag)));
      return blocks.get(tag);
    };
    const head = await block('latest');
    signal?.throwIfAborted();
    const results = await Promise.allSettled([
      ...(enabled.whitelist ? [pollWhitelist(head, block, signal)] : []),
      ...(enabled.burst ? [pollBurst(head, block, signal)] : []),
    ]);
    signal?.throwIfAborted();
    return { block: head.number, events: results.flatMap(result => result.status === 'fulfilled' ? result.value.events : []),
      status: results.some(result => result.status === 'rejected') ? 'degraded' :
        results.some(result => result.value.syncing) ? 'syncing' : 'monitoring' };
  };
}
