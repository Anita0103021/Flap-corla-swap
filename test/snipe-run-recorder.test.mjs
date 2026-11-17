import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Interface } from 'ethers';
import { CORLA_LAUNCH_TOPIC } from '../src/events.mjs';
import { createSnipeReceiptObserver, createSnipeRunRecorder, findLatestSnipeReport } from '../src/snipe-run-recorder.mjs';

const MINT = '0x' + '01'.repeat(20), TOKEN = '0x' + '02'.repeat(20);
const WALLET = '0x' + '03'.repeat(20), TX = '0x' + 'ab'.repeat(32), BLOCK = '0x' + 'bc'.repeat(32);
const KEY = '0x' + 'ff'.repeat(32), RPC = 'https://secret-rpc.invalid/private/api-token';
const target = { mint: MINT, token: TOKEN, url: RPC, wallet: WALLET, apiKey: KEY };
async function sandbox(t) {
  const parent = await realpath(tmpdir());
  const prefix = 'corla-snipe-recorder-test-';
  const root = await mkdtemp(join(parent, prefix));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(dirname(resolved), parent);
    assert.ok(basename(resolved).startsWith(prefix));
    await rm(resolved, { recursive: true, force: true });
  });
  return root;
}
const load = async (rootDir, fileName) => (await readFile(join(rootDir, 'reports', 'snipe-runs', fileName), 'utf8'))
  .trim().split('\n').map(line => JSON.parse(line));

test('run report is ordered, projected and immediately shareable without wallet, RPC or credential fields', async t => {
  const rootDir = await sandbox(t);
  const settings = { amountIn: 100n, slippageBps: 1000, walletCount: 1, raceAttempts: 3,
    rpcUrl: RPC, wallet: WALLET, sessionToken: KEY };
  const recorder = await createSnipeRunRecorder({ rootDir, settings, targets: [target], armBlock: 41 });
  assert.match(recorder.reportPath, /^reports\/snipe-runs\/snipe-[\w.-]+\.ndjson$/);
  assert.equal(recorder.record('snipe_pending_match', { token: TOKEN, mint: MINT, pendingTxHash: TX,
    leadMs: 41.125, pendingMode: 'full', matchedPending: true, wallet: WALLET, key: KEY }), true);
  assert.equal(recorder.record('snipe_race_attempt', { attempt: 1, maxAttempts: 3, raceMode: 'pending', txHash: TX,
    gasEstimate: 50_000n, calldata: KEY, privateKey: KEY, rpcUrl: RPC, token: WALLET }), true);
  assert.equal(recorder.record('buy_skipped', { error: 'PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT ' + RPC,
    token: TOKEN, message: KEY, wallet: WALLET }), true);
  assert.equal(recorder.record('unknown-key-' + KEY, {}), false);
  const closing = recorder.close();
  assert.equal(recorder.close(), closing);
  assert.equal(recorder.record('watch_stopped'), false);
  assert.deepEqual(await closing, { written: 3, dropped: 0, failed: false,
    eventCounts: { snipe_pending_match: 1, snipe_race_attempt: 1, buy_skipped: 1 } });
  const rows = await load(rootDir, recorder.fileName);
  assert.deepEqual(rows.map(row => row.sequence), [0, 1, 2, 3, 4]);
  assert.ok(rows.every((row, index) => !index || row.runMs >= rows[index - 1].runMs));
  assert.deepEqual(rows[0].settings, { raceAttempts: 3, walletCount: 1, slippageBps: 1000, amountIn: '100' });
  assert.deepEqual(rows[0].targets, [{ mint: MINT, token: TOKEN }]);
  assert.equal(rows[1].leadMs, 41.125);
  assert.equal(rows[1].pendingTxHash, TX);
  assert.equal(rows[2].gasEstimate, '50000');
  assert.equal(rows[2].token, undefined);
  assert.equal(rows[3].failureKind, 'min_out');
  assert.equal(rows[4].event, 'run_end');
  const raw = JSON.stringify(rows);
  for (const privateValue of [WALLET, KEY, RPC, rootDir]) assert.ok(!raw.includes(privateValue));
});

test('report stores typed opening-price refusals and safe comparison data, not the underlying RPC error', async t => {
  const rootDir = await sandbox(t);
  const recorder = await createSnipeRunRecorder({ rootDir, settings: { requirePreopen: false, maxOpeningPremiumBps: 1000 },
    targets: [target], armBlock: 41 });
  assert.ok(recorder.record('buy_skipped', { token: TOKEN, openingNetOut: 1000n, quotedNetOut: 320n, openingAmountOutMin: 910n,
    maxOpeningPremiumBps: 1000, openingTaxMs: 66, error: '当前报价超过开盘价溢价上限，不追价 ' + RPC }));
  await recorder.close();
  const rows = await load(rootDir, recorder.fileName);
  assert.equal(rows[0].settings.maxOpeningPremiumBps, 1000);
  assert.equal(rows[0].settings.requirePreopen, false);
  assert.deepEqual([rows[1].openingNetOut, rows[1].quotedNetOut, rows[1].openingAmountOutMin, rows[1].openingTaxMs, rows[1].failureKind],
    ['1000', '320', '910', 66, 'opening_price_cap']);
  assert.ok(!JSON.stringify(rows).includes(RPC));
});

