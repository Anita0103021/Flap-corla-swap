import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, parseEther, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { PANCAKE_FACTORY, ROUTER, WBNB, marketLimits, v2Output } from '../src/market.mjs';
import { readSnipeMarket, warmSnipeMarket } from '../src/snipe-market.mjs';

// Public BSC Multicall3 runtime, separately matched against
// BNB Chain's official endpoint. Tests themselves perform no networking.
const runtime = (await readFile(new URL('./fixtures/bsc-multicall3-runtime.hex', import.meta.url), 'utf8')).trim();
const multi = '0xcA11bde05977b3631167028862bE2a173976CA11';
const beacon = '0xdf8D1028FAbdA0201dBaF577A660fD8223d5b160';
const implementation = '0x9a2e15a581ce87f5d586745da78b9aeb01633583';
const target = { factory: FACTORY, mint: '0x0000000000000000000000000000000000000001',
  token: '0x0000000000000000000000000000000000000002' };
const pool = '0x0000000000000000000000000000000000000003';
const other = '0x0000000000000000000000000000000000000004';
const block = { number: 124 };
const settings = { amountIn: parseEther('0.1'), minLiquidity: parseEther('1'), maxBuyTaxBps: 500,
  maxSellTaxBps: 500, maxPriceImpactBps: 1000, slippageBps: 1000 };
const reserveBnb = parseEther('5');
const reserveToken = parseEther('2000');
const quoted = v2Output(settings.amountIn, reserveBnb, reserveToken);
const buyTax = 300n, sellTax = 400n;
const MULTI = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256)',
  'function getChainId() view returns (uint256)',
]);
const signature = (contract, data) => contract.toLowerCase() + ':' + data.slice(0, 10);

function providerFor(mode = {}) {
  const calls = [];
  const quote = mode.quoteToken ?? WBNB;
  const amountIn = mode.amountIn ?? settings.amountIn;
  const reserveQuote = mode.reserveQuote ?? reserveBnb;
  return {
    calls,
    async getCode(to, at) {
      assert.equal(to, multi);
      assert.equal(at, block.number);
      return mode.code ?? runtime;
    },
    async call(tx) {
      assert.equal(tx.blockTag, block.number, 'aggregate, direct reads and probes must use the same block');
      calls.push(tx);
      const definitions = [
        [multi, MULTI, 'getBlockNumber', [mode.height ?? block.number]],
        [multi, MULTI, 'getChainId', [mode.chain ?? 56n]],
        [target.mint, CORLA_ABI, 'launched', [mode.launched ?? true]],
        [target.mint, CORLA_ABI, 'token', [mode.actualToken ?? target.token]],
        [target.mint, CORLA_ABI, 'pool', [mode.actualPool ?? pool]],
        [target.mint, CORLA_ABI, 'emergencyWithdrawn', [mode.withdrawn ?? false]],
        [target.mint, CORLA_ABI, 'quoteToken', [mode.onChainQuote ?? mode.quoteToken ?? ZeroAddress]],
        [beacon, 'function implementation() view returns(address)', 'implementation', [mode.implementation ?? implementation]],
        [target.token, 'function mainPool() view returns (address)', 'mainPool', [mode.mainPool ?? pool]],
        [target.token, 'function buyTaxRate() view returns (uint16)', 'buyTaxRate', [mode.buyTax ?? buyTax]],
        [target.token, 'function sellTaxRate() view returns (uint16)', 'sellTaxRate', [mode.sellTax ?? sellTax]],
        [PANCAKE_FACTORY, 'function getPair(address,address) view returns (address)', 'getPair', [mode.factoryPair ?? pool]],
        [pool, 'function token0() view returns (address)', 'token0', [mode.reverse ? target.token : quote]],
        [pool, 'function token1() view returns (address)', 'token1', [mode.reverse ? quote : target.token]],
        [pool, 'function getReserves() view returns (uint112,uint112,uint32)', 'getReserves',
          mode.reverse ? [reserveToken, reserveQuote, 1000] : [reserveQuote, reserveToken, 1000]],
        [ROUTER, 'function getAmountsOut(uint256,address[]) view returns (uint256[])', 'getAmountsOut',
          [[amountIn, mode.quote ?? v2Output(amountIn, reserveQuote, reserveToken)]]],
      ];
      const bySignature = new Map(definitions.map(([address, abi, name, values]) => {
        const iface = typeof abi === 'string' ? new Interface([abi]) : abi;
        return [signature(address, iface.getFunction(name).selector), { name, bytes: iface.encodeFunctionResult(name, values) }];
      }));
      const respond = (to, data) => {
        const known = bySignature.get(signature(to, data));
        assert.ok(known, 'unexpected selector ' + signature(to, data));
        if (known.name === 'getPair') {
          const iface = new Interface(['function getPair(address,address) view returns (address)']);
          assert.deepEqual([...iface.decodeFunctionData('getPair', data)], [quote, target.token]);
        }
        if (known.name === 'getAmountsOut') {
          const iface = new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
          const [actualAmount, route] = iface.decodeFunctionData('getAmountsOut', data);
          assert.equal(actualAmount, amountIn);
          assert.deepEqual([...route], [quote, target.token]);
        }
        return known;
      };
      if (tx.to !== multi) return respond(tx.to, tx.data).bytes;
      const [batch] = MULTI.decodeFunctionData('aggregate3', tx.data);
      assert.ok(batch.length === 2 || batch.length === (mode.quoteToken ? 16 : 15));
      if (batch.length > 2 && mode.error) throw mode.error;
      if (batch.length > 2 && mode.empty) return '0x';
      const rows = batch.map(row => {
        const known = respond(row.target, row.callData);
        return mode.failed === known.name ? [false, '0x'] : [true, known.bytes];
      });
      return MULTI.encodeFunctionResult('aggregate3', [rows]) + (mode.trailing ? '00'.repeat(32) : '');
    },
  };
}

