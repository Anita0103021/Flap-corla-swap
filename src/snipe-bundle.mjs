import { Transaction, ZeroAddress, keccak256, toQuantity } from 'ethers';
import { CHAIN_ID, FACTORY } from './config.mjs';
import { ROUTER, ROUTER_ABI, WBNB } from './market.mjs';
import { decodePendingMint } from './pending-mint-shadow.mjs';
import { MAX_PREOPEN_MINTS } from './snipe-limits.mjs';

// NodeReal's BSC eth_sendBundle API. This adapter deliberately has no URL,
// credentials, network client, signer, log hook, or public RPC fallback.
// https://docs.nodereal.io/docs/send-bundle
const RAW_MAX = 32_770;
const MAX_SUBMISSIONS = 1_024;
const BEFORE_ACCEPTANCE_ERRORS = new Set([-32700, -32600, -32601, -32602]);
const STOPPED = Symbol('operation did not complete');
const lower = v => typeof v === 'string' ? v.toLowerCase() : '';
const isHash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
const isAddress = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && lower(v) !== ZeroAddress;
const isInt = v => Number.isSafeInteger(v) && v >= 0;
const requireValid = condition => { if (!condition) throw new Error('Invalid bundle input'); };
const result = (status, reason, fields) => Object.freeze({ status, reason, ...fields });
const synchronous = value => {
  if (value && typeof value.then === 'function') {
    // A wrongly injected async dependency must not create an unhandled
    // rejection, or be mistaken for a completed durable commit.
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Synchronous journal required');
  }
  return value;
};

function readSigned(raw, expectedHash) {
  requireValid(typeof raw === 'string' && raw.length <= RAW_MAX && /^0x(?:[0-9a-f]{2})+$/i.test(raw) &&
    isHash(expectedHash) && keccak256(raw) === lower(expectedHash));
  const tx = Transaction.from(raw);
  requireValid(tx.isSigned() && [0, 1, 2].includes(tx.type) && tx.chainId === CHAIN_ID && isAddress(tx.to) &&
    isAddress(tx.from) && tx.hash === lower(expectedHash) && lower(tx.serialized) === lower(raw) &&
    isInt(tx.nonce) && tx.gasLimit >= 21_000n);
  return tx;
}

function validateBuy(tx, expected, target, quoteToken, deadline) {
  requireValid(tx.type === 0 && lower(tx.to) === lower(ROUTER) && lower(tx.to) === lower(expected?.to) &&
    lower(tx.from) === lower(expected?.from) && lower(tx.data) === lower(expected?.data) &&
    typeof expected?.value === 'bigint' && tx.value === expected.value);
  const native = quoteToken === ZeroAddress;
  const name = native ? 'swapExactETHForTokensSupportingFeeOnTransferTokens' :
    'swapExactTokensForTokensSupportingFeeOnTransferTokens';
  const args = ROUTER_ABI.decodeFunctionData(name, tx.data);
  requireValid(lower(ROUTER_ABI.encodeFunctionData(name, args)) === lower(tx.data));
  const [minOut, path, recipient, expiration] = native ? args : args.slice(1);
  requireValid((native ? tx.value > 0n : tx.value === 0n && args[0] > 0n) && minOut > 0n &&
    path.length === 2 && lower(path[0]) === lower(native ? WBNB : quoteToken) &&
    lower(path[1]) === lower(target.token) && lower(path[0]) !== lower(path[1]) &&
    lower(recipient) === lower(tx.from) && expiration === BigInt(deadline));
}

