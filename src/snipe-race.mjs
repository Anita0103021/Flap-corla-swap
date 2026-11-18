import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { actionId, shortError } from './monitor.mjs';
import { decodePendingMint, makePendingTransactionFeed, pendingWsSources } from './pending-mint-shadow.mjs';
import { buildPreopenBuyPlan, preparePreopenMintSequence, PreopenMintWait } from './snipe-preopen.mjs';
import { MAX_PREOPEN_CANDIDATES } from './snipe-limits.mjs';
import { snipeSettingsForTarget } from './config.mjs';
import { ROUTER } from './market.mjs';
import { readQuoteDecimals, requireQuoteFunds } from './quote-assets.mjs';
import { hasReproducibleBscEnvelope } from './snipe-pending-compare.mjs';

const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const nowMs = () => performance.now();
const PREOPEN_BLOCKS = 3;
const POLL_MS = 220;
const QUEUED_PENDING_MAX_AGE_MS = 2_500;
export const SNIPE_RACE_WINDOW_MS = 4_800;
const key = (target, wallet) => lower(target.mint) + ':' + lower(wallet.address);
const candidateKey = (mint, hash) => lower(mint) + ':' + lower(hash);
const nonceKey = tx => {
  try {
    if (typeof tx?.from !== 'string' || typeof tx.nonce !== 'string' || !/^0x[0-9a-f]{1,14}$/i.test(tx.nonce)) return;
    const nonce = Number(BigInt(tx.nonce));
    if (Number.isSafeInteger(nonce)) return lower(tx.from) + ':' + nonce;
  } catch { /* malformed source frame */ }
};
const ENVELOPE_FIELDS = [
  'hash', 'from', 'to', 'input', 'data', 'type', 'nonce', 'gas', 'value', 'gasPrice', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'r', 's', 'v', 'yParity', 'chainId', 'blockHash', 'blockNumber', 'transactionIndex',
];
const envelopeFingerprint = tx => createHash('sha256').update(JSON.stringify([
  ...ENVELOPE_FIELDS.map(field => tx[field]), tx.accessList,
])).digest('hex');
const snapshot = tx => Object.freeze(Object.fromEntries(
  ENVELOPE_FIELDS.filter(field => tx[field] !== undefined).map(field => [field, tx[field]]).concat(tx.accessList === undefined ? [] :
  [['accessList', Object.freeze(tx.accessList.map(row => Object.freeze({ address: row.address,
    storageKeys: Object.freeze([...row.storageKeys]) })))]])));

