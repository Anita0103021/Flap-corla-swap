import { setTimeout as sleep } from 'node:timers/promises';
import { toQuantity, ZeroAddress } from 'ethers';
import { createCorlaInspectionScope, inspectMint, isCorlaFundingClosed, requireCorlaPool, verifySnipeState } from './corla.mjs';
import { isRpcLimit, verifyLaunchCandidate } from './events.mjs';
import { makeLaunchFeed } from './launch-feed.mjs';
import { applyOpeningPriceGuard, buildBuy, readMarket, readOpeningBuyTax, ROUTER, verifyRoundTrip } from './market.mjs';
import { readSnipeMarket, warmSnipeMarket } from './snipe-market.mjs';
import { makeSnipeRace } from './snipe-race.mjs';
import { actionId, BuySnapshotGuardError, LEGACY_RECEIPT_WATCH_MS, launchSearchBounds, makeJournalHistoryPoller, shortError, verifyBuySnapshot } from './monitor.mjs';
import { rpcPoolPlan } from './rpc-config.mjs';
import { snipeSettingsForTarget } from './config.mjs';
import { quoteAsset, readQuoteDecimals, requireQuoteFunds } from './quote-assets.mjs';

const lower = address => address?.toLowerCase();
const ms = since => Math.round(performance.now() - since);
const abortWait = signal => new Promise(ok => {
  if (signal.aborted) ok();
  else signal.addEventListener('abort', ok, { once: true });
});
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const read = result => { if ('error' in result) throw result.error; return result.value; };
function measure(times, key, task) {
  const started = performance.now();
  return settle(Promise.resolve().then(task)).then(result => {
    times[key] = ms(started);
    return result;
  });
}
const retryableProof = error => error instanceof BuySnapshotGuardError ? error.retryable :
  ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(error?.code) || isRpcLimit(error);
const finished = status => ['confirmed', 'failed', 'simulated'].includes(status);

export function snipeWsUrl(rpcUrl, override = process.env.BSC_WSS_URL) {
  if (override) {
    try { if (new URL(override).protocol === 'wss:') return override; } catch { /* fail with a safe message */ }
    throw new Error('BSC_WSS_URL 必须使用 wss://');
  }
  const url = new URL(rpcUrl);
  return url.origin === 'https://bsc-rpc.publicnode.com' && url.pathname === '/' && !url.search &&
    !url.username && !url.password ? 'wss://bsc-rpc.publicnode.com' : undefined;
}

export function resolveSnipeEndpoints(rpcUrl, env = process.env) {
  const cfg = { rpcUrl, rpcCustom: Boolean(env.BSC_RPC_URL) };
  const [watchUrl] = rpcPoolPlan(cfg, 'watch', env).urls;
  const [executionUrl] = rpcPoolPlan(cfg, 'snipe', env).urls;
  return { watchUrl, executionUrl, wsUrl: snipeWsUrl(watchUrl, env.BSC_WSS_URL || '') };
}

async function probeSimulation(provider, height) {
  let result;
  try {
    result = await provider.send('eth_simulateV1', [{
      blockStateCalls: [{ calls: [{ from: '0x000000000000000000000000000000000000dEaD',
        to: '0x0000000000000000000000000000000000000004', data: '0x' }] }],
      validation: false,
    }, toQuantity(height)]);
  } catch { throw new Error('当前 BSC RPC 不支持买卖检查所需的 eth_simulateV1'); }
  if (result?.[0]?.calls?.[0]?.status !== '0x1') throw new Error('当前 BSC RPC 返回了不可用的交易模拟结果');
}

