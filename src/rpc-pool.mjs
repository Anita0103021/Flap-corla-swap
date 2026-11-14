import { JsonRpcProvider, keccak256, toQuantity } from 'ethers';
import { LOW_LATENCY_RPC_TIMEOUT_MS, MAX_BROADCAST_CONCURRENCY } from './rpc-config.mjs';

const BSC_ID = 56n;
const MAX_LAG = 4;
const HEAD_WINDOW = 10_000;
const MAX_RETRY_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_RECEIPT_ATTEMPTS = 3;
const PROBE_LOGS = {
  address: '0x4bdd60107d9a1da95e03be6b6e972fa57ea62fd3',
  topics: ['0x33a8c95f5f2db419267a319b5eae65e50fdbec72a10c6e0bc380268275dee1e4'],
};
const KNOWN_HOSTS = new Set([
  'bsc-dataseed.bnbchain.org', 'bsc-rpc.publicnode.com', 'bsc.nodereal.io',
  'bsc-dataseed.defibit.io', 'bsc-dataseed.ninicoin.io', 'bsc.drpc.org', 'bnb.api.onfinality.io',
  'bsc.rpc.blxrbdn.com',
]);
const READS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBalance', 'eth_getCode',
  'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getLogs', 'eth_getBlockByNumber',
  'eth_getBlockByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_simulateV1',
]);
const RAW = 'eth_sendRawTransaction';
const RECEIPT = 'eth_getTransactionReceipt';
const LARGE_READS = new Set(['eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByHash', RECEIPT, 'eth_simulateV1', 'eth_call']);
const NOT_SUBMITTED = new WeakMap();

// Only the local raw-transport control flow can attest that no endpoint
// accepted this payload. Do not trust a status/code from an arbitrary error.
export function isDefinitelyNotSubmitted(error, txHash) {
  return NOT_SUBMITTED.has(error) && (txHash === undefined || NOT_SUBMITTED.get(error) === txHash);
}
function notSubmitted(message, status, txHash = null) {
  const error = rpcError(message, 'TRANSACTION_NOT_SUBMITTED', status);
  NOT_SUBMITTED.set(error, txHash);
  return error;
}

async function readBoundedJson(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void response.body?.cancel().catch(() => {});
    throw wireError('size');
  }
  if (!response.body) throw wireError('bad-response');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // Count the decompressed bytes as well as the optional wire header.
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        throw wireError('size');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function quantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,14}$/i.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
function rpcError(message, code = 'SERVER_ERROR', status) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}) });
}
function wireError(kind, retryMs = 0) { return { kind, retryMs }; }
function isLimit(error, method, allowAmbiguous = true) {
  const text = String(error?.message ?? '');
  return !/revert|insufficient funds|nonce too low/i.test(text) &&
    (Number(error?.code) === 429 || /too many requests|rate[- _]?limit|request[- _]?limit|throttl|request quota|\b(?:http|status)\s*429\b/i.test(text) ||
      (allowAmbiguous && method !== 'eth_getLogs' && Number(error?.code) === -32005 &&
        !/response size|result size|too many results|block range|query returned more than/i.test(text)));
}
function methodPolicy(method, error) {
  const text = String(error?.message ?? '');
  if (/revert/i.test(text)) return false;
  return [-32601, -32004].includes(Number(error?.code)) ||
    /(?:method|endpoint) (?:is )?(?:not (?:available|supported|enabled|allowed|found)|disabled)|does not exist\/is not available|unauthori[sz]ed method/i.test(text) ||
    (method === 'eth_getLogs' && /^(?:rpc error:\s*)?limit exceeded[.!]?$/i.test(text.trim()));
}
function pinnedUnavailable(method, params, error) {
  const msg = String(error?.message ?? '');
  if (/revert/i.test(msg)) return false;
  if (!['eth_call', 'eth_simulateV1', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance',
    'eth_getTransactionCount', 'eth_getStorageAt'].includes(method)) return false;
  const tag = method === 'eth_getLogs' ? params?.[0]?.toBlock :
    method === 'eth_getBlockByNumber' ? params?.[0] : params?.at(-1);
  return (quantity(tag) !== null || typeof tag?.blockHash === 'string' || typeof params?.[0]?.blockHash === 'string') &&
    /header not found|unknown block|block not found|missing trie node|state (?:is )?not available|historical state|requested (?:block|range).* (?:higher than|beyond)|block range .*?beyond.*?head|(?:to|requested) block .*?(?:greater than|after).*?(?:head|latest)/i.test(msg);
}

