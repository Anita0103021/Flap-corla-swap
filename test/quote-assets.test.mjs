import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getAddress, parseEther, ZeroAddress } from 'ethers';
import { checkBudget, FACTORY, quoteSpendRows, snipeSettingsForTarget, validateConfig } from '../src/config.mjs';
import { buildClaim, buildMint, CORLA_ABI, CORLA_QUOTE_ABI } from '../src/corla.mjs';
import { CORLA_LAUNCH_TOPIC, decodeLaunchCandidate, portalLaunchQuote, verifyLaunchCandidate } from '../src/events.mjs';
import { buildBuy, ROUTER, ROUTER_ABI, WBNB } from '../src/market.mjs';
import { decodePendingMint } from '../src/pending-mint-shadow.mjs';
import { prepareQuoteAllowances } from '../src/quote-allowances.mjs';
import { formatQuoteUnits, QUOTE_ERC20, quoteUnits } from '../src/quote-assets.mjs';

// Public ai16z final Mint and launch on Nov 14, 2026. The fixture preserves
// the original calldata, relevant events and their original log indexes.
const fixture = JSON.parse(await readFile(new URL('./fixtures/bsc-corla-usdt-launch.json', import.meta.url), 'utf8'));
const { receipt } = fixture;
const launch = receipt.logs.find(log => log.topics[0] === CORLA_LAUNCH_TOPIC);
const at = i => getAddress('0x' + launch.topics[i].slice(-40));
const USDT = getAddress('0x55d398326f99059ff775485246999027b3197955');
const target = { mint: getAddress(launch.address), token: at(1), factory: FACTORY };
const withQuote = { ...target, quoteToken: USDT };
const [DEPLOYMENT_KEY] = CORLA_QUOTE_ABI.decodeFunctionData('mintQuote', fixture.input);
const WALLET = { address: at(3) };
const launchLog = { ...launch, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, transactionHash: receipt.hash };
const receiptProvider = { getTransactionReceipt: async hash => { assert.equal(hash, receipt.hash); return receipt; } };

test('a BSC USDT final Mint is decoded at the factory and proves its actual initial USDT reserve', async () => {
  const before = { ...withQuote, pricePerLot: parseEther('70'), deploymentKey: DEPLOYMENT_KEY };
  const watched = new Map([[target.mint.toLowerCase(), before]]);
  const tx = { to: fixture.to, value: fixture.value, input: fixture.input, hash: receipt.hash, from: WALLET.address };
  assert.equal(getAddress(tx.to), FACTORY);
  assert.deepEqual(decodePendingMint(tx, watched), { mint: target.mint, hash: receipt.hash });
  assert.equal(decodePendingMint({ ...tx, value: '0x1' }, watched), null);
  assert.equal(decodePendingMint({ ...tx, to: target.mint }, watched), null);
  assert.equal(decodePendingMint(tx, new Map([[target.mint.toLowerCase(), { ...before, deploymentKey: '0x' + 'aa'.repeat(32) }]])), null);
  const transfer = receipt.logs.filter(log => log.address === USDT.toLowerCase()).map(log => QUOTE_ERC20.parseLog(log))
    .find(({ args }) => args.from === WALLET.address && args.to === target.mint);
  assert.equal(transfer.args.value, parseEther('70'));
  assert.ok(receipt.logs.some(log => portalLaunchQuote(log, target.token, at(2)) === USDT));
  const candidate = row => decodeLaunchCandidate(row, launchLog, receipt.blockNumber, receipt.blockNumber);
  const read = await verifyLaunchCandidate(receiptProvider, candidate(withQuote));
  assert.equal(read.quoteToken, USDT);
  assert.equal(read.pool, at(2));
  assert.equal(read.openingReserves.reserveQuote, parseEther('3500'));
  assert.ok(read.openingReserves.reserveToken > 0n);
  assert.equal(read.openingReserves.reserveBnb, undefined);
  for (const token of [ZeroAddress, WALLET.address]) {
    assert.equal(await verifyLaunchCandidate(receiptProvider, candidate({ ...target, quoteToken: token })), null);
  }
});

