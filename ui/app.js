import { mintDefaultBatches, mintWalletFunding, mintWalletQuota } from './mint-wallet-selection.js';

const $ = id => document.getElementById(id);
const labels = { overview: 'Mint 工作区', snipe: '开盘狙击', discover: '代币看板', wallets: '钱包管理', settings: '预算与 Gas' };
const workspaceNames = { mint: 'Mint', snipe: '狙击' };
const state = {
  config: null, source: 'example', session: '', allowLive: false, wallets: [], walletVaultExists: false,
  walletLocalUnlock: false, walletLocalUnlockSupported: false,
  projects: [], logs: [], running: false, mode: 'idle', workspace: null, busy: '', starting: false, stopping: false,
  lastError: '', lastErrorWorkspace: null, editing: -1, pendingProjectRemove: null, pendingWalletRemove: null, liveReview: null,
  preview: null, configRevision: '', stateRevision: '', logCursor: '', reloadRequired: '', cancelingStartup: false,
  snipeReport: '',
};
const EXPLORER = 'https://bscscan.com';
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^(?:0|[1-9]\d*)$/;
const TOKEN_FACTORY = '0xfba753f8b890eb35caa000c427f99ed5903ea517';
const defaults = {
  snipe: { amountBnb: '0.01', walletCount: 1, minLiquidityBnb: '1', slippageBps: 1000, maxOpeningPremiumBps: 1000,
    maxPriceImpactBps: 1000, maxBuyTaxBps: 500, maxSellTaxBps: 500, windowBlocks: 15, deadlineSeconds: 12,
    scanMs: 350, repeatAttempts: 1, requirePreopen: false },
  outer: { maxTotalBnb: '0.5', maxGasPriceGwei: '0.25', gasLimitCap: 10_000_000, pollMs: 1200 },
};
const refreshJobs = new Map();
const refreshResults = new Map();
const SNIPE_PROGRESS_LAST_LOT_MS = 350;
const SNIPE_PROGRESS_LIVE_MS = 1200;
const SNIPE_PROGRESS_IDLE_MS = 2500;
const SNIPE_PROGRESS_BACKOFF_MS = 3800;
let snipeProgressTimer;
const participantCache = new Map();
const metadataCache = new Map();
const metadataQueue = new Map();
const failedImages = new Map();
const METADATA_RETRY_MS = 30_000;
const METADATA_TTL_MS = 10 * 60_000;
const CATALOG_LIMIT = 18;
const CATALOG_STATUS_LIMIT = 32;
const CATALOG_REFRESH_MS = 3000;
const CATALOG_TERMINAL_RECHECK_MS = 60_000;
const CATALOG_ENDING_SEC = 24 * 60 * 60;
const CATALOG_FUNDING_LIMIT = 18;
const RPC_POOL_LABELS = { dashboard: '看板与项目状态', metadata: '目录与代币信息', mint: 'Mint 与领币执行', watch: '开盘日志监听', snipe: '狙击报价与执行' };
const catalog = {
  rows: [], statuses: new Map(), lookups: new Map(), nextCursor: null, total: null, loaded: false,
  filter: 'all', sort: 'latest', query: '', busy: '', reading: 0, error: '', statusError: '',
  statusReadAt: new Map(), statusOffset: 0, lastUpdated: 0, lastBlock: 0, headBlock: 0, failures: 0,
  resumePending: false, morePending: false, pendingMetadata: new Map(),
  fundingRows: new Map(), fundingTimes: new Map(), fundingReading: false, fundingNextAt: 0,
};
let metadataInFlight = 0;
let configEpoch = 0;
let runEpoch = 0;
let pendingLiveStart;
let catalogSearchTimer;
let catalogAutoTimer;
let catalogFundingTimer;
let catalogPaintQueued = false;
let rpcStatusTimer;
let rpcStatusReading = false;
let rpcStatusSnapshot = '';
let currentView;
const viewPositions = new Map();
const NOTIFICATION_PREFS_KEY = 'corla-desk:notifications:v1';
const NOTIFICATION_SEEN_KEY = 'corla-desk:notifications:seen:v1';
const NOTIFICATION_SEEN_LIMIT = 384;
const notificationSeen = new Set();
let notificationPrefs = readNotificationPrefs();
let notificationStream, notificationRetry, notificationFailures = 0, notificationGeneration = 0;
let notificationStatus = 'idle', notificationPrompt = false, notificationUnsupported = false, notificationPageUnloaded = false;

function element(tag, cls = '', value) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (value !== undefined) el.textContent = value;
  return el;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
function setButton(button, label, glyph) { button.replaceChildren(icon(glyph), document.createTextNode(label)); }
function external(url, cls, text, glyph) {
  const link = element('a', cls, text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (glyph) link.append(icon(glyph));
  return link;
}
function iconAction(name, label, handler) {
  const button = element('button', 'icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.addEventListener('click', handler);
  return button;
}
function badge(label, tone = '') { return element('span', 'badge' + (tone ? ' ' + tone : ''), label); }
function short(value) {
  return typeof value === 'string' && value.length > 16 ? value.slice(0, 8) + '…' + value.slice(-6) : (value || '—');
}
function validAddress(value) { return HEX_ADDRESS.test(value || '') && !/^0x0{40}$/.test(value); }
function decimal(value, decimals, { allowZero = false } = {}) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('金额必须是正十进制数字');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals || whole.length > 24) throw new Error('金额超出范围或小数位过多');
  const n = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (!n && !allowZero) throw new Error('金额必须大于零');
  return n;
}
function formatUnits(value, decimals = 18) {
  try {
    const s = BigInt(value).toString().padStart(decimals + 1, '0');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return s.slice(0, -decimals) + (frac ? '.' + frac : '');
  } catch { return '—'; }
}
function parseLink(value) {
  const u = new URL(value);
  const path = /^\/apps\/corla\/mint\/(0x[\da-fA-F]{40})\/?$/.exec(u.pathname);
  const single = name => u.searchParams.getAll(name).length === 1 ? u.searchParams.get(name) : null;
  const token = path?.[1];
  const mint = single('mint');
  if (u.origin !== 'https://flap.sh' || u.username || u.password || !validAddress(token) || !validAddress(mint) ||
      token.toLowerCase() === mint.toLowerCase() || single('factory')?.toLowerCase() !== TOKEN_FACTORY || single('catalogVersion') !== '4') {
    throw new Error('请输入使用已核实工厂的 flap.sh Corla v4 Mint 链接。');
  }
  return { url: u.href, token, mint };
}
function parsedTarget(target) { try { return parseLink(target.url); } catch { return null; } }
function same(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function projectKey({ mint, token } = {}) {
  return validAddress(mint) && validAddress(token) ? mint.toLowerCase() + ':' + token.toLowerCase() : null;
}
function boundedSet(map, key, value, max = 512) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}
function metaText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}
function imageUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function tokenTitle(key, token) {
  const title = element('span', 'token-title');
  title.dataset.tokenTitle = key ?? '';
  title.dataset.tokenAddress = token ?? '';
  paintTokenTitle(title);
  return title;
}
function paintTokenTitle(title) {
  const meta = metadataCache.get(title.dataset.tokenTitle);
  const address = title.dataset.tokenAddress;
  const name = meta?.name || meta?.symbol;
  const ticker = meta?.symbol && (!name || name.toLowerCase() !== meta.symbol.toLowerCase()) ? meta.symbol : '';
  const text = element('strong', name ? 'token-name' : 'token-name mono', name || short(address));
  if (name) text.title = name;
  title.replaceChildren(text, ...(ticker ? [element('span', 'token-ticker', ticker)] : []));
}
function tokenPicture(key, glyph) {
  const picture = element('span', 'project-icon token-picture');
  picture.dataset.tokenPicture = key ?? '';
  picture.append(icon(glyph));
  paintTokenPicture(picture);
  return picture;
}
function paintTokenPicture(picture) {
  const url = metadataCache.get(picture.dataset.tokenPicture)?.image;
  if (!url || (failedImages.get(url)?.retryAt ?? 0) > Date.now() || picture.dataset.imageUrl === url) return;
  const previous = picture.querySelector('img.loaded');
  picture.querySelector('img:not(.loaded)')?.remove();
  picture.dataset.imageUrl = url;
  if (previous?.dataset.tokenImageUrl === url) return;
  const img = element('img', 'token-image');
  img.dataset.tokenImageUrl = url;
  img.alt = '';
  img.width = img.height = 34;
  img.decoding = 'async';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => {
    failedImages.delete(url);
    if (img.parentElement !== picture || picture.dataset.imageUrl !== url) return;
    previous?.remove();
    img.classList.add('loaded');
  }, { once: true });
  img.addEventListener('error', () => {
    if (img.parentElement !== picture || picture.dataset.imageUrl !== url) return;
    const old = failedImages.get(url);
    if (!old || old.retryAt <= Date.now()) {
      const attempts = Math.min((old?.attempts ?? 0) + 1, 5);
      boundedSet(failedImages, url, { attempts, retryAt: Date.now() + 15_000 * 2 ** (attempts - 1) }, 256);
    }
    delete picture.dataset.imageUrl;
    img.remove();
  }, { once: true });
  img.src = url;
  picture.append(img);
}
function paintMetadata(keys) {
  if (catalog.query && !$('view-discover').hidden) renderDiscover();
  for (const node of document.querySelectorAll('[data-token-title]')) if (keys.has(node.dataset.tokenTitle)) paintTokenTitle(node);
  for (const node of document.querySelectorAll('[data-token-picture]')) if (keys.has(node.dataset.tokenPicture)) paintTokenPicture(node);
  for (const node of document.querySelectorAll('[data-catalog-description],[data-catalog-supply]')) {
    const key = node.dataset.catalogDescription ?? node.dataset.catalogSupply;
    if (keys.has(key)) paintCatalogMetadata(node, key);
  }
}
function drainMetadata() {
  if (document.visibilityState !== 'visible' || state.reloadRequired === 'SESSION_EXPIRED') return;
  while (metadataInFlight < 2) {
    const rows = [...metadataQueue].filter(([, row]) => !row.started).slice(0, 8);
    if (!rows.length) return;
    const expected = new Set(rows.map(([key]) => key));
    const received = new Set();
    rows.forEach(([, row]) => { row.started = true; });
    metadataInFlight++;
    void api('project/metadata', { urls: rows.map(([, row]) => row.url) }).then(result => {
      const updated = new Set();
      for (const project of Array.isArray(result.projects) ? result.projects : []) {
        const key = projectKey(project ?? {});
        if (!expected.has(key)) continue;
        const meta = { name: metaText(project.name), symbol: metaText(project.symbol), image: imageUrl(project.image),
          description: typeof project.description === 'string' ? project.description.trim().slice(0, 240) : '',
          initialSupply: catalogInteger(project.initialSupply) };
        if (!meta.name && !meta.symbol && !meta.image && !meta.description && meta.initialSupply === null) continue;
        received.add(key);
        const old = metadataCache.get(key);
        const merged = { ...meta };
        for (const field of Object.keys(meta)) if ((meta[field] == null || meta[field] === '') && old?.[field] != null) merged[field] = old[field];
        const hint = Number(project.retryAfterMs);
        const ttl = hint > 0 && Number.isFinite(hint) ? Math.max(5000, Math.min(METADATA_RETRY_MS, hint)) : METADATA_TTL_MS;
        boundedSet(metadataCache, key, { ...merged, expires: Date.now() + ttl });
        if (!old || Object.keys(meta).some(field => old[field] !== merged[field])) updated.add(key);
      }
      if (updated.size) paintMetadata(updated);
    }).catch(() => { /* Metadata is optional and never blocks project state. */ }).finally(() => {
      for (const [key] of rows) {
        if (!received.has(key)) boundedSet(metadataCache, key, {
          ...metadataCache.get(key), expires: Date.now() + METADATA_RETRY_MS,
        });
        metadataQueue.delete(key);
      }
      metadataInFlight--;
      drainMetadata();
    });
  }
}
function queueMetadata(targets) {
  if (!state.session || state.reloadRequired === 'SESSION_EXPIRED') return;
  for (const target of targets) {
    if (metadataQueue.size >= 256) break;
    const parsed = parsedTarget(target);
    if (!parsed) continue;
    const key = projectKey(parsed);
    if (metadataQueue.has(key) || metadataCache.get(key)?.expires > Date.now()) continue;
    metadataQueue.set(key, { url: parsed.url });
  }
  drainMetadata();
}
function retryVisibleMetadata() {
  if (document.visibilityState !== 'visible' || !currentView || state.reloadRequired === 'SESSION_EXPIRED') return;
  if (currentView === 'discover') {
    const rows = [];
    for (const card of $('discover-results').children) {
      if (!card.dataset.catalogUrl) continue;
      const rect = card.getBoundingClientRect();
      if (rect.bottom < -200) continue;
      if (rect.top > window.innerHeight + 400) break;
      const picture = card.querySelector('[data-token-picture]');
      if (picture) paintTokenPicture(picture);
      rows.push({ url: card.dataset.catalogUrl });
      if (rows.length >= 18) break;
    }
    queueMetadata(rows);
  } else if (currentView === 'overview' || currentView === 'snipe') {
    for (const node of $('view-' + currentView).querySelectorAll('[data-token-picture]')) paintTokenPicture(node);
    queueMetadata(targetsOf(currentView === 'snipe' ? 'snipe' : 'mint'));
  }
}
function normalizeConfig(config) {
  const targets = config.targets ?? [];
  return { ...config,
    targets: targets.map(({ buyOnLaunch: _legacy, ...target }) => target),
    snipeTargets: config.snipeTargets ?? targets.filter(target => target.buyOnLaunch).map(target => target.url),
  };
}
function targetsOf(workspace, config = state.config) {
  return workspace === 'snipe' ? (config?.snipeTargets ?? []).map(url => ({ url }))
    : workspace === 'mint' ? (config?.targets ?? [])
    : [...targetsOf('mint', config), ...targetsOf('snipe', config)];
}
function projectSnapshot(url) {
  const parsed = parsedTarget({ url });
  if (!parsed) return null;
  const row = state.projects.find(p => projectKey(p) === projectKey(parsed) && !p.error);
  const listed = catalog.statuses.get(projectKey(parsed));
  return listed && !listed.error && Number(listed.block ?? 0) > Number(row?.block ?? 0) ? listed : row;
}
function matchWallets(target, wallets) {
  if (target.mintWallets === undefined) return wallets;
  const selected = target.mintWallets.map(address => wallets.find(wallet => same(wallet, address)));
  if (!selected.length || selected.some(wallet => !wallet)) throw new Error('有项目选择的钱包已移除或未选择钱包，请在 Mint 项目中重新选择。');
  return selected;
}
const fmtInt = new Intl.NumberFormat('zh-CN');
const fmtCompact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
const fmtScientific = new Intl.NumberFormat('zh-CN', { notation: 'scientific', maximumFractionDigits: 2 });
const fmtTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const configCopy = () => structuredClone(state.config);
function frozen() { return state.running || state.stopping || state.starting || state.cancelingStartup || Boolean(state.busy || state.reloadRequired); }

