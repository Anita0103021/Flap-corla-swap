import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { replayCorlaOpening } from '../scripts/replay-corla-opening.mjs';

const cli = fileURLToPath(new URL('../scripts/replay-corla-opening.mjs', import.meta.url));
const row = (result, scenario) => result.scenarios.find(item => item.scenario === scenario);

test('historical parent fixture covers the missed input and uses the actual production guards without I/O', async t => {
  const denied = what => () => { throw new Error(`offline regression attempted to access ${what}`); };
  const fetchMock = t.mock.method(globalThis, 'fetch', denied('fetch'));
  const wsMock = t.mock.method(globalThis, 'WebSocket', denied('WebSocket'));
  const result = await replayCorlaOpening();
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(wsMock.mock.callCount(), 0);
  assert.equal(result.passed, true, JSON.stringify(result.scenarios.filter(item => !item.passed)));
  assert.equal(result.mode, 'offline-mock-historical-parent');
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.scenarioCount, result.scenarios.length);
  assert.equal(result.timingBasis, 'injected-synthetic-clock');
  assert.equal(result.seed, 0);
  assert.equal(result.historicalParent.blockNumber, 500);
  assert.equal(result.historicalParent.pendingDelayMs, 459);
  assert.equal(result.historicalOpeningMath.openingNetOut, '1437028.144260996559320774');
  assert.equal(result.historicalOpeningMath.openingMinOut, '1306389.22205545141756434');
  assert.deepEqual(result.sideEffects, { networkRequests: 0, liveTransactions: 0, walletFiles: 0 });
  assert.equal(row(result, 'historical-late-459ms').mockSubmissions, 0);
  assert.equal(row(result, 'exact-signed-sequence').signedSequenceMatches, true);
  assert.equal(typeof row(result, 'exact-signed-sequence').simulatedTimingsMs.inputToHandoff, 'number');
  assert.equal(row(result, 'competitor-before-buy').priceGuardRejected, true);
  assert.equal(row(result, 'nonce-replacement').chosenReplacement, true);
  assert.equal(row(result, 'nonce-consumed').stage, 'stale_pending');
  assert.equal(row(result, 'parent-reorg-before-sign').signatures, 0);
  assert.equal(row(result, 'launch-during-simulation').signatures, 0);
  assert.equal(row(result, 'unknown-pending').pendingFrames, 0);
  assert.equal(row(result, 'receipt-unknown').mockReceiptStatus, 'pending');
  assert.equal(row(result, 'receipt-unknown').signatures, 1);
  assert.equal(row(result, 'ordered-bundle-ack-included').mockReceiptStatus, 'confirmed');
  assert.equal(row(result, 'ordered-bundle-ack-no-inclusion').bundleStatus, 'accepted');
  assert.equal(row(result, 'ordered-bundle-ack-no-inclusion').mockReceiptStatus, 'pending');
  assert.equal(row(result, 'ordered-bundle-delivery-unknown').bundleHandoffs, 1);
  assert.equal(row(result, 'ordered-bundle-stale-parent').bundleHandoffs, 0);
});

test('seeded replay is reproducible and exercises both sides of expiry and price boundaries', async () => {
  const [first, repeated, different] = await Promise.all([replayCorlaOpening({ seed: 0 }), replayCorlaOpening({ seed: 0 }),
    replayCorlaOpening({ seed: 0xffff_ffff })]);
  assert.deepEqual(first, repeated);
  assert.ok(first.passed && different.passed);
  assert.notDeepEqual(row(first, 'seeded-cross-feed-duplicates').variant, row(different, 'seeded-cross-feed-duplicates').variant);
  assert.equal(row(first, 'seeded-sign-deadline').signatures, 0);
  assert.equal(row(different, 'seeded-sign-deadline').signatures, 1);
  for (const result of [first, different]) {
    assert.equal(row(result, 'seeded-price-below-cap').priceGuardRejected, false);
    assert.equal(row(result, 'seeded-price-above-cap').priceGuardRejected, true);
    assert.equal(row(result, 'seeded-cross-feed-duplicates').pendingFrames, 2);
  }
  await assert.rejects(replayCorlaOpening({ seed: 0x1_0000_0000 }), /uint32/);
  await assert.rejects(replayCorlaOpening({ seed: -1 }), /uint32/);
});

test('CLI stdout is machine-readable and no flag can enable live execution', () => {
  const result = spawnSync(process.execPath, [cli, '--json', '--seed', '4294967295'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).seed, 0xffff_ffff);
  for (const args of [['--live'], ['--seed', '-1'], ['--seed', '4294967296']]) {
    const bad = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /Usage:/);
  }
});