// Before taking a WebSocket event as a trigger, validate every explicit target
// on the same arming block. This is deliberately outside the launch hot path.
export async function prepareSnipe({ provider, watchProvider = provider, cfg, wallets, log, signal, services = {} }) {
  const svc = { inspectMint, probeSimulation, warmSnipeMarket, ...services };
  const [head, watchHeight] = await Promise.all([
    provider.getBlock('latest'), watchProvider === provider ? null : watchProvider.getBlockNumber(),
  ]);
  if (!head || !Number.isSafeInteger(head.number) || (watchHeight !== null && !Number.isSafeInteger(watchHeight))) {
    throw new Error('无法读取 BSC 启动区块');
  }
  const armBlock = Math.max(head.number, watchHeight ?? head.number);
  signal.throwIfAborted();
  // Multicall capability is prepared in parallel with existing arming reads.
  // Its absence is not a startup failure and never delays the first signal.
  if (services.warmSnipeMarket || typeof provider.getCode === 'function') {
    void Promise.resolve().then(() => svc.warmSnipeMarket(provider, head)).catch(() => {});
  }
  const scope = createCorlaInspectionScope(provider, head.number);
  const pendingTargets = [];
  const examined = await Promise.all(cfg.targets.map(async target => {
    try {
      const state = await svc.inspectMint(provider, target, head.number, scope);
      if (signal.aborted) return null;
      log('project', { ...state, block: head.number, mint: target.mint, token: target.token, deployedToken: state.token });
      if (isCorlaFundingClosed(state) ||
          (Number.isSafeInteger(head.timestamp) && state.fundingDeadline <= BigInt(head.timestamp))) return null;
      requireCorlaPool(state);
      const quoteToken = quoteAsset(state.quoteToken);
      const quote = target.snipeQuote;
      if (quoteToken !== quoteAsset(quote?.quoteToken) || (quote && quote.quoteDecimals !== state.quoteDecimals)) {
        throw new Error('狙击支付币或精度与已确认配置不同，请重新配置项目');
      }
      const armed = quote ? { ...target, quoteToken, deploymentKey: state.deploymentKey } : target;
      if (state.phase === 1 && typeof state.pricePerLot === 'bigint' && state.pricePerLot > 0n) {
        pendingTargets.push({ ...armed, pricePerLot: state.pricePerLot });
      }
      return armed;
    } catch (e) {
      if (signal.aborted) return null;
      log('project_error', { mint: target.mint, error: shortError(e) });
      return null;
    }
  }));
  signal.throwIfAborted();
  const targets = examined.filter(Boolean);
  if (!targets.length) throw new Error('狙击名单没有已通过合约核验且尚未开盘的目标');
  const selected = wallets.slice(0, cfg.snipe.walletCount);
  if (!selected.length) throw new Error('没有可用的狙击钱包');
  await svc.probeSimulation(provider, head.number);
  signal.throwIfAborted();
  return { targets, pendingTargets, wallets: selected, armBlock, wsUrl: snipeWsUrl(cfg.rpcUrl) };
}

