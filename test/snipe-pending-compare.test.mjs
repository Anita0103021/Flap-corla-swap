import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, Transaction, toQuantity } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI, CORLA_QUOTE_ABI } from '../src/corla.mjs';
import { hasReproducibleBscEnvelope, makeSnipePendingCompare, pendingLeadPercentiles } from '../src/snipe-pending-compare.mjs';

const h = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const a = n => '0x' + BigInt(n).toString(16).padStart(40, '0');
const target = { factory: FACTORY, mint: a(1), token: a(2), pricePerLot: 5n };
const other = { factory: FACTORY, mint: a(3), token: a(4), pricePerLot: 5n, quoteToken: a(5), deploymentKey: h(9) };
const wallet = Wallet.createRandom(); // local synthetic test signer; nothing sent
const unsigned = tx => { const { r, s, v, yParity, ...rest } = tx; return rest; };

async function pending({ type = 0, chainId = 56n, nonce = 2, project = target } = {}) {
  const isQuote = Boolean(project.quoteToken);
  const data = isQuote ? CORLA_QUOTE_ABI.encodeFunctionData('mintQuote', [project.deploymentKey, []]) :
    CORLA_ABI.encodeFunctionData('mint', [[]]);
  const fees = type === 2 ? { maxFeePerGas: 50000001n, maxPriorityFeePerGas: 1n } : { gasPrice: 50000000n };
  const tx = Transaction.from(await wallet.signTransaction({ type, chainId, nonce, to: isQuote ? FACTORY : project.mint,
    gasLimit: 300_000n, value: isQuote ? 0n : project.pricePerLot, data, ...fees, ...(type ? { accessList: [] } : {}) }));
  return {
    type: toQuantity(type), chainId: toQuantity(chainId), nonce: toQuantity(nonce), hash: tx.hash, from: tx.from, to: tx.to,
    gas: toQuantity(tx.gasLimit), value: toQuantity(tx.value), input: tx.data,
    ...Object.fromEntries(Object.entries(fees).map(([key, value]) => [key, toQuantity(value)])),
    ...(type ? { accessList: tx.accessList, yParity: toQuantity(tx.signature.yParity) } : {}),
    r: tx.signature.r, s: tx.signature.s,
    v: toQuantity(type ? tx.signature.yParity : tx.signature.networkV ?? tx.signature.v),
  };
}

const launch = (txHash, patch = {}) => ({ target, mint: target.mint, token: target.token, blockNumber: 101,
  blockHash: h(101), txHash, source: 'ws', ...patch });

test('validates actual signed BSC legacy and typed envelopes without exporting raw material', async () => {
  for (const type of [0, 1, 2]) {
    const tx = await pending({ type });
    assert.equal(hasReproducibleBscEnvelope(tx), true);
    assert.equal(hasReproducibleBscEnvelope(unsigned(tx)), false);
    assert.equal(hasReproducibleBscEnvelope({ ...tx, hash: h(9) }), false);
    assert.equal(hasReproducibleBscEnvelope({ ...tx, from: a(100) }), false);
    assert.equal(hasReproducibleBscEnvelope({ ...tx, blockNumber: '0x12' }), false);
  }
  const { chainId, ...legacyWithNetworkV } = await pending();
  assert.equal(hasReproducibleBscEnvelope(legacyWithNetworkV), true);
  assert.equal(hasReproducibleBscEnvelope(await pending({ chainId: 1n, type: 2 })), false);
});

test('reports first observations separately per source and distinguishes signed, shape-only, and hash-only', async () => {
  let t = 100;
  const now = () => t;
  const wallClock = () => 1_800_000_000_000 + t;
  const tx = await pending(), unrelatedEarlierMint = await pending({ nonce: 1 });
  const observations = [];
  let proofCalls = 0;
  const compare = makeSnipePendingCompare({
    provider: { getBlock: async number => ({ number, hash: h(number) }) },
    targets: [target], sources: [1, { source: 2, url: 'wss://do-not-leak.invalid/path/access-key' }, 'hash_only'],
    armBlock: 100, clock: now, wallClock,
    sourceStatus: source => ({ mode: source === 'hash_only' ? 'hash_only' : 'full',
      hasFullPayload: source !== 'hash_only', healthy: source !== 'hash_only', apiKey: 'do-not-log' }),
    verify: () => ++proofCalls > 1, onObservation: row => observations.push(row),
  });
  assert.equal(compare.observePending(1, unrelatedEarlierMint), true);
  assert.equal(compare.observePending(1, tx, { seen: 90, receivedAtMs: wallClock() - 10 }), true);
  t = 120;
  compare.observePending(2, unsigned(tx));
  t = 130;
  compare.observeHash('hash_only', tx.hash);
  assert.equal(compare.observePending(9, tx), false);
  t = 140;
  compare.observePending(1, tx); // later duplicate cannot overwrite
  t = 205;
  assert.equal(await compare.onCandidate(launch(tx.hash, { observedAtMonotonicMs: 200 })), false);
  t = 320;
  compare.observePending(2, tx);
  t = 450;
  await compare.onCandidate(launch(tx.hash, { source: 'http' }));
  const result = await compare.summarize();
  assert.equal(observations.length, 1);
  assert.equal(result.canonicalLaunches, 1);
  const [row] = result.launches;
  assert.equal(row.confirmationSource, 'ws');
  assert.equal(row.verificationMs, 250);
  assert.deepEqual(row.sources.map(s => s.firstSignedEnvelope.leadMs), [110, -120, null]);
  assert.deepEqual(row.sources.map(s => s.firstExactMint.leadMs), [110, 80, null]);
  assert.deepEqual(row.sources.map(s => s.firstHashOnly.leadMs), [null, null, 70]);
  assert.equal(row.sources[1].firstSignedEnvelope.classification, 'late');
  assert.equal(result.signedEnvelopeAnySource.earlyCoveragePct, 100);
  assert.equal(result.sources[1].signedEnvelope.earlyCoveragePct, 0);
  assert.equal(result.sources[2].signedEnvelopeWhileHealthy.earlyCoveragePct, null);
  assert.equal(result.sources[2].hashOnly.earlyCoveragePct, 100);
  assert.equal(result.sources[1].signedEnvelope.leadMs.p50Ms, -120);
  const publicReport = JSON.stringify(result);
  for (const sensitive of [wallet.privateKey, tx.input, tx.r, tx.s, 'wss://', 'access-key', 'do-not-log']) {
    assert.ok(!publicReport.includes(sensitive));
  }
});