// The confirmed and pending paths share an in-process owner as well as the
// executor's cross-process journal. Never let a confirmed quote replace the
// original price floor after a speculative sequence has started.
export function makeSnipeRace({ provider, prepared, settings, execute, signal, log, services = {} }) {
  const svc = { buildPreopenBuyPlan, preparePreopenMintSequence, makePendingTransactionFeed,
    hasReproducibleBscEnvelope, delay, nowMs, ...services };
  const maxAttempts = settings.repeatAttempts ?? 1;
  const enabled = maxAttempts > 1;
  if (settings.requirePreopen && !enabled) throw new Error('只走提前狙击需要限次竞争模式');
  if (enabled && (typeof execute.race !== 'function' || typeof execute.raceStatus !== 'function')) {
    throw new Error('当前执行器不支持限次竞争，请改用单次模式');
  }
  const owners = new Map(), work = new Map(), queued = new Map(), candidateTimes = new Map(), measured = new Set();
  const pendingReceipts = new Map(), activeSeries = new Set();
  const confirmedMints = new Set();
  const launchSignals = new Map(), firstLaunchSignals = new Map();
  const nonceHeads = new Map(), confirmedNotices = new Map();
  const targets = new Map((prepared.pendingTargets ?? []).map(t => [lower(t.mint), t]));
  const feeds = new Map(), pendingStates = new Map();
  let closed = false, pendingStarted = false, receiptTimer, receiptCheck;
  const ended = () => closed || signal.aborted;
  const paused = mint => confirmedMints.has(mint) || settings.requirePreopen && launchSignals.has(mint);
  const inclusion = candidate => lower(candidate.blockHash) + ':' + lower(candidate.txHash);
  const launchKey = candidate => lower(candidate.mint) + ':' + inclusion(candidate);

  function pendingHealth() {
    const sources = Array.from(pendingStates, ([source, last]) => {
      const status = feeds.get(source)?.status?.() ?? last;
      return { source, mode: status.mode, healthy: status.healthy === true, hasFullPayload: status.hasFullPayload === true,
        reconnects: status.reconnects ?? 0, pendingLastFullAtMs: status.pendingLastFullAtMs, retryMs: status.retryMs };
    });
    return { earlyEnabled: enabled, requirePreopen: settings.requirePreopen === true, targetCount: targets.size,
      disabled: prepared.observePending === false, sources };
  }

  function pendingEvidence() {
    const { sources } = pendingHealth();
    const healthy = sources.filter(source => source.healthy);
    const active = sources.filter(source => source.hasFullPayload);
    const last = Math.max(0, ...sources.map(source => source.pendingLastFullAtMs ?? 0));
    return { pendingMode: healthy[0]?.mode ?? active[0]?.mode ?? sources[0]?.mode ?? 'idle',
      pendingSourceCount: sources.length, pendingHealthyCount: healthy.length, pendingFullSourceCount: active.length,
      fullFeedHealthy: healthy.length > 0, ...(last ? { pendingLastFullAtMs: last } : {}) };
  }

  function noteLaunchSignal(candidate, seen = svc.nowMs()) {
    const mint = lower(candidate.mint);
    if (targets.has(mint) && !confirmedMints.has(mint)) {
      launchSignals.set(mint, inclusion(candidate));
    }
    const id = launchKey(candidate);
    const earlier = firstLaunchSignals.get(id);
    if (earlier) return { seen: earlier.seen, source: earlier.source, first: false };
    if (firstLaunchSignals.size >= 256) firstLaunchSignals.delete(firstLaunchSignals.keys().next().value);
    const arrival = { seen, source: candidate.source };
    // Receipt verification can take long enough for a source to reconnect.
    // Preserve the health at discovery, not the later state at verification.
    firstLaunchSignals.set(id, { ...arrival, pending: targets.has(mint) ? pendingEvidence() : undefined });
    return { ...arrival, first: true };
  }
  function removeLaunchSignal(candidate) {
    firstLaunchSignals.delete(launchKey(candidate));
    const mint = lower(candidate.mint);
    if (launchSignals.get(mint) !== inclusion(candidate)) return;
    launchSignals.delete(mint);
    if (targets.has(mint)) drainPending(targets.get(mint), mint);
  }

  function sourceMatch(notice, source, at) {
    const signed = at?.signed;
    const lead = signed ? notice.seen - signed.seen : null;
    const signatureVerified = Boolean(signed);
    // A late upgrade is a new measurement, not a second opening opportunity.
    const previous = notice.recorded.get(source);
    if (previous === signatureVerified) return;
    notice.recorded.set(source, signatureVerified);
    const { candidate } = notice;
    log('snipe_pending_source_match', { mint: candidate.mint, token: candidate.token,
      launchTx: candidate.txHash, launchBlock: candidate.blockNumber, pendingSource: source,
      signatureVerified, matchedPending: signatureVerified && lead >= 0,
      seenBeforeLocalConfirmation: signatureVerified && lead >= 0, leadMs: lead,
      ...(signed ? { pendingReceivedAtMs: signed.receivedAtMs } : {}) });
  }

  function noteConfirmed(candidate, seen) {
    const mint = lower(candidate.mint);
    confirmedMints.add(mint);
    launchSignals.delete(mint);
    queued.delete(mint);
    if (!targets.has(mint)) return;
    const id = candidateKey(candidate.mint, candidate.txHash);
    if (measured.has(id) || measured.size >= 256) return;
    measured.add(id);
    const entry = candidateTimes.get(id);
    const at = entry?.signed;
    const first = firstLaunchSignals.get(launchKey(candidate)) ?? { seen, source: candidate.source };
    const notice = { candidate, seen: first.seen, recorded: new Map() };
    confirmedNotices.set(id, notice);
    for (const source of pendingStates.keys()) sourceMatch(notice, source, entry?.sources.get(source));
    const match = at && first.seen >= at.seen;
    log('snipe_pending_match', { mint: candidate.mint, token: candidate.token, launchTx: candidate.txHash,
      launchBlock: candidate.blockNumber, source: first.source, ...(first.pending ?? pendingEvidence()), matchedPending: Boolean(match),
      ...(match ? { pendingTxHash: candidate.txHash, pendingReceivedAtMs: at.receivedAtMs,
        pendingSource: at.source, leadMs: Math.round(first.seen - at.seen) } : {}) });
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

  async function preopen(target, mint, bucket) {
    const trade = snipeSettingsForTarget(settings, target);
    const skipAfterLaunch = () => { throw new Error('收到开盘信号；「没抢到开盘就不追」已开启，不继续提交'); };
    const checkOpening = () => { if (settings.requirePreopen && paused(mint)) skipAfterLaunch(); };
    const headAt = svc.nowMs();
    const head = await provider.getBlock('latest');
    const headMs = Math.round(svc.nowMs() - headAt);
    if (ended() || paused(mint) || !head || head.number < prepared.armBlock) return;
    let sequence;
    let selected;
    const checkSelected = () => {
      const now = svc.nowMs();
      if (!selected || selected.length !== sequence.pendingHashes.length) throw new Error('待打包 Mint 选中序列已失效；未发送');
      if (selected.some(row => now - row.seen > QUEUED_PENDING_MAX_AGE_MS)) throw new Error('待打包 Mint 已过期；未发送');
      if (selected.some(row => row.nonceKey && nonceHeads.get(row.nonceKey)?.hash !== lower(row.tx.hash))) {
        throw new Error('待打包 Mint 的 nonce 已被新签名交易替换；未发送');
      }
    };
    const candidates = () => {
      const now = svc.nowMs();
      return bucket.items.filter(row => now - row.seen <= QUEUED_PENDING_MAX_AGE_MS &&
        (!row.nonceKey || nonceHeads.get(row.nonceKey)?.hash === lower(row.tx.hash))).map(row => row.tx);
    };
    const proofAt = svc.nowMs();
    try { sequence = await svc.preparePreopenMintSequence(provider, target, candidates, trade, head, { signal }); }
    catch (error) {
      if (ended() || paused(mint)) return;
      const details = { mint: target.mint, token: target.token, quoteBlock: head.number, headMs,
        proofMs: Math.round(svc.nowMs() - proofAt) };
      if (error instanceof PreopenMintWait) {
        return log('snipe_pending_gate', { ...details, ...error.evidence, preopenStage: error.stage });
      }
      return log('buy_skipped', { ...details, raceMode: 'pending', error: shortError(error),
        pendingTxHash: bucket.items.at(-1)?.tx.hash });
    }
    if (ended() || paused(mint)) return;
    const pendingHashes = sequence.pendingHashes;
    selected = pendingHashes.map(hash => bucket.items.find(row => lower(row.tx.hash) === lower(hash))).filter(Boolean);
    try { checkSelected(); } catch (error) {
      log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending',
        quoteBlock: head.number, error: shortError(error) });
      return;
    }
    const pendingTxHash = pendingHashes.at(-1);
    const seen = Math.max(...pendingHashes.map(hash => candidateTimes.get(candidateKey(mint, hash))?.signed?.seen ?? proofAt));
    const timing = { headMs, proofMs: Math.round(svc.nowMs() - proofAt) };
    const evidence = { quoteBlock: sequence.quoteBlock, mintedLots: sequence.mintedLots, totalLots: sequence.totalLots,
      remainingLots: sequence.remainingLots, pendingCandidateCount: sequence.pendingCandidateCount, pendingMintCount: pendingHashes.length,
      pendingHashes, pendingTxHash };
    log('snipe_pending_gate', { ...timing, ...evidence, mint: target.mint, token: target.token, preopenStage: 'ready' });
    await Promise.allSettled(prepared.wallets.map(async wallet => {
      const id = key(target, wallet);
      if (ended() || paused(mint) || owners.has(id)) return;
      let plan;
      const planAt = svc.nowMs();
      try { plan = await svc.buildPreopenBuyPlan(provider, target, sequence, wallet, trade, head, { signal }); }
      catch (e) {
        if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending',
          ...timing, ...evidence, planMs: Math.round(svc.nowMs() - planAt), error: shortError(e) });
        return;
      }
      if (ended() || paused(mint) || owners.has(id)) return;
      try { checkSelected(); } catch (error) {
        log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending',
          ...timing, ...evidence, error: shortError(error) });
        return;
      }
      owners.set(id, 'pending');
      const details = { ...evidence, ...timing, planMs: Math.round(svc.nowMs() - planAt),
        pendingTxHash: plan.pendingHash ?? pendingTxHash, quoteBlock: plan.quoteBlock,
        amountOutMin: plan.amountOutMin, openingNetOut: plan.openingNetOut, quotedNetOut: plan.quotedNetOut,
        openingAmountOutMin: plan.openingAmountOutMin, maxOpeningPremiumBps: plan.maxOpeningPremiumBps,
        ...(target.snipeQuote ? { quoteToken: trade.quoteToken, amountIn: trade.amountIn } : {}),
        gasEstimate: plan.gasEstimate, quoteMs: Math.round(svc.nowMs() - seen) };
      log('snipe_race_mode', { ...details, mint: target.mint, token: target.token, raceMode: 'pending', maxAttempts });
      try {
        await series({ target, wallet, raceMode: 'pending', details, checkOpening: () => { checkOpening(); checkSelected(); }, request: {
          actionId: actionId('buy', target), wallet, tx: plan.tx, gasEstimate: plan.gasEstimate, preopenPlan: plan,
          quoteToken: trade.quoteToken,
          beforeSign: async () => {
            const [parent, latest] = await Promise.all([provider.getBlock(plan.quoteBlock), provider.getBlock('latest')]);
            signal.throwIfAborted();
            if (!parent || !latest || lower(parent.hash) !== lower(plan.quoteBlockHash) ||
                latest.number < plan.quoteBlock || latest.number - plan.quoteBlock > PREOPEN_BLOCKS ||
                latest.timestamp + 2 >= plan.deadline) throw new Error('提前发单的模拟区块已过期或重组；未发送');
            if (latest.number > plan.quoteBlock) {
              const senderNonces = new Map();
              for (const row of selected) if (row.nonceKey) {
                const sender = lower(row.tx.from), nonce = Number(BigInt(row.tx.nonce));
                senderNonces.set(sender, Math.min(senderNonces.get(sender) ?? nonce, nonce));
              }
              const [freshNonces, code] = await Promise.all([
                Promise.all([...senderNonces].map(async ([sender, expected]) => {
                  const nonce = await provider.getTransactionCount(sender, latest.number);
                  return Number.isSafeInteger(nonce) && nonce === expected;
                })), provider.getCode(target.token, latest.number),
              ]);
              if (freshNonces.some(valid => !valid)) throw new Error('待打包 Mint 的 nonce 已在新父块变化；未发送');
              // A pool already created in a newer block must satisfy the
              // original minOut at that state. Never chase by re-quoting.
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
    const bucket = queued.get(mint);
    if (!bucket || paused(mint) || ended()) return;
    const now = svc.nowMs();
    bucket.items = bucket.items.filter(row => now - row.seen <= QUEUED_PENDING_MAX_AGE_MS);
    if (!bucket.items.length || prepared.wallets.every(wallet => owners.has(key(target, wallet)))) {
      queued.delete(mint);
      return;
    }
    if (bucket.considered === bucket.version) return;
    // If new frames arrive during an inconclusive proof, re-read the head
    // once for that new wave. The earlier snapshot may predate their parent.
    bucket.considered = bucket.version;
    const job = preopen(target, mint, bucket).catch(error => {
      if (!ended()) log('buy_skipped', { mint: target.mint, token: target.token, raceMode: 'pending', error: shortError(error) });
    }).finally(() => {
      work.delete(mint);
      drainPending(target, mint);
    });
    work.set(mint, job);
  }

  function onPending(tx, arrival, source) {
    if (ended()) return;
    const now = svc.nowMs();
    const seen = Number.isFinite(arrival?.seen) && arrival.seen >= 0 && arrival.seen <= now ? arrival.seen : now;
    const receivedAtMs = Number.isSafeInteger(arrival?.receivedAtMs) ? arrival.receivedAtMs : Date.now();
    const replaceNonce = (senderNonce, hash, excludeMint) => {
      if (!nonceHeads.has(senderNonce) && nonceHeads.size >= 512) nonceHeads.delete(nonceHeads.keys().next().value);
      nonceHeads.set(senderNonce, { hash, seen });
      for (const [mint, bucket] of queued) if (mint !== excludeMint &&
          bucket.items.some(row => row.nonceKey === senderNonce && lower(row.tx.hash) !== hash)) {
        bucket.version++;
        drainPending(targets.get(mint), mint);
      }
    };
    const match = decodePendingMint(tx, targets);
    if (!match) {
      // Only inspect non-Mint traffic for sender/nonce pairs we already use.
      // A valid self-transfer/cancel can replace the selected Mint just as a
      // newer Mint can. Never do signature recovery for unrelated mempool txs.
      const senderNonce = nonceKey(tx), previous = senderNonce && nonceHeads.get(senderNonce);
      if (!previous || previous.hash === lower(tx.hash) || !svc.hasReproducibleBscEnvelope(tx)) return;
      replaceNonce(senderNonce, lower(tx.hash));
      return;
    }
    const target = targets.get(lower(match.mint));
    const id = candidateKey(match.mint, match.hash);
    const frameMode = arrival?.mode === 'full' || arrival?.mode === 'mixed' ? arrival.mode : pendingStates.get(source)?.mode;
    const mint = lower(target.mint);
    const meta = { seen, receivedAtMs, mode: frameMode, source };
    let entry = candidateTimes.get(id);
    if (!entry) {
      if (candidateTimes.size >= 512) candidateTimes.delete(candidateTimes.keys().next().value);
      entry = { ...meta, sources: new Map() };
      candidateTimes.set(id, entry);
      log('snipe_pending', { mint: target.mint, token: target.token, pendingTxHash: match.hash, pendingMode: frameMode,
        pendingReceivedAtMs: receivedAtMs, pendingSource: source,
        afterLaunchSignal: confirmedMints.has(mint) || launchSignals.has(mint) });
    }
    let sourceAt = entry.sources.get(source);
    if (sourceAt?.signed) return;
    const fingerprint = envelopeFingerprint(tx);
    if (sourceAt?.checkedFingerprint === fingerprint) return;
    const verified = entry.verifiedFingerprint === fingerprint || svc.hasReproducibleBscEnvelope(tx);
    const firstAtSource = !sourceAt;
    if (!sourceAt) { sourceAt = { first: meta }; entry.sources.set(source, sourceAt); }
    sourceAt.checkedFingerprint = fingerprint;
    if (verified) entry.verifiedFingerprint = fingerprint;
    if (verified) sourceAt.signed = meta;
    if (firstAtSource || verified) {
      log('snipe_pending_source', { mint: target.mint, token: target.token, pendingTxHash: match.hash,
        pendingMode: frameMode, pendingReceivedAtMs: receivedAtMs, pendingSource: source, signatureVerified: verified,
        afterLaunchSignal: confirmedMints.has(mint) || launchSignals.has(mint) });
    }
    const notice = confirmedNotices.get(id);
    if (notice) sourceMatch(notice, source, sourceAt);
    if (!verified) {
      // An incomplete first source is not allowed to poison the hash for a
      // later full envelope. A visibly signed but forged frame is diagnostic.
      if (!entry.signatureFailureReported && tx.r && tx.s) {
        entry.signatureFailureReported = true;
        log('buy_skipped', { mint: target.mint, token: target.token, pendingTxHash: match.hash,
          raceMode: 'pending', error: '无法核验待打包 Mint 的 BSC 签名与交易哈希' });
      }
      return;
    }
    if (entry.signed) return;
    entry.signed = meta;
    if (!enabled || confirmedMints.has(mint) ||
        prepared.wallets.every(wallet => owners.has(key(target, wallet)))) return;
    const senderNonce = nonceKey(tx);
    if (senderNonce) replaceNonce(senderNonce, match.hash, mint);
    // Keep the bounded group even while proof reads are in flight. Multiple
    // consecutive Mint calls can fill and open in a single block.
    const bucket = queued.get(mint) ?? { items: [], version: 0, considered: 0 };
    if (senderNonce) bucket.items = bucket.items.filter(row => row.nonceKey !== senderNonce);
    while (bucket.items.length >= MAX_PREOPEN_CANDIDATES) bucket.items.shift();
    bucket.items.push({ tx: snapshot(tx), seen, nonceKey: senderNonce });
    bucket.version++;
    queued.set(mint, bucket);
    drainPending(target, mint);
  }

  return {
    enabled, noteLaunchSignal, removeLaunchSignal, noteConfirmed, runConfirmed, pendingHealth,
    isOwned: (target, wallet) => owners.has(key(target, wallet)),
    start() {
      if (enabled && !receiptTimer && !ended()) {
        receiptTimer = setInterval(() => {
          if (!receiptCheck && pendingReceipts.size) receiptCheck = followPending().finally(() => { receiptCheck = undefined; });
        }, 900);
        receiptTimer.unref();
      }
      if (ended() || pendingStarted || !targets.size || prepared.observePending === false) return;
      pendingStarted = true;
      const primary = prepared.pendingWsUrl ?? process.env.BSC_PENDING_WSS_URL ?? 'wss://bsc-rpc.publicnode.com';
      const backups = prepared.pendingWsBackupUrls ?? process.env.BSC_PENDING_WSS_BACKUP_URLS ?? '';
      const { sources, invalidBackups } = pendingWsSources(primary, backups);
      if (invalidBackups) {
        log('snipe_pending_feed', { pendingMode: 'invalid_config', message: '请检查备用 WSS 配置；最多使用前两个备用来源' });
      }
      for (const { source, url: wsUrl } of sources) {
        const onStatus = ({ mode, healthy, hasFullPayload, reconnects, retryMs, pendingLastFullAtMs,
          connections, fullMessages, hashMessages, droppedMessages }) => {
          if (ended()) return;
          pendingStates.set(source, { mode, healthy, hasFullPayload, reconnects, retryMs, pendingLastFullAtMs });
          log('snipe_pending_feed', { pendingSource: source, pendingMode: mode, healthy, reconnects, retryMs,
            pendingLastFullAtMs, connections, fullMessages, hashMessages, droppedMessages });
        };
        if (!wsUrl) {
          onStatus({ mode: 'invalid_config' });
          continue;
        }
        try {
          const feed = svc.makePendingTransactionFeed({ wsUrl, signal,
            onTransaction: (tx, arrival) => onPending(tx, arrival, source), onStatus });
          feeds.set(source, feed);
          pendingStates.set(source, { mode: 'connecting' });
          feed.start();
        } catch {
          feeds.get(source)?.close();
          feeds.delete(source);
          onStatus({ mode: 'unavailable' });
        }
      }
    },
    async close() {
      closed = true;
      queued.clear();
      clearInterval(receiptTimer);
      for (const feed of feeds.values()) feed.close();
      await Promise.allSettled([...work.values(), receiptCheck].filter(Boolean));
    },
  };
}
