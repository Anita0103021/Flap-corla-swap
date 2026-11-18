import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createFirstBuyController, firstBuyBudget, firstBuyFormatBnb, firstBuyModeProjection, firstBuyReadiness, firstBuyRegisteredSelection, firstBuyRunTelemetry, parseFirstBuyDraft } from '../ui/firstbuy.js';

const account = '0x' + '11'.repeat(20), token = '0x' + '22'.repeat(20), mint = '0x' + '33'.repeat(20);
const executorAddress = '0x' + '44'.repeat(20);
const now = 1_800_000_000_000;
const draft = {
  targetUrl: `https://flap.sh/apps/corla/mint/${token}?mint=${mint}&factory=0xfba753f8b890eb35caa000c427f99ed5903ea517&catalogVersion=4&lang=zh`,
  executorAddress, amountBnb: '0.05', maxAttempts: '3', windowBlocks: '15', deadlineSeconds: '12',
  gasLimitCap: '500000', maxGasPriceGwei: '0.25', gasBudgetBnb: '0.001', maxTotalBnb: '0.5',
  ownerAddress: account, callerAddresses: [account],
};
const ready = () => ({ status: 'ready', liveReady: true, chainId: 56, contractAddress: executorAddress,
  observedAt: now, prepared: { planId: 'plan-12345678', expiresAt: now + 60_000 },
  floor: { verified: true, minOutRaw: '12345', display: '12345 MOCK（最小单位）' },
  requirements: [{ code: 'verified_code', label: '执行器代码一致', met: true }, { code: 'once_lock', label: '单次成功锁可用', met: true }],
});

test('guarded first-buy form has strict exact-wei budgets and cannot accept an arbitrary floor or caller duplication', () => {
  const checked = parseFirstBuyDraft(draft);
  assert.equal(checked.maxAttempts, 3);
  assert.equal(checked.gasLimitCap, 500000);
  assert.ok(Object.isFrozen(checked));
  assert.ok(Object.isFrozen(checked.callerAddresses));
  const budget = firstBuyBudget(draft);
  assert.equal(budget.amountWei, '50000000000000000');
  assert.equal(budget.attemptsGasWei, '375000000000000');
  assert.equal(budget.maxSpendWei, '50375000000000000');
  assert.equal(firstBuyFormatBnb(budget.maxSpendWei), '0.050375 BNB');
  assert.equal(firstBuyFormatBnb('900719925474099300000000000000000000'), '900719925474099300 BNB');
  for (const patch of [
    { amountBnb: '5e-2' }, { amountBnb: '0' }, { maxAttempts: 1025 }, { windowBlocks: '2.5' },
    { windowBlocks: 2401 }, { deadlineSeconds: 9 }, { deadlineSeconds: 1801 }, { gasLimitCap: 399999 }, { gasLimitCap: 1660001 },
    { gasBudgetBnb: '0.000374999999999999' }, { maxTotalBnb: '0.050374999999999999' },
    { callerAddresses: [account, account.toUpperCase().replace('0X', '0x')] },
    { callerAddresses: [token] },
    { minOutRaw: '1' }, { rpcUrl: 'https://private.invalid/credential' },
    { executorAddress: '0x' + '0'.repeat(40) }, { ownerAddress: token + '/path' },
    { targetUrl: draft.targetUrl.replace('https://flap.sh', 'https://flap.sh.attacker.invalid') },
    { targetUrl: draft.targetUrl + '&mint=' + mint },
  ]) assert.throws(() => parseFirstBuyDraft({ ...draft, ...patch }));
  assert.equal(parseFirstBuyDraft({ ...draft, executorAddress: '' }).executorAddress, '');
  const long = parseFirstBuyDraft({ ...draft, maxAttempts: 1024, windowBlocks: 2400, deadlineSeconds: 1800,
    gasBudgetBnb: '0.128', maxTotalBnb: '0.178' });
  assert.equal(long.maxAttempts, 1024);
  assert.equal(firstBuyBudget(long).maxSpendWei, '178000000000000000');
  assert.equal(parseFirstBuyDraft({ ...draft, deadlineSeconds: 10, gasLimitCap: 400000 }).deadlineSeconds, 10);
  assert.equal(parseFirstBuyDraft({ ...draft, gasLimitCap: 1660000, gasBudgetBnb: '0.002' }).gasLimitCap, 1660000);
});

