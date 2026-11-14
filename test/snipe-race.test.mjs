import test from 'node:test';
import assert from 'node:assert/strict';
import { toQuantity } from 'ethers';
import { CORLA_ABI } from '../src/corla.mjs';
import { FACTORY } from '../src/config.mjs';
import { actionId } from '../src/monitor.mjs';
import { makeSnipeRace, SNIPE_RACE_WINDOW_MS } from '../src/snipe-race.mjs';

const target = { factory: FACTORY, mint: '0x' + '12'.repeat(20), token: '0x' + '34'.repeat(20), pricePerLot: 10n };
const wallet = { address: '0x' + '56'.repeat(20) };
const hash = '0x' + 'ab'.repeat(32);
const prepared = { armBlock: 100, wallets: [wallet], pendingTargets: [target] };
const tx = { to: '0x' + '57'.repeat(20), data: '0x98765432', value: 12n };
const job = { actionId: actionId('buy', target), wallet, tx, beforeSign() {} };
const pendingMint = (txHash = hash) => ({ hash: txHash, from: wallet.address, to: target.mint,
  value: toQuantity(target.pricePerLot), input: CORLA_ABI.encodeFunctionData('mint', [[]]) });
const testHead = { number: 100, hash, timestamp: 500 };
const testPlan = { tx, gasEstimate: 25_000n, quoteBlock: 100, quoteBlockHash: hash, deadline: 515 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = (attempt, status) => ({ actionId: job.actionId, attempt, attemptActionId: job.actionId + ':' + attempt,
  ...(status === 'pending' ? { txHash: hash } : {}), status });

function setup({ execute, raceServices = {}, provider = {}, repeatAttempts = 3, requirePreopen = false }) {
  const abort = new AbortController();
  const rows = [];
  let time = 1_000;
  let feed;
  const race = makeSnipeRace({ provider, prepared, settings: { repeatAttempts, requirePreopen }, execute, signal: abort.signal,
    log: (event, fields) => rows.push({ event, ...fields }), services: {
      nowMs: () => time, delay: async ms => { time += ms; },
      makePendingTransactionFeed(options) {
        feed = options;
        return { start: () => options.onStatus({ mode: 'full' }), close() {} };
      }, ...raceServices,
    } });
  return { race, rows, feed: () => feed, time: () => time, abort };
}

test('confirmed competition reuses the exact order, advances only on reverted receipt, and stops on success', async () => {
  const sent = [];
  const { race, rows } = setup({ execute: {
    async race(request) {
      sent.push(request);
      request.onBroadcast('send', { txHash: hash });
      return sent.length === 1 ? result(1, 'pending') : result(2, 'confirmed');
    },
    async raceStatus() { return result(1, 'failed'); },
  } });
  const final = await race.runConfirmed({ target, wallet, request: job, details: {} });
  assert.equal(final.status, 'confirmed');
  assert.equal(sent.length, 2);
  assert.ok(sent.every(request => request.tx === tx && request.maxAttempts === 3));
  assert.deepEqual(rows.filter(row => row.event === 'snipe_race_outcome').map(row => row.status),
    ['pending', 'failed', 'confirmed']);
  assert.equal(await race.runConfirmed({ target, wallet, request: job, details: {} }), null);
  await race.close();
});

test('an unresolved send never creates another order even when receipt polling runs out', async () => {
  let sent = 0;
  const { race } = setup({ execute: {
    async race() { sent++; return result(1, 'pending'); },
    async raceStatus() { return result(1, 'pending'); },
  } });
  assert.equal((await race.runConfirmed({ target, wallet, request: job, details: {} })).status, 'pending');
  assert.equal(sent, 1);
  await race.close();
});

test('the retry window controls when a new round starts, not when in-flight work ends', async () => {
  for (const offset of [SNIPE_RACE_WINDOW_MS - 1, SNIPE_RACE_WINDOW_MS]) {
    let sent = 0;
    let now = 100;
    const { race } = setup({ repeatAttempts: 5, raceServices: { nowMs: () => now }, execute: {
      async race() {
        if (++sent > 1) return result(2, 'confirmed');
        now += offset;
        return result(1, 'failed');
      },
      async raceStatus() { assert.fail('already reconciled by the executor stub'); },
    } });
    // The stub has already reconciled the first receipt, so no poll is needed.
    const final = await race.runConfirmed({ target, wallet, request: job, details: {} });
    assert.equal(sent, offset < SNIPE_RACE_WINDOW_MS ? 2 : 1);
    assert.equal(final.status, sent === 2 ? 'confirmed' : 'failed');
    await race.close();
  }
});

test('a 35-second wait at the penultimate lot uses zero rounds; the final Mint may use more than five', async () => {
  const finished = Promise.withResolvers();
  const finalHash = '0x' + 'bc'.repeat(32);
  let now = 1_000, sent = 0;
  const lookedAt = [];
  const { race, rows, feed } = setup({
    requirePreopen: true, repeatAttempts: 8, provider: { getBlock: async () => testHead },
    raceServices: { nowMs: () => now, async buildPreopenBuyPlan(_provider, _target, pending) {
      lookedAt.push(pending.hash);
      if (pending.hash === hash) throw new Error('still two lots short in parent');
      return { ...testPlan, pendingHash: pending.hash };
    } },
    execute: {
      async race(request) {
        await request.beforeSign();
        request.beforeDispatch();
        request.onBroadcast('send', { txHash: hash, attempt: ++sent });
        now += 80;
        if (sent === 8) finished.resolve();
        return result(sent, sent === 8 ? 'confirmed' : 'failed');
      },
      async raceStatus() { assert.fail('the stub already returned the reconciled result'); },
    },
  });
  try {
    race.start();
    feed().onTransaction(pendingMint());
    await tick();
    assert.equal(sent, 0);
    now += 35_000;
    feed().onTransaction(pendingMint(finalHash));
    await finished.promise;
    await tick();
    assert.deepEqual(lookedAt, [hash, finalHash]);
    assert.deepEqual(rows.filter(row => row.event === 'snipe_race_attempt').map(row => row.attempt),
      [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(rows.find(row => row.event === 'snipe_race_mode').pendingTxHash, finalHash);
  } finally { await race.close(); }
});

test('a new Mint arriving during a previous read is kept unless stale or canonical launch intervenes', async () => {
  for (const scenario of ['queued', 'stale', 'opened']) {
    const firstPlan = Promise.withResolvers();
    const finalHash = '0x' + 'bc'.repeat(32);
    let sent = 0, now = 1_000;
    const checked = [];
    const { race, feed } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead },
      raceServices: { nowMs: () => now, async buildPreopenBuyPlan(_p, _target, pending) {
        checked.push(pending.hash);
        if (pending.hash === hash) {
          await firstPlan.promise;
          throw new Error('earlier Mint did not fill');
        }
        return { ...testPlan, pendingHash: finalHash };
      } },
      execute: { async race(req) {
        await req.beforeSign();
        sent++;
        return result(1, 'confirmed');
      }, async raceStatus() { assert.fail('no receipt polling expected'); } },
    });
    try {
      race.start();
      feed().onTransaction(pendingMint());
      await tick();
      now += 50;
      feed().onTransaction(pendingMint(finalHash)); // originally dropped by work/cooldown
      feed().onTransaction(pendingMint(finalHash));
      if (scenario === 'stale') now += 3_000;
      if (scenario === 'opened') race.noteConfirmed({ ...target, txHash: finalHash, blockNumber: 101, source: 'ws' }, now + 5);
      firstPlan.resolve();
      await tick();
      assert.deepEqual(checked, scenario === 'queued' ? [hash, finalHash] : [hash]);
      assert.equal(sent, scenario === 'queued' ? 1 : 0);
    } finally { firstPlan.resolve(); await race.close(); }
  }
});