export function makeFastSnipe({ provider, watchProvider = provider, settings, prepared, execute, signal, log, services = {} }) {
  const svc = { verifyLaunchCandidate, verifySnipeState, buildBuy, readMarket, readOpeningBuyTax, verifyRoundTrip, makeLaunchFeed, ...services };
  const combinedMarket = services.readSnipeMarket ??
    (services.readMarket || services.verifySnipeState ? null : readSnipeMarket);
  const targetMap = new Map(prepared.targets.map(target => [lower(target.mint), target]));
  const race = makeSnipeRace({ provider, prepared, settings, execute, signal, log, services: services.race });
  // The first proven launch consumes the opportunity for this entire project
  // (one attempt per selected wallet), even if quoting/simulation refuses it.
  const attempted = new Set();
  const awaiting = new Map();
  const recent = new Map();
  const reported = new Map();
  const inFlight = new Map();
  const warmChecks = new Set();
  const removed = new Set();
  const pollHistory = makeJournalHistoryPoller({ execute, signal, log });
  let receiptCheck;
  let stopped = false;
  const ended = () => stopped || signal.aborted;

  function noteResult(result, wallet, target, details) {
    const id = actionId('buy', target);
    const key = id + ':' + wallet.address;
    const pending = result.status === 'pending';
    if (pending) awaiting.set(wallet.address, { id: result.actionId ?? id, target, wallet, details });
    if (result.actionId && result.actionId !== id) {
      log('buy_skipped', { ...details, token: target.token, wallet: wallet.address,
        error: '该钱包有其他交易待确认，本次未发送' });
      return;
    }
    if (pending) recent.delete(key);
    if (finished(result.status)) {
      if (awaiting.get(wallet.address)?.id === id) awaiting.delete(wallet.address);
      const until = recent.get(key)?.until ?? Date.now() + LEGACY_RECEIPT_WATCH_MS;
      recent.delete(key);
      if (execute.reconcile && result.status !== 'simulated' && result.txHash && result.receiptStable !== true) {
        recent.set(key, { id, target, wallet, details, until: result.receiptStable === false ? Infinity : until });
      }
    }
    const fingerprint = [result.status, result.txHash, result.reason, result.receiptStable, result.receiptBlock].join(':');
    if (reported.get(key) !== fingerprint) {
      reported.set(key, fingerprint);
      log('buy', { mint: target.mint, token: target.token, ...details, ...result });
    }
  }
  const inclusion = c => lower(c.blockHash) + ':' + lower(c.txHash);
  function onRemoved(candidate) {
    removed.add(inclusion(candidate));
    if (removed.size > 128) removed.delete(removed.values().next().value);
  }
  async function refreshReceipts() {
    if (ended()) return;
    const selected = new Set(awaiting.keys());
    const rechecks = [];
    for (const [key, entry] of recent) {
      if (entry.until <= Date.now()) recent.delete(key);
      else if (!selected.has(entry.wallet.address)) {
        selected.add(entry.wallet.address);
        rechecks.push([key, entry]);
      }
    }
    const exact = execute.reconcile ? [...awaiting.values()].map(async entry => {
      const { id, target, wallet, details } = entry;
      try {
        const result = await (race.enabled && target && id === actionId('buy', target) ?
          execute.raceStatus(id, wallet) : execute.reconcile(id, wallet));
        if (!result || result.actionId !== id || awaiting.get(wallet.address) !== entry) return;
        if (finished(result.status)) awaiting.delete(wallet.address);
        if (target && id === actionId('buy', target)) noteResult(result, wallet, target, details);
      } catch { /* Keep unresolved reservations; never replace a transaction. */ }
    }).concat(rechecks.map(async ([key, entry]) => {
      const { id, target, wallet, details } = entry;
      const result = await (race.enabled && target && id === actionId('buy', target) ?
        execute.raceStatus(id, wallet) : execute.reconcile(id, wallet));
      if (!result || result.actionId !== id || recent.get(key) !== entry || awaiting.has(wallet.address)) return;
      if (result.status === 'pending' || finished(result.status)) noteResult(result, wallet, target, details);
    })) : [];
    // Watch persisted immature receipts after a restart, without putting the
    // work on the candidate callback or rechecking wallets just handled above.
    const history = !inFlight.size && pollHistory?.(prepared.wallets.filter(wallet => !selected.has(wallet.address)));
    await Promise.allSettled([...exact, history].filter(Boolean));
  }

  async function seedPending() {
    if (!execute.reconcilePending || ended()) return;
    await Promise.allSettled(prepared.wallets.map(async wallet => {
      const result = await execute.reconcilePending(wallet);
      if (ended() || awaiting.has(wallet.address) || !result?.actionId || result.status !== 'pending' || !result.txHash) return;
      const target = prepared.targets.find(row => actionId('buy', row) === result.actionId);
      if (target) noteResult(result, wallet, target, {});
      else awaiting.set(wallet.address, { id: result.actionId, wallet });
    }));
  }
  function prepareWallets() {
    const wallets = new Map();
    if (typeof execute.prepare !== 'function') return wallets;
    for (const wallet of prepared.wallets) {
      if (ended() || awaiting.has(wallet.address)) continue;
      const started = performance.now();
      try {
        const result = execute.prepare({ wallet, signal });
        if (!result) continue;
        const entry = { result };
        // Observe rejection without replacing the executor's opaque preparation
        // Promise. A failed preparation only loses the speed-up.
        const observed = Promise.resolve(result).then(() => {}, () => {}).finally(() => {
          entry.walletPrepMs = ms(started);
          warmChecks.delete(observed);
        });
        warmChecks.add(observed);
        wallets.set(wallet.address, entry);
      } catch { /* The ordinary guarded executor remains the fallback. */ }
    }
    return wallets;
  }
  async function place(candidate, target, seen, key, quoteTelemetry) {
    const trade = snipeSettingsForTarget(settings, target);
    const settingsBlock = prepared.armBlock;
    const wallets = settings.requirePreopen ? new Map() : prepareWallets();
    let head, proof, market;
    // A WSS gateway may be a block ahead of the HTTP endpoint, or the HTTP
    // receipt index may briefly lag the header. Recheck within a small bound.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ended() || removed.has(inclusion(candidate))) return;
      const times = {};
      const evidence = measure(times, 'proofMs', () => svc.verifyLaunchCandidate(provider, candidate));
      head = read(await measure(times, 'headMs', () => provider.getBlock('latest')));
      if (ended() || removed.has(inclusion(candidate))) return;
      if (head?.number >= candidate.blockNumber) {
        const bounds = launchSearchBounds(settingsBlock, head.number, settings.windowBlocks);
        if (!bounds || candidate.blockNumber < bounds[0]) return;
        const [r, m, s, tax] = await Promise.all([
          evidence,
          settings.requirePreopen ? null : measure(times, 'marketMs', () => combinedMarket
            ? combinedMarket(provider, target, candidate.pool, trade, head)
            : svc.readMarket(provider, target, { launched: true, pool: candidate.pool }, trade, head)),
          settings.requirePreopen || combinedMarket ? null :
            measure(times, 'stateMs', () => svc.verifySnipeState(provider, target, candidate.pool, head.number)),
          settings.requirePreopen ? null : measure(times, 'openingTaxMs', () =>
            svc.readOpeningBuyTax(provider, target.token, candidate.blockNumber)),
        ]);
        Object.assign(quoteTelemetry, times, { quoteMs: ms(seen), seenBlock: head.number });
        const verified = read(r);
        if (verified) {
          if (ended() || removed.has(inclusion(candidate))) return;
          // Receipt indexing can be retried before this point. After a
          // canonical launch is proven, no later candidate may re-quote,
          // re-run preflight, re-sign or submit a second buy.
          attempted.add(key);
          race.noteConfirmed(candidate, seen);
          if (settings.requirePreopen) {
            if (prepared.wallets.some(wallet => !race.isOwned(target, wallet))) {
              log('buy_skipped', { ...quoteTelemetry, mint: target.mint, token: target.token, launchBlock: verified.blockNumber,
                launchTx: verified.txHash, error: '已开盘；「没抢到开盘就不追」已开启，不提交确认后买单' });
            }
            return;
          }
          if (s) read(s);
          market = applyOpeningPriceGuard(read(m), verified.openingReserves, read(tax), trade);
          proof = verified;
          break;
        }
      }
      if (attempt < 2) await sleep(140 + attempt * 80, undefined, { signal });
    }
    if (ended() || removed.has(inclusion(candidate))) return;
    if (!proof || !market) throw new BuySnapshotGuardError('暂未验证开盘回执或交易池；等待 RPC 同步', true);
    const id = actionId('buy', target);
    const details = { launchBlock: proof.blockNumber, launchTx: proof.txHash,
      pair: market.pair, amountOutMin: market.amountOutMin, quoted: market.quoted,
      openingNetOut: market.openingNetOut, quotedNetOut: market.quotedNetOut,
      openingAmountOutMin: market.openingAmountOutMin, maxOpeningPremiumBps: market.maxOpeningPremiumBps,
      ...(trade.quoteToken ? { quoteToken: trade.quoteToken, amountIn: trade.amountIn } : {}),
      signalSource: candidate.source, marketReadMode: market.readMode, ...quoteTelemetry };
    await Promise.all(prepared.wallets.map(async wallet => {
      if (ended() || (race.enabled && race.isOwned(target, wallet))) return;
      const warm = wallets.get(wallet.address);
      const orderTimes = {};
      const orderDetails = () => ({ ...details, ...orderTimes,
        ...(warm?.walletPrepMs !== undefined ? { walletPrepMs: warm.walletPrepMs } : {}) });
      const walletBusy = () => log('buy_skipped', { ...details, token: target.token, wallet: wallet.address,
        error: '该钱包有交易待确认，单次机会已跳过，不补单' });
      if (awaiting.has(wallet.address)) return walletBusy();
      let attemptedHash;
      try {
        const previous = race.enabled ? null : await execute.reconcile?.(id, wallet);
        if (previous) return noteResult(previous, wallet, target, orderDetails());
        if (ended() || removed.has(inclusion(candidate))) return;
        if (awaiting.has(wallet.address)) return walletBusy();
        const tx = svc.buildBuy(market, wallet.address, trade, head);
        // The same exact buy is simulated while executor obtains nonce/gas
        // and estimates. The pre-sign guard awaits BOTH the simulation and
        // canonical-block checks; no trade-off between safety and latency.
        const simulation = measure(orderTimes, 'simulationMs', () =>
          svc.verifyRoundTrip(provider, market, wallet.address, trade, head, { buyTx: tx }));
        const request = { actionId: id, wallet, tx, singleSubmission: true, quoteToken: trade.quoteToken,
          ...(warm ? { preparedWallet: warm.result } : {}),
          beforeSign: async () => {
            const [simulationResult, snapshot, decimals] = await Promise.all([
              simulation, measure(orderTimes, 'snapshotMs', () =>
                verifyBuySnapshot(provider, { launch: proof, quoteBlock: head, settings, armBlock: settingsBlock, signal })),
              trade.quoteToken && trade.quoteToken !== ZeroAddress ? readQuoteDecimals(provider, trade.quoteToken, 'latest') : null,
              trade.quoteToken && trade.quoteToken !== ZeroAddress ?
                requireQuoteFunds(provider, trade.quoteToken, wallet.address, ROUTER, trade.amountIn, 'latest') : null,
            ]);
            signal.throwIfAborted();
            if (removed.has(inclusion(candidate))) throw new Error('开盘事件已被链重组移除');
            read(snapshot);
            if (decimals !== null && decimals !== trade.quoteDecimals) throw new Error('买入支付币精度已变化；未发送');
            const simulated = read(simulationResult);
            if (simulated.to !== tx.to || simulated.data !== tx.data || simulated.value !== tx.value) {
              throw new Error('交易与买卖模拟不一致');
            }
          },
          onBroadcast: (stage, { txHash, walletChecksMs, preflightMs, preflightOverlapped, signMs,
            broadcastConcurrency, broadcastRpcCount }) => {
            if (stage === 'send') attemptedHash = txHash;
            for (const [name, value] of Object.entries({ walletChecksMs, preflightMs, signMs, broadcastConcurrency, broadcastRpcCount })) {
              if (Number.isFinite(value) && value >= 0) orderTimes[name] = value;
            }
            if (typeof preflightOverlapped === 'boolean') orderTimes.preflightOverlapped = preflightOverlapped;
            log(stage === 'send' ? 'snipe_send' : 'snipe_ack', {
              ...orderDetails(), token: target.token, wallet: wallet.address, txHash, elapsedMs: ms(seen),
            });
          },
        };
        const result = await race.runConfirmed({ target, wallet, request, details: orderDetails() });
        if (!result) return;
        // Reconciliation can return an already pending order without running
        // this order's guard. Preserve that reservation even if this order's
        // unused simulation failed in parallel.
        if (result.status === 'pending' || (result.actionId && result.actionId !== id)) {
          noteResult(result, wallet, target, orderDetails());
          await simulation;
          return;
        }
        // For injected/test executors without beforeSign, still await the
        // simulation before reporting an outcome. Production always uses it.
        read(await simulation);
        return noteResult(result, wallet, target, orderDetails());
      } catch (e) {
        if (signal.aborted && e === signal.reason) return;
        // The executor releases a staged reservation only with positive
        // evidence of non-submission. Never sign a replacement for an ambiguous buy.
        if (attemptedHash && e?.code !== 'TRANSACTION_NOT_SUBMITTED') {
          noteResult({ status: 'pending', actionId: id, wallet: wallet.address, txHash: attemptedHash,
            reason: '广播状态未知，等待回执，不重新发送' }, wallet, target, orderDetails());
          return;
        }
        if (!ended()) log('buy_skipped', { ...orderDetails(), token: target.token, wallet: wallet.address, error: shortError(e) });
      }
    }));
  }
  function onCandidate(candidate) {
    const target = targetMap.get(lower(candidate.mint));
    if (ended() || removed.has(inclusion(candidate)) || !target || lower(target.token) !== lower(candidate.token) || candidate.blockNumber <= prepared.armBlock) return;
    const key = lower(target.mint);
    if (attempted.has(key)) return;
    if (inFlight.has(key)) return false;
    const seen = performance.now();
    const quoteTelemetry = {};
    log('snipe_detected', { mint: target.mint, token: target.token, signalSource: candidate.source,
      launchBlock: candidate.blockNumber, launchTx: candidate.txHash, pool: candidate.pool, quoteToken: target.quoteToken });
    const task = place(candidate, target, seen, key, quoteTelemetry).catch(e => {
      if (ended()) return;
      if (!attempted.has(key) && retryableProof(e)) {
        log('snipe_feed', { transport: candidate.source, phase: 'retrying', message: '仅补查开盘回执，尚未尝试买入' });
        return false;
      }
      log('buy_skipped', { ...quoteTelemetry, ...e?.priceEvidence, mint: target.mint, token: target.token,
        launchBlock: candidate.blockNumber, launchTx: candidate.txHash, error: shortError(e) });
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  return async function run() {
    const feed = svc.makeLaunchFeed({ provider: watchProvider, targets: prepared.targets, armBlock: prepared.armBlock,
      windowBlocks: settings.windowBlocks, wsUrl: prepared.wsUrl, scanMs: settings.scanMs, signal, onCandidate, onRemoved,
      onStatus: status => { if (!ended()) log('snipe_feed', typeof status === 'string' ? { message: status } : status); } });
    let seed;
    const interval = setInterval(() => {
      if (!seed && !receiptCheck && (awaiting.size || recent.size || pollHistory)) {
        receiptCheck = refreshReceipts().finally(() => { receiptCheck = null; });
      }
    }, 850);
    try {
      await feed.start();
      race.start();
      // Starting the feed is never gated on reconciling prior reservations.
      seed = seedPending().finally(() => { seed = null; });
      await abortWait(signal);
    } finally {
      stopped = true;
      clearInterval(interval);
      try { await Promise.all([feed.close(), race.close()]); }
      finally { await Promise.allSettled([...inFlight.values(), ...warmChecks, receiptCheck, seed].filter(Boolean)); }
    }
  };
}
