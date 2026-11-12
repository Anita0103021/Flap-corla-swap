import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, Transaction, Wallet, ZeroAddress, id, parseEther, toQuantity } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { DIRECT_LAUNCH_PORTAL } from '../src/events.mjs';
import { makeExecutor } from '../src/execution.mjs';
import { PANCAKE_FACTORY, ROUTER, WBNB, v2Output } from '../src/market.mjs';
import { buildPreopenBuyPlan, isVerifiedPreopenBuyPlan } from '../src/snipe-preopen.mjs';

const target = { factory: FACTORY, mint: '0x0000000000000000000000000000000000000033', token: '0x0000000000000000000000000000000000000044' };
const pool = '0x0000000000000000000000000000000000000055';
const fixtureWallet = Wallet.createRandom();
const wallet = fixtureWallet.address;
const head = { number: 500, timestamp: 50_000, hash: '0x' + 'ab'.repeat(32) };
const deadline = head.timestamp + 12;
const settings = { amountIn: parseEther('0.1'), minLiquidity: parseEther('1'), slippageBps: 1000, deadlineSeconds: 12,
  maxBuyTaxBps: 500, maxSellTaxBps: 500, maxPriceImpactBps: 1000 };
const reserveBnb = parseEther('5');
const reserveToken = parseEther('10000000');
const quoted = v2Output(settings.amountIn, reserveBnb, reserveToken);
const netQuoted = quoted * 9700n / 10_000n;
const minimum = (netQuoted * 10_000n + 10_999n) / 11_000n;
const portal = new Interface(['event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)']);
const factory = new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
  'function getPair(address,address) view returns (address)']);
const pair = new Interface(['event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const token = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)',
  'function mainPool() view returns (address)', 'function buyTaxRate() view returns (uint16)', 'function sellTaxRate() view returns (uint16)']);
const router = new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)']);
const portalData = AbiCoder.defaultAbiCoder().encode(
  ['tuple(uint256,uint256,uint8,address,uint8,uint256,string,string,string,address,uint256,uint8,uint16)'],
  [[1, 1, 0, ZeroAddress, 1, 1, 'sample', 'sample', '', pool, reserveToken, 0, 0]],
);
const event = (abi, name, address, args) => ({ address, ...abi.encodeEventLog(abi.getEvent(name), args) });

