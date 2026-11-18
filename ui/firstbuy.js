// A UI projection only. The server must independently validate the plan,
// account/nonce exclusivity, code, floor, deadlines and every money movement.
// Importing or mounting this module never deploys, funds, arms or starts a job.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = '0x' + '0'.repeat(40);
const UINT = /^(?:0|[1-9]\d{0,77})$/;
const ID = /^[A-Za-z0-9:_-]{8,160}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MODES = Object.freeze({ pending: '等待末笔 Pending', guarded: '预置首买 · 限额竞争' });
const DRAFT_KEYS = new Set(['targetUrl', 'executorAddress', 'amountBnb', 'maxAttempts', 'windowBlocks',
  'deadlineSeconds', 'gasLimitCap', 'maxGasPriceGwei', 'gasBudgetBnb', 'maxTotalBnb', 'ownerAddress', 'callerAddresses']);
const STATE_LABELS = Object.freeze({
  unavailable: ['未接入', '当前服务尚未启用预置首买接口。原来的 Pending 模式不会被自动替换。'],
  not_deployed: ['未部署', '先核对部署预览；部署会消耗 BNB Gas，不会在准备时自动执行。'],
  not_configured: ['未配置', '选择目标、执行钱包和限额，再生成只读准备结果。'],
  prepared: ['已准备', '准备仅为只读检查；还需完成服务端列出的链上预置与授权。'],
  awaiting_authorization: ['待授权 / 预置', '执行器尚未完成链上授权、资金或目标预置；不能开始竞争。'],
  ready: ['已就绪', '已通过当前检查。仍需确认启动；不能保证主网首笔或一定成交。'],
  running: ['竞争中', '按区块、时间、尝试次数和 Gas 总预算限制投递；失败尝试同样会消耗 Gas。'],
  settling: ['结果待确认', '只核对原交易和链上单次成功锁，不重新签名或盲目开启新 nonce。'],
  succeeded: ['已成功一次', '该项目的单次成功锁已消耗，不能再次启动买入。'],
  missed: ['首买已错过', '初始池状态已被其他买入或变动改变，停止继续追价；已有交易仍需核对。'],
  exhausted: ['竞争额度已用尽', '尝试次数或 Gas 额度已到上限，不再创建新买单；失败尝试也计入额度。'],
  cancelled: ['预置已取消', '链上取消成熟后可预览撤回闲置本金；取消不代表在途交易从网络消失。'],
  expired: ['窗口已结束', '停止新投递；已在途交易仍须核对，不因窗口结束就自动解锁。'],
  stopped: ['已停止', '已停止新投递；在途交易仍可能上链。'],
  blocked: ['被检查拦截', '请处理下方未满足条件，不会自动放宽价格或预算。'],
});

const address = (value, label, optional = false) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !ADDRESS.test(value) || value.toLowerCase() === ZERO) throw new Error(label + '无效');
  return value.toLowerCase();
};
function integer(value, label, min, max) {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}范围为 ${min}–${max}`);
  return value;
}
function decimal(value, label, decimals) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,30})(?:\.\d+)?$/.test(value)) throw new Error(label + '须填写普通十进制数字');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(label + '精度过高');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
  if (units <= 0n || units > MAX_UINT256) throw new Error(label + '须大于 0');
  return units;
}
function rawUint(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= MAX_UINT256 ? value : null;
  if (typeof value === 'string' && UINT.test(value)) {
    const n = BigInt(value);
    return n <= MAX_UINT256 ? n : null;
  }
  return null;
}
export function firstBuyFormatBnb(value) {
  const units = rawUint(value);
  if (units === null) return '待核验';
  const whole = units / 10n ** 18n, fraction = (units % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''} BNB`;
}

