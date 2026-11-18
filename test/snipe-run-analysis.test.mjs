import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import test from 'node:test';
import { analyzeSnipeRun, readSnipeRun } from '../scripts/analyze-snipe-run.mjs';

const mint = '0x' + '11'.repeat(20), launchTx = '0x' + '22'.repeat(32), blockHash = '0x' + '33'.repeat(32);
const buyHash = '0x' + '44'.repeat(32), context = { mint, launchTx, launchBlock: 100 };
const start = { event: 'run_start' }, end = { event: 'run_end', failed: false, dropped: 0 };
const launch = { event: 'snipe_pending_match', ...context, matchedPending: false };

test('no samples or old source metrics never masquerade as zero early coverage', () => {
  const summary = analyzeSnipeRun([start, { event: 'snipe_pending_feed', pendingSource: 1 }, end]);
  assert.equal(summary.confirmedLaunches, 0);
  assert.equal(summary.sourceMetrics[0].earlyCoveragePct, null);
  assert.equal(summary.sourceMetrics[0].unseen, null);
  const old = analyzeSnipeRun([start, { event: 'snipe_pending_feed', pendingSource: 1 }, launch, end]);
  assert.equal(old.sourceMetrics[0].earlyCoveragePct, null);
  assert.ok(old.findings.includes('legacy_report_has_no_per_source_signature_metrics'));
  assert.ok(old.findings.includes('no_buy_submission_recorded'));
});

test('late signed arrival corrects explicit unseen without becoming early; missing telemetry stays unknown', () => {
  const base = { event: 'snipe_pending_source_match', ...context };
  const summary = analyzeSnipeRun([start,
    { event: 'snipe_pending_feed', pendingSource: 3 }, launch,
    { ...base, pendingSource: 1, signatureVerified: false, leadMs: null },
    { ...base, pendingSource: 1, signatureVerified: true, leadMs: -459 },
    { ...base, pendingSource: 1, signatureVerified: false, leadMs: null },
    { ...base, pendingSource: 2, signatureVerified: true, leadMs: 70 },
    { ...base, pendingSource: 2, signatureVerified: true, leadMs: 60 }, end,
  ]);
  const [late, early, missing] = summary.sourceMetrics;
  assert.deepEqual([late.late, late.unseen, late.earlyCoveragePct, late.signedLeadMs.p50Ms], [1, 0, 0, -459]);
  assert.deepEqual([early.early, early.earlyCoveragePct, early.signedLeadMs.p95Ms], [1, 100, 70]);
  assert.equal(missing.missingMetricRows, 1);
  assert.equal(missing.earlyCoveragePct, null);
  assert.equal(missing.unseen, null);
  assert.equal(missing.evidenceAvailable, false);
});

test('analysis only emits typed public fields and never treats ACK as a successful receipt', () => {
  const secret = 'https://SECRET.invalid/TOKEN';
  const summary = analyzeSnipeRun([start, launch,
    { event: secret, wallet: secret, privateKey: secret },
    { event: 'snipe_send', txHash: buyHash, elapsedMs: 300, signMs: 2, message: secret },
    { event: 'snipe_ack', txHash: buyHash, status: 'accepted', elapsedMs: 340 },
    { event: 'snipe_first_buy', ...context, status: 'mined', txHash: buyHash, receiptBlock: 100,
      receiptBlockHash: blockHash, receiptIndex: 87, amountIn: '1', firstBuyTotalIn: '20000',
      firstBuyQuoteOut: '1', firstBuySwapCount: 2, firstBuyAggregationComplete: true }, end,
  ]);
  assert.equal(summary.submittedBuyHashes, 1);
  assert.equal(summary.recordedReceipts.length, 0);
  assert.ok(summary.findings.includes('submission_without_recorded_canonical_receipt'));
  assert.equal(summary.recordedFirstBuys[0].totalBuyIn, '20000');
  assert.equal(summary.stageTimingsByEventMs['snipe_send.signMs'].p95Ms, 2);
  assert.ok(!JSON.stringify(summary).includes(secret));
  assert.throws(() => analyzeSnipeRun([start, start]), /多个run_start/);
});

test('bounded reader handles valid NDJSON and rejects invalid, empty, or oversized lines without echoing payload', async t => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'corla-analysis-'));
  t.after(async () => {
    assert.ok(relative(parent, root).startsWith('corla-analysis-'));
    await rm(root, { recursive: true, force: true });
  });
  const file = join(root, 'run.ndjson');
  await writeFile(file, [start, launch, end].map(JSON.stringify).join('\n'));
  assert.equal((await readSnipeRun(file)).confirmedLaunches, 1);
  const contents = await readFile(file, 'utf8');
  await writeFile(file, contents + '\nSECRETinvalid');
  await assert.rejects(readSnipeRun(file), { message: '报告包含无效JSON行' });
  await writeFile(file, '');
  await assert.rejects(readSnipeRun(file), /报告为空/);
  await writeFile(file, 'x'.repeat(1_048_577));
  await assert.rejects(readSnipeRun(file), /超出上限/);
});
