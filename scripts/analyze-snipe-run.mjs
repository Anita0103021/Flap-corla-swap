import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_ROWS = 100_002;
const TIMINGS = ['headMs', 'proofMs', 'planMs', 'walletChecksMs', 'preflightMs', 'signMs', 'simulationMs', 'elapsedMs'];
const TIMING_EVENTS = new Set(['snipe_pending_gate', 'snipe_race_mode', 'snipe_send', 'snipe_ack', 'buy_skipped']);
const validMs = x => Number.isFinite(x) && Math.abs(x) <= 86_400_000;
const int = x => Number.isSafeInteger(x) && x >= 0;
const low = x => typeof x === 'string' ? x.toLowerCase() : '';
const safeHash = x => HASH.test(x ?? '') ? low(x) : undefined;
const safeAddress = x => ADDRESS.test(x ?? '') ? low(x) : undefined;
const sourceId = x => Number.isSafeInteger(x) && x >= 1 && x <= 8 ? x : undefined;
const quantity = x => typeof x === 'string' && /^\d{1,78}$/.test(x) && BigInt(x) < (1n << 256n) ? x : undefined;
const launchKey = row => safeAddress(row.mint) && safeHash(row.launchTx) && int(row.launchBlock)
  ? `${low(row.mint)}:${low(row.launchTx)}:${row.launchBlock}` : null;

function percentiles(values) {
  const sorted = values.filter(validMs).sort((a, b) => a - b), n = sorted.length;
  const at = p => n ? sorted[Math.ceil(n * p) - 1] : null;
  return { samples: n, p50Ms: at(.5), p95Ms: at(.95), minMs: n ? sorted[0] : null, maxMs: at(1) };
}

/** Report-only analysis. No application imports, provider, signer or network.
 * All output is an explicit projection; arbitrary log messages never escape. */