/** No arbitrary minOut can be entered into this form: it comes from a proved server plan. */
export function parseFirstBuyDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !DRAFT_KEYS.has(key))) {
    throw new Error('首买配置包含不支持的字段');
  }
  let url;
  try { url = new URL(input.targetUrl); } catch { throw new Error('请选择完整的 Corla v4 项目链接'); }
  const target = /^\/apps\/corla\/mint\/(0x[0-9a-fA-F]{40})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://flap.sh' || url.username || url.password || url.hash || !target ||
      url.searchParams.getAll('mint').length !== 1 || url.searchParams.getAll('factory').length !== 1 ||
      url.searchParams.getAll('catalogVersion').length !== 1 || url.searchParams.get('catalogVersion') !== '4' ||
      url.searchParams.get('factory')?.toLowerCase() !== '0xfba753f8b890eb35caa000c427f99ed5903ea517') {
    throw new Error('仅支持明确指定的 Corla v4 项目');
  }
  const token = address(target[1], 'Token'), mint = address(url.searchParams.get('mint'), 'Mint');
  if (token === mint) throw new Error('Token 与 Mint 不能相同');
  const executorAddress = address(input.executorAddress, '执行器地址', true);
  const ownerAddress = address(input.ownerAddress, '部署 / 预置钱包');
  if (!Array.isArray(input.callerAddresses) || input.callerAddresses.length !== 1) {
    throw new Error('当前首买版本仅支持一个执行钱包');
  }
  const callerAddresses = input.callerAddresses.map(value => address(value, '执行钱包'));
  if (callerAddresses[0] !== ownerAddress) throw new Error('当前执行钱包必须与部署 / 预置钱包相同');
  const draft = {
    targetUrl: url.href, executorAddress, amountBnb: input.amountBnb,
    maxAttempts: integer(input.maxAttempts, '最多尝试次数', 1, 1024),
    windowBlocks: integer(input.windowBlocks, '最长竞争区块数', 1, 2400),
    deadlineSeconds: integer(input.deadlineSeconds, '最长竞争时间', 10, 1800),
    gasLimitCap: integer(input.gasLimitCap, '每笔 Gas 上限', 400_000, 1_660_000),
    maxGasPriceGwei: input.maxGasPriceGwei, gasBudgetBnb: input.gasBudgetBnb, maxTotalBnb: input.maxTotalBnb,
    ownerAddress, callerAddresses,
  };
  const amount = decimal(draft.amountBnb, '买入金额', 18);
  const gasPrice = decimal(draft.maxGasPriceGwei, '最高 Gas 价格', 9);
  const gasBudget = decimal(draft.gasBudgetBnb, '竞争 Gas 总预算', 18);
  const total = decimal(draft.maxTotalBnb, '买入与竞争总预算', 18);
  const worstGas = BigInt(draft.maxAttempts) * BigInt(draft.gasLimitCap) * gasPrice;
  if (worstGas > MAX_UINT256 || gasBudget < worstGas) throw new Error('竞争 Gas 总预算不足以覆盖填写的全部尝试上限');
  if (amount + worstGas > total) throw new Error('总预算不足以覆盖一次买入和全部尝试的最坏 Gas');
  return Object.freeze({ ...draft, callerAddresses: Object.freeze(callerAddresses) });
}

export function firstBuyBudget(draft) {
  const checked = parseFirstBuyDraft(draft);
  const amount = decimal(checked.amountBnb, '买入金额', 18), gas = BigInt(checked.maxAttempts) * BigInt(checked.gasLimitCap) *
    decimal(checked.maxGasPriceGwei, '最高 Gas 价格', 9);
  return Object.freeze({ amountWei: amount.toString(), attemptsGasWei: gas.toString(), maxSpendWei: (amount + gas).toString(),
    gasBudgetWei: decimal(checked.gasBudgetBnb, '竞争 Gas 总预算', 18).toString(),
    note: '按项目全局尝试上限计算；部署、授权、预置与撤回的 Gas 另行预览，不包含在竞争 Gas 中。' });
}

/** Read-only telemetry; never infer actual paid Gas from conservative reservation. */
export function firstBuyRunTelemetry(server, { previous = null, maxAttempts, report } = {}) {
  const validAttempts = value => Number.isSafeInteger(value) && value >= 0 && value <= 1024;
  const cap = typeof maxAttempts === 'string' && /^(?:[1-9]\d*)$/.test(maxAttempts) ? Number(maxAttempts) : maxAttempts;
  const checkedCap = Number.isSafeInteger(cap) && cap >= 1 && cap <= 1024 ? cap : null;
  const gas = rawUint(server?.gasReserved);
  const validPrevious = previous && validAttempts(previous.attempts) && rawUint(previous.gasReserved) !== null;
  const record = validAttempts(server?.attempts) && gas !== null
    ? { attempts: server.attempts, gasReserved: gas.toString(), maxAttempts: checkedCap }
    : validPrevious ? previous : null;
  const active = server?.running === true || server?.unknownSubmission === true || ['running', 'settling'].includes(server?.status);
  const last = Boolean(record && (!active || !validAttempts(server?.attempts) || gas === null));
  const recordedCap = Number.isSafeInteger(record?.maxAttempts) && record.maxAttempts >= 1 && record.maxAttempts <= 1024 ? record.maxAttempts : null;
  const prefix = last ? '上次：' : '';
  // A relative known recorder filename only. It is never used as a URL, link or request path.
  const reportPath = typeof report === 'string' && report.length <= 200 && /^reports\/snipe-runs\/snipe-[\w-]+\.ndjson$/.test(report) ? report : null;
  return { record, last, reportPath,
    attemptsText: record ? `${prefix}${record.attempts} / ${recordedCap ?? '上限待核验'} 次` : '待读取运行记录',
    gasText: record ? prefix + firstBuyFormatBnb(record.gasReserved) : '待读取运行记录' };
}