const stockReceipts = JSON.parse(await readFile(new URL('./fixtures/bsc-corla-stock-launches.json', import.meta.url), 'utf8'));
const verifiedAssets = JSON.parse(await readFile(new URL('./fixtures/flap-corla-enabled-quotes.json', import.meta.url), 'utf8')).enabled;

for (const { symbol, receipt: stock, to, value, input } of stockReceipts) {
  test(symbol + ' actual final Mint arms only its designated non-USDT V2 route', async () => {
    const log = stock.logs.find(row => row.topics[0] === CORLA_LAUNCH_TOPIC);
    const addr = i => getAddress('0x' + log.topics[i].slice(-40));
    const quoteToken = verifiedAssets.find(row => row.symbol === symbol).address;
    const [deploymentKey] = CORLA_QUOTE_ABI.decodeFunctionData('mintQuote', input);
    const row = { mint: getAddress(log.address), token: addr(1), factory: FACTORY, quoteToken, deploymentKey };
    assert.equal(getAddress(to), FACTORY);
    assert.deepEqual(decodePendingMint({ to, from: addr(3), input, value, hash: stock.hash }, new Map([[log.address, row]])),
      { mint: row.mint, hash: stock.hash });
    const identify = asset => decodeLaunchCandidate({ ...row, quoteToken: asset }, {
      ...log, blockNumber: stock.blockNumber, blockHash: stock.blockHash, transactionHash: stock.hash,
    }, stock.blockNumber, stock.blockNumber);
    const rpc = { getTransactionReceipt: async () => stock };
    const launch = await verifyLaunchCandidate(rpc, identify(quoteToken));
    assert.equal(launch.pool, addr(2));
    assert.equal(launch.quoteToken, quoteToken);
    assert.ok(launch.openingReserves.reserveQuote > 0n);
    assert.ok(launch.openingReserves.reserveToken > 0n);
    assert.equal(await verifyLaunchCandidate(rpc, identify(USDT)), null);
  });
}

const block = { number: 1234, timestamp: 1000 };
const active = { phase: 1, pricePerLot: parseEther('70'), mintedLots: 47n, totalLots: 50n, maxMintsPerWallet: 3n,
  tokensPerLot: 100n, fundingDeadline: 2000n, emergencyWithdrawn: false, agentOnly: false, launched: false,
  quoteToken: USDT, quoteDecimals: 18, deploymentKey: DEPLOYMENT_KEY, blockNumber: block.number };
const mintTarget = { ...target, mintBatches: 2, autoClaim: true, mintQuote: { quoteToken: USDT, quoteDecimals: 18, priceLimit: parseEther('80') } };

function walletProvider({
  balance = parseEther('1000'), mintAllowance = 0n, routerAllowance = 0n, approveResult = true,
  nonce = 9, gas = parseEther('0.01'),
} = {}) {
  const allowances = new Map([[FACTORY, mintAllowance], [ROUTER, routerAllowance]]);
  return {
    allowances,
    async getBlock(tag) { assert.equal(tag, 'latest'); return block; },
    async getBalance(wallet, at) { assert.equal(wallet, WALLET.address); assert.equal(at, block.number); return gas; },
    async getTransactionCount(wallet, tag) {
      assert.equal(wallet, WALLET.address); assert.equal(tag, 'latest'); return nonce++;
    },
    async call({ to, data, blockTag }) {
      if (to === USDT) {
        const { name, args } = QUOTE_ERC20.parseTransaction({ data });
        if (name === 'approve') return QUOTE_ERC20.encodeFunctionResult(name, [approveResult]);
        assert.ok(blockTag === block.number || blockTag === 'latest');
        if (name !== 'decimals') assert.equal(args[0], WALLET.address);
        if (name === 'allowance') assert.ok(allowances.has(args[1]), 'use a trusted spender');
        return QUOTE_ERC20.encodeFunctionResult(name, [name === 'decimals' ? 18
          : name === 'balanceOf' ? balance : allowances.get(args[1])]);
      }
      assert.equal(blockTag, block.number);
      const { name, args } = CORLA_ABI.parseTransaction({ data });
      assert.equal(args[0], WALLET.address);
      return CORLA_ABI.encodeFunctionResult(name, [name === 'walletMintCount' ? 1n : false]);
    },
  };
}

