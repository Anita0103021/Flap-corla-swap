import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { Interface, ZeroAddress } from 'ethers';
import { CORLA_LAUNCH_TOPIC } from './events.mjs';
import { WBNB } from './market.mjs';
import { quoteAsset } from './quote-assets.mjs';
import { MAX_PREOPEN_MINTS } from './snipe-limits.mjs';

const EVENTS = new Set([
  'watch_started', 'watch_stopped', 'watch_error', 'project', 'project_error', 'rpc_error', 'journal',
  'snipe_feed', 'snipe_detected', 'snipe_pending', 'snipe_pending_match', 'snipe_pending_feed', 'snipe_pending_gate',
  'snipe_race_mode', 'snipe_race_attempt', 'snipe_race_outcome', 'snipe_send', 'snipe_ack',
  'snipe_receipt', 'snipe_launch_index', 'snipe_first_buy', 'buy', 'buy_skipped',
]);
const NUMBERS = [
  'attempt', 'maxAttempts', 'raceAttempts', 'repeatAttempts', 'broadcastConcurrency', 'broadcastRpcCount',
  'walletCount', 'chainId', 'block', 'blockNumber', 'armBlock',
  'launchBlock', 'seenBlock', 'receiptBlock', 'quoteBlock', 'parentBlock', 'lastBlock', 'launchIndex',
  'receiptIndex', 'transactionIndex', 'scanToBlock', 'scanMs', 'windowBlocks', 'deadlineSeconds',
  'preopenLots', 'slippageBps', 'maxOpeningPremiumBps', 'maxPriceImpactBps', 'maxBuyTaxBps', 'maxSellTaxBps', 'phase',
  'pendingCandidateCount', 'pendingMintCount', 'pendingSource', 'pendingSourceCount', 'pendingHealthyCount', 'pendingFullSourceCount',
  'stalePendingCount',
  'fullMessages', 'hashMessages', 'droppedMessages', 'unrecognizedMessages', 'connections',
  'matchingPendingMessages', 'canonicalLaunches', 'matchesDuringHealthyFullFeed', 'retryMs', 'reconnects',
];
const TIMINGS = [
  'leadMs', 'elapsedMs', 'quoteMs', 'proofMs', 'headMs', 'marketMs', 'stateMs', 'openingTaxMs', 'walletPrepMs',
  'walletChecksMs', 'preflightMs', 'signMs', 'simulationMs', 'snapshotMs', 'pendingSeenMs',
  'confirmedSeenMs', 'seenMs', 'ackMs', 'decisionMs', 'raceWindowMs', 'planMs', 'pendingLeadMs',
];
const QUANTITIES = [
  'amountIn', 'amountOutMin', 'quoted', 'openingNetOut', 'quotedNetOut', 'openingAmountOutMin', 'gasEstimate', 'gasUsed', 'gasLimit', 'gasPrice',
  'effectiveGasPrice', 'maxGasPriceWei', 'gasLimitCap', 'maxTotalWei', 'reserveBnb', 'reserveQuote',
  'minLiquidity', 'pricePerLot', 'mintedLots', 'totalLots', 'remainingLots', 'batches', 'raceGasCap',
];
const HASHES = ['txHash', 'launchTx', 'launchTxHash', 'pendingTxHash', 'blockHash', 'receiptBlockHash', 'parentHash'];
const BOOLS = [
  'live', 'launched', 'receiptStable', 'preflightOverlapped', 'knownSuccess', 'matchedPending',
  'success', 'healthy', 'fullFeedHealthy', 'seenBeforeLocalConfirmation', 'afterLaunchSignal', 'submitted', 'requirePreopen',
];
const TRANSPORT = new Set(['ws', 'http', 'pending', 'confirmed']);
const MODE = new Set(['pending', 'confirmed', 'preopen', 'repeat', 'race', 'once', 'single', 'public', 'live']);
const FEED = new Set([
  'ready', 'subscribed', 'connecting', 'connected', 'retrying', 'reconnecting', 'error', 'degraded',
  'disconnected', 'disabled', 'polling', 'scanning', 'active', 'busy', 'fallback', 'idle',
  'full', 'mixed', 'hash_only', 'subscribed_no_payload', 'timeout', 'unsupported', 'chain_unverified',
  'transport_unavailable', 'unavailable', 'stopped', 'payload_timeout', 'invalid_config',
]);
const STATUS = new Set([
  'confirmed', 'failed', 'pending', 'skipped', 'simulated', 'submitted', 'not_submitted', 'mined',
  'accepted', 'refused', 'reverted', 'success', 'reconciled', 'exhausted', 'blocked', 'error', 'no_buy_seen',
]);
const PAIR_EVENTS = new Interface([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
]);
const SWAP_TOPIC = PAIR_EVENTS.getEvent('Swap').topicHash;
const isHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const isAddress = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const low = value => typeof value === 'string' ? value.toLowerCase() : '';
const int = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => !!low(a) && low(a) === low(b);
const round = value => Math.round(value * 1000) / 1000;
const REPORT_NAME = /^snipe-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{10}\.ndjson$/;
const reportPathFor = name => 'reports/snipe-runs/' + name;

