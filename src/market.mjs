import { Contract, Interface, ZeroAddress, getAddress, toQuantity, parseEther } from 'ethers';

export const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const TOKEN = new Interface([
  'function mainPool() view returns (address)',
  'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)',
  'function approve(address,uint256) returns (bool)',
]);
const ROUTER_ABI = new Interface([
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
]);
const FACTORY = new Interface(['function getPair(address,address) view returns (address)']);
const PAIR = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
]);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const BPS = 10_000n;
export const discount = (amount, bps) => amount * (BPS - BigInt(bps)) / BPS;
// PancakeSwap v2 charges 25 bps at the AMM, independently of transfer taxes.
export function v2Output(amount, reserveIn, reserveOut) {
  const amountWithFee = amount * 9975n;
  return amountWithFee * reserveOut / (reserveIn * BPS + amountWithFee);
}
export function marketLimits({ amountIn, reserveBnb, reserveToken, quoted, buyTax, sellTax, settings }) {
  if (reserveBnb < settings.minLiquidity || reserveToken <= 0n) throw new Error('Pancake V2 储备低于门槛');
  if (buyTax > BigInt(settings.maxBuyTaxBps) || sellTax > BigInt(settings.maxSellTaxBps)) {
    throw new Error('买入或卖出税超过配置阈值');
  }
  const spot = amountIn * reserveToken / reserveBnb;
  if (spot <= 0n || quoted <= 0n || quoted >= reserveToken || quoted !== v2Output(amountIn, reserveBnb, reserveToken)) {
    throw new Error('路由报价与池子储备不一致');
  }
  const priceImpactBps = (BPS * (spot - quoted) + spot - 1n) / spot;
  if (priceImpactBps > BigInt(settings.maxPriceImpactBps)) throw new Error('价格冲击超过配置阈值');
  const amountOutMin = discount(discount(quoted, buyTax), settings.slippageBps);
  const reverse = v2Output(discount(amountOutMin, sellTax), reserveToken - quoted, reserveBnb + amountIn);
  const reverseMin = discount(reverse, settings.slippageBps);
  if (amountOutMin <= 0n || reverseMin <= 0n) throw new Error('最低成交量计算为零');
  return { amountOutMin, reverseMin, priceImpactBps };
}

export async function readOpeningBuyTax(provider, token, height) {
  const raw = await provider.call({ to: token, blockTag: height, data: TOKEN.encodeFunctionData('buyTaxRate') });
  const [tax] = TOKEN.decodeFunctionResult('buyTaxRate', raw);
  if (!same(raw, TOKEN.encodeFunctionResult('buyTaxRate', [tax])) || tax >= BPS) throw new Error('开盘区块买税无法核验');
  return tax;
}

export function applyOpeningPriceGuard(market, openingReserves, openingBuyTax, settings) {
  const maxOpeningPremiumBps = settings.maxOpeningPremiumBps ?? 1000;
  if (!Number.isSafeInteger(maxOpeningPremiumBps) || maxOpeningPremiumBps < 0 || maxOpeningPremiumBps > 1000) {
    throw new Error('开盘价溢价上限必须在 0–10% 之间');
  }
  const { reserveBnb, reserveToken } = openingReserves ?? {};
  if (typeof reserveBnb !== 'bigint' || typeof reserveToken !== 'bigint' || reserveBnb <= 0n || reserveToken <= 0n ||
      typeof openingBuyTax !== 'bigint' || openingBuyTax < 0n || openingBuyTax >= BPS) {
    throw new Error('未能核验初始池储备或开盘买税，不追价');
  }
  const openingNetOut = discount(v2Output(settings.amountIn, reserveBnb, reserveToken), openingBuyTax);
  const quotedNetOut = discount(market.quoted, market.buyTax);
  if (openingNetOut <= 0n || quotedNetOut <= 0n) throw new Error('开盘价格保护无法计算有效净报价');
  // Cap the unit price, not percentage loss of output; round towards safety.
  const denominator = BPS + BigInt(maxOpeningPremiumBps);
  const openingAmountOutMin = (openingNetOut * BPS + denominator - 1n) / denominator;
  const priceEvidence = { openingNetOut, quotedNetOut, openingAmountOutMin, maxOpeningPremiumBps };
  if (quotedNetOut < openingAmountOutMin) {
    throw Object.assign(new Error('当前报价超过开盘价溢价上限，不追价'), { priceEvidence });
  }
  if (market.amountOutMin >= openingAmountOutMin) return { ...market, ...priceEvidence };
  const reverse = v2Output(discount(openingAmountOutMin, market.sellTax),
    market.reserveToken - market.quoted, market.reserveBnb + settings.amountIn);
  const reverseMin = discount(reverse, settings.slippageBps);
  if (reverseMin <= 0n) throw new Error('最低卖出量计算为零');
  return { ...market, ...priceEvidence, amountOutMin: openingAmountOutMin, reverseMin };
}