async function fixture({ patchState = {}, tax = 300, badHash = false, badHeader = false, badSeed = false,
  failedBuy = false, badTokenCode = false, fakeMinterNonce = false, omittedSwap = false } = {}) {
  const signer = Wallet.createRandom();
  const pricePerLot = parseEther('0.05');
  const input = CORLA_ABI.encodeFunctionData('mint', [[]]);
  const signed = Transaction.from(await signer.signTransaction({ type: 2, chainId: 56, nonce: 5, to: target.mint,
    data: input, value: pricePerLot, gasLimit: 9_000_000, maxFeePerGas: 80_000_000n, maxPriorityFeePerGas: 80_000_000n }));
  const pending = { to: target.mint, from: signer.address, hash: badHash ? '0x' + 'cd'.repeat(32) : signed.hash,
    chainId: '0x38', type: '0x2', nonce: '0x5', gas: toQuantity(signed.gasLimit), value: toQuantity(pricePerLot), input,
    maxFeePerGas: toQuantity(signed.maxFeePerGas), maxPriorityFeePerGas: toQuantity(signed.maxPriorityFeePerGas),
    r: signed.signature.r, s: signed.signature.s, v: toQuantity(signed.signature.yParity), accessList: [], blockNumber: null };
  const state = { blockNumber: head.number, phase: 1, launched: false, emergencyWithdrawn: false, quoteToken: ZeroAddress,
    token: ZeroAddress, pool: ZeroAddress, fundingDeadline: 90_000n, pricePerLot, mintedLots: 99n, totalLots: 100n, ...patchState };
  const success = (returnData = '0x', logs = [], gasUsed = '0x5208') => ({ status: '0x1', returnData, logs, gasUsed });
  const minted = () => success('0x', [
    event(CORLA_ABI, 'Minted', target.mint, [signer.address, 100]),
    event(CORLA_ABI, 'Launched', target.mint, [target.token, pool, signer.address]),
    event(portal, 'FlapDirectLaunched', DIRECT_LAUNCH_PORTAL, [target.token, 0, target.mint, id('DirectLaunchV2(DirectLaunchV2Data)'), portalData]),
    event(factory, 'PairCreated', PANCAKE_FACTORY, [target.token, WBNB, pool, 1]),
    event(pair, 'Mint', pool, [DIRECT_LAUNCH_PORTAL, reserveToken, reserveBnb]),
    event(pair, 'Sync', pool, [badSeed ? reserveToken - 1n : reserveToken, reserveBnb]),
  ]);
  const api = [];
  const provider = {
    getCode: async (address, block) => {
      assert.equal(address, target.token); assert.equal(block, head.number);
      return badTokenCode ? '0x01' : '0x';
    },
    getTransactionCount: async (address, block) => {
      assert.equal(address, signer.address); assert.equal(block, head.number);
      return fakeMinterNonce ? 6 : 5;
    },
    getBalance: async (address, block) => {
      assert.equal(address, signer.address); assert.equal(block, head.number);
      return parseEther('1');
    },
    getBlock: async block => {
      assert.equal(block, head.number);
      return badHeader ? { ...head, hash: '0x' + 'cd'.repeat(32) } : head;
    },
    send: async (method, [payload, anchor]) => {
      assert.equal(method, 'eth_simulateV1');
      assert.equal(anchor, toQuantity(head.number));
      const request = payload.blockStateCalls[0];
      assert.equal(request.blockOverrides.time, toQuantity(head.timestamp + 1));
      assert.equal(request.stateOverrides, undefined);
      assert.equal(request.calls[0].from, signer.address);
      assert.equal(request.calls[0].nonce, '0x5');
      assert.equal(request.calls[0].gas, pending.gas);
      assert.equal(request.calls[0].data, input);
      assert.equal(request.calls[0].value, pending.value);
      api.push(request.calls);
      const calls = [minted(), success(token.encodeFunctionResult('mainPool', [pool])),
        success(token.encodeFunctionResult('buyTaxRate', [tax])), success(token.encodeFunctionResult('sellTaxRate', [300])),
        success(factory.encodeFunctionResult('getPair', [pool])), success(router.encodeFunctionResult('getAmountsOut', [[settings.amountIn, quoted]]))];
      if (request.calls.length === 9) {
        const output = failedBuy ? { status: '0x0' } : success('0x', [
          ...(omittedSwap ? [] : [event(pair, 'Swap', pool, [ROUTER, 0, settings.amountIn, quoted, 0, wallet])]),
          event(token, 'Transfer', target.token, [pool, wallet, quoted * 9700n / 10_000n]),
        ], toQuantity(225_000));
        calls.push(output, success(), success('0x', [event(pair, 'Swap', pool, [ROUTER, minimum, 0, 0, parseEther('0.1'), wallet])]));
      }
      return [{ parentHash: head.hash, number: toQuantity(head.number + 1), timestamp: toQuantity(head.timestamp + 1), calls }];
    },
  };
  return { api, run: () => buildPreopenBuyPlan(provider, target, pending, wallet, settings, head,
    { services: { inspectMint: async (_provider, checked, block) => {
      assert.deepEqual(checked, target); assert.equal(block, head.number); return state;
    } } }) };
}

test('preopen plan independently verifies exact signed final mint and uses the initial simulated quote for minOut', async () => {
  const { run, api } = await fixture();
  const plan = await run();
  assert.equal(isVerifiedPreopenBuyPlan(plan), true);
  assert.equal(isVerifiedPreopenBuyPlan({ ...plan }), false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.tx), true);
  assert.equal(plan.recipient, wallet);
  assert.equal(api.length, 2);
  assert.deepEqual(api.map(x => x.length), [6, 9]);
  assert.equal(plan.quoteBlock, head.number);
  assert.equal(plan.quoteBlockHash, head.hash);
  assert.equal(plan.pool, pool);
  assert.equal(plan.amountOutMin, minimum);
  assert.equal(plan.openingNetOut, netQuoted);
  assert.equal(plan.openingAmountOutMin, minimum);
  assert.equal(plan.gasEstimate, 225_000n);
  assert.equal(plan.deadline, deadline);
  assert.equal(plan.tx.to, ROUTER);
  assert.equal(plan.tx.value, settings.amountIn);
  const decoded = router.decodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', plan.tx.data);
  assert.equal(decoded[0], minimum);
  assert.deepEqual([...decoded[1]], [WBNB, target.token]);
  assert.equal(decoded[2], wallet);
  assert.equal(decoded[3], BigInt(deadline));
});

