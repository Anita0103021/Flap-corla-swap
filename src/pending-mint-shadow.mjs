import { ZeroAddress } from 'ethers';
import { CORLA_ABI, CORLA_QUOTE_ABI, createCorlaInspectionScope, inspectMint } from './corla.mjs';
import { FACTORY } from './config.mjs';
import { verifyLaunchCandidate } from './events.mjs';
import { quoteAsset } from './quote-assets.mjs';

const lower = s => typeof s === 'string' ? s.toLowerCase() : '';
const hash = s => typeof s === 'string' && /^0x[0-9a-f]{64}$/i.test(s);
const address = s => typeof s === 'string' && /^0x[0-9a-f]{40}$/i.test(s);
const quantity = s => typeof s === 'string' && /^0x[0-9a-f]{1,64}$/i.test(s);
const mintFunction = CORLA_ABI.getFunction('mint');
const quoteMintFunction = CORLA_QUOTE_ABI.getFunction('mintQuote');
const MAX_INPUT_CHARS = 2 + 2 * (4 + 96 + 32 * 64);
const MAX_WS_CHARS = 128 * 1024;
const MAX_PER_SECOND = 4096;
const PENDING_CONNECT_MS = 5_000;
const FULL_PAYLOAD_TIMEOUT_MS = 8_000;
const STABLE_PAYLOAD_MS = 15_000;
const PENDING_AGE_MS = 120_000;
const MAX_PENDING = 4096;
const MAX_INCLUSIONS = 1024;
const keyOf = c => [c.mint, c.blockHash, c.txHash].map(lower).join(':');
const pendingKey = (mint, hash) => lower(mint) + ':' + lower(hash);

export function pendingWsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('请用 --ws 或 BSC_PENDING_WSS_URL 指定待打包订阅节点');
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'wss:' || (url.protocol === 'ws:' && local)) &&
        !url.hash && !url.username && !url.password) return url.href;
  } catch { /* keep endpoint details out of the error */ }
  throw new Error('待打包订阅需要 wss:// 或本机 ws:// 地址');
}

export function pendingWsSources(primary, backups = '') {
  let invalidBackups = false;
  if (typeof backups === 'string') {
    if (backups.length > 8192) { invalidBackups = true; backups = []; }
    else backups = backups.split(',').map(row => row.trim()).filter(Boolean);
  }
  if (!Array.isArray(backups)) { invalidBackups = true; backups = []; }
  if (backups.length > 2) invalidBackups = true;
  const seen = new Set(), sources = [];
  for (const [i, value] of [primary, ...backups.slice(0, 2)].entries()) {
    let url;
    try { url = pendingWsUrl(value); } catch { /* keep the failure confined to this slot */ }
    if (url && seen.has(url)) continue;
    if (url) seen.add(url);
    sources.push({ source: i + 1, url });
  }
  return { sources, invalidBackups };
}

/** Verify the exact configured factory/proxy/token and active funding phase
 * at a pinned canonical header. No targets are discovered or enrolled. */
export async function armPendingTargets(provider, targets, { inspect = inspectMint } = {}) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 32 ||
      new Set(targets.map(t => lower(t.mint))).size !== targets.length ||
      new Set(targets.map(t => lower(t.token))).size !== targets.length ||
      targets.some(t => lower(t.factory) !== lower(FACTORY) || !address(t.mint) || !address(t.token) ||
        lower(t.mint) === lower(t.token))) throw new Error('需要 1–32 个明确指定且不重复的 Corla v4 项目');
  const head = await provider.getBlock('latest');
  if (!Number.isSafeInteger(head?.number) || head.number < 0 || !hash(head.hash) ||
      !Number.isSafeInteger(head.timestamp)) throw new Error('无法验证观测起始区块');
  const scope = createCorlaInspectionScope(provider, head.number);
  const armed = [];
  const excluded = [];
  // Bound arming waves as inspectMint itself fans out contract checks.
  for (let i = 0; i < targets.length; i += 4) {
    const results = await Promise.allSettled(targets.slice(i, i + 4).map(t => inspect(provider, t, head.number, scope)));
    for (const [j, result] of results.entries()) {
      const target = targets[i + j];
      const state = result.status === 'fulfilled' && result.value;
      if (state && !state.launched && !state.emergencyWithdrawn && state.phase === 1 &&
          state.fundingDeadline > BigInt(head.timestamp) && state.mintedLots < state.totalLots && state.pricePerLot > 0n) {
        armed.push({ ...target, pricePerLot: state.pricePerLot,
          ...(state.quoteToken && state.quoteToken !== ZeroAddress ? { quoteToken: state.quoteToken, deploymentKey: state.deploymentKey } : {}) });
      } else excluded.push({ mint: target.mint, reason: state ? 'not_active_funding' : 'verification_unavailable_or_failed' });
    }
  }
  const canonical = await provider.getBlock(head.number);
  if (canonical?.number !== head.number || lower(canonical?.hash) !== lower(head.hash)) throw new Error('观测起始区块不再是主链');
  return { armBlock: head.number, targets: armed, excluded };
}

