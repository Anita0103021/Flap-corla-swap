import test from 'node:test';
import assert from 'node:assert/strict';
import { toQuantity } from 'ethers';
import { CORLA_ABI } from '../src/corla.mjs';
import { FACTORY } from '../src/config.mjs';
import { actionId } from '../src/monitor.mjs';
import { makeSnipeRace } from '../src/snipe-race.mjs';

const target = { factory: FACTORY, mint: '0x' + '12'.repeat(20), token: '0x' + '34'.repeat(20), pricePerLot: 10n };
const wallet = { address: '0x' + '56'.repeat(20) };
const hash = '0x' + 'ab'.repeat(32);
const prepared = { armBlock: 100, wallets: [wallet], pendingTargets: [target] };
const tx = { to: '0x' + '57'.repeat(20), data: '0x98765432', value: 12n };
const job = { actionId: actionId('buy', target), wallet, tx, beforeSign() {} };
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
  feed().onTransaction(candidate);
  await seen.promise;
  assert.equal(await race.runConfirmed({ target, wallet, request: job, details: {} }), null);
  race.noteConfirmed({ ...target, txHash: hash, blockNumber: 101, source: 'ws' }, time() + 42);
  const row = rows.find(row => row.event === 'snipe_pending_match');
  assert.equal(row.matchedPending, true);
  assert.equal(row.leadMs, 42);
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
    await race.close();
    assert.match(rejection?.message ?? '', /不继续提交/);
    assert.equal(codeCalls, canonicalSignal ? 0 : 1);
  }
});
