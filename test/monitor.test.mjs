import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'ethers';
import { actionId, checkBuyFreshness, launchSearchBounds, makeJournalHistoryPoller, makeMonitor } from '../src/monitor.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { discount, marketLimits, v2Output } from '../src/market.mjs';

test('launch window never includes blocks at or before arming', () => {
  assert.equal(launchSearchBounds(100, 100, 15), null);
  assert.deepEqual(launchSearchBounds(100, 101, 15), [101, 101]);
  assert.deepEqual(launchSearchBounds(100, 150, 15), [136, 150]);
});

test('final buy check rejects reorged, stale, old and expired launches', () => {
  const launchHash = '0x' + 'aa'.repeat(32), quoteHash = '0x' + 'bb'.repeat(32);
  const args = { head: { number: 110, timestamp: 1004 }, canonicalLaunch: { number: 105, hash: launchHash },
    canonicalQuote: { number: 108, hash: quoteHash },
    launch: { blockHash: launchHash, blockNumber: 105 }, quoteBlock: { number: 108, hash: quoteHash, timestamp: 1000 },
    settings: { windowBlocks: 15, deadlineSeconds: 12 }, armBlock: 100 };
  checkBuyFreshness(args);
  assert.throws(() => checkBuyFreshness({ ...args, canonicalLaunch: { ...args.canonicalLaunch, hash: quoteHash } }), { retryable: false });
  assert.throws(() => checkBuyFreshness({ ...args, canonicalQuote: { ...args.canonicalQuote, hash: launchHash } }), { retryable: true });
  assert.throws(() => checkBuyFreshness({ ...args, head: { ...args.head, number: 107 } }), { retryable: true });
  assert.throws(() => checkBuyFreshness({ ...args, armBlock: 105 }));
  assert.throws(() => checkBuyFreshness({ ...args, head: { ...args.head, number: 120 } }));
  assert.throws(() => checkBuyFreshness({ ...args, head: { ...args.head, timestamp: 1010 } }));
});

const addresses = [
  '0x0000000000000000000000000000000000000101',
  '0x0000000000000000000000000000000000000102',
  '0x0000000000000000000000000000000000000103',
];
const wallets = addresses.map(address => ({ address }));
const target = {
  mint: '0x4724ce75d772eda774147f6198f1a876811d6e19', token: '0xc402b65aa0a6ef7562a1580fd778397d6e817777',
  mintBatches: 2, maxMintPriceWei: parseEther('0.1'), mintWallets: addresses.slice(0, 2), autoClaim: true,
};
const snipeSettings = {
  windowBlocks: 15, walletCount: 1, deadlineSeconds: 12, amountIn: parseEther('0.1'),
  minLiquidity: parseEther('1'), slippageBps: 1000, maxOpeningPremiumBps: 1000,
  maxBuyTaxBps: 500, maxSellTaxBps: 500, maxPriceImpactBps: 1000,
};
const openingReserves = { reserveBnb: parseEther('5'), reserveToken: parseEther('5000000000') };
const buyTax = 300n;
const openingNetOut = discount(v2Output(snipeSettings.amountIn, openingReserves.reserveBnb, openingReserves.reserveToken), buyTax);
const requiredOut = (openingNetOut * 10_000n + 10_999n) / 11_000n;
function marketQuote(reserves = openingReserves) {
  const quoted = v2Output(snipeSettings.amountIn, reserves.reserveBnb, reserves.reserveToken);
  const market = { ...reserves, quoted, buyTax, sellTax: 300n };
  return { ...market, ...marketLimits({ ...market, amountIn: snipeSettings.amountIn, settings: snipeSettings }) };
}

