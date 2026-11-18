import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { REPLAY_SCHEMA_VERSION, REPLAY_SCENARIO_NAMES } from './replay-corla-opening.mjs';

// This supervisor never loads the app, live configuration, wallet vault, or RPC.
// Its fixed child programs are offline fixtures. There is no live execution switch.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = join(ROOT, 'reports', 'snipe-adversarial');
const TESTS = [
  'test/snipe-bundle.test.mjs', 'test/snipe-bundle-journal.test.mjs', 'test/snipe-pending-compare.test.mjs',
  'test/replay-corla-opening.test.mjs', 'test/adversarial-night.test.mjs', 'test/snipe-preopen.test.mjs',
  'test/snipe-race.test.mjs', 'test/launch-feed.test.mjs', 'test/pending-mint-shadow.test.mjs',
  'test/snipe.test.mjs', 'test/execution.test.mjs', 'test/rpc-pool.test.mjs',
];
const OUT_LIMIT = 192 * 1024;
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(?:path|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|systemdrive|homedrive|userprofile)$/i.test(key)));
const RUN_ID = /^[a-z0-9][a-z0-9-]{5,95}$/;
const iso = (time = Date.now()) => new Date(time).toISOString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const DECIMAL = /^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/;
const U32 = n => Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff;
const CASE_COUNTERS = ['inspected', 'simulations', 'signatures', 'mockSubmissions', 'receiptPolls', 'pendingFrames', 'canonicalReads', 'bundleHandoffs'];
const CASE_BOOLS = ['signedSequenceMatches', 'chosenReplacement', 'matchedPending', 'priceGuardRejected'];
const CASE_TIMINGS = ['pendingAfterLaunchMs', 'pendingLeadMs'];
const STAGES = new Set(['waiting_lots', 'waiting_pending', 'stale_pending', 'ready']);
const RECEIPTS = new Set(['confirmed', 'failed', 'pending', 'skipped']);
const BUNDLE_STATUS = new Set(['accepted', 'refused', 'unknown', 'disabled']);
const BUNDLE_REASONS = new Set(['parent_changed', 'builder_ack', 'delivery_unverified', 'previously_attempted']);
const BUNDLE_MODES = new Set(['ack-included', 'ack-no-inclusion', 'delivery-unknown', 'stale-parent']);
const FIXED_BASELINE_FILES = ['package.json', 'package-lock.json',
  'scripts/run-corla-adversarial-night.mjs', 'scripts/replay-corla-opening.mjs'];

/** Public relative paths + file hashes only. No configuration, state or reports
 * are opened. Cover the entire source/test set, including newly added modules. */
export async function collectAdversarialBaseline(root = ROOT) {
  const files = [...FIXED_BASELINE_FILES];
  for (const directory of ['src', 'test']) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (entry.isFile() && /^[A-Za-z0-9_-]+(?:\.test)?\.mjs$/.test(entry.name)) files.push(`${directory}/${entry.name}`);
    }
  }
  const entries = [];
  for (const path of files.sort()) {
    const data = await readFile(join(root, path));
    entries.push({ path, sha256: sha256(data), bytes: data.length });
  }
  const content = { schemaVersion: 1, algorithm: 'sha256', node: process.version, files: entries };
  return { ...content, digest: sha256(JSON.stringify(content)) };
}

function baselineError() {
  const error = new Error('测试代码版本已改变，请创建新的 run-id，不能混入原运行记录');
  error.code = 'ADVERSARIAL_BASELINE_CHANGED';
  return error;
}

export function assertAdversarialBaseline(expected, observed) {
  if (!expected || expected.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(expected.digest ?? '') ||
      observed?.digest !== expected.digest) throw baselineError();
}

function evidenceError() {
  const error = new Error('离线回放证据格式不完整或与本轮不一致');
  error.code = 'INVALID_REPLAY_EVIDENCE';
  return error;
}

/** Strict report envelope and scenario set, then a bounded allowlist snapshot.
 * Never retain arbitrary assertion text, transaction bytes, addresses or URLs. */
