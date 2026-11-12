import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, parseEther } from 'ethers';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeFastSnipe, prepareSnipe, resolveSnipeEndpoints, snipeWsUrl } from '../src/snipe.mjs';
import { buildBuy, marketLimits, v2Output, WBNB } from '../src/market.mjs';

const target = { mint: '0x0000000000000000000000000000000000000001', token: '0x0000000000000000000000000000000000000002' };
const pool = '0x0000000000000000000000000000000000000003';
const wallet = { address: '0x0000000000000000000000000000000000000004' };
const hash = '0x' + 'a'.repeat(64);
const txHash = '0x' + 'b'.repeat(64);
const tx = { to: pool, data: '0x12345678', value: 1n };
const openingReserves = { reserveBnb: 5_000n, reserveToken: 1_000_000n };
const candidate = { ...target, pool, source: 'ws', blockNumber: 101, blockHash: hash, txHash, openingReserves };
const settings = { windowBlocks: 15, deadlineSeconds: 12, walletCount: 1, scanMs: 350,
  amountIn: 100n, minLiquidity: 1000n, slippageBps: 1000, maxBuyTaxBps: 500, maxSellTaxBps: 500, maxPriceImpactBps: 1000 };
function snapshot(reserves = openingReserves) {
  const market = { ...reserves, pair: pool, quoted: v2Output(settings.amountIn, reserves.reserveBnb, reserves.reserveToken),
    buyTax: 300n, sellTax: 300n };
  return { ...market, ...marketLimits({ ...market, amountIn: settings.amountIn, settings }) };
}

function fixture(t, overrides = {}) {
  const controller = new AbortController();
  const logs = [];
  const block = { number: 101, hash, timestamp: 3000 };
  let feed, closed = false, sends = 0;
  const started = Promise.withResolvers();
  const execute = async job => {
    assert.equal(job.singleSubmission, true);
    overrides.onPreflight?.(job);
    await job.beforeSign();
    sends++;
    job.onBroadcast('send', { txHash, walletChecksMs: 17, preflightMs: 29, preflightOverlapped: true, signMs: 1 });
    job.onBroadcast('ack', { txHash });
    return overrides.afterSend?.(job) ?? { status: 'confirmed', actionId: job.actionId, txHash };
  };
  execute.reconcile = overrides.reconcile;
  execute.reconcilePending = overrides.reconcilePending;
  execute.prepare = overrides.prepare;
  execute.race = overrides.executeRace;
  execute.raceStatus = overrides.raceStatus;
  const run = makeFastSnipe({
    provider: overrides.provider ?? { getBlock: async () => block }, settings: overrides.settings ?? settings,
    prepared: { armBlock: 100, targets: [target], wallets: overrides.wallets ?? [wallet] },
    execute, signal: controller.signal, log: (event, details) => logs.push({ event, ...details }),
    services: {
      makeLaunchFeed: opts => {
        feed = opts;
        return { start: () => started.resolve(), close: async () => { closed = true; } };
      },
      verifyLaunchCandidate: overrides.proof ?? (async () => candidate),
      verifySnipeState: overrides.verifyState ?? (async () => {}),
      readOpeningBuyTax: overrides.openingTax ?? (async (_provider, token, height) => {
        assert.equal(token, target.token); assert.equal(height, 101); return 300n;
      }),
      readMarket: overrides.market ?? (async () => snapshot()),
      ...(overrides.combinedMarket ? { readSnipeMarket: overrides.combinedMarket } : {}),
      buildBuy: overrides.buildBuy ?? (() => tx),
      verifyRoundTrip: overrides.simulate ?? (async () => tx),
    },
  })();
  t.after(async () => { controller.abort(); await run; assert.ok(closed); });
  return { started: started.promise, candidate: c => feed.onCandidate(c), remove: c => feed.onRemoved(c), logs, sends: () => sends };
}

const address = n => '0x' + n.toString(16).padStart(40, '0');
async function eventually(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= end) assert.fail('expected receipt reconciliation');
    await sleep(10);
  }
}

test('confirmed replay rejects an inflated quote before building, simulating or executing', async t => {
  const incidentSettings = { ...settings, amountIn: parseEther('0.1') };
  const seed = { reserveBnb: parseEther('5.5'), reserveToken: parseEther('2000000000') };
  const quote = { pair: pool, reserveBnb: parseEther('8.2'),
    reserveToken: parseEther('1350000000'), buyTax: 300n, sellTax: 300n };
  quote.quoted = v2Output(incidentSettings.amountIn, quote.reserveBnb, quote.reserveToken);
  const f = fixture(t, { settings: incidentSettings, proof: async () => ({ ...candidate, openingReserves: seed }),
    market: async () => ({ ...quote, ...marketLimits({ ...quote, amountIn: incidentSettings.amountIn, settings: incidentSettings }) }),
    buildBuy: () => assert.fail('overpriced order must never be constructed'),
    simulate: async () => assert.fail('overpriced order must never be simulated') });
  await f.started;
  await f.candidate(candidate);
  await f.candidate({ ...candidate, source: 'http' });
  assert.equal(f.sends(), 0);
  const [row, extra] = f.logs.filter(x => x.event === 'buy_skipped');
  assert.equal(extra, undefined);
  assert.match(row.error, /超过开盘价溢价上限/);
  assert.equal(row.openingNetOut, parseEther('34557792.758605294879235679'));
  assert.equal(row.quotedNetOut, parseEther('15738139.703003102503087441'));
  assert.equal(row.openingAmountOutMin, parseEther('31416175.235095722617486981'));
});