function date(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
export function firstBuyReadiness(value, now = Date.now()) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  let status = Object.hasOwn(STATE_LABELS, state.status) ? state.status : 'unavailable';
  if (state.running === true) status = 'running';
  if (state.unknownSubmission === true) status = 'settling';
  if (state.succeeded === true) status = 'succeeded';
  const plan = state.prepared && typeof state.prepared === 'object' ? state.prepared : {};
  const expiry = date(plan.expiresAt ?? state.expiresAt);
  if (expiry !== null && expiry <= now && !['running', 'settling', 'succeeded'].includes(status)) status = 'expired';
  const requirements = Array.isArray(state.requirements) ? state.requirements.slice(0, 24).map(row => ({
    code: typeof row?.code === 'string' && /^[a-z0-9_-]{1,48}$/.test(row.code) ? row.code : 'unknown',
    label: typeof row?.label === 'string' ? row.label.slice(0, 200) : '未知检查', met: row?.met === true,
  })) : [];
  const observed = date(state.observedAt ?? state.checkedAt);
  const fresh = observed !== null && observed <= now && now - observed <= 15_000;
  const floor = state.floor && typeof state.floor === 'object' ? state.floor : {};
  const hasFloor = floor.verified === true && (rawUint(floor.minOutRaw) ?? 0n) > 0n;
  const planId = ID.test(plan.planId ?? state.planId ?? '') ? (plan.planId ?? state.planId) : null;
  const contract = typeof state.contractAddress === 'string' && ADDRESS.test(state.contractAddress) && state.contractAddress.toLowerCase() !== ZERO;
  const canStart = status === 'ready' && state.liveReady === true && state.chainId === 56 && fresh && expiry !== null && expiry > now &&
    contract && planId !== null && hasFloor && requirements.length > 0 && requirements.every(row => row.met);
  return Object.freeze({ status, label: STATE_LABELS[status][0], copy: STATE_LABELS[status][1], requirements,
    canStart, canStop: status === 'running' || status === 'settling', fresh, planId,
    modes: MODES, liveReady: state.liveReady === true });
}

const PREVIEW_ROUTES = Object.freeze({ deploy: 'firstbuy/deploy-preview', arm: 'firstbuy/arm-preview', start: 'firstbuy/start',
  cancel: 'firstbuy/cancel-preview', withdraw: 'firstbuy/withdraw-preview' });
const COMMIT_ROUTES = Object.freeze({ deploy: 'firstbuy/deploy', arm: 'firstbuy/arm', start: 'firstbuy/start',
  cancel: 'firstbuy/cancel', withdraw: 'firstbuy/withdraw' });
const EXIT_OPERATIONS = new Set(['cancel', 'withdraw']);
function exitDraft(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['executorAddress', 'ownerAddress'].includes(key))) {
    throw new Error('退出操作只允许核对执行器和所有者，不接受自填撤回金额');
  }
  return { executorAddress: address(input.executorAddress, '执行器地址'), ownerAddress: address(input.ownerAddress, '所有者钱包') };
}

/** Only a page preference: it never writes or migrates the old strategy config. */
export function firstBuyModeProjection(selected, { legacyActive = false, guardedActive = false, busy = false } = {}) {
  const mode = guardedActive ? 'guarded' : legacyActive ? 'pending' : selected === 'pending' ? 'pending' : 'guarded';
  return Object.freeze({ mode, showGuarded: mode === 'guarded', showLegacy: mode === 'pending',
    selectionDisabled: legacyActive || guardedActive || busy });
}