async function api(path, body) {
  const route = path.split('?', 1)[0];
  const sensitive = path === 'start' || path.startsWith('wallets/');
  const headers = {};
  if (state.session) headers['X-Corla-Session'] = state.session;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let payload;
  try {
    if (sensitive && (location.protocol !== 'http:' || location.hostname !== '127.0.0.1')) {
      throw new Error('钱包操作仅允许在 127.0.0.1 的本机操作台进行。');
    }
    if (body !== undefined) payload = JSON.stringify(body);
  } finally {
    if (sensitive && body) {
      body.password = '';
      body.privateKeys?.fill('');
    }
  }
  let response;
  const timeout = path === 'start' || path === 'stop' ? 90_000 : ['state', 'status', 'rpc/status'].includes(route) ? 6_000 :
    ['catalog', 'catalog/status', 'catalog/funding-times'].includes(path) ? 12_000 :
    ['project/participants', 'project/wallet-balances'].includes(path) ? 8_000 : path === 'project/metadata' ? 15_000 : 35_000;
  try {
    const pending = fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer',
      headers, body: payload, signal: AbortSignal.timeout(timeout) });
    payload = undefined;
    response = await pending;
  } catch (err) {
    payload = undefined;
    if (err?.name === 'TimeoutError') throw new Error(path === 'start' || path === 'stop'
      ? '请求超时。请先检查当前运行状态，不要重复启动。' : '读取超时，可稍后重试。');
    throw new Error('无法连接本地服务，请确认启动窗口仍在运行。');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回了不可识别的响应。'); }
  if (!response.ok) {
    const code = typeof data?.code === 'string' ? data.code : '';
    const reason = response.status === 409 && code === 'CONFIG_STALE' || response.status === 403 && code === 'SESSION_EXPIRED'
      ? requirePageReload(code) : '';
    const error = new Error(reason || (typeof data?.error === 'string' ? data.error : '操作失败（HTTP ' + response.status + '）'));
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return data;
}
let toastTimer;
function notify(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
function setNotice(id, text) {
  $(id).textContent = text || '';
  $(id).hidden = !text;
}
function setConnection(ok, text) {
  $('connection-dot').className = 'dot ' + (ok ? 'ready' : 'error');
  $('connection-label').textContent = text;
}
function readNotificationPrefs() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY)); } catch { /* optional storage */ }
  return { enabled: stored?.enabled === true, whitelist: stored?.whitelist !== false, burst: stored?.burst !== false };
}
function notificationPermission() {
  return typeof window.Notification === 'function' && window.isSecureContext ? window.Notification.permission : 'unsupported';
}
function renderNotificationControls() {
  const permission = notificationPermission();
  const supported = permission !== 'unsupported' && !notificationUnsupported;
  $('notifications-enabled').checked = notificationPrefs.enabled;
  $('notifications-enabled').disabled = !supported && !notificationPrefs.enabled;
  for (const kind of ['whitelist', 'burst']) {
    $('notifications-' + kind).checked = notificationPrefs[kind];
    $('notifications-' + kind).disabled = !supported || !notificationPrefs.enabled;
  }
  const authorize = $('notifications-permission');
  authorize.hidden = !notificationPrefs.enabled || permission !== 'default' || !supported;
  authorize.disabled = notificationPrompt;
  $('notifications-test').disabled = permission !== 'granted' || !supported;
  let title = '已关闭', tone = '', detail = '';
  if (!supported) {
    [title, tone, detail] = ['设备不支持', 'amber', '当前环境不能显示网页桌面通知，请使用桌面 Chrome。'];
  } else if (notificationPrefs.enabled) {
    if (!notificationPrefs.whitelist && !notificationPrefs.burst) title = '未选择提醒';
    else if (permission !== 'granted') {
      [title, tone, detail] = permission === 'denied'
        ? ['权限已阻止', 'amber', '请在 Chrome 地址栏的网站设置中允许本机站点的通知，并检查系统通知设置。']
        : ['等待授权', 'amber', '请允许 Chrome 显示通知，或点下方「授权浏览器通知」。'];
    } else if (state.reloadRequired === 'SESSION_EXPIRED') {
      [title, tone, detail] = ['需要重新连接', 'amber', '本地会话已失效，请重新加载页面以恢复监测。'];
    } else if (notificationStatus === 'monitoring') {
      [title, tone] = ['监测中', 'green'];
    } else if (notificationStatus === 'degraded' || notificationStatus === 'reconnecting') {
      [title, tone, detail] = ['暂未同步', 'amber', '链上数据或本地连接暂不可用，会自动重试。'];
    } else [title, tone] = ['连接中…', 'violet'];
  }
  const badgeNode = $('notifications-state');
  badgeNode.className = 'badge' + (tone ? ' ' + tone : '');
  if (badgeNode.textContent !== title) badgeNode.textContent = title;
  $('notifications-help').textContent = detail ||
    '请保持本地控制台页面打开，切换到别的标签页也可收到提醒。关闭页面或系统拦截时不会弹窗。';
}
function stopNotificationStream() {
  notificationGeneration++;
  clearTimeout(notificationRetry);
  notificationRetry = undefined;
  const stream = notificationStream;
  notificationStream = undefined;
  stream?.controller.abort();
}
function syncNotificationStream({ restart = false } = {}) {
  const enabled = { whitelist: notificationPrefs.whitelist, burst: notificationPrefs.burst };
  const allowed = state.session && state.reloadRequired !== 'SESSION_EXPIRED' && !notificationPageUnloaded &&
    notificationPrefs.enabled && !notificationUnsupported && notificationPermission() === 'granted' &&
    (enabled.whitelist || enabled.burst);
  if (!allowed) {
    stopNotificationStream();
    notificationStatus = 'idle';
    notificationFailures = 0;
  } else {
    const key = String(enabled.whitelist) + ':' + String(enabled.burst);
    if (restart || (notificationStream && notificationStream.key !== key)) {
      stopNotificationStream();
      notificationFailures = 0;
    }
    if (!notificationStream && !notificationRetry) {
      const stream = { controller: new AbortController(), key, generation: notificationGeneration };
      notificationStream = stream;
      notificationStatus = 'syncing';
      void readNotificationStream(stream, enabled);
    }
  }
  renderNotificationControls();
}
async function readNotificationStream(stream, enabled) {
  const { controller } = stream;
  let watchdog, reader;
  const touch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), 60_000);
  };
  try {
    touch();
    const response = await fetch('/api/notifications/stream', { method: 'POST', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', 'X-Corla-Session': state.session },
      body: JSON.stringify({ enabled }), signal: controller.signal });
    if (notificationStream !== stream) return;
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (body?.code === 'SESSION_EXPIRED' && notificationStream === stream) requirePageReload('SESSION_EXPIRED');
    }
    if (!response.ok || !response.body ||
      !/^application\/(?:x-)?ndjson(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')) return;
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', ready = false;
    while (notificationStream === stream && !controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done || notificationStream !== stream || controller.signal.aborted) break;
      touch();
      pending += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        if (newline > 16_384) return;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame?.type === 'ready') {
          ready = true;
          notificationFailures = 0;
        } else if (frame?.type === 'status' && ['syncing', 'monitoring', 'degraded'].includes(frame.status)) {
          notificationStatus = frame.status;
          if (frame.status === 'monitoring') notificationFailures = 0;
          renderNotificationControls();
        } else if (ready && frame?.type === 'event') {
          void deliverChainNotification(frame.event, stream);
        }
      }
      if (pending.length > 16_384) return;
    }
  } catch { /* auto-reconnect unless the settings or session stopped this stream */ }
  finally {
    clearTimeout(watchdog);
    controller.abort();
    reader?.releaseLock();
    if (notificationStream === stream) {
      notificationStream = undefined;
      notificationStatus = 'reconnecting';
      const retry = Math.min(30_000, 1000 * 2 ** Math.min(notificationFailures++, 5));
      notificationRetry = setTimeout(() => {
        notificationRetry = undefined;
        syncNotificationStream();
      }, retry);
      renderNotificationControls();
    }
  }
}
function openNotificationProject(token) {
  window.focus();
  location.hash = '#discover';
  catalog.filter = 'all';
  for (const option of $('catalog-filters').children) {
    option.setAttribute('aria-pressed', String(option.dataset.catalogFilter === 'all'));
  }
  $('catalog-search').value = token;
  syncCatalogSearch();
  renderDiscover();
}
function createDesktopNotification(title, body, { tag, token } = {}) {
  try {
    const message = new window.Notification(title, { body, lang: 'zh-CN', ...(tag ? { tag } : {}) });
    message.onclick = event => {
      event.preventDefault();
      if (token) openNotificationProject(token);
      else window.focus();
      message.close();
    };
    return message;
  } catch {
    notificationUnsupported = notificationPermission() === 'granted';
    syncNotificationStream();
    return null;
  }
}
function burstNotificationDetails(event) {
  const minted = String(event.mintedLots ?? ''), total = String(event.totalLots ?? '');
  if (minted.length <= 78 && total.length <= 78 && UINT.test(minted) && UINT.test(total)) {
    const totalLots = BigInt(total), mintedLots = BigInt(minted);
    if (totalLots > 0n && mintedLots * 3n > totalLots && mintedLots <= totalLots) {
      const percent = mintedLots * 1000n / totalLots;
      return '最近 60 秒认购 ' + minted + '/' + total + ' 批（' + percent / 10n + '.' + percent % 10n + '%）。';
    }
  }
  return '最近 60 秒新增认购已超过项目总批数的 1/3。';
}
async function deliverChainNotification(event, stream) {
  if (!event || !['whitelist', 'burst'].includes(event.kind) || typeof event.id !== 'string' ||
      !event.id || event.id.length > 256 || typeof event.token !== 'string' || typeof event.mint !== 'string' ||
      !validAddress(event.token) || !validAddress(event.mint)) return;
  const showOnce = () => {
    if (stream.generation !== notificationGeneration || !notificationPrefs.enabled || !notificationPrefs[event.kind] ||
        notificationPermission() !== 'granted' || notificationSeen.has(event.id)) return;
    let ids;
    try {
      const stored = localStorage.getItem(NOTIFICATION_PREFS_KEY);
      if (stored) {
        const current = JSON.parse(stored);
        if (current.enabled !== true || current[event.kind] === false) return;
      }
      ids = JSON.parse(localStorage.getItem(NOTIFICATION_SEEN_KEY));
    } catch { /* optional storage */ }
    if (!Array.isArray(ids)) ids = [];
    if (ids.includes(event.id)) return;
    const cached = metadataCache.get(projectKey(event));
    const name = metaText(cached?.name || event.name || cached?.symbol || event.symbol)
      .replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 60) || short(event.token);
    const title = (event.kind === 'whitelist' ? '白名单 Mint' : '异常 Mint') + ' · ' + name;
    const detail = event.kind === 'whitelist' ? '检测到新创建的白名单 Mint。' : burstNotificationDetails(event);
    if (!createDesktopNotification(title, detail + ' 点击在代币看板查看。', { tag: 'corla-desk:' + event.id, token: event.token })) return;
    notificationSeen.add(event.id);
    if (notificationSeen.size > NOTIFICATION_SEEN_LIMIT) notificationSeen.delete(notificationSeen.values().next().value);
    try { localStorage.setItem(NOTIFICATION_SEEN_KEY, JSON.stringify([...ids.slice(1 - NOTIFICATION_SEEN_LIMIT), event.id])); }
    catch { /* Chrome still collapses same-tag duplicates if storage is unavailable */ }
  };
  if (navigator.locks) {
    try { await navigator.locks.request('corla-desk:notification-delivery', showOnce); }
    catch { showOnce(); }
  } else showOnce();
}
async function requestDesktopNotificationPermission() {
  if (notificationPermission() !== 'default' || notificationPrompt) return;
  notificationPrompt = true;
  try { await window.Notification.requestPermission(); }
  catch { notify('无法请求桌面通知权限，请检查 Chrome 的网站设置。', true); }
  finally {
    notificationPrompt = false;
    syncNotificationStream();
  }
}
function bindDesktopNotifications() {
  for (const kind of ['enabled', 'whitelist', 'burst']) {
    $('notifications-' + kind).addEventListener('change', event => {
      notificationPrefs = { ...notificationPrefs, [kind]: event.target.checked };
      try { localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(notificationPrefs)); } catch { /* optional storage */ }
      syncNotificationStream({ restart: true });
      if (kind === 'enabled' && notificationPrefs.enabled) void requestDesktopNotificationPermission();
    });
  }
  $('notifications-permission').addEventListener('click', requestDesktopNotificationPermission);
  $('notifications-test').addEventListener('click', () => {
    if (notificationPermission() !== 'granted') return;
    const message = createDesktopNotification('Corla Desk · 通知测试', '这是一条测试通知，没有发送任何交易。', { tag: 'corla-desk:test' });
    if (!message) notify('当前设备无法显示桌面通知。', true);
    else message.onerror = () => notify('浏览器无法显示桌面通知，请检查 Chrome 和系统设置。', true);
  });
  $('catalog-notification-link').addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    requestAnimationFrame(() => {
      if (location.hash !== '#settings') return;
      if (currentView !== 'settings') switchView();
      $('notifications-panel').scrollIntoView({ block: 'start' });
    });
  });
  window.addEventListener('storage', event => {
    if (event.key !== NOTIFICATION_PREFS_KEY && event.key !== null) return;
    const prefs = readNotificationPrefs();
    if (Object.keys(prefs).every(key => prefs[key] === notificationPrefs[key])) return;
    notificationPrefs = prefs;
    syncNotificationStream({ restart: true });
  });
  window.addEventListener('pagehide', () => { notificationPageUnloaded = true; stopNotificationStream(); });
  window.addEventListener('pageshow', () => { notificationPageUnloaded = false; syncNotificationStream(); });
  window.addEventListener('online', () => syncNotificationStream({ restart: true }));
  window.addEventListener('focus', () => syncNotificationStream());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNotificationStream();
  });
  navigator.permissions?.query({ name: 'notifications' }).then(status => {
    status.addEventListener('change', () => syncNotificationStream());
  }).catch(() => {});
  renderNotificationControls();
}
function requirePageReload(code) {
  const reason = state.reloadRequired === 'SESSION_EXPIRED' ? state.reloadRequired : code;
  const sessionExpired = reason === 'SESSION_EXPIRED';
  const status = sessionExpired ? '本地会话已失效' : '配置已在其他页面修改';
  const message = status + '。未保存的配置仍在，密码和私钥输入已清空。请记录要保留的配置，重新加载并核对；不会自动重试写入或启动。';
  if (state.reloadRequired === reason) return message;
  state.reloadRequired = reason;
  state.liveReview = null;
  $('live-password').value = $('wallet-remove-password').value = '';
  $('wallet-local-unlock-password').value = '';
  $('live-password').disabled = true;
  clearImportSecrets();
  for (const [dialog, notice] of [['project-dialog', 'project-error'], ['snipe-add-dialog', 'snipe-add-error'],
    ['project-remove-dialog', 'project-remove-error'], ['live-dialog', 'live-error'],
    ['wallet-import-dialog', 'wallet-import-error'], ['wallet-remove-dialog', 'wallet-remove-error'],
    ['wallet-local-unlock-dialog', 'wallet-local-unlock-error']]) {
    if (!$(dialog).open) continue;
    setNotice(notice, message);
    for (const button of $(dialog).querySelectorAll('button[type=submit]')) button.disabled = true;
  }
  setNotice('fatal', message);
  $('reload-local-ui').hidden = false;
  setConnection(!sessionExpired, status);
  renderControls();
  renderProjects();
  renderDiscover();
  if (sessionExpired) {
    clearTimeout(statePollTimer);
    resumeCatalogAuto();
    resumeRpcStatus();
    syncNotificationStream();
  }
  return message;
}
function switchView() {
  let current = location.hash.slice(1);
  if (!Object.hasOwn(labels, current)) current = 'overview';
  const changed = currentView !== undefined && currentView !== current;
  if (changed) viewPositions.set(currentView, window.scrollY);
  currentView = current;
  for (const name of Object.keys(labels)) $('view-' + name).hidden = name !== current;
  for (const a of document.querySelectorAll('.nav-item')) {
    const active = a.getAttribute('href') === '#' + current;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('crumb').textContent = labels[current];
  if (changed) window.scrollTo({ top: viewPositions.get(current) ?? 0, behavior: 'instant' });
  if (current === 'overview' && state.session && !refreshResults.has('mint')) void refresh({ silent: true, workspace: 'mint' });
  resumeSnipeProgress();
  resumeCatalogAuto();
  resumeRpcStatus();
}
function rpcStatusVisible() {
  return Boolean(state.session) && state.reloadRequired !== 'SESSION_EXPIRED' && !$('view-settings').hidden && document.visibilityState === 'visible';
}
function setRpcSync(text, tone = '') {
  const status = $('rpc-sync');
  if (status.textContent !== text) status.textContent = text;
  status.className = 'badge' + (tone ? ' ' + tone : '');
}
function resumeRpcStatus() {
  clearTimeout(rpcStatusTimer);
  if (rpcStatusVisible() && !rpcStatusReading) void loadRpcStatus();
}
function rpcDisplayName(value, fallback) {
  // Only accept display labels, not connection strings (which may contain keys).
  return typeof value === 'string' && /^[\p{L}\p{N} ._()·#-]{1,90}$/u.test(value) && !PRIVATE_KEY.test(value) ? value : fallback;
}
function rpcEndpointView(endpoint, index, now) {
  const states = {
    checking: ['测速中', ''], healthy: ['可用', 'green'], cooldown: ['退避中', 'amber'],
    'wrong-chain': ['链 ID 不符', 'red'], stale: ['区块落后', 'amber'], unavailable: ['不可用', 'red'],
  };
  let [status, tone] = Object.hasOwn(states, endpoint.status) ? states[endpoint.status] : ['待检测', ''];
  const limited = ['rate-limit', 'rate-limited', 'rate_limit', 'rate_limited'].includes(endpoint.reason);
  if (endpoint.status === 'cooldown' && limited) status = '限流退避';
  if (endpoint.reason === 'stale-head') [status, tone] = ['区块落后', 'amber'];
  if (endpoint.reason === 'unsupported') [status, tone] = ['不支持所需方法', 'amber'];
  const detail = endpoint.status !== 'healthy' && Number.isFinite(endpoint.retryAt)
    ? (endpoint.retryAt > now ? `${Math.ceil((endpoint.retryAt - now) / 1000)} 秒后复测` : '等待复测') : '';
  const latency = Number.isFinite(endpoint.latencyMs) && endpoint.latencyMs >= 0 ? `${Math.round(endpoint.latencyMs)} ms` : '—';
  return { name: rpcDisplayName(endpoint.name, `节点 ${index + 1}`), status, tone, detail, latency };
}
function renderRpcPools(rawPools) {
  const now = Date.now();
  const pools = [];
  for (const id of Object.keys(RPC_POOL_LABELS)) {
    const pool = rawPools.find(item => item?.id === id);
    if (!pool) continue;
    const entries = (Array.isArray(pool.endpoints) ? pool.endpoints : []).filter(item => item && typeof item === 'object').slice(0, 20);
    const nodes = entries.map((item, i) => rpcEndpointView(item, i, now));
    const nodeName = name => (typeof name === 'string' && nodes[entries.findIndex(item => item.name === name)]?.name) || '—';
    pools.push({ label: RPC_POOL_LABELS[id], preferred: nodeName(pool.preferred), active: nodeName(pool.active), nodes, unavailable: pool.unavailable === true });
  }
  const snapshot = JSON.stringify(pools);
  if (rpcStatusSnapshot === snapshot) return;
  rpcStatusSnapshot = snapshot;
  const host = $('rpc-pools');
  if (!pools.length) {
    host.replaceChildren(element('p', 'empty rpc-placeholder', '暂无节点状态，系统将自动读取。'));
    return;
  }
  const panels = pools.map(pool => {
    const panel = element('section', 'rpc-pool');
    const header = element('div', 'rpc-pool-header');
    const summary = element('dl', 'rpc-pool-summary');
    for (const [label, name] of [['当前节点', pool.active], ['主 RPC', pool.preferred]]) {
      const item = element('div');
      item.append(element('dt', '', label), element('dd', '', name));
      summary.append(item);
    }
    header.append(element('h3', '', pool.label), summary);
    panel.append(header);
    if (!pool.nodes.length) {
      panel.append(element('p', 'rpc-detail', pool.unavailable ? '节点配置不可用，请检查本机 RPC 设置。' : '暂无节点信息。'));
      return panel;
    }
    const list = element('ul', 'rpc-nodes');
    for (const node of pool.nodes) {
      const row = element('li', 'rpc-node');
      const info = element('span', 'rpc-telemetry');
      info.append(element('span', 'rpc-latency mono', node.latency), badge(node.status, node.tone));
      row.append(element('span', 'rpc-name', node.name), info);
      if (node.detail) row.append(element('small', 'rpc-detail', node.detail));
      list.append(row);
    }
    panel.append(list);
    return panel;
  });
  host.replaceChildren(...panels);
}
async function loadRpcStatus() {
  if (!rpcStatusVisible() || rpcStatusReading) return;
  rpcStatusReading = true;
  let nextPoll = 2500;
  try {
    const data = await api('rpc/status');
    if (!Array.isArray(data?.pools)) throw new Error('Invalid RPC status response');
    if (!rpcStatusVisible()) return;
    renderRpcPools(data.pools);
    setRpcSync('自动监测', 'green');
  } catch {
    nextPoll = 5000;
    if (rpcStatusVisible()) {
      setRpcSync('连接待恢复', 'amber');
      if (!rpcStatusSnapshot) $('rpc-pools').replaceChildren(element('p', 'empty rpc-placeholder', '暂未读到节点状态，将自动重试。'));
    }
  } finally {
    rpcStatusReading = false;
    if (rpcStatusVisible()) rpcStatusTimer = setTimeout(loadRpcStatus, nextPoll);
  }
}
function phaseFor(row) {
  if (!row) return ['待查询', ''];
  if (row.error) return ['查询失败', 'red'];
  if (row.launched) return ['已开盘', 'green'];
  if (row.emergencyWithdrawn || row.phase === 2) return ['已结束', ''];
  if (row.mintedLots === row.totalLots && row.totalLots !== '0') return ['已铸满 · 待开盘', 'amber'];
  return ['筹资中', 'amber'];
}
function drawParticipantDetails(details) {
  const cached = participantCache.get(details.dataset.projectKey);
  const body = details.querySelector('.participant-body');
  if (!cached) {
    body.replaceChildren(element('p', 'hint', '展开后单独读取，不影响项目刷新。'));
    return;
  }
  if (cached.loading) {
    body.replaceChildren(element('p', 'hint', '正在读取钱包份额…'));
    return;
  }
  if (cached.error) {
    const retry = element('button', 'btn secondary compact', '重新读取');
    retry.type = 'button';
    retry.addEventListener('click', () => loadParticipants(details.dataset.projectKey, details.dataset.projectUrl, true));
    body.replaceChildren(element('p', 'hint', cached.error), retry);
    return;
  }
  const items = element('ul');
  for (const p of cached.participants) {
    const text = p.refunded ? '已退款' : p.claimed ? '已领取' : Number(p.count) > 0 ? '未领取' : '未参与';
    const item = element('li', 'mono', short(p.wallet) + (p.error ? ' · 查询失败：' + p.error : ' · ' + p.count + ' 批 · ' + text));
    item.title = p.wallet;
    items.append(item);
  }
  body.replaceChildren(cached.participants.length ? items : element('p', 'hint', '暂无钱包份额。'));
  if (cached.block) body.append(element('small', 'hint', '份额区块 #' + fmtInt.format(cached.block)));
}
function repaintParticipants(key) {
  for (const details of document.querySelectorAll('.participant-list')) {
    if (details.dataset.projectKey === key) drawParticipantDetails(details);
  }
}
async function loadParticipants(key, url, force = false) {
  if (!key || !url || !state.session) return;
  const previous = participantCache.get(key);
  if (previous?.loading || !force && previous?.expires > Date.now()) return;
  const current = { loading: true };
  boundedSet(participantCache, key, current, 128);
  repaintParticipants(key);
  try {
    const response = await api('project/participants', { url });
    if (participantCache.get(key) !== current) return;
    Object.assign(current, { participants: response.participants ?? [], block: response.block, expires: Date.now() + 15_000 });
  } catch (e) {
    if (participantCache.get(key) !== current) return;
    Object.assign(current, { error: '份额读取失败：' + e.message, expires: Date.now() + 5000 });
  } finally {
    current.loading = false;
    if (participantCache.get(key) === current) repaintParticipants(key);
  }
}
function renderProjectList(workspace) {
  const snipe = workspace === 'snipe';
  const list = $(snipe ? 'snipe-projects' : 'projects');
  const nodes = [];
  const targets = targetsOf(workspace);
  const openLists = new Set([...list.querySelectorAll('.participant-list[open]')].map(el => el.dataset.projectKey));
  const focus = list.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focus?.closest('.project')?.dataset.projectKey;
  const focusControl = focus?.dataset.projectControl;
  let latestBlock = 0, opened = 0, funding = 0;
  for (const [index, target] of targets.entries()) {
    const parsed = parsedTarget(target);
    const key = projectKey(parsed ?? {});
    const row = state.projects.find(p => same(p.mint, parsed?.mint) && same(p.token, parsed?.token));
    const [label, tone] = phaseFor(row);
    if (label === '已开盘') opened++;
    if (label === '筹资中') funding++;
    if (!row?.error) latestBlock = Math.max(latestBlock, Number(row?.block || row?.blockNumber) || 0);
    const card = element('article', 'project');
    card.dataset.projectKey = key ?? '';
    const head = element('div', 'project-head');
    const pict = tokenPicture(key, snipe ? 'bolt' : 'cube');
    const identity = element('div', 'project-id');
    const addr = element('small', 'project-address', 'CA ' + short(parsed?.token) + ' · Mint ' + short(parsed?.mint));
    if (parsed) addr.title = 'Token ' + parsed.token + '\nMint ' + parsed.mint;
    identity.append(tokenTitle(key, parsed?.token), addr);
    const buttons = element('div', 'project-buttons');
    buttons.append(badge(label, tone));
    if (parsed) {
      const link = external(parsed.url, 'icon-button', undefined, 'link');
      link.title = '打开 Corla 项目'; link.setAttribute('aria-label', '打开 Corla 项目');
      link.dataset.projectControl = 'link';
      buttons.append(link);
    }
    if (!snipe) {
      const edit = iconAction('edit', '配置 Mint ' + short(parsed?.token), () => openProject(index));
      edit.disabled = frozen();
      edit.dataset.projectControl = 'edit';
      buttons.append(edit);
    }
    const remove = iconAction('trash', (snipe ? '移除狙击目标 ' : '移除项目 ') + short(parsed?.token), () => openProjectRemoval(index, workspace));
    remove.classList.add('destructive');
    remove.disabled = frozen();
    remove.dataset.projectControl = 'remove';
    buttons.append(remove);
    head.append(pict, identity, buttons);
    card.append(head);
    if (row?.error) card.append(element('p', 'hint', String(row.error)));
    if (row?.refreshError) card.append(element('p', 'hint snapshot-stale', '本轮未更新，显示上次快照。'));
    const progress = element('div', 'progress-details');
    let progressText = row && !row.error ? row.mintedLots + ' / ' + row.totalLots + ' 批' : '— / — 批';
    if (snipe && row && !row.error && !row.launched && !row.emergencyWithdrawn && row.phase !== 2) {
      const minted = catalogInteger(row.mintedLots), total = catalogInteger(row.totalLots);
      if (minted !== null && total !== null && total >= minted) progressText += ' · 剩 ' + fmtInt.format(total - minted) + ' 批';
    }
    progress.append(element('strong', '', progressText),
      element('span', '', row?.pricePerLot != null ? formatUnits(row.pricePerLot) + ' BNB / 批' : '等待链上数据'));
    const bar = element('progress', 'progress-track' + (row?.launched ? ' launched' : ''));
    bar.max = 100;
    let percentage = 0;
    try { if (BigInt(row.totalLots) > 0n) percentage = Number(BigInt(row.mintedLots) * 10000n / BigInt(row.totalLots)) / 100; } catch { /* unread */ }
    bar.value = Math.max(0, Math.min(percentage, 100));
    bar.setAttribute('aria-label', 'Mint 进度');
    const flags = element('div', 'project-flags');
    if (snipe) {
      const newLaunchStatus = state.running && state.workspace === 'snipe' ? '开盘 · 查看狙击日志' : '已开盘，不追买';
      flags.append(badge(row?.launched ? newLaunchStatus : '监控新开盘', row?.launched ? '' : 'violet'));
    } else {
      if (target.mintBatches) flags.append(badge('每钱包目标 ' + target.mintBatches + ' 批', 'violet'));
      if (row?.maxMintsPerWallet != null) flags.append(badge('链上限额 ' + row.maxMintsPerWallet + ' 批/地址',
        target.mintBatches > Number(row.maxMintsPerWallet) ? 'amber' : ''));
      if (target.mintBatches) flags.append(badge('价格保护 ≤ ' + target.maxMintPriceBnb + ' BNB/批'));
      if (target.autoClaim) flags.append(badge('自动领币', 'green'));
      if (target.mintBatches || target.autoClaim) {
        const count = target.mintWallets?.length ?? state.wallets.length;
        const missing = target.mintWallets?.some(address => !state.wallets.some(w => same(w.address, address)));
        flags.append(badge((target.mintWallets ? '选定 ' : '全部 ') + count + ' 个钱包', missing ? 'red' : ''));
      } else flags.append(badge('仅观察'));
    }
    if (validAddress(row?.pool)) {
      const link = external(EXPLORER + '/address/' + row.pool, 'project-pool', '交易池 ' + short(row.pool), 'link');
      link.title = row.pool;
      flags.append(link);
    }
    card.append(progress, bar, flags);
    if (!snipe && parsed && state.wallets.length) {
      const details = element('details', 'participant-list');
      details.dataset.projectKey = key;
      details.dataset.projectUrl = parsed.url;
      const summary = element('summary', '', '钱包份额（' + state.wallets.length + '）');
      summary.dataset.projectControl = 'participants';
      details.append(summary, element('div', 'participant-body'));
      details.open = openLists.has(key);
      drawParticipantDetails(details);
      details.addEventListener('toggle', () => { if (details.isConnected && details.open) void loadParticipants(key, parsed.url); });
      card.append(details);
    }
    nodes.push(card);
  }
  if (!nodes.length) nodes.push(element('div', 'empty', state.config ? (snipe ? '暂无狙击目标，点击右上角添加。' : '暂无 Mint 项目，点击右上角添加。') : '正在读取本地配置…'));
  list.replaceChildren(...nodes);
  if (focusKey && focusControl) {
    const current = [...list.querySelectorAll('[data-project-control]')].find(node =>
      node.dataset.projectControl === focusControl && node.closest('.project')?.dataset.projectKey === focusKey);
    current?.focus({ preventScroll: true });
  }
  $(snipe ? 'snipe-block-label' : 'block-label').textContent = latestBlock ? '最新快照区块 #' + fmtInt.format(latestBlock) : '等待链上快照';
  if (snipe) return;
  $('count-projects').textContent = state.config ? String(targets.length) : '—';
  $('count-funding').textContent = latestBlock || state.config && !targets.length ? String(funding) : '—';
  $('count-launched').textContent = latestBlock || state.config && !targets.length ? String(opened) : '—';
  $('count-wallets').textContent = state.config ? String(state.wallets.length) : '—';
}
function renderProjects() {
  renderProjectList('mint');
  renderProjectList('snipe');
}
const eventNames = {
  project: ['项目快照', ''], project_error: ['项目异常', 'red'], rpc_error: ['RPC 异常', 'red'],
  watch_started: ['启动监控', 'violet'], watch_stopped: ['停止监控', ''], watch_error: ['监控异常', 'red'],
  mint: ['Mint', 'violet'], claim: ['自动领币', 'violet'], buy: ['开盘买入', 'violet'],
  mint_skipped: ['跳过 Mint', 'amber'], claim_skipped: ['跳过领币', 'amber'], buy_skipped: ['跳过买入', 'amber'],
  journal: ['历史回执', ''], status: ['刷新状态', ''], configured: ['保存配置', ''],
  snipe_detected: ['发现开盘', 'violet'], snipe_feed: ['监听状态', ''],
  snipe_send: ['向 RPC 发单', 'amber'], snipe_ack: ['RPC 已接收', 'violet'],
  snipe_race_mode: ['竞争路径', 'violet'], snipe_race_attempt: ['竞争提交', 'amber'], snipe_race_outcome: ['竞争结果', 'violet'],
  snipe_pending_feed: ['待打包监听', ''], snipe_pending_match: ['提前量对照', ''], snipe_pending: ['发现待打包 Mint', ''],
};
const feedPhases = { ready: '监听已就绪', subscribed: '已订阅', connecting: '连接中',
  connected: '已连接', retrying: '重连中', reconnecting: '重连中', error: '异常', degraded: '回退中',
  disconnected: '已断开', disabled: '未启用', polling: '补扫中', scanning: '开始补扫',
  active: '补扫正常', busy: '事件队列忙', fallback: 'HTTP 回退' };
const logStatus = { simulated: '内部验证通过', confirmed: '链上已确认', pending: '待确认', failed: '链上失败', skipped: '已跳过 · 不重发' };
const logReasons = {
  rpc_limited: 'RPC 限流或不支持日志查询',
  'Previously confirmed block was reorganized; do not resubmit': '原确认区块已重组，正在重新核验，不自动补发',
  'Canonical block unavailable; do not resubmit': '暂未读取到主链区块，不自动补发',
  'Waiting for the configured number of confirmations': '等待达到配置的确认数',
};
function renderLogList(workspace) {
  const prefix = workspace === 'snipe' ? 'snipe-' : '';
  const filter = $(prefix + 'log-filter').value;
  const entries = [...state.logs].reverse().filter(event => {
    const tagged = event.workspace ?? (/^buy/.test(event.event) ? 'snipe' : 'mint');
    if (tagged !== workspace && tagged !== 'all') return false;
    if (filter === 'trades') return /^(mint|claim|buy|journal|snipe_send|snipe_ack)/.test(event.event);
    if (filter === 'errors') return Boolean(event.error || event.event?.endsWith('_skipped') || event.status === 'failed');
    return true;
  }).slice(0, 100);
  const rows = entries.map(entry => {
    const row = element('div', 'log-row');
    const [name, tone] = eventNames[entry.event] || [String(entry.event || '事件'), ''];
    const time = new Date(entry.time);
    const stamp = element('span', 'log-time', Number.isNaN(time.getTime()) ? '—' : fmtTime.format(time));
    stamp.title = '北京时间（UTC+8）';
    const details = element('div', 'log-detail');
    const info = [];
    if (entry.status) {
      const awaitingProof = entry.status === 'pending' && Number.isSafeInteger(entry.receiptBlock);
      const immature = entry.receiptStable === false && ['confirmed', 'failed'].includes(entry.status);
      info.push(awaitingProof ? '待重新核验回执' : immature ?
        (entry.status === 'confirmed' ? '已上链 · 等待稳定确认' : '暂报失败 · 等待稳定确认') :
        (logStatus[entry.status] || entry.status));
    }
    if (entry.wallet) info.push('钱包 ' + short(entry.wallet));
    if (entry.token) info.push('Token ' + short(entry.token));
    else if (entry.mint) info.push('Mint ' + short(entry.mint));
    if (entry.event === 'project') info.push(entry.mintedLots + '/' + entry.totalLots + ' 批', entry.launched ? '已开盘' : '未开盘');
    if (entry.event === 'mint' && entry.batch) info.push('第 ' + entry.batch + ' 批');
    if (entry.block || entry.armBlock || entry.launchBlock) info.push('#' + (entry.block || entry.armBlock || entry.launchBlock));
    if (entry.signalSource) info.push(entry.signalSource === 'ws' ? 'WSS 推送' : 'HTTP 补扫');
    if (entry.event === 'snipe_feed' && entry.transport) info.push(String(entry.transport).toUpperCase(), feedPhases[entry.phase] || entry.phase);
    if (entry.event === 'snipe_feed' && entry.retryMs) info.push('延迟 ' + entry.retryMs + ' ms 后重试');
    if (entry.raceMode) info.push(entry.raceMode === 'pending' ? '开盘前准备' : '确认后');
    if (Number.isSafeInteger(entry.attempt)) info.push('第 ' + entry.attempt + ' 次');
    if (Number.isFinite(entry.leadMs)) info.push('比本地开盘通知早 ' + entry.leadMs + ' ms');
    if (entry.pendingMode && entry.event === 'snipe_pending_feed') info.push(entry.pendingMode);
    if (Number.isFinite(entry.quoteMs)) info.push('发现→验池报价 ' + entry.quoteMs + ' ms');
    if (Number.isFinite(entry.marketMs)) info.push((entry.marketReadMode === 'aggregate' ? '聚合报价' :
      entry.marketReadMode === 'direct' ? '直读报价' : '市场检查') + ' ' + entry.marketMs + ' ms');
    if (entry.event === 'snipe_send' && Number.isFinite(entry.walletChecksMs) && Number.isFinite(entry.preflightMs)) {
      info.push('钱包检查 ' + entry.walletChecksMs + ' ms',
        '交易预检 ' + entry.preflightMs + ' ms' + (entry.preflightOverlapped ? '（并行）' : ''));
    }
    if (Number.isFinite(entry.elapsedMs)) info.push('发现→' + (entry.event === 'snipe_ack' ? 'RPC 接收' : '发出请求') + ' ' + entry.elapsedMs + ' ms');
    if (entry.event === 'buy_skipped') {
      const quoted = catalogInteger(entry.quotedNetOut), floor = catalogInteger(entry.openingAmountOutMin);
      if (quoted !== null && floor !== null) {
        info.push(quoted < floor ? '低于开盘价保护底线，未发送' : '开盘价保护预检',
          '预计净到手 ' + fmtInt.format(quoted) + ' / 最低 ' + fmtInt.format(floor) + '（Token 最小单位）');
      }
    }
    if (entry.error || entry.reason || entry.message) {
      const reason = Object.hasOwn(logReasons, entry.reason) ? logReasons[entry.reason] : entry.reason;
      info.push(entry.error || reason || entry.message);
    }
    details.textContent = info.join(' · ') || '—';
    const hash = entry.txHash || (entry.event === 'snipe_detected' ? entry.launchTx : '');
    if (TX_HASH.test(hash)) {
      details.append(' · ', external(EXPLORER + '/tx/' + hash, '', entry.event === 'snipe_detected' ? '查看开盘交易' : '查看交易'));
    }
    row.append(stamp, badge(name, tone), details);
    return row;
  });
  $(prefix + 'logs').replaceChildren(...(rows.length ? rows : [element('div', 'empty', filter === 'all' ? '暂无运行日志' : '没有符合筛选的事件')]));
}
function renderLogs() { renderLogList('mint'); renderLogList('snipe'); }
function configuredActions(workspace) {
  const targets = targetsOf(workspace);
  return workspace === 'snipe' ? targets.length : targets.some(t => t.autoClaim || t.mintBatches > 0);
}
function liveAvailable(workspace) { return state.allowLive && state.wallets.length > 0 && Boolean(configuredActions(workspace)); }
function renderWalletList() {
  if (!state.config) return;
  $('wallet-count-label').textContent = '已导入 ' + state.wallets.length + ' / 32 个钱包';
  const rows = state.wallets.map(({ address, label }, index) => {
    const row = element('div', 'wallet-row');
    const pict = element('span', 'project-icon'); pict.append(icon('wallet'));
    const info = element('div', 'wallet-info');
    const name = element('span', 'wallet-name', label || '钱包 ' + (index + 1));
    const link = external(EXPLORER + '/address/' + address, 'mono wallet-address', address);
    link.title = '在 BscScan 查看公开地址';
    info.append(name, link);
    const remove = iconAction('trash', '删除钱包 ' + short(address), () => openWalletRemoval({ address, label }));
    remove.classList.add('destructive');
    remove.dataset.walletMutation = '';
    remove.disabled = frozen();
    row.append(pict, info, badge('#' + (index + 1)), remove);
    return row;
  });
  $('wallet-list').replaceChildren(...(rows.length ? rows : [element('p', 'empty roomy', '还没有实盘钱包。点击右上角「导入私钥」添加。')]));
}
function setWallets(wallets) {
  const previous = state.wallets.map(wallet => wallet.address.toLowerCase()).join(',');
  state.wallets = Array.isArray(wallets)
    ? wallets.filter(w => validAddress(w?.address)).map(w => ({ address: w.address, label: typeof w.label === 'string' ? w.label : '' })) : [];
  if (previous !== state.wallets.map(wallet => wallet.address.toLowerCase()).join(',')) participantCache.clear();
  renderWalletList();
  renderProjects();
  renderControls();
}
function isRefreshing(workspace) { return refreshJobs.has(workspace) || refreshJobs.has('all'); }
function canRefresh(workspace) {
  if (!state.session || !state.config || state.reloadRequired || !targetsOf(workspace).length) return false;
  // Snipe progress is a dashboard-only read. Do not tie it to the flags
  // that freeze strategy, project and wallet writes during a live task.
  return workspace === 'snipe' || !frozen();
}
function snipeProgressVisible() {
  return currentView === 'snipe' && document.visibilityState === 'visible' && canRefresh('snipe');
}
function snipeProgressNearFull() {
  const keys = new Set(targetsOf('snipe').map(target => projectKey(parsedTarget(target) ?? {})).filter(Boolean));
  return state.projects.some(row => {
    if (!keys.has(projectKey(row)) || row.error || row.refreshError || row.launched || row.emergencyWithdrawn || row.phase === 2) return false;
    const deadline = catalogTimestamp(row.fundingDeadline);
    if (deadline && deadline <= Date.now() / 1000) return false;
    const minted = catalogInteger(row.mintedLots), total = catalogInteger(row.totalLots);
    return minted !== null && total !== null && total - minted === 1n;
  });
}
function resumeSnipeProgress(immediate = true) {
  clearTimeout(snipeProgressTimer);
  if (!snipeProgressVisible() || isRefreshing('snipe')) return;
  const load = () => {
    if (snipeProgressVisible()) void refresh({ silent: true, workspace: 'snipe', automatic: true });
  };
  if (immediate) load();
  else {
    // Delay from completion, not request start; the dashboard read never overlaps itself.
    const interval = refreshResults.get('snipe')?.error ? SNIPE_PROGRESS_BACKOFF_MS :
      snipeProgressNearFull() ? SNIPE_PROGRESS_LAST_LOT_MS :
      state.running && state.workspace === 'snipe' ? SNIPE_PROGRESS_LIVE_MS : SNIPE_PROGRESS_IDLE_MS;
    snipeProgressTimer = setTimeout(load, interval);
  }
}
function renderRefreshStatus(workspace) {
  const prefix = workspace === 'snipe' ? 'snipe-' : '';
  const button = $(prefix + 'refresh');
  const job = refreshJobs.get(workspace) ?? refreshJobs.get('all');
  const loading = Boolean(job && (!job.automatic || !refreshResults.has(workspace)));
  if (button.classList.toggle('refreshing', loading) !== (button.dataset.refreshing === 'true')) {
    button.dataset.refreshing = String(loading);
    setButton(button, loading ? '刷新中…' : '刷新链上', 'refresh');
  }
  button.setAttribute('aria-busy', String(loading));
  const notice = $(prefix + 'refresh-status');
  const last = refreshResults.get(workspace);
  notice.classList.toggle('snapshot-stale', !loading && Boolean(last?.error));
  const auto = workspace === 'snipe' && snipeProgressVisible();
  const autoLabel = auto && !last?.error && snipeProgressNearFull() ? '剩 1 批 · 快速刷新' : '自动更新';
  const message = loading ? '正在后台刷新，可继续操作' :
    last?.error ? last.error : last ? (auto ? autoLabel + ' · ' : '') + '最近刷新 ' + fmtTime.format(last.at) + ' · ' + last.ms + ' ms' :
      auto ? autoLabel + ' · 等待读取' : '';
  if (notice.textContent !== message) notice.textContent = message;
  notice.hidden = !message;
}
function renderWorkspaceControls(workspace) {
  const snipe = workspace === 'snipe';
  const prefix = snipe ? 'snipe-' : '';
  const name = workspaceNames[workspace];
  const active = state.running || state.stopping || state.starting;
  const current = active && state.workspace === workspace;
  const disabled = !state.config;
  const start = $(snipe ? 'start-snipe' : 'start-live');
  const stop = $(snipe ? 'stop-snipe' : 'stop');
  $(prefix + 'refresh').disabled = !canRefresh(workspace) || isRefreshing(workspace);
  renderRefreshStatus(workspace);
  start.hidden = current;
  start.disabled = disabled || frozen() || !liveAvailable(workspace);
  stop.hidden = !current;
  stop.disabled = state.reloadRequired === 'SESSION_EXPIRED' || state.stopping || state.cancelingStartup || Boolean(state.busy);
  setButton(stop, state.stopping || state.busy === 'stop' ? '正在停止…' : state.starting ? '取消启动' : '停止 ' + name, 'stop');
  const liveHint = !state.config ? '正在连接本地服务。' : !state.allowLive ? '当前服务禁止广播交易。' :
    active && !current ? '请先停止' + (snipe ? ' Mint' : '狙击') + '工作区，再启动当前工作区。' :
    !state.wallets.length ? '先导入至少一个实盘钱包。' :
    !targetsOf(workspace).length ? (snipe ? '先添加一个狙击目标。' : '先添加一个 Mint 项目。') :
    !configuredActions(workspace) ? '请设置 Mint 批数或开启自动领币。' :
    '实盘钱包：' + state.wallets.length + ' 个。启动前需要解锁并确认。';
  $(prefix + 'live-caption').textContent = liveHint;
  start.title = liveHint;
  const modes = current && (state.stopping || state.busy === 'stop') ? ['停止中', '正在等待当前操作安全结束。', 'stopping'] :
    current && (state.starting || state.busy === 'start') ? ['启动中', '正在解锁钱包并校验策略和 BSC RPC。', 'stopping'] :
    current && state.mode === 'live' ? [name + ' 实盘运行中', '当前工作区可能发送主网交易并花费 BNB。', 'live'] :
    current ? ['内部验证中', '当前服务不广播交易。', 'ready'] :
    active ? ['待机', '另一个工作区正在运行；同一时间只运行一个。', ''] :
    ['待机', '待机期间只读链上数据，不发送交易。', ''];
  $(prefix + 'mode-label').textContent = modes[0];
  $(prefix + 'mode-copy').textContent = modes[1];
  $(prefix + 'mode-indicator').className = 'dot ' + modes[2];
  $(prefix + 'budget-label').textContent = state.config?.maxTotalBnb ? state.config.maxTotalBnb + ' BNB' : '未设定';
  setNotice(prefix + 'run-alert', state.lastErrorWorkspace && state.lastErrorWorkspace !== workspace ? '' : state.lastError);
}
function renderControls() {
  const disabled = !state.config;
  renderWorkspaceControls('mint');
  renderWorkspaceControls('snipe');
  const cancel = $('live-cancel-startup');
  const ownWorkspace = pendingLiveStart?.workspace === state.workspace;
  const checking = state.busy === 'start' || state.cancelingStartup;
  const canceling = state.cancelingStartup || ownWorkspace && state.stopping;
  const progress = $('live-start-progress');
  progress.hidden = !checking;
  if (checking) {
    const detail = canceling ? '正在等待服务安全结束。' : ownWorkspace && state.starting ?
      '正在校验钱包、策略与 RPC，可以取消启动。' : '正在提交启动请求…';
    if (progress.textContent !== detail) progress.textContent = detail;
  }
  cancel.hidden = !checking || (!canceling && !(ownWorkspace && state.starting));
  cancel.disabled = canceling || state.reloadRequired === 'SESSION_EXPIRED';
  cancel.textContent = canceling ? '正在停止…' : '取消启动';
  $('live-cancel-review').hidden = $('live-submit').hidden = checking;
  $('live-close-review').disabled = checking;
  updateLiveSubmit();
  $('add-project').disabled = disabled || frozen();
  $('add-snipe').disabled = disabled || frozen();
  $('import-wallet').disabled = disabled || frozen() || state.wallets.length >= 32;
  $('wallet-local-unlock-panel').hidden = !state.walletLocalUnlockSupported;
  $('wallet-remember-local-unlock').hidden = state.walletLocalUnlock;
  $('wallet-remember-local-unlock').disabled = disabled || frozen() || !state.walletVaultExists;
  $('wallet-forget-local-unlock').hidden = !state.walletLocalUnlock;
  $('wallet-forget-local-unlock').disabled = disabled || frozen();
  $('wallet-local-unlock-copy').textContent = state.walletLocalUnlock
    ? '当前 Windows 账号已开启免密码；换系统或账号仍需使用原钱包库密码。'
    : '输入原密码一次，开启 Windows 本机免密码。';
  for (const button of document.querySelectorAll('[data-wallet-mutation]')) button.disabled = disabled || frozen();
  for (const form of ['settings-form', 'snipe-form']) {
    document.querySelector('#' + form + ' button[type=submit]').disabled = disabled || frozen();
  }
  $('config-source').textContent = !state.config ? '—' : state.source === 'local' ? '本地配置' : '内置示例';
  $('claim-count').textContent = state.config ? String(targetsOf('mint').filter(t => t.autoClaim).length) : '—';
  $('snipe-amount-label').textContent = state.config ? (state.config.snipe?.amountBnb ?? defaults.snipe.amountBnb) + ' BNB' : '—';
  $('snipe-wallet-count').textContent = state.config ? String(state.config.snipe?.walletCount ?? defaults.snipe.walletCount) : '—';
  $('snipe-report-row').hidden = !state.snipeReport;
  $('snipe-report-path').textContent = state.snipeReport;
}
function renderConfigForms() {
  const snipe = $('snipe-form').elements;
  for (const [key, value] of Object.entries(defaults.snipe)) {
    const configured = state.config.snipe?.[key];
    const stored = configured === undefined ? value : configured;
    const input = snipe[key];
    if (typeof value === 'boolean') {
      input.defaultChecked = input.checked = stored === true;
      input.indeterminate = typeof stored !== 'boolean';
    } else if (input.hasAttribute('data-bps-percent')) {
      input.value = Number.isSafeInteger(stored) ? stored / 100 : '';
    } else input.value = stored;
  }
  syncSnipeOpeningPolicy();
  const general = $('settings-form').elements;
  for (const [key, value] of Object.entries(defaults.outer)) general[key].value = state.config[key] ?? value;
}
const catalogDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const catalogFundingDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function catalogInteger(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && value.length <= 80 && UINT.test(value)) return BigInt(value);
  return null;
}
function catalogTimestamp(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000 ? n : 0;
}
function catalogProgress(row) {
  const minted = catalogInteger(row?.mintedLots);
  const total = catalogInteger(row?.totalLots);
  return minted === null || total === null || total === 0n ? null :
    Number(minted >= total ? 1000n : minted * 1000n / total);
}
function catalogPhase(status, now) {
  if (!status || status.error || typeof status.launched !== 'boolean') return ['unknown', status?.error ? '状态未读到' : '读取状态…', ''];
  if (status.launched) return ['launched', '已开盘', 'green'];
  const deadline = catalogTimestamp(status.fundingDeadline);
  if (status.emergencyWithdrawn || status.phase === 2 || (deadline && deadline <= now)) return ['ended', '已结束', ''];
  if (catalogProgress(status) === 1000) return ['funded', '已铸满 · 待开盘', 'violet'];
  if (deadline && deadline - now <= CATALOG_ENDING_SEC) return ['ending', '即将结束', 'amber'];
  return ['funding', '筹资中', 'amber'];
}
function catalogIsFilled(status) {
  return Boolean(status && !status.error && (status.launched === true || catalogProgress(status) === 1000));
}
function catalogFundingPhase(status, kind, deadline, now) {
  if (catalogIsFilled(status)) return 'filled';
  if (status?.emergencyWithdrawn === true) return 'withdrawn';
  if (kind === 'ended') return deadline && deadline <= now && status?.phase === 2 ? 'expired' : 'ended';
  return kind === 'funding' || kind === 'ending' ? 'active' : 'unknown';
}
function formatCatalogDuration(seconds) {
  const parts = [];
  for (const [size, unit] of [[86_400, '天'], [3600, '小时'], [60, '分'], [1, '秒']]) {
    const n = Math.floor(seconds / size);
    if (n) parts.push(n + unit);
    seconds %= size;
  }
  return parts.join('') || '0秒';
}
function paintCatalogDuration(node, now) {
  const key = node.dataset.catalogDuration;
  const phase = node.dataset.fundingPhase;
  const start = catalogTimestamp(node.dataset.fundingStart);
  const deadline = catalogTimestamp(node.dataset.fundingDeadline);
  const filledAt = catalog.fundingTimes.get(key)?.filledAt;
  let label = '筹资时长待核验';
  let value = '', suffix = '', end = 0;
  if (!start) {
    label = '筹资开始时间待核验';
  } else if (phase === 'filled') {
    label = '打满用时待核验';
    if (filledAt >= start && (!deadline || filledAt <= deadline)) {
      label = '用时 ';
      suffix = '打满';
      end = filledAt;
    }
  } else if (phase === 'expired') {
    label = '未打满 · 筹资 ';
    end = deadline;
  } else if (phase === 'active' && (!deadline || now < deadline)) {
    label = '已筹资 ';
    value = formatCatalogDuration(Math.max(0, now - start));
  } else if (phase === 'withdrawn' || phase === 'ended' || phase === 'active') {
    label = '筹资结束时间待核验';
  }
  if (end >= start && start) value = formatCatalogDuration(end - start);
  if (phase === 'filled' && end && end === start) {
    label = '';
    value = '同秒打满';
    suffix = '';
  }
  const [, prefixEl, valueEl, suffixEl] = node.children;
  if (prefixEl.textContent !== label) prefixEl.textContent = label;
  if (valueEl.textContent !== value) valueEl.textContent = value;
  if (suffixEl.textContent !== suffix) suffixEl.textContent = suffix;
  const tone = phase === 'filled' && value ? 'filled' : '';
  if (node.dataset.durationTone !== tone) node.dataset.durationTone = tone;
  const title = start ? '开始：' + catalogFundingDate.format(new Date(start * 1000)) + '（北京时间）' +
    (end ? '；' + (phase === 'filled' ? '打满：' : '截止：') + catalogFundingDate.format(new Date(end * 1000)) : '') : '';
  if (node.title !== title) node.title = title;
}
function catalogRow(project) {
  const verified = parsedTarget(project ?? {});
  return verified && projectKey(verified) === projectKey(project) ? { ...project, ...verified } : null;
}
function catalogQuery(value) { return String(value ?? '').normalize('NFKC').trim().toLowerCase(); }
function catalogMatches(row, query) {
  if (!query) return true;
  if (validAddress(query)) return same(row.token, query) || same(row.mint, query);
  const meta = metadataCache.get(projectKey(row));
  return [row.token, row.mint, meta?.name, meta?.symbol].some(value => catalogQuery(value).includes(query));
}
function catalogRowsForDisplay() {
  const extra = catalog.lookups.get(catalog.query)?.project;
  return extra && !catalog.rows.some(row => projectKey(row) === projectKey(extra)) ? [extra, ...catalog.rows] : catalog.rows;
}
function paintCatalogMetadata(node, key) {
  const meta = metadataCache.get(key);
  if (node.hasAttribute('data-catalog-description')) {
    const description = meta?.description;
    node.hidden = !description;
    node.textContent = description ?? '';
  } else {
    const supply = meta?.initialSupply;
    const exact = supply == null ? '—' : formatUnits(supply);
    const whole = supply == null ? 0n : supply / 10n ** 18n;
    node.textContent = whole >= 10_000_000_000_000_000n ? fmtScientific.format(whole) :
      whole >= 100_000_000n ? fmtCompact.format(whole) : exact;
    node.title = exact;
    node.setAttribute('aria-label', exact);
  }
}
function catalogStat(label, value) {
  const group = element('div', 'catalog-stat');
  const amount = element('dd', '', value);
  amount.title = value;
  group.append(element('dt', '', label), amount);
  return group;
}
function catalogCard(row, display) {
  const { key, view, kind, title, tone, mode, mintIndex, hasSnipe, disabled, fundingPhase, now } = display;
  const card = element('article', 'catalog-card');
  card.dataset.catalogCard = key;
  card.dataset.catalogUrl = row.url;
  const head = element('div', 'catalog-card-head');
  const identity = element('div', 'catalog-card-identity');
  const name = tokenTitle(key, row.token);
  const address = element('span', 'catalog-address mono', 'CA ' + short(row.token));
  address.title = row.token;
  const addressLine = element('div', 'catalog-address-line');
  const copy = iconAction('copy', '复制合约地址 ' + short(row.token), async () => {
    try { await navigator.clipboard.writeText(row.token); notify('合约地址已复制。'); }
    catch { notify('当前浏览器未授予剪贴板权限。合约：' + row.token, true); }
  });
  copy.classList.add('catalog-copy');
  copy.dataset.catalogAction = 'copy';
  addressLine.append(address, copy);
  identity.append(name, addressLine);
  // Catalog rows already bind this official Corla URL to the on-chain Mint and Token.
  const official = external(row.url, 'catalog-official', 'Flap', 'link');
  official.title = '打开 Flap 官方代币详情（新标签页）';
  official.setAttribute('aria-label', '在 Flap 查看 ' + short(row.token) + ' 的代币资料（新标签页）');
  official.dataset.catalogAction = 'official';
  const headTools = element('div', 'catalog-head-tools');
  headTools.append(badge(title, tone), official);
  head.append(tokenPicture(key, 'cube'), identity, headTools);
  const description = element('p', 'catalog-description');
  description.dataset.catalogDescription = key;
  paintCatalogMetadata(description, key);
  const price = catalogInteger(view.pricePerLot);
  const goal = catalogInteger(view.totalLots);
  const stats = element('dl', 'catalog-stats');
  const priceText = price === null ? '—' : formatUnits(price) + ' BNB';
  const totalText = price === null || goal === null ? '—' : formatUnits(price * goal) + ' BNB';
  const supply = catalogStat('初始总供应', '—');
  const supplyValue = supply.querySelector('dd');
  supplyValue.dataset.catalogSupply = key;
  paintCatalogMetadata(supplyValue, key);
  stats.append(catalogStat('Mint 单批', priceText), catalogStat('Mint 目标金额', totalText), supply);
  const progress = element('div', 'catalog-progress');
  const percentage = catalogProgress(view);
  const bought = catalogInteger(view.mintedLots);
  const details = element('div', 'catalog-progress-caption');
  details.append(element('span', '', (bought === null ? '—' : fmtInt.format(bought)) + ' / ' + (goal === null ? '—' : fmtInt.format(goal)) + ' 批'),
    element('strong', '', percentage === null ? '—' : (percentage / 10) + '%'));
  const gauge = element('progress', 'progress-track' + (kind === 'launched' ? ' launched' : ''));
  gauge.max = 1000;
  // Unknown is a neutral zero bar, not a determinate funding claim.
  gauge.value = percentage ?? 0;
  gauge.setAttribute('aria-label', percentage === null ? '筹资进度尚未读取' : '筹资进度');
  if (percentage === null) gauge.classList.add('unknown');
  progress.append(gauge, details);
  const lower = element('div', 'catalog-card-foot');
  const deadline = catalogTimestamp(view.fundingDeadline);
  const timing = element('div', 'catalog-timing');
  const duration = element('span', 'catalog-duration');
  duration.dataset.catalogDuration = key;
  duration.dataset.fundingPhase = fundingPhase;
  duration.dataset.fundingStart = catalogTimestamp(row.createdAt);
  duration.dataset.fundingDeadline = deadline;
  duration.append(icon('progress'), element('span'), element('strong'), element('span'));
  paintCatalogDuration(duration, now);
  const sub = element('span', 'catalog-deadline', deadline ? '截止 ' + catalogDate.format(new Date(deadline * 1000)) : '截止时间未知');
  if (deadline) sub.title = '北京时间（UTC+8）';
  timing.append(duration, sub);
  lower.append(timing);
  if (mode) lower.append(badge(mode, mode === '公开 Mint' ? 'green' : 'amber'));
  const actions = element('div', 'catalog-actions');
  const mint = element('button', 'btn primary compact');
  mint.type = 'button';
  mint.dataset.catalogAction = 'mint';
  setButton(mint, kind === 'launched' ? '配置领币' : mintIndex >= 0 ? '配置 Mint' : '加入 Mint', mintIndex >= 0 ? 'edit' : 'plus');
  mint.disabled = disabled || (kind === 'ended' && mintIndex < 0);
  if (kind === 'ended' && mintIndex < 0) mint.title = '该项目已结束且未开盘';
  mint.addEventListener('click', () => openProject(mintIndex, row.url, { claimOnly: kind === 'launched' }));
  const snipe = element('button', 'btn secondary compact');
  snipe.type = 'button';
  snipe.dataset.catalogAction = 'snipe';
  setButton(snipe, hasSnipe ? '已在狙击名单' : '加入狙击', 'bolt');
  snipe.disabled = disabled || hasSnipe || !['funding', 'ending', 'funded'].includes(kind);
  if (!hasSnipe && snipe.disabled && ['launched', 'ended', 'unknown'].includes(kind)) snipe.title = '只有尚未开盘且可核验的目标可加入狙击';
  snipe.addEventListener('click', () => openSnipe(row.url));
  if (kind === 'ended' && mintIndex < 0) actions.append(element('p', 'catalog-action-note', '已结束，不能再 Mint'));
  else actions.append(mint);
  if (['funding', 'ending', 'funded'].includes(kind)) actions.append(snipe);
  card.append(head, description, stats, progress, lower, actions);
  return card;
}
function updateCatalogCards(list, entries, now) {
  const mint = targetsOf('mint').map(row => projectKey(parsedTarget(row) ?? {}));
  const snipe = new Set(targetsOf('snipe').map(row => projectKey(parsedTarget(row) ?? {})));
  const disabled = !state.config || frozen();
  const old = new Map(Array.from(list.children, node => [node.dataset.catalogCard, node]));
  catalog.fundingRows.clear();
  const next = entries.map(({ row, key, live, phase }) => {
    const view = live && !live.error ? { ...row, ...live } : row;
    const [kind, title, tone] = phase;
    const deadline = catalogTimestamp(view.fundingDeadline);
    const fundingPhase = catalogFundingPhase(live, kind, deadline, now);
    if (fundingPhase === 'filled' && catalogTimestamp(row.createdAt)) catalog.fundingRows.set(key, row);
    const mode = !['funding', 'ending'].includes(kind) ? '' : view.agentOnly ? '仅 Agent' :
      view.whitelistEnabled && catalogTimestamp(view.whitelistDeadline) > now ? '白名单期' : '公开 Mint';
    const mintIndex = mint.indexOf(key);
    const hasSnipe = snipe.has(key);
    const previous = old.get(key);
    old.delete(key);
    // Ignore new block numbers when no data shown on the card changed.
    const version = JSON.stringify([row.url, kind, title, mode, view.mintedLots, view.totalLots,
      view.pricePerLot, view.fundingDeadline, mintIndex, hasSnipe, disabled, fundingPhase, row.createdAt]);
    if (previous?.dataset.catalogVersion === version) return previous;
    const card = catalogCard(row, { key, view, kind, title, tone, mode, mintIndex, hasSnipe, disabled, fundingPhase, now });
    card.dataset.catalogVersion = version;
    if (previous) {
      const focused = previous.contains(document.activeElement) && document.activeElement.dataset.catalogAction;
      previous.replaceWith(card);
      if (focused) {
        const sameAction = card.querySelector('[data-catalog-action="' + focused + '"]:not(:disabled)');
        (sameAction ?? card.querySelector('[data-catalog-action="mint"]:not(:disabled)') ??
          card.querySelector('[data-catalog-action="copy"]'))?.focus({ preventScroll: true });
      }
    }
    return card;
  });
  for (const node of old.values()) node.remove();
  next.forEach((node, index) => {
    const current = list.children.item(index);
    if (current !== node) list.insertBefore(node, current);
  });
}
function catalogText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}
function renderDiscover() {
  if ($('view-discover').hidden || catalogPaintQueued) return;
  catalogPaintQueued = true;
  const frame = typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible' ? requestAnimationFrame : setTimeout;
  frame(() => {
    catalogPaintQueued = false;
    if (!$('view-discover').hidden) paintDiscover();
  });
}
function paintDiscover() {
  const now = Math.floor(Date.now() / 1000);
  const entries = [];
  for (const row of catalogRowsForDisplay()) {
    if (!catalogMatches(row, catalog.query)) continue;
    const key = projectKey(row);
    const live = catalog.statuses.get(key);
    const phase = catalogPhase(live, now);
    const [kind] = phase;
    if (catalog.filter !== 'all' &&
        !(catalog.filter === 'funding' ? ['funding', 'ending'].includes(kind) : catalog.filter === kind)) continue;
    const sortKey = catalog.sort === 'progress' ? -(catalogProgress(live) ?? -1) :
      catalog.sort === 'ending' && ['funding', 'ending', 'funded'].includes(kind) ? catalogTimestamp(live?.fundingDeadline) || Infinity : Infinity;
    entries.push({ row, key, live, phase, sortKey });
  }
  if (catalog.sort !== 'latest') entries.sort((a, b) => a.sortKey === b.sortKey ? 0 : a.sortKey < b.sortKey ? -1 : 1);
  const exact = validAddress(catalog.query);
  const lookup = exact && catalog.lookups.get(catalog.query);
  const looking = exact && lookup?.loading;
  const total = catalog.total == null ? '' : ' / 链上登记 ' + fmtInt.format(catalog.total);
  const loaded = '已加载 ' + fmtInt.format(catalog.rows.length) + total + ' · 显示 ' + fmtInt.format(entries.length);
  const scope = !catalog.query ? '' : exact ? ' · 全目录地址查询' : ' · 搜索已加载项目';
  catalogText('catalog-summary', !catalog.loaded ? (catalog.error ? '目录暂不可用，将自动重试' : '正在读取链上目录…') : loaded + scope);
  const active = catalogVisible();
  catalogText('catalog-live-label', !active ? (state.session ? '已暂停' : '自动连接中') :
    catalog.failures ? '自动重试中' : catalog.loaded ? '自动更新' : '正在同步');
  $('catalog-live-dot').className = 'dot ' + (catalog.failures ? 'stopping' : active && catalog.loaded ? 'ready' : '');
  catalogText('catalog-updated', catalog.lastUpdated ? '最近同步 ' + fmtTime.format(new Date(catalog.lastUpdated)) +
    (catalog.lastBlock ? ' · 区块 #' + fmtInt.format(catalog.lastBlock) : '') : '尚未同步');
  const warning = catalog.error || catalog.statusError || (lookup?.error ?? '');
  catalogText('catalog-notice', warning);
  $('catalog-notice').hidden = !warning;
  const list = $('discover-results');
  if (entries.length) updateCatalogCards(list, entries, now);
  else {
    catalog.fundingRows.clear();
    const msg = looking ? '正在工厂目录中查找此地址…' : !catalog.loaded && !catalog.error ? '正在读取 Corla 项目…'
      : exact && lookup?.done && !lookup.project ? 'Corla v4 工厂中未找到该地址。'
      : catalog.query || catalog.filter !== 'all' ? '没有匹配项目。可切换筛选，或加载更多项目后再找。' : '暂未读到项目，看板将自动更新。';
    if (list.firstElementChild?.classList.contains('catalog-empty')) {
      if (list.firstElementChild.textContent !== msg) list.firstElementChild.textContent = msg;
    } else list.replaceChildren(element('div', 'empty roomy catalog-empty', msg));
  }
  const more = $('catalog-more');
  more.hidden = catalog.nextCursor === null;
  const loadingMore = catalog.busy === 'more' || catalog.morePending;
  more.disabled = loadingMore || !state.session || state.reloadRequired === 'SESSION_EXPIRED';
  const moreText = loadingMore ? '加载中…' : '加载更多项目';
  if (more.textContent !== moreText) setButton(more, moreText, 'plus');
}
function catalogVisible() {
  return Boolean(state.session) && state.reloadRequired !== 'SESSION_EXPIRED' && !$('view-discover').hidden && document.visibilityState === 'visible';
}
function catalogFundingTick() {
  if (!catalogVisible()) return;
  retryVisibleMetadata();
  const now = Math.floor(Date.now() / 1000);
  for (const node of $('discover-results').querySelectorAll('[data-funding-phase="active"]')) paintCatalogDuration(node, now);
  void loadCatalogFundingTimes();
}
async function loadCatalogFundingTimes() {
  const now = Date.now();
  if (!catalogVisible() || catalog.fundingReading || now < catalog.fundingNextAt) return;
  const wanted = new Map();
  for (const [key, row] of catalog.fundingRows) {
    const cached = catalog.fundingTimes.get(key);
    if (!cached?.filledAt && (cached?.retryAt ?? 0) <= now) wanted.set(key, row);
    if (wanted.size === CATALOG_FUNDING_LIMIT) break;
  }
  if (!wanted.size) return;
  catalog.fundingReading = true;
  const received = new Set();
  let retryAfterMs = 0;
  try {
    const data = await api('catalog/funding-times', { urls: [...wanted.values()].map(row => row.url) });
    const retry = Number(data.retryAfterMs);
    if (Number.isFinite(retry) && retry > 0) retryAfterMs = Math.max(3000, Math.min(120_000, retry));
    for (const hit of Array.isArray(data.projects) ? data.projects : []) {
      const key = projectKey(hit ?? {});
      const row = wanted.get(key);
      const filledAt = catalogTimestamp(hit?.filledAt);
      if (!row || !filledAt || filledAt < catalogTimestamp(row.createdAt) ||
          (catalogTimestamp(row.fundingDeadline) && filledAt > catalogTimestamp(row.fundingDeadline))) continue;
      boundedSet(catalog.fundingTimes, key, { filledAt }, 1024);
      received.add(key);
    }
    if (catalogVisible() && received.size) {
      const seconds = Math.floor(Date.now() / 1000);
      for (const node of $('discover-results').querySelectorAll('[data-funding-phase="filled"]')) {
        if (received.has(node.dataset.catalogDuration)) paintCatalogDuration(node, seconds);
      }
    }
  } catch { /* Historical evidence is optional; do not disturb the live catalog. */ }
  finally {
    const after = Date.now();
    for (const [key] of wanted) {
      if (received.has(key)) continue;
      const attempts = Math.min((catalog.fundingTimes.get(key)?.attempts ?? 0) + 1, 5);
      const delay = retryAfterMs || 4000 * 2 ** (attempts - 1);
      boundedSet(catalog.fundingTimes, key, { attempts, retryAt: after + delay }, 1024);
    }
    catalog.fundingNextAt = after + 1500;
    catalog.fundingReading = false;
  }
}
function scheduleCatalogAuto(delay) {
  clearTimeout(catalogAutoTimer);
  if (catalogVisible()) catalogAutoTimer = setTimeout(() => { void loadCatalog({ more: catalog.morePending }); }, delay);
}
function resumeCatalogAuto() {
  clearTimeout(catalogAutoTimer);
  clearInterval(catalogFundingTimer);
  catalog.resumePending = catalogVisible() && Boolean(catalog.busy);
  if (!catalogVisible()) catalog.morePending = false;
  if (catalogVisible() && !catalog.busy) scheduleCatalogAuto(0);
  if (catalogVisible() && validAddress(catalog.query)) void resolveCatalogAddress(catalog.query);
  renderDiscover();
  if (catalogVisible()) {
    catalogFundingTimer = setInterval(catalogFundingTick, 1000);
    // A previous request might have finished while the board was hidden.
    const now = Math.floor(Date.now() / 1000);
    for (const node of $('discover-results').querySelectorAll('[data-funding-phase="filled"]')) paintCatalogDuration(node, now);
    catalogFundingTick();
  }
}
function catalogStatusRows(page) {
  const rows = new Map();
  const now = Date.now();
  const eligible = row => {
    const key = projectKey(row);
    const status = catalog.statuses.get(key);
    // A local deadline is not proof of a terminal on-chain state. Keep
    // checking sold-out Mints until the contract confirms launch.
    const terminal = status?.launched || status?.emergencyWithdrawn ||
      (status?.phase === 2 && catalogProgress(status) !== 1000);
    return !terminal || now - (catalog.statusReadAt.get(key) ?? 0) >= CATALOG_TERMINAL_RECHECK_MS;
  };
  const add = row => {
    if (row && rows.size < CATALOG_STATUS_LIMIT && eligible(row)) rows.set(projectKey(row), row);
  };
  add(catalog.lookups.get(catalog.query)?.project);
  page.forEach(add);
  const remainder = catalog.rows.filter(row => !rows.has(projectKey(row)) && eligible(row));
  if (remainder.length) {
    const start = catalog.statusOffset % remainder.length;
    const length = Math.min(remainder.length, CATALOG_STATUS_LIMIT - rows.size);
    for (let i = 0; i < length; i++) add(remainder[(start + i) % remainder.length]);
    catalog.statusOffset = (start + length) % remainder.length;
  }
  return [...rows.values()];
}
async function loadCatalogStatus(rows) {
  if (!rows.length || !catalogVisible()) return true;
  if (catalog.reading) return true;
  catalog.reading = true;
  try {
    const d = await api('catalog/status', { urls: rows.map(row => row.url) });
    const pending = new Set(rows.map(projectKey));
    const count = pending.size;
    for (const row of d.projects ?? []) {
      const key = projectKey(row ?? {});
      if (!pending.has(key)) continue;
      const old = catalog.statuses.get(key);
      if (row.error) {
        if (!old) catalog.statuses.set(key, row);
        continue;
      }
      if (typeof row.launched !== 'boolean' || Number(row.block ?? 0) < Number(old?.block ?? 0)) continue;
      catalog.statuses.set(key, row);
      catalog.statusReadAt.set(key, Date.now());
      pending.delete(key);
    }
    catalog.statusError = pending.size ? '部分链上状态暂未同步，已保留可用快照。' : '';
    return pending.size < count;
  } catch (e) {
    catalog.statusError = '链上状态暂未同步，已保留可用快照。' + e.message;
    return false;
  } finally {
    catalog.reading = false;
    renderDiscover();
  }
}
function mergeCatalogPage(data, page, older = false) {
  const total = older ? catalog.total : catalogInteger(data.total);
  const byIndex = new Map();
  const byKey = new Map();
  // A cached older page may fill gaps, but cannot replace a known newer snapshot.
  for (const row of older ? [...page, ...catalog.rows] : [...catalog.rows, ...page]) {
    const index = catalogInteger(row.index);
    if (index === null || (total !== null && index >= total)) continue;
    const key = projectKey(row);
    const oldIndex = byKey.get(key);
    if (oldIndex !== undefined) byIndex.delete(oldIndex);
    const old = byIndex.get(index);
    if (old) byKey.delete(projectKey(old));
    byIndex.set(index, row);
    byKey.set(key, index);
  }
  catalog.rows = [...byIndex.values()].sort((a, b) => Number(b.index) - Number(a.index));
  catalog.total = total ?? catalog.total;
  // Continue below the contiguous range, but don't skip a gap after many new registrations.
  let cursor = catalogInteger(data.nextCursor);
  while (cursor > 0n && byIndex.has(cursor - 1n)) cursor--;
  catalog.nextCursor = cursor > 0n ? String(cursor) : null;
}
async function loadCatalog({ more = false } = {}) {
  if (!catalogVisible()) return;
  if (more && catalog.nextCursor === null) {
    catalog.morePending = false;
    scheduleCatalogAuto(CATALOG_REFRESH_MS);
    return;
  }
  if (catalog.busy || catalog.reading) {
    if (more && catalog.busy !== 'more') {
      catalog.morePending = true;
      renderDiscover();
    }
    if (!catalog.busy) scheduleCatalogAuto(200);
    return;
  }
  clearTimeout(catalogAutoTimer);
  catalog.busy = more ? 'more' : 'auto';
  if (more) catalog.morePending = false;
  let updated = false;
  const startedAt = performance.now();
  renderDiscover();
  try {
    const request = { limit: CATALOG_LIMIT };
    if (more) request.cursor = catalog.nextCursor;
    else request.refresh = true;
    const d = await api('catalog', request);
    if (!Array.isArray(d.projects)) throw new Error('目录返回格式不正确。');
    const block = Number(d.block ?? 0);
    if (!more && block && block < catalog.headBlock) throw new Error('节点返回了较旧的区块。');
    const page = d.projects.map(catalogRow).filter(Boolean);
    const older = more && block < catalog.headBlock;
    mergeCatalogPage(d, page, older);
    if (!older && block > catalog.headBlock) catalog.headBlock = block;
    catalog.loaded = true;
    catalog.error = '';
    for (const row of page) catalog.pendingMetadata.set(projectKey(row), row);
    const exact = catalog.lookups.get(catalog.query)?.project;
    if (exact) catalog.pendingMetadata.set(projectKey(exact), exact);
    if (catalogVisible()) {
      queueMetadata(catalog.pendingMetadata.values());
      catalog.pendingMetadata.clear();
      renderDiscover();
      updated = await loadCatalogStatus(catalogStatusRows(page));
      if (updated && !more) {
        catalog.lastUpdated = Date.now();
        catalog.lastBlock = catalog.headBlock;
      }
    }
  } catch (e) { catalog.error = '代币目录未更新。' + e.message; }
  finally {
    if (!more) {
      if (updated) catalog.failures = 0;
      else if (catalogVisible()) catalog.failures = Math.min(catalog.failures + 1, 4);
    }
    catalog.busy = '';
    const resume = catalog.resumePending;
    catalog.resumePending = false;
    renderDiscover();
    if (catalogVisible() && catalog.morePending && catalog.nextCursor !== null) void loadCatalog({ more: true });
    else {
      catalog.morePending = false;
      const delay = Math.min(30_000, CATALOG_REFRESH_MS * 2 ** catalog.failures);
      scheduleCatalogAuto(resume ? 0 : catalog.failures ? delay : Math.max(300, delay - (performance.now() - startedAt)));
    }
  }
}
async function resolveCatalogAddress(query) {
  if (!catalogVisible() || !validAddress(query) || catalog.rows.some(row => catalogMatches(row, query))) return;
  const before = catalog.lookups.get(query);
  if (before?.loading || (before?.done && before.expires > Date.now())) return;
  boundedSet(catalog.lookups, query, { loading: true }, 64);
  if (query === catalog.query) renderDiscover();
  try {
    const d = await api('catalog/resolve', { address: query });
    const project = catalogRow(d.project);
    if (project && !catalogMatches(project, query)) throw new Error('目录返回的地址不匹配。');
    boundedSet(catalog.lookups, query, { done: true, project, expires: Date.now() + (project ? 300_000 : 12_000) }, 64);
    if (project) {
      if (catalogVisible()) {
        queueMetadata([project]);
        if (!catalog.busy && !catalog.reading) await loadCatalogStatus([project]);
      }
    }
  } catch (e) { boundedSet(catalog.lookups, query, { error: '完整地址查询失败：' + e.message }, 64); }
  finally { if (query === catalog.query && !$('view-discover').hidden) renderDiscover(); }
}
function setBusy(name = '') {
  state.busy = name;
  renderControls();
  renderProjects();
  renderDiscover();
}
function setConfig(config) {
  configEpoch++;
  state.config = normalizeConfig(config);
  state.source = 'local';
  const configured = new Set(targetsOf('all').map(target => projectKey(parsedTarget(target) ?? {})));
  state.projects = state.projects.filter(row => configured.has(projectKey(row)));
  renderConfigForms();
  renderControls();
  renderProjects();
  renderDiscover();
  queueMetadata(targetsOf('all'));
  resumeSnipeProgress();
}
async function saveConfig(config) {
  const saved = await api('config', { config, configRevision: state.configRevision });
  state.configRevision = saved.configRevision ?? state.configRevision;
  state.stateRevision = '';
  setConfig(saved.config);
}
let polling = false, statePollTimer;
function scheduleStatePoll() {
  clearTimeout(statePollTimer);
  if (!state.session || state.reloadRequired === 'SESSION_EXPIRED') return;
  const active = state.running || state.starting || state.stopping || state.busy === 'start' || state.busy === 'stop';
  const visible = document.visibilityState === 'visible';
  const delay = visible ? (active ? 1400 : 3500) : (active ? 10_000 : 30_000);
  statePollTimer = setTimeout(() => { void updateState(); }, delay);
}
function mergeSnapshots(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const configured = new Set(targetsOf('all').map(target => projectKey(parsedTarget(target) ?? {})));
  const merged = new Map(state.projects.map(row => [projectKey(row), row]).filter(([key]) => configured.has(key)));
  for (const row of rows) {
    const key = projectKey(row ?? {});
    if (!key || !configured.has(key)) continue;
    const prev = merged.get(key);
    const nextBlock = Number(row.block || row.blockNumber || 0);
    const previousBlock = Number(prev?.block || prev?.blockNumber || 0);
    if (prev && nextBlock && nextBlock < previousBlock) continue;
    if (row.error && prev && !prev.error) {
      merged.set(key, { ...prev, refreshError: row.error });
    } else if (!prev || nextBlock >= previousBlock) {
      merged.set(key, row);
    }
  }
  state.projects = [...merged.values()];
}
function applyRunState(data, fallbackWorkspace = 'mint') {
  state.running = Boolean(data.running);
  state.mode = data.mode;
  state.workspace = data.workspace ?? (state.running ? fallbackWorkspace : null);
  state.starting = Boolean(data.starting);
  state.stopping = Boolean(data.stopping);
  if (typeof data.snipeReport === 'string' && /^reports\/snipe-runs\/snipe-[\w-]+\.ndjson$/.test(data.snipeReport)) state.snipeReport = data.snipeReport;
}
async function updateState() {
  if (polling || !state.session || state.reloadRequired === 'SESSION_EXPIRED') return;
  clearTimeout(statePollTimer);
  polling = true;
  const epoch = configEpoch;
  const observedRunEpoch = runEpoch;
  try {
    const query = new URLSearchParams();
    if (state.stateRevision) query.set('since', state.stateRevision);
    if (state.logCursor) query.set('afterLog', state.logCursor);
    const d = await api('state' + (query.size ? '?' + query : ''));
    if (state.reloadRequired === 'SESSION_EXPIRED') return;
    setConnection(true, state.reloadRequired === 'CONFIG_STALE' ? '配置已在其他页面修改' : '本地已连接');
    if (currentView !== 'discover') retryVisibleMetadata();
    if (d.unchanged) return;
    // An older poll may finish after a local save. Do not let that poll
    // invalidate our new revision or skip reconciliation on the next poll.
    const checkRevision = epoch === configEpoch && state.busy !== 'config';
    if (checkRevision) {
      state.stateRevision = observedRunEpoch === runEpoch && typeof d.stateRevision === 'string' ? d.stateRevision : '';
      if (typeof d.configRevision === 'string' && d.configRevision !== state.configRevision) requirePageReload('CONFIG_STALE');
    } else state.stateRevision = '';
    const wasFrozen = frozen();
    if (observedRunEpoch === runEpoch) applyRunState(d);
    state.lastError = d.lastError || '';
    state.lastErrorWorkspace = d.lastErrorWorkspace || null;
    const previous = JSON.stringify(state.projects);
    // A manually refreshed snapshot can arrive just ahead of the poll response.
    // Only let a server snapshot replace it when the server has project rows.
    mergeSnapshots(d.projects);
    if (previous !== JSON.stringify(state.projects) || wasFrozen !== frozen()) renderProjects();
    if (wasFrozen !== frozen()) renderDiscover();
    const logs = Array.isArray(d.logs) ? d.logs : [];
    state.logCursor = typeof d.logCursor === 'string' ? d.logCursor : '';
    if (d.logsDelta ? logs.length : JSON.stringify(logs) !== JSON.stringify(state.logs)) {
      state.logs = d.logsDelta ? [...state.logs, ...logs].slice(-150) : logs;
      renderLogs();
    }
    renderControls();
  } catch {
    if (state.reloadRequired !== 'SESSION_EXPIRED') setConnection(false, '连接中断');
  } finally {
    polling = false;
    scheduleStatePoll();
  }
}
async function refresh({ silent = false, workspace = 'all', automatic = false } = {}) {
  if (!canRefresh(workspace) || isRefreshing(workspace) || workspace === 'all' && refreshJobs.size) return;
  const started = performance.now();
  const epoch = configEpoch;
  const scopes = workspace === 'all' ? ['mint', 'snipe'] : [workspace];
  refreshJobs.set(workspace, { automatic });
  renderControls();
  try {
    // Use the saved list for the snipe snapshot, not editable parameters;
    // this is an existing read endpoint and never changes the running plan.
    const d = await api('status', { ...(workspace === 'snipe' ? {} : { config: state.config }), workspace, summaryOnly: true });
    if (epoch !== configEpoch || state.reloadRequired) return;
    const rows = Array.isArray(d.projects) ? d.projects : [];
    const incoming = new Map(rows.map(row => [projectKey(row ?? {}), row]));
    const previous = new Map(state.projects.map(row => [projectKey(row), row]));
    const elapsed = Math.round(performance.now() - started);
    let totalFailed = 0;
    for (const scope of scopes) {
      const scoped = targetsOf(scope).map(target => projectKey(parsedTarget(target) ?? {}));
      const failed = scoped.filter(key => {
        const row = incoming.get(key), before = previous.get(key);
        return !row || row.error || Number(row.block || row.blockNumber || 0) < Number(before?.block || before?.blockNumber || 0);
      }).length;
      totalFailed += failed;
      const last = refreshResults.get(scope);
      refreshResults.set(scope, failed
        ? { ...last, error: failed + ' 项未更新，保留可用快照' }
        : { at: new Date(), ms: elapsed, error: '' });
    }
    mergeSnapshots(rows);
    if (!state.reloadRequired) setNotice('fatal', '');
    if (workspace === 'snipe') renderProjectList('snipe'); else renderProjects();
    if (!silent) notify(totalFailed ? '部分项目未刷新，保留上次快照。' : '已刷新链上状态 · ' + elapsed + ' ms');
  } catch (e) {
    if (epoch === configEpoch) {
      for (const scope of scopes) refreshResults.set(scope, { ...refreshResults.get(scope), error: '刷新失败，保留可用快照：' + e.message });
      if (!silent) notify(e.message, true);
    }
  } finally {
    refreshJobs.delete(workspace);
    renderControls();
    if (!automatic) queueMetadata(targetsOf(workspace));
    if (scopes.includes('snipe')) resumeSnipeProgress(epoch !== configEpoch);
    if (epoch !== configEpoch && workspace !== 'snipe') setTimeout(() => void refresh({ silent: true, workspace }), 0);
  }
}
let previewTimer, previewSequence = 0;
const MINT_BALANCE_FRESH_MS = 22_000;
const MINT_BALANCE_REFRESH_MS = 15_000;
const emptyMintBalanceRead = () => ({ key: '', rows: new Map(), block: null, at: 0, project: null, loading: false, failed: false });
let mintBalanceRead = emptyMintBalanceRead();
let mintBalanceTimer, mintWalletAuto = false, mintBatchesAuto = false;
const mintDialogTarget = () => parsedTarget({ url: $('project-url').value.trim() });
function selectedMintWallets() {
  return [...$('project-wallet-choices').querySelectorAll('input:checked')].map(input => input.value);
}
function renderMintWalletChoices(selected) {
  const choices = $('project-wallet-choices');
  const rows = state.wallets.map((w, i) => ({ ...w, title: w.label || '钱包 ' + (i + 1), missing: false }));
  for (const address of selected ?? []) {
    if (!rows.some(row => same(row.address, address))) rows.push({ address, title: '钱包已移除', missing: true });
  }
  choices.replaceChildren(...rows.map(({ address, title, missing }) => {
    const row = element('label', 'checkbox-row wallet-choice' + (missing ? ' wallet-missing' : ''));
    const box = element('input');
    box.type = 'checkbox';
    box.value = address;
    box.checked = selected?.some(wallet => same(wallet, address)) ?? false;
    row.dataset.mintWallet = address.toLowerCase();
    if (missing) row.dataset.missing = 'true';
    const text = element('span', 'mint-wallet-name', title);
    text.append(element('small', 'mono', short(address)));
    text.title = address;
    const quota = element('small', 'mint-wallet-quota');
    quota.append(element('span', 'mint-wallet-quota-used'), element('span', 'mint-wallet-quota-left'));
    text.append(quota);
    const meta = element('span', 'mint-wallet-meta');
    meta.append(element('span', 'mint-wallet-balance mono', '—'), element('span', 'mint-wallet-result'));
    row.append(box, text, meta);
    return row;
  }));
  if (!rows.length) choices.append(element('p', 'hint', '请先在钱包管理中导入钱包。'));
}
function mintBalanceFresh(target) {
  return mintBalanceRead.key === (projectKey(target ?? {}) ?? '') && !mintBalanceRead.failed && mintBalanceRead.at > 0 &&
    Date.now() - mintBalanceRead.at < MINT_BALANCE_FRESH_MS;
}
function mintWalletGasReserve() {
  return BigInt(state.config?.gasLimitCap ?? defaults.outer.gasLimitCap) *
    decimal(state.config?.maxGasPriceGwei ?? defaults.outer.maxGasPriceGwei, 9);
}
function walletBalanceText(value) {
  if (value === null) return '— BNB';
  const exact = formatUnits(value);
  const [whole, fraction = ''] = exact.split('.');
  const visible = fraction.slice(0, 8).replace(/0+$/, '');
  if (value > 0n && whole === '0' && !visible) return '<0.00000001 BNB';
  return whole + (visible ? '.' + visible : '') + ' BNB';
}
async function loadMintWalletBalances() {
  if (!$('project-dialog').open || !state.wallets.length || state.reloadRequired) return;
  const target = mintDialogTarget();
  const key = projectKey(target ?? {}) ?? '';
  if (mintBalanceRead.loading && mintBalanceRead.key === key) return;
  const request = { ...(mintBalanceRead.key === key ? mintBalanceRead : emptyMintBalanceRead()), key, loading: true };
  mintBalanceRead = request;
  updateMintFields();
  try {
    const data = await api('project/wallet-balances', target ? { url: target.url } : {});
    if (mintBalanceRead !== request || !$('project-dialog').open) return;
    if (!Number.isSafeInteger(data.block) || data.block < 1 || !Array.isArray(data.wallets)) throw new Error('余额快照无效');
    if (request.block !== null && data.block < request.block) return; // Neither replace newer balances nor extend their freshness.
    const known = new Set(state.wallets.map(w => w.address.toLowerCase()));
    request.rows = new Map(data.wallets.filter(row => validAddress(row?.address) && known.has(row.address.toLowerCase()))
      .map(row => [row.address.toLowerCase(), row]));
    request.block = data.block;
    request.project = key && data.project && projectKey(data.project) === key ? data.project : null;
    request.at = Date.now();
    request.failed = false;
  } catch {
    if (mintBalanceRead === request) request.failed = true;
  } finally {
    if (mintBalanceRead === request && $('project-dialog').open) {
      request.loading = false;
      updateMintFields();
    }
  }
}
function paintMintWalletFunding(qty, validQty, claim) {
  const target = mintDialogTarget();
  const key = projectKey(target ?? {});
  const fresh = mintBalanceFresh(target);
  const balanceProject = mintBalanceRead.project;
  const preview = key && projectKey(state.preview ?? {}) === key ? state.preview : null;
  const project = fresh && balanceProject ? balanceProject : preview;
  let gasWei;
  try { gasWei = mintWalletGasReserve(); } catch { /* Unknown gas configuration cannot qualify a wallet. */ }
  let sufficient = 0, missingBalance = 0;
  for (const node of $('project-wallet-choices').querySelectorAll('[data-mint-wallet]')) {
    const input = node.querySelector('input');
    const row = mintBalanceRead.rows.get(node.dataset.mintWallet);
    const balance = catalogInteger(row?.balanceWei);
    const amount = node.querySelector('.mint-wallet-balance');
    const result = node.querySelector('.mint-wallet-result');
    const missing = node.dataset.missing === 'true';
    const quota = node.querySelector('.mint-wallet-quota');
    quota.hidden = !key || missing;
    if (!quota.hidden) {
      const known = fresh ? mintWalletQuota(project, row) : null;
      quota.querySelector('.mint-wallet-quota-used').textContent = known
        ? '已 Mint ' + fmtInt.format(known.minted) + '/' + fmtInt.format(known.cap) + ' 次'
        : mintBalanceRead.loading && !mintBalanceRead.at ? '正在读取 Mint 次数…'
          : !fresh && mintBalanceRead.at ? 'Mint 次数待刷新' : 'Mint 次数未读到';
      quota.querySelector('.mint-wallet-quota-left').textContent = !known ? '' : known.stop === 'launched' ? '已开盘' :
        known.stop === 'closed' ? 'Mint 已结束' : known.stop === 'sold-out' ? '项目已打满' :
          '剩余限额 ' + fmtInt.format(known.remaining) + ' 次';
      quota.title = known && !known.stop ? '这是合约的单地址剩余限额，不代表当前可立即 Mint；仍受项目剩余份额、开放阶段和白名单限制。' : '';
    }
    if (!missing && balance === null) missingBalance++;
    const funding = fresh && validQty && !missing
      ? mintWalletFunding({ batches: qty, autoClaim: claim, project, wallet: row, gasWei })
      : { status: 'unknown', needWei: null };
    if (funding.status === 'sufficient') sufficient++;
    if (mintWalletAuto) input.checked = funding.status === 'sufficient';
    node.dataset.funding = funding.status;
    amount.textContent = missing ? '—' : walletBalanceText(balance);
    const tips = [];
    if (balance !== null) tips.push('余额 ' + formatUnits(balance) + ' BNB');
    if (funding.needWei !== null) tips.push('需预留 ' + formatUnits(funding.needWei) + ' BNB（含 Gas）');
    amount.title = tips.join('；');
    result.textContent = missing ? '不在钱包库' : funding.status === 'sufficient' ? '余额足够' :
      funding.status === 'insufficient' ? '余额不足' : funding.status === 'idle' ? '无待执行动作' :
      !fresh && balance !== null ? '余额待刷新' : balance === null ? '余额未读到' : '待核对项目';
  }
  $('project-wallet-sufficient').disabled = !sufficient;
  $('project-wallet-refresh').disabled = mintBalanceRead.loading || !state.wallets.length;
  const snapshot = '区块 #' + fmtInt.format(mintBalanceRead.block);
  $('project-wallet-balance-status').textContent = !state.wallets.length ? '导入钱包后可读取 BNB 余额。' :
    mintBalanceRead.loading ? '正在读取 BNB 余额…' : mintBalanceRead.failed ? '余额读取失败，可刷新重试。' :
      fresh ? snapshot + ' · ' + sufficient + ' 个余额足够' + (missingBalance ? ' · ' + missingBalance + ' 个余额未读到' : '') :
        mintBalanceRead.at ? '余额快照已过期，请刷新。' : '等待链上余额快照…';
}
function syncMintDefaultBatches() {
  if (!mintBatchesAuto) return;
  const key = projectKey(mintDialogTarget() ?? {});
  const balanceProject = mintBalanceRead.key === key ? mintBalanceRead.project : null;
  const preview = key && projectKey(state.preview ?? {}) === key ? state.preview : null;
  const project = balanceProject && Number(balanceProject.block ?? mintBalanceRead.block) >= Number(preview?.block ?? 0)
    ? balanceProject : preview;
  const value = mintDefaultBatches(project);
  const input = $('project-batches');
  const display = value === null ? '' : String(value);
  if (input.value !== display) input.value = display;
}
function updateMintFields() {
  syncMintDefaultBatches();
  const qty = Number($('project-batches').value);
  const validQty = UINT.test($('project-batches').value) && qty <= 32;
  const claim = $('project-claim').checked;
  paintMintWalletFunding(qty, validQty, claim);
  $('project-save-review').hidden = !state.allowLive || !state.wallets.length || (!qty && !claim);
  const selected = selectedMintWallets();
  const walletCount = selected.length;
  const missing = selected.some(address => !state.wallets.some(w => same(w.address, address)));
  $('project-wallet-summary').textContent = '参与钱包：已选 ' + walletCount + ' 个' + (missing ? '（含已移除）' : '');
  const estimate = $('project-estimate');
  if (missing) { estimate.textContent = '请取消选择已移除的钱包。'; return; }
  if (!validQty) {
    estimate.textContent = mintBatchesAuto && $('project-batches').value === '' ?
      '等待读取链上每地址限额和剩余份额，也可手动填写批数。' : '每钱包目标批数须为 0–32。';
    return;
  }
  if (!walletCount) {
    estimate.textContent = !qty && !claim ? '仅监控，不执行 Mint 或领币。' :
      '尚未选择参与钱包；请等待余额筛选、手动选择，或关闭 Mint 和领币，仅作监控。';
    return;
  }
  const cap = Number(state.preview?.maxMintsPerWallet ?? 0);
  const effective = cap > 0 ? Math.min(qty, cap) : qty;
  try {
    const mint = qty > 0 ? verifiedMintPrice(state.preview) : 0n;
    const gas = mintWalletGasReserve();
    const ceiling = BigInt(walletCount) * (BigInt(qty) * (mint + gas) + (claim ? gas : 0n));
    estimate.textContent = (qty > 0 ? '最多新增 ' + (walletCount * effective) + ' 批 · ' : '') +
      '预算预留上限 ' + formatUnits(ceiling) + ' BNB（含 Gas）' +
      (effective < qty ? ' · 链上限额将把实际每地址目标降到 ' + effective + ' 批' : '');
  } catch { estimate.textContent = '读取合约的每批应付金额后显示预算预留上限。'; }
}
function verifiedMintPrice(project, target) {
  if (target && (!same(project?.mint, target.mint) || !same(project?.token, target.token))) {
    throw new Error('请先读取该项目的链上参数，再保存 Mint 设置。');
  }
  const value = project?.pricePerLot;
  if ((typeof value !== 'bigint' && (typeof value !== 'string' || !UINT.test(value))) || BigInt(value) <= 0n) {
    throw new Error('未读到有效的链上单批金额，请点「读取链上参数」重试。');
  }
  return BigInt(value);
}
function showMintPreview(project) {
  state.preview = project;
  let price;
  try { price = formatUnits(verifiedMintPrice(project)); } catch { /* No verified quote yet. */ }
  const lots = project?.tokensPerLot == null ? null : formatUnits(project.tokensPerLot);
  const cap = project?.maxMintsPerWallet;
  $('project-price').textContent = price ? price + ' BNB' : '等待读取';
  $('project-preview').textContent = project ? [
    lots && lots !== '—' ? '每批份额 ' + lots + ' 枚' : null,
    cap != null ? '链上限额 ' + cap + ' 批 / 地址' : null,
    project.launched ? '已开盘（仅可领取）' : null,
  ].filter(Boolean).join(' · ') || '已读取链上参数。' : '粘贴链接后自动读取每批应付金额和限额。';
  updateMintFields();
}
async function fetchMintPreview({ force = false } = {}) {
  if (state.reloadRequired) return;
  let parsed;
  const id = ++previewSequence;
  try { parsed = parseLink($('project-url').value.trim()); } catch {
    showMintPreview(null);
    $('project-preview-button').disabled = false;
    if (force) $('project-preview').textContent = '请先粘贴有效的 Corla Mint 链接。';
    return;
  }
  const snapshot = projectSnapshot(parsed.url);
  const existing = projectKey(state.preview ?? {}) === projectKey(parsed) ? state.preview : null;
  const cached = Number(existing?.block ?? 0) >= Number(snapshot?.block ?? 0) ? existing ?? snapshot : snapshot;
  if (cached && !force) { showMintPreview(cached); $('project-preview-button').disabled = false; return; }
  $('project-preview').textContent = '正在读取链上参数…';
  $('project-preview-button').disabled = true;
  const current = () => id === previewSequence && $('project-dialog').open && !state.reloadRequired;
  try {
    let project;
    for (const delay of [0, 160, 350]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (!current()) return;
      try { ({ project } = await api('project/preview', { url: parsed.url })); break; }
      catch (e) { if (e.status !== 409 || e.code !== 'PREVIEW_BUSY' || delay === 350) throw e; }
    }
    if (!current()) return;
    if (!project || !same(project.mint, parsed.mint) || !same(project.token, parsed.token)) throw new Error('链上项目不匹配');
    if (cached && Number(project.block ?? 0) < Number(cached.block ?? 0)) throw new Error('节点返回了较旧的区块');
    showMintPreview(project);
  } catch {
    if (current()) {
      showMintPreview(cached ?? null);
      $('project-preview').textContent = cached ? '刷新失败，显示上次链上读取结果。' : '暂未读到链上参数，请重试。';
    }
  } finally { if (id === previewSequence) $('project-preview-button').disabled = Boolean(state.reloadRequired); }
}
function scheduleMintPreview() {
  clearTimeout(previewTimer);
  previewSequence++;
  // Discard the preceding project's wallet counts (and late responses).
  if (mintBalanceRead.key !== (projectKey(mintDialogTarget() ?? {}) ?? '')) mintBalanceRead = emptyMintBalanceRead();
  showMintPreview(null);
  $('project-preview-button').disabled = false;
  previewTimer = setTimeout(() => {
    if (!$('project-dialog').open) return;
    void fetchMintPreview();
    if (!mintBalanceFresh(mintDialogTarget())) void loadMintWalletBalances();
  }, 250);
}
function openProject(index, discoveredUrl = '', { claimOnly = false } = {}) {
  if (!state.config || frozen()) return;
  state.editing = index;
  const target = state.config.targets[index];
  $('project-dialog-title').textContent = target ? '配置 Mint 项目' : '添加 Mint 项目';
  $('project-url').value = target?.url ?? discoveredUrl;
  mintBatchesAuto = !target && !claimOnly;
  $('project-batches').value = target?.mintBatches ?? (claimOnly ? 0 : '');
  $('project-claim').checked = target?.autoClaim ?? true;
  $('project-wallet-picker').open = true;
  mintBalanceRead = emptyMintBalanceRead();
  mintWalletAuto = target?.mintWallets === undefined;
  renderMintWalletChoices(target?.mintWallets);
  $('delete-project').hidden = !target;
  setNotice('project-error', '');
  showMintPreview(projectSnapshot($('project-url').value) ?? null);
  $('project-preview-button').disabled = false;
  $('project-dialog').showModal();
  $(target || discoveredUrl ? 'project-batches' : 'project-url').focus();
  if ($('project-url').value) void fetchMintPreview();
  void loadMintWalletBalances();
  clearInterval(mintBalanceTimer);
  mintBalanceTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadMintWalletBalances();
  }, MINT_BALANCE_REFRESH_MS);
}
async function submitProject(event) {
  event.preventDefault();
  if (frozen()) return;
  const reviewAfterSave = event.submitter?.dataset.review === 'mint';
  setNotice('project-error', '');
  let saved = false;
  try {
    let parsed;
    try { parsed = parseLink($('project-url').value.trim()); } catch {
      throw new Error('请输入已核实工厂的 flap.sh Corla v4 Mint 链接。');
    }
    const config = configCopy();
    if (config.targets.some((target, index) => index !== state.editing && (same(parsedTarget(target)?.mint, parsed.mint) || same(parsedTarget(target)?.token, parsed.token)))) {
      throw new Error('该项目已在监控列表中。');
    }
    updateMintFields();
    const mintBatches = Number($('project-batches').value);
    if (!UINT.test($('project-batches').value) || mintBatches > 32) throw new Error('每钱包目标批数须为 0–32 的整数。');
    const target = { url: parsed.url, mintBatches, autoClaim: $('project-claim').checked };
    const selected = selectedMintWallets();
    if (target.mintBatches || target.autoClaim) {
      if (mintWalletAuto && state.wallets.length && !mintBalanceFresh(parsed)) {
        void loadMintWalletBalances();
        throw new Error('请等余额刷新后再保存，或手动选择参与钱包。');
      }
      if (!selected.length) throw new Error('请至少选择一个参与钱包；仅监控时把批数设为 0 并关闭自动领币。');
    }
    if (selected.length) {
      matchWallets({ mintWallets: selected }, state.wallets.map(w => w.address));
      target.mintWallets = selected;
    }
    if (target.mintBatches) {
      // Keep the saved amount as a fail-closed spending guard, not a bid.
      target.maxMintPriceBnb = formatUnits(verifiedMintPrice(state.preview, parsed));
    }
    if (state.editing >= 0) config.targets[state.editing] = target;
    else config.targets.push(target);
    if (config.targets.length > 32) throw new Error('最多监控 32 个项目。');
    setBusy('config');
    await saveConfig(config);
    saved = true;
    $('project-dialog').close();
    notify('Mint 项目配置已保存。');
  } catch (e) { setNotice('project-error', e.message); }
  finally { setBusy(); }
  if (saved && reviewAfterSave) {
    location.hash = 'overview';
    reviewLive('mint');
  } else if (saved) void refresh({ silent: true, workspace: 'mint' });
}
function openSnipe(discoveredUrl = '') {
  if (!state.config || frozen()) return;
  $('snipe-url').value = discoveredUrl;
  setNotice('snipe-add-error', '');
  $('snipe-add-dialog').showModal();
  $('snipe-url').focus();
}
async function submitSnipe(event) {
  event.preventDefault();
  if (frozen()) return;
  setNotice('snipe-add-error', '');
  let saved = false;
  try {
    let parsed;
    try { parsed = parseLink($('snipe-url').value.trim()); } catch { throw new Error('请粘贴有效的 Corla v4 Mint 链接。'); }
    const config = configCopy();
    if (targetsOf('snipe', config).some(target => same(parsedTarget(target)?.mint, parsed.mint) || same(parsedTarget(target)?.token, parsed.token))) {
      throw new Error('该项目已在狙击名单。');
    }
    if (config.snipeTargets.length >= 32) throw new Error('最多添加 32 个狙击目标。');
    config.snipeTargets.push(parsed.url);
    config.snipe = { ...defaults.snipe, ...config.snipe };
    setBusy('config');
    await saveConfig(config);
    saved = true;
    $('snipe-add-dialog').close();
    location.hash = 'snipe';
    notify('已加入狙击名单。');
  } catch (e) { setNotice('snipe-add-error', e.message); }
  finally { setBusy(); }
  if (saved) void refresh({ silent: true, workspace: 'snipe' });
}
function openProjectRemoval(index, workspace = 'mint') {
  const target = targetsOf(workspace)[index];
  if (frozen() || !target) return;
  state.pendingProjectRemove = { index, workspace };
  $('project-remove-title').textContent = workspace === 'snipe' ? '移除狙击目标' : '移除 Mint 项目';
  $('project-remove-copy').textContent = workspace === 'snipe' ? '只从狙击名单移除，不影响 Mint 工作区。' :
    '只从 Mint 工作区移除，不影响狙击名单。';
  $('project-remove-target').textContent = parsedTarget(target)?.token || '此项目';
  setNotice('project-remove-error', '');
  $('project-dialog').close();
  $('project-remove-dialog').showModal();
}
async function removeProject(event) {
  event.preventDefault();
  const { index, workspace } = state.pendingProjectRemove ?? {};
  if (frozen() || index == null || !targetsOf(workspace)[index]) return;
  setBusy('config');
  $('project-remove-submit').disabled = true;
  try {
    const config = configCopy();
    (workspace === 'snipe' ? config.snipeTargets : config.targets).splice(index, 1);
    await saveConfig(config);
    $('project-remove-dialog').close();
    notify(workspace === 'snipe' ? '已移除狙击目标。' : '已移除 Mint 项目。');
  } catch (e) { setNotice('project-remove-error', e.message); }
  finally { $('project-remove-submit').disabled = Boolean(state.reloadRequired); setBusy(); }
}
function validatePassword(password) {
  if ([...password.trim()].length < 12 || new TextEncoder().encode(password).length > 512) {
    throw new Error('钱包库密码至少 12 个字符，且不超过 512 字节。');
  }
}
function maskPrivateKeys(masked) {
  $('wallet-private-keys').classList.toggle('secret-mask', masked);
  $('wallet-keys-visibility').setAttribute('aria-pressed', String(!masked));
  setButton($('wallet-keys-visibility'), masked ? '显示私钥' : '隐藏私钥', 'eye');
}
function clearImportSecrets() {
  for (const id of ['wallet-private-keys', 'wallet-import-password', 'wallet-password-repeat']) $(id).value = '';
  maskPrivateKeys(true);
}
function openWalletImport() {
  if (!state.config || frozen() || state.wallets.length >= 32) return;
  clearImportSecrets();
  $('wallet-label').value = '';
  $('wallet-import-password-row').hidden = state.walletLocalUnlock;
  $('wallet-password-repeat-row').hidden = state.walletVaultExists || state.walletLocalUnlock;
  $('wallet-password-note').textContent = state.walletVaultExists ? '输入现有密码' : '首次导入设定，至少 12 个字符';
  setNotice('wallet-import-error', '');
  $('wallet-import-dialog').showModal();
  $('wallet-private-keys').focus();
}
async function importWallets(event) {
  event.preventDefault();
  if (frozen() || !state.config) return;
  const privateKeys = $('wallet-private-keys').value.split(/\r?\n/).map(key => key.trim()).filter(Boolean);
  let password = $('wallet-import-password').value;
  let repeat = $('wallet-password-repeat').value;
  clearImportSecrets();
  const label = $('wallet-label').value.trim();
  setNotice('wallet-import-error', '');
  let started = false;
  try {
    if (!privateKeys.length || privateKeys.some(key => !PRIVATE_KEY.test(key))) throw new Error('每行输入一个有效的 64 位十六进制私钥（可带 0x）。');
    if (state.wallets.length + privateKeys.length > 32) throw new Error('钱包总数不能超过 32。');
    if (privateKeys.length !== 1 && label) throw new Error('批量导入时请留空备注。');
    if (!state.walletLocalUnlock) {
      validatePassword(password);
      if (!state.walletVaultExists && password !== repeat) throw new Error('两次输入的钱包库密码不一致。');
    }
    repeat = '';
    setBusy('wallet-import');
    started = true;
    $('wallet-import-submit').disabled = true;
    setButton($('wallet-import-submit'), '正在加密…', 'lock');
    const request = api('wallets/import', { privateKeys, label, ...(state.walletLocalUnlock ? { useLocalUnlock: true } : { password }) });
    password = '';
    const result = await request;
    state.walletVaultExists = true;
    setWallets(result.wallets);
    $('wallet-import-dialog').close();
    notify('钱包已加密导入。');
  } catch (e) { setNotice('wallet-import-error', e.message); }
  finally {
    privateKeys.fill('');
    password = repeat = '';
    $('wallet-import-submit').disabled = Boolean(state.reloadRequired);
    setButton($('wallet-import-submit'), '加密并导入', 'lock');
    if (started) setBusy();
  }
}
function openWalletRemoval({ address, label }) {
  if (frozen()) return;
  state.pendingWalletRemove = address;
  $('wallet-remove-target').textContent = label ? label + ' · ' + address : address;
  $('wallet-remove-password').value = '';
  $('wallet-remove-password-row').hidden = state.walletLocalUnlock;
  setNotice('wallet-remove-error', '');
  $('wallet-remove-dialog').showModal();
  $(state.walletLocalUnlock ? 'wallet-remove-submit' : 'wallet-remove-password').focus();
}
async function removeWallet(event) {
  event.preventDefault();
  const address = state.pendingWalletRemove;
  if (frozen() || !validAddress(address)) return;
  let password = $('wallet-remove-password').value;
  $('wallet-remove-password').value = '';
  setNotice('wallet-remove-error', '');
  let started = false;
  try {
    if (!state.walletLocalUnlock) validatePassword(password);
    setBusy('wallet-remove');
    started = true;
    $('wallet-remove-submit').disabled = true;
    const request = api('wallets/remove', { address, ...(state.walletLocalUnlock ? { useLocalUnlock: true } : { password }) });
    password = '';
    const result = await request;
    state.walletVaultExists = true;
    setWallets(result.wallets);
    $('wallet-remove-dialog').close();
    notify('已删除本地钱包。');
  } catch (e) { setNotice('wallet-remove-error', e.message); }
  finally {
    password = '';
    $('wallet-remove-submit').disabled = Boolean(state.reloadRequired);
    if (started) setBusy();
  }
}
async function forgetLocalWalletUnlock() {
  if (!state.walletLocalUnlock || frozen()) return;
  setBusy('wallet-unlock');
  try {
    await api('wallets/forget-local-unlock', {});
    state.walletLocalUnlock = false;
    notify('已关闭本机免密码。下次需要原钱包库密码。');
  } catch (error) { notify(error.message, true); }
  finally { setBusy(); }
}
function openLocalWalletUnlock() {
  if (frozen() || !state.walletVaultExists || state.walletLocalUnlock || !state.walletLocalUnlockSupported) return;
  $('wallet-local-unlock-password').value = '';
  setNotice('wallet-local-unlock-error', '');
  $('wallet-local-unlock-dialog').showModal();
  $('wallet-local-unlock-password').focus();
}
async function rememberLocalWalletUnlock(event) {
  event.preventDefault();
  if (frozen() || state.walletLocalUnlock || !state.walletLocalUnlockSupported) return;
  const field = $('wallet-local-unlock-password');
  let password = field.value;
  field.value = '';
  setBusy('wallet-unlock');
  $('wallet-local-unlock-submit').disabled = true;
  try {
    validatePassword(password);
    const work = api('wallets/remember-local-unlock', { password });
    password = '';
    await work;
    state.walletLocalUnlock = true;
    $('wallet-local-unlock-dialog').close();
    notify('已开启 Windows 本机免密码。');
  } catch (error) { setNotice('wallet-local-unlock-error', error.message); }
  finally {
    password = '';
    $('wallet-local-unlock-submit').disabled = Boolean(state.reloadRequired);
    setBusy();
  }
}
function worstBudget(cfg, wallets, workspace) {
  const gas = BigInt(cfg.gasLimitCap ?? 10_000_000) * decimal(cfg.maxGasPriceGwei ?? '1', 9);
  if (workspace === 'snipe') {
    const buyers = BigInt(cfg.snipe.walletCount ?? 1);
    if (buyers > BigInt(wallets.length)) throw new Error('买入钱包数超出可用实盘钱包数。');
    return BigInt(cfg.snipeTargets.length) * buyers * BigInt(cfg.snipe.repeatAttempts ?? 1) * (gas + decimal(cfg.snipe.amountBnb, 18));
  }
  let total = 0n;
  for (const target of cfg.targets) {
    if (!target.mintBatches && !target.autoClaim) continue;
    const n = BigInt(matchWallets(target, wallets).length);
    if (target.mintBatches) total += n * BigInt(target.mintBatches) * (gas + decimal(target.maxMintPriceBnb, 18));
    if (target.autoClaim) total += n * gas;
  }
  return total;
}
function readParameters(form, defaultsGroup) {
  const values = new FormData(form);
  const result = {};
  if (form.id === 'snipe-form') {
    const issue = snipeOpeningPolicyError(form.elements);
    if (issue) throw new Error(issue);
  }
  for (const [name, fallback] of Object.entries(defaultsGroup)) {
    const raw = String(values.get(name) ?? '').trim();
    const input = form.elements[name];
    if (!input.checkValidity()) throw new Error('请检查' + (input.labels?.[0]?.innerText.trim() || '参数') + '的有效范围。');
    if (typeof fallback === 'boolean') {
      result[name] = input.checked;
    } else if (input.hasAttribute('data-bps-percent')) {
      result[name] = Number(decimal(raw, 2, { allowZero: input.min === '0' }));
    } else if (typeof fallback === 'number') {
      if (!UINT.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('区块、数量和基点必须是整数。');
      result[name] = Number(raw);
    } else {
      decimal(raw, name === 'maxGasPriceGwei' ? 9 : 18);
      result[name] = raw;
    }
  }
  return result;
}
function snipeOpeningPolicyError(fields) {
  if (fields.requirePreopen.indeterminate) return '保存的「没抢到开盘就不追」设置无效，请重新选择。';
  if (fields.requirePreopen.checked && (!UINT.test(fields.repeatAttempts.value) ||
      Number(fields.repeatAttempts.value) < 2 || Number(fields.repeatAttempts.value) > 5)) {
    return '已开启「没抢到开盘就不追」，请把「每项目每钱包最多提交」设为 2–5 次。';
  }
  return '';
}
function syncSnipeOpeningPolicy() {
  const fields = $('snipe-form').elements;
  const message = $('snipe-preopen-error');
  const issue = snipeOpeningPolicyError(fields);
  fields.repeatAttempts.min = fields.requirePreopen.checked ? '2' : '1';
  message.textContent = issue;
  message.hidden = !issue;
}
function reviewLive(workspace) {
  if (!liveAvailable(workspace) || frozen()) return;
  const config = configCopy();
  const wallets = state.wallets.map(({ address }) => address);
  const snipe = workspace === 'snipe';
  let paramsChanged = false;
  $('live-password').value = '';
  $('live-submit').disabled = true;
  $('live-title').textContent = '确认 ' + workspaceNames[workspace] + '实盘';
  let error = '';
  let total;
  try {
    if (snipe) {
      const params = readParameters($('snipe-form'), defaults.snipe);
      paramsChanged = Object.keys(params).some(key => params[key] !==
        (config.snipe?.[key] === undefined ? defaults.snipe[key] : config.snipe[key]));
      config.snipe = params;
    }
    total = worstBudget(config, wallets, workspace);
    if (total <= 0n) throw new Error('当前没有启用任何交易动作。');
    if (!config.maxTotalBnb || total > decimal(config.maxTotalBnb, 18)) throw new Error('预算预留上限超出总预算。请到「预算与 Gas」中复核。');
  } catch (e) { error = e.message; }
  setNotice('live-error', error);
  const settings = { ...defaults.snipe, ...config.snipe };
  const ul = element('ul');
  const used = new Set();
  if (snipe) {
    for (const address of wallets.slice(0, settings.walletCount)) used.add(address);
  } else {
    for (const target of targetsOf('mint', config)) {
      if (!target.mintBatches && !target.autoClaim) continue;
      try { for (const address of matchWallets(target, wallets)) used.add(address); } catch { /* already reported */ }
    }
  }
  for (const address of used) ul.append(element('li', 'mono', address));
  const projects = element('ul');
  for (const target of targetsOf(workspace, config)) {
    const choices = [];
    if (snipe) choices.push('开盘买入 ' + settings.amountBnb + ' BNB × ' + settings.walletCount + ' 钱包');
    else {
        if (target.mintBatches) choices.push('每钱包目标 ' + target.mintBatches + ' 批（受链上限制）；按链上单批价付款，超过保存价 ' + target.maxMintPriceBnb + ' BNB 不发单');
      if (target.autoClaim) choices.push('开盘后自动领币');
      if (choices.length) {
        choices.push((target.mintWallets?.length ?? wallets.length) + ' 个参与钱包');
        if (target.mintWallets) choices.push(target.mintWallets.map(short).join('、'));
      }
    }
    if (choices.length) {
      const item = element('li');
      item.append(element('code', '', parsedTarget(target)?.token ?? '未知地址'), document.createTextNode(' · ' + choices.join(' / ')));
      projects.append(item);
    }
  }
  $('live-summary').replaceChildren(element('h3', '', '本次参与钱包（' + used.size + '）'), ul, element('h3', '', '项目与操作'), projects,
    element('h3', '', '费用与限制'),
    element('p', '', '预算预留（含 Gas）：' + (total === undefined ? '—' : formatUnits(total)) + ' BNB / 配置上限 ' + (config.maxTotalBnb || '—') + ' BNB'),
    element('p', '', 'Gas 上限：' + (config.maxGasPriceGwei ?? '1') + ' Gwei × ' + (config.gasLimitCap ?? 10_000_000)));
  if (snipe) {
    const attempts = settings.repeatAttempts ?? 1;
    $('live-summary').append(element('p', '', (attempts > 1
      ? '竞争模式：每项目每钱包最多提交 ' + attempts + ' 次。末笔 Mint 可核验时会提前发单，回退会消耗 Gas；按次数预留本金和 Gas。'
      : '单次模式：首次有效开盘每钱包只尝试一次。') + ' 开盘窗口：' + settings.windowBlocks + ' 区块；最低储备：' +
      settings.minLiquidityBnb + ' WBNB；当前报价滑点上限：' + settings.slippageBps / 100 + '%；买税 / 卖税上限：' +
      settings.maxBuyTaxBps + ' / ' + settings.maxSellTaxBps + ' bps。'));
    $('live-summary').append(element('p', '', '开盘价溢价上限：' + settings.maxOpeningPremiumBps / 100 +
      '%（' + (settings.maxOpeningPremiumBps === 0 ? '不得高于开盘价' : '相对开盘基准报价') + '）。' +
      (settings.requirePreopen ? '没抢到开盘就不追：开盘确认后不补买，检测到代币已部署也不再新签。'
        : '允许开盘后补买，但开盘基准无法核验或超过上限时不发单。')));
    if (paramsChanged) $('live-summary').append(element('p', '', '本次使用当前狙击表单参数；如需下次复用，请另行保存狙击参数。'));
  }
  state.liveReview = { config, configRevision: state.configRevision, wallets, workspace, allowed: !error };
  $('live-password-row').hidden = state.walletLocalUnlock;
  $('live-local-unlock-note').hidden = !state.walletLocalUnlock;
  $('live-remember-local-row').hidden = state.walletLocalUnlock || !state.walletLocalUnlockSupported;
  $('live-remember-local').checked = state.walletLocalUnlockSupported && !state.walletLocalUnlock;
  $('live-password').disabled = Boolean(error);
  $('live-dialog').showModal();
  updateLiveSubmit();
  $(state.walletLocalUnlock ? 'live-cancel-review' : 'live-password').focus();
}
function updateLiveSubmit() {
  $('live-submit').disabled = frozen() || !state.liveReview?.allowed ||
    state.liveReview.configRevision !== state.configRevision ||
    (!state.walletLocalUnlock && !$('live-password').value);
}
async function startLive(event) {
  event.preventDefault();
  const review = state.liveReview;
  if (event.submitter !== $('live-submit') || $('live-submit').disabled ||
      frozen() || !review?.allowed || review.configRevision !== state.configRevision || !liveAvailable(review.workspace)) return;
  let password = $('live-password').value;
  $('live-password').value = '';
  updateLiveSubmit();
  setNotice('live-error', '');
  let attempt;
  try {
    if (!state.walletLocalUnlock) validatePassword(password);
    attempt = pendingLiveStart = { workspace: review.workspace, cancelRequested: false };
    setBusy('start');
    $('live-password').disabled = true;
    // The operator explicitly pressed the review's live button. Keep the
    // existing wire confirmation marker for the currently running server.
    const request = api('start', { config: review.config, configRevision: review.configRevision, workspace: review.workspace,
      mode: 'live', confirmation: 'BSC LIVE', expectedWallets: review.wallets,
      ...(state.walletLocalUnlock ? { useLocalUnlock: true } :
        { password, rememberLocalUnlock: state.walletLocalUnlockSupported && $('live-remember-local').checked }) });
    password = '';
    void updateState();
    const d = await request;
    if (typeof d.walletLocalUnlock === 'boolean') state.walletLocalUnlock = d.walletLocalUnlock;
    if (!attempt.cancelRequested) {
      runEpoch++;
      state.stateRevision = '';
      applyRunState(d, review.workspace);
      if (!state.reloadRequired) $('live-dialog').close();
      notify(d.running ? workspaceNames[review.workspace] + '实盘已启动。' : '启动请求结束，请检查当前运行状态。');
    }
  } catch (e) {
    if (!attempt?.cancelRequested || state.reloadRequired) setNotice('live-error', e.message);
  } finally {
    password = '';
    if (attempt) {
      pendingLiveStart = null;
      $('live-password').disabled = Boolean(state.reloadRequired || state.cancelingStartup);
      setBusy();
      await updateState();
    }
  }
}
async function cancelLiveStartup() {
  const attempt = pendingLiveStart;
  if (!attempt || state.workspace !== attempt.workspace || !state.starting || state.stopping ||
      state.cancelingStartup || state.reloadRequired === 'SESSION_EXPIRED') return;
  state.cancelingStartup = attempt.cancelRequested = true;
  renderControls();
  try {
    const data = await api('stop', { workspace: attempt.workspace });
    runEpoch++;
    state.stateRevision = '';
    applyRunState(data, attempt.workspace);
    $('live-dialog').close();
    notify('启动已停止。已发送的交易不会被撤销。');
  } catch (e) {
    attempt.cancelRequested = false;
    setNotice('live-error', e.message);
  } finally {
    state.cancelingStartup = false;
    if ($('live-dialog').open && !state.busy && !state.reloadRequired) {
      $('live-password').disabled = false;
    }
    renderControls();
    renderProjects();
    renderDiscover();
    await updateState();
  }
}

window.addEventListener('hashchange', switchView);
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => {
  if (!state.busy) $(el.dataset.close).close();
}));
for (const id of ['project-dialog', 'snipe-add-dialog', 'project-remove-dialog', 'live-dialog', 'wallet-import-dialog', 'wallet-remove-dialog']) {
  $(id).addEventListener('cancel', e => { if (state.busy) e.preventDefault(); });
}
$('project-remove-dialog').addEventListener('close', () => { state.pendingProjectRemove = null; });
$('project-dialog').addEventListener('close', () => {
  clearTimeout(previewTimer);
  clearInterval(mintBalanceTimer);
  previewSequence++;
  state.preview = null;
  mintBalanceRead = emptyMintBalanceRead();
  mintBatchesAuto = false;
});
$('wallet-import-dialog').addEventListener('close', clearImportSecrets);
$('wallet-remove-dialog').addEventListener('close', () => { state.pendingWalletRemove = null; $('wallet-remove-password').value = ''; });
$('live-dialog').addEventListener('close', () => {
  state.liveReview = null;
  $('live-password').value = '';
});
window.addEventListener('pagehide', () => {
  clearImportSecrets();
  $('wallet-remove-password').value = $('live-password').value = '';
  $('wallet-local-unlock-password').value = '';
});
for (const [workspace, buttonIds] of Object.entries({ mint: ['refresh', 'start-live', 'stop'], snipe: ['snipe-refresh', 'start-snipe', 'stop-snipe'] })) {
  const [refreshId, startId, stopId] = buttonIds;
  $(refreshId).addEventListener('click', () => refresh({ workspace }));
  $(startId).addEventListener('click', () => reviewLive(workspace));
  $(stopId).addEventListener('click', () => stopWorkspace(workspace));
}
async function stopWorkspace(workspace) {
  if (state.busy || state.stopping || state.cancelingStartup || state.reloadRequired === 'SESSION_EXPIRED') return;
  setBusy('stop');
  try {
    const d = await api('stop', { workspace });
    runEpoch++;
    state.stateRevision = '';
    applyRunState(d, workspace);
    notify('监控已停止。已发送的交易不会被撤销。');
  } catch (e) { notify(e.message, true); }
  finally { setBusy(); await updateState(); }
}
$('add-project').addEventListener('click', () => openProject(-1));
$('add-snipe').addEventListener('click', () => openSnipe());
$('snipe-add-form').addEventListener('submit', submitSnipe);
$('project-url').addEventListener('input', scheduleMintPreview);
$('project-preview-button').addEventListener('click', () => fetchMintPreview({ force: true }));
$('project-batches').addEventListener('input', () => {
  mintBatchesAuto = false;
  updateMintFields();
});
$('project-claim').addEventListener('input', updateMintFields);
$('project-wallet-choices').addEventListener('input', () => {
  mintWalletAuto = false;
  updateMintFields();
});
$('project-wallet-sufficient').addEventListener('click', () => {
  mintWalletAuto = true;
  updateMintFields();
});
$('project-wallet-refresh').addEventListener('click', loadMintWalletBalances);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('project-dialog').open && !mintBalanceFresh(mintDialogTarget())) {
    void loadMintWalletBalances();
  }
});
$('project-form').addEventListener('submit', submitProject);
$('delete-project').addEventListener('click', () => openProjectRemoval(state.editing));
$('project-remove-form').addEventListener('submit', removeProject);
$('live-password').addEventListener('input', updateLiveSubmit);
$('copy-snipe-report').addEventListener('click', async () => {
  if (!state.snipeReport) return;
  try { await navigator.clipboard.writeText(state.snipeReport); notify('已复制项目目录下的测速文件路径。'); }
  catch { notify('复制失败，请手动复制文件路径。', true); }
});
$('live-password').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    $('live-submit').focus();
  }
});
$('live-form').addEventListener('submit', startLive);
$('live-cancel-startup').addEventListener('click', cancelLiveStartup);
$('reload-local-ui').addEventListener('click', () => location.reload());
$('log-filter').addEventListener('change', renderLogs);
$('snipe-log-filter').addEventListener('change', renderLogs);
$('import-wallet').addEventListener('click', openWalletImport);
$('wallet-forget-local-unlock').addEventListener('click', forgetLocalWalletUnlock);
$('wallet-remember-local-unlock').addEventListener('click', openLocalWalletUnlock);
$('wallet-local-unlock-form').addEventListener('submit', rememberLocalWalletUnlock);
$('wallet-local-unlock-dialog').addEventListener('close', () => { $('wallet-local-unlock-password').value = ''; });
$('wallet-keys-visibility').addEventListener('click', () => maskPrivateKeys(!$('wallet-private-keys').classList.contains('secret-mask')));
$('wallet-import-form').addEventListener('submit', importWallets);
$('wallet-remove-form').addEventListener('submit', removeWallet);
async function saveParameters(event, workspace) {
  event.preventDefault();
  if (!state.config || frozen()) return;
  const config = configCopy();
  try {
    const params = readParameters(event.currentTarget, workspace === 'snipe' ? defaults.snipe : defaults.outer);
    if (workspace === 'snipe') config.snipe = params;
    else Object.assign(config, params);
    setBusy('config');
    await saveConfig(config);
    notify(workspace === 'snipe' ? '狙击参数已保存。' : '预算与 Gas 已保存。');
  } catch (e) { notify(e.message, true); }
  finally { setBusy(); }
}
$('settings-form').addEventListener('submit', event => saveParameters(event, 'general'));
$('snipe-form').addEventListener('submit', event => saveParameters(event, 'snipe'));
$('snipe-form').elements.requirePreopen.addEventListener('change', syncSnipeOpeningPolicy);
$('snipe-form').elements.repeatAttempts.addEventListener('input', syncSnipeOpeningPolicy);
$('snipe-form').addEventListener('reset', () => queueMicrotask(() => {
  if (state.config) renderConfigForms();
}));
$('snipe-form').addEventListener('invalid', event => {
  const section = event.target.closest('details');
  if (section) section.open = true;
}, true);
document.addEventListener('visibilitychange', resumeCatalogAuto);
document.addEventListener('visibilitychange', resumeRpcStatus);
document.addEventListener('visibilitychange', () => {
  resumeSnipeProgress();
  if (document.visibilityState === 'visible') {
    drainMetadata();
    void updateState();
  } else scheduleStatePoll();
});
$('catalog-more').addEventListener('click', () => loadCatalog({ more: true }));
function syncCatalogSearch(event) {
  const input = $('catalog-search');
  $('catalog-clear').hidden = !input.value;
  if (event?.isComposing) return;
  const query = catalogQuery(input.value).slice(0, 100);
  if (query === catalog.query) return;
  catalog.query = query;
  clearTimeout(catalogSearchTimer);
  renderDiscover();
  if (validAddress(catalog.query)) {
    const exact = catalog.query;
    catalogSearchTimer = setTimeout(() => { if (catalog.query === exact) void resolveCatalogAddress(exact); }, 220);
  }
}
$('catalog-search').addEventListener('input', syncCatalogSearch);
$('catalog-search').addEventListener('compositionend', syncCatalogSearch);
$('catalog-clear').addEventListener('click', () => {
  $('catalog-search').value = '';
  syncCatalogSearch();
  $('catalog-search').focus();
});
syncCatalogSearch();
$('catalog-sort').addEventListener('change', event => {
  catalog.sort = event.target.value;
  renderDiscover();
});
$('catalog-filters').addEventListener('click', event => {
  const choice = event.target.closest('button[data-catalog-filter]');
  if (!choice) return;
  catalog.filter = choice.dataset.catalogFilter;
  for (const option of $('catalog-filters').children) {
    option.setAttribute('aria-pressed', String(option === choice));
  }
  renderDiscover();
});

async function boot() {
  switchView();
  renderControls();
  try {
    const data = await api('bootstrap');
    state.config = normalizeConfig(data.config);
    state.source = data.source;
    state.session = data.sessionToken;
    syncNotificationStream();
    state.configRevision = data.configRevision ?? '';
    state.allowLive = Boolean(data.allowLive);
    state.walletVaultExists = Boolean(data.walletVaultExists) || Boolean(data.walletVault?.length);
    state.walletLocalUnlockSupported = data.walletLocalUnlockSupported === true;
    state.walletLocalUnlock = data.walletLocalUnlock === true;
    setWallets(data.walletVault);
    renderConfigForms();
    renderControls();
    renderProjects();
    if (location.hash === '#discover') resumeCatalogAuto();
    resumeRpcStatus();
    await updateState();
    if (currentView === 'snipe') resumeSnipeProgress();
    else if (currentView !== 'discover') void refresh({ silent: true, workspace: 'mint' });
    queueMetadata(targetsOf('all'));
  } catch (e) {
    setConnection(false, '未连接');
    setNotice('fatal', e.message);
  }
}
bindDesktopNotifications();
boot();
