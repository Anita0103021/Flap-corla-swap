import { setTimeout as delay } from 'node:timers/promises';
import { actionId, shortError } from './monitor.mjs';
import { decodePendingMint, makePendingTransactionFeed } from './pending-mint-shadow.mjs';
import { buildPreopenBuyPlan } from './snipe-preopen.mjs';

const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const nowMs = () => performance.now();
const PREOPEN_BLOCKS = 3;
const POLL_MS = 220;
const SERIES_MS = 4800;
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
  const owners = new Map(), work = new Map(), candidateTimes = new Map(), measured = new Set(), lastPlan = new Map();
  const pendingReceipts = new Map(), activeSeries = new Set();
  const confirmedMints = new Set();
  const targets = new Map((prepared.pendingTargets ?? []).map(t => [lower(t.mint), t]));
  let feed, closed = false, pendingMode = 'idle', receiptTimer, receiptCheck;
  const ended = () => closed || signal.aborted;

  function noteConfirmed(candidate, seen) {
    confirmedMints.add(lower(candidate.mint));
    if (!targets.has(lower(candidate.mint))) return;
    const id = candidateKey(candidate.mint, candidate.txHash);
    if (measured.has(id) || measured.size >= 256) return;
    measured.add(id);
    const at = candidateTimes.get(id);
    const match = typeof at === 'number' && seen >= at;
    log('snipe_pending_match', { mint: candidate.mint, token: candidate.token, launchTx: candidate.txHash,
      launchBlock: candidate.blockNumber, source: candidate.source, pendingMode, matchedPending: match,
      ...(match ? { pendingTxHash: candidate.txHash, leadMs: Math.round(seen - at) } : {}) });
  }

  async function series({ target, wallet, request, raceMode, details }) {
    const owner = key(target, wallet);
    activeSeries.add(owner);
    const expires = svc.nowMs() + SERIES_MS;
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
      const outerBroadcast = request.onBroadcast;
      let staged = false;
      last = await execute.race({ ...request, maxAttempts, onBroadcast(stage, meta) {
        if (stage === 'send') {
          staged = true;
          log('snipe_race_attempt', { ...report, ...meta, status: 'submitting' });
        }
        outerBroadcast?.(stage, meta);
      } });
      record(last);
      // If it was already accepted, an RPC outage or stop only leads to
      // receipt polling, never a fresh nonce / replacement.
      while (last?.status === 'pending' && last.attempt > 0 && !ended() && svc.nowMs() < expires) {
        try { await svc.delay(POLL_MS, undefined, { signal }); }
        catch { return last; }
        if (ended()) return last;
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
    const alreadyOpened = () => settings.requirePreopen && confirmedMints.has(lower(target.mint));
    const head = await provider.getBlock('latest');
    if (ended() || alreadyOpened() || !head || head.number < prepared.armBlock) return;
    await Promise.allSettled(prepared.wallets.map(async wallet => {
      const id = key(target, wallet);
      if (ended() || alreadyOpened() || owners.has(id)) return;
      let plan;
      try { plan = await svc.buildPreopenBuyPlan(provider, target, pending, wallet, settings, head, { signal }); }
      catch (e) {
        if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending',
          pendingTxHash: pending.hash, error: shortError(e) });
        return;
      }
      if (ended() || alreadyOpened() || owners.has(id)) return;
      owners.set(id, 'pending');
      const details = { pendingTxHash: plan.pendingHash ?? pending.hash, quoteBlock: plan.quoteBlock,
        amountOutMin: plan.amountOutMin, openingNetOut: plan.openingNetOut, quotedNetOut: plan.quotedNetOut,
        openingAmountOutMin: plan.openingAmountOutMin, maxOpeningPremiumBps: plan.maxOpeningPremiumBps,
        gasEstimate: plan.gasEstimate, quoteMs: Math.round(svc.nowMs() - seen) };
      log('snipe_race_mode', { ...details, mint: target.mint, token: target.token, raceMode: 'pending', maxAttempts });
      try {
        await series({ target, wallet, raceMode: 'pending', details, request: {
          actionId: actionId('buy', target), wallet, tx: plan.tx, gasEstimate: plan.gasEstimate, preopenPlan: plan,
          beforeSign: async () => {
            const skipAfterLaunch = () => { throw new Error('已开盘；「没抢到开盘就不追」已开启，不继续提交'); };
            if (alreadyOpened()) skipAfterLaunch();
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
            if (alreadyOpened()) skipAfterLaunch();
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

  function onPending(tx) {
    if (ended()) return;
    const match = decodePendingMint(tx, targets);
    if (!match) return;
    const target = targets.get(lower(match.mint));
    const id = candidateKey(match.mint, match.hash);
    const seen = svc.nowMs();
    if (candidateTimes.has(id)) return;
    if (candidateTimes.size >= 512) candidateTimes.delete(candidateTimes.keys().next().value);
    candidateTimes.set(id, seen);
    log('snipe_pending', { mint: target.mint, token: target.token, pendingTxHash: match.hash, pendingMode });
    const mint = lower(target.mint);
    if (!enabled || settings.requirePreopen && confirmedMints.has(mint) || work.has(mint) || seen - (lastPlan.get(mint) ?? -Infinity) < 300 ||
        prepared.wallets.every(wallet => owners.has(key(target, wallet)))) return;
    lastPlan.set(mint, seen);
    const job = preopen(target, tx, seen).catch(error => {
      if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending', error: shortError(error) });
    }).finally(() => work.delete(mint));
    work.set(mint, job);
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
      clearInterval(receiptTimer);
      feed?.close();
      await Promise.allSettled([...work.values(), receiptCheck].filter(Boolean));
    },
  };
}
