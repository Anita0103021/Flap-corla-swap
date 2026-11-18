import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Wallet, toQuantity } from 'ethers';
import { CORLA_ABI } from '../src/corla.mjs';
import { FACTORY } from '../src/config.mjs';
import { actionId } from '../src/monitor.mjs';
import { makeSnipeRace, SNIPE_RACE_WINDOW_MS } from '../src/snipe-race.mjs';
import { PreopenMintWait } from '../src/snipe-preopen.mjs';
import { hasReproducibleBscEnvelope } from '../src/snipe-pending-compare.mjs';

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
const minter = Wallet.createRandom();
async function signedPending(overrides = {}, signer = minter) {
  const signed = Transaction.from(await signer.signTransaction({ chainId: 56, type: 0, nonce: 7,
    to: target.mint, value: target.pricePerLot, gasLimit: 100_000n, gasPrice: 100_000_000n,
    data: CORLA_ABI.encodeFunctionData('mint', [[]]), ...overrides }));
  return { hash: signed.hash, from: signed.from, to: signed.to, input: signed.data, value: toQuantity(signed.value),
    type: '0x0', nonce: toQuantity(signed.nonce), gas: toQuantity(signed.gasLimit), gasPrice: toQuantity(signed.gasPrice),
    v: toQuantity(signed.signature.networkV), r: signed.signature.r, s: signed.signature.s, blockNumber: null };
}

function setup({ execute, raceServices = {}, provider = {}, repeatAttempts = 3, requirePreopen = false,
  pendingWsUrl = 'wss://primary.example.invalid/', pendingWsBackupUrls = [], pendingTargets = prepared.pendingTargets }) {
  const abort = new AbortController();
  const rows = [];
  let time = 1_000;
  const feeds = [];
  const race = makeSnipeRace({ provider, prepared: { ...prepared, pendingTargets, pendingWsUrl, pendingWsBackupUrls }, settings: { repeatAttempts, requirePreopen }, execute, signal: abort.signal,
    log: (event, fields) => rows.push({ event, ...fields }), services: {
      nowMs: () => time, delay: async ms => { time += ms; },
      // Existing race-control fixtures deliberately omit signed envelopes.
      // Real signature/path poisoning tests below explicitly use the validator.
      hasReproducibleBscEnvelope: () => true,
      async preparePreopenMintSequence(_p, _t, candidates, _settings, head) {
        const latest = candidates().at(-1);
        if (!latest) throw new PreopenMintWait('waiting_pending', {});
        return { pendingHashes: [latest.hash], quoteBlock: head.number };
      },
      makePendingTransactionFeed(options) {
        feeds.push(options);
        return { start: () => options.onStatus({ mode: 'full' }), close() {} };
      }, ...raceServices,
    } });
  return { race, rows, feed: (i = 0) => feeds[i], time: () => time, abort };
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
      const id = pending.pendingHashes.at(-1);
      lookedAt.push(id);
      if (id === hash) throw new Error('still two lots short in parent');
      return { ...testPlan, pendingHash: id };
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
        const id = pending.pendingHashes.at(-1);
        checked.push(id);
        if (id === hash) {
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

test('a 47/50 parent can use 3 fresh candidates from independent WSS feeds without waiting for 49/50 on chain', async () => {
  const sent = Promise.withResolvers(), snapshot = Promise.withResolvers();
  let checks = 0;
  const tail = [hash, '0x' + 'bc'.repeat(32), '0x' + 'cd'.repeat(32)];
  const { race, rows, feed, time } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead },
    pendingWsBackupUrls: ['wss://backup.example.invalid/ws'],
    raceServices: {
      async preparePreopenMintSequence(_p, _t, read) {
        checks++;
        await snapshot.promise;
        return { mintedLots: 47n, totalLots: 50n, remainingLots: 3n, pendingCandidateCount: 3, quoteBlock: 100,
          pendingHashes: read().map(tx => tx.hash) };
      },
      async buildPreopenBuyPlan(_p, _t, sequence) {
        assert.deepEqual(sequence.pendingHashes, tail);
        return { ...testPlan, pendingHash: tail[2] };
      },
    },
    execute: {
      async race(request) {
        await request.beforeSign();
        request.beforeDispatch();
        request.onBroadcast('send', { txHash: hash });
        sent.resolve();
        return result(1, 'confirmed');
      },
      async raceStatus() { assert.fail('no extra wallet order expected'); },
    },
  });
  try {
    race.start();
    feed(0).onTransaction(pendingMint(tail[0]), { seen: time(), receivedAtMs: 10 });
    await tick();
    feed(1).onTransaction(pendingMint(tail[1]), { seen: time() + 1, receivedAtMs: 11 });
    feed(0).onTransaction(pendingMint(tail[1]), { seen: time() + 2, receivedAtMs: 12 });
    feed(1).onTransaction(pendingMint(tail[2]), { seen: time() + 3, receivedAtMs: 13 });
    snapshot.resolve();
    await Promise.race([sent.promise, tick().then(tick)]);
    assert.equal(checks, 1);
    assert.deepEqual(rows.filter(r => r.event === 'snipe_pending').map(r => r.pendingSource), [1, 2, 2]);
    const [submission] = rows.filter(r => r.event === 'snipe_send');
    assert.deepEqual(submission?.pendingHashes, tail);
    race.noteConfirmed({ ...target, blockNumber: 101, txHash: tail[2], source: 'ws' }, time() + 40);
    assert.equal(rows.find(r => r.event === 'snipe_pending_match').pendingSource, 2);
  } finally { snapshot.resolve(); await race.close(); }
});

