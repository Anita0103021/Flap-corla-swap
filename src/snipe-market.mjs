import { Interface, keccak256, ZeroAddress } from 'ethers';
import { CHAIN_ID, FACTORY, address } from './config.mjs';
import { CORLA_ABI, verifySnipeState } from './corla.mjs';
import { isRpcLimit } from './events.mjs';
import { PANCAKE_FACTORY, ROUTER, WBNB, marketLimits, readMarket } from './market.mjs';
import { quoteAsset } from './quote-assets.mjs';

// BSC Multicall3 runtime verified independently at PublicNode and BNB's
// official HTTP RPC. Do not trust just an address for execution-sensitive reads.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';
const BEACON = '0xdf8D1028FAbdA0201dBaF577A660fD8223d5b160';
const IMPLEMENTATION = '0x9a2e15a581ce87f5d586745da78b9aeb01633583';
const MULTI = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256)',
  'function getChainId() view returns (uint256)',
]);
const BEACON_ABI = new Interface(['function implementation() view returns (address)']);
const TOKEN = new Interface([
  'function mainPool() view returns (address)',
  'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)',
]);
const V2_FACTORY = new Interface(['function getPair(address,address) view returns (address)']);
const PAIR = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
]);
const ROUTER_ABI = new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
const modeByProvider = new WeakMap();
const HEX = /^0x(?:[a-f0-9]{2})+$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const checkedHeight = height => Number.isSafeInteger(height) && height >= 0;
class AggregateIdentityError extends Error {}

function item(target, abi, name, args = []) {
  return { target, abi, name, data: abi.encodeFunctionData(name, args) };
}

const sentinels = () => [
  item(MULTICALL3, MULTI, 'getBlockNumber'),
  item(MULTICALL3, MULTI, 'getChainId'),
];

function exactResult(abi, name, data) {
  if (typeof data !== 'string' || data.length > 32_768 || !HEX.test(data)) throw new Error('Multicall 报价返回格式无效');
  try {
    const values = abi.decodeFunctionResult(name, data);
    // Reject malformed/trailing or noncanonical encodings instead of silently
    // accepting a partially decoded result.
    if (!same(abi.encodeFunctionResult(name, values), data)) throw new Error();
    return values;
  } catch { throw new Error('Multicall 报价返回格式无效'); }
}

function compatibilityError(error) {
  if (isRpcLimit(error) || ['TIMEOUT', 'NETWORK_ERROR', 'CANCELLED'].includes(error?.code)) return false;
  const message = [error?.shortMessage, error?.message, error?.info?.error?.message].filter(Boolean).join(' ');
  return error?.code === 'UNSUPPORTED_OPERATION' ||
    /(?:multicall|aggregate3).{0,48}(?:unsupported|not supported|unavailable|not implemented)|(?:response|request|calldata) size limit/i.test(message);
}

async function aggregate(provider, reads, height) {
  const calls = [...sentinels(), ...reads];
  let raw;
  try {
    raw = await provider.call({
      to: MULTICALL3,
      data: MULTI.encodeFunctionData('aggregate3', [calls.map(({ target, data }) => [target, true, data])]),
      blockTag: height,
    });
  } catch (error) {
    if (compatibilityError(error)) return null;
    throw error;
  }
  // Empty outer result can occur with a node lacking this historical view.
  // In every other case decode and fail closed; never re-read a proven mismatch.
  if (raw === '0x') return null;
  const [rows] = exactResult(MULTI, 'aggregate3', raw);
  if (rows.length !== calls.length) throw new Error('Multicall 报价数据不完整');
  if (!rows[0].success || !rows[1].success) throw new Error('Multicall 报价区块或链编号校验失败');
  const [at] = exactResult(MULTI, 'getBlockNumber', rows[0].returnData);
  const [chain] = exactResult(MULTI, 'getChainId', rows[1].returnData);
  if (at !== BigInt(height)) throw new AggregateIdentityError('Multicall 返回了错误的报价区块');
  if (chain !== CHAIN_ID) throw new AggregateIdentityError('Multicall 报价不是 BSC 主网');
  return reads.map(({ abi, name }, index) => {
    const row = rows[index + 2];
    if (!row.success) throw new Error('Multicall 报价子调用失败：' + name);
    return exactResult(abi, name, row.returnData);
  });
}

/** Optional non-blocking arm probe. Trading remains available through the
 * original pinned reads if no trusted aggregate capability is ready. */