export function analyzeSnipeRun(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('报告行数超出上限');
  const counts = {}, launches = new Map(), perSource = new Map(), sources = new Set(), samples = new Map();
  const sends = new Set(), receipts = new Map(), firstBuys = new Map();
  let sourceMetricsAvailable = false, end, starts = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('报告记录无效');
    // Do not turn arbitrary event names into output keys (they can contain secrets).
    if (['run_start', 'run_end', 'snipe_pending', 'snipe_pending_source', 'snipe_pending_source_match',
      'snipe_pending_match', 'snipe_detected', 'snipe_pending_gate', 'snipe_send', 'snipe_ack', 'snipe_receipt',
      'snipe_first_buy', 'buy_skipped', 'snipe_race_outcome', 'snipe_pending_feed'].includes(row.event)) {
      counts[row.event] = (counts[row.event] ?? 0) + 1;
    }
    if (row.event === 'run_start') starts++;
    if (row.event === 'run_end') end = row;
    if (['snipe_pending_feed', 'snipe_pending_source', 'snipe_pending_source_match'].includes(row.event) && sourceId(row.pendingSource)) {
      sources.add(row.pendingSource);
    }
    if (row.event === 'snipe_pending_match') {
      const key = launchKey(row);
      if (key) launches.set(key, { mint: low(row.mint), launchTx: low(row.launchTx), launchBlock: row.launchBlock,
        matchedPending: row.matchedPending === true, leadMs: validMs(row.leadMs) ? row.leadMs : null });
    }
    if (row.event === 'snipe_pending_source_match') {
      const key = launchKey(row), source = sourceId(row.pendingSource);
      if (!key || !source) continue;
      sourceMetricsAvailable = true;
      if (!perSource.has(source)) perSource.set(source, new Map());
      const byLaunch = perSource.get(source), prior = byLaunch.get(key);
      const signed = row.signatureVerified === true && validMs(row.leadMs);
      // The first no-input report can be corrected by a late signed arrival.
      if (!prior || signed && (!prior.signed || row.leadMs > prior.leadMs)) {
        byLaunch.set(key, { signed, leadMs: signed ? row.leadMs : null });
      }
    }
    if (TIMING_EVENTS.has(row.event)) for (const field of TIMINGS) {
      if (!validMs(row[field]) || row[field] < 0) continue;
      const key = `${row.event}.${field}`;
      if (!samples.has(key)) samples.set(key, []);
      samples.get(key).push(row[field]);
    }
    if (row.event === 'snipe_send' && safeHash(row.txHash)) sends.add(low(row.txHash));
    if (row.event === 'snipe_receipt' && safeHash(row.txHash) && safeHash(row.receiptBlockHash) &&
        int(row.receiptBlock) && int(row.receiptIndex) && typeof row.success === 'boolean') {
      receipts.set(low(row.txHash), { txHash: low(row.txHash), block: row.receiptBlock,
        index: row.receiptIndex, blockHash: low(row.receiptBlockHash), success: row.success });
    }
    if (row.event === 'snipe_first_buy' && safeHash(row.launchTx) && safeHash(row.txHash) &&
        safeHash(row.receiptBlockHash) && row.status === 'mined' && int(row.receiptBlock) && int(row.receiptIndex)) {
      const key = launchKey(row);
      if (key) firstBuys.set(key, { txHash: low(row.txHash), block: row.receiptBlock, index: row.receiptIndex,
        blockHash: low(row.receiptBlockHash), firstSwapIn: quantity(row.amountIn),
        aggregationComplete: row.firstBuyAggregationComplete === true,
        totalBuyIn: row.firstBuyAggregationComplete === true ? quantity(row.firstBuyTotalIn) : undefined,
        quoteSoldOut: row.firstBuyAggregationComplete === true ? quantity(row.firstBuyQuoteOut) : undefined,
        buySwapCount: int(row.firstBuySwapCount) ? row.firstBuySwapCount : undefined });
    }
  }
  if (starts > 1) throw new Error('请一次分析一个运行文件，不能合并多个run_start');
  const sourceMetrics = [...sources].sort((a, b) => a - b).map(source => {
    const matched = perSource.get(source) ?? new Map();
    const available = perSource.has(source);
    const timings = [...launches.keys()].map(key => matched.get(key));
    const leads = timings.filter(row => row?.signed).map(row => row.leadMs);
    const early = leads.filter(x => x > 0).length;
    const missing = timings.filter(row => !row).length;
    return { source, evidenceAvailable: available, confirmedSamples: launches.size,
      early: available ? early : null,
      late: available ? leads.filter(x => x < 0).length : null,
      coincident: available ? leads.filter(x => x === 0).length : null,
      unseen: available ? timings.filter(row => row && !row.signed).length : null,
      missingMetricRows: missing,
      earlyCoveragePct: sourceMetricsAvailable && launches.size && !missing ? 100 * early / launches.size : null,
      signedLeadMs: percentiles(leads) };
  });
  const findings = [];
  if (!launches.size) findings.push('no_verified_launch_samples');
  if (!sourceMetricsAvailable) findings.push('legacy_report_has_no_per_source_signature_metrics');
  if (launches.size && !sends.size) findings.push('no_buy_submission_recorded');
  if (sends.size && !receipts.size) findings.push('submission_without_recorded_canonical_receipt');
  if (!end) findings.push('run_has_no_end_marker');
  if (end?.failed === true || end?.dropped > 0) findings.push('recorder_failed_or_dropped_events');
  return { schemaVersion: 1, mode: 'offline_run_report_analysis',
    interpretation: '仅分析记录时的主链核验和本机计时，不重新查询主链；旧日志缺失指标不当成0覆盖率。阶段并行且按事件采样，不能把p95相加当作全链路耗时。',
    events: counts, confirmedLaunches: launches.size, submittedBuyHashes: sends.size,
    recorder: { closed: Boolean(end), failed: end?.failed === true, dropped: int(end?.dropped) ? end.dropped : null },
    sourceMetrics, stageTimingsByEventMs: Object.fromEntries([...samples].map(([key, values]) => [key, percentiles(values)])),
    recordedReceipts: [...receipts.values()], recordedFirstBuys: [...firstBuys.values()], findings };
}

export async function readSnipeRun(path) {
  const size = await stat(path);
  if (!size.isFile() || size.size > 64 * 1024 * 1024) throw new Error('报告文件无效或过大');
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity }), rows = [];
  try {
    for await (const line of lines) {
      if (line.length > 1_048_576 || rows.length >= MAX_ROWS) throw new Error('报告行数或行长度超出上限');
      if (line.trim()) {
        try { rows.push(JSON.parse(line)); } catch { throw new Error('报告包含无效JSON行'); }
      }
    }
    if (!rows.length) throw new Error('报告为空');
    return analyzeSnipeRun(rows);
  } finally { lines.close(); input.destroy(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) console.log('node scripts/analyze-snipe-run.mjs <单份snipe-*.ndjson>\n仅离线读取报告并输出脱敏JSON，不连接RPC或读取钱包。');
    else {
      if (positionals.length !== 1) throw new Error();
      console.log(JSON.stringify(await readSnipeRun(positionals[0]), null, 2));
    }
  } catch { console.error('分析失败：请检查单份报告路径、JSON格式及大小，使用 --help 查看用法'); process.exitCode = 1; }
}