/** Restore exit controls after a restart without overwriting deliberate edits. */
export function firstBuyRegisteredSelection(server, { ownerAddress = '', executorAddress = '', ownerEdited = false,
  executorEdited = false, walletAddresses = [] } = {}) {
  const registeredOwner = ADDRESS.test(server?.ownerAddress ?? '') && server.ownerAddress.toLowerCase() !== ZERO ? server.ownerAddress : null;
  const registeredExecutor = ADDRESS.test(server?.contractAddress ?? '') && server.contractAddress.toLowerCase() !== ZERO ? server.contractAddress : null;
  const available = new Set(walletAddresses.filter(value => ADDRESS.test(value ?? '')).map(value => value.toLowerCase()));
  const selectedOwner = !ownerEdited && registeredOwner && available.has(registeredOwner.toLowerCase()) ? registeredOwner.toLowerCase() : ownerAddress;
  const selectedExecutor = !executorEdited && !executorAddress && registeredExecutor ? registeredExecutor : executorAddress;
  return { ownerAddress: selectedOwner, executorAddress: selectedExecutor, registeredOwner, registeredExecutor,
    changed: selectedOwner !== ownerAddress || selectedExecutor !== executorAddress };
}

/** Separate confirmations; no action is inferred from a returned URL or arbitrary request object. */
export function createFirstBuyController({ api, onChange = () => {}, now = Date.now } = {}) {
  if (typeof api !== 'function' || typeof now !== 'function' || typeof onChange !== 'function') throw new Error('首买界面缺少本地接口');
  let server = null, busy = false, preview = null, error = '', uncertain = false, stopped = false;
  let preparedFingerprint = null, preparedPlanId = null, draftEpoch = 0;
  const value = () => {
    const readiness = firstBuyReadiness(server, now());
    return { server, busy, preview, error, uncertain, draftPrepared: preparedFingerprint !== null,
      readiness: { ...readiness, canStart: readiness.canStart && preparedFingerprint !== null && readiness.planId === preparedPlanId } };
  };
  const emit = () => { try { onChange(value()); } catch { /* presentation must not repeat a transaction */ } };
  async function invoke(operation, task, money = false) {
    if (stopped || busy) throw new Error('首买操作正在处理');
    if (money && uncertain) throw new Error('上一项提交结果待确认，请先核对原交易');
    busy = true; error = ''; emit();
    try { return await task(); }
    catch (e) {
      error = typeof e?.message === 'string' ? e.message.slice(0, 400) : '本地首买接口暂不可用';
      if (money) uncertain = true;
      throw e;
    } finally { busy = false; emit(); }
  }
  function adopt(result) {
    if (result?.state && typeof result.state === 'object') server = result.state;
    else if (result?.status && typeof result.status === 'string' && result.status !== 'preview') server = result;
    if (server?.submissionResolved === true) uncertain = false;
    if (preparedPlanId !== null && firstBuyReadiness(server, now()).planId !== preparedPlanId) {
      preparedFingerprint = preparedPlanId = null;
    }
  }
  return {
    value,
    async refresh() {
      return invoke('refresh', async () => { const result = await api('firstbuy/status'); adopt(result); return value(); });
    },
    async prepare(draft) {
      const checked = parseFirstBuyDraft(draft);
      const epoch = draftEpoch;
      return invoke('prepare', async () => {
        preview = null; preparedFingerprint = preparedPlanId = null;
        adopt(await api('firstbuy/prepare', checked));
        if (epoch === draftEpoch && firstBuyReadiness(server, now()).planId !== null) {
          preparedFingerprint = JSON.stringify(checked);
          preparedPlanId = firstBuyReadiness(server, now()).planId;
        }
        return value();
      });
    },
    async requestPreview(operation, draft) {
      if (!Object.hasOwn(PREVIEW_ROUTES, operation)) throw new Error('不支持的首买操作');
      const checked = EXIT_OPERATIONS.has(operation) ? exitDraft(draft) : parseFirstBuyDraft(draft);
      if (operation === 'start' && (!value().readiness.canStart || JSON.stringify(checked) !== preparedFingerprint)) {
        throw new Error('首买检查未全部满足或参数已变化，请先为当前参数重新准备');
      }
      return invoke('preview', async () => {
        const planId = firstBuyReadiness(server, now()).planId;
        const result = await api(PREVIEW_ROUTES[operation], operation === 'start'
          ? { planId, confirmed: false } : { draft: checked });
        const id = result?.previewId ?? result?.id;
        const expiresAt = date(result?.expiresAt);
        if (!ID.test(id ?? '') || expiresAt === null || expiresAt <= now() || expiresAt - now() > 300_000 ||
            (result.operation !== undefined && result.operation !== operation)) throw new Error('交易预览无效或已过期');
        const summary = (Array.isArray(result.summary) ? result.summary : [result.summary]).filter(row => typeof row === 'string')
          .slice(0, 16).map(row => row.slice(0, 300));
        if (!summary.length) throw new Error('交易预览缺少操作与费用摘要');
        preview = Object.freeze({ operation, previewId: id, expiresAt, planId, summary: Object.freeze(summary) });
        emit(); return preview;
      });
    },
    cancelPreview() { if (busy) return; preview = null; emit(); },
    invalidateDraft() {
      draftEpoch++;
      preparedFingerprint = preparedPlanId = null;
      preview = null;
      emit();
    },
    async confirm() {
      const selected = preview;
      if (!selected || selected.expiresAt <= now()) throw new Error('请重新生成有效交易预览');
      if (selected.operation === 'start' && !value().readiness.canStart) throw new Error('准备结果已失效，不能启动');
      return invoke('commit', async () => {
        // Consume before awaiting: errors/timeouts cannot leave a one-click replay.
        preview = null;
        const result = await api(COMMIT_ROUTES[selected.operation], { previewId: selected.previewId,
          ...(selected.operation === 'start' ? { planId: selected.planId } : {}), confirmed: true });
        adopt(result);
        if (selected.operation !== 'start') preparedFingerprint = preparedPlanId = null;
        return value();
      }, true);
    },
    async stop() {
      return invoke('stop', async () => { preview = null; adopt(await api('firstbuy/stop', {})); return value(); });
    },
    close() { stopped = true; preview = null; },
  };
}

