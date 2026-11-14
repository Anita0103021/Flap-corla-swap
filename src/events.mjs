import { AbiCoder, Interface, ZeroAddress, getAddress, id, zeroPadValue } from 'ethers';
import { FACTORY, int } from './config.mjs';
import { PANCAKE_FACTORY, WBNB } from './market.mjs';
import { DIRECT_LAUNCH_PORTAL } from './pool-launch.mjs';
import { quoteAsset } from './quote-assets.mjs';

export { DIRECT_LAUNCH_PORTAL };
// Observed at Corla v4 launch tx 0x59b184bd... and factory creation tx 0x26f1b611....
export const CORLA_LAUNCH_TOPIC = '0x33a8c95f5f2db419267a319b5eae65e50fdbec72a10c6e0bc380268275dee1e4';
export const CORLA_CREATED_TOPIC = '0x3c32f24b29de91aa01e490e681071d2eb04a2efe649d0a47425f5f518126b3be';
export const MAX_DISCOVERY_BLOCKS = 50_000;
const V2_SCHEMA = id('DirectLaunchV2(DirectLaunchV2Data)');
const PORTAL = new Interface(['event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)']);
const PAIR = new Interface([
  'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
]);
const V2_FACTORY = new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)']);
const ABI = AbiCoder.defaultAbiCoder();
const V2_DATA = 'tuple(uint256 nonce,uint256 ts,uint8 tokenVersion,address quoteToken,uint8 migratorType,uint256 initialPriceWad,string name,string symbol,string meta,address pool,uint256 totalSupply,uint8 antiSniperMode,uint16 maxBuyBps)';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const logAddress = topic => {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topic)) return null;
  const result = getAddress('0x' + topic.slice(-40).toLowerCase());
  return result === ZeroAddress ? null : result;
};

function validateRange(fromBlock, toBlock, maxSpan) {
  int(fromBlock, '起始区块', 0, Number.MAX_SAFE_INTEGER);
  int(toBlock, '结束区块', fromBlock, Number.MAX_SAFE_INTEGER);
  if (toBlock - fromBlock + 1 > maxSpan) throw new Error('日志查询最多允许 ' + maxSpan + ' 个区块');
}

function rpcErrorText(error) {
  return [error?.shortMessage, error?.message, error?.error?.message, error?.info?.error?.message,
    error?.info?.responseStatus].join(' ');
}
function explicitlyRateLimited(error) {
  return [error?.status, error?.statusCode, error?.error?.status, error?.info?.status].includes(429) ||
    /\b429\b|rate[- ]?limit|request[- ]?limit|too many requests|throttl/i.test(rpcErrorText(error));
}
export function isRpcLimit(error) {
  return explicitlyRateLimited(error) ||
    [error?.code, error?.error?.code, error?.info?.error?.code].includes(-32005);
}

// RPC providers impose different getLogs range/result limits. Split just those
// errors; fail closed on any unavailable or partial history.
async function getLogs(provider, filter, fromBlock, toBlock) {
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (error) {
    // -32005 is also used for rate limits. Recursing on an ambiguous response
    // can multiply load during an outage, so split only explicit range errors.
    const limit = !explicitlyRateLimited(error) &&
      /block range|blocks range|range must|query returned more than|response size|too many results|maximum number of (?:blocks|logs)/i.test(rpcErrorText(error));
    if (fromBlock >= toBlock || !limit) throw error;
    const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
    return [...await getLogs(provider, filter, fromBlock, mid), ...await getLogs(provider, filter, mid + 1, toBlock)];
  }
}

function validLog(log, contract, topic, from, to) {
  return log && !log.removed && same(log.address, contract) && same(log.topics?.[0], topic) &&
    hash(log.transactionHash) && hash(log.blockHash) && Number.isSafeInteger(log.blockNumber) &&
    log.blockNumber >= from && log.blockNumber <= to;
}

export function portalLaunchQuote(log, token, pool) {
  if (!same(log?.address, DIRECT_LAUNCH_PORTAL)) return null;
  try {
    const decoded = PORTAL.parseLog(log);
    if (!decoded || !same(decoded.args.token, token) || decoded.args.kind !== 0n || !same(decoded.args.schemaId, V2_SCHEMA)) return null;
    const [data] = ABI.decode([V2_DATA], decoded.args.data);
    return data.migratorType === 1n && data.tokenVersion === 0n && same(data.pool, pool) &&
      data.totalSupply > 0n ? data.quoteToken : null;
  } catch { return null; }
}

