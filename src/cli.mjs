import { formatEther, formatUnits } from 'ethers';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { CHAIN_ID, address, checkBudget, int, loadConfig, quoteSpendRows, snipeSettingsForTarget } from './config.mjs';
import { inspectMint, inspectParticipant } from './corla.mjs';
import { discoverProjects } from './events.mjs';
import { readMarket, verifyRoundTrip } from './market.mjs';
import { actionId, makeMonitor, shortError } from './monitor.mjs';
import { loadWallets, makeExecutor } from './execution.mjs';
import { createRpcPool } from './rpc-pool.mjs';
import { rpcPoolPlan } from './rpc-config.mjs';
import { requireRuntime } from './runtime.mjs';
import { prepareQuoteAllowances } from './quote-allowances.mjs';
import { formatQuoteUnits } from './quote-assets.mjs';

const help = `Flap Corla Mint Tool · BNB Smart Chain (56)
  npm start -- status   [--config FILE]
  npm start -- discover [--config FILE] [--blocks N]
  npm start -- quote    [--config FILE] [--token 0x...] [--wallet 0x...]
  npm start -- watch    [--config FILE] [--once]
  npm start -- watch    --live --config FILE

默认仅链上读取或模拟。--live 只能用于 watch，且必须在终端再次确认。
watch 只自动交易配置中明确指定的项目，不会自动买 discover 的结果。
配置默认为 config.example.json；真实运行请另存为 config.local.json。`;

function log(event, data) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
}
async function confirmLive(cfg, wallets, budget) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('主网执行必须在交互式终端确认');
  console.log('\n将启用 BSC 主网交易。钱包只应由此程序使用，且应为专用小额钱包。');
  for (const wallet of wallets) console.log('  钱包: ' + wallet.address);
  for (const t of cfg.targets) {
    console.log('  Token: ' + t.token + ' / Mint: ' + t.mint);
    console.log('    每钱包 Mint: ' + t.mintBatches + ' 批'
      + (t.mintBatches ? '（每批不超过 ' + (t.mintQuote ?
        formatQuoteUnits(t.mintQuote.priceLimit, t.mintQuote.quoteDecimals) + ' / 支付币 ' + t.mintQuote.quoteToken :
        formatEther(t.maxMintPriceWei) + ' BNB') + '）' : '')
      + '；自动领取: ' + (t.autoClaim ? '是' : '否') + '；开盘买入: ' + (t.buyOnLaunch ? '是' : '否'));
  }
  if (cfg.snipe) {
    console.log('  买入: 前 ' + cfg.snipe.walletCount + ' 个钱包；最大滑点 '
      + cfg.snipe.slippageBps + ' bps；开盘价溢价上限 ' + cfg.snipe.maxOpeningPremiumBps
      + ' bps；只对启动后开盘且距开盘未超 ' + cfg.snipe.windowBlocks + ' 块的项目下单。');
    if (cfg.targets.some(t => t.buyOnLaunch && !t.snipeQuote)) console.log('  BNB 项目每钱包买入 ' + formatEther(cfg.snipe.amountIn)
      + ' BNB；最低 WBNB 储备 ' + formatEther(cfg.snipe.minLiquidity) + ' WBNB。');
  }
  const quotes = quoteSpendRows(cfg, wallets);
  for (const row of quotes) console.log('  ' + row.wallet.address + ' / ' + row.target.token + ': ' +
    formatQuoteUnits(row.amount, row.quoteDecimals) + ' 支付币 ' + row.quoteToken);
  if (quotes.length) console.log('  支付币本金与 BNB 分开，额度不足会先授权至确认金额：Mint 授权 Corla 工厂，买入授权 Pancake V2 Router。');
  console.log('  预估最坏支出（含 Gas 上限）: ' + formatEther(budget) + ' BNB；Gas 上限: '
    + formatUnits(cfg.maxGasPriceWei, 9) + ' Gwei × ' + cfg.gasLimitCap);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if ((await prompt.question('确认请输入 BSC LIVE: ')).trim() !== 'BSC LIVE') throw new Error('未确认，未广播交易');
  } finally { prompt.close(); }
}

