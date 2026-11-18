import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { replayCorlaOpening } from '../scripts/replay-corla-opening.mjs';
import { adversarialDeadlineTime, assertAdversarialBaseline, collectAdversarialBaseline,
  validateReplayEvidence } from '../scripts/run-corla-adversarial-night.mjs';

const runner = fileURLToPath(new URL('../scripts/run-corla-adversarial-night.mjs', import.meta.url));
const cloned = value => JSON.parse(JSON.stringify(value));

test('strict scenario validation retains bounded variants, outcomes and explicitly synthetic timing', async () => {
  const replay = await replayCorlaOpening({ seed: 42 });
  const evidence = validateReplayEvidence(replay, 42);
  assert.equal(evidence.count, 19);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.timingBasis, 'injected-synthetic-clock');
  assert.equal(evidence.scenarios.every(row => typeof row.name === 'string' && row.passed === true), true);
  const duplicate = evidence.scenarios.find(row => row.name === 'seeded-cross-feed-duplicates');
  assert.equal(duplicate.variant.lead, replay.scenarios.find(row => row.name === duplicate.name).variant.lead);
  assert.equal(duplicate.signedSequenceMatches, true);
  assert.equal(duplicate.stage, 'ready');
  assert.equal(duplicate.mockSubmissions, 1);
  assert.equal(typeof duplicate.simulatedTimingsMs.inputToHandoff, 'number');
  const unknown = evidence.scenarios.find(row => row.name === 'ordered-bundle-delivery-unknown');
  assert.equal(unknown.bundleStatus, 'unknown');
  assert.equal(unknown.bundleHandoffs, 1);
  assert.equal(unknown.mockReceiptStatus, 'pending');
  const dirty = cloned(replay);
  const marker = 'SECRET_RAW_OR_RPC_URL';
  Object.assign(dirty.scenarios[0], { assertion: marker, privateKey: marker, raw: marker, endpoint: marker });
  dirty.scenarios[0].variant = { unknown: marker, lead: 12 };
  dirty.scenarios[0].simulatedTimingsMs = { untrusted: marker, proof: 0 };
  assert.equal(JSON.stringify(validateReplayEvidence(dirty, 42)).includes(marker), false);
});

test('missing, duplicate, contradictory or malformed evidence cannot silently count as passed', async () => {
  const good = await replayCorlaOpening({ seed: 7 });
  const mutations = [
    value => { value.schemaVersion = 1; },
    value => { value.seed++; },
    value => { value.mode = 'live'; },
    value => { value.timingBasis = 'real-rpc'; },
    value => { value.scenarios = []; value.scenarioCount = 0; },
    value => { value.scenarios.pop(); value.scenarioCount--; },
    value => { value.scenarios[1] = cloned(value.scenarios[0]); },
    value => { delete value.scenarios[0].name; },
    value => { value.scenarios[0].scenario = 'another-scenario'; },
    value => { value.scenarios[0].passed = 'true'; },
    value => { value.scenarios[0].passed = false; },
    value => { delete value.scenarios[0].stage; },
    value => { delete value.scenarios[0].simulations; },
    value => { value.scenarios[0].mockSubmissions = -1; },
    value => { value.scenarios[0].simulatedTimingsMs = { proof: -1 }; },
    value => { value.scenarios[0].variant = { lead: Number.MAX_VALUE }; },
    value => { value.scenarios[0].variant = { competitorInput: 'wss://private.invalid/credential' }; },
    value => { value.sideEffects.networkRequests = 1; },
  ];
  for (const mutate of mutations) {
    const bad = cloned(good); mutate(bad);
    assert.throws(() => validateReplayEvidence(bad, 7), { code: 'INVALID_REPLAY_EVIDENCE' });
  }
  const failed = cloned(good);
  failed.scenarios[0] = { name: good.scenarios[0].name, scenario: good.scenarios[0].name, passed: false, assertion: 'do not retain' };
  failed.passed = false;
  const evidence = validateReplayEvidence(failed, 7);
  assert.equal(evidence.passed, false);
  assert.deepEqual(evidence.scenarios[0], { name: good.scenarios[0].name, passed: false });
});

test('code baseline includes file contents and additions but never opens real configuration or reports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'corla-adversarial-baseline-'));
  t.after(async () => {
    const canonical = await realpath(root);
    assert.equal(canonical.toLowerCase(), resolve(root).toLowerCase());
    assert.ok(canonical.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase() + '\\') ||
      canonical.startsWith(resolve(tmpdir()) + '/'));
    await rm(canonical, { recursive: true, force: true });
  });
  for (const dir of ['src', 'test', 'scripts']) await mkdir(join(root, dir));
  for (const name of ['package.json', 'package-lock.json', 'src/example.mjs', 'test/example.test.mjs',
    'scripts/run-corla-adversarial-night.mjs', 'scripts/replay-corla-opening.mjs']) await writeFile(join(root, name), 'fixture-a');
  const before = await collectAdversarialBaseline(root);
  assert.equal(before.files.length, 6);
  assertAdversarialBaseline(before, await collectAdversarialBaseline(root));
  await writeFile(join(root, 'config.local.json'), 'not part of the baseline');
  await mkdir(join(root, 'reports'));
  await writeFile(join(root, 'reports', 'private.log'), 'not part of the baseline');
  assertAdversarialBaseline(before, await collectAdversarialBaseline(root));
  await writeFile(join(root, 'src/example.mjs'), 'fixture-b'); // same byte count, different hash
  const changed = await collectAdversarialBaseline(root);
  assert.throws(() => assertAdversarialBaseline(before, changed), { code: 'ADVERSARIAL_BASELINE_CHANGED' });
  assert.equal(JSON.stringify(changed).includes(root), false);
  await writeFile(join(root, 'src/added.mjs'), 'new source');
  const added = await collectAdversarialBaseline(root);
  assert.throws(() => assertAdversarialBaseline(changed, added), { code: 'ADVERSARIAL_BASELINE_CHANGED' });
});

test('deadline is timezone-explicit and rejects normalized invalid calendar dates and unsafe CLI options', () => {
  assert.equal(adversarialDeadlineTime('2026-11-18T09:00:00+08:00'), Date.parse('2026-11-18T01:00:00Z'));
  assert.equal(adversarialDeadlineTime('2026-11-18T01:00:00.012Z'), Date.parse('2026-11-18T01:00:00.012Z'));
  for (const raw of ['2026-11-18T09:00:00', '2026-02-30T09:00:00+08:00', '2026-11-18T24:00:00Z', 'invalid']) {
    assert.throws(() => adversarialDeadlineTime(raw));
  }
  const help = spawnSync(process.execPath, [runner, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0);
  for (const args of [['--live'], ['--until', '2026-02-30T09:00:00+08:00'],
    ['--until', '2000-01-01T00:00:00Z'], ['--resume', '../state'], ['--resume', 'valid-run', '--seed', '1']]) {
    const bad = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(bad.status, 1);
  }
});