test('preopen refuses non-final, already deployed, mismatched nonce, and forged signed-hash candidates before simulation', async () => {
  for (const [options, reason] of [
    [{ patchState: { mintedLots: 98n } }, /最后一批/],
    [{ badTokenCode: true }, /预计 Token 已部署/],
    [{ fakeMinterNonce: true }, /nonce/],
    [{ badHash: true }, /签名与交易哈希/],
  ]) {
    const { run, api } = await fixture(options);
    await assert.rejects(run, reason);
    assert.equal(api.length, 0);
  }
});

test('preopen fails closed on wrong seed, tax, revert, missing real swap, and reorg', async () => {
  for (const [options, reason, calls] of [
    [{ badSeed: true }, /注资与储备不一致/, 1],
    [{ tax: 501 }, /超过配置阈值/, 1],
    [{ failedBuy: true }, /回退/, 2],
    [{ omittedSwap: true }, /没有证明/, 2],
    [{ badHeader: true }, /重组/, 2],
  ]) {
    const { run, api } = await fixture(options);
    await assert.rejects(run, reason);
    assert.equal(api.length, calls);
  }
});

test('executor accepts only the exact branded preopen route without probing the not-yet-created live pool', async t => {
  const { run } = await fixture();
  const plan = await run();
  const dir = await mkdtemp(join(tmpdir(), 'corla-preopen-fixture-'));
  const journalPath = join(dir, 'attempts.sqlite');
  let sent = 0;
  const provider = {
    send: async method => {
      if (method === 'eth_chainId') return '0x38';
      assert.equal(method, 'eth_gasPrice');
      return '0x5f5e100';
    },
    getTransactionCount: async () => 11,
    getBalance: async () => parseEther('1'),
    getTransactionReceipt: async () => null,
    estimateGas: async () => assert.fail('the pair does not exist before launch'),
    call: async () => assert.fail('the pair does not exist before launch'),
    submitRawTransaction: async (raw, options) => {
      sent++;
      assert.equal(options.singleSubmission, true);
      const tx = Transaction.from(raw);
      assert.equal(tx.from, wallet);
      assert.equal(tx.nonce, 11);
      assert.equal(tx.data, plan.tx.data);
      assert.equal(tx.value, plan.tx.value);
      assert.equal(tx.gasLimit, plan.gasEstimate * 120n / 100n);
      return tx.hash;
    },
  };
  const execute = makeExecutor({ provider, wallets: [fixtureWallet], live: true, journalPath, directBroadcast: true,
    receiptTimeoutMs: 0, maxGasPriceWei: 200_000_000n, gasLimitCap: 500_000n });
  t.after(async () => {
    execute.close();
    for (const file of [journalPath, journalPath + '-wal', journalPath + '-shm', journalPath + '-journal']) {
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(dir);
  });
  const request = { actionId: 'bsc56:' + target.mint.toLowerCase() + ':buy', wallet: fixtureWallet, tx: plan.tx,
    maxAttempts: 3, gasEstimate: plan.gasEstimate, beforeSign: async () => {} };
  await assert.rejects(execute.race({ ...request, preopenPlan: { ...plan } }), /original verified ordered simulation plan/);
  assert.equal(sent, 0);
  const result = await execute.race({ ...request, preopenPlan: plan });
  assert.equal(result.status, 'pending');
  assert.equal(result.attempt, 1);
  assert.equal(sent, 1);
  assert.equal((await execute.race({ ...request, preopenPlan: plan })).txHash, result.txHash);
  assert.equal(sent, 1, 'an unresolved raw transaction never opens another nonce');
});