async function main() {
  const { positionals, values: flags } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' }, help: { type: 'boolean', short: 'h' },
      live: { type: 'boolean' }, once: { type: 'boolean' }, blocks: { type: 'string' },
      token: { type: 'string' }, wallet: { type: 'string' },
    },
  });
  const [command = 'status'] = positionals;
  if (flags.help || command === 'help') return console.log(help);
  if (positionals.length > 1 || !['status', 'discover', 'quote', 'watch'].includes(command)) throw new Error(help);
  if (flags.live && (command !== 'watch' || flags.once || !flags.config || resolve(flags.config) === resolve('config.example.json'))) {
    throw new Error('--live 仅用于 watch，须显式指定非示例配置，且不能加 --once');
  }
  if ((flags.once && command !== 'watch') || (flags.blocks && command !== 'discover') ||
      ((flags.token || flags.wallet) && command !== 'quote')) throw new Error('命令选项不匹配；使用 --help');

  requireRuntime();
  const cfg = await loadConfig(flags.config ?? 'config.example.json');
  if (flags.live && cfg.snipe?.requirePreopen) {
    throw new Error('命令行实盘不支持「没抢到开盘就不追」，请使用网页「开盘狙击」工作区');
  }
  if (flags.live && cfg.snipe?.repeatAttempts > 1) throw new Error('多次竞争狙击目前仅在网页「开盘狙击」工作区运行');
  if (flags.live && cfg.snipe?.broadcastConcurrency > 1) throw new Error('多节点并发投递仅在网页「开盘狙击」工作区运行');
  const plan = rpcPoolPlan(cfg, command === 'discover' ? 'discovery' : command === 'quote' ? 'snipe' : 'mint');
  const provider = createRpcPool(plan.urls, plan);
  let execute;
  try {
    if ((await provider.getNetwork()).chainId !== CHAIN_ID) throw new Error('RPC 不是 BSC 主网 (chain ID 56)');
    if (command === 'status') {
      const block = await provider.getBlock('latest');
      for (const target of cfg.targets) {
        const state = await inspectMint(provider, target, block.number);
        log('project', { block: block.number, mint: target.mint, ...state, token: target.token, deployedToken: state.token });
        const participants = await Promise.all(cfg.watchWallets.map(async w =>
          ({ wallet: w.address, ...await inspectParticipant(provider, target, w.address, block.number) })));
        for (const participant of participants) log('participant', { mint: target.mint, ...participant });
      }
      return;
    }
    if (command === 'discover') {
      const n = int(Number(flags.blocks ?? '3000'), '--blocks', 1, 50000);
      const head = await provider.getBlockNumber();
      const projects = await discoverProjects(provider, Math.max(0, head - n + 1), head);
      for (const project of projects) log('discovered', project);
      log('discover_done', { head, blocks: n, count: projects.length });
      return;
    }
    if (command === 'quote') {
      if (!cfg.snipe) throw new Error('quote 需要配置至少一个 buyOnLaunch 项目及 snipe 参数');
      const token = flags.token && address(flags.token, '--token');
      const block = await provider.getBlock('latest');
      const wallet = flags.wallet ? address(flags.wallet, '--wallet') : '0x000000000000000000000000000000000000dEaD';
      const targets = cfg.targets.filter(t => token ? t.token === token : t.buyOnLaunch);
      if (!targets.length) throw new Error('未在配置中找到 Token');
      let successes = 0;
      for (const target of targets) {
        const state = await inspectMint(provider, target, block.number);
        if (!state.launched) {
          log('quote_skipped', { token: target.token, reason: '未开盘' });
          continue;
        }
        const trade = snipeSettingsForTarget(cfg.snipe, target);
        if (trade.quoteToken && !flags.wallet) throw new Error('ERC-20 买卖模拟请用 --wallet 指定有支付币余额和 Router 额度的公开地址');
        if (trade.quoteToken && state.quoteDecimals !== trade.quoteDecimals) throw new Error('支付币精度与配置不符');
        const market = await readMarket(provider, target, state, trade, block);
        await verifyRoundTrip(provider, market, wallet, trade, block, { fundSimulation: !trade.quoteToken });
        log('quote_simulated', { token: target.token, wallet, amountIn: trade.amountIn, valueWei: trade.quoteToken ? 0n : trade.amountIn,
          ...market, historicalQuoteOnly: true });
        successes++;
      }
      if (!successes) throw new Error('没有已开盘项目可模拟');
      return;
    }

    const live = Boolean(flags.live);
    const wallets = live ? await loadWallets(provider, cfg.walletFile) : cfg.watchWallets;
    if (live) await confirmLive(cfg, wallets, checkBudget(cfg, wallets));
    const stop = new AbortController();
    const { signal } = stop;
    const shutdown = () => stop.abort();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    let watching = false;
    try {
      execute = await makeExecutor({ provider, wallets, live, signal, maxGasPriceWei: cfg.maxGasPriceWei, gasLimitCap: cfg.gasLimitCap,
        journalPath: cfg.journalPath, confirmations: 3, receiptTimeoutMs: 1500 });
      if (live) await prepareQuoteAllowances({ provider, cfg, wallets, execute, signal, log });
      const armBlock = await provider.getBlockNumber();
      if (signal.aborted) return;
      watching = true;
      log('watch_started', { chainId: Number(CHAIN_ID), armBlock, live, wallets: wallets.map(w => w.address),
        message: !wallets.length ? '无 watchWallets，只读监控，不模拟钱包操作' : undefined });
      if (live && execute.reconcile) {
        // Check prior reservations without recreating or sending anything.
        const seen = new Set();
        const pendingResults = await Promise.allSettled(wallets.map(async wallet => {
          if (signal.aborted) return;
          const row = await execute.reconcilePending?.(wallet);
          if (row) {
            const [, mint, kind] = row.actionId.split(':');
            seen.add(row.wallet + ':' + row.actionId);
            log('journal', { action: kind, mint, ...row });
          }
        }));
        if (!signal.aborted && pendingResults.some(result => result.status === 'rejected')) {
          log('rpc_error', { error: '暂未核对部分钱包的历史交易；不会重新提交未决交易。' });
        }
        for (const wallet of wallets) {
          for (const target of cfg.targets) {
            for (const kind of ['mint', 'claim', 'buy']) {
              if (signal.aborted) return;
              const id = actionId(kind, target);
              if (seen.has(wallet.address + ':' + id)) continue;
              try {
                const r = await execute.reconcile(id, wallet);
                if (r) log('journal', { action: kind, mint: target.mint, ...r });
              } catch (error) {
                if (!signal.aborted) log('rpc_error', { error: shortError(error) });
              }
            }
          }
        }
      }
      const tick = makeMonitor({ provider, cfg, wallets, execute, armBlock, signal, log });
      if (flags.once) return await tick();
      while (!signal.aborted) {
        try { await tick(); } catch (e) { if (!signal.aborted) log('rpc_error', { error: shortError(e) }); }
        try { await delay(cfg.pollMs, undefined, { signal }); } catch (e) {
          if (!signal.aborted) throw e;
        }
      }
    } catch (e) {
      if (!signal.aborted) throw e;
    } finally {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      if (watching && !flags.once) log('watch_stopped', {});
    }
  } finally {
    try { execute?.close?.(); } finally { provider.destroy(); }
  }
}

main().catch(e => {
  console.error(shortError(e));
  process.exitCode = 1;
});