export function validateReplayEvidence(report, seed) {
  const valid = condition => { if (!condition) throw evidenceError(); };
  valid(U32(seed) && report?.seed === seed && report.schemaVersion === REPLAY_SCHEMA_VERSION &&
    report.mode === 'offline-mock-historical-parent' && report.timingBasis === 'injected-synthetic-clock' &&
    typeof report.passed === 'boolean' && report.scenarioCount === REPLAY_SCENARIO_NAMES.length &&
    Array.isArray(report.scenarios) && report.scenarios.length === REPLAY_SCENARIO_NAMES.length &&
    report.sideEffects?.networkRequests === 0 && report.sideEffects?.liveTransactions === 0 && report.sideEffects?.walletFiles === 0);
  const seen = new Set();
  const expected = new Set(REPLAY_SCENARIO_NAMES);
  const scenarios = report.scenarios.map(row => {
    valid(row && expected.has(row.name) && !seen.has(row.name) && row.scenario === row.name && typeof row.passed === 'boolean');
    seen.add(row.name);
    const out = { name: row.name, passed: row.passed };
    if (row.passed) {
      valid(CASE_COUNTERS.filter(key => key !== 'bundleHandoffs').every(key => row[key] !== undefined) &&
        CASE_BOOLS.every(key => row[key] !== undefined) && Object.hasOwn(row, 'stage') &&
        row.simulatedTimingsMs !== undefined && Object.hasOwn(row, 'mockReceiptStatus'));
    }
    for (const key of CASE_COUNTERS) {
      if (row[key] === undefined) continue;
      valid(Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 100_000);
      out[key] = row[key];
    }
    for (const key of CASE_BOOLS) {
      if (row[key] === undefined) continue;
      valid(typeof row[key] === 'boolean'); out[key] = row[key];
    }
    for (const key of CASE_TIMINGS) {
      if (row[key] === undefined) continue;
      valid(row[key] === null || Number.isFinite(row[key]) && Math.abs(row[key]) <= 86_400_000);
      out[key] = row[key];
    }
    for (const [key, choices] of [['stage', STAGES], ['mockReceiptStatus', RECEIPTS],
      ['bundleStatus', BUNDLE_STATUS], ['bundleReason', BUNDLE_REASONS]]) {
      if (row[key] === undefined) continue;
      valid(row[key] === null || choices.has(row[key])); out[key] = row[key];
    }
    for (const key of ['projectedCompetitorNetOut', 'openingMinOut']) {
      if (row[key] === undefined) continue;
      valid(row[key] === null || typeof row[key] === 'string' && DECIMAL.test(row[key])); out[key] = row[key];
    }
    if (row.variant !== undefined) {
      valid(row.variant && typeof row.variant === 'object' && !Array.isArray(row.variant));
      out.variant = {};
      for (const key of ['lead', 'deadlineRemaining', 'duplicateLag', 'unknownLag']) {
        if (row.variant[key] === undefined) continue;
        valid(Number.isSafeInteger(row.variant[key]) && row.variant[key] >= 0 && row.variant[key] <= 86_400_000);
        out.variant[key] = row.variant[key];
      }
      if (row.variant.bundleMode !== undefined) {
        valid(BUNDLE_MODES.has(row.variant.bundleMode)); out.variant.bundleMode = row.variant.bundleMode;
      }
      if (row.variant.competitorInput !== undefined) {
        valid(typeof row.variant.competitorInput === 'string' && DECIMAL.test(row.variant.competitorInput));
        out.variant.competitorInput = row.variant.competitorInput;
      }
    }
    if (row.simulatedTimingsMs !== undefined) {
      valid(row.simulatedTimingsMs && typeof row.simulatedTimingsMs === 'object' && !Array.isArray(row.simulatedTimingsMs));
      out.simulatedTimingsMs = {};
      for (const key of ['head', 'proof', 'plan', 'inputToPlan', 'inputToHandoff']) {
        if (row.simulatedTimingsMs[key] === undefined) continue;
        valid(Number.isFinite(row.simulatedTimingsMs[key]) && row.simulatedTimingsMs[key] >= 0 && row.simulatedTimingsMs[key] <= 86_400_000);
        out.simulatedTimingsMs[key] = row.simulatedTimingsMs[key];
      }
    }
    return out;
  });
  const passed = scenarios.every(row => row.passed === true);
  valid(report.passed === passed);
  return { schemaVersion: REPLAY_SCHEMA_VERSION, timingBasis: 'injected-synthetic-clock',
    count: scenarios.length, passed, scenarios };
}