function fixture({ targetOverrides, gasLimitCap = 10_000_000n, reply = 'confirmed' } = {}) {
  const project = { ...target, ...targetOverrides };
  const snapshot = {
    mintedLots: 2n, totalLots: 50n, launched: false, pricePerLot: parseEther('0.1'), tokensPerLot: parseEther('1'),
    maxMintsPerWallet: 3n, phase: 1, fundingDeadline: 1100n, whitelistEnabled: false, whitelistDeadline: 0n,
    agentOnly: false, emergencyWithdrawn: false,
  };
  let block = 100;
  let active = 0;
  let maxActive = 0;
  const counts = new Map(addresses.map(address => [address, 0n]));
  const submitted = [];
  const logs = [];
  const journal = new Map();
  const key = (action, wallet) => action + ':' + wallet;
  let latestMinted;
  const provider = {
    async getBlock() { return { number: block, timestamp: 1000 }; },
    async call({ to, data, blockTag }) {
      assert.equal(to, project.mint);
      assert.equal(blockTag, block);
      const { name, args } = CORLA_ABI.parseTransaction({ data });
      if (name === 'getMintState') return CORLA_ABI.encodeFunctionResult(name, [snapshot.mintedLots, snapshot.phase]);
      const result = {
        ...snapshot,
        walletMintCount: name === 'walletMintCount' ? counts.get(args[0]) : undefined,
        claimed: false, refunded: false, mintedLots: latestMinted ?? snapshot.mintedLots,
      };
      assert.ok(name in result);
      return CORLA_ABI.encodeFunctionResult(name, [result[name]]);
    },
    async getBalance() { return parseEther('1'); },
  };
  const execute = async request => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await request.beforeSign?.();
      submitted.push(request);
      const result = { status: reply, actionId: request.actionId, wallet: request.wallet.address, txHash: '0x' + 'a'.repeat(64) };
      journal.set(key(result.actionId, result.wallet), result);
      return result;
    } finally { active--; }
  };
  execute.reconcile = async (action, wallet) => journal.get(key(action, wallet.address)) ?? null;
  const tick = makeMonitor({
    provider, wallets, cfg: { targets: [project], gasLimitCap }, execute, armBlock: 100,
    log: (event, row) => logs.push({ event, ...row }),
    services: { inspectMint: async (_provider, _target, blockNumber) => ({ ...snapshot, blockNumber }) },
  });
  return {
    project, snapshot, counts, submitted, logs, journal, tick, key,
    next: async () => { block++; await tick(); },
    maxActive: () => maxActive,
    setLatestMinted: value => { latestMinted = value; },
  };
}

function actions(submitted) {
  return submitted.map(row => [row.wallet.address, row.actionId]).sort((a, b) => a[0].localeCompare(b[0]));
}

test('mint goal is reached sequentially per wallet, selected wallets run in parallel, then claim', async () => {
  const f = fixture();
  f.counts.set(addresses[1], 1n); // Existing Mint counts toward this goal.
  f.counts.set(addresses[2], 1n); // Unselected wallet is not used for either action.
  const legacy = 'bsc56:' + target.mint + ':mint';
  assert.equal(actionId('mint', target), legacy);
  assert.equal(actionId('mint', target, 1), legacy);
  assert.equal(actionId('mint', target, 2), legacy + ':2');
  assert.throws(() => actionId('mint', target, 33), /批次/);
  await f.tick();
  assert.equal(f.maxActive(), 2);
  assert.deepEqual(actions(f.submitted), [[addresses[0], legacy], [addresses[1], legacy + ':2']]);
  await f.tick();
  await f.next(); // Later RPC block but still no wallet count change.
  assert.equal(f.submitted.length, 2);
  f.counts.set(addresses[0], 1n);
  f.counts.set(addresses[1], 2n);
  f.snapshot.mintedLots += 2n;
  await f.next();
  assert.deepEqual(actions(f.submitted.slice(2)), [[addresses[0], legacy + ':2']]);
  f.counts.set(addresses[0], 2n);
  f.snapshot.mintedLots++;
  await f.next();
  assert.equal(f.submitted.length, 3); // At requested goal; cap is higher but do not continue.
  f.snapshot.launched = true;
  await f.next();
  assert.deepEqual(actions(f.submitted.slice(3)), [
    [addresses[0], actionId('claim', target)], [addresses[1], actionId('claim', target)],
  ]);
  assert.ok(f.logs.some(log => log.event === 'mint' && log.mintOrdinal === 2 && log.mintGoal === 2));
});