test('a launch signal pauses the strict early-only path before the receipt lookup completes', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let signed = 0, reason;
  const { race, feed } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead },
    raceServices: { buildPreopenBuyPlan: async () => testPlan },
    execute: {
      async race(request) {
        entered.resolve();
        await release.promise;
        try { await request.beforeSign(); request.beforeDispatch(); signed++; }
        catch (e) { reason = e.message; }
        return result(0, 'skipped');
      },
      async raceStatus() { assert.fail('no order shall be watched'); },
    },
  });
  try {
    race.start();
    feed().onTransaction(pendingMint());
    try {
      await entered.promise;
      race.noteLaunchSignal({ ...target, blockNumber: 101, txHash: hash, blockHash: hash });
    } finally { release.resolve(); }
    await tick();
    assert.equal(signed, 0);
    assert.match(reason, /收到开盘信号/);
  } finally { release.resolve(); await race.close(); }
});

test('receipt verification retries do not turn a late WSS pending frame into early coverage', async () => {
  let now = 1000;
  const { race, rows, feed } = setup({ repeatAttempts: 1, execute: {}, raceServices: { nowMs: () => now } });
  try {
    race.start();
    const opened = { ...target, blockNumber: 101, txHash: hash, blockHash: hash, source: 'ws' };
    assert.equal(race.noteLaunchSignal(opened, 1000).first, true);
    now = 1010;
    feed().onTransaction(pendingMint(), { seen: 1010, receivedAtMs: 20 });
    assert.deepEqual(race.noteLaunchSignal({ ...opened, source: 'http' }, 1100), { seen: 1000, source: 'ws', first: false });
    race.noteConfirmed({ ...opened, source: 'http' }, 1100);
    const row = rows.find(entry => entry.event === 'snipe_pending_match');
    assert.equal(row.matchedPending, false);
    assert.equal(row.source, 'ws');
    assert.equal(row.leadMs, undefined);
  } finally { await race.close(); }
});

test('an invalid primary leaves a healthy backup active and diagnostics never expose node addresses', async () => {
  const { race, feed, rows } = setup({ repeatAttempts: 1, execute: {},
    pendingWsUrl: 'https://invalid.example/fixture-secret', pendingWsBackupUrls: ['wss://valid.example/fixture-secret'] });
  try {
    race.start();
    assert.equal(feed().wsUrl, 'wss://valid.example/fixture-secret');
    assert.equal(feed(1), undefined);
    feed().onStatus({ mode: 'full', healthy: true, hasFullPayload: true, pendingLastFullAtMs: 2030 });
    const status = race.pendingHealth();
    assert.deepEqual(status.sources.map(row => [row.source, row.mode, row.healthy]), [[1, 'invalid_config', false], [2, 'full', true]]);
    feed().onTransaction(pendingMint(), { seen: 1_000, receivedAtMs: 2_030, mode: 'full' });
    assert.equal(rows.find(row => row.event === 'snipe_pending').pendingSource, 2);
    assert.ok(!JSON.stringify([status, rows]).includes('fixture-secret'));
  } finally { await race.close(); }
});

