import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { formatEther, ZeroAddress } from 'ethers';
import { CHAIN_ID, address, checkBudget, int, mintWalletsFor, parseMintLink, readJson, snipeOpeningDefaults, snipeTargetUrl, snipeTargetUrls, validateConfig } from './config.mjs';
import { inspectMint, inspectParticipant } from './corla.mjs';
import { discoverProjects } from './events.mjs';
import { makeExecutor } from './execution.mjs';
import { actionId, makeMonitor, shortError } from './monitor.mjs';
import { createWalletVault } from './wallet-vault.mjs';
import { createLocalWalletUnlock } from './local-wallet-unlock.mjs';
import { makeFastSnipe, prepareSnipe, snipeWsUrl } from './snipe.mjs';
import { SNIPE_RACE_WINDOW_MS } from './snipe-race.mjs';
import { MAX_SNIPE_ATTEMPTS, MAX_PREOPEN_MINTS } from './snipe-limits.mjs';
import { createSnipeReceiptObserver, createSnipeRunRecorder, findLatestSnipeReport } from './snipe-run-recorder.mjs';
import { readCatalogQuoteMetadata, readDashboardParticipants, readDashboardProjects, readDashboardWalletBalances } from './dashboard-chain.mjs';
import { createProjectMetadata } from './project-metadata.mjs';
import { findCatalogAddress, readCatalogPage } from './catalog.mjs';
import { readCatalogFundingTimes } from './catalog-funding.mjs';
import { createRpcPool } from './rpc-pool.mjs';
import { LOW_LATENCY_RPC_TIMEOUT_MS, rpcPoolPlan } from './rpc-config.mjs';
import { syncParentDirectory } from './local-files.mjs';
import { requireRuntime } from './runtime.mjs';
import { createNotificationFeed } from './notification-feed.mjs';
import { createNotificationStream } from './notification-stream.mjs';
import { prepareQuoteAllowances } from './quote-allowances.mjs';
import { createFlapQuoteCatalog } from './quote-catalog.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateKeys = ['rpcUrl', 'rpcBackupUrls', 'walletFile', 'journalPath'];
const rpcLabels = { dashboard: '工作区与代币看板', metadata: '代币元数据', mint: 'Mint 与领币', watch: '开盘监控 · HTTP', snipe: '狙击买入' };
const snipeTiming = { retryWindowMs: SNIPE_RACE_WINDOW_MS, rpcTimeoutMs: LOW_LATENCY_RPC_TIMEOUT_MS, maxAttempts: MAX_SNIPE_ATTEMPTS,
  maxPreopenMints: MAX_PREOPEN_MINTS };
const MAX_FUNDING_REQUEST = 18;
const MAX_FUNDING_QUEUE = 54;
const FUNDING_JOB_SIZE = 12;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_STATE_PROJECTS = 64;
const publicKeys = new Set(['pollMs', 'targets', 'watchWallets', 'maxGasPriceGwei', 'gasLimitCap', 'maxTotalBnb', 'snipe', 'snipeTargets']);
const projectKeys = new Set(['url', 'mintBatches', 'maxMintPriceBnb', 'autoClaim', 'mintWallets',
  'quoteToken', 'quoteDecimals', 'maxMintPriceQuote']);
const snipeTargetKeys = new Set(['url', 'quoteToken', 'quoteDecimals', 'amountQuote', 'minLiquidityQuote']);
const strategyKeys = new Set(['amountBnb', 'walletCount', 'minLiquidityBnb', 'slippageBps',
  'maxBuyTaxBps', 'maxSellTaxBps', 'maxPriceImpactBps', 'windowBlocks', 'deadlineSeconds', 'scanMs', 'repeatAttempts',
  'maxOpeningPremiumBps', 'requirePreopen', 'broadcastConcurrency']);
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/themes.css': ['themes.css', 'text/css; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/mint-wallet-selection.js': ['mint-wallet-selection.js', 'text/javascript; charset=utf-8'],
};
const postRoutes = new Set(['/api/status', '/api/discover', '/api/config', '/api/start', '/api/stop', '/api/local/lifecycle',
  '/api/wallets/import', '/api/wallets/remove', '/api/wallets/remember-local-unlock', '/api/wallets/forget-local-unlock',
  '/api/project/preview', '/api/project/participants', '/api/project/metadata',
  '/api/project/wallet-balances',
  '/api/catalog', '/api/catalog/status', '/api/catalog/resolve', '/api/catalog/funding-times', '/api/catalog/quote-assets', '/api/notifications/stream']);
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://flap.mypinata.cloud; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
};