export async function warmSnipeMarket(provider, block) {
  const height = typeof block === 'number' ? block : block?.number;
  if (!checkedHeight(height) || typeof provider?.getCode !== 'function') return false;
  const mark = { available: false, height };
  modeByProvider.set(provider, mark);
  try {
    const code = await provider.getCode(MULTICALL3, height);
    if (typeof code !== 'string' || code.length !== 7618 || !HEX.test(code) || keccak256(code) !== MULTICALL3_HASH) return false;
    mark.available = Boolean(await aggregate(provider, [], height));
  } catch (error) {
    // Don't let a lying chain/height response silently opt into direct reads
    // through the same provider. Probe availability failures are compatible.
    if (error instanceof AggregateIdentityError) mark.error = error;
    return false;
  }
  return mark.available && modeByProvider.get(provider) === mark;
}

async function direct(provider, target, pool, settings, block) {
  const [market] = await Promise.all([
    readMarket(provider, target, { launched: true, pool }, settings, block),
    verifySnipeState(provider, target, pool, block.number),
  ]);
  return { ...market, readMode: 'direct' };
}

/** Confirmed-path snapshot only. The caller still verifies launch receipt,
 * wallet-specific simulation, canonical head, nonce and final slippage. */
export async function readSnipeMarket(provider, target, pool, settings, block) {
  if (!checkedHeight(block?.number)) throw new Error('缺少有效的报价区块');
  const quoteToken = quoteAsset(settings.quoteToken);
  const native = quoteToken === ZeroAddress;
  const asset = native ? WBNB : quoteToken;
  const checked = { mint: address(target?.mint, 'Mint'), token: address(target?.token, 'Token'), factory: FACTORY, quoteToken };
  const pair = address(pool, 'Pool');
  if (!same(target?.factory, FACTORY) || checked.mint === checked.token || checked.token === asset ||
      (target.quoteToken !== undefined && quoteAsset(target.quoteToken) !== quoteToken)) throw new Error('Corla 工厂、目标或支付币不匹配');
  const mark = modeByProvider.get(provider);
  if (mark?.error) throw mark.error;
  if (!mark?.available || block.number < mark.height) return direct(provider, checked, pair, settings, block);
  const path = [asset, checked.token];
  // These are the same getters as the direct checks. All are read from the
  // exact quote block, before the separate full round-trip trade simulation.
  const reads = [
    item(checked.mint, CORLA_ABI, 'launched'),
    item(checked.mint, CORLA_ABI, 'token'),
    item(checked.mint, CORLA_ABI, 'pool'),
    item(BEACON, BEACON_ABI, 'implementation'),
    item(checked.mint, CORLA_ABI, 'emergencyWithdrawn'),
    item(checked.token, TOKEN, 'mainPool'),
    item(PANCAKE_FACTORY, V2_FACTORY, 'getPair', path),
    item(checked.token, TOKEN, 'buyTaxRate'),
    item(checked.token, TOKEN, 'sellTaxRate'),
    item(pair, PAIR, 'token0'),
    item(pair, PAIR, 'token1'),
    item(pair, PAIR, 'getReserves'),
    item(ROUTER, ROUTER_ABI, 'getAmountsOut', [settings.amountIn, path]),
    ...(!native ? [item(checked.mint, CORLA_ABI, 'quoteToken')] : []),
  ];
  const result = await aggregate(provider, reads, block.number);
  if (result === null) return direct(provider, checked, pair, settings, block);
  const [[launched], [token], [corlaPool], [implementation], [withdrawn], [mainPool], [factoryPair], [buyTax], [sellTax],
    [token0], [token1], reserves, [amounts], onChainQuote] = result;
  if (!launched || withdrawn || !same(token, checked.token) || !same(corlaPool, pair) || !same(implementation, IMPLEMENTATION) ||
      (!native && !same(onChainQuote?.[0], quoteToken))) {
    throw new Error('Corla 当前开盘状态或实现与事件不一致');
  }
  if (!same(mainPool, pair) || !same(factoryPair, pair)) throw new Error('Corla、Token 和 Pancake V2 的交易池不一致');
  const quoteFirst = same(token0, asset);
  if (!(quoteFirst ? same(token1, checked.token) : same(token0, checked.token) && same(token1, asset))) {
    throw new Error('池子不是预期的支付币/Token 直连路径');
  }
  if (amounts.length !== 2 || amounts[0] !== settings.amountIn) throw new Error('路由报价与池子储备不一致');
  const [reserveQuote, reserveToken] = quoteFirst ? reserves : [reserves[1], reserves[0]];
  const quoted = amounts[1];
  const limits = marketLimits({ amountIn: settings.amountIn, reserveQuote, reserveToken, quoted, buyTax, sellTax, settings });
  return { pair: factoryPair, quoted, buyTax, sellTax, ...(native ? { reserveBnb: reserveQuote } : { reserveQuote, quoteToken }),
    reserveToken, path, ...limits, blockNumber: block.number, readMode: 'aggregate' };
}