function seededPair(log, pool) {
  if (!same(log?.address, pool)) return false;
  try {
    const decoded = PAIR.parseLog(log);
    return Boolean(decoded && same(decoded.args.sender, DIRECT_LAUNCH_PORTAL) &&
      decoded.args.amount0 > 0n && decoded.args.amount1 > 0n);
  } catch { return false; }
}

function exactEvent(abi, event, log) {
  try {
    const parsed = abi.parseLog(log);
    if (parsed?.name !== event) return null;
    const encoded = abi.encodeEventLog(event, parsed.args);
    if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length ||
        !encoded.topics.every((topic, i) => same(topic, log.topics[i]))) return null;
    return parsed.args;
  } catch { return null; }
}

function receiptLogIndex(log) {
  const index = log.index ?? log.logIndex;
  if (Number.isSafeInteger(index) && index >= 0) return index;
  if (typeof index === 'string' && /^0x[0-9a-f]{1,13}$/i.test(index)) return Number(BigInt(index));
  return null;
}

// Only a new official V2 pair, its first reserve update immediately followed
// by the Portal's seed Mint, and the subsequent matching launch attestations
// establish a price reference. End-of-block reserves may already include buys.
function initialLiquidity(receipt, target, pool, launchTopics) {
  const quoteToken = quoteAsset(target.quoteToken);
  const asset = quoteToken === ZeroAddress ? WBNB : quoteToken;
  if (same(target.token, asset) || receipt.logs.length > 1024) return null;
  function unique(contract, topic) {
    let result;
    for (const [i, log] of receipt.logs.entries()) {
      if (!same(log?.address, contract) || !same(log.topics?.[0], topic)) continue;
      if (result || !Array.isArray(log.topics) || (log.removed !== undefined && log.removed !== false) ||
          (log.blockHash != null && !same(log.blockHash, receipt.blockHash)) ||
          (log.transactionHash != null && !same(log.transactionHash, receipt.hash)) ||
          (log.blockNumber != null && log.blockNumber !== receipt.blockNumber)) return null;
      result = { log, i };
    }
    return result;
  }
  const created = unique(PANCAKE_FACTORY, V2_FACTORY.getEvent('PairCreated').topicHash);
  const sync = unique(pool, PAIR.getEvent('Sync').topicHash);
  const mint = unique(pool, PAIR.getEvent('Mint').topicHash);
  const portal = unique(DIRECT_LAUNCH_PORTAL, PORTAL.getEvent('FlapDirectLaunched').topicHash);
  const launch = unique(target.mint, CORLA_LAUNCH_TOPIC);
  if (!created || !sync || !mint || !portal || !launch ||
      !(created.i < sync.i && sync.i + 1 === mint.i && mint.i < portal.i && portal.i < launch.i) ||
      !same(portalLaunchQuote(portal.log, target.token, pool), quoteToken) || launch.log.data !== '0x' ||
      launch.log.topics.length !== launchTopics.length ||
      !launch.log.topics.every((topic, i) => same(topic, launchTopics[i]))) return null;

  const indexes = [created, sync, mint, portal, launch].map(({ log }) => receiptLogIndex(log));
  if (indexes.some((index, i) => index === null || (i && index <= indexes[i - 1])) ||
      indexes[1] + 1 !== indexes[2]) return null;

  const pair = exactEvent(V2_FACTORY, 'PairCreated', created.log);
  const reserves = exactEvent(PAIR, 'Sync', sync.log);
  const funding = exactEvent(PAIR, 'Mint', mint.log);
  const quoteFirst = asset.toLowerCase() < target.token.toLowerCase();
  if (!pair || !reserves || !funding || !same(pair.pair, pool) || pair.pairCount <= 0n ||
      !same(pair.token0, quoteFirst ? asset : target.token) || !same(pair.token1, quoteFirst ? target.token : asset) ||
      !same(funding.sender, DIRECT_LAUNCH_PORTAL) || reserves.reserve0 <= 0n || reserves.reserve1 <= 0n ||
      funding.amount0 !== reserves.reserve0 || funding.amount1 !== reserves.reserve1) return null;

  const reserveQuote = quoteFirst ? reserves.reserve0 : reserves.reserve1;
  return { ...(quoteToken === ZeroAddress ? { reserveBnb: reserveQuote } : { reserveQuote }),
    reserveToken: quoteFirst ? reserves.reserve1 : reserves.reserve0 };
}