test('requires exact eventual final hash; late payload and wall-derived time do not become an early hit', async () => {
  let t = 100;
  const [penultimate, final] = await Promise.all([pending({ nonce: 1 }), pending({ nonce: 2 })]);
  const compare = makeSnipePendingCompare({ provider: { getBlock: async number => ({ number, hash: h(number) }) },
    targets: [target], sources: [1], armBlock: 100, clock: () => t, wallClock: () => 1000 + t, verify: () => true });
  compare.observePending(1, penultimate);
  t = 230;
  await compare.onCandidate(launch(final.hash, { observedAtMs: 1200 }));
  t = 235;
  compare.observePending(1, final);
  const result = await compare.summarize();
  assert.equal(result.launches[0].noticeTimeBasis, 'wall_derived');
  assert.equal(result.signedEnvelopeAnySource.early, 0);
  assert.equal(result.signedEnvelopeAnySource.late, 1);
  assert.equal(result.signedEnvelopeAnySource.missedBeforeNotice, 1);
  assert.equal(result.signedEnvelopeAnySource.earlyCoveragePct, 0);
  assert.equal(result.signedEnvelopeAnySource.leadMs.p95Ms, -35);
});

test('handles canonical recheck, removal while verification is in progress, and empty denominator', async () => {
  let pinned = h(101), readable = true, allowVerify;
  const proofGate = new Promise(resolve => { allowVerify = resolve; });
  const compare = makeSnipePendingCompare({
    provider: { getBlock: async number => readable ? { number, hash: pinned } : null },
    targets: [target], sources: [1], armBlock: 100,
    verify: () => proofGate,
  });
  await compare.onCandidate(launch(h(10), { blockNumber: 100 }));
  const promising = compare.onCandidate(launch(h(11)));
  const verifyingOnly = compare.onCandidate(launch(h(12), { blockHash: h(102) }));
  compare.onRemoved(launch(h(12), { blockHash: h(102), removed: true }));
  allowVerify(true);
  await Promise.all([promising, verifyingOnly]);
  assert.equal((await compare.summarize()).canonicalLaunches, 1);
  pinned = h(102);
  const displaced = await compare.summarize();
  assert.equal(displaced.canonicalLaunches, 0);
  assert.equal(displaced.displacedOrRemoved, 2);
  assert.equal(displaced.signedEnvelopeAnySource.earlyCoveragePct, null);
  readable = false;
  assert.equal((await compare.summarize()).noProofAtEnd, 1);
});

test('bounds unpaired counts, logs evictions and recognizes exact quote-token factory calls', async () => {
  const [evicted, retained] = await Promise.all([pending({ nonce: 1 }), pending({ project: other })]);
  const compare = makeSnipePendingCompare({ provider: { getBlock: async number => ({ number, hash: h(number) }) },
    targets: [target, other], sources: [1], armBlock: 100, verify: () => true,
    limits: { pendingPerSource: 1, hashesPerSource: 1, inclusions: 1 } });
  assert.equal(compare.observePending(1, evicted), true);
  assert.equal(compare.observePending(1, retained), true);
  compare.observeHash(1, evicted.hash);
  compare.observeHash(1, retained.hash);
  await compare.onCandidate(launch(retained.hash, { target: other, mint: other.mint, token: other.token }));
  await compare.onCandidate(launch(evicted.hash, { blockNumber: 102, blockHash: h(102) }));
  const readout = await compare.summarize();
  assert.equal(readout.droppedInclusions, 1);
  assert.equal(readout.sources[0].evictedMatchingHashes, 1);
  assert.equal(readout.sources[0].evictedHashOnlyHashes, 1);
  assert.equal(readout.launches[0].txHash, retained.hash);
  assert.equal(readout.signedEnvelopeAnySource.early, 1);
});

test('uses nearest-rank percentiles inclusive of negative leads; no data yields null', () => {
  assert.deepEqual(pendingLeadPercentiles([365, -9, null, 22, 5, NaN]), {
    samples: 4, p50Ms: 5, p95Ms: 365, minMs: -9, maxMs: 365,
  });
  assert.deepEqual(pendingLeadPercentiles([]), { samples: 0, p50Ms: null, p95Ms: null, minMs: null, maxMs: null });
  const init = { provider: { getBlock() {} }, targets: [target], armBlock: 100 };
  assert.throws(() => makeSnipePendingCompare({ ...init, sources: ['wss://covert.invalid/key'] }), /来源/);
  assert.throws(() => makeSnipePendingCompare({ ...init, sources: [1, '1'] }), /重复/);
});