test('verified opening guard is encoded in the signed order, and missing opening proof fails closed', async t => {
  const abi = new Interface(['function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)']);
  const f = fixture(t, { settings: { ...settings, maxOpeningPremiumBps: 0 },
    market: async () => ({ ...snapshot(), path: [WBNB, target.token] }),
    buildBuy, simulate: async (_p, _m, _wallet, _settings, _block, { buyTx }) => buyTx,
    onPreflight({ tx }) {
      assert.equal(abi.decodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', tx.data)[0],
        snapshot().quoted * 9700n / 10_000n);
    },
  });
  const noSeed = fixture(t, { proof: async () => ({ ...candidate, openingReserves: undefined }),
    buildBuy: () => assert.fail('unverified opening reserves must not reach buy construction') });
  await Promise.all([f.started, noSeed.started]);
  await Promise.all([f.candidate(candidate), noSeed.candidate(candidate)]);
  assert.equal(f.sends(), 1);
  assert.equal(noSeed.sends(), 0);
  assert.match(noSeed.logs.at(-1).error, /未能核验初始池储备/);
});

test('no-chase mode refuses confirmed fallback without quoting, preparing or submitting', async t => {
  const f = fixture(t, { settings: { ...settings, repeatAttempts: 3, requirePreopen: true },
    prepare: () => assert.fail('no confirmed preparation'),
    market: async () => assert.fail('no confirmed market read'),
    openingTax: async () => assert.fail('no confirmed tax read'),
    executeRace: async () => assert.fail('no confirmed execution'),
    raceStatus: async () => assert.fail('nothing to reconcile') });
  await f.started;
  await f.candidate(candidate);
  assert.equal(f.sends(), 0);
  assert.match(f.logs.at(-1).error, /不提交确认后买单/);
});

test('verified receipt and pinned market reads overlap, then simulation overlaps preflight', async t => {
  const proof = Promise.withResolvers(), marketStarted = Promise.withResolvers();
  const sim = Promise.withResolvers(), preflight = Promise.withResolvers();
  const f = fixture(t, {
    proof: () => proof.promise,
    market: async () => { marketStarted.resolve(); return snapshot(); },
    simulate: () => sim.promise, onPreflight: () => preflight.resolve(),
  });
  await f.started;
  const action = f.candidate(candidate);
  await marketStarted.promise;
  assert.equal(f.sends(), 0);
  proof.resolve(candidate);
  await preflight.promise;
  assert.equal(f.sends(), 0);
  sim.resolve(tx);
  await action;
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.logs.map(row => row.event), ['snipe_detected', 'snipe_send', 'snipe_ack', 'buy']);
  assert.ok(f.logs[2].elapsedMs >= f.logs[2].quoteMs);
  await f.candidate({ ...candidate, source: 'http' });
  assert.equal(f.sends(), 1);
});

test('candidate overlaps wallet preparation with proof and aggregated quote, retains the exact promise and one-shot guard', async t => {
  const proof = Promise.withResolvers(), quoteStarted = Promise.withResolvers(), warm = Promise.withResolvers();
  let prepareCount = 0;
  const f = fixture(t, {
    prepare(input) {
      prepareCount++;
      assert.equal(input.wallet, wallet);
      assert.ok(input.signal instanceof AbortSignal);
      return warm.promise;
    },
    proof() { assert.equal(prepareCount, 1); return proof.promise; },
    combinedMarket(_p, selected, address, suppliedSettings, block) {
      assert.equal(prepareCount, 1);
      assert.equal(selected, target);
      assert.equal(address, pool);
      assert.equal(suppliedSettings, settings);
      assert.equal(block.number, candidate.blockNumber);
      quoteStarted.resolve();
      return snapshot();
    },
    market() { assert.fail('combined reader owns fallback'); },
    verifyState() { assert.fail('combined reader owns state verification'); },
    onPreflight(job) { assert.equal(job.preparedWallet, warm.promise); },
  });
  t.after(() => { warm.resolve(null); proof.resolve(candidate); });
  await f.started;
  const action = f.candidate(candidate);
  await quoteStarted.promise;
  assert.equal(f.sends(), 0);
  warm.resolve({ opaque: true });
  proof.resolve(candidate);
  await action;
  const submit = f.logs.find(row => row.event === 'snipe_send');
  assert.ok(submit);
  for (const name of ['proofMs', 'headMs', 'marketMs', 'walletPrepMs', 'simulationMs', 'snapshotMs',
    'walletChecksMs', 'preflightMs', 'signMs']) assert.ok(Number.isFinite(submit[name]), name);
  assert.equal(submit.preflightOverlapped, true);
  assert.equal(f.logs.find(row => row.event === 'snipe_ack').walletChecksMs, 17);
  await f.candidate({ ...candidate, source: 'http' });
  assert.equal(f.sends(), 1);
  assert.equal(prepareCount, 1);
});

