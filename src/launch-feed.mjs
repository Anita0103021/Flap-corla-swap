import { corlaLaunchFilter, decodeLaunchCandidate, isRpcLimit, readLaunchCandidates } from './events.mjs';
import { int } from './config.mjs';

const MAX_ACTIVE = 8;
const MAX_QUEUE = 64;
const MAX_RECORDS = 1024;
const MAX_CANDIDATE_ATTEMPTS = 4;
const OVERLAP_BLOCKS = 4;
const MAX_WS_MESSAGE = 64 * 1024;

const keyOf = ({ mint, blockHash, txHash, pool, caller }) =>
  [mint, blockHash, txHash, pool, caller].join(':').toLowerCase();

function checkedWsUrl(value) {
  if (value == null || value === '') return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('开盘 WebSocket URL 无效'); }
  if (!['wss:', 'ws:'].includes(url.protocol) || url.hash) throw new Error('开盘 WebSocket 需要 ws:// 或 wss://');
  return url.href;
}

/** Confirmed log notifications are a low-latency hint, not chain authority.
 * HTTP scanning always runs and overlaps recent blocks to repair gaps. The
 * caller must verify a canonical receipt, actual pool and fresh head before
 * acting on a candidate. Return false (or reject) to retry a candidate via
 * HTTP while it remains in the window, e.g. an RPC has not indexed its receipt.
 * Attempts are capped per inclusion even when the observed head stops moving.
 */