function endpoint(raw, index) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('BSC RPC URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash) throw new Error('BSC RPC 必须为有效的 HTTP(S) URL（不能含片段）');
  const canonical = url.href;
  const publicName = url.protocol === 'https:' && !url.port && !url.search && !url.username && !url.password &&
    (url.pathname === '/' || (url.hostname === 'bnb.api.onfinality.io' && url.pathname === '/public')) &&
    KNOWN_HOSTS.has(url.hostname) ? url.hostname : null;
  const decoded = s => { try { return decodeURIComponent(s); } catch { return s; } };
  const secrets = [...new Set([url.hostname, url.username, url.password, ...url.pathname.split('/'), ...url.searchParams.values()]
    .filter(Boolean).flatMap(value => [value, decoded(value)]))].sort((a, b) => b.length - a.length);
  let auth;
  if (url.username || url.password) {
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('带账号密码的 BSC RPC 必须使用 HTTPS');
    }
    const encoded = Buffer.from(decoded(url.username) + ':' + decoded(url.password)).toString('base64');
    auth = 'Basic ' + encoded;
    secrets.unshift(auth, encoded);
    url.username = '';
    url.password = '';
  }
  return {
    url: url.href, canonical, auth, secrets, index, name: publicName ?? '自定义 RPC ' + (index + 1),
    state: 'checking', reason: null, score: null, head: null, headAt: null,
    failures: 0, due: 0, retryAt: null, generation: 0, unsupported: new Map(),
    probe: null, batch: true,
  };
}

function safeRpcError(error, endpoints, method, id) {
  const clean = s => {
    let value = String(s ?? 'RPC 请求失败').slice(0, 4096)
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL]');
    for (const { secrets } of endpoints) for (const secret of secrets) {
      // RPC keys sometimes appear as naked path / query fragments in errors.
      if (secret.length >= 3) value = value.split(secret).join('[隐藏]');
      else value = value.replace(new RegExp('(?<![\\w])' + secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g'), '[隐藏]');
    }
    if (method === RAW) value = value.replace(/0x[0-9a-f]{65,}/gi, '[交易数据]');
    return value.slice(0, 600);
  };
  const out = { code: Number.isSafeInteger(error?.code) ? error.code : -32000, message: clean(error?.message) };
  const isRevertData = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) && value.length <= 131_074;
  if (['eth_call', 'eth_estimateGas'].includes(method)) {
    if (isRevertData(error?.data)) out.data = error.data;
    else if (isRevertData(error?.data?.data)) out.data = { data: error.data.data, message: clean(error.data.message ?? error.message) };
  }
  return { id, jsonrpc: '2.0', error: out };
}
const failurePacket = (id, kind) => ({
  id, jsonrpc: '2.0',
  error: {
    code: kind === 'size' ? -32095 : kind === 'rate' ? -32096 : kind === 'method' ? -32097 : -32098,
    message: kind === 'rate' ? 'BSC RPC rate limit：等待节点恢复' : kind === 'size' ? 'BSC RPC response size limit exceeded' :
      kind === 'method' ? '可用 BSC RPC 不支持此方法' : '当前无可用的 BSC RPC，请稍后重试',
  },
});