/** An address/topic filter usable for both eth_getLogs and eth_subscribe. */
export function corlaLaunchFilter(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 32) throw new Error('开盘监听需要 1–32 个 Corla 项目');
  const address = [];
  const tokens = [];
  const seen = new Set();
  for (const target of targets) {
    if (!same(target?.factory, FACTORY)) throw new Error('不支持的 Corla v4 工厂');
    const mint = getAddress(target.mint);
    const token = getAddress(target.token);
    if (mint === ZeroAddress || token === ZeroAddress || mint === token || seen.has(mint)) throw new Error('开盘监听项目地址无效或重复');
    seen.add(mint);
    address.push(mint);
    tokens.push(zeroPadValue(token, 32));
  }
  return { address, topics: [CORLA_LAUNCH_TOPIC, tokens] };
}

/** Decode one untrusted log, locally binding it to its allowlisted Mint/Token.
 * Node JSON-RPC logs use hex block numbers; ethers getLogs formats numbers.
 * This does not establish that the receipt is canonical or that liquidity exists.
 */
export function decodeLaunchCandidate(target, raw, fromBlock, toBlock, { allowRemoved = false } = {}) {
  if (!raw || !same(target?.factory, FACTORY) || !Array.isArray(raw.topics) || raw.topics.length !== 4 ||
      raw.data !== '0x' || (raw.removed !== undefined && typeof raw.removed !== 'boolean') ||
      (raw.removed === true && !allowRemoved)) return null;
  const blockNumber = typeof raw.blockNumber === 'string' && /^0x[0-9a-f]{1,14}$/i.test(raw.blockNumber)
    ? Number(BigInt(raw.blockNumber)) : raw.blockNumber;
  const log = { address: raw.address, topics: raw.topics, transactionHash: raw.transactionHash, blockHash: raw.blockHash, blockNumber };
  if (!validLog(log, target.mint, CORLA_LAUNCH_TOPIC, fromBlock, toBlock)) return null;
  const token = logAddress(raw.topics[1]);
  const pool = logAddress(raw.topics[2]);
  const caller = logAddress(raw.topics[3]);
  if (!same(token, target.token) || !pool || !caller || same(pool, token) || same(pool, target.mint)) return null;
  return {
    target, token, mint: target.mint, pool, caller,
    blockNumber, blockHash: raw.blockHash.toLowerCase(), txHash: raw.transactionHash.toLowerCase(),
    ...(raw.removed === true ? { removed: true } : {}),
  };
}

/** One bounded HTTP query for all allowlisted Corla launches in a window. */
export async function readLaunchCandidates(provider, targets, fromBlock, toBlock) {
  validateRange(fromBlock, toBlock, 101);
  const filter = corlaLaunchFilter(targets);
  const byMint = new Map(targets.map(target => [target.mint.toLowerCase(), target]));
  const logs = await getLogs(provider, filter, fromBlock, toBlock);
  if (!Array.isArray(logs) || logs.length > 1024) throw new Error('开盘日志返回异常');
  const candidates = [];
  for (const log of logs) {
    if (typeof log?.address !== 'string') continue;
    const decoded = decodeLaunchCandidate(byMint.get(log.address.toLowerCase()), log, fromBlock, toBlock);
    if (decoded) candidates.push(decoded);
  }
  return candidates.sort((a, b) => a.blockNumber - b.blockNumber);
}

/** Bind a WebSocket or HTTP observation to the same successful receipt as
 * the official Portal V2 launch, expected payment asset, and positive V2 LP seed.
 */
