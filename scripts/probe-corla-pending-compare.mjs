import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { CHAIN_ID, parseMintLink } from '../src/config.mjs';
import { makeLaunchFeed } from '../src/launch-feed.mjs';
import { armPendingTargets, makePendingTransactionFeed, pendingWsUrl } from '../src/pending-mint-shadow.mjs';
import { BUILTIN_WATCH_RPC_URLS } from '../src/rpc-config.mjs';
import { createRpcPool } from '../src/rpc-pool.mjs';
import { makeSnipePendingCompare } from '../src/snipe-pending-compare.mjs';

const USAGE = `多来源 Corla 末笔 Mint 只读测量（不读取钱包、应用配置或交易日志）
node scripts/probe-corla-pending-compare.mjs --target "<Corla v4 链接>" --source wss://bsc-rpc.publicnode.com --source-env OTHER_PENDING_WSS --seconds 120

--target 可重复（1–32 个）；仅观测起始时仍在筹资的项目。
--source / --source-env 可重复（合计 1–8 个不同地址），有凭据的 URL 请通过 --source-env 传入。
--seconds 1–3600（默认 120）。输出 JSON Lines，只记录来源编号、公开链上哈希和计时，不记录节点 URL。
覆盖率按核验后的确认样本计算；提前量是本机先见差值，不证明早于打包。无开盘样本不是 0% 覆盖。
默认只订阅标准 Pending 接口，兼容仅返回哈希的节点，但不扩大成高频单哈希查询，也不广播。
`;
const write = (event, row) => console.log(JSON.stringify({ event, ...row }));
let stage = 'arguments';

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, target: { type: 'string', multiple: true },
    source: { type: 'string', multiple: true }, 'source-env': { type: 'string', multiple: true },
    seconds: { type: 'string' },
  } });
  if (values.help) { process.stdout.write(USAGE); return; }
  const rawDuration = values.seconds ?? '120';
  if (!/^\d{1,4}$/.test(rawDuration) || Number(rawDuration) < 1 || Number(rawDuration) > 3600) throw new Error();
  if (!values.target?.length || values.target.length > 32) throw new Error();
  const duration = Number(rawDuration);
  const configured = values.target.map(parseMintLink);
  const fromEnvironment = (values['source-env'] ?? []).map(name => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,95}$/.test(name)) throw new Error();
    return process.env[name];
  });
  const endpoints = [...(values.source ?? []), ...fromEnvironment].map(pendingWsUrl);
  if (!endpoints.length || endpoints.length > 8 || new Set(endpoints).size !== endpoints.length) throw new Error();
  const slots = endpoints.map((_, i) => i + 1);

  // This driver calls read-only methods; it neither loads credentials from the
  // application nor instantiates wallet, signer, execution journal, or Builder.
  stage = 'arming';
  const provider = createRpcPool(BUILTIN_WATCH_RPC_URLS, { lowLatency: true, requiredMethods: ['eth_getLogs'] });
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const feeds = [];
  let confirmed, progress;
  try {
    if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error();
    const { targets, excluded, armBlock } = await armPendingTargets(provider, configured);
    if (stop.signal.aborted) return;
    write('armed', { armBlock, durationSeconds: duration, sources: slots,
      targets: targets.map(({ mint, token }) => ({ mint, token })), excluded });
    if (!targets.length) {
      write('summary', { result: 'no_active_targets', canonicalLaunches: 0, signedEnvelopeAnySource: { earlyCoveragePct: null } });
      return;
    }
    stage = 'observing';
    const comparer = makeSnipePendingCompare({ provider, targets, armBlock, sources: slots,
      sourceStatus: slot => feeds[slot - 1]?.status(), onObservation: row => write('launch_observed_provisional', row) });
    for (const slot of slots) {
      feeds.push(makePendingTransactionFeed({ wsUrl: endpoints[slot - 1], signal: stop.signal,
        onTransaction: (tx, meta) => comparer.observePending(slot, tx, meta),
        onHash: (hash, meta) => comparer.observeHash(slot, hash, meta),
        onStatus: details => write('pending_status', { source: slot, ...details }) }));
    }
    confirmed = makeLaunchFeed({ provider, targets, armBlock, windowBlocks: 32,
      scanMs: 650, wsUrl: 'wss://bsc-rpc.publicnode.com', signal: stop.signal,
      onCandidate: comparer.onCandidate, onRemoved: comparer.onRemoved,
      onStatus: details => write('confirmation_status', details) });
    const sourceStates = () => feeds.map((feed, i) => ({ source: slots[i], ...feed.status() }));
    progress = setInterval(() => write('progress', { pendingStatus: sourceStates() }), 15_000);
    for (const feed of feeds) feed.start();
    confirmed.start();
    try { await sleep(duration * 1_000, undefined, { signal: stop.signal }); }
    catch (error) { if (!stop.signal.aborted) throw error; }
    const pendingStatus = sourceStates(), interrupted = stop.signal.aborted;
    clearInterval(progress);
    stop.abort();
    await confirmed.close();
    stage = 'summary';
    write('summary', { ...(await comparer.summarize()), interrupted, pendingStatus });
  } finally {
    clearInterval(progress);
    stop.abort();
    for (const feed of feeds) feed.close();
    try { await confirmed?.close(); } finally {
      provider.destroy();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
}

main().catch(() => {
  // Third-party transport errors and argument errors can include secrets.
  console.error(stage === 'arguments' ? '参数无效，请使用 --help 查看格式' : `只读探测失败（阶段：${stage}）`);
  process.exitCode = 1;
});