test('trusted pinned Multicall exactly reproduces direct minOut and retains all 13 reads in one request', async () => {
  const provider = providerFor();
  assert.equal(await warmSnipeMarket(provider, block), true);
  provider.calls.length = 0;
  const result = await readSnipeMarket(provider, target, pool, settings, block);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].to, multi);
  const directProvider = providerFor({ code: '0x' });
  assert.equal(await warmSnipeMarket(directProvider, block), false);
  assert.deepEqual({ ...result, readMode: 'direct' }, await readSnipeMarket(directProvider, target, pool, settings, block));
  assert.equal(directProvider.calls.length, 13);
  assert.equal(result.amountOutMin, (quoted * 9700n / 10000n) * 9000n / 10000n);
  assert.equal(result.amountOutMin, marketLimits({ amountIn: settings.amountIn, reserveBnb, reserveToken,
    quoted, buyTax, sellTax, settings }).amountOutMin);
  const reversed = providerFor({ reverse: true });
  await warmSnipeMarket(reversed, block);
  assert.deepEqual(result, await readSnipeMarket(reversed, target, pool, settings, block));
});

test('aggregated and direct quotes agree on a six-decimal ERC-20 pair and its on-chain asset', async () => {
  const quoteToken = '0x0000000000000000000000000000000000000088';
  const project = { ...target, quoteToken };
  const amountIn = 10_000_000n, reserveQuote = 1500_000_000n;
  const trade = { ...settings, quoteToken, quoteDecimals: 6, amountIn, minLiquidity: 100_000_000n };
  const mode = { quoteToken, amountIn, reserveQuote, reverse: true };
  const agg = providerFor(mode);
  await warmSnipeMarket(agg, block);
  const result = await readSnipeMarket(agg, project, pool, trade, block);
  assert.deepEqual(result.path, [quoteToken, target.token]);
  assert.equal(result.reserveQuote, reserveQuote);
  assert.equal(result.reserveBnb, undefined);
  assert.equal(result.quoted, v2Output(amountIn, reserveQuote, reserveToken));
  const direct = providerFor({ ...mode, code: '0x' });
  assert.deepEqual(await readSnipeMarket(direct, project, pool, trade, block), { ...result, readMode: 'direct' });
  mode.onChainQuote = other;
  await assert.rejects(readSnipeMarket(agg, project, pool, trade, block), /当前开盘状态/);
  await assert.rejects(readSnipeMarket(direct, project, pool, { ...trade, quoteToken: other }, block), /支付币不匹配/);
});

test('negative market/state results and unsafe RPC results cannot trigger direct fallback', async () => {
  for (const [patch, reason] of [
    [{ launched: false }, /Corla 当前/], [{ withdrawn: true }, /Corla 当前/], [{ implementation: other }, /Corla 当前/],
    [{ actualToken: other }, /Corla 当前/], [{ actualPool: other }, /Corla 当前/], [{ mainPool: other }, /交易池不一致/],
    [{ factoryPair: other }, /交易池不一致/], [{ buyTax: 501n }, /税/], [{ sellTax: 501n }, /税/],
    [{ quote: quoted + 1n }, /路由报价/], [{ chain: 1n }, /不是 BSC/], [{ height: block.number - 1 }, /错误的报价区块/],
    [{ failed: 'getReserves' }, /子调用失败/], [{ trailing: true }, /返回格式无效/],
    [{ error: Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) }, /timeout/],
    [{ error: Object.assign(new Error('RPC response size limit; HTTP 429'), { code: 'SERVER_ERROR' }) }, /429/],
    [{ error: Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }) }, /reverted/],
  ]) {
    const mode = {};
    const provider = providerFor(mode);
    assert.equal(await warmSnipeMarket(provider, block), true);
    Object.assign(mode, patch);
    provider.calls.length = 0;
    await assert.rejects(readSnipeMarket(provider, target, pool, settings, block), reason);
    assert.equal(provider.calls.length, 1, 'do not multiply rejected reads');
  }
});

test('explicit compatibility failure falls back to the original 13 pinned direct calls', async () => {
  for (const mode of [{ empty: true }, { error: new Error('aggregate3 unsupported on this endpoint') }]) {
    const provider = providerFor(mode);
    assert.equal(await warmSnipeMarket(provider, block), true);
    provider.calls.length = 0;
    const result = await readSnipeMarket(provider, target, pool, settings, block);
    assert.equal(result.quoted, quoted);
    assert.equal(provider.calls.length, 14);
  }
});

test('an arming probe reporting the wrong chain or block fails closed', async () => {
  for (const [mode, reason] of [[{ chain: 1n }, /不是 BSC/], [{ height: block.number + 1 }, /错误的报价区块/]]) {
    const provider = providerFor(mode);
    assert.equal(await warmSnipeMarket(provider, block), false);
    provider.calls.length = 0;
    await assert.rejects(readSnipeMarket(provider, target, pool, settings, block), reason);
    assert.equal(provider.calls.length, 0);
  }
});