test('wallet preparation failure is observed without rearming a submission or removing fresh executor checks', async t => {
  let prepareCount = 0;
  const failure = Promise.reject(new Error('optional read failed'));
  const f = fixture(t, {
    prepare() { prepareCount++; return failure; },
    onPreflight(job) { assert.equal(job.preparedWallet, failure); },
  });
  await f.started;
  await f.candidate(candidate);
  await f.candidate(candidate);
  assert.equal(prepareCount, 1);
  assert.equal(f.sends(), 1);
});

test('failed round trip, unarmed old launch, and unknown targets never send', async t => {
  const f = fixture(t, { simulate: async () => { throw new Error('no sale'); } });
  await f.started;
  await f.candidate({ ...candidate, blockNumber: 100 });
  await f.candidate({ ...candidate, token: pool });
  assert.equal(f.logs.length, 0);
  await f.candidate(candidate);
  assert.equal(f.sends(), 0);
  assert.ok(f.logs.some(row => row.event === 'buy_skipped' && row.error === 'no sale'));
});

test('one chance per wallet even on transient or deterministic preflight failure', async t => {
  const flaky = { address: address(5) }, rejected = { address: address(6) };
  const attempts = new Map();
  const f = fixture(t, { wallets: [wallet, flaky, rejected], simulate: async (_, __, account) => {
    const tries = (attempts.get(account) ?? 0) + 1;
    attempts.set(account, tries);
    if (account === flaky.address && tries === 1) throw Object.assign(new Error('temporarily unavailable'), { code: 'TIMEOUT' });
    if (account === rejected.address) throw new Error('买入→授权→卖出模拟未全部通过；已跳过，不会发单');
    return tx;
  }, afterSend: job => ({ status: job.wallet === wallet ? 'pending' : 'confirmed', actionId: job.actionId, txHash }) });
  await f.started;
  assert.notEqual(await f.candidate(candidate), false);
  assert.equal(f.sends(), 1);
  assert.notEqual(await f.candidate({ ...candidate, source: 'http' }), false);
  assert.equal(f.sends(), 1);
  await f.candidate(candidate);
  assert.equal(f.sends(), 1);
  assert.deepEqual([...attempts.entries()], [[wallet.address, 1], [flaky.address, 1], [rejected.address, 1]]);
});

test('errors after broadcast attempt are never retried, even if the executor proved non-submission', async t => {
  const unknown = fixture(t, { afterSend() { throw Object.assign(new Error('transport disconnected'), { code: 'NETWORK_ERROR' }); } });
  await unknown.started;
  assert.notEqual(await unknown.candidate(candidate), false);
  await unknown.candidate(candidate);
  assert.equal(unknown.sends(), 1);
  assert.ok(unknown.logs.some(row => row.event === 'buy' && row.status === 'pending'));

  const refused = fixture(t, { afterSend() {
    throw Object.assign(new Error('one send route refused before processing'), { code: 'TRANSACTION_NOT_SUBMITTED' });
  } });
  await refused.started;
  assert.notEqual(await refused.candidate(candidate), false);
  await refused.candidate({ ...candidate, blockHash: txHash, txHash: hash });
  assert.equal(refused.sends(), 1, 'another inclusion cannot re-arm a spent opportunity');
  assert.ok(refused.logs.some(row => row.event === 'buy_skipped'));
});

test('receipt discovery may recover before the first opportunity, but a verified launch with a failed quote is terminal', async t => {
  let proofs = 0, quotes = 0;
  const f = fixture(t, {
    proof() {
      if (++proofs === 1) throw Object.assign(new Error('RPC failed to index launch receipt'), { code: 'TIMEOUT' });
      return candidate;
    },
    market() {
      if (++quotes > 1) throw Object.assign(new Error('quote RPC unavailable'), { code: 'TIMEOUT' });
      return snapshot();
    },
  });
  await f.started;
  assert.equal(await f.candidate(candidate), false, 'no canonical receipt and no buying attempt yet');
  assert.notEqual(await f.candidate({ ...candidate, source: 'http' }), false);
  await f.candidate(candidate);
  assert.equal(proofs, 2);
  assert.equal(quotes, 2);
  assert.equal(f.sends(), 0);
  const skipped = f.logs.find(row => row.event === 'buy_skipped');
  assert.ok(skipped);
  assert.ok(Number.isFinite(skipped.marketMs));
  assert.ok(Number.isFinite(skipped.quoteMs));
});

