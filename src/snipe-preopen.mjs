import { AbiCoder, Interface, Transaction, ZeroAddress, id, toQuantity } from 'ethers';
import { CHAIN_ID, FACTORY, address } from './config.mjs';
import { CORLA_ABI, inspectMint, requireCorlaPool } from './corla.mjs';
import { DIRECT_LAUNCH_PORTAL } from './events.mjs';
import { applyOpeningPriceGuard, buildBuy, buildSimulatedSell, marketLimits, PANCAKE_FACTORY, ROUTER, v2Output, WBNB } from './market.mjs';
import { decodePendingMint } from './pending-mint-shadow.mjs';
import { QUOTE_ERC20, quoteAsset, requireQuoteFunds } from './quote-assets.mjs';

const PORTAL = new Interface(['event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)']);
const PAIR = new Interface([
  'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
]);
const V2_FACTORY = new Interface([
  'event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
  'function getPair(address,address) view returns (address)',
]);
const TOKEN = new Interface([
  'function mainPool() view returns (address)',
  'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)',
  'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const V2_ROUTER = new Interface([
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
]);
const V2_SCHEMA = id('DirectLaunchV2(DirectLaunchV2Data)');
const V2_DATA = 'tuple(uint256 nonce,uint256 ts,uint8 tokenVersion,address quoteToken,uint8 migratorType,uint256 initialPriceWad,string name,string symbol,string meta,address pool,uint256 totalSupply,uint8 antiSniperMode,uint16 maxBuyBps)';
const coder = AbiCoder.defaultAbiCoder();
const verifiedPlans = new WeakSet();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const quantity = v => typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v);
function uint(v) {
  if (!quantity(v)) throw new Error('待打包 Mint 交易数字字段无效');
  return BigInt(v);
}
const guard = (ok, message) => { if (!ok) throw new Error(message); };

/** Match the advertised hash to an actually signed BSC transaction. */
function signedMint(pending, target, value) {
  const tokenQuote = quoteAsset(target.quoteToken) !== ZeroAddress;
  const to = tokenQuote ? FACTORY : target.mint;
  guard(decodePendingMint(pending, new Map([[target.mint.toLowerCase(), { ...target, pricePerLot: target.pricePerLot ?? value }]])),
    '待打包交易不是目标的完整 Mint 调用');
  try {
    const type = Number(uint(pending.type ?? '0x0'));
    const v = uint(pending.v ?? pending.yParity);
    const nonce = uint(pending.nonce);
    const gasLimit = uint(pending.gas);
    const chainId = type === 0 && pending.chainId == null && v >= 35n ? (v - 35n) / 2n : uint(pending.chainId);
    const accessList = pending.accessList ?? [];
    if (![0, 1, 2].includes(type) || chainId !== CHAIN_ID || (type === 0 ? v !== 147n && v !== 148n : v > 1n) ||
        nonce > BigInt(Number.MAX_SAFE_INTEGER) || gasLimit < 21_000n || gasLimit > 15_000_000n ||
        !Array.isArray(accessList) || accessList.length > 32 || (type === 0 && accessList.length) ||
        accessList.some(row => !Array.isArray(row?.storageKeys) || row.storageKeys.length > 64)) throw new Error();
    const prices = type === 2 ? { maxFeePerGas: uint(pending.maxFeePerGas),
      maxPriorityFeePerGas: uint(pending.maxPriorityFeePerGas) } : { gasPrice: uint(pending.gasPrice) };
    const tx = Transaction.from({ type, chainId, nonce: Number(nonce), gasLimit, ...prices, to,
      ...(type ? { accessList } : {}), value, data: pending.input ?? pending.data,
      signature: { r: pending.r, s: pending.s, v: Number(v) } });
    const gasPriceCeiling = tx.gasPrice ?? tx.maxFeePerGas;
    if (!same(tx.from, pending.from) || !same(tx.hash, pending.hash) || !gasPriceCeiling ||
        (type === 2 && tx.maxPriorityFeePerGas > gasPriceCeiling)) throw new Error();
    return { from: tx.from, nonce: Number(nonce), gasPriceCeiling, call: {
      from: tx.from, to, nonce: toQuantity(nonce), gas: toQuantity(gasLimit), data: tx.data,
      value: toQuantity(value), ...(type ? { accessList } : {}),
      ...Object.fromEntries(Object.entries(prices).map(([key, value]) => [key, toQuantity(value)])),
    } };
  } catch { throw new Error('无法核验待打包 Mint 的 BSC 签名与交易哈希'); }
}