const PANEL = `
  <section class="panel firstbuy-panel" aria-labelledby="firstbuy-title">
    <div class="panel-heading"><div><h2 id="firstbuy-title">预置首买 · 限额竞争</h2><p>独立于等待末笔 Pending 的模式；提前准备，不承诺主网首笔。</p></div><span data-firstbuy="status" class="badge" role="status">未接入</span></div>
    <div class="panel-form">
      <p data-firstbuy="copy" class="hint"></p>
      <div data-firstbuy="notice" class="notice" role="status" hidden></div>
      <form data-firstbuy="form" class="settings-stack">
        <div class="field-grid">
          <label class="field"><span>目标项目</span><select name="targetUrl" required aria-label="预置首买目标"></select></label>
          <label class="field"><span>单次买入额 <small>BNB</small></span><input name="amountBnb" inputmode="decimal" value="0.05" required></label>
          <label class="field"><span>项目全局最多尝试 <small>次</small></span><input name="maxAttempts" type="number" min="1" max="1024" value="120" required></label>
          <label class="field"><span>最长竞争区块数</span><input name="windowBlocks" type="number" min="1" max="2400" value="600" required></label>
          <label class="field"><span>最长竞争时间 <small>秒</small></span><input name="deadlineSeconds" type="number" min="10" max="1800" value="300" required></label>
          <label class="field"><span>竞争 Gas 总预算 <small>BNB</small></span><input name="gasBudgetBnb" inputmode="decimal" value="0.0084" required></label>
        </div>
        <details><summary>执行器、钱包与费用上限</summary><div class="field-grid">
          <label class="field"><span>执行器合约地址 <small>未部署可留空</small></span><input name="executorAddress" autocomplete="off" spellcheck="false" placeholder="0x…"></label>
          <label class="field"><span>部署 / 预置钱包</span><select name="ownerAddress" required></select></label>
          <label class="field"><span>每笔 Gas 上限</span><input name="gasLimitCap" type="number" min="400000" max="1660000" value="700000" required></label>
          <label class="field"><span>最高 Gas 价格 <small>Gwei</small></span><input name="maxGasPriceGwei" inputmode="decimal" value="0.1" required></label>
          <label class="field"><span>买入与竞争总预算 <small>BNB</small></span><input name="maxTotalBnb" inputmode="decimal" value="0.5" required></label>
        </div><p data-firstbuy="caller" class="hint"></p></details>
        <p class="hint">失败尝试也花 Gas。区块窗口、时间、次数、预算中任一上限耗尽就停止新投递，并非一定持续到所填秒数。上面的总预算按一次成功买入和项目全部尝试计算；部署、授权、预置与撤回的 Gas 另行核对。</p>
        <dl class="stats">
          <div><dt>登记所有者</dt><dd data-firstbuy="owner">待读取</dd></div>
          <div><dt>执行器</dt><dd data-firstbuy="contract">未部署</dd></div>
          <div><dt>开盘储备锚点</dt><dd data-firstbuy="reserve">待核验</dd></div>
          <div><dt>最低到手量（只读）</dt><dd data-firstbuy="floor">待验证的服务端计划</dd></div>
          <div><dt>最坏买入＋竞争支出</dt><dd data-firstbuy="budget">待填写</dd></div>
          <div><dt>部署 / 预置 Gas（另算）</dt><dd data-firstbuy="setup-gas">确认预览后显示</dd></div>
          <div><dt>已用尝试 / 次数上限</dt><dd data-firstbuy="attempts">待读取运行记录</dd></div>
          <div><dt>竞争 Gas 保守占用</dt><dd data-firstbuy="gas-reserved">待读取运行记录</dd></div>
          <div><dt>本地运行记录</dt><dd class="firstbuy-report"><span data-firstbuy="report-path">启动后自动记录</span><button type="button" data-firstbuy-action="copy-report" class="btn secondary compact" hidden>复制路径</button></dd></div>
        </dl>
        <p class="hint">Gas 保守占用按已投递尝试的 Gas 上限与价格预留，不是实际扣费；失败尝试也占预算。停止后的保留值标为「上次」，实际费用以链上回执为准。运行记录路径相对于本项目目录。</p>
        <ul data-firstbuy="requirements" aria-label="首买启动前检查"></ul>
        <div class="form-actions">
          <button type="submit" class="btn secondary">准备与模拟 · 不发交易</button>
          <button type="button" data-firstbuy-action="deploy" class="btn secondary">部署预览</button>
          <button type="button" data-firstbuy-action="arm" class="btn secondary">预置 / 授权预览</button>
          <button type="button" data-firstbuy-action="start" class="btn primary" disabled>核对并启动首买</button>
          <button type="button" data-firstbuy-action="stop" class="btn stop" disabled>停止新投递</button>
          <button type="button" data-firstbuy-action="cancel-plan" class="btn secondary" disabled>取消预置预览</button>
          <button type="button" data-firstbuy-action="withdraw" class="btn secondary" disabled>撤回闲置本金预览</button>
          <button type="button" data-firstbuy-action="refresh" class="btn secondary compact">刷新状态</button>
        </div>
      </form>
    </div>
  </section>
  <dialog data-firstbuy="review" aria-labelledby="firstbuy-review-title">
    <div class="dialog-form">
    <div class="dialog-heading"><h2 id="firstbuy-review-title">核对主网操作</h2><button type="button" data-firstbuy-action="cancel" class="btn secondary compact" aria-label="关闭核对">关闭</button></div>
    <p data-firstbuy="review-copy" class="hint"></p><ul data-firstbuy="review-lines"></ul>
    <p class="hint">只有点击下方确认才提交。RPC 接收不等于成交；结果不明时只核对原交易。</p>
    <div class="form-actions"><button type="button" data-firstbuy-action="cancel" class="btn secondary">取消</button><button type="button" data-firstbuy-action="confirm" class="btn primary">确认本次操作</button></div>
    </div>
  </dialog>`;

