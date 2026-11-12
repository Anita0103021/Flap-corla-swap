import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { FetchRequest, JsonRpcProvider, parseEther } from 'ethers';
import { CORLA_LAUNCH_TOPIC } from '../src/events.mjs';
import { readMarket, verifyRoundTrip } from '../src/market.mjs';

// Only known public chain samples and read-only RPC methods. Never opens wallet
// storage, creates signatures, broadcasts, or prints the configured URLs.
const SAMPLES = [
  '0x4bdd60107d9a1da95e03be6b6e972fa57ea62fd3',
  '0x4724ce75d772eda774147f6198f1a876811d6e19',
];
const HISTORICAL = {
  block: '0x' + (133078952).toString(16),
  tx: '0x59b184bd258a6bf84c99acce7310018e651d74dcefa08f5b549f5a34f402def1',
  token: '0x9b540b85d7dc7f3db4fbb7cebc45fb2214667777',
  pool: '0x31ad8087936d753c90128064e5341c880dc35a34',
};
const FILTER = { address: SAMPLES, topics: [CORLA_LAUNCH_TOPIC] };
const HTTP_TIMEOUT_MS = 4200;
const REFERENCE_POLL_MS = 300;
const WS_TIMEOUT_MS = 8000;
const MAX_HEAD_POLLS = 24;
const PROFILES = [
  { name: 'PublicNode', http: 'https://bsc-rpc.publicnode.com', ws: 'wss://bsc-rpc.publicnode.com' },
  { name: 'BNB Chain official', http: 'https://bsc-dataseed.bnbchain.org' },
  { name: 'dRPC public', http: 'https://bsc.drpc.org', ws: 'wss://bsc.drpc.org' },
  { name: '1RPC public', http: 'https://public.1rpc.io/bnb' },
];

const { values } = parseArgs({
  options: {
    samples: { type: 'string', default: '8' },
    custom: { type: 'boolean' },
    'skip-sim': { type: 'boolean' },
    'split-head-only': { type: 'boolean' },
  },
});
const count = Number(values.samples);
if (!Number.isSafeInteger(count) || count < 6 || count > 12) {
  throw new Error('Use --samples 6 through 12');
}
if (values.custom) {
  if (!process.env.BSC_RPC_URL) throw new Error('--custom requires BSC_RPC_URL');
  PROFILES.splice(0, PROFILES.length, {
    name: 'Custom (URL hidden)',
    http: process.env.BSC_RPC_URL,
    ws: process.env.BSC_WSS_URL,
  });
}
if (values.custom && values['split-head-only']) {
  throw new Error('Use --split-head-only only with the default PublicNode WSS / BNB Chain HTTP profiles');
}

const ms = n => Math.round(n);
function percentile(sorted, p) {
  return sorted.length ? ms(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]) : null;
}
function summarize(times, errors = []) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50_ms: percentile(sorted, 0.50),
    p95_ms: percentile(sorted, 0.95),
    failures: errors.reduce((map, label) => {
      map[label] = (map[label] ?? 0) + 1;
      return map;
    }, {}),
  };
}

function readUrl(url, allowed) {
  try {
    const parsed = new URL(url);
    if (!allowed.includes(parsed.protocol)) throw new Error();
    return parsed.href;
  } catch { return null; }
}

function safeFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  if (/^(?:TIMEOUT|SERVER_ERROR|NETWORK_ERROR|BAD_DATA|CALL_EXCEPTION|UNSUPPORTED_OPERATION)$/.test(error?.code ?? '')) {
    return error.code;
  }
  return 'network_or_rpc_failure';
}

let rpcId = 0;
async function rpc(url, method, params) {
  const started = performance.now();
  const id = ++rpcId;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return { error: 'HTTP_' + resp.status };
    }
    const data = await resp.json();
    if (data?.id !== id) return { error: 'bad_response' };
    if (data.error) {
      const code = data.error.code;
      return { error: Number.isSafeInteger(code) ? 'RPC_' + code : 'bad_response' };
    }
    if (data.result == null) return { error: 'empty_response' };
    const receivedAt = performance.now();
    return { result: data.result, receivedAt, elapsed: receivedAt - started };
  } catch (error) { return { error: safeFailure(error) }; }
}