test('opening telemetry keeps the pending outage at first discovery even if WSS recovers before receipt verification', async () => {
  const { race, rows, feed } = setup({ repeatAttempts: 1, execute: {} });
  try {
    race.start();
    const opened = { ...target, blockNumber: 101, txHash: hash, blockHash: hash, source: 'ws' };
    feed().onStatus({ mode: 'payload_timeout', retryMs: 500, pendingLastFullAtMs: 2500 });
    race.noteLaunchSignal(opened, 1200);
    feed().onStatus({ mode: 'full', healthy: true, hasFullPayload: true, pendingLastFullAtMs: 3000 });
    assert.equal(race.pendingHealth().sources[0].healthy, true);
    race.noteConfirmed(opened, 1600);
    const row = rows.find(entry => entry.event === 'snipe_pending_match');
    assert.equal(row.matchedPending, false);
    assert.equal(row.pendingMode, 'payload_timeout');
    assert.equal(row.fullFeedHealthy, false);
    assert.equal(row.pendingHealthyCount, 0);
    assert.equal(row.pendingLastFullAtMs, 2500);
  } finally { await race.close(); }
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

test('incomplete or forged first source cannot poison the same hash delivered completely by a backup', async () => {
  const good = await signedPending();
  for (const first of [{ ...good, r: undefined, s: undefined }, { ...good, r: '0x' + 'ff'.repeat(32) }]) {
    let plans = 0, submitted = 0, heads = 0, now = 1000, envelopeChecks = 0;
    const { race, rows, feed } = setup({ requirePreopen: true, pendingWsBackupUrls: ['wss://backup.example.invalid/'],
      provider: { async getBlock() { heads++; return testHead; } }, raceServices: {
        hasReproducibleBscEnvelope(frame) { envelopeChecks++; return hasReproducibleBscEnvelope(frame); }, nowMs: () => now,
        async buildPreopenBuyPlan(_p, _target, sequence) {
          plans++;
          assert.deepEqual(sequence.pendingHashes, [good.hash]);
          now += 25;
          return { ...testPlan, pendingHash: good.hash };
        },
      }, execute: {
        async race(request) {
          await request.beforeSign(); request.beforeDispatch(); request.onBroadcast('send', { txHash: hash });
          submitted++; return result(1, 'confirmed');
        },
        async raceStatus() { assert.fail('no unresolved order'); },
      } });
    try {
      race.start();
      feed(0).onTransaction(first, { seen: 1000 });
      feed(0).onTransaction(first, { seen: 1000 });
      await tick();
      assert.equal(heads, 0, 'unverifiable frame must not start contract/RPC inspection');
      now += 50;
      feed(1).onTransaction(good, { seen: now });
      feed(0).onTransaction(good, { seen: now });
      await tick();
      assert.equal(plans, 1);
      assert.equal(submitted, 1);
      assert.equal(envelopeChecks, 2, 'repeated failed frames and identical signed bytes across sources do not repeat signature recovery');
      assert.equal(rows.find(row => row.event === 'snipe_send').elapsedMs, 25,
        'execution timing must begin at the complete signed envelope, not the incomplete first object');
      assert.deepEqual(rows.filter(row => row.event === 'snipe_pending_source').map(row =>
        [row.pendingSource, row.signatureVerified]), [[1, false], [2, true], [1, true]]);
    } finally { await race.close(); }
  }
});

test('source telemetry measures signed-envelope arrival, not an earlier incomplete object, and records late upgrades', async () => {
  const good = await signedPending();
  let now = 1000;
  const { race, rows, feed } = setup({ repeatAttempts: 1, execute: {}, pendingWsBackupUrls: ['wss://backup.example.invalid/'],
    raceServices: { hasReproducibleBscEnvelope, nowMs: () => now } });
  try {
    race.start();
    feed(0).onTransaction({ ...good, r: undefined, s: undefined }, { seen: now, receivedAtMs: 10 });
    now = 1100;
    const opened = { ...target, blockNumber: 101, txHash: good.hash, blockHash: hash, source: 'ws' };
    race.noteLaunchSignal(opened, now);
    race.noteConfirmed(opened, now);
    assert.equal(rows.find(row => row.event === 'snipe_pending_match').matchedPending, false);
    assert.deepEqual(rows.filter(row => row.event === 'snipe_pending_source_match').map(row => row.leadMs), [null, null]);
    now = 1120;
    feed(1).onTransaction(good, { seen: now, receivedAtMs: 20 });
    now = 1130;
    feed(0).onTransaction(good, { seen: now, receivedAtMs: 30 });
    feed(0).onTransaction(good, { seen: now, receivedAtMs: 30 });
    const late = rows.filter(row => row.event === 'snipe_pending_source_match' && row.signatureVerified);
    assert.deepEqual(late.map(row => [row.pendingSource, row.leadMs, row.matchedPending, row.seenBeforeLocalConfirmation]),
      [[2, -20, false, false], [1, -30, false, false]]);
    assert.equal(rows.filter(row => row.event === 'snipe_race_mode').length, 0);
  } finally { await race.close(); }
});

test('a verified same-nonce replacement arriving during planning invalidates the old plan before ownership', async () => {
  const good = await signedPending(), replacement = await signedPending({ gasPrice: 120_000_000n });
  const release = Promise.withResolvers();
  const planned = [], submitted = [];
  const { race, feed, rows } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead }, raceServices: {
    hasReproducibleBscEnvelope,
    async buildPreopenBuyPlan(_p, _t, sequence) {
      const selected = sequence.pendingHashes.at(-1);
      planned.push(selected);
      if (selected === good.hash) await release.promise;
      return { ...testPlan, pendingHash: selected };
    },
  }, execute: {
    async race(request) { await request.beforeSign(); request.beforeDispatch(); submitted.push(request.preopenPlan.pendingHash); return result(1, 'confirmed'); },
    async raceStatus() { assert.fail('no unresolved order'); },
  } });
  try {
    race.start();
    feed().onTransaction(good);
    await tick();
    feed().onTransaction(replacement);
    release.resolve();
    await tick();
    assert.deepEqual(planned, [good.hash, replacement.hash]);
    assert.deepEqual(submitted, [replacement.hash]);
    assert.match(rows.find(row => row.event === 'buy_skipped')?.error ?? '', /nonce 已被新签名交易替换/);
  } finally { release.resolve(); await race.close(); }
});