test('a slow pre-sign check does not open a round after the retry deadline', async () => {
  let now = 1_000;
  let sent = 0;
  const { race } = setup({ raceServices: { nowMs: () => now }, execute: {
    async race(request) {
      await request.beforeSign();
      sent++;
      return result(1, 'confirmed');
    },
    async raceStatus() { assert.fail('no order was sent'); },
  } });
  try {
    await assert.rejects(race.runConfirmed({ target, wallet,
      request: { ...job, beforeSign() { now += SNIPE_RACE_WINDOW_MS; } }, details: {} }), /发单窗口已结束/);
    assert.equal(sent, 0);
  } finally { await race.close(); }
});

test('a verified pending plan owns the order, and the opening comparison matches the exact pending hash', async () => {
  const seen = Promise.withResolvers();
  const head = { number: 100, hash, timestamp: 500 };
  const plan = { tx, pendingHash: hash, gasEstimate: 25_000n, quoteBlock: 100, quoteBlockHash: hash, deadline: 515 };
  const { race, rows, feed, time } = setup({
    provider: { getBlock: async () => head },
    raceServices: { buildPreopenBuyPlan: async () => plan },
    execute: {
      async race(request) {
        assert.equal(request.preopenPlan, plan);
        assert.equal(request.tx, tx);
        assert.equal(request.gasEstimate, 25_000n);
        await request.beforeSign();
        seen.resolve();
        return result(1, 'confirmed');
      },
      async raceStatus() { throw new Error('Confirmed result is terminal'); },
    },
  });
  race.start();
  const candidate = { hash, from: wallet.address, to: target.mint, value: toQuantity(target.pricePerLot),
    input: CORLA_ABI.encodeFunctionData('mint', [[]]) };
  const receivedAtMs = 1_794_626_238_617;
  feed().onTransaction(candidate, { receivedAtMs, seen: time() - 1, mode: 'full' });
  feed().onTransaction(candidate, { receivedAtMs: receivedAtMs + 20, seen: time(), mode: 'mixed' });
  await seen.promise;
  assert.equal(await race.runConfirmed({ target, wallet, request: job, details: {} }), null);
  race.noteConfirmed({ ...target, txHash: hash, blockNumber: 101, source: 'ws' }, time() + 42);
  const row = rows.find(row => row.event === 'snipe_pending_match');
  assert.equal(row.matchedPending, true);
  assert.equal(row.leadMs, 43);
  assert.equal(row.pendingReceivedAtMs, receivedAtMs);
  const captured = rows.filter(row => row.event === 'snipe_pending');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].pendingReceivedAtMs, receivedAtMs);
  assert.equal(captured[0].pendingMode, 'full');
  await race.close();
});

