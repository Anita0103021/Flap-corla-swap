import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther, Interface } from 'ethers';
import { buildBuy, marketLimits, readMarket, v2Output, verifyRoundTrip, PANCAKE_FACTORY, ROUTER, WBNB } from '../src/market.mjs';

const settings = { amountIn: parseEther('0.01'), minLiquidity: parseEther('1'), maxBuyTaxBps: 500,
  maxSellTaxBps: 500, maxPriceImpactBps: 150, slippageBps: 150, deadlineSeconds: 12 };
const reserveBnb = parseEther('5');
const reserveToken = parseEther('84');
const quoted = v2Output(settings.amountIn, reserveBnb, reserveToken);
const inputs = { amountIn: settings.amountIn, reserveBnb, reserveToken, quoted, buyTax: 300n, sellTax: 300n, settings };
const target = '0x9B540b85d7Dc7f3DB4fBb7CEBC45fb2214667777';
const wallet = '0x000000000000000000000000000000000000dEaD';
const pair = '0x0000000000000000000000000000000000000001';
const otherPair = '0x0000000000000000000000000000000000000002';

function quoteProvider({ factoryPair = pair, wait = Promise.resolve(), quote = quoted } = {}) {
  const definitions = [
    [target, 'function mainPool() view returns (address)', [pair]],
    [target, 'function buyTaxRate() view returns (uint16)', [inputs.buyTax]],
    [target, 'function sellTaxRate() view returns (uint16)', [inputs.sellTax]],
    [PANCAKE_FACTORY, 'function getPair(address,address) view returns (address)', [factoryPair]],
    [pair, 'function token0() view returns (address)', [WBNB]],
    [pair, 'function token1() view returns (address)', [target]],
    [pair, 'function getReserves() view returns (uint112,uint112,uint32)', [reserveBnb, reserveToken, 1000]],
    [ROUTER, 'function getAmountsOut(uint256,address[]) view returns (uint256[])', [[settings.amountIn, quote]]],
  ];
  const responses = new Map(definitions.map(([address, abi, result]) => {
    const iface = new Interface([abi]);
    const fragment = iface.fragments[0];
    return [address.toLowerCase() + ':' + fragment.selector, iface.encodeFunctionResult(fragment, result)];
  }));
  const calls = [];
  return { calls, async call(tx) {
    calls.push(tx);
    const key = tx.to.toLowerCase() + ':' + tx.data.slice(0, 10);
    assert.ok(responses.has(key), 'unexpected quote RPC: ' + key);
    await wait;
    return responses.get(key);
  } };
}

test('Pancake V2 quote thresholds, nonzero tax-aware minOut and reverse amount', () => {
  const limits = marketLimits(inputs);
  assert.equal(limits.amountOutMin, (quoted * 9700n / 10000n) * 9850n / 10000n);
  assert.ok(limits.reverseMin > 0n && limits.reverseMin < settings.amountIn);
  assert.throws(() => marketLimits({ ...inputs, quoted: quoted + 1n }), /报价/);
  assert.throws(() => marketLimits({ ...inputs, sellTax: 501n }), /税/);
  assert.throws(() => marketLimits({ ...inputs, reserveBnb: 0n }), /储备/);
  assert.throws(() => marketLimits({ ...inputs, settings: { ...settings, maxPriceImpactBps: 1 } }), /冲击/);
});

test('market quote fans out all 8 reads before any reply, pinned to one block', async () => {
  let release;
  const provider = quoteProvider({ wait: new Promise(resolve => { release = resolve; }) });
  const read = readMarket(provider, { token: target }, { launched: true, pool: pair }, settings, { number: 321 });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.calls.length, 8, 'no pair or quote call should wait on another read');
    assert.ok(provider.calls.every(call => call.blockTag === 321));
  } finally {
    release();
  }
  const market = await read;
  assert.equal(market.pair, pair);
  assert.equal(market.quoted, quoted);
  assert.equal(market.blockNumber, 321);
  assert.equal(market.amountOutMin, marketLimits(inputs).amountOutMin);
});

test('concurrent pair and quote reads do not bypass canonical pool or math checks', async () => {
  const project = { token: target };
  const state = { launched: true, pool: pair };
  const block = { number: 321 };
  await assert.rejects(readMarket(quoteProvider({ factoryPair: otherPair }), project, state, settings, block), /交易池不一致/);
  await assert.rejects(readMarket(quoteProvider({ quote: quoted + 1n }), project, state, settings, block), /路由报价/);
  const provider = quoteProvider();
  await assert.rejects(readMarket(provider, project, state, settings, {}), /报价区块/);
  assert.equal(provider.calls.length, 0);
});

test('stateful simulation only returns the BNB buy, not approval or sell', async () => {
  const market = { ...marketLimits(inputs), path: [WBNB, target] };
  const block = { number: 100, timestamp: 1000 };
  const rpc = { async send(method, params) {
    assert.equal(method, 'eth_simulateV1');
    assert.equal(params[1], '0x64');
    assert.equal(params[0].blockStateCalls[0].calls.length, 3);
    assert.equal(params[0].blockStateCalls[0].calls[1].data.slice(0, 10), '0x095ea7b3');
    return [{ calls: [{ status: '0x1' }, { status: '0x1' }, { status: '0x1' }] }];
  } };
  const tx = await verifyRoundTrip(rpc, market, wallet, settings, block);
  const abi = new Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)']);
  const [min, path, recipient, deadline] = abi.decodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', tx.data);
  assert.equal(tx.to, ROUTER);
  assert.equal(tx.value, settings.amountIn);
  assert.equal(min, market.amountOutMin);
  assert.deepEqual([...path], market.path);
  assert.equal(recipient, wallet);
  assert.equal(deadline, 1012n);
  await assert.rejects(verifyRoundTrip({ send: async () => [{ calls: [{ status: '0x1' }, { status: '0x1' }, { status: '0x0' }] }] },
    market, wallet, settings, block), /未全部通过/);
});

test('prebuilt buy must exactly match the round-trip simulation before any RPC', async () => {
  const market = { ...marketLimits(inputs), path: [WBNB, target] };
  const block = { number: 100, timestamp: 1000 };
  const buyTx = buildBuy(market, wallet, settings, block);
  let simulated = 0;
  const rpc = { async send(_method, params) {
    simulated++;
    assert.equal(params[0].blockStateCalls[0].calls[0].data, buyTx.data);
    return [{ calls: [{ status: '0x1' }, { status: '0x1' }, { status: '0x1' }] }];
  } };
  for (const changed of [{ value: buyTx.value + 1n }, { to: otherPair }, { data: '0x' }]) {
    await assert.rejects(verifyRoundTrip(rpc, market, wallet, settings, block, { buyTx: { ...buyTx, ...changed } }), /买单不一致/);
  }
  await assert.rejects(verifyRoundTrip(rpc, { ...market, blockNumber: 99 }, wallet, settings, block, { buyTx }), /报价区块/);
  assert.equal(simulated, 0);
  assert.deepEqual(await verifyRoundTrip(rpc, market, wallet, settings, block, { buyTx }), buyTx);
  assert.equal(simulated, 1);
});