export function makeLaunchFeed({
  provider, targets, armBlock, windowBlocks, wsUrl, scanMs = 350, signal,
  onCandidate, onRemoved, onStatus, services = {},
}) {
  if (!provider || typeof onCandidate !== 'function') throw new Error('开盘监听缺少 RPC 或回调');
  int(armBlock, '武装区块', 0, Number.MAX_SAFE_INTEGER - 1);
  int(windowBlocks, '开盘窗口', 1, 101);
  int(scanMs, 'HTTP 扫描间隔', 100, 30000);
  const filter = corlaLaunchFilter(targets);
  const byMint = new Map(targets.map(target => [target.mint.toLowerCase(), target]));
  const wsAddress = checkedWsUrl(wsUrl);
  const {
    WebSocket = globalThis.WebSocket,
    readCandidates = readLaunchCandidates,
    connectTimeoutMs = 5000,
    heartbeatMs = 10000,
    reconnectBaseMs = 400,
  } = services;

  let closed = false;
  let started = false;
  let closing;
  let head = armBlock;
  let lastScan = null;
  let scans = 0;
  let httpFailures = 0;
  let pollTimer;
  let pollTask;
  let socket;
  let socketTimer;
  let heartbeat;
  let reconnect;
  let wsFailures = 0;
  const phases = new Map();
  const records = new Map();
  const queued = new Map();
  const tasks = new Set();
  const stopped = () => closed || signal?.aborted;
  const firstEligible = () => Math.max(armBlock + 1, head - windowBlocks + 1);

  function report(transport, phase, details = {}) {
    const key = phase + ':' + (details.reason ?? '');
    if (stopped() || phases.get(transport) === key) return;
    phases.set(transport, key);
    try { onStatus?.({ transport, phase, ...details }); } catch { /* diagnostics must not affect detection */ }
  }

  function prune() {
    const first = firstEligible();
    for (const [key, record] of records) {
      if (record.candidate.blockNumber < first && record.status !== 'active') {
        records.delete(key);
        queued.delete(key);
      }
    }
  }

  function room() {
    if (records.size < MAX_RECORDS) return true;
    // Never evict an eligible terminal record: replaying it would reset its
    // retry budget (or discard a reorg tombstone).
    prune();
    if (records.size < MAX_RECORDS) return true;
    return false;
  }

  function drain() {
    while (!stopped() && tasks.size < MAX_ACTIVE && queued.size) {
      const [key, record] = queued.entries().next().value;
      queued.delete(key);
      if (record.status !== 'queued' || record.candidate.blockNumber < firstEligible()) continue;
      record.status = 'active';
      record.attempts = (record.attempts ?? 0) + 1;
      const finish = retry => {
        if (record.status === 'removed') return;
        const eligible = record.candidate.blockNumber >= firstEligible();
        record.status = retry && eligible && record.attempts < MAX_CANDIDATE_ATTEMPTS ? 'retry' : 'done';
        record.notBefore = Date.now() + Math.max(scanMs, Math.min(900, scanMs * 2 ** (record.attempts - 1)));
      };
      const task = Promise.resolve().then(() => {
        if (stopped() || record.status === 'removed') return;
        return onCandidate({ ...record.candidate });
      }).then(result => finish(result === false), () => finish(true)).finally(() => {
        tasks.delete(task);
        drain();
      });
      tasks.add(task);
    }
  }

  function deliver(candidate, source) {
    if (!candidate || stopped() || candidate.blockNumber < firstEligible()) return;
    const key = keyOf(candidate);
    const prior = records.get(key);
    if (candidate.removed) {
      if (prior?.status === 'removed' || (!prior && !room())) return;
      queued.delete(key);
      const removed = { ...candidate, source, observedAtMs: prior?.candidate.observedAtMs ?? Date.now(),
        observedAtMonotonicMs: prior?.candidate.observedAtMonotonicMs ?? performance.now() };
      if (prior) prior.status = 'removed';
      else records.set(key, { candidate: removed, status: 'removed' });
      try { Promise.resolve(onRemoved?.(removed)).catch(() => {}); } catch { /* final chain check remains mandatory */ }
      return;
    }
    if (prior && (prior.status !== 'retry' || prior.notBefore > Date.now())) return;
    if (queued.size >= MAX_QUEUE || (!prior && !room())) {
      // Leave it unrecorded so the HTTP overlap can still recover it.
      report('feed', 'busy');
      return;
    }
    const record = prior ?? {};
    record.status = 'queued';
    record.candidate = {
      ...candidate, source, observedAtMs: prior?.candidate.observedAtMs ?? Date.now(),
      observedAtMonotonicMs: prior?.candidate.observedAtMonotonicMs ?? performance.now(),
    };
    records.set(key, record);
    queued.set(key, record);
    drain();
  }

  function schedulePoll(ms) {
    if (!stopped()) pollTimer = setTimeout(() => {
      pollTask = poll();
    }, ms);
  }

  async function poll() {
    const beganAt = Date.now();
    try {
      const current = await provider.getBlockNumber();
      if (stopped()) return;
      if (!Number.isSafeInteger(current) || current < 0) throw new Error('开盘监听区块号无效');
      head = current;
      prune();
      const first = firstEligible();
      // Increment only on successful scans. A failed query must not advance
      // the cursor. Periodic full-window sweeps repair lagging log indexes.
      const sweep = lastScan == null || current < lastScan || scans % 4 === 0;
      let from = sweep ? first : Math.max(first, lastScan - OVERLAP_BLOCKS + 1);
      for (const { candidate, status } of records.values()) {
        if (status === 'retry' && candidate.blockNumber >= first) from = Math.min(from, candidate.blockNumber);
      }
      if (from <= current) {
        const result = await readCandidates(provider, targets, from, current);
        if (stopped()) return;
        for (const candidate of result) deliver(candidate, 'http');
        lastScan = current;
        scans++;
      }
      httpFailures = 0;
      report('http', 'active', { scanMs });
    } catch (error) {
      if (stopped()) return;
      httpFailures++;
      report('http', 'retrying', {
        reason: isRpcLimit(error) ? 'rpc_limited' : 'rpc_unavailable',
        retryMs: failureDelay(),
      });
    } finally {
      const remaining = scanMs - (Date.now() - beganAt);
      schedulePoll(httpFailures ? failureDelay() : Math.max(10, remaining));
    }
  }

  function failureDelay() {
    return Math.min(3000, Math.max(scanMs, 250) * 2 ** Math.min(3, httpFailures - 1));
  }

  function clearSocketTimers() {
    clearTimeout(socketTimer);
    clearInterval(heartbeat);
  }

  function reconnectLater() {
    if (stopped()) return;
    report('ws', 'fallback');
    const wait = Math.min(15000, reconnectBaseMs * 2 ** Math.min(wsFailures++, 6));
    reconnect = setTimeout(connect, wait);
  }

  function connect() {
    if (stopped()) return;
    report('ws', 'connecting');
    let conn;
    try { conn = new WebSocket(wsAddress); } catch { reconnectLater(); return; }
    socket = conn;
    let subscription;
    let handshake = 0;
    let probeId = 3;
    let probeAt = 0;
    const current = () => !stopped() && socket === conn;
    const fail = () => {
      if (!current()) return;
      socket = null;
      clearSocketTimers();
      try { conn.close(); } catch { /* optional transport */ }
      reconnectLater();
    };
    const request = (id, method, params) => {
      try { conn.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { fail(); }
    };
    socketTimer = setTimeout(fail, connectTimeoutMs);
    conn.addEventListener('open', () => {
      if (!current()) return;
      handshake = 1;
      request(1, 'eth_chainId', []);
    });
    conn.addEventListener('error', fail);
    conn.addEventListener('close', fail);
    conn.addEventListener('message', ({ data }) => {
      if (!current() || typeof data !== 'string' || data.length > MAX_WS_MESSAGE) return;
      let packet;
      try { packet = JSON.parse(data); } catch { return; }
      if (!packet || typeof packet !== 'object') return;
      if (handshake === 1 && packet.id === 1) {
        if (packet.error || typeof packet.result !== 'string' || !/^0x0*38$/i.test(packet.result)) return fail();
        handshake = 2;
        return request(2, 'eth_subscribe', ['logs', filter]);
      }
      if (handshake === 2 && packet.id === 2) {
        if (packet.error || typeof packet.result !== 'string' || !/^0x[0-9a-f]{1,128}$/i.test(packet.result)) return fail();
        handshake = 3;
        subscription = packet.result;
        clearTimeout(socketTimer);
        wsFailures = 0;
        report('ws', 'subscribed');
        heartbeat = setInterval(() => {
          if (!current()) return;
          if (probeAt) {
            if (Date.now() - probeAt >= heartbeatMs) fail();
            return;
          }
          probeAt = Date.now();
          request(++probeId, 'eth_blockNumber', []);
        }, heartbeatMs);
        return;
      }
      if (handshake !== 3) return;
      if (probeAt && packet.id === probeId) {
        if (packet.error || typeof packet.result !== 'string' || !/^0x[0-9a-f]{1,14}$/i.test(packet.result)) return fail();
        probeAt = 0;
        return;
      }
      if (packet.method !== 'eth_subscription' || packet.params?.subscription !== subscription) return;
      const raw = packet.params.result;
      if (typeof raw?.address !== 'string') return;
      const target = byMint.get(raw.address.toLowerCase());
      const candidate = decodeLaunchCandidate(target, raw, firstEligible(), Number.MAX_SAFE_INTEGER, { allowRemoved: true });
      deliver(candidate, 'ws');
    });
  }

  function stopScheduling() {
    closed = true;
    clearTimeout(pollTimer);
    clearTimeout(reconnect);
    clearSocketTimers();
    queued.clear();
    const old = socket;
    socket = null;
    try { old?.close(); } catch { /* optional transport */ }
  }

  return {
    start() {
      if (started || stopped()) return;
      started = true;
      signal?.addEventListener('abort', stopScheduling, { once: true });
      report('http', 'scanning', { scanMs });
      schedulePoll(0);
      if (wsAddress && typeof WebSocket === 'function') connect();
      else report('ws', 'disabled');
    },
    close() {
      if (!closing) {
        stopScheduling();
        signal?.removeEventListener('abort', stopScheduling);
        closing = Promise.allSettled([pollTask, ...tasks]).then(() => {});
      }
      return closing;
    },
  };
}