test('Mint attaches no BNB for payment, guards the quote currency and uses the same direct claim', async () => {
  const provider = walletProvider({ mintAllowance: parseEther('70') });
  const plan = await buildMint(provider, mintTarget, active, WALLET.address, block);
  assert.deepEqual(plan.tx, { to: FACTORY, data: fixture.input, value: 0n });
  assert.equal(plan.details.mintOrdinal, 2);
  assert.equal(plan.details.quoteToken, USDT);
  await assert.rejects(buildMint(walletProvider(), mintTarget, active, WALLET.address, block), /额度不足/);
  await assert.rejects(buildMint(walletProvider({ mintAllowance: parseEther('70'), balance: 1n }),
    mintTarget, active, WALLET.address, block), /余额/);
  await assert.rejects(buildMint({}, mintTarget, { ...active, quoteDecimals: 6 }, WALLET.address, block), /配置不一致/);
  await assert.rejects(buildMint({}, mintTarget, { ...active, deploymentKey: '0x' + '0'.repeat(64) }, WALLET.address, block), /配置不一致/);
  assert.equal(await buildMint({}, mintTarget, { ...active, pricePerLot: parseEther('81') }, WALLET.address, block), null);
  const claim = await buildClaim(walletProvider({ mintAllowance: 0n, balance: 0n }), mintTarget,
    { ...active, launched: true }, WALLET.address);
  assert.deepEqual(claim.tx, { to: target.mint, data: CORLA_ABI.encodeFunctionData('claim'), value: 0n });
});

const link = t => 'https://flap.sh/apps/corla/mint/' + t.token + '?mint=' + t.mint + '&factory=' + FACTORY + '&catalogVersion=4';
const other = { mint: '0x0000000000000000000000000000000000000020', token: '0x0000000000000000000000000000000000000030' };
const third = { mint: '0x0000000000000000000000000000000000000040', token: '0x0000000000000000000000000000000000000050' };
const snipeTarget = (t, amountQuote = '10', quoteToken = USDT, quoteDecimals = 18) => ({
  url: link(t), quoteToken, quoteDecimals, amountQuote, minLiquidityQuote: '1000',
});
const mintRow = { url: link(target), mintBatches: 2, autoClaim: true, quoteToken: USDT, quoteDecimals: 18, maxMintPriceQuote: '80' };

test('every currently enabled Flap quote uses its actual input asset and never substitutes BNB', () => {
  for (const { address: quoteToken, decimals: quoteDecimals } of verifiedAssets) {
    const native = quoteToken === ZeroAddress;
    const cfg = validateConfig({ targets: [], snipeTargets: [native ? link(other) : snipeTarget(other, '1.25', quoteToken, quoteDecimals)],
      snipe: native ? { amountBnb: '1.25', minLiquidityBnb: '1' } : undefined }, '.');
    const settings = snipeSettingsForTarget(cfg.snipe, cfg.targets[0]);
    const path = [native ? WBNB : quoteToken, other.token];
    const tx = buildBuy({ path, amountOutMin: 42n }, WALLET.address, settings, block);
    const call = ROUTER_ABI.parseTransaction({ data: tx.data, value: tx.value });
    assert.equal(tx.to, ROUTER);
    assert.equal(tx.value, native ? parseEther('1.25') : 0n);
    assert.deepEqual([...call.args[native ? 1 : 2]], path);
    if (!native) assert.equal(call.args[0], quoteUnits('1.25', quoteDecimals, 'payment'));
  }
});