async function reportDirectory(rootDir, create = false) {
  let parent = await realpath(rootDir);
  for (const child of ['reports', 'snipe-runs']) {
    const requested = join(parent, child);
    if (create) await mkdir(requested, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const dir = await realpath(requested);
    const within = relative(parent, dir);
    if ((process.platform === 'win32' ? within.toLowerCase() : within) !== child || isAbsolute(within)) {
      throw new Error('Report directory escaped workspace');
    }
    parent = dir;
  }
  return parent;
}

export async function findLatestSnipeReport(rootDir) {
  try {
    const dir = await reportDirectory(rootDir);
    let latest;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile() && REPORT_NAME.test(entry.name) && (!latest || entry.name > latest)) latest = entry.name;
    }
    return latest ? reportPathFor(latest) : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function quantity(value) {
  if (typeof value === 'bigint') {
    if (value < 0n || value >= (1n << 256n)) return;
    return value.toString();
  }
  if (int(value)) return String(value);
  if (typeof value === 'string' && value.length <= 78 && /^(?:0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) < (1n << 256n)) return value;
}

function failureKind(fields) {
  // Errors, RPC packets, dynamic labels and free-text reasons are never copied
  // to disk. Classify only the error type so the file is shareable.
  const source = [fields.error, fields.reason, fields.code].map(value =>
    typeof value === 'string' ? value.slice(0, 250) : '').join(' ');
  if (!source.trim()) return;
  if (/超过开盘价溢价上限/i.test(source)) return 'opening_price_cap';
  if (/没抢到开盘就不追/i.test(source)) return 'no_confirmed_fallback';
  if (/初始池储备|开盘区块买税|开盘价格保护/i.test(source)) return 'opening_evidence';
  if (/最低到手量|滑点|INSUFFICIENT_OUTPUT_AMOUNT/i.test(source)) return 'min_out';
  if (/rate.?limit|429|throttl|限流/i.test(source)) return 'rate_limited';
  if (/gas.*(?:price|limit|cap)|(?:gas|费用).*上限/i.test(source)) return 'gas_limit';
  if (/balance|余额|INSUFFICIENT_FUNDS/i.test(source)) return 'balance';
  if (/nonce|钱包有交易待确认/i.test(source)) return 'nonce_or_pending';
  if (/not submitted|TRANSACTION_NOT_SUBMITTED|未被节点接受/i.test(source)) return 'not_submitted';
  if (/unknown|状态未知|不明确/i.test(source)) return 'unknown_submission';
  if (/expired|deadline|过期|窗口|too late/i.test(source)) return 'expired';
  if (/withdraw|税|tax|池|liquidity|pool/i.test(source)) return 'market_guard';
  if (/revert|回退|CALL_EXCEPTION/i.test(source)) return 'reverted';
  if (/timeout|超时/i.test(source)) return 'timeout';
  if (/abort|stop|停止|取消/i.test(source)) return 'stopped';
  if (/proof|canonical|重组|主链|核对|核验|报价区块/i.test(source)) return 'proof';
  return 'other';
}

function fieldsFor(fields, allowedMints, allowedTokens) {
  const result = {};
  if (!fields || typeof fields !== 'object') return result;
  if (allowedMints.has(low(fields.mint))) result.mint = low(fields.mint);
  if (allowedTokens.has(low(fields.token))) result.token = low(fields.token);
  if (isAddress(fields.quoteToken) && allowedTokens.has(low(fields.token))) result.quoteToken = low(fields.quoteToken);
  for (const key of NUMBERS) if (int(fields[key])) result[key] = fields[key];
  for (const key of ['pendingReceivedAtMs', 'pendingLastFullAtMs']) {
    if (int(fields[key]) && fields[key] <= 8_640_000_000_000_000) result[key] = fields[key];
  }
  if (Number.isSafeInteger(fields.blockOffset)) result.blockOffset = fields.blockOffset;
  for (const key of TIMINGS) {
    const value = fields[key];
    const signed = key === 'leadMs' || key === 'pendingLeadMs';
    if (Number.isFinite(value) && Math.abs(value) <= 86_400_000 && (value >= 0 || signed)) result[key] = round(value);
    else if (value === null && signed) result[key] = null;
  }
  for (const key of QUANTITIES) {
    const encoded = quantity(fields[key]);
    if (encoded !== undefined) result[key] = encoded;
  }
  for (const key of HASHES) if (isHash(fields[key])) result[key] = low(fields[key]);
  if (Array.isArray(fields.pendingHashes) && fields.pendingHashes.length > 0 &&
      fields.pendingHashes.length <= MAX_PREOPEN_MINTS && fields.pendingHashes.every(isHash)) {
    result.pendingHashes = fields.pendingHashes.map(low);
  }
  for (const key of BOOLS) if (typeof fields[key] === 'boolean') result[key] = fields[key];
  for (const key of ['source', 'signalSource', 'confirmedSource', 'transport']) {
    if (TRANSPORT.has(fields[key])) result[key] = fields[key];
  }
  for (const key of ['raceMode', 'mode']) if (MODE.has(fields[key])) result[key] = fields[key];
  for (const key of ['pendingMode', 'phase', 'feedMode', 'mode']) if (FEED.has(fields[key])) result[key] = fields[key];
  if (STATUS.has(fields.status)) result.status = fields.status;
  if (['waiting_lots', 'waiting_pending', 'stale_pending', 'ready'].includes(fields.preopenStage)) result.preopenStage = fields.preopenStage;
  if (['aggregate', 'direct'].includes(fields.marketReadMode)) result.marketReadMode = fields.marketReadMode;
  const classified = failureKind(fields);
  if (classified) result.failureKind = classified;
  return result;
}

/**
 * Open a per-run NDJSON file. record() never awaits disk and cannot throw.
 * Only public transaction/block identifiers and explicit schema fields are
 * exported; no signer addresses, RPC URLs, credentials or raw transactions.
 */
export async function createSnipeRunRecorder({
  rootDir, settings = {}, targets = [], armBlock, maxEvents = 20_000, maxQueueBytes = 1024 * 1024,
} = {}) {
  if (typeof rootDir !== 'string' || !rootDir || !Array.isArray(targets) || targets.length > 32 ||
      (armBlock !== undefined && !int(armBlock)) || !int(maxEvents) || maxEvents < 1 || maxEvents > 100_000 ||
      !int(maxQueueBytes) || maxQueueBytes < 512 || maxQueueBytes > 16 * 1024 * 1024) {
    throw new Error('狙击记录参数无效');
  }
  const selected = targets.flatMap(target => isAddress(target?.mint) && isAddress(target?.token)
    ? [{ mint: low(target.mint), token: low(target.token) }] : []);
  const mints = new Set(selected.map(target => target.mint));
  const tokens = new Set(selected.map(target => target.token));
  const ts = new Date().toISOString();
  const fileName = 'snipe-' + ts.replace(/[:.]/g, '-') + '-' + randomBytes(5).toString('hex') + '.ndjson';
  const reportPath = reportPathFor(fileName);
  let file;
  try {
    const dir = await reportDirectory(rootDir, true);
    file = await open(join(dir, fileName), 'ax', 0o600);
    await file.writeFile(JSON.stringify({
      event: 'run_start', schemaVersion: 1, sequence: 0, time: ts, runMs: 0,
      chainId: 56, armBlock, targets: selected, settings: fieldsFor(settings, mints, tokens),
    }) + '\n', 'utf8');
  } catch {
    await file?.close().catch(() => {});
    throw new Error('无法创建狙击测速记录', { cause: 'SNIPE_RECORDER_UNAVAILABLE' });
  }

  const began = performance.now();
  const counts = Object.create(null);
  const queue = [];
  let accepted = 0, written = 0, dropped = 0, bytes = 0, failed = false;
  let draining, scheduled, closing;
  function schedule() {
    if (!scheduled && !draining && queue.length && !failed) {
      scheduled = setImmediate(() => { scheduled = undefined; void drain(); });
    }
  }
  function drain() {
    if (draining || !queue.length || failed) return draining;
    const batch = queue.splice(0, 64);
    draining = file.writeFile(batch.map(item => item.line).join(''), 'utf8').then(() => {
      written += batch.length;
      for (const item of batch) counts[item.event] = (counts[item.event] ?? 0) + 1;
    }).catch(() => {
      failed = true;
      dropped += batch.length + queue.length;
      queue.length = 0;
    }).finally(() => {
      bytes -= batch.reduce((sum, row) => sum + row.bytes, 0);
      draining = undefined;
      if (!closing) schedule();
    });
    return draining;
  }
  function record(event, fields) {
    if (!EVENTS.has(event) || closing) return false;
    if (failed || accepted >= maxEvents) { dropped++; return false; }
    try {
      const row = fieldsFor(fields, mints, tokens);
      const time = event === 'snipe_pending' && row.pendingReceivedAtMs !== undefined
        ? new Date(row.pendingReceivedAtMs).toISOString() : new Date().toISOString();
      const line = JSON.stringify({ event, sequence: accepted + 1, time,
        runMs: round(performance.now() - began), ...row }) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > maxQueueBytes) { dropped++; return false; }
      bytes += size;
      accepted++;
      queue.push({ line, bytes: size, event });
      schedule();
      return true;
    } catch { dropped++; return false; }
  }
  function close() {
    if (closing) return closing;
    clearImmediate(scheduled);
    scheduled = undefined;
    closing = (async () => {
      while (draining || queue.length && !failed) await (draining ?? drain());
      const summary = { event: 'run_end', sequence: accepted + 1, time: new Date().toISOString(),
        runMs: round(performance.now() - began), written, dropped, failed, eventCounts: counts };
      try {
        if (!failed) await file.writeFile(JSON.stringify(summary) + '\n', 'utf8');
        await file.sync();
      } catch { failed = true; }
      finally { try { await file.close(); } catch { failed = true; } }
      return { written, dropped, failed, eventCounts: { ...counts } };
    })();
    return closing;
  }
  return { fileName, reportPath, record, close };
}