function toJson(value) {
  return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
}
function json(res, status, value) {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(toJson(value));
}
class HttpError extends Error {
  constructor(status, message, publicCode) { super(message); this.status = status; this.publicCode = publicCode; }
}
async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, '仅接受 JSON 请求');
  }
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) throw new HttpError(413, '请求体太大');
  const chunks = [];
  let bytes = 0;
  // An early exit must not destroy the socket before we send the 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new HttpError(413, '请求体太大');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new HttpError(400, 'JSON 请求格式错误');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须为对象');
  return body;
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, label + ' 必须为对象');
  return value;
}
function visibleConfig(input) {
  const pick = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key))) : undefined;
  const cfg = pick(input, publicKeys);
  if (Array.isArray(cfg.targets)) cfg.targets = cfg.targets.map(target => pick(target, projectKeys) ?? {});
  cfg.snipeTargets = snipeTargetUrls(input);
  if (Array.isArray(cfg.snipeTargets)) cfg.snipeTargets = cfg.snipeTargets.map(row => typeof row === 'string' ? row : pick(row, snipeTargetKeys) ?? {});
  if (cfg.snipe !== undefined) {
    cfg.snipe = pick(cfg.snipe, strategyKeys);
    if (cfg.snipe) Object.assign(cfg.snipe, snipeOpeningDefaults(cfg.snipe));
  }
  return cfg;
}
function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}
const fundingKey = ({ mint, token }) => mint.toLowerCase() + '/' + token.toLowerCase();
function savedProjectKeys(input) {
  const urls = [
    ...(Array.isArray(input.targets) ? input.targets.map(row => row?.url) : []),
    ...[].concat(snipeTargetUrls(input) ?? []).map(snipeTargetUrl),
  ];
  return new Set(urls.flatMap(url => {
    try { return [fundingKey(parseMintLink(url))]; } catch { return []; }
  }));
}
function safeToken(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

/**
 * Local operator console, bound to loopback. Wallet secrets are accepted only on
 * authenticated same-origin vault/unlock requests; never logged or returned.
 * The production entry point offers live only; allowSimulation is a test option.
 */
export async function createUiServer({
  rootDir = defaultRoot, port = 0, host = '127.0.0.1', allowLive = true, allowSimulation = false, services = {},
  onLifecycle,
} = {}) {
  if (host !== '127.0.0.1') throw new Error('UI 只能绑定 IPv4 本机回环地址 127.0.0.1');
  const root = resolve(rootDir);
  const localFile = join(root, 'config.local.json');
  const example = object(await readJson(join(root, 'config.example.json')), '示例配置');
  let source = 'local';
  let diskConfig;
  try { diskConfig = object(await readJson(localFile), '本地配置'); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('无法读取 config.local.json，请检查文件是否为有效 JSON');
    // Example projects stay useful for chain lookups, but ship with all writes off.
    diskConfig = allowLive ? { ...example, snipeTargets: [], targets: example.targets.map(target => ({
      ...target, mintBatches: 0, autoClaim: false, buyOnLaunch: false,
    })) } : example;
    source = 'example';
  }
  const pinned = Object.fromEntries(privateKeys.flatMap(key =>
    diskConfig[key] === undefined ? [] : [[key, diskConfig[key]]]));
  const svc = { createRpcPool, inspectMint, inspectParticipant, discoverProjects, createWalletVault, createLocalWalletUnlock, makeExecutor,
    makeMonitor, makeFastSnipe, prepareSnipe, readDashboardProjects, readDashboardParticipants, readDashboardWalletBalances,
    createProjectMetadata, readCatalogPage, findCatalogAddress, readCatalogFundingTimes, readCatalogQuoteMetadata, createNotificationFeed,
    prepareQuoteAllowances, createFlapQuoteCatalog, ...services };
  const vault = await svc.createWalletVault(join(root, 'state', 'wallet-vault.json'));
  const localUnlock = svc.createLocalWalletUnlock(join(root, 'state', 'wallet-unlock.dpapi'));
  const metadata = svc.createProjectMetadata();
  const readFlapQuoteCatalog = svc.createFlapQuoteCatalog();
  const sessionToken = randomBytes(32).toString('hex');
  const stateEpoch = randomBytes(8).toString('hex');
  let configRevision = randomBytes(16).toString('hex');
  let stateSequence = 0;
  let logSequence = 0;
  let savedKeys = savedProjectKeys(diskConfig);
  let origin;
  let run = null;
  let closing = false;
  let closeTask;
  let serviceAction = null;
  const serviceControls = typeof onLifecycle === 'function';
  let saving = false;
  let walletWriting = false;
  let reading = false;
  let lastError;
  let lastErrorWorkspace;
  let lastSnipeReport = await findLatestSnipeReport(root).catch(() => null);
  const logs = [];
  const projects = new Map();
  let dashboardReady;
  let dashboard;
  let metadataReady;
  let metadataRpc;
  const rpcPools = new Map();
  const summaryJobs = new Map();
  const previewJobs = new Map();
  const catalogPages = new Map();
  const catalogJobs = new Map();
  const catalogStatusCache = new Map();
  const catalogQuoteCache = new Map();
  const catalogQuoteJobs = new Map();
  let catalogQuoteBatches = 0;
  const catalogAddresses = new Map();
  const catalogLookups = new Map();
  const catalogFundingSnapshots = new Map();
  const catalogFundingCache = new Map();
  const catalogFundingQueue = new Map();
  const catalogFundingAbort = new AbortController();
  let catalogFundingWork;
  const participantJobs = new Map();
  const participantCache = new Map();
  const walletBalanceJobs = new Map();
  const walletBalanceCache = new Map();
  let metadataBatches = 0;
  const notificationStream = createNotificationStream({ openFeed: async signal => {
    const plan = rpcPoolPlan(checked(undefined, 'mint'), 'notifications');
    // Deliberately do not warm or share this pool with Mint, WSS/HTTP launch
    // watch, trade execution, or the catalog. Destroy it when opt-in ends.
    const provider = svc.makeProvider ? svc.makeProvider(plan.urls[0], plan) : svc.createRpcPool(plan.urls, plan);
    let closed = false;
    const destroy = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', destroy);
      provider.destroy?.();
    };
    signal.addEventListener('abort', destroy, { once: true });
    try {
      signal.throwIfAborted();
      if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error('通知 RPC 不是 BSC 主网 (56)');
      signal.throwIfAborted();
      return { poll: svc.createNotificationFeed({ provider }), close: destroy };
    } catch (error) {
      destroy();
      throw error;
    }
  } });

  const stateRevision = () => stateEpoch + ':' + stateSequence;
  const logCursor = () => stateEpoch + ':' + logSequence;
  const stateChanged = () => { stateSequence++; };
  const pendingState = () => typeof run?.pendingHealth === 'function' ? { snipePending: run.pendingHealth() } : {};
  function state(afterLog) {
    const tail = typeof afterLog === 'string' && afterLog.startsWith(stateEpoch + ':') ? afterLog.slice(stateEpoch.length + 1) : '';
    const after = /^\d{1,16}$/.test(tail) ? Number(tail) : NaN;
    const floor = logSequence - logs.length;
    const delta = Number.isSafeInteger(after) && after >= floor && after <= logSequence;
    return { stateRevision: stateRevision(), configRevision, running: Boolean(run), mode: run?.mode ?? 'idle',
      workspace: run?.workspace ?? null, stopping: Boolean(run?.controller.signal.aborted),
      starting: Boolean(run && !run.ready && !run.controller.signal.aborted), logCursor: logCursor(),
      logs: delta ? logs.slice(after - floor) : logs, ...(delta ? { logsDelta: true } : {}),
      projects: [...projects.values()], lastError, lastErrorWorkspace, snipeReport: lastSnipeReport, ...pendingState() };
  }
  function log(event, fields = {}) {
    const row = { time: new Date().toISOString(), event, ...fields };
    logs.push(row);
    logSequence++;
    if (logs.length > 150) logs.splice(0, logs.length - 150);
    if (event === 'project' && row.mint) remember(projects, row.mint.toLowerCase(), row, MAX_STATE_PROJECTS);
    if (['rpc_error', 'project_error', 'watch_error'].includes(event)) {
      lastError = row.error;
      lastErrorWorkspace = row.workspace;
    }
    stateChanged();
  }
  function requireCurrentConfig(revision) {
    if (revision !== configRevision) {
      throw new HttpError(409, '配置已变更，请刷新并重新核对后再操作。', 'CONFIG_STALE');
    }
  }
  function rememberProjectSnapshot(row, revision) {
    if (run || configRevision !== revision || row.error || !savedKeys.has(fundingKey(row))) return;
    const key = row.mint.toLowerCase();
    const previous = projects.get(key);
    if (!Number.isSafeInteger(row.block) || (previous && Number(previous.block || 0) >= row.block)) return;
    remember(projects, key, row, MAX_STATE_PROJECTS);
    stateChanged();
  }
  function checked(input, workspace = 'all') {
    const editable = object(input ?? visibleConfig(diskConfig), '配置');
    if (privateKeys.some(key => Object.hasOwn(editable, key))) throw new HttpError(400, '网页不可修改 RPC 或本地文件路径');
    return validateConfig({ ...editable, ...pinned }, root, { allowEmptyTargets: true, workspace });
  }
  function getRpcPool(cfg, role, plan = rpcPoolPlan(cfg, role)) {
    if (!rpcPools.has(role)) rpcPools.set(role, svc.createRpcPool(plan.urls, plan));
    return rpcPools.get(role);
  }
  async function readyProvider(cfg, role = 'mint') {
    const plan = rpcPoolPlan(cfg, role);
    const provider = svc.makeProvider ? svc.makeProvider(plan.urls[0], plan) : getRpcPool(cfg, role, plan);
    try {
      if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error('RPC 不是 BSC 主网 (chain ID 56)');
      return provider;
    } catch (e) { releaseProvider(provider); throw e; }
  }
  function releaseProvider(provider) {
    // The default pools keep recovery probes and latency history across jobs.
    if (svc.makeProvider) provider?.destroy?.();
  }
  function rpcStatus() {
    const cfg = checked(undefined, 'mint');
    return { pools: Object.entries(rpcLabels).map(([id, label]) => {
      try {
        const info = svc.makeProvider ? (id === 'dashboard' ? dashboard : id === 'metadata' ? metadataRpc : null)?.rpcStatus?.()
          : getRpcPool(cfg, id).rpcStatus();
        return { id, label, preferred: null, active: null, endpoints: [], ...info };
      } catch {
        // Never return configuration URLs, exception payloads or credentials.
        return { id, label, preferred: null, active: null, endpoints: [], unavailable: true };
      }
    }) };
  }
  function dashboardProvider(cfg) {
    // One warm, independent provider for UI queries; never used to sign or
    // shared with the sniper's watcher or executor.
    if (!dashboardReady) {
      dashboardReady = readyProvider(cfg, 'dashboard')
        .then(provider => (dashboard = provider))
        .catch(error => { dashboardReady = null; throw error; });
    }
    return dashboardReady;
  }
  function metadataProvider(cfg) {
    // Keep catalog and IPFS work separate from both project refresh and sniping.
    if (!metadataReady) {
      metadataReady = readyProvider(cfg, 'metadata')
        .then(provider => (metadataRpc = provider))
        .catch(error => { metadataReady = null; throw error; });
    }
    return metadataReady;
  }
  async function summaryStatus(cfg, { remember = true } = {}) {
    if (!cfg.targets.length) return [];
    const revision = configRevision;
    const key = (remember ? revision : 'read-only') + ':' + cfg.workspace + ':' + cfg.targets.map(fundingKey).join(',');
    const existing = summaryJobs.get(key);
    if (existing) return existing;
    if (summaryJobs.size >= 4) throw new HttpError(409, '项目刷新请求过多，请稍后再试');
    const work = (async () => {
      const provider = await dashboardProvider(cfg);
      const read = await svc.readDashboardProjects(provider, cfg.targets, 'latest');
      const rows = cfg.targets.map(target => {
        const chain = read.get(target.mint.toLowerCase()) ?? { error: '未读到项目合约状态' };
        const block = chain.blockNumber;
        const row = { ...chain, block, mint: target.mint, token: target.token, deployedToken: chain.token };
        return row;
      });
      const enriched = remember ? await catalogQuotes(cfg, rows) : rows;
      if (remember) for (const row of enriched) rememberProjectSnapshot(row, revision);
      return enriched;
    })();
    summaryJobs.set(key, work);
    try { return await work; } finally { summaryJobs.delete(key); }
  }
  async function catalogPage({ cursor, limit: requestedLimit, refresh }) {
    if (cursor != null && (typeof cursor !== 'string' || cursor.length > 64)) throw new HttpError(400, '目录游标无效');
    const limit = int(requestedLimit ?? 18, '每页项目数', 1, 32);
    const key = (cursor ?? '') + ':' + limit;
    const cached = catalogPages.get(key);
    const age = cached ? Date.now() - cached.time : Infinity;
    const ttl = cursor ? 45000 : 12000;
    if (cached && age < (refresh === true ? 1000 : ttl)) return cached.page;
    const existing = catalogJobs.get(key);
    if (existing) return existing;
    if (catalogJobs.size >= 4) throw new HttpError(409, '目录正在加载，请稍后再试');
    const work = (async () => {
      const provider = await dashboardProvider(checked(undefined, 'mint'));
      const page = await svc.readCatalogPage(provider, { cursor: cursor ?? undefined, limit });
      for (const row of page.projects) {
        cacheCatalogAddress(row.token.toLowerCase(), row);
        cacheCatalogAddress(row.mint.toLowerCase(), row);
      }
      if (catalogPages.size >= 32) catalogPages.delete(catalogPages.keys().next().value);
      catalogPages.set(key, { time: Date.now(), page });
      return page;
    })();
    catalogJobs.set(key, work);
    try { return await work; } finally { catalogJobs.delete(key); }
  }
  function cacheCatalogAddress(key, project) {
    remember(catalogAddresses, key, { project, time: Date.now() }, 2048);
    return project;
  }
  async function resolveCatalogAddress(input) {
    const resolved = address(input, '代币或 Mint 合约');
    const key = resolved.toLowerCase();
    const cached = catalogAddresses.get(key);
    if (cached && Date.now() - cached.time < (cached.project ? 120000 : 12000)) return cached.project;
    const existing = catalogLookups.get(key);
    if (existing) return existing;
    if (catalogLookups.size >= 2) throw new HttpError(409, '合约地址正在查询，请稍后再试');
    const work = (async () => {
      const provider = await dashboardProvider(checked(undefined, 'mint'));
      return cacheCatalogAddress(key, await svc.findCatalogAddress(provider, resolved));
    })();
    catalogLookups.set(key, work);
    try { return await work; } finally { catalogLookups.delete(key); }
  }
  async function catalogQuotes(cfg, rows) {
    const byBlock = new Map();
    const work = new Set();
    const included = new Set();
    const clock = performance.now();
    for (const row of rows) {
      if (row.error || !row.quoteToken || row.quoteToken === ZeroAddress || !Number.isSafeInteger(row.block) || row.block < 1) continue;
      const token = row.quoteToken.toLowerCase();
      if (included.has(token)) continue;
      included.add(token);
      if ((catalogQuoteCache.get(token)?.until ?? 0) > clock) continue;
      const existing = catalogQuoteJobs.get(token);
      if (existing) work.add(existing);
      else {
        if (!byBlock.has(row.block)) byBlock.set(row.block, []);
        byBlock.get(row.block).push(token);
      }
    }
    for (const [block, tokens] of byBlock) {
      if (catalogQuoteBatches >= 2) break;
      catalogQuoteBatches++;
      const job = (async () => {
        try {
          const provider = await dashboardProvider(cfg);
          const result = await svc.readCatalogQuoteMetadata(provider, tokens, block);
          for (const token of tokens) {
            const { quoteDecimals = null, quoteSymbol = null } = result.get(token) ?? {};
            remember(catalogQuoteCache, token, { quoteDecimals, quoteSymbol, until: performance.now() +
              (quoteDecimals !== null && quoteSymbol !== null ? 600_000 : 30_000) }, 512);
          }
        } catch {
          for (const token of tokens) {
            const previous = catalogQuoteCache.get(token);
            remember(catalogQuoteCache, token, { quoteDecimals: previous?.quoteDecimals ?? null,
              quoteSymbol: previous?.quoteSymbol ?? null, until: performance.now() + 30_000 }, 512);
          }
        } finally {
          catalogQuoteBatches--;
          for (const token of tokens) catalogQuoteJobs.delete(token);
        }
      })();
      for (const token of tokens) catalogQuoteJobs.set(token, job);
      work.add(job);
    }
    if (work.size) {
      // Give the normal one-call enrichment a chance, but a slow quote token
      // must not hold the rest of the catalog hostage. Its result is cached
      // for the next read even if the metadata deadline wins this response.
      let timer;
      try { await Promise.race([Promise.all(work), new Promise(done => { timer = setTimeout(done, 1000); })]); }
      finally { clearTimeout(timer); }
    }
    return rows.map(row => {
      if (row.error || !row.quoteToken) return row;
      if (row.quoteToken === ZeroAddress) return { ...row, nativeQuote: true, quoteSymbol: 'BNB', quoteDecimals: 18 };
      const meta = catalogQuoteCache.get(row.quoteToken.toLowerCase());
      return { ...row, nativeQuote: false, quoteSymbol: meta?.quoteSymbol ?? null, quoteDecimals: row.quoteDecimals ?? meta?.quoteDecimals ?? null };
    });
  }
  async function catalogStatus(urls) {
    if (!Array.isArray(urls) || urls.length > 32) throw new HttpError(400, '看板状态每批最多 32 个项目');
    const byMint = new Map();
    for (const url of urls) {
      const target = parseMintLink(url);
      const previous = byMint.get(target.mint);
      if (previous && previous.token !== target.token) throw new HttpError(400, '同一 Mint 对应了不同的代币地址');
      byMint.set(target.mint, target);
    }
    const targets = [...byMint.values()];
    if (!targets.length) return [];
    const key = targets.map(t => t.mint + '/' + t.token).join(',');
    const cached = catalogStatusCache.get(key);
    // Coalesce auto-refreshes from multiple tabs, without stalling the next
    // foreground refresh (normally ~3 seconds apart).
    if (cached && performance.now() - cached.at < 650) return cached.rows;
    // Browsing the catalog must never add projects to the active workspaces or
    // fill /api/state with dozens of untracked cards.
    const cfg = { ...checked(undefined, 'mint'), workspace: 'catalog', targets };
    const rows = await summaryStatus(cfg, { remember: false });
    for (const row of rows) {
      if (row.error || !Number.isSafeInteger(row.block) || row.block < 1) continue;
      const id = fundingKey(row);
      const previous = catalogFundingSnapshots.get(id);
      if (!previous || row.block >= previous.block) remember(catalogFundingSnapshots, id, row, 1024);
    }
    const enriched = await catalogQuotes(cfg, rows);
    remember(catalogStatusCache, key, { at: performance.now(), rows: enriched }, 48);
    return enriched;
  }
  function currentFundingRecord(id) {
    const snapshot = catalogFundingSnapshots.get(id);
    if (!snapshot) return null;
    const project = catalogAddresses.get(snapshot.mint.toLowerCase())?.project ??
      catalogAddresses.get(snapshot.token.toLowerCase())?.project;
    if (!project || fundingKey(project) !== id || !Number.isSafeInteger(project.createdAt) || project.createdAt < 1 ||
        !Number.isSafeInteger(project.fundingDeadline) || project.fundingDeadline < project.createdAt) return null;
    // Only authenticated on-chain snapshots, never browser-supplied counts.
    if (typeof project.totalLots !== 'bigint' || project.totalLots <= 0n || snapshot.totalLots !== project.totalLots ||
        (snapshot.launched !== true && snapshot.mintedLots !== project.totalLots)) return null;
    return { project, snapshot };
  }
  function pumpFundingHistory() {
    if (closing || catalogFundingWork || !catalogFundingQueue.size) return;
    const batch = [];
    for (const [id] of catalogFundingQueue) {
      const entry = currentFundingRecord(id);
      if (entry) batch.push([id, entry]);
      else catalogFundingQueue.delete(id);
      if (batch.length === FUNDING_JOB_SIZE) break;
    }
    if (!batch.length) return;
    catalogFundingWork = (async () => {
      let provider;
      const entries = new Map(batch);
      const found = new Set();
      const publish = match => {
        const id = fundingKey(match);
        const entry = entries.get(id);
        if (!entry || found.has(id) || catalogFundingAbort.signal.aborted) return;
        const { project, snapshot } = entry;
        if (!Number.isSafeInteger(match.filledAt) || match.filledAt < project.createdAt ||
            match.filledAt > project.fundingDeadline || !Number.isSafeInteger(match.blockNumber) ||
            match.blockNumber < 1 || match.blockNumber > snapshot.block || !/^0x[\da-f]{64}$/i.test(match.blockHash)) return;
        remember(catalogFundingCache, id, { createdAt: project.createdAt, totalLots: project.totalLots, value: {
          mint: project.mint, token: project.token, filledAt: match.filledAt,
          blockNumber: match.blockNumber, blockHash: match.blockHash,
        } }, 1024);
        found.add(id);
      };
      try {
        const cfg = checked(undefined, 'mint');
        provider = await readyProvider(cfg, 'catalogHistory');
        const blockProvider = await dashboardProvider(cfg).catch(() => provider);
        const matches = await svc.readCatalogFundingTimes(provider, batch.map(([, entry]) => entry),
          { blockProvider, signal: catalogFundingAbort.signal, onResult: publish });
        for (const match of matches) publish(match);
      } catch { /* Read-only history is optional; never fail the live board. */ }
      finally { releaseProvider(provider); }
      for (const [id, { project }] of batch) {
        if (!found.has(id) && !catalogFundingAbort.signal.aborted) {
          const failures = Math.min((catalogFundingCache.get(id)?.failures ?? 0) + 1, 5);
          remember(catalogFundingCache, id, { createdAt: project.createdAt, totalLots: project.totalLots,
            failures, retryAt: Date.now() + Math.min(120_000, 8000 * 2 ** (failures - 1)) }, 1024);
        }
        catalogFundingQueue.delete(id);
      }
    })().finally(() => {
      catalogFundingWork = null;
      pumpFundingHistory();
    });
  }
  function catalogFundingTimes(urls) {
    if (!Array.isArray(urls) || urls.length > MAX_FUNDING_REQUEST) {
      throw new HttpError(400, '每批最多查询 ' + MAX_FUNDING_REQUEST + ' 个筹资用时');
    }
    // Validate the whole request before queuing any work.
    const ids = new Set(urls.map(url => fundingKey(parseMintLink(url))));
    const matches = [];
    let retry = Infinity;
    const now = Date.now();
    for (const id of ids) {
      const record = currentFundingRecord(id);
      if (!record) continue;
      const cached = catalogFundingCache.get(id);
      if (cached?.createdAt === record.project.createdAt && cached.totalLots === record.project.totalLots) {
        if (cached.value) { matches.push(cached.value); continue; }
        if (cached.retryAt > now) { retry = Math.min(retry, cached.retryAt - now); continue; }
      }
      if (!closing && !catalogFundingQueue.has(id) && catalogFundingQueue.size < MAX_FUNDING_QUEUE) {
        catalogFundingQueue.set(id, true);
      }
      retry = Math.min(retry, 3000);
    }
    pumpFundingHistory();
    return { projects: matches, ...(Number.isFinite(retry) ? { retryAfterMs: Math.max(1000, retry) } : {}) };
  }
  async function participants(url) {
    const target = parseMintLink(url);
    const cfg = checked(undefined, 'mint');
    const wallets = allowSimulation ? cfg.watchWallets : await publicWallets();
    if (!wallets.length) return { participants: [], block: null };
    const key = target.mint.toLowerCase() + '/' + target.token.toLowerCase() + ':' + wallets.map(w => w.address).join(',');
    const cached = participantCache.get(key);
    if (cached && Date.now() - cached.time < 4000) return cached.result;
    const existing = participantJobs.get(key);
    if (existing) return existing;
    if (participantJobs.size >= 4) throw new HttpError(409, '钱包份额查询过多，请稍后再试');
    const work = (async () => {
      const provider = await dashboardProvider(cfg);
      const block = await provider.getBlockNumber();
      const rows = await svc.readDashboardParticipants(provider, target, wallets.map(w => w.address), block);
      const result = { participants: rows, block };
      if (participantCache.size >= 48) participantCache.delete(participantCache.keys().next().value);
      participantCache.set(key, { time: Date.now(), result });
      return result;
    })();
    participantJobs.set(key, work);
    try { return await work; } finally { participantJobs.delete(key); }
  }
  async function walletBalances(body) {
    if (Object.keys(body).some(key => key !== 'url')) throw new HttpError(400, '钱包余额查询仅接受可选的 Corla 链接');
    const target = body.url === undefined ? null : parseMintLink(body.url);
    if (walletWriting || closing) throw new HttpError(409, '钱包列表正在更新，请稍后重试');
    // Always get the wallet set from the public vault metadata. Never accept
    // arbitrary caller-supplied addresses or use the unlocked/live wallet set.
    const wallets = (await publicWallets()).map(w => w.address);
    if (!wallets.length) return { wallets: [], block: null };
    if (wallets.length > 32) throw new HttpError(400, '钱包余额查询最多支持 32 个钱包');
    const key = (target ? fundingKey(target) : '-') + ':' + wallets.map(wallet => wallet.toLowerCase()).join(',');
    const existing = walletBalanceJobs.get(key);
    if (existing) return existing;
    const cached = walletBalanceCache.get(key);
    if (cached && Date.now() - cached.time < 2000) return cached.result;
    if (walletBalanceJobs.size >= 4) throw new HttpError(409, '钱包余额查询过多，请稍后再试');
    const work = (async () => {
      const cfg = checked(undefined, 'mint');
      const provider = await dashboardProvider(cfg);
      const result = await svc.readDashboardWalletBalances(provider, target, wallets);
      if (result.project) [result.project] = await catalogQuotes(cfg, [result.project]);
      remember(walletBalanceCache, key, { time: Date.now(), result }, 24);
      return result;
    })();
    walletBalanceJobs.set(key, work);
    try { return await work; } finally { walletBalanceJobs.delete(key); }
  }
  async function projectMetadata(urls) {
    if (!Array.isArray(urls) || urls.length > 32) throw new HttpError(400, '元数据查询每批最多 32 个项目');
    if (!urls.length) return [];
    const entries = [...new Map(urls.map(url => {
      const target = parseMintLink(url);
      return [target.mint + ':' + target.token, target];
    })).values()];
    if (metadataBatches >= 5) throw new HttpError(409, '元数据正在加载，请稍后再试');
    metadataBatches++;
    try {
      const provider = await metadataProvider(checked(undefined, 'mint'));
      const rows = [];
      for (let i = 0; i < entries.length; i += 8) {
        const batch = await Promise.allSettled(entries.slice(i, i + 8).map(t => metadata.lookup(provider, t)));
        rows.push(...batch.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value));
      }
      return rows;
    } finally { metadataBatches--; }
  }
  async function status(cfg) {
    if (cfg.targets.length === 0) return [];
    const revision = configRevision;
    const provider = await readyProvider(cfg, 'dashboard');
    try {
      const block = await provider.getBlock('latest');
      if (!block) throw new Error('无法读取 BSC 区块');
      const watchWallets = allowSimulation ? cfg.watchWallets : await publicWallets();
      const results = await Promise.all(cfg.targets.map(async target => {
        try {
          const chain = await svc.inspectMint(provider, target, block.number);
          const participants = await Promise.all(watchWallets.map(async ({ address: wallet }) => {
            try { return { wallet, ...await svc.inspectParticipant(provider, target, wallet, block.number) }; }
            catch (error) { return { wallet, error: shortError(error) }; }
          }));
          return { block: block.number, mint: target.mint, ...chain, token: target.token, deployedToken: chain.token, participants };
        } catch (error) {
          return { block: block.number, mint: target.mint, token: target.token, error: shortError(error) };
        }
      }));
      const rows = await catalogQuotes(cfg, results);
      for (const row of rows) rememberProjectSnapshot(row, revision);
      return rows;
    } finally { releaseProvider(provider); }
  }
  async function discover(blocks) {
    // Read-only discovery does not require a configured target or strategy.
    const cfg = validateConfig({ ...visibleConfig(example), ...pinned }, root);
    const provider = await readyProvider(cfg, 'discovery');
    try {
      const head = await provider.getBlockNumber();
      return await svc.discoverProjects(provider, Math.max(0, head - blocks + 1), head);
    } finally { releaseProvider(provider); }
  }
  async function preview(url) {
    const target = parseMintLink(url);
    const key = fundingKey(target);
    const existing = previewJobs.get(key);
    if (existing) return existing;
    if (previewJobs.size >= 4) throw new HttpError(409, '项目预览请求过多，请稍后再试。', 'PREVIEW_BUSY');
    const work = (async () => {
      const cfg = validateConfig({ ...visibleConfig(example), ...pinned }, root, { workspace: 'mint' });
      const provider = await readyProvider(cfg, 'dashboard');
      try {
        const block = await provider.getBlock('latest');
        if (!block) throw new Error('无法读取 BSC 区块');
        const chain = await svc.inspectMint(provider, target, block.number, undefined, { verifyPool: true });
        const [row] = await catalogQuotes(cfg, [{ block: block.number, ...chain, mint: target.mint, token: target.token, deployedToken: chain.token }]);
        return row;
      } finally { releaseProvider(provider); }
    })();
    previewJobs.set(key, work);
    try { return await work; } finally { previewJobs.delete(key); }
  }
  function publicRows(rows) {
    return rows.map(({ address, label }) => ({ address, label }));
  }
  async function publicWallets() {
    try { return publicRows(await vault.list()); }
    catch { throw new HttpError(400, '无法读取本地钱包库，请检查文件是否损坏'); }
  }
  async function walletSummary() {
    const walletVault = await publicWallets();
    const liveWallets = walletVault.map(wallet => wallet.address);
    const walletVaultExists = liveWallets.length > 0 || Boolean(await vault.exists?.());
    return { walletVault, walletVaultExists, liveWallets, liveWalletCount: liveWallets.length,
      walletLocalUnlockSupported: allowLive && localUnlock.supported, walletLocalUnlock: await hasLocalUnlock(),
      liveWalletReady: allowLive && liveWallets.length > 0 };
  }
  async function hasLocalUnlock() {
    return allowLive && localUnlock.supported && await localUnlock.exists().catch(() => false);
  }
  async function localPassword() {
    if (!allowLive || !localUnlock.supported) throw new HttpError(400, '此电脑无法使用本机解锁');
    try { return await localUnlock.read(); }
    catch { throw new HttpError(400, '本机解锁不可用，请在钱包管理清除后重新输入原密码'); }
  }
  async function forgetLocalUnlock() {
    if (!allowLive || !localUnlock.supported) throw new HttpError(403, '此电脑无法使用本机解锁');
    if (run || walletWriting || closing) throw new HttpError(409, '请先停止实盘，再修改钱包库解锁方式');
    walletWriting = true;
    try {
      await localUnlock.remove();
      return { walletLocalUnlock: false };
    } catch { throw new HttpError(400, '无法清除本机解锁凭据'); }
    finally { walletWriting = false; }
  }
  async function rememberWalletUnlock(body) {
    if (!allowLive || !localUnlock.supported) throw new HttpError(403, '此电脑无法使用本机解锁');
    if (run || walletWriting || closing) throw new HttpError(409, '请先停止实盘，再修改钱包库解锁方式');
    walletWriting = true;
    let password = body.password;
    delete body.password;
    try {
      await vault.verifyPassword(password);
      await localUnlock.save(password);
      return { walletLocalUnlock: true };
    } catch (error) {
      throw new HttpError(400, error?.code === 'WALLET_VAULT' ? error.message : '未能开启本机免密码，请核对原密码和 Windows 权限');
    } finally { password = undefined; walletWriting = false; }
  }
  async function changeWallets(body, remove) {
    if (!allowLive) throw new HttpError(403, '此测试进程不允许修改钱包库');
    if (run || walletWriting || closing) throw new HttpError(409, '请先停止实盘，再修改钱包清单');
    walletWriting = true;
    try {
      const password = body.useLocalUnlock === true && body.password === undefined ? await localPassword() : body.password;
      const wallets = remove ? await vault.removeWallet({ password, address: body.address })
        : await vault.importWallets({ password, privateKeys: body.privateKeys, label: body.label });
      projects.clear();
      participantCache.clear();
      walletBalanceCache.clear();
      stateChanged();
      return { wallets: publicRows(wallets) };
    } catch (error) {
      // Vault errors are local and intentionally sanitized. Never return request fields.
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, error?.code === 'WALLET_VAULT' ? error.message
        : '钱包操作失败，请检查钱包库密码、私钥格式和重复地址');
    } finally {
      delete body.password;
      delete body.privateKeys;
      walletWriting = false;
    }
  }
  async function saveConfig(input, revision) {
    if (run || saving || walletWriting || closing) throw new HttpError(409, '请先停止任务或等待本机修改完成。');
    requireCurrentConfig(revision);
    object(input, '配置');
    const cfg = checked(input);
    saving = true;
    const tmp = localFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      const merged = { ...visibleConfig(input), ...pinned };
      await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await rename(tmp, localFile);
      diskConfig = merged;
      source = 'local';
      configRevision = randomBytes(16).toString('hex');
      savedKeys = new Set(cfg.targets.map(fundingKey));
      for (const [key, row] of projects) {
        if (typeof row.token !== 'string' || !savedKeys.has(fundingKey(row))) projects.delete(key);
      }
      stateChanged();
      await syncParentDirectory(localFile);
      return { config: visibleConfig(merged), configRevision };
    } finally {
      saving = false;
      await unlink(tmp).catch(() => {});
    }
  }
  async function start(body) {
    if (run || saving || walletWriting || closing) throw new HttpError(409, '已有运行中的任务，请先停止或等待修改完成');
    const { mode, confirmation } = body;
    if (mode !== 'live' && !(mode === 'simulation' && allowSimulation)) throw new HttpError(400, '正式控制台仅支持实盘模式');
    const live = mode === 'live';
    if (live && !allowLive) throw new HttpError(403, '此测试进程不允许实盘');
    if (live && confirmation !== 'BSC LIVE') throw new HttpError(403, '缺少 BSC LIVE 实盘确认');
    if (live && (!Array.isArray(body.expectedWallets) || body.expectedWallets.length < 1 ||
        body.expectedWallets.length > 32 || !body.expectedWallets.every(a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)))) {
      throw new HttpError(400, '请先刷新页面并核对实盘钱包清单');
    }
    const workspace = body.workspace ?? (live ? 'mint' : 'all');
    if (workspace !== 'mint' && workspace !== 'snipe' && !(workspace === 'all' && !live && allowSimulation)) {
      throw new HttpError(400, '请选择 Mint 或开盘狙击工作区');
    }
    if (live) requireCurrentConfig(body.configRevision);
    const cfg = checked(body.config, workspace);
    if (!cfg.targets.length) throw new HttpError(400, '请先添加至少一个项目');
    const expectedWallets = live ? body.expectedWallets.map(address => address.toLowerCase()) : [];
    let password = body.password;
    delete body.password;
    const useLocalUnlock = live && body.useLocalUnlock === true && password === undefined;
    const rememberLocalUnlock = live && body.rememberLocalUnlock === true && localUnlock.supported && !useLocalUnlock;
    if (live && !useLocalUnlock && (typeof password !== 'string' || !password.trim() || Buffer.byteLength(password, 'utf8') > 512)) {
      throw new HttpError(400, '请输入有效的钱包库密码');
    }
    const budget = live ? checkBudget(cfg, expectedWallets) : null;
    const task = { mode, workspace, controller: new AbortController(), ready: false, done: null };
    let recorder, receiptObserver, startupError;
    const jobLog = (event, fields) => {
      log(event, { ...fields, workspace });
      recorder?.record(event, fields);
      receiptObserver?.observe(event, fields);
    };
    const { signal } = task.controller;
    run = task;
    stateChanged();
    let ready, rejectReady;
    const started = new Promise((ok, fail) => { ready = ok; rejectReady = fail; });
    task.done = (async () => {
      let provider, watchProvider, executor;
      try {
        const fastSnipe = live && workspace === 'snipe';
        if (fastSnipe) {
          // Create the file as soon as the launch request is accepted.
          // Diagnostics from RPC checks, arming and allowances belong to
          // the same run even if the monitor never starts.
          recorder = await createSnipeRunRecorder({ rootDir: root, settings: cfg.snipe, targets: cfg.targets });
          lastSnipeReport = recorder.reportPath;
          stateChanged();
          signal.throwIfAborted();
        }
        // WSS remains a separate fast path; the HTTP watcher rotates
        // independently and still covers disconnects or missing events.
        const wsUrl = fastSnipe ? snipeWsUrl(rpcPoolPlan(cfg, 'watch').urls[0]) : undefined;
        provider = await readyProvider(cfg, fastSnipe ? 'snipe' : 'mint');
        signal.throwIfAborted();
        let wallets;
        try { wallets = live ? await vault.unlock({ password: useLocalUnlock ? await localPassword() : password, provider }) : cfg.watchWallets; }
        catch (error) {
          if (error instanceof HttpError) throw error;
          throw new Error('无法解锁钱包库：请检查密码与钱包库文件');
        }
        signal.throwIfAborted();
        if (live && (wallets.length !== expectedWallets.length ||
            wallets.some((w, i) => w.address.toLowerCase() !== expectedWallets[i]))) {
          throw new Error('实盘钱包与已核对的清单不同，请刷新页面后重新确认');
        }
        if (rememberLocalUnlock) {
          try { await localUnlock.save(password); }
          catch { jobLog('wallet_local_unlock_error', { error: '本机免密码设置未保存，本次仍可用已解锁钱包运行。' }); }
        }
        password = undefined;
        let prepared;
        if (fastSnipe) {
          watchProvider = await readyProvider(cfg, 'watch');
          prepared = { ...await svc.prepareSnipe({ provider, watchProvider, cfg, wallets, signal, log: jobLog }), wsUrl };
        }
        executor = await svc.makeExecutor({ provider, wallets, live, signal, maxGasPriceWei: cfg.maxGasPriceWei,
          gasLimitCap: cfg.gasLimitCap, journalPath: cfg.journalPath, confirmations: 3, receiptTimeoutMs: fastSnipe ? 0 : 1500,
          directBroadcast: fastSnipe, ...(fastSnipe ? { broadcastConcurrency: cfg.snipe.broadcastConcurrency } : {}) });
        const approvals = live ? await svc.prepareQuoteAllowances({
          provider, cfg, wallets, execute: executor, signal, log: jobLog, inspect: svc.inspectMint,
        }) : 0;
        // An approval wait can span the entire opening window. Never use an
        // arming cutoff from before the wallets were ready for this market.
        if (fastSnipe && approvals) {
          prepared = { ...await svc.prepareSnipe({ provider, watchProvider, cfg, wallets, signal, log: jobLog }), wsUrl };
        }
        const armBlock = prepared?.armBlock ?? await provider.getBlockNumber();
        signal.throwIfAborted();
        const execute = async request => {
          signal.throwIfAborted();
          return executor({ ...request, beforeSign: async () => {
            signal.throwIfAborted();
            await request.beforeSign?.();
            signal.throwIfAborted();
          } });
        };
        execute.reconcile = executor.reconcile;
        execute.prepare = executor.prepare;
        execute.race = executor.race;
        execute.raceStatus = executor.raceStatus;
        execute.reconcilePending = executor.reconcilePending;
        execute.reconcileRecent = executor.reconcileRecent;
        if (prepared) {
          receiptObserver = createSnipeReceiptObserver({ provider: watchProvider, record: recorder.record, signal });
          signal.throwIfAborted();
        }
        const fast = prepared ? svc.makeFastSnipe({ provider, watchProvider, settings: cfg.snipe, prepared, cfg, execute, signal, log: jobLog }) : null;
        const tick = fast ? null : svc.makeMonitor({ provider, cfg, wallets, execute, armBlock, signal, log: jobLog });
        task.pendingHealth = fast?.pendingHealth;
        task.ready = true;
        lastError = undefined;
        lastErrorWorkspace = undefined;
        jobLog('watch_started', { chainId: Number(CHAIN_ID), armBlock, live, wallets: wallets.map(w => w.address),
          ...(budget === null ? {} : { worstCaseBnb: formatEther(budget) }),
          message: fast ? '事件驱动狙击：WSS/HTTP 监控与交易执行分开' :
            wallets.length === 0 ? '未填写观察钱包，当前只看链上进度' : undefined });
        ready();
        if (fast) { await fast(); return; }
        if (live && execute.reconcile) {
          const reconciled = new Set();
          if (executor.reconcilePending) {
            // A transaction from a previous run or the other workspace can
            // still reserve a nonce; do not resubmit, just surface its status.
            const pendingResults = await Promise.allSettled(wallets.map(async wallet => {
              if (signal.aborted) return;
              const row = await executor.reconcilePending(wallet);
              if (row) {
                reconciled.add(row.wallet + ':' + row.actionId);
                const [, mint, kind] = row.actionId.split(':');
                jobLog('journal', { action: kind, mint, ...row });
              }
            }));
            if (!signal.aborted && pendingResults.some(result => result.status === 'rejected')) {
              jobLog('rpc_error', { error: '暂未核对部分钱包的历史交易；不会重新提交未决交易。' });
            }
          }
          for (const target of cfg.targets) {
            if (signal.aborted) break;
            const mintWallets = target.mintBatches || target.autoClaim ? mintWalletsFor(target, wallets) : [];
            const buyWallets = target.buyOnLaunch ? wallets.slice(0, cfg.snipe.walletCount) : [];
            const rows = [
              ...(target.mintBatches ? mintWallets.map(w => ['mint', w]) : []),
              ...(target.autoClaim ? mintWallets.map(w => ['claim', w]) : []),
              ...buyWallets.map(w => ['buy', w]),
            ];
            for (const [kind, wallet] of rows) {
              if (signal.aborted) break;
              const id = actionId(kind, target);
              if (reconciled.has(wallet.address + ':' + id)) continue;
              try {
                const row = await execute.reconcile(id, wallet);
                if (row) jobLog('journal', { action: kind, mint: target.mint, ...row });
              } catch (error) {
                if (!signal.aborted) jobLog('rpc_error', { error: shortError(error) });
              }
            }
          }
        }
        while (!signal.aborted) {
          try { await tick(); } catch (e) { if (!signal.aborted) jobLog('rpc_error', { error: shortError(e) }); }
          try { await delay(cfg.pollMs, undefined, { signal }); } catch (e) { if (!signal.aborted) throw e; }
        }
      } catch (e) {
        const error = signal.aborted ? '任务已停止' : shortError(e);
        if (!task.ready) startupError = new HttpError(400, error);
        if (!signal.aborted) jobLog('watch_error', { error });
      } finally {
        password = undefined;
        try { executor?.close?.(); } catch { jobLog('watch_error', { error: '交易日志未能正常关闭' }); }
        if (task.ready || (recorder && signal.aborted)) jobLog('watch_stopped');
        try { await receiptObserver?.close(); } catch { /* Telemetry must not prevent shutdown. */ }
        try {
          const report = await recorder?.close();
          if (report?.failed) throw new Error('Report write failed');
          if (report?.dropped) log('snipe_report_warning', { workspace,
            message: '运行记录有 ' + report.dropped + ' 条事件未写入，请核对文件末行统计。' });
        } catch { log('watch_error', { workspace, error: '测速记录未能正常结束，请查看已写入的部分' }); }
        try {
          if (watchProvider !== provider) releaseProvider(watchProvider);
          releaseProvider(provider);
        } finally {
          if (run === task) { run = null; stateChanged(); }
          if (startupError) rejectReady(startupError);
        }
      }
    })();
    await started;
    return { ...state(), ...(live ? { walletLocalUnlock: await hasLocalUnlock() } : {}) };
  }
  async function stop(workspace) {
    const task = run;
    if (task) {
      if (workspace !== undefined && task.workspace !== workspace) throw new HttpError(409, '请到正在运行的工作区停止任务');
      if (!task.controller.signal.aborted) {
        task.controller.abort();
        stateChanged();
      }
      await task.done;
    }
    return state();
  }
  function acceptLifecycle(body, res) {
    if (Object.keys(body).length !== 1 || !['restart', 'exit'].includes(body.action)) {
      throw new HttpError(400, '请选择重启或退出');
    }
    if (!serviceControls) throw new HttpError(409, '该服务进程未启用网页启停');
    if (saving || walletWriting) throw new HttpError(409, '正在保存配置或钱包，请等保存完成再试');
    serviceAction = body.action;
    closing = true;
    // Acknowledge the intent before closing the HTTP listener. Even a tab
    // closed during the acknowledgement should not leave the service locked.
    let invoked = false;
    const finish = () => {
      if (invoked) return;
      invoked = true;
      void Promise.resolve().then(() => onLifecycle(serviceAction)).catch(() => {});
    };
    res.once('finish', finish);
    res.once('close', finish);
    return json(res, 202, { action: serviceAction });
  }
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      // Host pinning prevents DNS rebinding; cross-site navigations cannot call APIs.
      if (!origin || req.headers.host !== new URL(origin).host) throw new HttpError(403, '只接受本机控制台访问');
      const requestUrl = new URL(req.url, origin);
      const { pathname } = requestUrl;
      const session = req.headers['x-corla-session'];
      if (pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '拒绝跨站请求');
      if (req.method === 'GET' && Object.hasOwn(assets, pathname)) {
        const [file, type] = assets[pathname];
        const data = await readFile(join(root, 'ui', file));
        res.writeHead(200, { ...headers, 'Content-Type': type });
        res.end(data);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/health') {
        return json(res, 200, { service: 'corla-desk', instance: stateEpoch, action: serviceAction });
      }
      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        const wallets = await walletSummary();
        return json(res, 200, { config: visibleConfig(diskConfig), configRevision, source, sessionToken,
          allowLive, snipeTiming, serviceControls, serviceInstance: stateEpoch, ...wallets });
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        const since = requestUrl.searchParams.get('since');
        const afterLog = requestUrl.searchParams.get('afterLog');
        if ((req.headers.origin && req.headers.origin !== origin) ||
            ((session !== undefined || since !== null || afterLog !== null) && !safeToken(session, sessionToken))) {
          throw new HttpError(403, '本地会话已失效，请重新连接。', 'SESSION_EXPIRED');
        }
        const revision = stateRevision();
        return json(res, 200, since === revision && (afterLog === null || afterLog === logCursor())
          ? { unchanged: true, stateRevision: revision, ...pendingState() } : state(afterLog));
      }
      if (req.method === 'GET' && pathname === '/api/rpc/status') {
        if ((req.headers.origin && req.headers.origin !== origin) ||
            !safeToken(session, sessionToken)) {
          throw new HttpError(403, '本地会话校验失败，请重新连接。', 'SESSION_EXPIRED');
        }
        return json(res, 200, rpcStatus());
      }
      if (req.method !== 'POST' || !postRoutes.has(pathname)) throw new HttpError(404, '页面不存在');
      if (req.headers.origin !== origin) throw new HttpError(403, '本地会话校验失败，请刷新页面');
      if (!safeToken(session, sessionToken)) throw new HttpError(403, '本地会话已失效，请重新连接。', 'SESSION_EXPIRED');
      if (closing) throw new HttpError(409, '本地服务正在停止，请稍候', 'SERVICE_STOPPING');
      const body = await readBody(req);
      if (closing) throw new HttpError(409, '本地服务正在停止，请稍候', 'SERVICE_STOPPING');
      if (pathname === '/api/local/lifecycle') return acceptLifecycle(body, res);
      if (pathname === '/api/notifications/stream') {
        const enabled = body.enabled;
        if (Object.keys(body).length !== 1 || !enabled || typeof enabled !== 'object' || Array.isArray(enabled) ||
            Object.keys(enabled).length !== 2 || typeof enabled.whitelist !== 'boolean' || typeof enabled.burst !== 'boolean' ||
            (!enabled.whitelist && !enabled.burst)) throw new HttpError(400, '请至少启用一种桌面通知');
        if (!notificationStream.canAttach()) throw new HttpError(409, '桌面通知连接已满，请关闭多余的控制台标签页');
        res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
        notificationStream.attach(res, { whitelist: enabled.whitelist, burst: enabled.burst });
        return;
      }
      let result;
      if (pathname === '/api/config') result = await saveConfig(body.config, body.configRevision);
      if (pathname === '/api/wallets/import' || pathname === '/api/wallets/remove') {
        result = await changeWallets(body, pathname.endsWith('/remove'));
      }
      if (pathname === '/api/wallets/forget-local-unlock') result = await forgetLocalUnlock();
      if (pathname === '/api/wallets/remember-local-unlock') result = await rememberWalletUnlock(body);
      if (pathname === '/api/start') result = await start(body);
      if (pathname === '/api/stop') result = await stop(body.workspace);
      if (pathname === '/api/project/preview') result = { project: await preview(body.url) };
      if (pathname === '/api/project/participants') result = await participants(body.url);
      if (pathname === '/api/project/wallet-balances') result = await walletBalances(body);
      if (pathname === '/api/project/metadata') result = { projects: await projectMetadata(body.urls) };
      if (pathname === '/api/catalog') result = await catalogPage(body);
      if (pathname === '/api/catalog/status') result = { projects: await catalogStatus(body.urls) };
      if (pathname === '/api/catalog/resolve') result = { project: await resolveCatalogAddress(body.address) };
      if (pathname === '/api/catalog/funding-times') result = catalogFundingTimes(body.urls);
      if (pathname === '/api/catalog/quote-assets') {
        if (Object.keys(body).length) throw new HttpError(400, '底池目录无需附加参数');
        try {
          result = await readFlapQuoteCatalog(await dashboardProvider(checked(undefined, 'mint')));
        } catch {
          // A failed read on an existing route is not a missing API route.
          throw new HttpError(503, '底池目录暂时读取失败，请稍后重试', 'QUOTE_CATALOG_UNAVAILABLE');
        }
      }
      if (pathname === '/api/status' && body.summaryOnly === true) {
        const startedAt = performance.now();
        const cfg = checked(body.config, body.workspace ?? 'all');
        result = { projects: await summaryStatus(cfg), elapsedMs: Math.round(performance.now() - startedAt) };
      }
      if ((pathname === '/api/status' && body.summaryOnly !== true) || pathname === '/api/discover') {
        if (reading) throw new HttpError(409, '已有查询请求，请稍后再试');
        reading = true;
        try {
          const rows = pathname === '/api/status' ? await status(checked(body.config, body.workspace ?? 'all'))
            : await discover(int(body.blocks ?? 3000, '扫描区块数', 1, 50000));
          result = { projects: rows };
        } finally { reading = false; }
      }
      return json(res, 200, result);
    } catch (e) {
      if (!res.headersSent && !res.destroyed) {
        const code = e.status ?? (e.code === 'ENOENT' ? 404 : 400);
        if (code === 413) {
          res.shouldKeepAlive = false;
          res.setHeader('Connection', 'close');
        }
        json(res, code, { error: code === 404 ? '页面不存在' : shortError(e),
          ...(e.publicCode ? { code: e.publicCode } : {}) });
      }
    }
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => { server.off('error', fail); ok(); });
  });
  origin = 'http://' + host + ':' + server.address().port;
  return {
    server, url: origin,
    close() {
      if (closeTask) return closeTask;
      closing = true;
      catalogFundingAbort.abort();
      closeTask = (async () => {
        try {
          // Keep the health check reachable until the current job has drained
          // and flushed its journal/report, so the page does not announce an
          // exit before it is safe to release the port.
          await Promise.all([stop(), notificationStream.close()]);
        } finally {
          await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
          if (svc.makeProvider) {
            dashboard?.destroy?.();
            if (metadataRpc !== dashboard) metadataRpc?.destroy?.();
          }
          for (const provider of rpcPools.values()) provider.destroy();
          await catalogFundingWork;
        }
      })();
      return closeTask;
    },
  };
}