function verifyInput({ mintRaws, buyRaw, expectedMintHashes, expectedBuyHash, parent, deadline, target, expectedBuy }) {
  requireValid(isInt(parent?.number) && parent.number < Number.MAX_SAFE_INTEGER && isHash(parent.hash) &&
    isInt(parent.timestamp) && isInt(deadline) && deadline - parent.timestamp >= 5 && deadline - parent.timestamp <= 60);
  requireValid(Array.isArray(mintRaws) && mintRaws.length > 0 && mintRaws.length <= MAX_PREOPEN_MINTS &&
    Array.isArray(expectedMintHashes) && expectedMintHashes.length === mintRaws.length &&
    isAddress(target?.mint) && isAddress(target?.token) &&
    (target.factory === undefined || lower(target.factory) === lower(FACTORY)) &&
    typeof target.pricePerLot === 'bigint' && target.pricePerLot > 0n);
  const quoteToken = target.quoteToken === undefined ? ZeroAddress : lower(target.quoteToken);
  requireValid(quoteToken === ZeroAddress || isAddress(quoteToken) && isHash(target.deploymentKey));
  const buy = readSigned(buyRaw, expectedBuyHash);
  validateBuy(buy, expectedBuy, target, quoteToken, deadline);
  const seenHashes = new Set([buy.hash]), lastNonce = new Map();
  const mintHashes = [];
  const targets = new Map([[lower(target.mint), { ...target, quoteToken }]]);
  const txs = [];
  for (let i = 0; i < mintRaws.length; i++) {
    const raw = mintRaws[i];
    const mint = readSigned(raw, expectedMintHashes[i]);
    const from = lower(mint.from);
    const hit = decodePendingMint({ hash: mint.hash, to: mint.to, from, input: mint.data,
      value: toQuantity(mint.value) }, targets);
    requireValid(hit && !seenHashes.has(mint.hash) && from !== lower(buy.from) &&
      (!lastNonce.has(from) || mint.nonce === lastNonce.get(from) + 1));
    seenHashes.add(mint.hash);
    lastNonce.set(from, mint.nonce);
    mintHashes.push(mint.hash);
    txs.push(raw);
  }
  return {
    txs: Object.freeze([...txs, buyRaw]),
    walletNonceKey: lower(buy.from) + ':' + buy.nonce,
    intent: Object.freeze({ chainId: Number(CHAIN_ID), mint: lower(target.mint), token: lower(target.token),
      wallet: lower(buy.from), nonce: buy.nonce, buyTxHash: buy.hash,
      parentBlock: parent.number, parentHash: lower(parent.hash), targetBlock: parent.number + 1,
      maxTimestamp: deadline, mintHashes: Object.freeze([...mintHashes]) }),
    fields: Object.freeze({ buyTxHash: buy.hash, mintHashes: Object.freeze(mintHashes),
      parentBlock: parent.number, parentHash: lower(parent.hash), targetBlock: parent.number + 1, maxTimestamp: deadline }),
    parentTimestamp: parent.timestamp,
  };
}