class RpcPool extends JsonRpcProvider {
  #endpoints;
  #required;
  #fetch;
  #now;
  #timer;
  #initial;
  #checkedAt = null;
  #highHead = null;
  #highAt = null;
  #probeId = 0;
  #shutdown = new AbortController();
  #probeInterval;
  #probeTimeout;
  #requestTimeout;
  #responseBytes;
  #cooldown;

  constructor(urls, options) {
    super(undefined, 56, {
      staticNetwork: true, batchMaxCount: 8,
      batchStallTime: options.lowLatency ? 0 : 5, cacheTimeout: -1,
    });
    this.#endpoints = [...new Map(urls.map((url, index) => {
      const item = endpoint(url, index);
      return [item.canonical, item];
    })).values()];
    if (!this.#endpoints.length || this.#endpoints.length > 12) throw new Error('RPC 池须配置 1–12 个不同的 HTTP(S) 节点');
    this.#required = [...new Set(options.requiredMethods ?? [])];
    if (this.#required.some(method => !['eth_simulateV1', 'eth_getLogs'].includes(method))) throw new Error('RPC 池不支持所选探测方法');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#probeInterval = options.probeIntervalMs ?? 30_000;
    this.#probeTimeout = options.probeTimeoutMs ?? 2000;
    this.#requestTimeout = options.requestTimeoutMs ?? (options.lowLatency ? LOW_LATENCY_RPC_TIMEOUT_MS : 3500);
    this.#responseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.#responseBytes) || this.#responseBytes < 128 || this.#responseBytes > MAX_RESPONSE_BYTES) {
      throw new Error('Invalid RPC response size limit');
    }
    this.#cooldown = options.cooldownMs ?? 3500;
    this.#initial = this.#probeDue();
  }

  #sort(endpoints) {
    return endpoints.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || a.index - b.index);
  }
  #pick(payload, skip = new Set()) {
    const now = this.#now();
    return this.#sort(this.#endpoints.filter(ep => ep.state === 'healthy' && !skip.has(ep) &&
      payload.some(p => (ep.unsupported.get(p.method) ?? 0) <= now)));
  }
  async readyRpc() {
    await this.#initial;
    if (this.#shutdown.signal.aborted) throw rpcError('RPC 池已停止', 'CANCELLED');
    if (this.#endpoints.some(e => e.state === 'healthy')) return this;
    const recovery = this.#endpoints.filter(e => e.due <= this.#now());
    if (recovery.length) {
      await Promise.all(recovery.map(e => this.#probe(e)));
      if (this.#endpoints.some(e => e.state === 'healthy')) return this;
    }
    const limited = this.#endpoints.some(e => e.reason === 'rate-limit');
    throw rpcError(limited ? 'BSC RPC rate limit：等待节点恢复' :
      this.#endpoints.every(e => e.state === 'wrong-chain') ? 'RPC 不是 BSC 主网 (chain ID 56)' :
      '当前无可用的 BSC RPC（节点不可达、落后或不支持所需方法）', 'SERVER_ERROR', limited ? 429 : undefined);
  }
  async getNetwork() {
    await this.readyRpc();
    return super.getNetwork();
  }
  rpcStatus() {
    const preferred = this.#sort(this.#endpoints.filter(e => e.score !== null &&
      (e.state === 'healthy' || e.state === 'cooldown')))[0]?.name ?? null;
    const active = this.#sort(this.#endpoints.filter(e => e.state === 'healthy'))[0]?.name ?? null;
    return {
      primary: preferred ?? active, preferred: preferred ?? active, active, checkedAt: this.#checkedAt,
      endpoints: this.#sort([...this.#endpoints]).map(e => ({
        name: e.name, latencyMs: e.score === null ? null : Math.round(e.score),
        state: e.state, status: e.state, head: e.head, retryAt: e.retryAt, reason: e.reason,
      })),
    };
  }
  async refreshRpc() {
    await this.#initial;
    if (!this.#shutdown.signal.aborted) {
      const now = this.#now();
      await Promise.all(this.#endpoints.filter(e => e.state === 'healthy' || e.due <= now).map(e => this.#probe(e)));
    }
    return this.rpcStatus();
  }
  destroy() {
    this.#shutdown.abort();
    clearTimeout(this.#timer);
    super.destroy();
  }
  #schedule() {
    clearTimeout(this.#timer);
    if (this.#shutdown.signal.aborted) return;
    const due = Math.min(...this.#endpoints.filter(e => !e.probe).map(e => e.due));
    if (!Number.isFinite(due)) return;
    this.#timer = setTimeout(() => { void this.#probeDue(); }, Math.max(10, due - this.#now()));
    this.#timer.unref?.();
  }
  async #probeDue() {
    const now = this.#now();
    await Promise.all(this.#endpoints.filter(e => e.due <= now).map(e => this.#probe(e)));
    this.#schedule();
  }
  #penalize(ep, generation, reason, { retryMs = 0 } = {}) {
    if (this.#shutdown.signal.aborted || ep.generation !== generation) return;
    const transient = ['rate-limit', 'timeout', 'offline'].includes(reason);
    ep.generation++;
    ep.failures++;
    ep.state = reason === 'wrong-chain' ? 'wrong-chain' : transient ? 'cooldown' : 'unavailable';
    ep.reason = reason;
    const delay = transient ? Math.min(120_000, this.#cooldown * 2 ** Math.min(5, ep.failures - 1)) : this.#probeInterval;
    ep.due = ep.retryAt = this.#now() + Math.max(delay, retryMs);
    this.#schedule();
  }
  #recordHead(ep, height, at) {
    if (height === null) return false;
    ep.head = height;
    ep.headAt = at;
    if (this.#highAt !== null && at - this.#highAt <= HEAD_WINDOW && height + MAX_LAG < this.#highHead) return false;
    if (this.#highAt === null || height >= this.#highHead || at - this.#highAt > HEAD_WINDOW) {
      if (height !== this.#highHead || this.#highAt === null || at - this.#highAt > HEAD_WINDOW) this.#highAt = at;
      this.#highHead = height;
    }
    return true;
  }
  #demoteStale() {
    if (this.#highAt === null) return;
    for (const ep of this.#endpoints) {
      if (ep.state !== 'healthy' || ep.headAt === null) continue;
      // Compare near-concurrent samples; an older standby sample is not proof of lag.
      const ageBlocks = Math.ceil(Math.max(0, this.#highAt - ep.headAt) / 250);
      if (ageBlocks <= 8 && ep.head + MAX_LAG + ageBlocks < this.#highHead) {
        this.#penalize(ep, ep.generation, 'stale-head');
      }
    }
  }
  #probe(ep) {
    if (ep.probe) return ep.probe;
    if (this.#shutdown.signal.aborted) return Promise.resolve();
    const generation = ep.generation;
    ep.probe = (async () => {
      try {
        const [chain, head] = await Promise.all([
          this.#probeMethod(ep, 'eth_chainId', []),
          this.#probeMethod(ep, 'eth_blockNumber', []),
        ]);
        const chainId = quantity(chain.result);
        if (chainId === null) throw wireError('bad-response');
        if (BigInt(chainId) !== BSC_ID) throw wireError('wrong-chain');
        const number = quantity(head.result);
        if (number === null || number < 2) throw wireError('bad-response');
        const checks = await Promise.all(this.#required.map(method => this.#probeCapability(ep, method, number)));
        if (checks.some(latency => !Number.isFinite(latency))) throw wireError('unsupported');
        if (ep.generation !== generation || this.#shutdown.signal.aborted) return;
        if (!this.#recordHead(ep, number, head.at)) throw wireError('stale-head');
        const latency = checks.length ? Math.max(...checks) : head.latency;
        ep.score = ep.score === null ? latency : 0.65 * latency + 0.35 * ep.score;
        ep.state = 'healthy';
        ep.reason = null;
        ep.failures = 0;
        ep.retryAt = null;
        ep.due = this.#now() + this.#probeInterval;
        for (const method of this.#required) ep.unsupported.delete(method);
        this.#demoteStale();
      } catch (error) { this.#penalize(ep, generation, error?.kind === 'rate' ? 'rate-limit' : error?.kind ?? 'offline', error); }
      finally {
        this.#checkedAt = this.#now();
        ep.probe = null;
        this.#schedule();
      }
    })();
    return ep.probe;
  }
  async #probeMethod(ep, method, params) {
    // Several BSC clients parse IDs as unsigned integers.
    const id = 2_000_000_000 + (++this.#probeId % 100_000_000);
    const started = performance.now();
    const result = (await this.#wire(ep, [{ id, method, params, jsonrpc: '2.0' }], this.#probeTimeout)).get(id);
    if (!result) throw wireError('bad-response');
    if ('error' in result) {
      if (isLimit(result.error, method)) throw wireError('rate');
      if (methodPolicy(method, result.error)) throw wireError('unsupported');
      return { result: null, latency: Infinity, at: this.#now() };
    }
    return { result: result.result, latency: performance.now() - started, at: this.#now() };
  }
  async #probeCapability(ep, method, number) {
    const stable = toQuantity(number - 2);
    if (method === 'eth_getLogs') {
      const { result, latency } = await this.#probeMethod(ep, method, [{ ...PROBE_LOGS, fromBlock: stable, toBlock: stable }]);
      return Array.isArray(result) ? latency : Infinity;
    }
    const { result, latency } = await this.#probeMethod(ep, method, [{
      blockStateCalls: [{ calls: [{ from: '0x000000000000000000000000000000000000dEaD',
        to: '0x0000000000000000000000000000000000000004', data: '0x' }] }],
      validation: false,
    }, stable]);
    return quantity(result?.[0]?.calls?.[0]?.status) === 1 ? latency : Infinity;
  }
  async #wire(ep, items, timeout, { singleSubmission = false } = {}) {
    const signal = AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(timeout)]);
    const json = items.length === 1 ? items[0] : items;
    const payload = JSON.stringify(json);
    const headers = { 'content-type': 'application/json', ...(ep.auth ? { authorization: ep.auth } : {}) };
    // Fetch may transparently replay a buffered POST on HTTP 421. A
    // ReadableStream has no replayable body source; the exact Content-Length
    // keeps this a normal non-chunked JSON-RPC request for the gateway.
    const dataBytes = singleSubmission ? Buffer.from(payload) : null;
    if (dataBytes) headers['content-length'] = String(dataBytes.byteLength);
    const body = dataBytes ? new ReadableStream({
      start(controller) { controller.enqueue(dataBytes); controller.close(); },
    }) : payload;
    let response, data;
    try {
      response = await this.#fetch(ep.url, {
        method: 'POST', headers, body, ...(dataBytes ? { duplex: 'half' } : {}), redirect: 'error', signal,
      });
    } catch {
      throw wireError(signal.aborted && !this.#shutdown.signal.aborted ? 'timeout' : 'offline');
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const ms = !retry ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - this.#now();
      void response.body?.cancel().catch(() => {});
      throw wireError('rate', Math.min(MAX_RETRY_MS, Math.max(0, ms || 0)));
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (items.length > 1 && [400, 413, 415, 422].includes(response.status)) throw wireError('batch');
      throw wireError(response.status === 408 || response.status === 504 ? 'timeout' : 'offline');
    }
    const limit = Math.min(this.#responseBytes, items.reduce((size, item) =>
      size + (LARGE_READS.has(item.method) ? 8 * 1024 * 1024 : 128 * 1024), 0));
    try { data = await readBoundedJson(response, limit); }
    catch (error) {
      if (error?.kind === 'size') throw error;
      throw wireError(signal.aborted && !this.#shutdown.signal.aborted ? 'timeout' : 'bad-response');
    }
    if (items.length > 1 && !Array.isArray(data) && data?.id == null && [-32600, -32602].includes(data?.error?.code)) {
      throw wireError('batch');
    }
    const allowed = new Set(items.map(i => i.id));
    const found = new Map();
    for (const item of Array.isArray(data) ? data : [data]) {
      if (!item || item.jsonrpc !== '2.0' || !allowed.has(item.id) || found.has(item.id) ||
        (('result' in item) === ('error' in item)) || ('error' in item && !item.error)) {
        throw wireError('bad-response');
      }
      found.set(item.id, item);
    }
    return found;
  }
  async #route(items, allowFailover) {
    const pending = new Map(items.map(item => [item.id, item]));
    const results = new Map();
    const fallback = new Map();
    const absentReceipts = new Map();
    const receiptAttempts = new Map();
    const tried = new Set();
    while (pending.size && !this.#shutdown.signal.aborted) {
      const ep = this.#pick([...pending.values()], tried)[0];
      if (!ep) break;
      tried.add(ep);
      const generation = ep.generation;
      const group = [...pending.values()].filter(p => (ep.unsupported.get(p.method) ?? 0) <= this.#now());
      const keep = (item, packet) => { results.set(item.id, packet); pending.delete(item.id); };
      const retry = (item, kind) => {
        const packet = failurePacket(item.id, kind);
        const previous = fallback.get(item.id);
        if (!previous || kind === 'size' || (kind === 'rate' && previous.error.code !== -32095)) {
          fallback.set(item.id, packet);
        }
        if (!allowFailover) keep(item, packet);
      };
      const process = async group => {
        let packets;
        try {
          if (!ep.batch && group.length > 1) {
            for (const item of group) {
              if (ep.generation !== generation) { retry(item, ep.reason === 'rate-limit' ? 'rate' : 'unavailable'); continue; }
              await process([item]);
            }
            return;
          }
          for (const item of group) {
            if (item.method === RECEIPT) receiptAttempts.set(item.id, (receiptAttempts.get(item.id) ?? 0) + 1);
          }
          packets = await this.#wire(ep, group, this.#requestTimeout);
        } catch (error) {
          if (error?.kind === 'batch') {
            ep.batch = false;
            return process(group);
          }
          if (error?.kind === 'size') {
            for (const item of group) retry(item, 'size');
            return;
          }
          const limited = error?.kind === 'rate';
          this.#penalize(ep, generation, limited ? 'rate-limit' : error?.kind ?? 'offline', error);
          for (const item of group) retry(item, limited ? 'rate' : 'unavailable');
          return;
        }
        const chain = group.find(item => item.method === 'eth_chainId');
        const chainReply = chain && packets.get(chain.id);
        if (chainReply && 'result' in chainReply && BigInt(quantity(chainReply.result) ?? 0) !== BSC_ID) {
          this.#penalize(ep, generation, 'wrong-chain');
          for (const item of group) retry(item, 'unavailable');
          return;
        }
        if (ep.state === 'wrong-chain') {
          for (const item of group) retry(item, 'unavailable');
          return;
        }
        for (const item of group) {
          const packet = packets.get(item.id);
          if (!packet) {
            this.#penalize(ep, generation, 'bad-response');
            retry(item, 'unavailable');
            continue;
          }
          if ('error' in packet) {
            const { error } = packet;
            if (isLimit(error, item.method, allowFailover)) {
              this.#penalize(ep, generation, 'rate-limit');
              retry(item, 'rate');
            } else if (allowFailover && methodPolicy(item.method, error)) {
              ep.unsupported.set(item.method, this.#now() + this.#probeInterval * 5);
              if (this.#required.includes(item.method)) this.#penalize(ep, generation, 'unsupported');
              retry(item, 'method');
            } else if (allowFailover && pinnedUnavailable(item.method, item.params, error)) {
              retry(item, 'unavailable');
            } else if (item.method !== RECEIPT || !absentReceipts.has(item.id)) {
              keep(item, safeRpcError(error, this.#endpoints, item.method, item.id));
            }
            continue;
          }
          if (item.method === RECEIPT && packet.result === null) {
            absentReceipts.set(item.id, packet);
            continue;
          }
          const blockRequest = item.method === 'eth_getBlockByNumber' ? item.params?.[0] : null;
          if (item.method === 'eth_blockNumber' || blockRequest === 'latest') {
            const height = quantity(item.method === 'eth_blockNumber' ? packet.result : packet.result?.number);
            if (!this.#recordHead(ep, height, this.#now())) {
              this.#penalize(ep, generation, height === null ? 'bad-response' : 'stale-head');
              retry(item, 'unavailable');
              continue;
            }
          } else if (blockRequest && quantity(blockRequest) !== null && packet.result === null &&
            quantity(blockRequest) <= (this.#highHead ?? -1)) {
            retry(item, 'unavailable');
            continue;
          }
          keep(item, packet);
        }
      };
      await process(group);
      for (const item of group) {
        if (pending.has(item.id) && absentReceipts.has(item.id) && receiptAttempts.get(item.id) >= MAX_RECEIPT_ATTEMPTS) {
          keep(item, absentReceipts.get(item.id));
        }
      }
    }
    return items.map(i => results.get(i.id) ?? absentReceipts.get(i.id) ?? fallback.get(i.id) ??
      failurePacket(i.id, this.#endpoints.some(e => e.reason === 'rate-limit') ? 'rate' : 'method'));
  }
  async #postRaw(ep, item, singleSubmission) {
    const generation = ep.generation;
    let packet;
    try {
      // A stopped job can still have an in-flight POST; its outcome may be unknown.
      packet = (await this.#wire(ep, [item], this.#requestTimeout, { singleSubmission })).get(item.id);
    } catch (error) {
      if (error?.kind === 'rate') {
        this.#penalize(ep, generation, 'rate-limit', error);
        throw error; // Local HTTP 429, not an unstructured RPC error.
      }
      this.#penalize(ep, generation, error?.kind ?? 'offline', error);
      throw rpcError('Raw transaction submission outcome unknown');
    }
    if (!packet || ep.state === 'wrong-chain') throw rpcError('Raw transaction submission outcome unknown');
    if ('error' in packet) {
      if (isLimit(packet.error, RAW, false)) this.#penalize(ep, generation, 'rate-limit');
      // Don't expose upstream error text, which may contain credentials or raw data.
      throw rpcError('Raw transaction submission outcome unknown');
    }
    if (typeof packet.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(packet.result)) {
      throw rpcError('Raw transaction submission outcome unknown');
    }
    return packet.result;
  }
  async submitRawTransaction(signed, { signal, singleSubmission = false, broadcastConcurrency = 1, beforeDispatch, onDispatch } = {}) {
    if (typeof singleSubmission !== 'boolean') throw new TypeError('Invalid raw submission policy');
    if (!Number.isSafeInteger(broadcastConcurrency) || broadcastConcurrency < 1 ||
        broadcastConcurrency > MAX_BROADCAST_CONCURRENCY || (broadcastConcurrency > 1 && !singleSubmission)) {
      throw new TypeError('Invalid raw broadcast concurrency');
    }
    if (beforeDispatch !== undefined && (!singleSubmission || typeof beforeDispatch !== 'function')) {
      throw new TypeError('Invalid single-submission dispatch guard');
    }
    if (typeof signed !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(signed) || signed.length > 512 * 1024) {
      throw notSubmitted('Invalid raw transaction; not submitted');
    }
    const refused = (message, status) => notSubmitted(message, status, keccak256(signed));
    const stopped = () => signal?.aborted || this.#shutdown.signal.aborted;
    const mayStart = () => {
      if (stopped()) throw refused('Broadcast cancelled before acceptance');
    };
    const dispatched = count => { try { onDispatch?.(count); } catch { /* telemetry only */ } };
    mayStart();
    try { await this.readyRpc(); } catch { throw refused('No healthy RPC before broadcast'); }
    mayStart();
    // Readiness can suspend the caller. Recheck the synchronous gate before
    // the first POST; a closed gate is positive proof no endpoint saw the raw.
    try { beforeDispatch?.(); } catch { throw refused('Dispatch window closed before broadcast'); }
    const item = { id: 1, method: RAW, params: [signed], jsonrpc: '2.0' };
    if (broadcastConcurrency > 1) {
      mayStart();
      const endpoints = this.#pick([item]).slice(0, broadcastConcurrency);
      if (!endpoints.length) throw refused('No healthy RPC before broadcast');
      const expected = keccak256(signed);
      const posts = [];
      // One bounded wave, one POST per selected RPC, all for the signed hash
      // already in the journal. Never open new slots after this wave starts.
      for (const ep of endpoints) {
        if (stopped()) break;
        posts.push(this.#postRaw(ep, item, true).then(hash => {
          if (hash.toLowerCase() !== expected) throw rpcError('Raw transaction submission outcome unknown');
          return hash;
        }));
      }
      if (!posts.length) throw refused('Broadcast cancelled before acceptance');
      dispatched(posts.length);
      try { return await Promise.any(posts); }
      catch (error) {
        // Only release the nonce if every started POST was definitely rejected.
        if (error.errors.every(e => e?.kind === 'rate')) {
          throw refused('All attempted RPC nodes refused the broadcast (HTTP 429)', 429);
        }
        throw rpcError('Raw transaction submission outcome unknown');
      }
    }
    const tried = new Set();
    while (true) {
      mayStart();
      const ep = this.#pick([item], tried)[0];
      if (!ep) throw refused(tried.size ? 'All attempted RPC nodes refused the broadcast (HTTP 429)' :
        'No healthy RPC before broadcast', tried.size ? 429 : undefined);
      tried.add(ep);
      const post = this.#postRaw(ep, item, singleSubmission);
      dispatched(tried.size);
      try {
        return await post;
      } catch (error) {
        if (error?.kind !== 'rate') throw error;
        if (singleSubmission) throw refused('Single submission refused (HTTP 429)', 429);
      }
    }
  }
  async send(method, params) {
    if (method === RAW) return this.submitRawTransaction(Array.isArray(params) && params.length === 1 ? params[0] : null);
    return super.send(method, params);
  }
  async _send(payload) {
    await this.readyRpc();
    const items = Array.isArray(payload) ? payload : [payload];
    const reads = items.filter(i => READS.has(i.method));
    const singles = items.filter(i => !READS.has(i.method));
    // Do not batch writes: one gateway reply must describe exactly one signed
    // request. A timeout/malformed/5xx reply is ambiguous, so never resend.
    const groups = [...(reads.length ? [this.#route(reads, true)] : []),
      ...singles.map(async i => i.method === RAW ?
        [{ id: i.id, jsonrpc: '2.0', result: await this.submitRawTransaction(i.params?.[0]) }] : this.#route([i], false))];
    return (await Promise.all(groups)).flat();
  }
  getRpcError(payload, packet) {
    const code = packet.error?.code;
    if (code === -32095 || code === -32096 || code === -32098) {
      return rpcError(packet.error.message, 'SERVER_ERROR', code === -32096 ? 429 : undefined);
    }
    if (code === -32097) return rpcError(packet.error.message, 'UNSUPPORTED_OPERATION');
    // Keep ethers' error codes (including CALL_EXCEPTION) without echoing a raw signed transaction.
    return super.getRpcError(payload.method === RAW ? { ...payload, params: ['[交易数据]'] } : payload, packet);
  }
}

export function createRpcPool(urls, options = {}) {
  if (!Array.isArray(urls)) throw new Error('RPC 池须配置 HTTP(S) URL 数组');
  return new RpcPool(urls, options);
}
