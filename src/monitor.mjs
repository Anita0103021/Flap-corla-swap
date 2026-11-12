import { inspectMint, buildMint, buildClaim, createCorlaInspectionScope } from './corla.mjs';
import { findLaunch } from './events.mjs';
import { applyOpeningPriceGuard, readMarket, readOpeningBuyTax, verifyRoundTrip } from './market.mjs';
import { MAX_MINT_BATCHES, mintWalletsFor } from './config.mjs';

// Legacy/mock executors may not expose receipt maturity. Limit background
// checks in that case; the real executor retires entries at canonical depth.
export const LEGACY_RECEIPT_WATCH_MS = 30_000;

export function actionId(kind, target, ordinal = 1) {
  const base = 'bsc56:' + target.mint.toLowerCase() + ':' + kind;
  if (kind !== 'mint') return base;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_MINT_BATCHES) throw new Error('无效的 Mint 批次编号');
  // The first ordinal deliberately keeps the v1 journal ID, preserving old
  // staged, confirmed and failed entries across upgrading the workstation.
  return ordinal === 1 ? base : base + ':' + ordinal;
}
export function launchSearchBounds(armBlock, head, windowBlocks) {
  // Do not buy anything at or before arming, including on restart.
  const first = Math.max(armBlock + 1, head - windowBlocks + 1);
  return first <= head ? [first, head] : null;
}
export class BuySnapshotGuardError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}
const validHash = value => /^0x[\da-f]{64}$/i.test(value ?? '');
const sameHash = (a, b) => validHash(a) && validHash(b) && a.toLowerCase() === b.toLowerCase();

export function checkBuyFreshness({ head, canonicalLaunch, canonicalQuote, launch, quoteBlock, settings, armBlock }) {
  if (!Number.isSafeInteger(head?.number) || !Number.isSafeInteger(head?.timestamp) ||
      !Number.isSafeInteger(quoteBlock?.number) || !Number.isSafeInteger(quoteBlock?.timestamp) ||
      head.number < quoteBlock.number || head.timestamp < quoteBlock.timestamp || quoteBlock.number < launch.blockNumber) {
    throw new BuySnapshotGuardError('RPC 区块高度或时间未同步；未发送', true);
  }
  const bounds = launchSearchBounds(armBlock, head.number, settings.windowBlocks);
  if (!bounds || launch.blockNumber < bounds[0] || launch.blockNumber > bounds[1]) {
    throw new BuySnapshotGuardError('已超出开盘狙击窗口；未发送');
  }
  if (!canonicalLaunch || canonicalLaunch.number !== launch.blockNumber) {
    throw new BuySnapshotGuardError('无法读取开盘区块；未发送', true);
  }
  if (!sameHash(canonicalLaunch.hash, launch.blockHash)) {
    throw new BuySnapshotGuardError('开盘区块已重组；未发送');
  }
  if (canonicalQuote?.number !== quoteBlock.number || !sameHash(canonicalQuote?.hash, quoteBlock.hash) ||
      (head.number === quoteBlock.number && !sameHash(head.hash, quoteBlock.hash)) ||
      head.timestamp + 2 >= quoteBlock.timestamp + settings.deadlineSeconds) {
    throw new BuySnapshotGuardError('报价区块已变动或报价即将过期；本次不发送', true);
  }
}

export async function verifyBuySnapshot(provider, { launch, quoteBlock, settings, armBlock, signal }) {
  signal?.throwIfAborted();
  const launchRead = provider.getBlock(launch.blockNumber);
  const [head, canonicalLaunch, canonicalQuote] = await Promise.all([
    provider.getBlock('latest'), launchRead,
    quoteBlock.number === launch.blockNumber ? launchRead : provider.getBlock(quoteBlock.number),
  ]);
  signal?.throwIfAborted();
  checkBuyFreshness({ head, canonicalLaunch, canonicalQuote, launch, quoteBlock, settings, armBlock });
}