test('an observed signed self-transfer cancellation blocks the already planned Mint immediately before signing', async () => {
  const good = await signedPending(), cancel = await signedPending({ to: minter.address, value: 0n, data: '0x', gasPrice: 130_000_000n });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let signed = 0, rejection;
  const { race, feed } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead }, raceServices: {
    hasReproducibleBscEnvelope, buildPreopenBuyPlan: async () => ({ ...testPlan, pendingHash: good.hash }),
  }, execute: {
    async race(request) {
      entered.resolve();
      await release.promise;
      try { await request.beforeSign(); request.beforeDispatch(); signed++; }
      catch (error) { rejection = error.message; }
      return result(0, 'skipped');
    }, async raceStatus() { assert.fail('no signature or order'); },
  } });
  try {
    race.start();
    feed().onTransaction(good);
    await entered.promise;
    feed().onTransaction(cancel);
    release.resolve();
    await tick();
    assert.equal(signed, 0);
    assert.match(rejection ?? '', /nonce 已被新签名交易替换/);
  } finally { release.resolve(); await race.close(); }
});

test('source object mutation cannot change the verified queued envelope while the head read is in flight', async () => {
  const good = await signedPending(), original = good.hash;
  const release = Promise.withResolvers();
  let first = true, planned;
  const { race, feed } = setup({ requirePreopen: true, provider: { async getBlock() {
    if (first) { first = false; await release.promise; } return testHead;
  } }, raceServices: { hasReproducibleBscEnvelope,
    async buildPreopenBuyPlan(_p, _t, sequence) { planned = sequence.pendingHashes.at(-1); return { ...testPlan, pendingHash: planned }; },
  }, execute: {
    async race(request) { await request.beforeSign(); request.beforeDispatch(); return result(1, 'confirmed'); },
    async raceStatus() { assert.fail('no unresolved order'); },
  } });
  try {
    race.start();
    feed().onTransaction(good);
    good.hash = hash;
    good.input = '0x';
    release.resolve();
    await tick();
    assert.equal(planned, original);
  } finally { release.resolve(); await race.close(); }
});