/** No signatures, RPC calls, forwarding or storage of raw calldata. A call
 * matching this shape is only a candidate, not a proof it can fill the sale. */
export function decodePendingMint(tx, targetsByMint) {
  if (!hash(tx?.hash) || !address(tx?.to) || !address(tx.from) || !quantity(tx.value) ||
      tx.blockHash != null || tx.blockNumber != null || tx.transactionIndex != null) return null;
  const isFactory = lower(tx.to) === lower(FACTORY);
  const input = lower(tx.input ?? tx.data);
  const entry = isFactory ? quoteMintFunction : mintFunction;
  const abi = isFactory ? CORLA_QUOTE_ABI : CORLA_ABI;
  if (input.length < (isFactory ? 202 : 138) || input.length > MAX_INPUT_CHARS || !input.startsWith(entry.selector) ||
      !/^0x(?:[0-9a-f]{2})+$/.test(input)) return null;
  try {
    const target = isFactory ? [...targetsByMint.values()].find(t => lower(t.deploymentKey) === '0x' + input.slice(10, 74)) :
      targetsByMint.get(lower(tx.to));
    if (!target || (quoteAsset(target.quoteToken) !== ZeroAddress) !== isFactory ||
        BigInt(tx.value) !== (isFactory ? 0n : target.pricePerLot)) return null;
    const decoded = abi.decodeFunctionData(entry, input);
    if (lower(abi.encodeFunctionData(entry, decoded)) !== input) return null;
    return { mint: target.mint, hash: lower(tx.hash) };
  } catch { return null; }
}

export function makePendingMintShadow({
  provider, targets, armBlock, pendingStatus = () => ({}), onObservation,
  clock = () => performance.now(), verify = verifyLaunchCandidate,
}) {
  const targetsByMint = new Map(targets.map(t => [lower(t.mint), t]));
  const pending = new Map();
  const confirmed = new Map();
  const firstSignals = new Map();
  const removed = new Set();
  let matching = 0, droppedTracking = 0;
  const prunePending = now => {
    for (const [key, row] of pending) {
      if (now - row.at <= PENDING_AGE_MS) break;
      pending.delete(key);
    }
  };
  function observePending(tx) {
    const match = decodePendingMint(tx, targetsByMint);
    if (!match) return false;
    matching++;
    const now = clock();
    prunePending(now);
    const key = pendingKey(match.mint, match.hash);
    if (!pending.has(key)) {
      if (pending.size >= MAX_PENDING) {
        pending.delete(pending.keys().next().value);
        droppedTracking++;
      }
      pending.set(key, { at: now });
    }
    return true;
  }
  async function onCandidate(candidate) {
    const { blockNumber, blockHash, txHash } = candidate;
    const target = targetsByMint.get(lower(candidate.mint));
    if (!target || candidate.removed || lower(target.token) !== lower(candidate.token) || lower(candidate.factory ?? candidate.target?.factory) !== lower(FACTORY) ||
        !Number.isSafeInteger(blockNumber) || blockNumber <= armBlock || !hash(blockHash) || !hash(txHash)) return;
    const key = keyOf(candidate);
    if (removed.has(key) || confirmed.has(key)) return;
    if (!firstSignals.has(key)) {
      if (firstSignals.size >= MAX_INCLUSIONS) return;
      const now = clock();
      const feed = pendingStatus();
      prunePending(now);
      const earlier = pending.get(pendingKey(candidate.mint, txHash));
      firstSignals.set(key, { at: now, source: candidate.source === 'ws' ? 'ws' : 'http', mode: feed.mode ?? 'unavailable',
        healthy: feed.healthy === true,
        ...(earlier && earlier.at < now ? { pendingAt: earlier.at } : {}) });
    }
    const [proof, block] = await Promise.all([verify(provider, candidate), provider.getBlock(blockNumber)]);
    if (!proof || block?.number !== blockNumber || lower(block?.hash) !== lower(blockHash)) return false;
    if (removed.has(key) || confirmed.has(key)) return;
    const first = firstSignals.get(key);
    const leadMs = first.pendingAt === undefined ? null : Math.max(0, Math.round(first.at - first.pendingAt));
    const row = { mint: target.mint, token: target.token, txHash: lower(txHash), blockHash: lower(blockHash), block: blockNumber,
      confirmedSource: first.source, pendingMode: first.mode, fullFeedHealthy: first.healthy,
      seenBeforeLocalConfirmation: leadMs !== null, leadMs };
    confirmed.set(key, row);
    try { onObservation?.(row); } catch { /* Provisional; removals are checked at summary. */ }
  }
  function onRemoved(candidate) {
    const key = keyOf(candidate);
    if (removed.size < MAX_INCLUSIONS) removed.add(key);
    confirmed.delete(key);
  }
  async function summarize() {
    const snapshots = new Map();
    const unverified = [];
    const canonical = [];
    for (const row of confirmed.values()) {
      if (!snapshots.has(row.block)) snapshots.set(row.block,
        Promise.resolve().then(() => provider.getBlock(row.block)).catch(() => null));
    }
    for (const row of confirmed.values()) {
      const block = await snapshots.get(row.block);
      if (!block || block.number !== row.block || !hash(block.hash)) unverified.push(row);
      else if (lower(block.hash) === row.blockHash) canonical.push(row);
    }
    const covered = canonical.filter(row => row.seenBeforeLocalConfirmation);
    const fullFeed = canonical.filter(row => row.fullFeedHealthy);
    const missed = canonical.filter(row => !row.seenBeforeLocalConfirmation);
    return { trackedTargets: targets.length, matchingPendingMessages: matching, evictedPendingHashes: droppedTracking,
      canonicalLaunches: canonical.length, observedPendingBeforeLocalConfirmation: covered.length,
      unmatchedCanonicalLaunches: missed.length, canonicalLaunchesDuringHealthyFullFeed: fullFeed.length,
      matchesDuringHealthyFullFeed: fullFeed.filter(row => row.seenBeforeLocalConfirmation).length,
      noProofAtEnd: unverified.length, displacedOrRemoved: confirmed.size - canonical.length - unverified.length + removed.size,
      launches: canonical,
      unmatchedCaveat: '未命中不等于私有交易：可能是节点不可见、内层调用、金额不同、只返回哈希、断线或本地观测滞后。提前量相对于本进程首次收到开盘事件，不是打包前时间证明。' };
  }
  return { observePending, onCandidate, onRemoved, summarize };
}