async function recordLauncherError(error) {
  const message = shortError(error);
  console.error(message);
  try {
    const dir = join(defaultRoot, 'state');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'ui-start.log'), new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
  } catch { /* The launcher can still show a generic error. */ }
  process.exitCode = 1;
}
function restartUi(url) {
  const port = new URL(url).port;
  return new Promise((ok, fail) => {
    // Fixed executable/entry point. The HTTP client supplies no path, flags,
    // or command. Do not open a second browser tab on a restart.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--port', port], {
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', fail);
    child.once('spawn', () => { child.unref(); ok(); });
  });
}
function openUi(url) {
  if (process.platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
  }
}
async function isRunningUi(url) {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(900), redirect: 'error' });
    const health = response.ok && await response.json();
    return health?.service === 'corla-desk' && /^[a-f0-9]{16}$/.test(health.instance) && health.action === null;
  } catch { return false; }
}
async function main() {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '3924' },
    open: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('用法: npm.cmd run ui -- [--port 3924] [--open]');
    return;
  }
  requireRuntime();
  const port = int(Number(values.port), '端口', 0, 65535);
  let app, transition;
  const shutdown = action => {
    transition ??= (async () => {
      await app.close();
      if (action === 'restart') await restartUi(app.url);
    })().catch(recordLauncherError);
    return transition;
  };
  try {
    app = await createUiServer({ port, onLifecycle: shutdown });
  } catch (error) {
    const url = 'http://127.0.0.1:' + port;
    if (values.open && error.code === 'EADDRINUSE' && await isRunningUi(url)) {
      openUi(url);
      return;
    }
    throw error;
  }
  console.log('Corla 本地控制台: ' + app.url);
  console.log('正式实盘模式。只有在页面确认并解锁钱包后才启动交易。按 Ctrl+C 退出。');
  process.on('SIGINT', () => { void shutdown('exit'); });
  process.on('SIGTERM', () => { void shutdown('exit'); });
  if (values.open) openUi(app.url);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(recordLauncherError);
}