test('strict early-only mode blocks new pending signatures once the token is deployed or launch is verified', async () => {
  for (const canonicalSignal of [false, true]) {
    const head = { number: 100, hash, timestamp: 500 };
    const preflight = Promise.withResolvers();
    const checked = Promise.withResolvers();
    let rejection;
    const plan = { tx, pendingHash: hash, gasEstimate: 25_000n, quoteBlock: 100, quoteBlockHash: hash, deadline: 515 };
    let codeCalls = 0;
    const { race, feed } = setup({ requirePreopen: true, raceServices: { buildPreopenBuyPlan: async () => plan },
      provider: { getBlock: async tag => tag === 'latest' ? { ...head, number: 101 } : head,
        getCode: async () => { codeCalls++; return '0x01'; }, call: async () => assert.fail('must not simulate a late entry') },
      execute: { async race(request) {
        preflight.resolve();
        await checked.promise;
        try { await request.beforeSign(); } catch (error) { rejection = error; }
        return result(0, 'skipped');
      }, async raceStatus() { assert.fail('nothing was submitted'); } },
    });
    race.start();
    feed().onTransaction({ hash, from: wallet.address, to: target.mint, value: toQuantity(target.pricePerLot),
      input: CORLA_ABI.encodeFunctionData('mint', [[]]) });
    await preflight.promise;
    if (canonicalSignal) race.noteConfirmed({ ...target, txHash: hash, blockNumber: 101, source: 'ws' }, 1020);
    checked.resolve();
    await tick();
    await race.close();
    assert.match(rejection?.message ?? '', /不继续提交/);
    assert.equal(codeCalls, canonicalSignal ? 0 : 1);
  }
});