export async function verifyLaunchCandidate(provider, candidate) {
  if (!candidate || candidate.removed || !same(candidate.target?.factory, FACTORY) ||
      !same(candidate.target?.mint, candidate.mint) || !same(candidate.target?.token, candidate.token) ||
      !Number.isSafeInteger(candidate.blockNumber) || candidate.blockNumber < 0 ||
      !hash(candidate.blockHash) || !hash(candidate.txHash)) return null;
  const { target, token, pool, caller, blockNumber, blockHash, txHash } = candidate;
  const quoteToken = quoteAsset(target.quoteToken);
  let topics;
  try {
    topics = [CORLA_LAUNCH_TOPIC, ...[token, pool, caller].map(addr => zeroPadValue(getAddress(addr), 32))];
  } catch { return null; }
  if (!decodeLaunchCandidate(target, { address: target.mint, topics, data: '0x', transactionHash: txHash, blockNumber, blockHash },
    blockNumber, blockNumber)) return null;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1 || receipt.blockNumber !== blockNumber ||
      !same(receipt.blockHash, blockHash) || !same(receipt.hash, txHash) || !Array.isArray(receipt.logs)) return null;
  // Confirm the candidate itself is present in the receipt; an announced log
  // could become stale before the canonical head check at signing time.
  if (!receipt.logs.some(l => !l?.removed && same(l?.address, target.mint) && l.data === '0x' &&
      l.topics?.length === topics.length && l.topics.every((topic, i) => same(topic, topics[i]))) ||
      !receipt.logs.some(l => same(portalLaunchQuote(l, token, pool), quoteToken)) ||
      !receipt.logs.some(l => seededPair(l, pool))) return null;
  const openingReserves = initialLiquidity(receipt, target, pool, topics);
  // An untrusted event must not smuggle in a price reference if the receipt
  // lacks the stronger initial-liquidity evidence.
  const { openingReserves: _untrusted, ...observation } = candidate;
  return { ...observation, pool: getAddress(pool), caller: getAddress(caller),
    ...(quoteToken === ZeroAddress ? {} : { quoteToken }),
    ...(openingReserves ? { openingReserves } : {}) };
}

/**
 * Evidence for a recent launch, not just 100% funded. Bind the indexed Corla
 * event to the same successful receipt as the official Portal and V2 LP seed.
 */
export async function findLaunch(provider, target, state, fromBlock, toBlock) {
  validateRange(fromBlock, toBlock, 101);
  if (state?.launched !== true || !state.pool || same(state.pool, ZeroAddress)) return null;
  if (!same(target.factory, FACTORY)) throw new Error('不支持的 Corla v4 工厂');
  const pool = getAddress(state.pool);
  const topics = [CORLA_LAUNCH_TOPIC, zeroPadValue(target.token, 32), zeroPadValue(pool, 32)];
  const logs = await getLogs(provider, { address: target.mint, topics }, fromBlock, toBlock);
  const candidates = logs.map(log => decodeLaunchCandidate(target, log, fromBlock, toBlock))
    .filter(candidate => candidate && same(candidate.pool, pool));
  if (candidates.length !== 1) return null;
  const launch = await verifyLaunchCandidate(provider, candidates[0]);
  if (!launch) return null;
  const { token, mint, caller, blockNumber, blockHash, txHash, openingReserves, quoteToken } = launch;
  return { token, mint, pool, caller, blockNumber, blockHash, txHash,
    ...(quoteToken ? { quoteToken } : {}),
    ...(openingReserves ? { openingReserves } : {}) };
}

/** Read-only catalog candidates. These are never enrolled for automatic buys. */
export async function discoverProjects(provider, fromBlock, toBlock) {
  validateRange(fromBlock, toBlock, MAX_DISCOVERY_BLOCKS);
  const candidates = [];
  const seen = new Set();
  for (let start = fromBlock; start <= toBlock; start += 2000) {
    const end = Math.min(start + 1999, toBlock);
    const logs = await getLogs(provider, { address: FACTORY, topics: [CORLA_CREATED_TOPIC] }, start, end);
    for (const log of logs) {
      if (!validLog(log, FACTORY, CORLA_CREATED_TOPIC, start, end) || log.topics.length !== 4) continue;
      const [mint, creator, token] = log.topics.slice(1).map(logAddress);
      if (!mint || !creator || !token || mint === token || seen.has(mint)) continue;
      seen.add(mint);
      const query = new URLSearchParams({ mint, factory: FACTORY, catalogVersion: '4', lang: 'zh' });
      candidates.push({
        mint, creator, token, factory: FACTORY, blockNumber: log.blockNumber, blockHash: log.blockHash,
        txHash: log.transactionHash, url: 'https://flap.sh/apps/corla/mint/' + token + '?' + query,
      });
    }
  }
  return candidates.sort((a, b) => b.blockNumber - a.blockNumber);
}