test('an immature buy that reorgs changes to pending without a new broadcast', async t => {
  let status;
  const result = (state, id) => ({ status: state, actionId: id, txHash, receiptStable: false, receiptBlock: 101 });
  const f = fixture(t, { reconcile: async id => status ? result(status, id) : null, afterSend: job => {
    status = 'pending'; // Simulate a reorg before the background canonical check.
    return result('confirmed', job.actionId);
  } });
  await f.started;
  await f.candidate(candidate);
  await eventually(() => f.logs.some(row => row.event === 'buy' && row.status === 'pending'));
  assert.deepEqual(f.logs.filter(row => row.event === 'buy').map(row => row.status), ['confirmed', 'pending']);
  await f.candidate(candidate);
  assert.equal(f.sends(), 1);
});

test('a removed WSS inclusion or changed canonical block cannot pass pre-sign', async t => {
  const sim = Promise.withResolvers(), preflight = Promise.withResolvers();
  const f = fixture(t, { simulate: () => sim.promise, onPreflight: () => preflight.resolve() });
  await f.started;
  const action = f.candidate(candidate);
  await preflight.promise;
  f.remove(candidate);
  sim.resolve(tx);
  await action;
  assert.equal(f.sends(), 0);
  const stale = fixture(t, { provider: { getBlock: async tag => ({ number: 101, hash: tag === 'latest' ? hash : txHash, timestamp: 3000 }) } });
  await stale.started;
  await stale.candidate(candidate);
  assert.equal(stale.sends(), 0);
});

test('pre-arming filters already launched targets and checks simulation capability', async () => {
  let probed = 0;
  const cfg = { targets: [target, { ...target, mint: pool }], snipe: settings, rpcUrl: 'https://bsc-rpc.publicnode.com' };
  const options = { provider: { getBlock: async () => ({ number: 100 }) }, cfg, wallets: [wallet], log() {},
    signal: new AbortController().signal, services: { inspectMint: async (_p, t) => ({ launched: t.mint === pool }),
      probeSimulation: async (_p, height) => { probed++; assert.equal(height, 100); } } };
  const prepared = await prepareSnipe({ ...options, watchProvider: { getBlockNumber: async () => 101 } });
  assert.deepEqual(prepared.targets, [target]);
  assert.equal(prepared.armBlock, 101);
  assert.equal(probed, 1);
  assert.equal(snipeWsUrl('https://custom.invalid/rpc', ''), undefined);
  assert.throws(() => snipeWsUrl('https://custom.invalid/rpc', 'https://wrong.invalid/'));
  assert.equal(snipeWsUrl(cfg.rpcUrl, ''), 'wss://bsc-rpc.publicnode.com');
  assert.deepEqual(resolveSnipeEndpoints(cfg.rpcUrl, {}), { watchUrl: cfg.rpcUrl,
    executionUrl: 'https://bsc-dataseed.bnbchain.org', wsUrl: 'wss://bsc-rpc.publicnode.com' });
  assert.deepEqual(resolveSnipeEndpoints(cfg.rpcUrl, {
    BSC_WATCH_RPC_URL: 'https://watch.invalid', BSC_SNIPE_RPC_URL: 'https://execute.invalid', BSC_WSS_URL: 'wss://watch.invalid',
  }), { watchUrl: 'https://watch.invalid', executionUrl: 'https://execute.invalid', wsUrl: 'wss://watch.invalid' });
  await assert.rejects(prepareSnipe({ ...options, services: { ...options.services, inspectMint: async () => ({ launched: true }) } }), /尚未开盘/);
});

test('arming starts aggregate capability probe before it finishes without waiting for it', async () => {
  const warm = Promise.withResolvers(), began = Promise.withResolvers();
  const cfg = { targets: [target], snipe: settings, rpcUrl: 'https://bsc-rpc.publicnode.com' };
  const head = { number: 100 };
  try {
    const prepared = await prepareSnipe({ provider: { getBlock: async () => head }, cfg, wallets: [wallet], log() {},
      signal: new AbortController().signal, services: { inspectMint: async () => ({ launched: false }),
        probeSimulation: async () => {}, warmSnipeMarket(_p, block) {
          assert.equal(block, head);
          began.resolve();
          return warm.promise;
        } } });
    await began.promise;
    assert.equal(prepared.armBlock, 100);
  } finally { warm.resolve(false); }
});