test('run telemetry preserves exact conservative Gas, labels retained terminal counters and rejects arbitrary report paths', () => {
  const path = 'reports/snipe-runs/snipe-2026-01-01T00-00-00-000Z-0000000000.ndjson';
  const active = firstBuyRunTelemetry({ status: 'running', attempts: 3, gasReserved: '210000000000000' }, { maxAttempts: '120', report: path });
  assert.equal(active.attemptsText, '3 / 120 次');
  assert.equal(active.gasText, '0.00021 BNB');
  assert.equal(active.reportPath, path);
  assert.equal(active.last, false);
  const stopped = firstBuyRunTelemetry({ status: 'stopped' }, { previous: active.record, maxAttempts: '200', report: path });
  assert.equal(stopped.attemptsText, '上次：3 / 120 次');
  assert.equal(stopped.gasText, '上次：0.00021 BNB');
  assert.equal(stopped.last, true);
  const resumed = firstBuyRunTelemetry({ status: 'running', attempts: 0, gasReserved: '0' }, { previous: active.record, maxAttempts: 200 });
  assert.equal(resumed.attemptsText, '0 / 200 次');
  assert.equal(resumed.gasText, '0 BNB');
  assert.equal(firstBuyRunTelemetry({ status: 'running', attempts: 3, gasReserved: '1e18' }).record, null);
  assert.equal(firstBuyRunTelemetry({ status: 'running', attempts: 1025, gasReserved: '1' }).record, null);
  assert.equal(firstBuyRunTelemetry({ status: 'succeeded', attempts: 1, gasReserved: '1' }, { maxAttempts: 1 }).last, true);
  assert.equal(firstBuyRunTelemetry({ status: 'running', attempts: 1, gasReserved: '1' }, { maxAttempts: 0 }).attemptsText, '1 / 上限待核验 次');
  for (const report of ['https://attacker.invalid/file', '/reports/snipe-runs/snipe-a.ndjson',
    'reports/snipe-runs/../snipe-a.ndjson', 'reports/snipe-runs/snipe-a.ndjson?download=1',
    'reports/snipe-runs/snipe-a.ndjson\n', '<img src=x>', 'reports/snipe-runs/snipe-' + 'a'.repeat(300) + '.ndjson']) {
    assert.equal(firstBuyRunTelemetry(null, { report }).reportPath, null, report);
  }
});

test('mode preference never hides the active execution path or merges guarded and Pending controls', () => {
  assert.deepEqual(firstBuyModeProjection('guarded'), { mode: 'guarded', showGuarded: true, showLegacy: false, selectionDisabled: false });
  assert.equal(firstBuyModeProjection('pending').showGuarded, false);
  assert.equal(firstBuyModeProjection('guarded', { legacyActive: true }).mode, 'pending');
  assert.equal(firstBuyModeProjection('pending', { guardedActive: true }).mode, 'guarded');
  assert.equal(firstBuyModeProjection('guarded', { busy: true }).selectionDisabled, true);
});

test('saved owner and empty executor restore exit controls after restart, but explicit choices and clears are preserved', () => {
  const other = '0x' + '55'.repeat(20), server = { ownerAddress: account, contractAddress: executorAddress };
  const initial = { ownerAddress: other, executorAddress: '', walletAddresses: [other, account] };
  const restored = firstBuyRegisteredSelection(server, initial);
  assert.equal(restored.ownerAddress, account);
  assert.equal(restored.executorAddress, executorAddress);
  assert.equal(restored.registeredOwner, account);
  assert.equal(restored.changed, true);
  const deliberate = firstBuyRegisteredSelection(server, { ...initial, ownerEdited: true, executorEdited: true });
  assert.equal(deliberate.ownerAddress, other);
  assert.equal(deliberate.executorAddress, '');
  assert.equal(deliberate.changed, false);
  assert.equal(firstBuyRegisteredSelection(server, { ...initial, executorAddress: other }).executorAddress, other);
  assert.equal(firstBuyRegisteredSelection(server, { ...initial, walletAddresses: [other] }).ownerAddress, other,
    'a saved address no longer imported must not become a usable phantom wallet');
  const invalid = firstBuyRegisteredSelection({ ownerAddress: '<script>', contractAddress: 'https://private.invalid' }, initial);
  assert.equal(invalid.registeredOwner, null); assert.equal(invalid.registeredExecutor, null);
  assert.equal(invalid.changed, false);
});