const operations = [
  ['latest_block', 'eth_getBlockByNumber', ['latest', false], r => typeof r.hash === 'string' && typeof r.number === 'string'],
  ['recent_filtered_logs', 'eth_getLogs', [{ ...FILTER, fromBlock: 'latest', toBlock: 'latest' }], Array.isArray],
  ['historical_filtered_hit', 'eth_getLogs', [{ ...FILTER, fromBlock: HISTORICAL.block, toBlock: HISTORICAL.block }],
    r => Array.isArray(r) && r.some(log => log.transactionHash === HISTORICAL.tx && log.topics?.[0] === CORLA_LAUNCH_TOPIC)],
  ['launch_receipt', 'eth_getTransactionReceipt', [HISTORICAL.tx],
    r => r.transactionHash === HISTORICAL.tx && r.status === '0x1' && Array.isArray(r.logs)],
];

async function measureHttp(http) {
  const warmup = await rpc(http, 'eth_chainId', []);
  if (warmup.result !== '0x38') return { chain: warmup.error ?? 'wrong_chain' };
  const stats = new Map(operations.map(([label]) => [label, { times: [], errors: [] }]));
  for (let i = 0; i < count; i++) {
    for (const [label, method, params, valid] of operations) {
      const { result, elapsed, error } = await rpc(http, method, params);
      const { times, errors } = stats.get(label);
      if (result && valid(result)) times.push(elapsed);
      else errors.push(error ?? 'unexpected_result');
      await wait(80);
    }
  }
  return Object.fromEntries([...stats].map(([label, value]) => [label, summarize(value.times, value.errors)]));
}

async function measureWs(url, http) {
  if (!url) return { status: 'not_configured' };
  let ws;
  try { ws = new WebSocket(url); } catch { return { status: 'connect_failed' }; }
  const started = performance.now();
  let headsId, logsId, connectMs, logAckMs, headsAckMs;
  const heads = new Map();
  let ackError;
  let finishAck;
  const ready = new Promise(resolve => { finishAck = resolve; });
  const finish = result => finishAck(result);
  const handshakeTimer = setTimeout(() => finish(false), WS_TIMEOUT_MS);
  const matches = [];
  let logNotifications = 0;
  let polls = 0;
  try {
    ws.addEventListener('open', () => {
      connectMs = ms(performance.now() - started);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
    });
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
    ws.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.error) {
        ackError = Number.isSafeInteger(message.error.code) ? 'RPC_' + message.error.code : 'bad_response';
        finish(false);
        return;
      }
      if (message.id === 1) {
        if (message.result !== '0x38') { ackError = 'wrong_chain'; finish(false); return; }
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', FILTER] }));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_subscribe', params: ['newHeads'] }));
      }
      if (message.id === 2 && typeof message.result === 'string') {
        logsId = message.result;
        logAckMs = ms(performance.now() - started);
      }
      if (message.id === 3 && typeof message.result === 'string') {
        headsId = message.result;
        headsAckMs = ms(performance.now() - started);
      }
      if (logsId && headsId) finish(true);
      const params = message.params;
      if (message.method !== 'eth_subscription' || !params) return;
      if (params.subscription === logsId) logNotifications++;
      if (params.subscription !== headsId || typeof params.result?.hash !== 'string') return;
      if (heads.size > 120) heads.delete(heads.keys().next().value);
      if (!heads.has(params.result.hash)) heads.set(params.result.hash, performance.now());
    });
    if (!await ready) {
      return { status: ackError ?? 'handshake_failed_or_timed_out', connect_ms: connectMs ?? null,
        filtered_logs_ack_ms: logAckMs ?? null, new_heads_ack_ms: headsAckMs ?? null };
    }
    clearTimeout(handshakeTimer);
    const httpHeads = new Map();
    const paired = new Set();
    const pollStarted = performance.now();
    while (polls < MAX_HEAD_POLLS && performance.now() - pollStarted < 12000 && matches.length < count && ws.readyState === WebSocket.OPEN) {
      const queryStarted = performance.now();
      const { result, receivedAt } = await rpc(http, 'eth_getBlockByNumber', ['latest', false]);
      polls++;
      if (result?.hash && !httpHeads.has(result.hash)) httpHeads.set(result.hash, receivedAt);
      for (const [hash, httpAt] of httpHeads) {
        if (matches.length >= count) break;
        if (!heads.has(hash) || paired.has(hash)) continue;
        paired.add(hash);
        matches.push(httpAt - heads.get(hash)); // positive = WS seen earlier
      }
      await wait(Math.max(20, REFERENCE_POLL_MS - (performance.now() - queryStarted)));
    }
    return {
      status: 'subscribed',
      connect_ms: connectMs,
      filtered_logs_ack_ms: logAckMs,
      new_heads_ack_ms: headsAckMs,
      filtered_log_notifications: logNotifications,
      heads_seen: heads.size,
      reference_http_polls: polls,
      http_minus_ws_matching_head: summarize(matches),
      ws_seen_first: matches.filter(delta => delta > 0).length,
    };
  } finally {
    clearTimeout(handshakeTimer);
    try { ws.close(); } catch { /* open can fail after timeout */ }
  }
}

