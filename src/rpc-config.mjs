const PUBLIC_NODE = 'https://bsc-rpc.publicnode.com';
const BNB_OFFICIAL = 'https://bsc-dataseed.bnbchain.org';
export const DEFAULT_BSC_RPC_URL = PUBLIC_NODE;
export const BUILTIN_RPC_URLS = Object.freeze([
  BNB_OFFICIAL,
  PUBLIC_NODE,
  'https://bsc.nodereal.io',
  'https://bsc-dataseed.defibit.io',
]);
// BNB Chain's official public dataseeds disable eth_getLogs. These are
// candidates, not guarantees: the watcher probes the actual method.
export const BUILTIN_WATCH_RPC_URLS = Object.freeze([
  PUBLIC_NODE,
  'https://bsc.rpc.blxrbdn.com',
  'https://bsc.drpc.org',
  'https://bnb.api.onfinality.io/public',
]);

export function validateRpcUrl(value, label = 'BSC RPC') {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(label + ' URL 无效');
  let url;
  try { url = new URL(value); } catch { throw new Error(label + ' URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash) {
    throw new Error(label + ' 必须使用不含片段的 HTTP(S) URL');
  }
  return url.href;
}

export function validateRpcBackupUrls(value, label = 'rpcBackupUrls') {
  if (!Array.isArray(value) || value.length > 7) throw new Error(label + ' 必须是至多 7 个 RPC URL 的数组');
  return [...new Set(value.map(url => validateRpcUrl(url, label)))];
}

function envBackup(env, key) {
  if (env[key] === undefined) return undefined;
  return validateRpcBackupUrls(env[key].split(',').map(url => url.trim()).filter(Boolean), key);
}

const prefixes = {
  dashboard: 'BSC_DASHBOARD_RPC',
  metadata: 'BSC_METADATA_RPC',
  catalogHistory: 'BSC_CATALOG_HISTORY_RPC',
  notifications: 'BSC_NOTIFICATIONS_RPC',
  watch: 'BSC_WATCH_RPC',
  snipe: 'BSC_SNIPE_RPC',
};

/** Keep custom/private endpoints isolated unless the operator opts into specific backups. */
export function rpcPoolPlan(cfg, role, env = process.env) {
  const prefix = prefixes[role];
  const override = prefix && env[prefix + '_URL'];
  const dashboardOverride = role === 'metadata' && env.BSC_DASHBOARD_RPC_URL;
  const usingDefault = !cfg.rpcCustom && validateRpcUrl(cfg.rpcUrl) === validateRpcUrl(PUBLIC_NODE);
  const usesWatchDefault = role === 'watch' && !override;
  const base = override || dashboardOverride || (usesWatchDefault ? PUBLIC_NODE
    : usingDefault && ['dashboard', 'metadata', 'snipe'].includes(role) ? BNB_OFFICIAL : cfg.rpcUrl);
  const specific = prefix ? envBackup(env, prefix + '_BACKUP_URLS') : undefined;
  const inherited = override ? undefined
    : dashboardOverride ? envBackup(env, 'BSC_DASHBOARD_RPC_BACKUP_URLS')
    : envBackup(env, 'BSC_RPC_BACKUP_URLS') ?? cfg.rpcBackupUrls;
  const usesLogs = ['watch', 'discovery', 'catalogHistory', 'notifications'].includes(role);
  // The faster short-range watcher gateways may not serve old logs. The
  // history role defaults to the PublicNode endpoint verified for this use.
  const builtins = (usesWatchDefault || usingDefault) && !override && !dashboardOverride
    ? role === 'catalogHistory' ? [PUBLIC_NODE] : usesLogs ? BUILTIN_WATCH_RPC_URLS : BUILTIN_RPC_URLS
    : [];
  const backups = specific ?? inherited ?? builtins;
  const first = validateRpcUrl(base);
  const urls = [base, ...new Set(backups.map(url => validateRpcUrl(url)))].filter((url, i) => !i || url !== first);
  return {
    urls,
    lowLatency: ['dashboard', 'metadata', 'watch', 'snipe', 'notifications'].includes(role),
    requiredMethods: usesLogs ? ['eth_getLogs'] : role === 'snipe' ? ['eth_simulateV1'] : [],
    ...(role === 'catalogHistory' ? { requestTimeoutMs: 7500 } : {}),
  };
}