test('mixed budgets reserve token principal independently and never assume 18 decimals', () => {
  const q6 = '0x0000000000000000000000000000000000000060';
  const cfg = validateConfig({ targets: [mintRow], snipeTargets: [snipeTarget(other, '1.000001', q6, 6), link(third)],
    maxTotalBnb: '1', snipe: { amountBnb: '0.1', minLiquidityBnb: '1' } }, '.');
  assert.equal(cfg.targets.length, 3);
  const [mint, six, native] = cfg.targets;
  assert.equal(mint.mintQuote.priceLimit, parseEther('80'));
  assert.equal(snipeSettingsForTarget(cfg.snipe, six).amountIn, 1_000_001n);
  assert.equal(snipeSettingsForTarget(cfg.snipe, native).amountIn, parseEther('0.1'));
  assert.equal(cfg.snipe.requirePreopen, true);
  assert.equal(cfg.snipe.repeatAttempts, 2);
  assert.deepEqual(quoteSpendRows(cfg, [WALLET]).map(row => row.amount), [parseEther('160'), 1_000_001n]);
  // Two Mint batches, one claim, 2 × 2 buy attempts and 2 × 2 optional approvals.
  assert.equal(checkBudget(cfg, [WALLET]), parseEther('0.31'));
  assert.equal(quoteUnits('2', 0, 'amount'), 2n);
  assert.equal(formatQuoteUnits(1n, 100), '0.' + '0'.repeat(99) + '1');
  assert.throws(() => quoteUnits('1.0000001', 6, 'amount'), /精度/);
  const onlyToken = validateConfig({ targets: [], snipeTargets: [snipeTarget(other, '10')] }, '.');
  assert.equal(snipeSettingsForTarget(onlyToken.snipe, onlyToken.targets[0]).amountIn, parseEther('10'));
});

function approvalsTest(provider, overrides = {}) {
  const cfg = validateConfig({ targets: [mintRow], snipeTargets: [snipeTarget(other), snipeTarget(third, '12')] }, '.');
  const approvals = [];
  const task = { provider, cfg, wallets: [WALLET], log: () => {},
    inspect: async (_rpc, _target, height) => { assert.equal(height, block.number); return active; },
    execute: async ({ tx, actionId, beforeSign, receiptWaitMs }) => {
      assert.equal(tx.to, USDT);
      assert.equal(tx.value, 0n);
      assert.ok(receiptWaitMs > 0);
      await beforeSign();
      const [spender, value] = QUOTE_ERC20.decodeFunctionData('approve', tx.data);
      provider.allowances.set(spender, value);
      approvals.push([spender, value]);
      return { status: 'confirmed', actionId };
    }, ...overrides };
  return { approvals, prepare: () => prepareQuoteAllowances(task) };
}

test('only the reviewed spender gets limited approvals, including reset and already sufficient allowances', async () => {
  const x = approvalsTest(walletProvider({ mintAllowance: 1n }));
  assert.equal(await x.prepare(), 3);
  assert.deepEqual(x.approvals, [[FACTORY, 0n], [FACTORY, parseEther('70')], [ROUTER, parseEther('22')]]);
  assert.equal(await x.prepare(), 0);
  const closed = approvalsTest(walletProvider({ gas: 0n }), { inspect: async () => ({ ...active, launched: true }) });
  assert.equal(await closed.prepare(), 0);
  assert.deepEqual(closed.approvals, []);
});

test('an asset disabled after confirmation or a different DEX gets no new allowance', async () => {
  for (const state of [{ quoteEnabled: false }, { poolRoute: 'unsupported' }]) {
    const wrong = approvalsTest(walletProvider(), { inspect: async () => ({ ...active, ...state }) });
    await assert.rejects(wrong.prepare(), /未开放|直连池/);
    assert.deepEqual(wrong.approvals, []);
  }
  let inspections = 0;
  const moved = approvalsTest(walletProvider(), {
    inspect: async () => ({ ...active, quoteEnabled: ++inspections <= 3, poolRoute: 'pancake-v2' }),
  });
  await assert.rejects(moved.prepare(), /未开放/);
  assert.deepEqual(moved.approvals, []);
});

test('insufficient aggregate balance, denied or unconfirmed allowance never starts a buy', async () => {
  const short = approvalsTest(walletProvider({ balance: parseEther('80') }));
  await assert.rejects(short.prepare(), /余额不足/);
  assert.deepEqual(short.approvals, []);
  const denied = approvalsTest(walletProvider({ approveResult: false }));
  await assert.rejects(denied.prepare(), /未认可/);
  assert.deepEqual(denied.approvals, []);
  const pending = approvalsTest(walletProvider(), { execute: async () => ({ status: 'pending' }) });
  await assert.rejects(pending.prepare(), /尚未确认/);
  const unrelated = approvalsTest(walletProvider(), { execute: async () => ({ status: 'confirmed', actionId: 'unrelated' }) });
  await assert.rejects(unrelated.prepare(), /尚未确认/);
});
