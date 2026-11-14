import { setTimeout as delay } from 'node:timers/promises';
import { actionId, shortError } from './monitor.mjs';
import { decodePendingMint, makePendingTransactionFeed } from './pending-mint-shadow.mjs';
import { buildPreopenBuyPlan } from './snipe-preopen.mjs';
import { snipeSettingsForTarget } from './config.mjs';
import { ROUTER } from './market.mjs';
import { readQuoteDecimals, requireQuoteFunds } from './quote-assets.mjs';

const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const nowMs = () => performance.now();
const PREOPEN_BLOCKS = 3;
const POLL_MS = 220;
const PENDING_BACKLOG = 2;
const QUEUED_PENDING_MAX_AGE_MS = 2_500;
export const SNIPE_RACE_WINDOW_MS = 4_800;
const key = (target, wallet) => lower(target.mint) + ':' + lower(wallet.address);
const candidateKey = (mint, hash) => lower(mint) + ':' + lower(hash);

// The confirmed and pending paths share an in-process owner as well as the
// executor's cross-process journal. Never let a confirmed quote replace the
// original price floor after a speculative sequence has started.
export function makeSnipeRace({ provider, prepared, settings, execute, signal, log, services = {} }) {
  const svc = { buildPreopenBuyPlan, makePendingTransactionFeed, delay, nowMs, ...services };
  const maxAttempts = settings.repeatAttempts ?? 1;
  const enabled = maxAttempts > 1;
  if (settings.requirePreopen && !enabled) throw new Error('只走提前狙击需要限次竞争模式');
  if (enabled && (typeof execute.race !== 'function' || typeof execute.raceStatus !== 'function')) {
    throw new Error('当前执行器不支持限次竞争，请改用单次模式');
  }
  const owners = new Map(), work = new Map(), queued = new Map(), candidateTimes = new Map(), measured = new Set();
  const pendingReceipts = new Map(), activeSeries = new Set();
  const confirmedMints = new Set();
  const targets = new Map((prepared.pendingTargets ?? []).map(t => [lower(t.mint), t]));
  let feed, closed = false, pendingMode = 'idle', receiptTimer, receiptCheck;
  const ended = () => closed || signal.aborted;

  function noteConfirmed(candidate, seen) {
    const mint = lower(candidate.mint);
    confirmedMints.add(mint);
    queued.delete(mint);
    if (!targets.has(mint)) return;
    const id = candidateKey(candidate.mint, candidate.txHash);
    if (measured.has(id) || measured.size >= 256) return;
    measured.add(id);
    const at = candidateTimes.get(id);
    const match = at && seen >= at.seen;
    log('snipe_pending_match', { mint: candidate.mint, token: candidate.token, launchTx: candidate.txHash,
      launchBlock: candidate.blockNumber, source: candidate.source, pendingMode, matchedPending: Boolean(match),
      ...(match ? { pendingTxHash: candidate.txHash, pendingReceivedAtMs: at.receivedAtMs,
        leadMs: Math.round(seen - at.seen) } : {}) });
  }

  async function series({ target, wallet, request, raceMode, details, checkOpening }) {
    const owner = key(target, wallet);
    activeSeries.add(owner);
    const expires = svc.nowMs() + SNIPE_RACE_WINDOW_MS;
    const beforeDispatch = () => {
      checkOpening?.();
      signal.throwIfAborted();
      if (closed || svc.nowMs() >= expires) throw new Error('发单窗口已结束；未发送');
    };
    const report = { ...details, raceMode, maxAttempts, mint: target.mint, token: target.token };
    let last, fingerprint;
    function record(result) {
      const f = [result?.attempt, result?.status, result?.txHash, result?.receiptBlock].join(':');
      if (!result || f === fingerprint) return;
      fingerprint = f;
      log('snipe_race_outcome', { ...report, ...result });
      if (raceMode === 'pending') {
        if (result.status === 'pending' && result.attempt > 0 && result.txHash) {
          pendingReceipts.set(owner, { report, result, wallet });
        } else pendingReceipts.delete(owner);
      }
    }
    // The executor independently enforces the persisted cap. The local cap
    // also bounds work if a terminal status changes during reconciliation.
    try {
      for (let i = 0; i < maxAttempts && !ended() && svc.nowMs() < expires; i++) {
        let staged = false;
        last = await execute.race({ ...request, maxAttempts, beforeDispatch, async beforeSign() {
          beforeDispatch();
          await request.beforeSign?.();
          beforeDispatch();
        }, onBroadcast(stage, meta) {
          if (stage === 'send') {
            staged = true;
            log('snipe_race_attempt', { ...report, ...meta, status: 'submitting' });
          }
          request.onBroadcast?.(stage, meta);
        } });
        record(last);
        // An accepted or ambiguous order only leads to receipt polling,
        // never a fresh nonce / replacement.
        while (last?.status === 'pending' && last.attempt > 0 && !ended() && svc.nowMs() < expires) {
          try { await svc.delay(POLL_MS, undefined, { signal }); }
          catch { return last; }
          if (ended() || svc.nowMs() >= expires) return last;
          let current;
          try { current = await execute.raceStatus(request.actionId, wallet); }
          catch { return last; }
          if (!current || current.attempt !== last.attempt) return last;
          last = current;
          record(last);
        }
        if (!last || last.attempt < 1 || last.attempt >= maxAttempts || !['failed', 'skipped'].includes(last.status)) return last;
        if (!staged && last.status === 'skipped' && !last.attemptActionId) return last;
      }
      return last;
    } finally { activeSeries.delete(owner); }
  }

  async function followPending() {
    if (ended()) return;
    await Promise.allSettled([...pendingReceipts].slice(0, 16).map(async ([owner, entry]) => {
      if (activeSeries.has(owner)) return;
      const result = await execute.raceStatus(entry.result.actionId, entry.wallet);
      if (ended() || !result || pendingReceipts.get(owner) !== entry || result.attempt !== entry.result.attempt) return;
      if (result.status !== 'pending') pendingReceipts.delete(owner);
      if (result.status !== entry.result.status || result.receiptBlock !== entry.result.receiptBlock) {
        entry.result = result;
        log('snipe_race_outcome', { ...entry.report, ...result });
      }
    }));
  }

  async function runConfirmed({ target, wallet, request, details }) {
    if (settings.requirePreopen) return null;
    if (!enabled) return execute(request);
    const id = key(target, wallet);
    if (owners.has(id)) return null;
    owners.set(id, 'confirmed');
    log('snipe_race_mode', { ...details, mint: target.mint, token: target.token, raceMode: 'confirmed', maxAttempts });
    return series({ target, wallet, request, raceMode: 'confirmed', details });
  }

  async function preopen(target, pending, seen) {
    const trade = snipeSettingsForTarget(settings, target);
    const confirmed = () => confirmedMints.has(lower(target.mint));
    const skipAfterLaunch = () => { throw new Error('已开盘；「没抢到开盘就不追」已开启，不继续提交'); };
    const checkOpening = () => { if (settings.requirePreopen && confirmed()) skipAfterLaunch(); };
    const head = await provider.getBlock('latest');
    if (ended() || confirmed() || !head || head.number < prepared.armBlock) return;
    await Promise.allSettled(prepared.wallets.map(async wallet => {
      const id = key(target, wallet);
      if (ended() || confirmed() || owners.has(id)) return;
      let plan;
      try { plan = await svc.buildPreopenBuyPlan(provider, target, pending, wallet, trade, head, { signal }); }
      catch (e) {
        if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending',
          pendingTxHash: pending.hash, error: shortError(e) });
        return;
      }
      if (ended() || confirmed() || owners.has(id)) return;
      owners.set(id, 'pending');
      const details = { pendingTxHash: plan.pendingHash ?? pending.hash, quoteBlock: plan.quoteBlock,
        amountOutMin: plan.amountOutMin, openingNetOut: plan.openingNetOut, quotedNetOut: plan.quotedNetOut,
        openingAmountOutMin: plan.openingAmountOutMin, maxOpeningPremiumBps: plan.maxOpeningPremiumBps,
        ...(target.snipeQuote ? { quoteToken: trade.quoteToken, amountIn: trade.amountIn } : {}),
        gasEstimate: plan.gasEstimate, quoteMs: Math.round(svc.nowMs() - seen) };
      log('snipe_race_mode', { ...details, mint: target.mint, token: target.token, raceMode: 'pending', maxAttempts });
      try {
        await series({ target, wallet, raceMode: 'pending', details, checkOpening, request: {
          actionId: actionId('buy', target), wallet, tx: plan.tx, gasEstimate: plan.gasEstimate, preopenPlan: plan,
          quoteToken: trade.quoteToken,
          beforeSign: async () => {
            const [parent, latest] = await Promise.all([provider.getBlock(plan.quoteBlock), provider.getBlock('latest')]);
            signal.throwIfAborted();
            if (!parent || !latest || lower(parent.hash) !== lower(plan.quoteBlockHash) ||
                latest.number < plan.quoteBlock || latest.number - plan.quoteBlock > PREOPEN_BLOCKS ||
                latest.timestamp + 2 >= plan.deadline) throw new Error('提前发单的模拟区块已过期或重组；未发送');
            if (latest.number > plan.quoteBlock) {
              // A pool already created in a newer block must satisfy the
              // original minOut at that state. Never chase by re-quoting.
              const code = await provider.getCode(target.token, latest.number);
              if (code !== '0x') {
                if (settings.requirePreopen) skipAfterLaunch();
                await provider.call({ ...plan.tx, from: wallet.address, blockTag: latest.number });
              }
            }
            if (target.snipeQuote) {
              const [decimals] = await Promise.all([
                readQuoteDecimals(provider, trade.quoteToken, latest.number),
                requireQuoteFunds(provider, trade.quoteToken, wallet.address, ROUTER, trade.amountIn, latest.number),
              ]);
              if (decimals !== trade.quoteDecimals) throw new Error('买入支付币精度已变化；未发送');
            }
            signal.throwIfAborted();
          },
          onBroadcast: (stage, meta) => log(stage === 'send' ? 'snipe_send' : 'snipe_ack',
            { ...details, ...meta, raceMode: 'pending', mint: target.mint, token: target.token, wallet: wallet.address,
              elapsedMs: Math.round(svc.nowMs() - seen) }),
        } });
      } catch (e) {
        if (!ended()) log('buy_skipped', { ...details, mint: target.mint, token: target.token, raceMode: 'pending', error: shortError(e) });
      }
    }));
  }

  function drainPending(target, mint) {
    if (work.has(mint)) return;
    const items = queued.get(mint);
    if (!items) return;
    let next;
    if (!ended() && !confirmedMints.has(mint) && !prepared.wallets.every(wallet => owners.has(key(target, wallet)))) {
      const now = svc.nowMs();
      do { next = items.shift(); } while (next && now - next.seen > QUEUED_PENDING_MAX_AGE_MS);
    }
    if (!next || !items.length) queued.delete(mint);
    if (!next) return;
    const job = preopen(target, next.tx, next.seen).catch(error => {
      if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending', error: shortError(error) });
    }).finally(() => {
      work.delete(mint);
      drainPending(target, mint);
    });
    work.set(mint, job);
  }

  function onPending(tx, arrival) {
    if (ended()) return;
    const seen = Number.isFinite(arrival?.seen) ? arrival.seen : svc.nowMs();
    const receivedAtMs = Number.isSafeInteger(arrival?.receivedAtMs) ? arrival.receivedAtMs : Date.now();
    const match = decodePendingMint(tx, targets);
    if (!match) return;
    const target = targets.get(lower(match.mint));
    const id = candidateKey(match.mint, match.hash);
    if (candidateTimes.has(id)) return;
    if (candidateTimes.size >= 512) candidateTimes.delete(candidateTimes.keys().next().value);
    candidateTimes.set(id, { seen, receivedAtMs });
    // Done before inspecting the parent, simulating or submitting an order.
    const frameMode = arrival?.mode === 'full' || arrival?.mode === 'mixed' ? arrival.mode : pendingMode;
    log('snipe_pending', { mint: target.mint, token: target.token, pendingTxHash: match.hash, pendingMode: frameMode,
      pendingReceivedAtMs: receivedAtMs });
    const mint = lower(target.mint);
    if (!enabled || confirmedMints.has(mint) ||
        prepared.wallets.every(wallet => owners.has(key(target, wallet)))) return;
    // A previous Mint may still be in read-only validation when the next
    // one arrives. Keep the newest few candidates rather than losing them
    // to a fixed cooldown; every candidate must still pass the same proof.
    const items = queued.get(mint) ?? [];
    while (items.length >= PENDING_BACKLOG) items.shift();
    items.push({ tx, seen });
    queued.set(mint, items);
    drainPending(target, mint);
  }

  return {
    enabled, noteConfirmed, runConfirmed,
    isOwned: (target, wallet) => owners.has(key(target, wallet)),
    start() {
      if (enabled && !receiptTimer && !ended()) {
        receiptTimer = setInterval(() => {
          if (!receiptCheck && pendingReceipts.size) receiptCheck = followPending().finally(() => { receiptCheck = undefined; });
        }, 900);
        receiptTimer.unref();
      }
      if (ended() || !targets.size || prepared.observePending === false) return;
      const wsUrl = prepared.pendingWsUrl ?? process.env.BSC_PENDING_WSS_URL ?? 'wss://bsc-rpc.publicnode.com';
      try {
        feed = svc.makePendingTransactionFeed({ wsUrl, signal, onTransaction: onPending, onStatus: fields => {
          pendingMode = fields.mode;
          if (!ended()) log('snipe_pending_feed', { pendingMode });
        } });
        feed.start();
      } catch {
        pendingMode = 'unavailable';
        log('snipe_pending_feed', { pendingMode, message: settings.requirePreopen ?
          '待打包订阅不可用；不追价模式不会提交确认后买单' : '待打包订阅不可用；仅使用已开盘信号' });
      }
    },
    async close() {
      closed = true;
      queued.clear();
      clearInterval(receiptTimer);
      feed?.close();
      await Promise.allSettled([...work.values(), receiptCheck].filter(Boolean));
    },
  };
}