function findLogs(result, abi, event, contract) {
  guard(Array.isArray(result.logs) && result.logs.length <= 512, 'RPC 模拟事件缺失或过多');
  const topic = abi.getEvent(event).topicHash;
  return result.logs.filter(log => same(log.address, contract) && same(log.topics?.[0], topic) && !log.removed)
    .map(log => abi.parseLog(log)?.args).filter(Boolean);
}

function launchSeed(result, target, minter, totalLots, asset) {
  const opened = findLogs(result, CORLA_ABI, 'Launched', target.mint);
  const minted = findLogs(result, CORLA_ABI, 'Minted', target.mint);
  guard(opened.length === 1 && same(opened[0].token, target.token) && same(opened[0].lastMinter, minter) &&
    minted.length === 1 && same(minted[0].wallet, minter) && minted[0].mintedLots === totalLots,
  '最后一批未在模拟中完成 Corla 开盘');
  const pool = address(opened[0].pool, '预演交易池');
  const direct = findLogs(result, PORTAL, 'FlapDirectLaunched', DIRECT_LAUNCH_PORTAL);
  guard(direct.length === 1 && same(direct[0].token, target.token) && direct[0].kind === 0n &&
    same(direct[0].schemaId, V2_SCHEMA), '预演缺少官方 Flap Portal 开盘证明');
  const [details] = coder.decode([V2_DATA], direct[0].data);
  guard(details.tokenVersion === 0n && details.migratorType === 1n && same(details.quoteToken, quoteAsset(target.quoteToken)) &&
    details.totalSupply > 0n && same(details.pool, pool), '预演不是与项目支付币匹配的 V2 开盘');
  const pairs = findLogs(result, V2_FACTORY, 'PairCreated', PANCAKE_FACTORY);
  guard(pairs.length === 1 && same(pairs[0].pair, pool), '预演缺少 Pancake V2 工厂建池证明');
  const quoteFirst = same(pairs[0].token0, asset);
  guard(quoteFirst ? same(pairs[0].token1, target.token) :
    same(pairs[0].token0, target.token) && same(pairs[0].token1, asset), '预演交易池资产不符');
  const lp = findLogs(result, PAIR, 'Mint', pool);
  const sync = findLogs(result, PAIR, 'Sync', pool).at(-1);
  guard(lp.length === 1 && same(lp[0].sender, DIRECT_LAUNCH_PORTAL) && lp[0].amount0 > 0n && lp[0].amount1 > 0n &&
    sync?.reserve0 === lp[0].amount0 && sync?.reserve1 === lp[0].amount1, '预演池子注资与储备不一致');
  return { pool, quoteFirst, reserveQuote: quoteFirst ? sync.reserve0 : sync.reserve1,
    reserveToken: quoteFirst ? sync.reserve1 : sync.reserve0 };
}

function checkedHead(head) {
  return head && Number.isSafeInteger(head.number) && head.number >= 0 && hash(head.hash) &&
    Number.isSafeInteger(head.timestamp) && head.timestamp > 0;
}

export function isVerifiedPreopenBuyPlan(plan) {
  return typeof plan === 'object' && plan !== null && verifiedPlans.has(plan);
}

async function simulate(provider, head, calls, signal) {
  signal?.throwIfAborted();
  let response;
  try {
    response = await provider.send('eth_simulateV1', [{
      blockStateCalls: [{ blockOverrides: { time: toQuantity(head.timestamp + 1) }, calls }],
      validation: false,
    }, toQuantity(head.number)]);
  } catch { throw new Error('节点未完成末笔 Mint 顺序模拟'); }
  signal?.throwIfAborted();
  const block = Array.isArray(response) && response.length === 1 ? response[0] : null;
  guard(block && same(block.parentHash, head.hash) && quantity(block.number) && BigInt(block.number) === BigInt(head.number) + 1n &&
    quantity(block.timestamp) && BigInt(block.timestamp) === BigInt(head.timestamp) + 1n && Array.isArray(block.calls) &&
    block.calls.length === calls.length && block.calls.every(row => row.status === '0x1'), '顺序模拟不在指定父块或其中一笔回退');
  return block.calls;
}

