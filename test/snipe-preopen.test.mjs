import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, Transaction, Wallet, ZeroAddress, id, parseEther, toQuantity } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI, CORLA_QUOTE_ABI } from '../src/corla.mjs';
import { DIRECT_LAUNCH_PORTAL } from '../src/events.mjs';
import { makeExecutor } from '../src/execution.mjs';
import { PANCAKE_FACTORY, ROUTER, ROUTER_ABI, WBNB, v2Output } from '../src/market.mjs';
import { QUOTE_ERC20 } from '../src/quote-assets.mjs';
import { buildPreopenBuyPlan, isVerifiedPreopenBuyPlan, preparePreopenMintSequence } from '../src/snipe-preopen.mjs';

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
const portalData = quoteToken => AbiCoder.defaultAbiCoder().encode(
  ['tuple(uint256,uint256,uint8,address,uint8,uint256,string,string,string,address,uint256,uint8,uint16)'],
  [[1, 1, 0, quoteToken, 1, 1, 'sample', 'sample', '', pool, reserveToken, 0, 0]],
);
const event = (abi, name, address, args) => ({ address, ...abi.encodeEventLog(abi.getEvent(name), args) });

async function fixture({ patchState = {}, tax = 300, badHash = false, badHeader = false, badSeed = false,
  failedBuy = false, badTokenCode = false, fakeMinterNonce = false, omittedSwap = false,
  quoteToken = ZeroAddress, shortAllowance = false, differentQuote, mintCount = 1, totalLots = 100n,
  nonceGap = false, badProgress = false, senderBalance = parseEther('1'), senderAllowance,
  distinctSenders = false, legacy = false } = {}) {
  const signer = Wallet.createRandom();
  const pricePerLot = parseEther('0.05');
  const tokenQuote = quoteToken !== ZeroAddress;
  const deploymentKey = '0x' + '33'.repeat(32);
  const armed = tokenQuote ? { ...target, quoteToken, deploymentKey, pricePerLot } : target;
  const trade = tokenQuote ? { ...settings, quoteToken, quoteDecimals: 6 } : settings;
  const to = tokenQuote ? FACTORY : target.mint;
  const asset = tokenQuote ? quoteToken : WBNB;
  const value = tokenQuote ? 0n : pricePerLot;
  const input = tokenQuote ? CORLA_QUOTE_ABI.encodeFunctionData('mintQuote', [deploymentKey, []]) : CORLA_ABI.encodeFunctionData('mint', [[]]);
  const rows = await Promise.all(Array.from({ length: mintCount }, async (_, i) => {
    const sender = distinctSenders && i ? Wallet.createRandom() : signer;
    const nonce = 5 + i + (i && nonceGap ? 1 : 0);
    const fee = legacy ? { type: 0, gasPrice: 80_000_000n } :
      { type: 2, maxFeePerGas: 80_000_000n, maxPriorityFeePerGas: 80_000_000n };
    const signed = Transaction.from(await sender.signTransaction({ ...fee, chainId: 56, nonce, to,
      data: input, value, gasLimit: 9_000_000 }));
    return { to, from: sender.address, hash: badHash ? '0x' + 'cd'.repeat(32) : signed.hash,
      type: toQuantity(fee.type), nonce: toQuantity(nonce), gas: toQuantity(signed.gasLimit), value: toQuantity(value), input,
      ...(legacy ? { gasPrice: toQuantity(signed.gasPrice) } : {
        chainId: '0x38', maxFeePerGas: toQuantity(signed.maxFeePerGas), maxPriorityFeePerGas: toQuantity(signed.maxPriorityFeePerGas), accessList: [],
      }),
      r: signed.signature.r, s: signed.signature.s, v: toQuantity(legacy ? signed.signature.networkV : signed.signature.yParity),
      blockNumber: null };
  }));
  const pending = rows[0];
  const state = { blockNumber: head.number, phase: 1, launched: false, emergencyWithdrawn: false, quoteToken, quoteDecimals: 6, deploymentKey,
    token: ZeroAddress, pool: ZeroAddress, fundingDeadline: 90_000n, pricePerLot, mintedLots: totalLots - BigInt(mintCount), totalLots, ...patchState };
  const success = (returnData = '0x', logs = [], gasUsed = '0x5208') => ({ status: '0x1', returnData, logs, gasUsed });
  const minted = () => success('0x', [
    event(CORLA_ABI, 'Minted', target.mint, [rows.at(-1).from, totalLots]),
    event(CORLA_ABI, 'Launched', target.mint, [target.token, pool, rows.at(-1).from]),
    event(portal, 'FlapDirectLaunched', DIRECT_LAUNCH_PORTAL, [target.token, 0, target.mint, id('DirectLaunchV2(DirectLaunchV2Data)'), portalData(differentQuote ?? quoteToken)]),
    event(factory, 'PairCreated', PANCAKE_FACTORY, [target.token, asset, pool, 1]),
    event(pair, 'Mint', pool, [DIRECT_LAUNCH_PORTAL, reserveToken, reserveBnb]),
    event(pair, 'Sync', pool, [badSeed ? reserveToken - 1n : reserveToken, reserveBnb]),
  ]);
  const api = [];
  const provider = {
    async call({ to, data, blockTag }) {
      assert.equal(to, quoteToken); assert.equal(blockTag, head.number);
      const { name, args } = QUOTE_ERC20.parseTransaction({ data });
      assert.ok(name === 'balanceOf' || name === 'allowance');
      if (name === 'allowance') assert.equal(args[1], args[0] === wallet ? ROUTER : FACTORY);
      return QUOTE_ERC20.encodeFunctionResult(name, [name !== 'allowance' ? parseEther('100') :
        shortAllowance ? 0n : args[0] !== wallet && senderAllowance !== undefined ? senderAllowance : parseEther('100')]);
    },
    getCode: async (address, block) => {
      assert.equal(address, target.token); assert.equal(block, head.number);
      return badTokenCode ? '0x01' : '0x';
    },
    getTransactionCount: async (address, block) => {
      const first = rows.find(r => r.from === address);
      assert.ok(first); assert.equal(block, head.number);
      return fakeMinterNonce ? 6 : Number(first.nonce);
    },
    getBalance: async (address, block) => {
      assert.ok(rows.some(r => r.from === address)); assert.equal(block, head.number);
      return senderBalance;
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
      assert.deepEqual(request.calls.slice(0, mintCount).map(call => [call.from, call.nonce]), rows.map(r => [r.from, r.nonce]));
      api.push(request.calls);
      const progress = rows.slice(0, -1).map((row, i) => success('0x', [
        event(CORLA_ABI, 'Minted', target.mint, [row.from, state.mintedLots + BigInt(badProgress ? 2 : i + 1)]),
      ]));
      const calls = [...progress, minted(), success(token.encodeFunctionResult('mainPool', [pool])),
        success(token.encodeFunctionResult('buyTaxRate', [tax])), success(token.encodeFunctionResult('sellTaxRate', [300])),
        success(factory.encodeFunctionResult('getPair', [pool])), success(router.encodeFunctionResult('getAmountsOut', [[settings.amountIn, quoted]]))];
      if (request.calls.length === mintCount + 8) {
        const output = failedBuy ? { status: '0x0' } : success('0x', [
          ...(omittedSwap ? [] : [event(pair, 'Swap', pool, [ROUTER, 0, settings.amountIn, quoted, 0, wallet])]),
          event(token, 'Transfer', target.token, [pool, wallet, quoted * 9700n / 10_000n]),
        ], toQuantity(225_000));
        calls.push(output, success(), success('0x', [event(pair, 'Swap', pool, [ROUTER, minimum, 0, 0, parseEther('0.1'), wallet])]));
      }
      return [{ parentHash: head.hash, number: toQuantity(head.number + 1), timestamp: toQuantity(head.timestamp + 1), calls }];
    },
  };
  let inspections = 0;
  const options = { services: { inspectMint: async (_provider, checked, block) => {
    inspections++;
    assert.deepEqual(checked, armed); assert.equal(block, head.number); return state;
  } } };
  return { api, pending, rows, armed, inspections: () => inspections,
    prepare: (from = rows) => preparePreopenMintSequence(provider, armed, from, trade, head, options),
    run: (from = rows) => buildPreopenBuyPlan(provider, armed, from, wallet, trade, head, options) };
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

test('preopen uses the factory Mint and verified ERC-20 purchase and sale paths', async () => {
  const quoteToken = '0x0000000000000000000000000000000000000088';
  const { run, api } = await fixture({ quoteToken });
  const plan = await run();
  const [mint, , , , , , buy, , sell] = api[1];
  assert.equal(mint.to, FACTORY);
  assert.equal(mint.value, '0x0');
  assert.equal(plan.quoteToken, quoteToken);
  assert.equal(plan.tx.value, 0n);
  const parsed = ROUTER_ABI.parseTransaction({ data: buy.data });
  assert.equal(parsed.name, 'swapExactTokensForTokensSupportingFeeOnTransferTokens');
  assert.equal(parsed.args[0], settings.amountIn);
  assert.deepEqual([...parsed.args[2]], [quoteToken, target.token]);
  assert.deepEqual([...ROUTER_ABI.parseTransaction({ data: sell.data }).args[2]], [target.token, quoteToken]);
  await assert.rejects((await fixture({ quoteToken, shortAllowance: true })).run, /余额或授权额度不足/);
  await assert.rejects((await fixture({ quoteToken, differentQuote: ZeroAddress })).run, /支付币匹配/);
});

test('preopen refuses non-final, already deployed, mismatched nonce, and forged signed-hash candidates before simulation', async () => {
  for (const [options, reason] of [
    [{ patchState: { mintedLots: 98n } }, /父块剩余批数/],
    [{ badTokenCode: true }, /预计 Token 已部署/],
    [{ fakeMinterNonce: true }, /nonce/],
    [{ badHash: true }, /签名与交易哈希/],
  ]) {
    const { run, api } = await fixture(options);
    await assert.rejects(run, reason);
    assert.equal(api.length, 0);
  }
});

test('a mined penultimate Mint that arrives late is classified as stale, not a buy wallet funding error', async () => {
  const f = await fixture({ fakeMinterNonce: true });
  await assert.rejects(f.run(), error => error.stage === 'stale_pending' && error.evidence.stalePendingCount === 1);
  assert.equal(f.api.length, 0);
});

test('47/50 at the parent works with three verified Mints and only the last call launches', async () => {
  const f = await fixture({ mintCount: 3, totalLots: 50n, distinctSenders: true, legacy: true });
  const sequence = await f.prepare();
  assert.equal(sequence.mintedLots, 47n);
  assert.equal(sequence.remainingLots, 3n);
  assert.equal(sequence.pendingMintCount, 3);
  const plan = await f.run(sequence);
  assert.deepEqual(plan.pendingHashes, f.rows.map(row => row.hash));
  assert.equal(plan.pendingHash, f.rows[2].hash);
  assert.equal(plan.amountOutMin, minimum);
  assert.deepEqual(f.api.map(calls => calls.length), [8, 11]);
  assert.equal(f.inspections(), 1, 'validated target/sender snapshot is reused by the wallet simulation');
  const erc20 = await fixture({ mintCount: 3, totalLots: 50n, quoteToken: '0x' + '88'.repeat(20) });
  const buy = await erc20.run([...erc20.rows].reverse());
  assert.deepEqual(buy.pendingHashes, erc20.rows.map(row => row.hash), 'same-sender nonces override WS arrival order');
  assert.equal(ROUTER_ABI.parseTransaction({ data: buy.tx.data }).name, 'swapExactTokensForTokensSupportingFeeOnTransferTokens');
});

test('missing, duplicate, gapped or underfunded pending Mints never form a three-lot plan', async () => {
  const onlyTwo = await fixture({ mintCount: 3, totalLots: 50n });
  await assert.rejects(onlyTwo.run(onlyTwo.rows.slice(0, 2)), /父块剩余批数/);
  await assert.rejects(onlyTwo.run([...onlyTwo.rows.slice(0, 2), onlyTwo.rows[0]]), /父块剩余批数/);
  assert.equal(onlyTwo.api.length, 0);
  for (const options of [
    { nonceGap: true },
    { senderBalance: parseEther('0.12') },
    { quoteToken: '0x' + '88'.repeat(20), senderAllowance: parseEther('0.12') },
  ]) {
    const f = await fixture({ mintCount: 3, totalLots: 50n, ...options });
    await assert.rejects(f.run(), /nonce|累计余额|授权额度/);
    assert.equal(f.api.length, 0);
  }
  const wrongProgress = await fixture({ mintCount: 3, totalLots: 50n, badProgress: true });
  await assert.rejects(wrongProgress.run(), /逐批推进/);
  assert.equal(wrongProgress.api.length, 1, 'stop before building a buy after inconsistent Minted events');
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