/** All dynamic content uses textContent. api is the app's authenticated local API helper. */
export function mountFirstBuyPanel(container, { api, getTargets = () => [], getWallets = () => [], getDefaults = () => ({}),
  getReport = () => '', getBlockReason = () => '', onBusyChange = () => {}, onStateChange = () => {}, pollMs = 5_000 } = {}) {
  if (!container?.querySelector || typeof api !== 'function') throw new Error('无法挂载预置首买界面');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1_000 || pollMs > 60_000) throw new Error('首买状态刷新间隔无效');
  container.innerHTML = PANEL; // static trusted markup, never interpolates server data
  const doc = container.ownerDocument;
  const node = key => container.querySelector(`[data-firstbuy="${key}"]`);
  const form = node('form'), dialog = node('review');
  let closed = false, shownPreview, ownerEdited = false, executorEdited = false, lastRun = null;
  function paintCaller() {
    node('caller').textContent = form.elements.ownerAddress.value
      ? `当前执行钱包：${form.elements.ownerAddress.value}。本版本采用单钱包单 nonce lane，部署 / 预置与竞争由同一钱包完成。`
      : '请先导入并选择一个钱包。本版本只支持部署 / 预置钱包作为唯一执行钱包。';
  }
  function collectDraft() {
    const values = Object.fromEntries([...form.elements].filter(input => input.name && input.type !== 'checkbox').map(input => [input.name, input.value]));
    values.callerAddresses = [values.ownerAddress];
    return parseFirstBuyDraft(values);
  }
  function options() {
    const selected = form.elements.targetUrl.value, owner = form.elements.ownerAddress.value;
    const targets = getTargets().filter(row => row && typeof (typeof row === 'string' ? row : row.url) === 'string').slice(0, 32);
    const wallets = getWallets().filter(row => ADDRESS.test(row?.address ?? '') && row.address.toLowerCase() !== ZERO).slice(0, 32);
    form.elements.targetUrl.replaceChildren(...targets.map(row => {
      const option = doc.createElement('option'); option.value = typeof row === 'string' ? row : row.url;
      option.textContent = typeof row?.label === 'string' ? row.label.slice(0, 100) : option.value;
      option.selected = option.value === selected; return option;
    }));
    form.elements.ownerAddress.replaceChildren(...wallets.map(row => {
      const option = doc.createElement('option'); option.value = row.address.toLowerCase();
      option.textContent = `${row.name ?? row.label ?? '钱包'} ${row.address}`; option.selected = option.value === owner.toLowerCase(); return option;
    }));
    paintCaller();
  }
  function render(value) {
    if (closed) return;
    const { server, readiness, preview, busy, uncertain, error } = value;
    const registered = firstBuyRegisteredSelection(server, {
      ownerAddress: form.elements.ownerAddress.value, executorAddress: form.elements.executorAddress.value,
      ownerEdited, executorEdited, walletAddresses: getWallets().map(row => row.address),
    });
    node('owner').textContent = registered.registeredOwner ?? '尚未登记 / 待核验';
    if (registered.changed) {
      form.elements.ownerAddress.value = registered.ownerAddress;
      form.elements.executorAddress.value = registered.executorAddress;
      paintCaller();
      controller.invalidateDraft();
      return;
    }
    node('status').textContent = readiness.label;
    node('copy').textContent = readiness.copy;
    const blocked = getBlockReason();
    const notice = error || (uncertain ? '上一项提交结果待确认：不要重复点击部署、预置或启动，请先核对链上状态。' : '') || blocked;
    node('notice').textContent = notice; node('notice').hidden = !notice;
    node('contract').textContent = ADDRESS.test(server?.contractAddress ?? '') ? server.contractAddress : '未部署 / 待核验';
    node('reserve').textContent = typeof server?.expectedReserve?.display === 'string' ? server.expectedReserve.display.slice(0, 200) : '待核验';
    node('floor').textContent = typeof server?.floor?.display === 'string' ? server.floor.display.slice(0, 200) : '待验证的服务端计划';
    node('setup-gas').textContent = firstBuyFormatBnb(server?.estimatedGas?.setupWei);
    const telemetry = firstBuyRunTelemetry(server, { previous: lastRun, maxAttempts: form.elements.maxAttempts.value, report: getReport() });
    lastRun = telemetry.record;
    node('attempts').textContent = telemetry.attemptsText;
    node('gas-reserved').textContent = telemetry.gasText;
    node('report-path').textContent = telemetry.reportPath ?? '启动后自动记录';
    container.querySelector('[data-firstbuy-action="copy-report"]').hidden = !telemetry.reportPath;
    node('requirements').replaceChildren(...readiness.requirements.map(row => {
      const li = doc.createElement('li'); li.textContent = `${row.met ? '✓' : '未满足'} ${row.label}`; return li;
    }));
    for (const button of container.querySelectorAll('[data-firstbuy-action]')) {
      const action = button.dataset.firstbuyAction;
      if (action === 'copy-report') { button.disabled = !telemetry.reportPath; continue; }
      button.disabled = busy || (uncertain && !['refresh', 'stop', 'cancel'].includes(action));
      if (blocked && !['refresh', 'stop', 'cancel'].includes(action)) button.disabled = true;
      if (action === 'start') button.disabled ||= !readiness.canStart;
      if (action === 'stop') button.disabled ||= !readiness.canStop;
      if (['deploy', 'arm', 'withdraw'].includes(action)) button.disabled ||= server?.capabilities?.[action] !== true;
      if (action === 'cancel-plan') button.disabled ||= server?.capabilities?.cancel !== true;
    }
    form.querySelector('[type="submit"]').disabled = busy || uncertain || readiness.canStop || Boolean(blocked);
    if (preview && preview !== shownPreview) {
      shownPreview = preview;
      node('review-copy').textContent = preview.operation === 'start' ? '确认后将启动主网限额竞争，失败尝试也会产生 Gas。' :
        preview.operation === 'deploy' ? '部署执行器会发送一笔主网交易并消耗 Gas。不会自动注资或启动买入。' :
        preview.operation === 'cancel' ? '取消链上预置会发送主网交易并消耗 Gas；需核验取消成熟后才能释放相关预留。' :
        preview.operation === 'withdraw' ? '撤回金额由服务端核对合约余额与仍在预留的本金后确定；只向所有者撤回闲置本金，撤回 Gas 另算。' :
          '预置 / 授权可能发送主网交易。请逐项核对本金、费用、固定目标和最低到手量。';
      node('review-lines').replaceChildren(...preview.summary.map(text => { const li = doc.createElement('li'); li.textContent = text; return li; }));
      if (!dialog.open) dialog.showModal();
    } else if (!preview && dialog.open) { shownPreview = null; dialog.close(); }
    try { onBusyChange(busy); onStateChange(server, { uncertain, busy, readiness }); } catch { /* callback is display-only */ }
  }
  const controller = createFirstBuyController({ api, onChange: render });
  const handle = task => Promise.resolve().then(task).catch(error => {
    if (!closed) { node('notice').textContent = typeof error?.message === 'string' ? error.message.slice(0, 400) : '首买操作失败'; node('notice').hidden = false; }
  });
  const updateBudget = event => {
    if (event?.target?.name === 'ownerAddress') ownerEdited = true;
    if (event?.target?.name === 'executorAddress') executorEdited = true;
    controller.invalidateDraft();
    paintCaller();
    try { node('budget').textContent = firstBuyFormatBnb(firstBuyBudget(collectDraft()).maxSpendWei); }
    catch { node('budget').textContent = '请完善目标、钱包和预算'; }
  };
  const submit = event => { event.preventDefault(); void handle(() => controller.prepare(collectDraft())); };
  const click = event => {
    const button = event.target.closest?.('[data-firstbuy-action]');
    if (!button || !container.contains(button) || button.disabled) return;
    const action = button.dataset.firstbuyAction;
    if (action === 'copy-report') {
      void handle(async () => {
        const reportPath = firstBuyRunTelemetry(null, { report: getReport() }).reportPath;
        if (!reportPath) throw new Error('暂无有效的本地运行记录路径');
        const clipboard = doc.defaultView?.navigator?.clipboard;
        if (typeof clipboard?.writeText !== 'function') throw new Error('当前浏览器不支持复制，请手动复制显示的本地记录路径');
        await clipboard.writeText(reportPath);
        node('notice').textContent = '已复制项目目录下的运行记录路径。'; node('notice').hidden = false;
      });
      return;
    }
    if (getBlockReason() && !['refresh', 'stop', 'cancel'].includes(action)) return;
    if (action === 'cancel') controller.cancelPreview();
    else if (action === 'confirm') void handle(() => controller.confirm());
    else if (action === 'refresh') void handle(() => controller.refresh());
    else if (action === 'stop') void handle(() => controller.stop());
    else if (action === 'cancel-plan' || action === 'withdraw') void handle(() => controller.requestPreview(action === 'cancel-plan' ? 'cancel' : 'withdraw', {
      executorAddress: form.elements.executorAddress.value || (!executorEdited ? controller.value().server?.contractAddress : ''),
      ownerAddress: form.elements.ownerAddress.value,
    }));
    else void handle(() => controller.requestPreview(action, collectDraft()));
  };
  const cancel = event => { event.preventDefault(); controller.cancelPreview(); };
  form.addEventListener('submit', submit); form.addEventListener('input', updateBudget); form.addEventListener('change', updateBudget);
  container.addEventListener('click', click); dialog.addEventListener('cancel', cancel);
  options();
  const defaults = getDefaults();
  for (const [key, value] of Object.entries(defaults ?? {})) if (form.elements[key] && typeof value !== 'object') form.elements[key].value = String(value);
  render(controller.value());
  const visible = () => !closed && !container.closest('[hidden]') && doc.visibilityState !== 'hidden';
  const refresh = () => {
    if (!form.contains(doc.activeElement)) options();
    if (!controller.value().busy && !dialog.open) return handle(() => controller.refresh());
    return Promise.resolve();
  };
  const timer = setInterval(() => { if (visible() || controller.value().readiness.canStop) void refresh(); }, pollMs);
  if (visible()) void refresh();
  return {
    refresh,
    close() { closed = true; clearInterval(timer); controller.close();
      form.removeEventListener('submit', submit); form.removeEventListener('input', updateBudget); form.removeEventListener('change', updateBudget);
      container.removeEventListener('click', click); dialog.removeEventListener('cancel', cancel); if (dialog.open) dialog.close(); },
  };
}