test('cancel and withdrawal previews remain available without a target and cannot accept a user-entered withdrawal amount', async () => {
  const calls = [];
  const controller = createFirstBuyController({ now: () => now, api: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith('-preview')) return { previewId: 'preview-12345678', expiresAt: now + 10_000, summary: ['链上可撤回本金：0.05 BNB', 'Gas另算'] };
    return { status: 'stopped' };
  } });
  const exit = { executorAddress, ownerAddress: account };
  await controller.requestPreview('cancel', exit);
  assert.equal(calls.at(-1).path, 'firstbuy/cancel-preview');
  assert.deepEqual(calls.at(-1).body, { draft: exit });
  await controller.confirm();
  assert.equal(calls.at(-1).path, 'firstbuy/cancel');
  await controller.requestPreview('withdraw', exit);
  assert.equal(calls.at(-1).path, 'firstbuy/withdraw-preview');
  await controller.confirm();
  assert.deepEqual(calls.at(-1), { path: 'firstbuy/withdraw', body: { previewId: 'preview-12345678', confirmed: true } });
  await assert.rejects(controller.requestPreview('withdraw', { ...exit, amountBnb: '999' }), /不接受自填/);
});

test('a ready label alone is not authority: require fresh chain/plan/floor/proofs and fail closed on terminal or ambiguous state', () => {
  assert.equal(firstBuyReadiness(ready(), now).canStart, true);
  assert.equal(firstBuyReadiness({ status: 'ready', liveReady: true }, now).canStart, false);
  for (const patch of [
    { liveReady: false }, { chainId: 1 }, { observedAt: now - 15_001 }, { observedAt: now + 1 },
    { contractAddress: '' }, { floor: { verified: true, minOutRaw: '0' } },
    { floor: { verified: false, minOutRaw: '123' } }, { requirements: [] },
    { requirements: [{ code: 'nonce', label: '待核对', met: false }] },
    { prepared: { planId: 'plan-12345678', expiresAt: now } },
    { prepared: { planId: 'https://private.invalid', expiresAt: now + 1000 } },
    { unknownSubmission: true }, { succeeded: true }, { running: true },
  ]) assert.equal(firstBuyReadiness({ ...ready(), ...patch }, now).canStart, false, JSON.stringify(patch));
  assert.equal(firstBuyReadiness(null, now).status, 'unavailable');
  assert.equal(firstBuyReadiness({ ...ready(), unknownSubmission: true }, now).status, 'settling');
  for (const [status, label] of [['missed', '首买已错过'], ['exhausted', '竞争额度已用尽'], ['cancelled', '预置已取消']]) {
    const result = firstBuyReadiness({ ...ready(), status }, now);
    assert.equal(result.status, status);
    assert.equal(result.label, label);
    assert.equal(result.canStart, false);
    assert.equal(result.canStop, false);
  }
});

test('preparing/previewing does not commit; only explicit single-use confirmation calls the fixed write route', async () => {
  const calls = [], events = [];
  const controller = createFirstBuyController({ now: () => now, onChange: value => events.push(value),
    async api(path, body) {
      calls.push({ path, body });
      if (path === 'firstbuy/status' || path === 'firstbuy/prepare') return ready();
      if (path === 'firstbuy/deploy-preview') return { previewId: 'preview-12345678', operation: 'deploy', expiresAt: now + 30_000,
        summary: ['部署 Gas：0.0001 BNB'], request: { path: 'wallets/export', body: { secret: true } } };
      if (path === 'firstbuy/deploy') return { state: { status: 'not_configured', contractAddress: executorAddress } };
      assert.fail('unexpected route ' + path);
    },
  });
  assert.equal(calls.length, 0, 'construction must have no effects');
  await controller.refresh(); await controller.prepare(draft);
  await controller.requestPreview('deploy', draft);
  assert.deepEqual(calls.map(row => row.path), ['firstbuy/status', 'firstbuy/prepare', 'firstbuy/deploy-preview']);
  assert.equal(controller.value().preview.operation, 'deploy');
  await controller.confirm();
  assert.deepEqual(calls.at(-1), { path: 'firstbuy/deploy', body: { previewId: 'preview-12345678', confirmed: true } });
  await assert.rejects(controller.confirm(), /重新生成/);
  assert.equal(calls.filter(row => row.path === 'firstbuy/deploy').length, 1);
  assert.ok(!JSON.stringify(controller.value()).includes('wallets/export'));
  assert.ok(events.some(row => row.busy));
});

