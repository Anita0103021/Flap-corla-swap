import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import { CHAIN_ID, FACTORY } from './config.mjs';
import { MULTICALL3 } from './dashboard-chain.mjs';
import { decodePoolQuoteConfig, poolQuoteQuery } from './pool-launch.mjs';
import { FLAP_IMAGE_ORIGIN, rawCidDigest } from './project-metadata.mjs';
import { QUOTE_ERC20 } from './quote-assets.mjs';

export const CORLA_CREATE_URL = 'https://flap.sh/apps/corla/create?lang=zh';
const ABI = new Interface([
  'function getChainId() view returns (uint256)',
  'function getBlockNumber() view returns (uint256)',
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])',
  'function previewQuoteToken(address) view returns (uint8 decimals)',
]);
const GATEWAY = FLAP_IMAGE_ORIGIN + '/ipfs/';
const MAX_ASSETS = 256;
const READ_BYTES = 256 * 1024;
const bounds = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

async function readBytes(fetchImpl, url, max, signal) {
  const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal });
  if (!response.ok || response.redirected || Number(response.headers.get('content-length') ?? 0) > max || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Flap 创建页目录读取失败');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > max) throw new Error('Flap 创建页目录超出读取限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function parseQuoteCatalog(json) {
  const { schemaVersion, chainId, assets } = json ?? {};
  if (schemaVersion !== 1 || chainId !== Number(CHAIN_ID) ||
      !Array.isArray(assets) || !assets.length || assets.length > MAX_ASSETS) throw new Error('Flap 底池目录格式有变更');
  const seen = new Set();
  const rows = assets.map(row => {
    if (row?.chainId !== chainId || !/^0x[\da-f]{40}$/i.test(row.address ?? '') ||
        !/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,31}$/.test(row.symbol ?? '') ||
        !['featured', 'stocks'].includes(row.category) ||
        !Number.isSafeInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) {
      throw new Error('Flap 底池目录含无效资产');
    }
    const address = getAddress(row.address);
    if (seen.has(address)) throw new Error('Flap 底池目录含重复资产');
    seen.add(address);
    return { address, symbol: row.symbol, decimals: row.decimals, category: row.category };
  });
  if (!rows.some(row => row.address === ZeroAddress && row.symbol === 'BNB' && row.decimals === 18 && row.category === 'featured')) {
    throw new Error('Flap 底池目录缺少原生资产');
  }
  return rows;
}

async function readCatalogCid(cid, fetchImpl, signal) {
  const digest = typeof cid === 'string' && /^b[a-z2-7]{58}$/.test(cid) && rawCidDigest(cid);
  if (!digest) throw new Error('Flap 创建页底池目录 CID 无效');
  const body = await readBytes(fetchImpl, GATEWAY + cid, READ_BYTES, signal);
  if (!createHash('sha256').update(body).digest().equals(digest)) throw new Error('Flap 底池目录 CID 校验失败');
  return parseQuoteCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
}

/** Public directory snapshot from CORLA_CREATE_URL. A verified newer CID can
 * be configured without editing code. This list is never used for trading. */
export async function loadFlapQuoteCatalog(fetchImpl = globalThis.fetch, cidOverride = process.env.FLAP_CORLA_QUOTE_CATALOG_CID) {
  const saved = JSON.parse(await readFile(new URL('./flap-quote-catalog.json', import.meta.url), 'utf8'));
  if (saved.source !== CORLA_CREATE_URL) throw new Error('本地底池候选目录来源无效');
  const cid = cidOverride || saved.cid;
  if (cid === saved.cid) return { cid, assets: parseQuoteCatalog(saved) };
  return { cid, assets: await readCatalogCid(cid, fetchImpl, AbortSignal.timeout(6000)) };
}

function readResult(abi, method, row) {
  const raw = row?.returnData;
  if (!row?.success || typeof raw !== 'string') return null;
  try {
    const decoded = abi.decodeFunctionResult(method, raw);
    return abi.encodeFunctionResult(method, decoded).toLowerCase() === raw.toLowerCase() ? decoded : null;
  } catch { return null; }
}

export async function inspectFlapQuoteCatalog(provider, catalog) {
  const head = await provider.getBlock('latest');
  if (!Number.isSafeInteger(head?.number) || head.number < 1) throw new Error('底池目录缺少最新 BSC 区块');
  const check = (name, values = []) => ({ to: MULTICALL3, data: ABI.encodeFunctionData(name, values) });
  const results = [];
  // Two bounded multicalls per wave; this runs only on demand, not at launch.
  for (const wave of bounds(bounds(catalog.assets, 30), 2)) {
    const group = await Promise.all(wave.map(async assets => {
      const calls = [check('getChainId'), check('getBlockNumber'), ...assets.flatMap(({ address }) => [
        poolQuoteQuery(address),
        { to: FACTORY, data: ABI.encodeFunctionData('previewQuoteToken', [address]) },
        // Multicall always returns a third result to preserve row alignment.
        address === ZeroAddress ? check('getChainId') : { to: address, data: QUOTE_ERC20.encodeFunctionData('decimals') },
      ])];
      const raw = await provider.call({ to: MULTICALL3, blockTag: head.number,
        data: ABI.encodeFunctionData('aggregate3', [calls.map(({ to, data }) => [to, true, data])]) });
      const [rows] = ABI.decodeFunctionResult('aggregate3', raw);
      if (rows.length !== calls.length || readResult(ABI, 'getChainId', rows[0])?.[0] !== CHAIN_ID ||
          readResult(ABI, 'getBlockNumber', rows[1])?.[0] !== BigInt(head.number)) throw new Error('底池目录批量读取与 BSC 快照不一致');
      return assets.map((asset, i) => {
        const [portal, factory, token] = rows.slice(2 + i * 3, 5 + i * 3);
        let config;
        try { if (portal.success) config = decodePoolQuoteConfig(portal.returnData); } catch { /* Unknown is not disabled. */ }
        const factoryDecimals = readResult(ABI, 'previewQuoteToken', factory)?.[0];
        const decimals = asset.address === ZeroAddress ? 18n : readResult(QUOTE_ERC20, 'decimals', token)?.[0];
        const validDecimals = decimals === factoryDecimals && decimals === BigInt(asset.decimals);
        const status = !config ? 'unknown' : config.enabled === false ? 'disabled' :
          validDecimals && (asset.address === ZeroAddress || config.quotePriceUsd > 0n) ? 'enabled' : 'unverified';
        return { ...asset, status };
      });
    }));
    results.push(...group.flat());
  }
  return { block: head.number, cid: catalog.cid, assets: results };
}

export function createFlapQuoteCatalog({ load = loadFlapQuoteCatalog, inspect = inspectFlapQuoteCatalog, now = Date.now } = {}) {
  let directory, snapshot, inFlight;
  return async provider => {
    if (snapshot && now() - snapshot.time < 30_000) return snapshot.data;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let directoryStale = false;
      if (!directory || now() - directory.time >= 10 * 60_000) {
        try { directory = { data: await load(), time: now() }; }
        catch (error) {
          if (!directory) throw error;
          directoryStale = true;
        }
      }
      try {
        const data = { ...await inspect(provider, directory.data), ...(directoryStale ? { directoryStale } : {}) };
        snapshot = { data, time: now() };
        return data;
      } catch (error) {
        if (!snapshot) throw error;
        return { ...snapshot.data, stale: true };
      }
    })();
    try { return await inFlight; } finally { inFlight = undefined; }
  };
}