test('reconciles ordinal after restart and blocks new mint while its receipt is unresolved', async () => {
  const f = fixture({ targetOverrides: { mintBatches: 3, mintWallets: [addresses[0]] } });
  const second = actionId('mint', target, 2);
  const pending = { status: 'pending', actionId: second, wallet: addresses[0], txHash: '0x' + 'b'.repeat(64) };
  f.counts.set(addresses[0], 1n);
  f.journal.set(f.key(second, addresses[0]), pending);
  await f.tick(); // Reconstructed process sees existing exact journal entry.
  assert.equal(f.submitted.length, 0);
  f.counts.set(addresses[0], 2n);
  await f.next(); // Even when count moves, wait for pending ordinal to resolve.
  assert.equal(f.submitted.length, 0);
  f.journal.set(f.key(second, addresses[0]), { ...pending, status: 'confirmed' });
  await f.next();
  assert.deepEqual(actions(f.submitted), [[addresses[0], actionId('mint', target, 3)]]);
});

test('reports a reorg of a recently confirmed mint, keeping the original ordinal deduplicated', async () => {
  const f = fixture({ targetOverrides: { mintWallets: [addresses[0]] } });
  const first = actionId('mint', target);
  await f.tick();
  const recorded = f.journal.get(f.key(first, addresses[0]));
  f.journal.set(f.key(first, addresses[0]), { ...recorded, status: 'pending', reason: 'confirmed block was reorganized' });
  await f.next();
  assert.deepEqual(f.logs.filter(row => row.event === 'mint').map(row => row.status), ['confirmed', 'pending']);
  assert.equal(f.submitted.length, 1);
  f.counts.set(addresses[0], 1n);
  await f.next();
  assert.equal(f.submitted.length, 1);
});

test('restart history polling surfaces an older pending receipt and notices canonical recovery', async () => {
  const id = actionId('mint', target, 2);
  const row = { actionId: id, wallet: wallets[0].address, txHash: '0x' + 'a'.repeat(64), status: 'pending', receiptStable: false };
  const events = [];
  let awaiting = true, exact = 0;
  const poll = makeJournalHistoryPoller({ execute: {
    async reconcileRecent() { return awaiting ? [row] : []; },
    async reconcile(action, wallet) {
      assert.equal(action, id);
      assert.equal(wallet, wallets[0]);
      exact++;
      return { ...row, status: 'confirmed', receiptStable: true };
    },
  }, log: (event, details) => events.push([event, details]) });
  await poll([wallets[0]]);
  await poll([wallets[0]]);
  assert.equal(events.length, 1);
  assert.equal(exact, 0);
  awaiting = false;
  await poll([wallets[0]]);
  await poll([wallets[0]]);
  assert.equal(exact, 1);
  assert.deepEqual(events.map(([event, { status }]) => [event, status]), [['journal', 'pending'], ['journal', 'confirmed']]);
});

test('failed or simulated ordinal is not retried without another on-chain count', async () => {
  for (const status of ['failed', 'simulated']) {
    const f = fixture({ targetOverrides: { mintWallets: [addresses[0]] }, reply: status });
    await f.tick();
    await f.next();
    assert.deepEqual(actions(f.submitted), [[addresses[0], actionId('mint', target)]]);
  }
});

test('caps parallel mint attempts by remaining supply and requires final-lot gas floor', async () => {
  const f = fixture();
  f.snapshot.mintedLots = 49n;
  await f.tick();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].gasLimitFloor, 8_500_000n);
  const lowCap = fixture({ gasLimitCap: 1_000_000n });
  lowCap.snapshot.mintedLots = 49n;
  await lowCap.tick();
  assert.equal(lowCap.submitted.length, 0);
  assert.ok(lowCap.logs.some(row => row.event === 'mint_skipped' && /Gas 上限/.test(row.error)));
  const stale = fixture();
  stale.setLatestMinted(49n);
  await stale.tick();
  assert.equal(stale.submitted.length, 0);
  assert.ok(stale.logs.some(row => row.event === 'mint_skipped' && /重新计算开盘 Gas/.test(row.error)));
});