function rpcInt(value) {
  if (int(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-f]{1,14}$/i.test(value)) {
    const result = Number(BigInt(value));
    if (int(result)) return result;
  }
}

/** Optional, bounded read-only enrichment. Trigger only from an already
 * observed launch or known receipt, never directly from a submit callback. */
export function createSnipeReceiptObserver({ provider, record, signal, launchDelayMs = 1_200 } = {}) {
  const waiting = new Map();
  const seen = new Set();
  let comparisons = 0;
  let running, timer, scheduledAt, stopped = false;
  const active = () => !stopped && !signal?.aborted;
  async function compareFirstBuy({ fields, hash, height, index, launchLog, pool, launchBlockHash }) {
    const quote = quoteAsset(fields.quoteToken);
    const asset = quote === ZeroAddress ? WBNB : quote;
    if (!active() || typeof provider.getBlockNumber !== 'function' || typeof provider.getLogs !== 'function' ||
        !isAddress(pool) || /^0x0{40}$/i.test(pool) || same(fields.token, asset) || comparisons >= 2) return;
    comparisons++;
    try {
      const head = rpcInt(await provider.getBlockNumber());
      if (!active() || head === undefined || head < height) return;
      const scanToBlock = Math.min(head, height + 2);
      const swaps = await provider.getLogs({ address: pool, topics: [SWAP_TOPIC], fromBlock: height, toBlock: scanToBlock });
      if (!active() || !Array.isArray(swaps) || swaps.length > 512) return;
      // The canonical Pancake V2 factory sorts the pair tokens by address.
      // Only verified quote-in / target-out swaps count as buys.
      const quoteFirst = low(asset) < low(fields.token);
      const launchLogIndex = rpcInt(launchLog.index ?? launchLog.logIndex);
      const buys = [];
      for (const swap of swaps) {
        const block = rpcInt(swap.blockNumber);
        const txIndex = rpcInt(swap.transactionIndex);
        const logIndex = rpcInt(swap.index ?? swap.logIndex);
        if (swap.removed || !same(swap.address, pool) || !same(swap.topics?.[0], SWAP_TOPIC) ||
            block === undefined || block < height || block > scanToBlock || txIndex === undefined ||
            !isHash(swap.transactionHash) || !isHash(swap.blockHash) ||
            (block === height && (txIndex < index ||
              (txIndex === index && (logIndex === undefined || launchLogIndex === undefined || logIndex <= launchLogIndex))))) continue;
        try {
          const row = PAIR_EVENTS.parseLog(swap)?.args;
          if (!row) continue;
          const amountIn = quoteFirst ? row.amount0In : row.amount1In;
          const targetOut = quoteFirst ? row.amount1Out : row.amount0Out;
          if (amountIn > 0n && targetOut > 0n) buys.push({ block, txIndex, logIndex, amountIn, swap });
        } catch { /* Discard malformed event data. */ }
      }
      buys.sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || (a.logIndex ?? 0) - (b.logIndex ?? 0));
      const first = buys[0];
      const [canonicalLaunch, canonicalBuy] = await Promise.all([
        provider.getBlock(height), first && first.block !== height ? provider.getBlock(first.block) : null,
      ]);
      if (!active() || rpcInt(canonicalLaunch?.number) !== height || !same(canonicalLaunch?.hash, launchBlockHash)) return;
      const context = { token: fields.token, mint: fields.mint, quoteToken: fields.quoteToken, launchTx: hash,
        launchBlock: height, launchIndex: index, scanToBlock };
      if (!first) { record('snipe_first_buy', { ...context, status: 'no_buy_seen' }); return; }
      const inclusion = first.block === height ? canonicalLaunch : canonicalBuy;
      if (rpcInt(inclusion?.number) !== first.block || !same(first.swap.blockHash, inclusion?.hash)) return;
      record('snipe_first_buy', { ...context, status: 'mined', knownSuccess: true,
        txHash: first.swap.transactionHash, receiptBlock: first.block, receiptIndex: first.txIndex,
        receiptBlockHash: first.swap.blockHash, blockOffset: first.block - height, amountIn: first.amountIn });
    } catch { /* Optional comparison never affects the job or delays stop. */ }
    finally { comparisons--; }
  }
  async function enrich({ hash, height, fields, launch }) {
    try {
      const [receipt, header] = await Promise.all([
        provider.getTransactionReceipt(hash), provider.getBlock(height),
      ]);
      const index = rpcInt(receipt?.index ?? receipt?.transactionIndex);
      if (!active() || !same(receipt?.hash ?? receipt?.transactionHash, hash) ||
          rpcInt(receipt?.blockNumber) !== height || rpcInt(header?.number) !== height ||
          !isHash(header.hash) || !same(receipt.blockHash, header.hash) || index === undefined) return false;
      const status = rpcInt(receipt.status);
      if (status !== 0 && status !== 1) return false;
      if (launch) {
        const launchLog = receipt.logs?.find(row => same(row.address, fields.mint) &&
            same(row.topics?.[0], CORLA_LAUNCH_TOPIC) && isHash(row.topics?.[1]) &&
            same('0x' + row.topics[1].slice(-40), fields.token));
        if (status !== 1 || !launchLog) return false;
        record('snipe_launch_index', { token: fields.token, mint: fields.mint,
          launchTx: hash, launchBlock: height, launchIndex: index, blockHash: header.hash });
        const poolTopic = launchLog.topics[2];
        const pool = typeof poolTopic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(poolTopic)
          ? '0x' + poolTopic.slice(-40) : undefined;
        if (pool && (!fields.pool || same(pool, fields.pool))) void compareFirstBuy({
          fields, hash, height, index, launchLog, pool, launchBlockHash: header.hash,
        });
      } else {
        record('snipe_receipt', { mint: fields.mint, token: fields.token, quoteToken: fields.quoteToken,
          txHash: hash, receiptBlock: height, receiptIndex: index, receiptBlockHash: header.hash,
          launchBlock: fields.launchBlock, ...(int(fields.launchBlock) ? { blockOffset: height - fields.launchBlock } : {}),
          attempt: fields.attempt, status: 'mined', success: status === 1, gasUsed: receipt.gasUsed });
      }
      return true;
    } catch { return false; }
  }
  function schedule() {
    if (!active() || running || !waiting.size) return;
    const eligible = Math.min(...Array.from(waiting.values(), row => row.eligibleAt));
    if (timer && eligible >= scheduledAt) return;
    clearTimeout(timer);
    scheduledAt = eligible;
    timer = setTimeout(() => {
      timer = undefined;
      const now = performance.now();
      const batch = [...waiting.entries()].filter(([, info]) => info.eligibleAt <= now).slice(0, 2);
      if (!batch.length) { schedule(); return; }
      for (const [key] of batch) waiting.delete(key);
      running = Promise.allSettled(batch.map(async ([key, info]) => {
        if (!await enrich(info)) seen.delete(key);
      })).finally(() => { running = undefined; schedule(); });
    }, Math.max(1, Math.ceil(eligible - performance.now())));
    timer.unref();
  }
  function observe(event, fields = {}) {
    if (!active() || waiting.size >= 32 || seen.size >= 512) return;
    const launch = event === 'snipe_detected';
    if (launch && (!isAddress(fields.mint) || !isAddress(fields.token))) return;
    if (!launch && !['buy', 'journal', 'snipe_race_outcome'].includes(event)) return;
    if (launch ? int(fields.launchIndex) : int(fields.receiptIndex)) return;
    const hash = launch ? fields.launchTx : fields.txHash;
    const height = launch ? fields.launchBlock : fields.receiptBlock;
    if (!isHash(hash) || !int(height)) return;
    const key = low(hash) + ':' + height;
    if (seen.has(key)) return;
    seen.add(key);
    waiting.set(key, { hash, height, fields: { mint: fields.mint, token: fields.token,
      quoteToken: isAddress(fields.quoteToken) ? fields.quoteToken : undefined,
      launchBlock: fields.launchBlock, attempt: fields.attempt, pool: fields.pool }, launch,
      // Index enrichment cannot help the order and should not compete with
      // the first quote/submit. Receipt enrichment is already post-outcome.
      eligibleAt: performance.now() + (launch ? launchDelayMs : 50) });
    schedule();
  }
  async function close() {
    stopped = true;
    clearTimeout(timer);
    waiting.clear();
    await running;
  }
  return { observe, close };
}