test('start requires authoritative readiness and a separate review; expired review never submits', async () => {
  const calls = []; let time = now;
  const controller = createFirstBuyController({ now: () => time, api: async (path, body) => {
    calls.push({ path, body });
    if (path === 'firstbuy/status' || path === 'firstbuy/prepare') return ready();
    if (path === 'firstbuy/start' && body.confirmed === false) return {
      previewId: 'preview-12345678', operation: 'start', expiresAt: now + 5_000, summary: ['最多 3 次，失败 Gas 计入预算'],
    };
    if (path === 'firstbuy/start' && body.confirmed === true) return { status: 'running', running: true };
    assert.fail('unexpected request');
  } });
  await assert.rejects(controller.requestPreview('start', draft), /未全部满足/);
  assert.equal(calls.length, 0);
  await controller.refresh();
  assert.equal(controller.value().readiness.canStart, false, 'refresh alone must not bind current form to an old server plan');
  await controller.prepare(draft); await controller.requestPreview('start', draft);
  assert.equal(calls.filter(row => row.path === 'firstbuy/start' && row.body.confirmed === true).length, 0);
  time += 5_001;
  await assert.rejects(controller.confirm(), /重新生成/);
  time = now; await controller.requestPreview('start', draft); await controller.confirm();
  assert.deepEqual(calls.at(-1).body, { previewId: 'preview-12345678', planId: 'plan-12345678', confirmed: true });
  assert.equal(controller.value().readiness.status, 'running');
});

test('editing the draft invalidates both preparation and a pending confirmation, including edits while prepare is in flight', async () => {
  const prepared = Promise.withResolvers(); let calls = 0, slow = false;
  const controller = createFirstBuyController({ now: () => now, api: async (path, body) => {
    calls++;
    if (path === 'firstbuy/prepare') return slow ? prepared.promise : ready();
    if (path === 'firstbuy/start' && body.confirmed === false) return { previewId: 'preview-12345678', expiresAt: now + 10_000, summary: ['review'] };
    assert.fail('unexpected route ' + path);
  } });
  await controller.prepare(draft);
  assert.equal(controller.value().readiness.canStart, true);
  await assert.rejects(controller.requestPreview('start', { ...draft, amountBnb: '0.06' }), /参数已变化/);
  assert.equal(calls, 1);
  await controller.requestPreview('start', draft);
  controller.invalidateDraft();
  assert.equal(controller.value().preview, null);
  await assert.rejects(controller.confirm(), /重新生成/);
  assert.equal(controller.value().readiness.canStart, false);
  slow = true;
  const work = controller.prepare(draft);
  controller.invalidateDraft();
  prepared.resolve(ready()); await work;
  assert.equal(controller.value().readiness.canStart, false, 'an old pending prepare response cannot revive changed parameters');
});

test('ambiguous submit consumes review and never retries or uses a new route; only explicit server reconciliation clears it', async () => {
  let writes = 0, resolved = false;
  const controller = createFirstBuyController({ now: () => now, api: async (path, body) => {
    if (path === 'firstbuy/status') return { ...ready(), submissionResolved: resolved };
    if (path === 'firstbuy/arm-preview') return { previewId: 'preview-12345678', expiresAt: now + 20_000, summary: ['预置目标'] };
    if (path === 'firstbuy/arm') { writes++; throw new Error('RPC disconnected'); }
    assert.fail('unexpected route ' + path);
  } });
  await controller.refresh(); await controller.requestPreview('arm', draft);
  await assert.rejects(controller.confirm(), /disconnected/);
  assert.equal(controller.value().preview, null); assert.equal(controller.value().uncertain, true);
  await assert.rejects(controller.confirm(), /重新生成/); assert.equal(writes, 1);
  await controller.refresh(); assert.equal(controller.value().uncertain, true);
  resolved = true; await controller.refresh(); assert.equal(controller.value().uncertain, false);
});