function projectFingerprint(state) {
  // Exclude the observation height: time/phase-only changes still need to be
  // reported, but unchanged snapshots shouldn't add an event each block.
  return [state.activeLots, state.mintedLots, state.totalLots, state.launched, state.pool, state.token,
    state.pricePerLot, state.maxMintsPerWallet, state.tokensPerLot, state.phase, state.fundingDeadline,
    state.whitelistEnabled, state.whitelistDeadline, state.agentOnly, state.emergencyWithdrawn].join(':');
}
export function shortError(e) {
  if (e?.code === 'CALL_EXCEPTION') return '合约模拟回退 (CALL_EXCEPTION)';
  if (typeof e?.code === 'string') return '操作失败 (' + e.code.replace(/[^A-Z0-9_]/g, '').slice(0, 48) + ')';
  return String(e?.message ?? '操作失败')
    .replace(/(?:https?|wss?):\/\/[^\s"']+/gi, '[URL]')
    .replace(/0x[0-9a-fA-F]{65,}/g, '[DATA]').slice(0, 180);
}

// Optional restart recovery for recent receipts from prior jobs. Running-job
// actions are watched by exact ID first; callers pass only idle wallets to
// avoid duplicate lookups. An unavailable header may recover without a DB
// orphan marker, so explicitly recheck any previously reported pending ID.
export function makeJournalHistoryPoller({ execute, signal, log }) {
  if (!execute.reconcileRecent) return null;
  const waiting = new Map();
  return async wallets => {
    await Promise.allSettled(wallets.map(async wallet => {
      if (signal?.aborted) return;
      const prior = waiting.get(wallet.address) ?? new Map();
      const seen = new Set();
      function note(row) {
        if (!row?.actionId || !row.txHash) return;
        seen.add(row.actionId);
        const summary = [row.status, row.txHash, row.reason, row.receiptStable, row.receiptBlock].join(':');
        const changed = prior.get(row.actionId) !== summary;
        if (row.status === 'pending') prior.set(row.actionId, summary);
        else prior.delete(row.actionId);
        if (changed) {
          const [, mint, action] = row.actionId.split(':');
          log('journal', { mint, action, ...row });
        }
      }
      for (const row of await execute.reconcileRecent(wallet)) note(row);
      if (prior.size) waiting.set(wallet.address, prior);
      for (const id of prior.keys()) {
        if (signal?.aborted) break;
        if (!seen.has(id) && execute.reconcile) {
          try { note(await execute.reconcile(id, wallet)); } catch { /* Retain pending and try later. */ }
        }
      }
      if (!prior.size) waiting.delete(wallet.address);
    }));
  };
}

export function makeMonitor({ provider, cfg, wallets, execute, armBlock, log, signal, services = {} }) {
  const svc = { inspectMint, buildMint, buildClaim, findLaunch, readMarket, readOpeningBuyTax, verifyRoundTrip, ...services };
  const lastStates = new Map();
  const outcomes = new Map();
  const snipeAttempted = new Set();
  const active = new Set();
  const pending = new Map();
  const recent = new Map();
  const emitted = new Map();
  const pollHistory = makeJournalHistoryPoller({ execute, signal, log });
  let lastBlock = -1;
  let lastHash;

  function update(key, value, event, data) {
    if (emitted.get(key) === value) return;
    emitted.set(key, value);
    log(event, data);
  }

  async function action(kind, target, wallet, build, ordinal = 1, refreshing = false) {
    const id = actionId(kind, target, ordinal);
    const key = id + ':' + wallet.address;
    if (signal?.aborted || (!refreshing && outcomes.has(key)) || active.has(wallet.address) ||
      (!refreshing && [...pending.values()].some(item => item.wallet.address === wallet.address))) return;
    active.add(wallet.address);
    try {
      let result = execute.reconcile ? await execute.reconcile(id, wallet) : null;
      let details = kind === 'mint' ? { mintOrdinal: ordinal } : undefined;
      if (!result) {
        if (signal?.aborted || refreshing) return;
        const plan = await build();
        if (!plan || signal?.aborted) return;
        details = { ...details, ...plan.details };
        result = await execute({ actionId: id, wallet, tx: plan.tx, ...(kind === 'buy' ? { singleSubmission: true } : {}),
          gasLimitFloor: plan.gasLimitFloor, beforeSign: async () => {
            signal?.throwIfAborted();
            await plan.beforeSign?.();
            signal?.throwIfAborted();
          } });
      }
      if (result.actionId && result.actionId !== id) {
        update(key, 'busy:' + result.actionId, kind + '_skipped', { mint: target.mint, wallet: wallet.address,
          error: '该钱包有其他交易待确认，本次未发送' });
        return;
      }
      if (result.status === 'pending' && result.txHash && result.actionId === id) {
        recent.delete(key);
        pending.set(key, { wallet, kind, target, ordinal });
      }
      if (['simulated', 'confirmed', 'failed'].includes(result.status)) {
        outcomes.set(key, result.status);
        pending.delete(key);
        const until = recent.get(key)?.until ?? Date.now() + LEGACY_RECEIPT_WATCH_MS;
        recent.delete(key);
        if (execute.reconcile && result.status !== 'simulated' && result.txHash && result.receiptStable !== true) {
          // Rotate each checked ID so one wallet's multiple recent actions
          // are all revisited while limiting it to one background RPC at once.
          recent.set(key, { wallet, kind, target, ordinal, until: result.receiptStable === false ? Infinity : until });
        }
      }
      update(key, [result.status, result.txHash, result.reason, result.receiptStable, result.receiptBlock].join(':'),
        kind, { mint: target.mint, token: target.token, ...details, ...result });
    } catch (e) {
      if (signal?.aborted) return;
      const error = shortError(e);
      update(key, error, kind + '_skipped', {
        mint: target.mint, wallet: wallet.address, ...(kind === 'mint' ? { mintOrdinal: ordinal } : {}), error,
      });
    } finally {
      active.delete(wallet.address);
    }
  }

  return async function tick() {
    if (signal?.aborted) return;
    const block = await provider.getBlock('latest');
    if (signal?.aborted || !block || block.number < lastBlock ||
        (block.number === lastBlock && block.hash === lastHash)) return;
    lastBlock = block.number;
    lastHash = block.hash;
    const scope = createCorlaInspectionScope(provider, block.number);
    const states = await Promise.all(cfg.targets.map(async target => {
      try {
        const state = await svc.inspectMint(provider, target, block.number, scope);
        if (signal?.aborted) return null;
        const summary = projectFingerprint(state);
        if (lastStates.get(target.mint) !== summary) {
          lastStates.set(target.mint, summary);
          log('project', { mint: target.mint, block: block.number, ...state, token: target.token, deployedToken: state.token });
        }
        return { target, state };
      } catch (e) {
        if (signal?.aborted) return null;
        const error = shortError(e);
        update(target.mint, error, 'project_error', { mint: target.mint, error });
        return null;
      }
    }));
    if (signal?.aborted) return;

    // Existing unknown broadcasts reconcile even if the launch window has elapsed.
    for (const [key, entry] of recent) if (entry.until <= Date.now()) recent.delete(key);
    const recentBeforeTick = [...recent.entries()];
    await Promise.allSettled([...pending.values()].map(({ kind, target, wallet, ordinal }) =>
      action(kind, target, wallet, async () => null, ordinal, true)));
    const bounds = cfg.snipe && launchSearchBounds(armBlock, block.number, cfg.snipe.windowBlocks);
    if (bounds && wallets.length) {
      for (const entry of states) {
        if (signal?.aborted) return;
        if (!entry?.target.buyOnLaunch || !entry.state.launched) continue;
        const { target, state } = entry;
        const id = actionId('buy', target);
        if (snipeAttempted.has(id)) continue;
        const launchDetails = { mint: target.mint, token: target.token };
        try {
          const launch = await svc.findLaunch(provider, target, state, ...bounds);
          if (!launch || signal?.aborted || snipeAttempted.has(id)) continue;
          snipeAttempted.add(id);
          Object.assign(launchDetails, { launchBlock: launch.blockNumber, launchTx: launch.txHash });
          // This polling monitor has no pending-Mint path. Never turn a
          // preopen-only policy into a confirmed order, even in simulation.
          if (cfg.snipe.requirePreopen) {
            const error = '已开盘；「没抢到开盘就不追」已开启，不提交确认后买单';
            update('market:' + target.mint, error, 'buy_skipped', { ...launchDetails, error });
            continue;
          }
          const [quote, openingBuyTax] = await Promise.all([
            svc.readMarket(provider, target, state, cfg.snipe, block),
            svc.readOpeningBuyTax(provider, target.token, launch.blockNumber),
          ]);
          if (signal?.aborted) return;
          const market = applyOpeningPriceGuard(quote, launch.openingReserves, openingBuyTax, cfg.snipe);
          const selected = wallets.slice(0, cfg.snipe.walletCount);
          await Promise.all(selected.map(wallet => action('buy', target, wallet, async () => {
            const tx = await svc.verifyRoundTrip(provider, market, wallet.address, cfg.snipe, block);
            return { tx,
              beforeSign: () => verifyBuySnapshot(provider, { launch, quoteBlock: block, settings: cfg.snipe, armBlock, signal }),
              details: { ...launchDetails, pair: market.pair, amountOutMin: market.amountOutMin, quoted: market.quoted,
                openingNetOut: market.openingNetOut, quotedNetOut: market.quotedNetOut,
                openingAmountOutMin: market.openingAmountOutMin, maxOpeningPremiumBps: market.maxOpeningPremiumBps },
            };
          })));
        } catch (e) {
          if (signal?.aborted) return;
          const error = shortError(e);
          update('market:' + target.mint, error, 'buy_skipped', { ...launchDetails, ...e?.priceEvidence, error });
        }
      }
    }
    // Prioritize the short launch window, then process mint and claim.
    for (const entry of states) {
      if (signal?.aborted) return;
      if (!entry) continue;
      const { target, state } = entry;
      if (!target.mintBatches && !target.autoClaim) continue;
      let selected;
      try { selected = mintWalletsFor(target, wallets); } catch (e) {
        const error = shortError(e);
        update('wallets:' + target.mint, error, 'project_error', { mint: target.mint, error });
        continue;
      }
      if (target.autoClaim && state.launched) {
        await Promise.all(selected.map(wallet => action('claim', target, wallet, () => svc.buildClaim(provider, target, state, wallet.address))));
      } else if (target.mintBatches && !state.launched) {
        const remaining = state.totalLots - state.mintedLots;
        const nearEnd = BigInt(selected.length + 4);
        const finalMintGas = 8_500_000n;
        const floor = remaining <= nearEnd && cfg.gasLimitCap >= finalMintGas ? finalMintGas : undefined;
        let slots = remaining;
        await Promise.all(selected.map(async wallet => {
          if (signal?.aborted) return;
          let plan;
          try { plan = await svc.buildMint(provider, target, state, wallet.address, block); } catch (e) {
            const error = shortError(e);
            update('mint-plan:' + target.mint + ':' + wallet.address, error, 'mint_skipped', { mint: target.mint, wallet: wallet.address, error });
            return;
          }
          if (!plan) return;
          await action('mint', target, wallet, async () => {
            if (slots <= 0n) return null;
            if (!floor && remaining <= nearEnd) throw new Error('临近最后一批，单笔 Gas 上限不足以覆盖开盘');
            slots--;
            return {
              ...plan, gasLimitFloor: floor,
              beforeSign: async () => {
                const freshRemaining = await plan.beforeSign();
                if (!floor && freshRemaining <= nearEnd) {
                  throw new Error('筹资已临近最后一批，等待下一轮重新计算开盘 Gas');
                }
              },
            };
          }, plan.details.mintOrdinal);
        }));
      }
    }
    // Don't put routine receipt maturity checks before the launch/claim paths.
    // Exact pending results above still block other actions for their wallet.
    const blockedWallets = new Set([...pending.values()].map(entry => entry.wallet.address));
    const watchedWallets = new Set([...blockedWallets, ...[...recent.values()].map(entry => entry.wallet.address)]);
    await Promise.allSettled(recentBeforeTick.map(([key, entry]) => {
      if (recent.get(key) !== entry || blockedWallets.has(entry.wallet.address)) return;
      const { kind, target, wallet, ordinal } = entry;
      return action(kind, target, wallet, async () => null, ordinal, true);
    }));
    await pollHistory?.(wallets.filter(wallet => !watchedWallets.has(wallet.address)));
  };
}