test('only a newer head rechecks the selected minter nonce; consumed nonce prevents signing', async () => {
  const good = await signedPending();
  for (const [advanced, consumed] of [[false, false], [true, false], [true, true]]) {
    let initialHead = true, nonceReads = 0, signed = 0, rejection;
    const { race, feed } = setup({ requirePreopen: true, provider: {
      async getBlock(tag) {
        if (initialHead) { initialHead = false; return testHead; }
        return tag === 'latest' && advanced ? { ...testHead, number: 101 } : testHead;
      },
      async getTransactionCount(address, block) {
        nonceReads++;
        assert.equal(address, minter.address.toLowerCase());
        assert.equal(block, 101);
        return consumed ? 8 : 7;
      }, async getCode() { return '0x'; },
    }, raceServices: { hasReproducibleBscEnvelope, buildPreopenBuyPlan: async () => ({ ...testPlan, pendingHash: good.hash }) },
    execute: {
      async race(request) {
        try { await request.beforeSign(); request.beforeDispatch(); signed++; }
        catch (error) { rejection = error.message; }
        return result(consumed ? 0 : 1, consumed ? 'skipped' : 'confirmed');
      }, async raceStatus() { assert.fail('no unresolved order'); },
    } });
    try {
      race.start();
      feed().onTransaction(good);
      await tick();
      assert.equal(nonceReads, Number(advanced));
      assert.equal(signed, Number(!consumed));
      if (consumed) assert.match(rejection ?? '', /nonce 已在新父块变化/);
    } finally { await race.close(); }
  }
});

test('a replacement targeting another watched Mint invalidates and reconsiders the old bucket', async () => {
  const otherTarget = { ...target, mint: '0x' + '78'.repeat(20), token: '0x' + '89'.repeat(20) };
  const good = await signedPending(), replacement = await signedPending({ to: otherTarget.mint, gasPrice: 140_000_000n });
  const fallback = await signedPending({}, Wallet.createRandom());
  const firstHead = Promise.withResolvers(), firstPlan = Promise.withResolvers();
  let reads = 0;
  const planned = [], submitted = [];
  const { race, feed } = setup({ requirePreopen: true, pendingTargets: [target, otherTarget], provider: {
    async getBlock() { if (++reads === 1) await firstHead.promise; return testHead; },
  }, raceServices: { hasReproducibleBscEnvelope,
    async buildPreopenBuyPlan(_p, _t, sequence) {
      const selected = sequence.pendingHashes.at(-1);
      planned.push(selected);
      if (selected === good.hash) await firstPlan.promise;
      return { ...testPlan, pendingHash: selected };
    },
  }, execute: {
    async race(request) { await request.beforeSign(); request.beforeDispatch(); submitted.push(request.preopenPlan.pendingHash); return result(1, 'confirmed'); },
    async raceStatus() { assert.fail('no unresolved order'); },
  } });
  try {
    race.start();
    feed().onTransaction(fallback);
    feed().onTransaction(good);
    firstHead.resolve();
    await tick();
    assert.deepEqual(planned, [good.hash]);
    feed().onTransaction(replacement);
    firstPlan.resolve();
    await tick();
    assert.ok(planned.includes(fallback.hash), 'the old bucket must re-check its remaining independent candidate');
    assert.deepEqual(new Set(submitted), new Set([replacement.hash, fallback.hash]));
    assert.ok(!submitted.includes(good.hash));
  } finally { firstHead.resolve(); firstPlan.resolve(); await race.close(); }
});

test('a selected pending envelope that ages out during execution preparation cannot be signed', async () => {
  const good = await signedPending();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let now = 1000, signed = 0, rejection;
  const { race, feed } = setup({ requirePreopen: true, provider: { getBlock: async () => testHead }, raceServices: {
    hasReproducibleBscEnvelope, nowMs: () => now, buildPreopenBuyPlan: async () => ({ ...testPlan, pendingHash: good.hash }),
  }, execute: {
    async race(request) {
      entered.resolve(); await release.promise;
      try { await request.beforeSign(); request.beforeDispatch(); signed++; }
      catch (error) { rejection = error.message; }
      return result(0, 'skipped');
    }, async raceStatus() { assert.fail('nothing was signed'); },
  } });
  try {
    race.start(); feed().onTransaction(good);
    await entered.promise;
    now += 2501;
    release.resolve();
    await tick();
    assert.equal(signed, 0);
    assert.match(rejection ?? '', /Mint 已过期/);
  } finally { release.resolve(); await race.close(); }
});