async function measureDryBuy(http) {
  if (values['skip-sim']) return { status: 'skipped' };
  const req = new FetchRequest(http);
  req.timeout = HTTP_TIMEOUT_MS;
  const provider = new JsonRpcProvider(req, 56, { staticNetwork: true, batchMaxCount: 8, batchStallTime: 0, cacheTimeout: -1 });
  const target = { token: HISTORICAL.token };
  const state = { launched: true, pool: HISTORICAL.pool };
  const settings = { amountIn: parseEther('0.0001'), minLiquidity: 1n, maxBuyTaxBps: 2000,
    maxSellTaxBps: 2000, maxPriceImpactBps: 1000, slippageBps: 300, deadlineSeconds: 20 };
  const from = '0x000000000000000000000000000000000000dEaD'; // synthetic simulation only
  const marketTimes = [], marketErrors = [], simTimes = [], simErrors = [];
  try {
    for (let i = 0; i < count; i++) {
      let market, block;
      try {
        block = await provider.getBlock('latest');
        if (!block) throw new Error();
        const start = performance.now();
        market = await readMarket(provider, target, state, settings, block);
        marketTimes.push(performance.now() - start);
      } catch (error) {
        marketErrors.push(safeFailure(error));
        continue;
      }
      try {
        const start = performance.now();
        await verifyRoundTrip(provider, market, from, settings, block, { fundSimulation: true });
        simTimes.push(performance.now() - start);
      } catch (error) {
        simErrors.push(error?.message?.includes('模拟不可用') ? 'eth_simulateV1_unavailable' : safeFailure(error));
      }
      await wait(100);
    }
    return { market_quote: summarize(marketTimes, marketErrors), buy_approve_sell_simulation: summarize(simTimes, simErrors) };
  } finally { provider.destroy(); }
}

async function benchmark(profile) {
  const http = readUrl(profile.http, ['https:', 'http:']);
  const ws = readUrl(profile.ws, ['wss:', 'ws:']);
  if (!http) return { profile: profile.name, error: 'invalid_http_url' };
  const httpReads = await measureHttp(http);
  const wsResult = await measureWs(ws, http);
  // Avoid repeated market simulations on unavailable/rate-limited public RPCs.
  const dryBuy = httpReads.chain || !httpReads.launch_receipt?.samples
    ? { status: 'skipped_due_to_unavailable_http' }
    : await measureDryBuy(http);
  return { profile: profile.name, http: httpReads, websocket: wsResult, dry_buy: dryBuy };
}

const splitHeadOnly = values['split-head-only'];
const results = splitHeadOnly ? [] : await Promise.all(PROFILES.map(benchmark));
const splitHead = !values.custom && await measureWs(PROFILES[0].ws, PROFILES[1].http);
console.log(JSON.stringify({
  measured_at_utc: new Date().toISOString(), node: process.version, samples_per_http_operation: count,
  reference_head_poll_ms: REFERENCE_POLL_MS,
  note: 'Read-only. Matching-head timing is not launch propagation, inclusion, or transaction latency.',
  ...(splitHead ? { publicnode_ws_vs_bnb_chain_http: splitHead } : {}),
  results,
}, null, 2));