test('reports phase and whitelist changes without any minted lot changes', async () => {
  const f = fixture({ targetOverrides: { mintBatches: 0, autoClaim: false } });
  await f.tick();
  await f.next();
  f.snapshot.phase = 2;
  await f.next();
  f.snapshot.whitelistEnabled = true;
  await f.next();
  const updates = f.logs.filter(row => row.event === 'project');
  assert.deepEqual(updates.map(row => [row.phase, row.whitelistEnabled]), [[1, false], [2, false], [2, true]]);
});

test('CLI buy does not sign after quote reorg even when the launch block remains canonical', async () => {
  const launch = { blockNumber: 105, blockHash: '0x' + 'aa'.repeat(32), openingReserves };
  const initial = { number: 108, hash: '0x' + 'bb'.repeat(32), timestamp: 1000 };
  const canonical = { ...initial, hash: '0x' + 'cc'.repeat(32) };
  const reads = [], submitted = [], logs = [];
  let latest = 0;
  const tick = makeMonitor({
    provider: { async getBlock(tag) {
      reads.push(tag);
      if (tag === 'latest') return latest++ ? { ...canonical, number: 109, timestamp: 1001 } : initial;
      return tag === launch.blockNumber ? { number: tag, hash: launch.blockHash } : canonical;
    } },
    cfg: { targets: [{ ...target, buyOnLaunch: true, autoClaim: false, mintBatches: 0 }],
      snipe: snipeSettings },
    wallets, armBlock: 100, log: (event, row) => logs.push({ event, ...row }),
    execute: async job => { assert.equal(job.singleSubmission, true); await job.beforeSign(); submitted.push(job); },
    services: { inspectMint: async () => ({ launched: true }), findLaunch: async () => launch,
      readMarket: async () => marketQuote(), readOpeningBuyTax: async () => buyTax, verifyRoundTrip: async () => ({}) },
  });
  await tick();
  assert.deepEqual(submitted, []);
  assert.ok(reads.includes(initial.number));
  assert.ok(logs.some(row => row.event === 'buy_skipped' && /报价区块已变动/.test(row.error)));
});

test('CLI monitor consumes a proven launch once even if one selected wallet is refused', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  let latest = 103, quoteReads = 0;
  const launch = { blockNumber: 101, blockHash: hash, openingReserves };
  const calls = [];
  const tick = makeMonitor({
    provider: { async getBlock(tag) { return { number: tag === 'latest' ? latest : tag, timestamp: 1000, hash }; } },
    cfg: { targets: [{ ...target, buyOnLaunch: true, autoClaim: false, mintBatches: 0 }],
      snipe: { ...snipeSettings, walletCount: 2 } },
    wallets, armBlock: 100, log() {},
    execute: async job => {
      assert.equal(job.singleSubmission, true);
      await job.beforeSign();
      calls.push(job.wallet.address);
      if (job.wallet === wallets[0]) throw Object.assign(new Error('RPC refused'), { code: 'TRANSACTION_NOT_SUBMITTED' });
      return { status: 'failed', actionId: job.actionId, txHash: hash };
    },
    services: { inspectMint: async () => ({ launched: true }), findLaunch: async () => launch,
      readMarket: async () => { quoteReads++; return marketQuote(); }, readOpeningBuyTax: async () => buyTax,
      verifyRoundTrip: async (_provider, market) => {
        assert.equal(market.amountOutMin, requiredOut);
        assert.ok(market.reverseMin > marketQuote().reverseMin);
        return {};
      } },
  });
  await tick();
  latest++;
  await tick();
  assert.deepEqual(calls.sort(), addresses.slice(0, 2));
  assert.equal(quoteReads, 1);
});