test('the report keeps final-batch progress, hashes and WSS source without retaining calldata or endpoint addresses', async t => {
  const rootDir = await sandbox(t);
  const recorder = await createSnipeRunRecorder({ rootDir, targets: [target] });
  const tail = ['0x' + 'ac'.repeat(32), '0x' + 'bd'.repeat(32), TX];
  assert.ok(recorder.record('snipe_pending_gate', { token: TOKEN, mint: MINT, quoteBlock: 41, mintedLots: 47n,
    totalLots: 50n, remainingLots: 3n, pendingMintCount: 3, pendingHashes: tail, pendingTxHash: TX,
    preopenStage: 'ready', proofMs: 130, calldata: KEY, rpcUrl: RPC }));
  assert.ok(recorder.record('snipe_pending', { mint: MINT, pendingSource: 2, pendingTxHash: TX,
    afterLaunchSignal: true, pendingReceivedAtMs: 1_794_626_238_617 }));
  recorder.record('snipe_pending_gate', { pendingHashes: [RPC, KEY], preopenStage: RPC });
  await recorder.close();
  const [, ready, pending, invalid] = await load(rootDir, recorder.fileName);
  assert.deepEqual([ready.mintedLots, ready.totalLots, ready.remainingLots, ready.pendingMintCount, ready.preopenStage],
    ['47', '50', '3', 3, 'ready']);
  assert.deepEqual(ready.pendingHashes, tail);
  assert.equal(pending.pendingSource, 2);
  assert.equal(pending.afterLaunchSignal, true);
  assert.equal(pending.time, new Date(1_794_626_238_617).toISOString());
  assert.equal(invalid.pendingHashes, undefined);
  assert.equal(invalid.preopenStage, undefined);
  assert.ok(!JSON.stringify([ready, pending, invalid]).includes(RPC));
  assert.ok(!JSON.stringify([ready, pending, invalid]).includes(KEY));
});

test('per-run file names are unique and report queue caps are explicit', async t => {
  const rootDir = await sandbox(t);
  const first = await createSnipeRunRecorder({ rootDir, targets: [target], armBlock: 41, maxEvents: 2 });
  const second = await createSnipeRunRecorder({ rootDir, targets: [target], armBlock: 41, maxQueueBytes: 512 });
  assert.notEqual(first.fileName, second.fileName);
  assert.equal(first.record('snipe_detected', { token: TOKEN, launchTx: TX }), true);
  assert.equal(first.record('snipe_send', { txHash: TX }), true);
  assert.equal(first.record('snipe_ack', { txHash: TX }), false);
  const bulky = { mint: MINT, token: TOKEN, txHash: TX, launchTx: TX, launchTxHash: TX,
    pendingTxHash: TX, blockHash: BLOCK, receiptBlockHash: BLOCK, parentHash: BLOCK };
  assert.equal(second.record('snipe_race_outcome', bulky), false);
  assert.equal(second.record('watch_stopped'), true);
  const results = await Promise.all([first.close(), second.close()]);
  assert.deepEqual(results.map(result => [result.written, result.dropped, result.failed]), [[2, 1, false], [1, 1, false]]);
  assert.equal((await load(rootDir, first.fileName)).at(-1).dropped, 1);
});