/** Read-only conditional plan for an exact visible final Mint. No signing,
 * overrides of real balances, raw submission, or guessed minimum output. */
export async function buildPreopenBuyPlan(provider, target, pending, wallet, settings, head, { signal, services = {} } = {}) {
  signal?.throwIfAborted();
  guard(checkedHead(head), '缺少可核验的末笔 Mint 父块');
  guard(same(target?.factory, FACTORY), '不支持此 Corla 工厂');
  const quoteToken = quoteAsset(target.quoteToken);
  const tokenQuote = quoteToken !== ZeroAddress;
  guard(quoteToken === quoteAsset(settings.quoteToken), '提前买单的支付币不一致');
  const asset = tokenQuote ? quoteToken : WBNB;
  const verified = { mint: address(target.mint, 'Mint'), token: address(target.token, 'Token'), factory: FACTORY,
    ...(tokenQuote ? { quoteToken, deploymentKey: target.deploymentKey, pricePerLot: target.pricePerLot } : {}) };
  guard(!same(asset, verified.token), '买入币与支付币相同');
  const recipient = address(typeof wallet === 'string' ? wallet : wallet?.address, '钱包');
  guard(!same(recipient, pending?.from), 'Mint 钱包不能同时作为提前提交钱包');
  guard(Number.isSafeInteger(settings?.slippageBps) && settings.slippageBps > 0 && settings.slippageBps <= 1000 &&
    Number.isSafeInteger(settings.deadlineSeconds) && settings.deadlineSeconds >= 5 && settings.deadlineSeconds <= 60,
  '提前提交必须有不高于 10% 的滑点上限和有效截止时间');
  const at = head.number;
  // Cheaply authenticate the pending envelope before touching chain reads.
  // The amount bound here is verified against the real contract below;
  // this does not turn an arbitrary value into a valid last Mint.
  const value = uint(pending?.value);
  const mint = signedMint(pending, verified, value);
  const [state, code, nonce, funds] = await Promise.all([
    (services.inspectMint ?? inspectMint)(provider, verified, at, undefined, { requireQuoteMint: tokenQuote, verifyPool: true }),
    provider.getCode(verified.token, at), provider.getTransactionCount(mint.from, at), provider.getBalance(mint.from, at),
    tokenQuote ? requireQuoteFunds(provider, quoteToken, recipient, ROUTER, settings.amountIn, at) : null,
  ]);
  requireCorlaPool(state);
  guard(state.blockNumber === at && state.phase === 1 && state.launched === false && state.emergencyWithdrawn === false &&
    state.quoteToken === quoteToken && state.token === ZeroAddress && state.pool === ZeroAddress &&
    state.fundingDeadline > BigInt(head.timestamp + 1) && state.pricePerLot > 0n &&
    (tokenQuote ? value === 0n && state.pricePerLot === target.pricePerLot && state.deploymentKey === target.deploymentKey &&
      state.quoteDecimals === settings.quoteDecimals : state.pricePerLot === value) &&
    state.mintedLots + 1n === state.totalLots,
  '尚不能在核验的父块确认只剩最后一批 Mint');
  guard(code === '0x' && nonce === mint.nonce && funds >= value + BigInt(mint.call.gas) * mint.gasPriceCeiling,
    '预计 Token 已部署，或末笔 Mint 发件人余额/nonce 不匹配');
  if (tokenQuote) await requireQuoteFunds(provider, quoteToken, mint.from, FACTORY, state.pricePerLot, at);

  const path = [asset, verified.token];
  const getters = [
    [TOKEN, verified.token, 'mainPool', []],
    [TOKEN, verified.token, 'buyTaxRate', []],
    [TOKEN, verified.token, 'sellTaxRate', []],
    [V2_FACTORY, PANCAKE_FACTORY, 'getPair', path],
    [V2_ROUTER, ROUTER, 'getAmountsOut', [settings.amountIn, path]],
  ];
  const query = getters.map(([abi, to, name, args]) => ({ from: recipient, to, data: abi.encodeFunctionData(name, args) }));
  function verifyOpened(calls) {
    const seed = launchSeed(calls[0], verified, mint.from, state.totalLots, asset);
    const values = getters.map(([abi, , name], i) => {
      const data = calls[i + 1]?.returnData;
      const decoded = abi.decodeFunctionResult(name, data);
      guard(same(abi.encodeFunctionResult(name, decoded), data), '预演报价返回不完整');
      return decoded[0];
    });
    const [mainPool, buyTax, sellTax, pair, amounts] = values;
    guard(same(mainPool, seed.pool) && same(pair, seed.pool) && amounts.length === 2 && amounts[0] === settings.amountIn &&
      amounts[1] === v2Output(settings.amountIn, seed.reserveQuote, seed.reserveToken), '预演报价与开盘储备不一致');
    return { ...seed, buyTax, sellTax, quoted: amounts[1] };
  }
  const seed = verifyOpened(await simulate(provider, head, [mint.call, ...query], signal));
  const limits = applyOpeningPriceGuard({ ...seed, ...marketLimits({ ...seed, amountIn: settings.amountIn, settings }) },
    seed, seed.buyTax, settings);
  const tx = buildBuy({ path, amountOutMin: limits.amountOutMin }, recipient, settings, head);
  const deadline = head.timestamp + settings.deadlineSeconds;
  const actual = await simulate(provider, head, [mint.call, ...query,
    { from: recipient, to: tx.to, data: tx.data, value: toQuantity(tx.value) },
    { from: recipient, to: verified.token, data: TOKEN.encodeFunctionData('approve', [ROUTER, limits.amountOutMin]) },
    { from: recipient, to: ROUTER, data: buildSimulatedSell(path, limits.amountOutMin, limits.reverseMin, recipient, deadline, quoteToken) },
  ], signal);
  const verifiedSeed = verifyOpened(actual);
  guard(Object.keys(seed).every(key => seed[key] === verifiedSeed[key]), '两次预演的开盘池不一致');
  const buy = actual[query.length + 1];
  const sell = actual[query.length + 3];
  const buySwap = findLogs(buy, PAIR, 'Swap', seed.pool);
  const sellSwap = findLogs(sell, PAIR, 'Swap', seed.pool);
  const bought = findLogs(buy, TOKEN, 'Transfer', verified.token).filter(row => same(row.from, seed.pool) && same(row.to, recipient))
    .reduce((sum, row) => sum + row.value, 0n);
  const gasEstimate = uint(buy.gasUsed);
  guard(buySwap.length === 1 && same(buySwap[0].sender, ROUTER) && same(buySwap[0].to, recipient) &&
    (seed.quoteFirst ? buySwap[0].amount0In : buySwap[0].amount1In) === settings.amountIn &&
    bought >= limits.amountOutMin && sellSwap.length === 1 && same(sellSwap[0].sender, ROUTER) &&
    (seed.quoteFirst ? sellSwap[0].amount0Out : sellSwap[0].amount1Out) >= limits.reverseMin &&
    gasEstimate >= 21_000n && gasEstimate <= 5_000_000n, '预演没有证明按最低到手量完成买卖');
  const canonical = await provider.getBlock(at);
  signal?.throwIfAborted();
  guard(checkedHead(canonical) && canonical.number === at && same(canonical.hash, head.hash), '末笔 Mint 父块已经重组');
  const plan = Object.freeze({ tx: Object.freeze(tx), gasEstimate, amountOutMin: limits.amountOutMin,
    openingNetOut: limits.openingNetOut, quotedNetOut: limits.quotedNetOut,
    openingAmountOutMin: limits.openingAmountOutMin, maxOpeningPremiumBps: limits.maxOpeningPremiumBps,
    reverseMin: limits.reverseMin, recipient, mint: verified.mint, token: verified.token, quoteBlock: at,
    quoteBlockHash: head.hash, pendingHash: pending.hash.toLowerCase(), pool: seed.pool, deadline, quoteToken });
  verifiedPlans.add(plan);
  return plan;
}
