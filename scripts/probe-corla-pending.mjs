import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { CHAIN_ID, parseMintLink, readJson, snipeTargetUrls } from '../src/config.mjs';
import { makeLaunchFeed } from '../src/launch-feed.mjs';
import { shortError } from '../src/monitor.mjs';
import { armPendingTargets, makePendingMintShadow, makePendingTransactionFeed, pendingWsUrl } from '../src/pending-mint-shadow.mjs';
import { BUILTIN_WATCH_RPC_URLS } from '../src/rpc-config.mjs';
import { createRpcPool } from '../src/rpc-pool.mjs';

// Standalone shadow telemetry. The only configuration used is project links;
// no live process, signer, vault, journal, or write/broadcast RPC is loaded.
const usage = `只读观测 Corla 末笔 Mint 是否早于本地确认信号可见
node scripts/probe-corla-pending.mjs --ws wss://bsc-rpc.publicnode.com --seconds 120 [--config config.local.json]
node scripts/probe-corla-pending.mjs --target "<Corla v4 链接>" --seconds 120

--target 可重复；省略时仅读取 config.local.json 的狙击名单。已开盘和无法核验的项目不计入样本。
--ws 或 BSC_PENDING_WSS_URL 必选（如含访问凭据，用环境变量）。--seconds 默认 120，范围 1–3600。
开盘验证走独立 PublicNode WSS + 公共 HTTP 补扫；输出 JSON Lines。不会发交易。
没有开盘样本不是 0% 覆盖。提前量仅相对本进程的首次确认通知，不证明早于打包。\n`;
const write = (event, payload) => console.log(JSON.stringify({ event, ...payload }));

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, ws: { type: 'string' }, seconds: { type: 'string' },
    config: { type: 'string' }, target: { type: 'string', multiple: true },
  } });
  if (values.help) { process.stdout.write(usage); return; }
  if (values.target && values.config) throw new Error('请在 --target 与 --config 中选择一种');
  const ws = pendingWsUrl(values.ws ?? process.env.BSC_PENDING_WSS_URL);
  const duration = values.seconds ?? '120';
  if (!/^\d{1,4}$/.test(duration) || Number(duration) < 1 || Number(duration) > 3600) {
    throw new Error('--seconds 必须是 1–3600 秒');
  }
  const seconds = Number(duration);
  let links = values.target;
  if (!links) {
    try {
      const file = values.config ?? fileURLToPath(new URL('../config.local.json', import.meta.url));
      links = snipeTargetUrls(await readJson(file));
    } catch { throw new Error('无法读取狙击项目名单，请使用 --config 或 --target'); }
  }
  if (!Array.isArray(links) || !links.length || links.length > 32) throw new Error('请提供 1–32 个 Corla v4 项目');
  const configured = links.map(parseMintLink);
  const provider = createRpcPool(BUILTIN_WATCH_RPC_URLS, { lowLatency: true, requiredMethods: ['eth_getLogs'] });
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let pendingFeed, confirmedFeed, progress;
  try {
    if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error('公共观测 RPC 未验证为 BSC');
    const { targets, excluded, armBlock } = await armPendingTargets(provider, configured);
    if (stop.signal.aborted) return;
    write('armed', { armBlock, durationSeconds: seconds, targets: targets.map(({ mint, token }) => ({ mint, token })), excluded });
    if (!targets.length) {
      write('summary', { result: 'no_active_targets', canonicalLaunches: 0, coveragePct: null });
      return;
    }
    const shadow = makePendingMintShadow({ provider, targets, armBlock,
      pendingStatus: () => pendingFeed.status(),
      onObservation: row => write('launch_observed_provisional', row),
    });
    pendingFeed = makePendingTransactionFeed({
      wsUrl: ws, signal: stop.signal, onTransaction: shadow.observePending,
      onStatus: details => write('pending_status', details),
    });
    confirmedFeed = makeLaunchFeed({
      provider, targets, armBlock, windowBlocks: 32, scanMs: 650, wsUrl: 'wss://bsc-rpc.publicnode.com',
      signal: stop.signal, onCandidate: shadow.onCandidate, onRemoved: shadow.onRemoved,
      onStatus: details => write('confirmation_status', details),
    });
    progress = setInterval(() => write('progress', pendingFeed.status()), 15_000);
    pendingFeed.start();
    confirmedFeed.start();
    try { await sleep(seconds * 1000, undefined, { signal: stop.signal }); }
    catch (error) { if (!stop.signal.aborted) throw error; }
    const pending = pendingFeed.status();
    stop.abort();
    await confirmedFeed.close();
    const summary = await shadow.summarize();
    const opportunities = summary.canonicalLaunchesDuringHealthyFullFeed;
    write('summary', { ...summary, pending, coveragePct: opportunities ? 100 * summary.matchesDuringHealthyFullFeed / opportunities : null,
      result: !summary.canonicalLaunches ? 'no_launch_sample' : opportunities ? 'measured' : 'no_healthy_full_feed_sample' });
  } finally {
    clearInterval(progress);
    stop.abort();
    pendingFeed?.close();
    try { await confirmedFeed?.close(); } finally {
      provider.destroy();
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }
}

main().catch(error => {
  // parseArgs errors can contain verbatim argv, potentially the WSS URL.
  const message = String(error?.code ?? '').startsWith('ERR_PARSE_ARGS') ? '参数无效，使用 --help 查看格式' : shortError(error);
  console.error(message);
  process.exitCode = 1;
});