test('a reports directory that resolves outside the workspace is refused', async t => {
  const rootDir = await sandbox(t);
  const outside = await sandbox(t);
  await symlink(outside, join(rootDir, 'reports'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSnipeRunRecorder({ rootDir, targets: [target], armBlock: 41 }), /无法创建狙击测速记录/);
  await assert.rejects(findLatestSnipeReport(rootDir), /escaped workspace/);
});

test('recovers the newest report across processes without creating a folder while idle', async t => {
  const root = await sandbox(t);
  assert.equal(await findLatestSnipeReport(root), null);
  const dir = join(root, 'reports', 'snipe-runs');
  await mkdir(dir, { recursive: true });
  for (const file of [
    'snipe-2026-11-13T21-30-00-900Z-1111111111.ndjson',
    'snipe-2026-11-14T21-30-00-001Z-2222222222.ndjson',
    'snipe-does-not-match.ndjson',
  ]) await writeFile(join(dir, file), '');
  await mkdir(join(dir, 'snipe-2027-01-01T00-00-00-000Z-3333333333.ndjson'));
  assert.equal(await findLatestSnipeReport(root), 'reports/snipe-runs/snipe-2026-11-14T21-30-00-001Z-2222222222.ndjson');
});

test('receipt index enrichment only uses canonical observations and deduplicates independently of send', { timeout: 2000 }, async () => {
  const rows = [], calls = [];
  const launch = '0x' + '7b'.repeat(32), fork = '0x' + 'aa'.repeat(32);
  const observer = createSnipeReceiptObserver({
    launchDelayMs: 50,
    record: (event, fields) => rows.push([event, fields]),
    provider: {
      async getBlock(height) { return { number: height, hash: BLOCK }; },
      async getTransactionReceipt(hash) {
        calls.push(hash);
        if (hash === launch) return { hash, status: 1, index: 82, blockNumber: 42, blockHash: BLOCK,
          logs: [{ address: MINT, topics: [CORLA_LAUNCH_TOPIC, '0x' + '0'.repeat(24) + TOKEN.slice(2)] }] };
        return { hash, status: 0, index: 85, blockNumber: 42, blockHash: hash === fork ? fork : BLOCK, gasUsed: 337_978n };
      },
    },
  });
  try {
    observer.observe('snipe_send', { txHash: TX, receiptBlock: 42 });
    observer.observe('snipe_detected', { mint: MINT, token: TOKEN, launchBlock: 42, launchTx: launch });
    for (let i = 0; i < 2; i++) observer.observe('snipe_race_outcome', {
      mint: MINT, token: TOKEN, txHash: TX, receiptBlock: 42, launchBlock: 42, attempt: 1, status: 'failed',
    });
    observer.observe('buy', { txHash: fork, receiptBlock: 42, status: 'failed' });
    for (let i = 0; i < 40 && (rows.length < 2 || calls.length < 3); i++) await delay(15);
    assert.deepEqual(calls, [launch, TX, fork]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(([event, fields]) => [event, fields.launchIndex ?? fields.receiptIndex, fields.success]),
      [['snipe_launch_index', 82, undefined], ['snipe_receipt', 85, false]]);
    assert.equal(rows[1][1].blockOffset, 0);
  } finally { await observer.close(); }
});

test('delayed first-buy comparison sorts by block and index, ignores sells, and reports scanned absence', { timeout: 2000 }, async () => {
  const rows = [], queries = [];
  const launch = '0x' + '7a'.repeat(32), secondLaunch = '0x' + '7b'.repeat(32);
  const pool = '0x' + 'af'.repeat(20), next = '0x' + 'ef'.repeat(32);
  const sell = '0x' + '5a'.repeat(32), laterBuy = '0x' + '5b'.repeat(32);
  const abi = new Interface(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']);
  const log = (hash, blockNumber, transactionIndex, amounts) => ({
    address: pool, transactionHash: hash, blockNumber, transactionIndex, blockHash: blockNumber === 42 ? BLOCK : next,
    ...abi.encodeEventLog('Swap', [MINT, ...amounts, TOKEN]),
  });
  const topic = addr => '0x' + '0'.repeat(24) + addr.slice(2);
  const observer = createSnipeReceiptObserver({
    launchDelayMs: 0,
    record: (event, fields) => rows.push([event, fields]),
    provider: {
      async getBlock(height) { return { number: height, hash: height === 42 ? BLOCK : next }; },
      async getBlockNumber() { return 44; },
      async getTransactionReceipt(hash) {
        return { hash, status: 1, index: 82, blockNumber: 42, blockHash: BLOCK,
          logs: [{ address: MINT, topics: [CORLA_LAUNCH_TOPIC, topic(TOKEN), topic(pool)] }] };
      },
      async getLogs(query) {
        queries.push(query);
        if (queries.length > 1) return [];
        return [
          log(laterBuy, 43, 1, [0n, 100n, 50n, 0n]),
          log(sell, 42, 83, [100n, 0n, 0n, 50n]),
          log(TX, 42, 84, [0n, 150n, 70n, 0n]),
        ];
      },
    },
  });
  try {
    observer.observe('snipe_detected', { mint: MINT, token: TOKEN, pool, launchBlock: 42, launchTx: launch });
    for (let i = 0; i < 40 && rows.length < 2; i++) await delay(10);
    assert.equal(rows[1][0], 'snipe_first_buy');
    assert.equal(rows[1][1].txHash, TX);
    assert.equal(rows[1][1].receiptIndex, 84);
    assert.equal(rows[1][1].blockOffset, 0);
    assert.equal(rows[1][1].amountIn, 150n);
    observer.observe('snipe_detected', { mint: MINT, token: TOKEN, pool, launchBlock: 42, launchTx: secondLaunch });
    for (let i = 0; i < 40 && rows.length < 4; i++) await delay(10);
    assert.equal(rows[3][0], 'snipe_first_buy');
    assert.equal(rows[3][1].status, 'no_buy_seen');
    assert.equal(rows[3][1].scanToBlock, 44);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.address === pool && query.fromBlock === 42 && query.toBlock === 44));
  } finally { await observer.close(); }
});
