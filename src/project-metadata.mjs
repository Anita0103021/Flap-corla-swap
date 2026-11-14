import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import { FACTORY, address } from './config.mjs';
import { readCorlaCreation } from './corla-creation.mjs';

// Flap's documented gateway. Never fetch a publisher-supplied host or redirect.
export const FLAP_IMAGE_ORIGIN = 'https://flap.mypinata.cloud';
const IPFS_HOSTS = new Set([FLAP_IMAGE_ORIGIN, 'https://ipfs.io', 'https://gateway.pinata.cloud', 'https://dweb.link']);
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,104})$/;
const SEGMENT = /^[A-Za-z0-9_.~-]{1,80}$/;
const MAX_JSON_BYTES = 48 * 1024;
const MAX_DESCRIPTION_CHARS = 180;
const REGISTRY = new Interface([
  'function deploymentIndexPlusOne(address) view returns (uint256)',
  'function deployment(uint256) view returns (address mint, address creator, address expectedToken)',
]);

export function ipfsPath(input) {
  if (typeof input !== 'string' || input.length > 280) return null;
  let path = input.trim();
  if (path.startsWith('ipfs://')) {
    path = path.slice(7).replace(/^ipfs\//, '');
  } else if (path.startsWith('https://')) {
    // Do not let the URL parser normalize a supplied traversal segment.
    const match = /^(https:\/\/[a-z.]+)\/ipfs\/([^?#]+)$/.exec(path);
    if (!match || !IPFS_HOSTS.has(match[1])) return null;
    path = match[2];
  }
  const [cid, ...segments] = path.split('/');
  if (!CID.test(cid) || segments.length > 4 ||
      segments.some(segment => segment === '.' || segment === '..' || !SEGMENT.test(segment))) return null;
  return path;
}

function safeLabel(value, length) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
  return Array.from(clean).slice(0, length).join('') || undefined;
}

export function rawCidDigest(path) {
  if (!/^b[a-z2-7]+$/.test(path)) return null;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of path.slice(1)) {
    acc = (acc << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 255);
    }
  }
  return bytes.length === 36 && bytes[0] === 1 && bytes[1] === 0x55 &&
    bytes[2] === 0x12 && bytes[3] === 32 ? Buffer.from(bytes.slice(4)) : null;
}

async function fetchDisplayMeta(fetchImpl, path, timeoutMs) {
  const response = await fetchImpl(FLAP_IMAGE_ORIGIN + '/ipfs/' + path, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json, text/plain, application/octet-stream' },
  });
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
  const max = Number(response.headers.get('content-length') ?? 0);
  if (!response.ok || response.redirected || max > MAX_JSON_BYTES ||
      (type && !['application/json', 'text/plain', 'application/octet-stream'].includes(type)) || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) return null;
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = Buffer.concat(chunks, bytes);
  const digest = rawCidDigest(path);
  if (digest && !createHash('sha256').update(body).digest().equals(digest)) return null;
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  return {
    imagePath: ipfsPath(json?.image),
    // Publisher-controlled text, not HTML or a link; frontend must render it
    // as text. Collapse whitespace for a short one-card synopsis.
    description: typeof json?.description === 'string'
      ? safeLabel(json.description.replace(/\s+/gu, ' '), MAX_DESCRIPTION_CHARS)
      : undefined,
  };
}

async function readCreation(provider, target, blockTag) {
  const [indexResult, params] = await Promise.all([
    provider.call({ to: FACTORY, data: REGISTRY.encodeFunctionData('deploymentIndexPlusOne', [target.mint]), blockTag }),
    readCorlaCreation(provider, target.mint, blockTag),
  ]);
  const [index] = REGISTRY.decodeFunctionResult('deploymentIndexPlusOne', indexResult);
  if (index === 0n) return null;
  const deployment = await provider.call({ to: FACTORY, data: REGISTRY.encodeFunctionData('deployment', [index - 1n]), blockTag });
  const [mint, , expectedToken] = REGISTRY.decodeFunctionResult('deployment', deployment);
  if (mint !== target.mint || expectedToken !== target.token) return null;
  return {
    name: safeLabel(params.launch.name, 80),
    symbol: safeLabel(params.launch.symbol, 32),
    path: ipfsPath(params.launch.meta),
    initialSupply: params.launch.totalSupply > 0n ? params.launch.totalSupply.toString() : undefined,
  };
}

async function deadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

// Display-only data; never used by Mint execution, Sniper, or contract identity checks.
export function createProjectMetadata({
  fetchImpl = globalThis.fetch, maxEntries = 256, maxInFlight = 40,
  ttlMs = 30 * 60_000, partialTtlMs = 30_000, errorTtlMs = 5000,
  timeoutMs = 2400, rpcTimeoutMs = 4200, now = Date.now,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  function memoize(key, value, ttl) {
    cache.delete(key);
    if (value && ttl < ttlMs) value = { ...value, retryAfterMs: ttl };
    cache.set(key, { value, expires: now() + ttl });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    async lookup(provider, target, blockTag = 'latest') {
      let mint, token;
      try {
        if (address(target?.factory, '工厂') !== FACTORY) return null;
        mint = address(target?.mint, 'Mint');
        token = address(target?.token, 'Token');
        if (mint === token) return null;
      } catch { return null; }
      const key = mint + ':' + token;
      const cached = cache.get(key);
      if (cached && cached.expires > now()) {
        cache.delete(key);
        cache.set(key, cached);
        return cached.value;
      }
      if (inflight.has(key)) return inflight.get(key);
      if (inflight.size >= maxInFlight) return cached?.value ?? null;
      const task = (async () => {
        let creation;
        try {
          creation = await deadline(readCreation(provider, { mint, token }, blockTag), rpcTimeoutMs);
        } catch { /* Unsupported data layout or RPC unavailable: no invented metadata. */ }
        if (!creation) return memoize(key, cached?.value ?? null, errorTtlMs);
        const { name, symbol, path, initialSupply } = creation;
        let display;
        if (path) {
          try { display = await deadline(fetchDisplayMeta(fetchImpl, path, timeoutMs), timeoutMs); }
          catch { /* Names from the verified on-chain record are still useful. */ }
        }
        const { imagePath, description } = display ?? {};
        const old = cached?.value;
        const image = imagePath ? FLAP_IMAGE_ORIGIN + '/ipfs/' + imagePath : old?.image;
        const displayDescription = description || old?.description;
        const supply = initialSupply || old?.initialSupply;
        const value = { mint, token, name: name || old?.name, symbol: symbol || old?.symbol, image,
          ...(displayDescription ? { description: displayDescription } : {}),
          ...(supply ? { initialSupply: supply } : {}) };
        if (!value.name && !value.symbol && !image && !displayDescription && !supply) return memoize(key, null, errorTtlMs);
        return memoize(key, value, imagePath || !path ? ttlMs : partialTtlMs);
      })();
      inflight.set(key, task);
      try { return await task; } finally { inflight.delete(key); }
    },
  };
}