// Pin all market reads to the same block so a trade between two RPC calls
// cannot silently mix a newer quote with older reserves.
export async function readMarket(provider, target, state, settings, block) {
  if (state?.launched !== true || !state.pool || same(state.pool, ZeroAddress)) throw new Error('Corla 尚未开盘');
  if (!Number.isSafeInteger(block?.number) || block.number < 0) throw new Error('缺少有效的报价区块');
  const pool = getAddress(state.pool);
  const opts = { blockTag: block.number };
  const token = new Contract(target.token, TOKEN, provider);
  const factory = new Contract(PANCAKE_FACTORY, FACTORY, provider);
  const pair = new Contract(pool, PAIR, provider);
  const router = new Contract(ROUTER, ROUTER_ABI, provider);
  const path = [WBNB, target.token];
  // The launch receipt already names the candidate pair. Read everything in
  // one fan-out, but do not trust that pair until the token and the canonical
  // factory independently agree. Quote/reserve checks below still apply.
  const [mainPool, pairAddress, buyTax, sellTax, token0, token1, reserves, amounts] = await Promise.all([
    token.mainPool(opts), factory.getPair(WBNB, target.token, opts), token.buyTaxRate(opts), token.sellTaxRate(opts),
    pair.token0(opts), pair.token1(opts), pair.getReserves(opts), router.getAmountsOut(settings.amountIn, path, opts),
  ]);
  if (!same(mainPool, pool) || !same(pairAddress, pool)) throw new Error('Corla、Token 和 Pancake V2 的交易池不一致');
  const wbnbFirst = same(token0, WBNB);
  if (!(wbnbFirst ? same(token1, target.token) : same(token0, target.token) && same(token1, WBNB))) {
    throw new Error('池子不是预期的 WBNB/Token 直连路径');
  }
  const [reserveBnb, reserveToken] = wbnbFirst ? reserves : [reserves[1], reserves[0]];
  const quoted = amounts[1];
  const limits = marketLimits({ amountIn: settings.amountIn, reserveBnb, reserveToken, quoted, buyTax, sellTax, settings });
  return { pair: pairAddress, quoted, buyTax, sellTax, reserveBnb, reserveToken, path, ...limits, blockNumber: block.number };
}

export function buildBuy(market, wallet, settings, block) {
  const deadline = block.timestamp + settings.deadlineSeconds;
  return {
    to: ROUTER,
    data: ROUTER_ABI.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
      [market.amountOutMin, market.path, wallet, deadline]),
    value: settings.amountIn,
  };
}

export async function verifyRoundTrip(provider, market, wallet, settings, block, { fundSimulation = false, buyTx } = {}) {
  if (!Number.isSafeInteger(block?.number) || block.number < 0 ||
      (market.blockNumber !== undefined && market.blockNumber !== block.number)) {
    throw new Error('报价区块与买单模拟区块不一致；已跳过，不会发单');
  }
  const tx = buildBuy(market, wallet, settings, block);
  // The caller may start execution preflight using the prebuilt transaction in
  // parallel. Refuse to validate it if it differs from the exact buy simulated
  // here (including amount, minOut, recipient, path, and deadline).
  if (buyTx !== undefined && (!buyTx || typeof buyTx.to !== 'string' ||
      !same(buyTx.to, tx.to) || buyTx.data !== tx.data || buyTx.value !== tx.value)) {
    throw new Error('预构建买单与模拟买单不一致；已跳过，不会发单');
  }
  const target = market.path[1];
  const deadline = block.timestamp + settings.deadlineSeconds;
  const calls = [
    { from: wallet, to: tx.to, data: tx.data, value: toQuantity(tx.value) },
    { from: wallet, to: target, data: TOKEN.encodeFunctionData('approve', [ROUTER, market.amountOutMin]) },
    { from: wallet, to: ROUTER, data: ROUTER_ABI.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
      [market.amountOutMin, market.reverseMin, [target, WBNB], wallet, deadline]) },
  ];
  const blockCalls = {
    // Geth's default simulated timestamp adds 12s. BSC next block is faster.
    blockOverrides: { time: toQuantity(block.timestamp + 1) },
    calls,
  };
  if (fundSimulation) blockCalls.stateOverrides = { [wallet]: { balance: toQuantity(tx.value + parseEther('1')) } };
  let simulation;
  try {
    simulation = await provider.send('eth_simulateV1', [
      { blockStateCalls: [blockCalls], validation: false }, toQuantity(block.number),
    ]);
  } catch {
    throw new Error('RPC 买入→授权→卖出模拟不可用；已跳过，不会发单');
  }
  const results = simulation?.[0]?.calls;
  if (!Array.isArray(results) || results.length !== calls.length || results.some(r => r.status !== '0x1')) {
    throw new Error('买入→授权→卖出模拟未全部通过；已跳过，不会发单');
  }
  return tx; // The approval and sell calldata are simulation-only.
}