function diagnostic(result) {
  // Even failing test output can contain serialized synthetic raw envelopes.
  // Keep result classifications, not arbitrary child stderr/stdout in reports.
  return { result: result?.result ?? 'not_run', code: Number.isSafeInteger(result?.code) ? result.code : null,
    spawnError: /^[A-Z_]{1,40}$/.test(result?.spawnError ?? '') ? result.spawnError : null };
}

function integer(raw, label, low, high) {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < low || Number(raw) > high) {
    throw new Error(`${label} 超出范围 (${low}–${high})`);
  }
  return Number(raw);
}

export function adversarialDeadlineTime(raw) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw ?? '')) {
    throw new Error('--until 需要带明确时区的 ISO 时间，例如 2026-11-18T09:00:00+08:00');
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value)) throw new Error('截止时间无效');
  const suffix = raw.slice(-6);
  const offsetMinutes = raw.endsWith('Z') ? 0 : (suffix[0] === '-' ? -1 : 1) *
    (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(4, 6)));
  // Date.parse normalizes February 30 and 24:00; reject those rather than
  // quietly running on a different date than the operator supplied.
  if (new Date(value + offsetMinutes * 60_000).toISOString().slice(0, 19) !== raw.slice(0, 19)) {
    throw new Error('截止时间包含无效日期或时间');
  }
  return value;
}

async function atomic(path, content) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await sleep(20 * (attempt + 1));
    }
  }
}

function child(args, { signal, until, timeoutMs }) {
  return new Promise(resolve => {
    const started = performance.now();
    const allowance = Math.min(timeoutMs, until - Date.now());
    if (signal.aborted || allowance <= 0) {
      resolve({ result: signal.aborted ? 'interrupted' : 'deadline', elapsedMs: 0, stdout: '', stderr: '' });
      return;
    }
    const proc = spawn(process.execPath, args, {
      cwd: ROOT, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', result, spawnError;
    function stop(reason) {
      result ??= reason;
      // Test launcher uses isolation=none: no escaping test-runner children.
      proc.kill('SIGKILL');
    }
    const abort = () => stop('interrupted');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop(Date.now() >= until || allowance < timeoutMs ? 'deadline' : 'timeout'), allowance);
    proc.stdout.setEncoding('utf8').on('data', part => { stdout = (stdout + part).slice(-OUT_LIMIT); });
    proc.stderr.setEncoding('utf8').on('data', part => { stderr = (stderr + part).slice(-OUT_LIMIT); });
    proc.once('error', error => { spawnError = error.code ?? 'spawn_failure'; });
    proc.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve({ result: result ?? (code === 0 && !spawnError ? 'pass' : 'fail'), code, spawnError,
        elapsedMs: Math.round(performance.now() - started), stdout, stderr });
    });
  });
}

function seedFor(initial, round) {
  let x = (initial + Math.imul(round, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
}

async function runRound(state, stop) {
  assertAdversarialBaseline(state.baseline, await collectAdversarialBaseline());
  const index = state.rounds + 1;
  const seed = seedFor(state.seed, index);
  const options = { signal: stop.signal, until: Date.parse(state.until), timeoutMs: state.timeoutMs };
  const startedAt = iso();
  const replay = await child(['scripts/replay-corla-opening.mjs', '--json', '--seed', String(seed)], options);
  let scenarioResult, evidenceFailure, replayFailed = replay.result !== 'pass';
  try {
    scenarioResult = validateReplayEvidence(JSON.parse(replay.stdout), seed);
    replayFailed ||= !scenarioResult.passed;
  } catch { replayFailed = true; evidenceFailure = 'INVALID_REPLAY_EVIDENCE'; }
  const regression = ['deadline', 'interrupted'].includes(replay.result) ? null
    : await child(['--test', '--test-isolation=none', '--test-reporter=tap', ...TESTS], options);
  const counts = Object.fromEntries([...String(regression?.stdout ?? '').matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)\s*$/gm)]
    .map(([, key, value]) => [key, Number(value)]));
  const cutoff = [replay.result, regression?.result].find(x => x === 'interrupted' || x === 'deadline');
  const observedBaseline = await collectAdversarialBaseline();
  const baselineChanged = observedBaseline.digest !== state.baseline.digest;
  const passed = !replayFailed && regression?.result === 'pass' && counts.tests > 0 &&
    counts.pass === counts.tests && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && !baselineChanged;
  const failureCode = baselineChanged ? 'ADVERSARIAL_BASELINE_CHANGED' : evidenceFailure;
  const log = cutoff || passed ? null : JSON.stringify({ failureCode, replay: diagnostic(replay),
    regression: diagnostic(regression), failedCases: scenarioResult?.scenarios.filter(row => !row.passed).map(row => row.name) });
  return { event: 'round', index, seed, startedAt, endedAt: iso(), result: cutoff ?? (passed ? 'pass' : 'fail'),
    baselineDigest: state.baseline.digest, ...(baselineChanged ? { observedBaselineDigest: observedBaseline.digest } : {}),
    ...(failureCode ? { failureCode } : {}),
    replay: { ...scenarioResult, result: replay.result, elapsedMs: replay.elapsedMs },
    regression: regression && { ...counts, result: regression.result, elapsedMs: regression.elapsedMs }, log };
}