test('static panel has a read-only floor, explanatory costs, explicit paid reviews and no HTML interpolation', async () => {
  const code = await readFile(new URL('../ui/firstbuy.js', import.meta.url), 'utf8');
  assert.match(code, /最低到手量（只读）/);
  assert.match(code, /失败尝试也花 Gas/);
  assert.match(code, /部署、授权、预置与撤回的 Gas 另行核对/);
  assert.match(code, /已用尝试 \/ 次数上限/);
  assert.match(code, /竞争 Gas 保守占用/);
  assert.match(code, /data-firstbuy-action="copy-report"/);
  assert.match(code, /clipboard\.writeText\(reportPath\)/);
  assert.match(code, /name="deadlineSeconds"[^>]*min="10" max="1800"/);
  assert.match(code, /name="gasLimitCap"[^>]*min="400000" max="1660000"/);
  assert.ok(!/name="(?:minOut|amountOutMin|minOutRaw)"/.test(code));
  assert.equal((code.match(/\.innerHTML\s*=/g) ?? []).length, 1);
  assert.match(code, /container\.innerHTML = PANEL/);
  assert.ok(!/fetch\(|localStorage|privateKey|signTransaction/.test(code));
});

test('the main page mounts the guarded panel and switches controls without saving or starting old strategy', async () => {
  const [app, html] = await Promise.all(['app.js', 'index.html'].map(name => readFile(new URL('../ui/' + name, import.meta.url), 'utf8')));
  assert.match(app, /await import\('\.\/firstbuy\.js\?v=' \+ instance\)/);
  assert.ok(!/^import .*from '\.\/firstbuy\.js'/m.test(app), 'a missing new asset on an older backend must not abort the entire old app');
  assert.match(app, /后台尚未加载新版首买资源，需重启本地服务/);
  assert.match(html, /href="\/firstbuy\.css"/);
  assert.match(html, /id="firstbuy-workspace"/);
  assert.match(html, /<option value="guarded" selected>/);
  assert.match(html, /id="start-snipe"[^>]*hidden/);
  assert.match(app, /getReport: \(\) => state\.snipeReport/);
  const source = app.slice(app.indexOf('function syncSnipeStrategyView('), app.indexOf('async function mountFirstBuyWorkspace('));
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, value: '', textContent: '', dataset: {} }); return nodes.get(id); };
  const state = { running: false, firstBuyRunning: false, firstBuyBusy: false };
  const context = vm.createContext({ $, state, firstBuyUi: { firstBuyModeProjection } });
  vm.runInContext('let snipeStrategy = "guarded";\n' + source, context);
  vm.runInContext('syncSnipeStrategyView()', context);
  assert.equal($('firstbuy-workspace').hidden, false);
  assert.equal($('snipe-form').hidden, true);
  assert.equal($('start-snipe').hidden, true);
  state.running = true; state.workspace = 'snipe';
  vm.runInContext('syncSnipeStrategyView()', context);
  assert.equal($('snipe-strategy-mode').value, 'pending');
  assert.equal($('snipe-strategy-mode').disabled, true);
  assert.equal($('firstbuy-workspace').hidden, true);
  assert.equal($('snipe-form').hidden, false);
  state.firstBuyRunning = true; state.workspace = 'firstbuy';
  vm.runInContext('syncSnipeStrategyView()', context);
  assert.equal($('snipe-strategy-mode').value, 'guarded');
  assert.equal($('start-snipe').hidden, true);
  assert.equal($('firstbuy-workspace').hidden, false);
  assert.ok(!source.includes('api(') && !source.includes('saveConfig('));
});

test('an older service without the new module leaves the old app alive with a restart notice', async () => {
  const app = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  const selected = app.slice(app.indexOf('async function mountFirstBuyWorkspace('), app.indexOf('function renderControls('));
  const shown = []; let syncs = 0, requests = 0;
  const context = vm.createContext({
    localService: { instance: 'a'.repeat(16) },
    $: () => ({ replaceChildren: node => shown.push(node) }),
    element: (tag, className, textContent) => ({ tag, className, textContent }),
    syncSnipeStrategyView: () => { syncs++; }, api: () => { requests++; assert.fail('no request through a missing module'); },
  });
  // The VM deliberately has no dynamic-import loader, just like a failed
  // module fetch on a still-running older backend. The rejection must stay local.
  await vm.runInContext('let firstBuyPanel, firstBuyUi = null, firstBuyMountedInstance = "";\n' + selected + '\nmountFirstBuyWorkspace()', context);
  assert.equal(shown.length, 1);
  assert.match(shown[0].textContent, /后台尚未加载新版首买资源/);
  assert.match(shown[0].textContent, /不会自动启动任何交易/);
  assert.equal(syncs, 1);
  assert.equal(requests, 0);
});