// Race against a local deadline even if a test double or a future transport
// ignores AbortSignal. After the handoff, abort/timeout is never proof of refusal.
async function bounded(operation, timeoutMs, signal) {
  if (signal?.aborted) return STOPPED;
  const controller = new AbortController();
  let terminate;
  const stop = new Promise(resolve => { terminate = resolve; });
  const cancel = () => { terminate(STOPPED); controller.abort(); };
  const timer = setTimeout(cancel, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) return STOPPED;
    return await Promise.race([
      stop, Promise.resolve().then(() => controller.signal.aborted ? STOPPED : operation(controller.signal)).catch(() => STOPPED),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Explicit dependencies only: transport must send one JSON-RPC packet and return
 * its entire decoded reply; readLatestBlock must read a fresh canonical BSC
 * header, not cached or a WS candidate. Expected transaction fields/hashes and
 * parent must originate in the verified Corla sequence, not from the transport.
 *
 * The relay's targetBlock is an upper bound, not an on-chain parent/hash lock.
 * Passing a durable synchronous journal adds a permanent intent/nonce lock
 * before handoff and outcome persistence; the optional in-memory-only mode is
 * for isolated fixtures, not restart-safe live execution. Neither mode performs
 * settlement, receipt checking, signing, or network I/O on its own.
 */
export function makeNodeRealBundleSubmitter({
  transport, readLatestBlock, nowSeconds = () => Math.floor(Date.now() / 1_000), timeoutMs = 700,
  journal,
} = {}) {
  if ((transport !== undefined && typeof transport !== 'function') ||
      (readLatestBlock !== undefined && typeof readLatestBlock !== 'function') || typeof nowSeconds !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000 ||
      (journal !== undefined && (!journal || typeof journal.lookup !== 'function' ||
        typeof journal.reserve !== 'function' || typeof journal.markOutcome !== 'function'))) {
    throw new TypeError('Invalid ordered bundle adapter configuration');
  }
  const handedOffHashes = new Set(), handedOffNonces = new Set();
  let requestSequence = 0;
  const elapsed = deadline => {
    try {
      const now = nowSeconds();
      return !isInt(now) || now >= deadline;
    } catch { return true; }
  };

  return async function submit(input) {
    if (!transport || !readLatestBlock) return result('disabled', 'transport_not_configured');
    let plan, signal;
    try {
      signal = input?.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) return result('refused', 'invalid_input');
      if (signal?.aborted) return result('refused', 'aborted_before_submit');
      plan = verifyInput(input);
    } catch { return result('refused', 'invalid_input'); }
    const { fields } = plan;
    const refused = reason => result('refused', reason, fields);
    // Even without a new handoff, the earlier call may have delivered a raw
    // transaction for this nonce. Do not classify a duplicate as safe release.
    const attempted = () => result('unknown', 'previously_attempted', fields);
    if (handedOffHashes.has(fields.buyTxHash) || handedOffNonces.has(plan.walletNonceKey)) return attempted();
    // This lookup deliberately precedes expiry/parent checks. An old attempt
    // remains an unknown prior handoff, not a new safely-expired transaction.
    if (journal) {
      try {
        const found = synchronous(journal.lookup(plan.intent));
        if (typeof found !== 'boolean') throw new Error('Synchronous journal required');
        if (found) return attempted();
      } catch { return result('unknown', 'journal_unavailable', fields); }
    }
    if (handedOffHashes.size >= MAX_SUBMISSIONS) return refused('submission_capacity');
    if (elapsed(fields.maxTimestamp)) return refused('expired');
    const latest = await bounded(signal => readLatestBlock({ signal }), timeoutMs, signal);
    if (signal?.aborted) return refused('aborted_before_submit');
    if (latest === STOPPED) return refused('parent_unverified');
    try {
      if (!latest || latest.number !== fields.parentBlock || latest.timestamp !== plan.parentTimestamp ||
          lower(latest.hash) !== fields.parentHash) return refused('parent_changed');
    } catch { return refused('parent_unverified'); }

    // Re-check inside the scheduled dispatch; concurrent calls and deadlines
    // may have changed while waiting on the parent RPC or the microtask queue.
    let handedOff = false, blocked, id, reservation;
    const handoffDeadline = performance.now() + timeoutMs;
    const reply = await bounded(submitSignal => {
      if (elapsed(fields.maxTimestamp)) { blocked = 'expired'; return STOPPED; }
      if (submitSignal.aborted) { blocked = 'aborted_before_submit'; return STOPPED; }
      if (handedOffHashes.has(fields.buyTxHash) || handedOffNonces.has(plan.walletNonceKey)) {
        blocked = 'previously_attempted'; return STOPPED;
      }
      if (handedOffHashes.size >= MAX_SUBMISSIONS) { blocked = 'submission_capacity'; return STOPPED; }
      if (journal) {
        try {
          const reserved = synchronous(journal.reserve(plan.intent));
          if (reserved?.status === 'duplicate') { blocked = 'previously_attempted'; return STOPPED; }
          if (reserved?.status !== 'reserved' || !reserved.reservation) throw new Error('Invalid reservation');
          reservation = reserved.reservation;
        } catch { blocked = 'journal_unavailable'; return STOPPED; }
        // FULL-sync commits can outlast the dispatch budget. Keep the durable
        // tombstone, but never send a transaction after that budget/expiry.
        if (submitSignal.aborted || performance.now() >= handoffDeadline || elapsed(fields.maxTimestamp)) {
          blocked = 'reserved_not_dispatched'; return STOPPED;
        }
      }
      id = String(++requestSequence);
      const packet = Object.freeze({ jsonrpc: '2.0', id, method: 'eth_sendBundle', params: Object.freeze([Object.freeze({
        txs: plan.txs, maxBlockNumber: fields.targetBlock, maxTimestamp: fields.maxTimestamp,
        noMerge: true, revertingTxHashes: Object.freeze([]),
      })]) });
      handedOffHashes.add(fields.buyTxHash);
      handedOffNonces.add(plan.walletNonceKey);
      handedOff = true;
      return transport(packet, { signal: submitSignal });
    }, timeoutMs, signal);
    const finish = outcome => {
      if (journal && reservation) {
        try {
          if (synchronous(journal.markOutcome(reservation, outcome)) !== true) throw new Error('Synchronous journal required');
        } catch { return result('unknown', 'journal_update_failed', fields); }
      }
      return outcome;
    };
    if (!handedOff) {
      if (blocked === 'previously_attempted') return attempted();
      if (blocked === 'journal_unavailable') return result('unknown', 'journal_unavailable', fields);
      if (reservation) return finish(result('unknown', 'reserved_not_dispatched', fields));
      return refused(blocked ?? 'aborted_before_submit');
    }

    try {
      if (reply?.jsonrpc === '2.0' && reply.id === id) {
        if (!Object.hasOwn(reply, 'result') && BEFORE_ACCEPTANCE_ERRORS.has(reply.error?.code)) {
          return finish(refused('builder_rejected_request'));
        }
        if (!Object.hasOwn(reply, 'error') && isHash(reply.result)) {
          const bundleHash = lower(reply.result);
          if (bundleHash !== fields.buyTxHash && !fields.mintHashes.includes(bundleHash)) {
            return finish(result('accepted', 'builder_ack', { ...fields, bundleHash }));
          }
        }
      }
    } catch { /* Never expose relay payloads, errors, URLs, or raw transactions. */ }
    // A malformed ACK, duplicate/not-found or vendor error, disconnect,
    // timeout or cancellation after handoff may still correspond to delivery.
    return finish(result('unknown', 'delivery_unverified', fields));
  };
}