/** Standard full-pending subscription. Hash-only streams are never expanded
 * into one HTTP lookup per hash, and they are explicitly reported. */
export function makePendingTransactionFeed({
  wsUrl, signal, onTransaction, onHash, onStatus, services = {},
}) {
  const endpoint = pendingWsUrl(wsUrl);
  const { WebSocket = globalThis.WebSocket, clock = () => performance.now(), wallClock = Date.now,
    connectTimeoutMs = PENDING_CONNECT_MS, staleMs = FULL_PAYLOAD_TIMEOUT_MS, maxPerSecond = MAX_PER_SECOND,
    setTimer = setTimeout, clearTimer = clearTimeout } = services;
  let mode = 'idle', socket, timer, watchdog, reconnect, retryAt, stopped = false, started = false, epoch = 0;
  let connections = 0, failures = 0, full = 0, hashes = 0, dropped = 0, unrecognized = 0, lastDrop = -Infinity;
  let lastPayload = -Infinity, lastFullAtMs, fullInEpoch = 0, hashesInEpoch = 0, second = -1, inSecond = 0;

  function status() {
    const now = clock();
    const hasFullPayload = !stopped && Boolean(socket) && now - lastPayload < staleMs;
    return { mode, hasFullPayload, healthy: mode === 'full' && hasFullPayload && now - lastDrop > staleMs,
      connections, reconnects: Math.max(0, epoch - 1), fullMessages: full, hashMessages: hashes, droppedMessages: dropped,
      unrecognizedMessages: unrecognized, ...(lastFullAtMs === undefined ? {} : { pendingLastFullAtMs: lastFullAtMs }),
      ...(retryAt === undefined ? {} : { retryMs: Math.max(0, Math.ceil(retryAt - now)) }) };
  }
  const report = (next, force = false) => {
    if (!force && mode === next) return;
    mode = next;
    try { onStatus?.(status()); } catch { /* diagnostics only */ }
  };
  function disconnect() {
    clearTimer(timer);
    clearTimer(watchdog);
    const old = socket;
    socket = undefined;
    try { old?.close(); } catch { /* transports may already be closed */ }
  }
  function close() {
    if (stopped) return;
    stopped = true;
    clearTimer(reconnect);
    retryAt = undefined;
    disconnect();
    signal?.removeEventListener('abort', close);
  }
  function connect() {
    if (stopped || signal?.aborted) return;
    const thisEpoch = ++epoch;
    fullInEpoch = hashesInEpoch = 0;
    second = -1;
    inSecond = 0;
    lastPayload = -Infinity;
    retryAt = undefined;
    report('connecting');
    if (stopped || signal?.aborted) return;
    let conn;
    let handshake = 1, subscription, subscribedAt, stableFrom;
    const active = () => !stopped && epoch === thisEpoch && socket === conn;
    const retryLater = reason => {
      if (stopped || signal?.aborted) return;
      const wait = 500 * 2 ** failures;
      failures = Math.min(failures + 1, 4);
      retryAt = clock() + wait;
      reconnect = setTimer(connect, wait);
      report(reason, true);
    };
    const fail = (reason = 'disconnected', retry = true) => {
      if (!active()) return;
      disconnect();
      if (retry) retryLater(reason);
      else report(reason);
    };
    try { conn = socket = new WebSocket(endpoint); }
    catch { retryLater('transport_unavailable'); return; }
    const send = (id, method, params) => {
      try { conn.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch { fail(); }
    };
    // The subscription's actual data is the heartbeat. A successful
    // eth_blockNumber response says nothing about pending delivery, and a
    // lost ping response should not drop a still-working subscription.
    function checkPayload() {
      if (!active()) return;
      const left = staleMs - (clock() - (fullInEpoch ? lastPayload : subscribedAt));
      if (left > 0) { watchdog = setTimer(checkPayload, Math.ceil(left)); return; }
      fail(!fullInEpoch && hashesInEpoch ? 'hash_only' : 'payload_timeout');
    }
    timer = setTimer(() => fail('timeout'), connectTimeoutMs);
    conn.addEventListener('open', () => { if (active()) send(1, 'eth_chainId', []); });
    conn.addEventListener('close', () => fail());
    conn.addEventListener('error', () => fail());
    conn.addEventListener('message', ({ data }) => {
      if (!active()) return;
      if (typeof data !== 'string' || data.length > MAX_WS_CHARS) {
        dropped++; lastDrop = clock(); return;
      }
      const now = clock();
      const currentSecond = Math.floor(now / 1000);
      if (currentSecond !== second) { second = currentSecond; inSecond = 0; }
      if (++inSecond > maxPerSecond) { dropped++; lastDrop = now; return; }
      // Capture local arrival before JSON decoding or any target verification.
      const receivedAtMs = wallClock();
      let packet;
      try { packet = JSON.parse(data); } catch { unrecognized++; return; }
      if (handshake === 1 && packet?.id === 1) {
        if (packet.error || !quantity(packet.result)) return fail('chain_unverified');
        if (BigInt(packet.result) !== 56n) return fail('chain_unverified', false);
        handshake = 2;
        return send(2, 'eth_subscribe', ['newPendingTransactions', true]);
      }
      if (handshake === 2 && packet?.id === 2) {
        if ([-32601, -32602].includes(packet.error?.code)) return fail('unsupported', false);
        if (packet.error || typeof packet.result !== 'string' || !/^0x[0-9a-f]{1,128}$/i.test(packet.result)) {
          return fail('error');
        }
        handshake = 3;
        subscription = packet.result;
        subscribedAt = now;
        connections++;
        clearTimer(timer);
        watchdog = setTimer(checkPayload, staleMs);
        report('subscribed_no_payload');
        return;
      }
      if (handshake !== 3) return;
      if (packet?.method !== 'eth_subscription' || packet.params?.subscription !== subscription) return;
      const item = packet.params.result;
      if (typeof item === 'string' && hash(item)) {
        hashes++; hashesInEpoch++;
        try { onHash?.(item, { receivedAtMs, seen: now, mode: fullInEpoch ? 'mixed' : 'hash_only' }); }
        catch { /* optional telemetry; do not resolve hashes via RPC */ }
      }
      else if (item && hash(item.hash) && address(item.from) && (item.to == null || address(item.to)) &&
          quantity(item.value) && typeof (item.input ?? item.data) === 'string' &&
          item.blockHash == null && item.blockNumber == null && item.transactionIndex == null) {
        full++;
        fullInEpoch++;
        if (stableFrom === undefined || now - lastPayload >= staleMs) stableFrom = now;
        lastPayload = now;
        lastFullAtMs = receivedAtMs;
        if (now - stableFrom >= STABLE_PAYLOAD_MS) failures = 0;
        try { onTransaction(item, { receivedAtMs, seen: now, mode: hashesInEpoch ? 'mixed' : 'full' }); }
        catch { /* never let telemetry kill the feed */ }
      } else { unrecognized++; return; }
      if (active()) report(fullInEpoch && hashesInEpoch ? 'mixed' : fullInEpoch ? 'full' : 'hash_only');
    });
  }
  return {
    start() {
      if (started || stopped || signal?.aborted) return;
      started = true;
      signal?.addEventListener('abort', close, { once: true });
      if (typeof WebSocket !== 'function') report('transport_unavailable');
      else connect();
    },
    close,
    status,
  };
}