test('CLI monitor skips a valid current quote that exceeds opening premium, without quoting again', async () => {
  const hash = '0x' + 'aa'.repeat(32);
  const launch = { blockNumber: 101, blockHash: hash, txHash: '0x' + 'bb'.repeat(32), openingReserves };
  const later = marketQuote({ reserveBnb: parseEther('7'), reserveToken: parseEther('3600000000') });
  assert.ok(discount(later.quoted, later.buyTax) < requiredOut);
  let head = 103, simulations = 0, submissions = 0;
  const reads = [], logs = [];
  const tick = makeMonitor({
    provider: { getBlock: async () => ({ number: head, hash, timestamp: 1000 }) },
    cfg: { targets: [{ ...target, buyOnLaunch: true, mintBatches: 0, autoClaim: false }], snipe: snipeSettings },
    wallets, armBlock: 100, log: (event, details) => logs.push({ event, ...details }),
    execute: async () => { submissions++; },
    services: {
      inspectMint: async () => ({ launched: true }), findLaunch: async () => launch,
      readMarket: async (_provider, _target, _state, _settings, block) => { reads.push(['quote', block.number]); return later; },
      readOpeningBuyTax: async (_provider, token, height) => { reads.push(['tax', token, height]); return buyTax; },
      verifyRoundTrip: async () => { simulations++; },
    },
  });
  await tick();
  head++;
  await tick();
  assert.deepEqual(reads, [['quote', 103], ['tax', target.token, 101]]);
  assert.equal(simulations, 0);
  assert.equal(submissions, 0);
  const skipped = logs.find(row => row.event === 'buy_skipped');
  assert.match(skipped?.error, /报价超过开盘价溢价上限/);
  assert.equal(skipped.launchTx, launch.txHash);
  assert.equal(skipped.openingNetOut, openingNetOut);
  assert.equal(skipped.openingAmountOutMin, requiredOut);
  assert.equal(skipped.quotedNetOut, discount(later.quoted, later.buyTax));
  assert.equal(skipped.maxOpeningPremiumBps, 1000);
});

test('CLI monitor fails closed on missing opening evidence or a preopen-only policy', async () => {
  for (const requirePreopen of [false, true]) {
    const logs = [];
    let quoteReads = 0, taxReads = 0, simulations = 0, submissions = 0;
    const tick = makeMonitor({
      provider: { getBlock: async () => ({ number: 103, timestamp: 1000 }) },
      cfg: { targets: [{ ...target, buyOnLaunch: true, mintBatches: 0, autoClaim: false }],
        snipe: { ...snipeSettings, requirePreopen } },
      wallets, armBlock: 100, log: (event, details) => logs.push({ event, ...details }),
      execute: async () => { submissions++; },
      services: {
        inspectMint: async () => ({ launched: true }), findLaunch: async () => ({ blockNumber: 101 }),
        readMarket: async () => { quoteReads++; return marketQuote(); },
        readOpeningBuyTax: async () => { taxReads++; return buyTax; },
        verifyRoundTrip: async () => { simulations++; },
      },
    });
    await tick();
    assert.equal(simulations, 0);
    assert.equal(submissions, 0);
    assert.equal(quoteReads, requirePreopen ? 0 : 1);
    assert.equal(taxReads, requirePreopen ? 0 : 1);
    assert.match(logs.find(row => row.event === 'buy_skipped')?.error,
      requirePreopen ? /不提交确认后买单/ : /未能核验初始池储备/);
  }
});

test('aborting a tick during inspection does not start new transaction analysis', async () => {
  const abort = new AbortController();
  let work = 0;
  const tick = makeMonitor({ provider: { getBlock: async () => ({ number: 108, timestamp: 1000 }) },
    cfg: { targets: [target] }, wallets, armBlock: 100, signal: abort.signal, log() {},
    execute: async () => { work++; },
    services: { inspectMint: async () => { abort.abort(); return { launched: true }; }, buildClaim: async () => { work++; } },
  });
  await tick();
  assert.equal(work, 0);
});