function record(state, row) {
  state.rounds = row.index;
  state.lastRound = row;
  if (row.result === 'pass') state.passed++;
  if (row.result === 'fail') state.failed++;
  if (row.result === 'deadline' || row.result === 'interrupted') state.incomplete++;
  if (row.result !== 'deadline' && row.result !== 'interrupted') {
    state.replayScenarios += row.replay.count ?? 0;
    state.regressionChecks += row.regression?.tests ?? 0;
  }
}

async function checkpoint(directory, state) {
  state.updatedAt = iso();
  const last = state.lastRound;
  const localDeadline = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'long', hour12: false,
  }).format(new Date(state.until));
  const summary = `# Corla 开盘狙击 · 隔离对抗\n\n- 状态：${state.status}\n- 截止：${localDeadline}（${state.until}）\n` +
    `- 启动 / 最近更新（UTC）：${state.startedAt} / ${state.updatedAt}\n` +
    `- 轮次：通过 ${state.passed} / 失败 ${state.failed} / 截止或中断 ${state.incomplete}\n` +
    `- 累计回放场景 ${state.replayScenarios} 次、回归检查 ${state.regressionChecks} 次（包含重复回归执行）\n` +
    `- 固定代码基线 SHA256：${state.baseline.digest}；Node ${state.baseline.node}\n` +
    (last ? `- 最近一轮：#${last.index}，seed=${last.seed}，结果 ${last.result}${last.failureLog ? `；见 ${last.failureLog}` : ''}\n` : '') +
    (state.error ? `- 运行器异常：${state.error}\n` : '') +
    `\n只运行离线回放和本地测试，不读取实盘配置或钱包，不连接真实 Builder、不广播。\n` +
    `通过表示夹具符合预期，不代表主网能抢到第一笔；电脑休眠或关机会影响轮数。\n` +
    `逐场景变体、门控结果和 simulatedTimingsMs 为注入模拟时钟，不是主网 RPC/Builder 延迟。\n`;
  await atomic(join(directory, 'manifest.json'), JSON.stringify(state, null, 2) + '\n');
  await atomic(join(directory, 'summary.md'), summary);
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, until: { type: 'string' }, 'interval-ms': { type: 'string' },
    'timeout-ms': { type: 'string' }, seed: { type: 'string' }, 'run-id': { type: 'string' }, resume: { type: 'string' },
  } });
  if (values.help) {
    console.log('node scripts/run-corla-adversarial-night.mjs --until <ISO with timezone> [--interval-ms 180000] [--run-id <id>]\n' +
      'node scripts/run-corla-adversarial-night.mjs --resume <id>');
    return;
  }
  if (values.resume && Object.keys(values).length !== 1) throw new Error('--resume 不接受其他参数');
  const runId = values.resume ?? values['run-id'] ?? `corla-${iso().replace(/[:.]/g, '-').toLowerCase()}-${randomBytes(3).toString('hex')}`;
  if (!RUN_ID.test(runId)) throw new Error('运行 ID 仅接受小写字母、数字及连字符');
  const directory = join(OUTPUT, runId);
  const baseline = await collectAdversarialBaseline();
  let state;
  if (values.resume) {
    state = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    if (state.runId !== runId || state.schemaVersion !== 2 || state.mode !== 'offline_adversarial' ||
        !['RUNNING', 'INTERRUPTED', 'ERROR'].includes(state.status)) throw new Error('运行状态不允许继续');
    // Version 1 lacks a trustworthy baseline and cannot be silently upgraded.
    assertAdversarialBaseline(state.baseline, baseline);
    adversarialDeadlineTime(state.until);
    integer(String(state.intervalMs), 'intervalMs', 1000, 3_600_000);
    integer(String(state.timeoutMs), 'timeoutMs', 1000, 180000);
    integer(String(state.seed), 'seed', 0, 0xffff_ffff);
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || !Number.isSafeInteger(state.generation) || state.generation < 0) {
      throw new Error('运行状态损坏，无法继续');
    }
    if (state.status === 'RUNNING') {
      try { process.kill(state.pid, 0); throw new Error('原进程仍在运行'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const lines = await readFile(join(directory, 'rounds.ndjson'), 'utf8');
    for (const line of lines.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.index <= state.rounds) continue;
      if (row.event !== 'round' || row.index !== state.rounds + 1 || row.baselineDigest !== baseline.digest) {
        throw new Error('轮次记录不连续或代码版本不一致，无法继续');
      }
      record(state, row);
    }
    delete state.error;
  } else {
    const until = adversarialDeadlineTime(values.until);
    if (until <= Date.now() || until - Date.now() > 24 * 3_600_000) throw new Error('截止时间须在未来 24 小时内');
    const intervalMs = integer(values['interval-ms'] ?? '180000', '--interval-ms', 1000, 3_600_000);
    const timeoutMs = integer(values['timeout-ms'] ?? '45000', '--timeout-ms', 1000, 180000);
    const seed = values.seed === undefined ? randomBytes(4).readUInt32LE(0) : integer(values.seed, '--seed', 0, 0xffff_ffff);
    await mkdir(OUTPUT, { recursive: true });
    await mkdir(directory);
    await writeFile(join(directory, 'rounds.ndjson'), '', { flag: 'wx' });
    state = { schemaVersion: 2, mode: 'offline_adversarial', runId, pid: process.pid, baseline,
      generation: 0, startedAt: iso(), until: iso(until), intervalMs, timeoutMs, seed,
      rounds: 0, passed: 0, failed: 0, incomplete: 0, replayScenarios: 0, regressionChecks: 0 };
  }
  const until = Date.parse(state.until);
  await writeFile(join(directory, `worker-${state.generation + 1}.pid`), String(process.pid), { flag: 'wx' });
  state.generation++;
  state.pid = process.pid;
  state.status = 'RUNNING';
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await checkpoint(directory, state);
    while (!stop.signal.aborted && Date.now() < until) {
      const next = Date.now() + state.intervalMs;
      const { log, ...row } = await runRound(state, stop);
      if (log) {
        row.failureLog = `round-${String(row.index).padStart(4, '0')}.log`;
        await writeFile(join(directory, row.failureLog), log + '\n', 'utf8');
      }
      await appendFile(join(directory, 'rounds.ndjson'), JSON.stringify(row) + '\n', 'utf8');
      record(state, row);
      await checkpoint(directory, state);
      if (row.failureCode === 'ADVERSARIAL_BASELINE_CHANGED') throw baselineError();
      while (!stop.signal.aborted && Date.now() < Math.min(next, until)) {
        await sleep(Math.max(1, Math.min(next, until) - Date.now()), undefined, { signal: stop.signal })
          .catch(error => { if (!stop.signal.aborted) throw error; });
      }
    }
    state.status = stop.signal.aborted ? 'INTERRUPTED'
      : !state.passed && !state.failed ? 'DONE_NO_COMPLETE_ROUNDS' : state.failed ? 'DONE_WITH_FAILURES' : 'DONE';
  } catch (error) {
    state.status = 'ERROR';
    state.error = String(error.code ?? error.name ?? 'worker_error');
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    state.endedAt = iso();
    await checkpoint(directory, state);
    if (state.failed || !state.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
