import { Transaction } from 'ethers';
import { CHAIN_ID, FACTORY } from './config.mjs';
import { verifyLaunchCandidate } from './events.mjs';
import { decodePendingMint } from './pending-mint-shadow.mjs';

const lower = x => typeof x === 'string' ? x.toLowerCase() : '';
const same = (a, b) => Boolean(lower(a)) && lower(a) === lower(b);
const isHash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const isAddress = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) && !/^0x0{40}$/i.test(x);
const quantity = x => {
  if (typeof x !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(x)) throw new Error('Malformed quantity');
  return BigInt(x);
};
const validLocalMs = n => Number.isFinite(n) && n >= 0;
const rounded = n => Math.round(n * 1000) / 1000;
const MAX_SOURCES = 8;
const MODES = new Set(['idle', 'connecting', 'subscribed_no_payload', 'full', 'mixed', 'hash_only',
  'timeout', 'payload_timeout', 'disconnected', 'error', 'unsupported', 'transport_unavailable',
  'chain_unverified', 'invalid_config', 'disabled', 'unconfigured', 'closed', 'unavailable']);

/**
 * Whether an RPC object's signature fields really serialize to the advertised
 * BSC signed tx (legacy, EIP-2930, EIP-1559). This is intentionally not a
 * simulation and cannot prove eligibility, ordering or inclusion. No raw bytes
 * or signer object leave the validator. Call only after target ABI filtering.
 */
export function hasReproducibleBscEnvelope(row) {
  try {
    if (!isHash(row?.hash) || !isHash(row.r) || !isHash(row.s) ||
        !isAddress(row.from) || !isAddress(row.to) ||
        row.blockHash != null || row.blockNumber != null || row.transactionIndex != null) return false;
    const type = Number(quantity(row.type ?? '0x0'));
    if (![0, 1, 2].includes(type)) return false;
    const v = quantity(row.v ?? row.yParity);
    const chainId = type === 0 && row.chainId == null && v >= 35n ? (v - 35n) / 2n : quantity(row.chainId);
    if (chainId !== CHAIN_ID || (type ? v > 1n : v !== CHAIN_ID * 2n + 35n && v !== CHAIN_ID * 2n + 36n)) return false;
    if (type && row.yParity != null && quantity(row.yParity) !== v) return false;
    const nonce = quantity(row.nonce);
    const gasLimit = quantity(row.gas);
    const value = quantity(row.value);
    const data = row.input ?? row.data;
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER) || gasLimit < 21_000n || gasLimit > 16_777_216n ||
        typeof data !== 'string' || data.length > 8192 || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) return false;
    const accessList = row.accessList ?? [];
    if (!Array.isArray(accessList) || accessList.length > 32 || (!type && accessList.length)) return false;
    if (accessList.some(item => !isAddress(item?.address) || !Array.isArray(item.storageKeys) ||
        item.storageKeys.length > 64 || !item.storageKeys.every(isHash))) return false;
    const fees = type === 2 ?
      { maxFeePerGas: quantity(row.maxFeePerGas), maxPriorityFeePerGas: quantity(row.maxPriorityFeePerGas) } :
      { gasPrice: quantity(row.gasPrice) };
    if (type === 2 && fees.maxPriorityFeePerGas > fees.maxFeePerGas) return false;
    const transaction = Transaction.from({ type, chainId, nonce: Number(nonce), gasLimit, to: row.to, value, data, ...fees,
      ...(type ? { accessList } : {}), signature: { r: row.r, s: row.s, v: Number(v) } });
    return same(transaction.hash, row.hash) && same(transaction.from, row.from);
  } catch { return false; }
}

/** Nearest rank; a small-sample p95 (n <= 19) is the largest observed value. */
export function pendingLeadPercentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  const p = x => n ? rounded(sorted[Math.ceil(n * x) - 1]) : null;
  return { samples: n, p50Ms: p(0.50), p95Ms: p(0.95), minMs: n ? rounded(sorted[0]) : null, maxMs: p(1) };
}

function idOf(value) {
  const id = typeof value === 'object' && value !== null ? value.source : value;
  if (Number.isSafeInteger(id) && id >= 1 && id <= 999) return id;
  if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id)) return id;
  throw new Error('来源只允许不含地址或凭据的编号或短标签');
}
function cap(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('观测容量配置无效');
  return value;
}
function earlier(a, b) {
  return a == null || b.seen < a.seen ? b : a;
}
function firstOf(values) {
  return values.reduce((first, value) => value ? earlier(first, value) : first, undefined);
}
function take(map, key, value, max) {
  if (!map.has(key) && map.size >= max) {
    map.delete(map.keys().next().value);
    map.set(key, value);
    return true;
  }
  map.set(key, value);
  return false;
}
const inclusionKey = row => [row.mint, row.blockHash, row.txHash].join(':');
const mintTxKey = (mint, tx) => mint + ':' + tx;

/**
 * Read-only source comparator. Use sources (numeric feed slots or plain short
 * labels), not endpoint URLs. All times use this process's monotonic clock.
 * A confirmation arrival counts only after receipt + canonical block proof;
 * retries never shift its first-observation time. Late arrivals remain
 * measurable without becoming early coverage. Only sanitized hashes, timing,
 * classifications and source counters are stored, never the pending payload.
 */
export function makeSnipePendingCompare({
  provider, targets, armBlock, sources, sourceStatus = () => ({}), onObservation,
  clock = () => performance.now(), wallClock = Date.now, verify = verifyLaunchCandidate,
  limits = {},
}) {
  if (!provider || typeof provider.getBlock !== 'function' || typeof verify !== 'function' ||
      !Number.isSafeInteger(armBlock) || armBlock < 0 ||
      !Array.isArray(targets) || !targets.length || targets.length > 32 || !Array.isArray(sources) ||
      !sources.length || sources.length > MAX_SOURCES || typeof sourceStatus !== 'function') throw new Error('观测项目、来源或起始区块无效');
  const pendingCap = cap(limits.pendingPerSource ?? 4096, 16384);
  const hashesCap = cap(limits.hashesPerSource ?? 4096, 16384);
  const launchCap = cap(limits.inclusions ?? 256, 1024);
  const byMint = new Map(), tokenSet = new Set(), bySource = new Map();
  for (const target of targets) {
    if (!same(target?.factory, FACTORY) || !isAddress(target.mint) || !isAddress(target.token) ||
        same(target.mint, target.token) || byMint.has(lower(target.mint)) || tokenSet.has(lower(target.token))) {
      throw new Error('需要 1–32 个明确指定且不重复的 Corla v4 项目');
    }
    byMint.set(lower(target.mint), { ...target });
    tokenSet.add(lower(target.token));
  }
  for (const value of sources) {
    const source = idOf(value);
    if (bySource.has(String(source))) throw new Error('来源编号不能重复');
    bySource.set(String(source), { source, pending: new Map(), hashes: new Map(),
      matchingMessages: 0, signedMessages: 0, hashOnlyMessages: 0, evictedMatching: 0, evictedHashes: 0 });
  }
  const launches = new Map(), removed = new Set(), byInclusionTx = new Map(), byTxHash = new Map();
  let droppedInclusions = 0, droppedRemovals = 0;

  function timestamp(meta) {
    const now = clock();
    const seen = validLocalMs(meta?.seen) && meta.seen <= now ? meta.seen : now;
    const receivedAtMs = Number.isSafeInteger(meta?.receivedAtMs) && meta.receivedAtMs >= 0 ? meta.receivedAtMs : wallClock();
    return { seen, ...(Number.isSafeInteger(receivedAtMs) && receivedAtMs >= 0 ? { receivedAtMs } : {}) };
  }

  function noticeTimestamp(candidate) {
    const now = clock(), wallNow = wallClock();
    const ts = candidate.observedAtMonotonicMs;
    const wall = candidate.observedAtMs;
    const trustedWall = Number.isSafeInteger(wall) && wall >= 0 && Number.isSafeInteger(wallNow) &&
      wallNow >= wall && wallNow - wall <= 5000;
    if (validLocalMs(ts) && ts <= now) {
      return { seen: ts, timeBasis: 'received_monotonic', receivedAtMs: trustedWall ? wall : undefined };
    }
    if (trustedWall && now >= wallNow - wall) {
      return { seen: now - (wallNow - wall), timeBasis: 'wall_derived', receivedAtMs: wall };
    }
    return { seen: now, timeBasis: 'candidate_callback', receivedAtMs: Number.isSafeInteger(wallNow) ? wallNow : undefined };
  }

  function update(row, source, fields) {
    const slot = row.sources.get(source);
    if (!slot) return;
    for (const [field, value] of Object.entries(fields)) if (value) slot[field] = earlier(slot[field], value);
  }

  function observePending(source, tx, meta) {
    const entry = bySource.get(String(source));
    if (!entry) return false;
    const matched = decodePendingMint(tx, byMint);
    if (!matched) return false;
    const time = timestamp(meta);
    const key = mintTxKey(matched.mint, matched.hash);
    const prev = entry.pending.get(key);
    const next = { full: earlier(prev?.full, time), signed: prev?.signed };
    entry.matchingMessages++;
    // The same already-verified bytes need no repeated signature recovery
    // unless this callback expressly has an earlier timestamp.
    if ((!next.signed || time.seen < next.signed.seen) && hasReproducibleBscEnvelope(tx)) {
      next.signed = time;
      entry.signedMessages++;
    }
    if (take(entry.pending, key, next, pendingCap)) entry.evictedMatching++;
    for (const row of byInclusionTx.get(key) ?? []) update(row, String(entry.source), next);
    return true;
  }

  function observeHash(source, hash, meta) {
    const entry = bySource.get(String(source));
    if (!entry || !isHash(hash)) return false;
    const key = lower(hash), time = earlier(entry.hashes.get(key), timestamp(meta));
    entry.hashOnlyMessages++;
    if (take(entry.hashes, key, time, hashesCap)) entry.evictedHashes++;
    for (const row of byTxHash.get(key) ?? []) update(row, String(entry.source), { hash: time });
    return true;
  }

  function validatedCandidate(candidate) {
    const mint = lower(candidate?.mint), token = lower(candidate?.token);
    const target = byMint.get(mint);
    if (!target || !same(target.token, token) || !same(candidate.factory ?? candidate.target?.factory, FACTORY) ||
        !isHash(candidate.txHash) || !isHash(candidate.blockHash) || !Number.isSafeInteger(candidate.blockNumber) ||
        candidate.blockNumber <= armBlock) return null;
    return { mint, token, txHash: lower(candidate.txHash), blockHash: lower(candidate.blockHash), block: candidate.blockNumber, target };
  }

  function onRemoved(candidate) {
    const checked = validatedCandidate(candidate);
    if (!checked) return false;
    const key = inclusionKey(checked);
    const saved = launches.get(key);
    if (saved) { saved.removed = true; return true; }
    if (!removed.has(key) && removed.size >= launchCap) { droppedRemovals++; return false; }
    removed.add(key);
    return true;
  }

  function healthFor(source) {
    try {
      const status = sourceStatus(source);
      return { healthy: status?.healthy === true, mode: MODES.has(status?.mode) ? status.mode : 'unavailable',
        fullPayload: status?.hasFullPayload === true };
    } catch { return { healthy: false, mode: 'unavailable', fullPayload: false }; }
  }

  const classify = lead => lead == null ? 'unseen' : lead > 0 ? 'early' : lead < 0 ? 'late' : 'coincident';
  function timing(notice, first) {
    const lead = first ? notice.seen - first.seen : null;
    return { classification: classify(lead), leadMs: lead == null ? null : rounded(lead),
      ...(first?.receivedAtMs === undefined ? {} : { receivedAtMs: first.receivedAtMs }) };
  }
  function launchOutput(row) {
    const summaries = [...row.sources.values()].map(slot => ({
      source: slot.source, modeAtNotice: slot.health.mode, healthyAtNotice: slot.health.healthy,
      fullPayloadAtNotice: slot.health.fullPayload, firstHashOnly: timing(row.notice, slot.hash),
      firstExactMint: timing(row.notice, slot.full), firstSignedEnvelope: timing(row.notice, slot.signed),
    }));
    const firstSigned = firstOf([...row.sources.values()].map(slot => slot.signed));
    return { mint: row.mint, token: row.token, txHash: row.txHash, blockHash: row.blockHash, block: row.block,
      confirmationSource: row.confirmationSource, noticeTimeBasis: row.notice.timeBasis,
      noticeReceivedAtMs: row.notice.receivedAtMs, verificationMs: row.verificationMs,
      firstSignedEnvelope: timing(row.notice, firstSigned), sources: summaries };
  }

  async function onCandidate(candidate) {
    const checked = validatedCandidate(candidate);
    if (!checked) return;
    if (candidate.removed) { onRemoved(candidate); return; }
    const key = inclusionKey(checked);
    if (removed.has(key)) return;
    let row = launches.get(key);
    if (!row) {
      if (launches.size >= launchCap) { droppedInclusions++; return; }
      const exact = mintTxKey(checked.mint, checked.txHash);
      row = { mint: checked.mint, token: checked.token, txHash: checked.txHash, blockHash: checked.blockHash, block: checked.block,
        notice: noticeTimestamp(candidate), confirmationSource: candidate.source === 'ws' ? 'ws' : candidate.source === 'http' ? 'http' : 'unknown',
        sources: new Map() };
      launches.set(key, row);
      if (!byInclusionTx.has(exact)) byInclusionTx.set(exact, new Set());
      byInclusionTx.get(exact).add(row);
      if (!byTxHash.has(checked.txHash)) byTxHash.set(checked.txHash, new Set());
      byTxHash.get(checked.txHash).add(row);
      for (const [slot, entry] of bySource) {
        row.sources.set(slot, { source: entry.source, health: healthFor(entry.source), ...entry.pending.get(exact),
          hash: entry.hashes.get(checked.txHash) });
      }
    }
    if (row.removed || row.proved) return;
    if (row.inFlight) return row.inFlight;
    const once = Promise.resolve().then(async () => {
      try {
        const [proof, block] = await Promise.all([verify(provider, { ...candidate, target: checked.target }),
          provider.getBlock(row.block)]);
        if (row.removed) return;
        if (!proof || block?.number !== row.block || !same(block.hash, row.blockHash)) return false;
        row.proved = true;
        row.verificationMs = rounded(Math.max(0, clock() - row.notice.seen));
        try { onObservation?.(launchOutput(row)); } catch { /* metrics only */ }
      } catch { return false; }
    });
    row.inFlight = once;
    try { return await once; } finally { if (row.inFlight === once) row.inFlight = null; }
  }

  function counts(timings, count) {
    const early = timings.filter(t => t.classification === 'early');
    return { early: early.length, late: timings.filter(t => t.classification === 'late').length,
      coincident: timings.filter(t => t.classification === 'coincident').length,
      unseen: timings.filter(t => t.classification === 'unseen').length,
      missedBeforeNotice: count - early.length,
      earlyCoveragePct: count ? rounded(100 * early.length / count) : null,
      leadMs: pendingLeadPercentiles(timings.map(t => t.leadMs)),
      positiveLeadMs: pendingLeadPercentiles(early.map(t => t.leadMs)) };
  }

  async function summarize() {
    const observed = [...launches.values()];
    const heights = [...new Set(observed.filter(r => r.proved && !r.removed).map(r => r.block))];
    const blocks = new Map();
    for (let i = 0; i < heights.length; i += 8) await Promise.all(heights.slice(i, i + 8).map(async block => {
      try { blocks.set(block, await provider.getBlock(block)); } catch { blocks.set(block, null); }
    }));
    const canonical = [];
    let unverified = 0, displacedOrRemoved = removed.size;
    for (const row of observed) {
      const block = blocks.get(row.block);
      if (row.removed) displacedOrRemoved++;
      else if (!row.proved || block?.number !== row.block || !isHash(block?.hash)) unverified++;
      else if (!same(block.hash, row.blockHash)) displacedOrRemoved++;
      else canonical.push(row);
    }
    // A Corla Mint cannot legitimately launch twice on a canonical chain.
    const seen = new Map();
    for (const row of canonical) seen.set(row.mint, (seen.get(row.mint) ?? 0) + 1);
    const rows = canonical.filter(row => seen.get(row.mint) === 1).sort((a, b) => a.block - b.block).map(launchOutput);
    const conflicts = canonical.length - rows.length;
    const sourceMetrics = [...bySource.values()].map(entry => {
      const slots = rows.map(row => row.sources.find(slot => slot.source === entry.source));
      const healthy = slots.filter(slot => slot.healthyAtNotice);
      return { source: entry.source, matchingMessages: entry.matchingMessages, verifiedSignedArrivals: entry.signedMessages,
        hashOnlyMessages: entry.hashOnlyMessages, evictedMatchingHashes: entry.evictedMatching,
        evictedHashOnlyHashes: entry.evictedHashes, launchesWhileHealthy: healthy.length,
        hashOnly: counts(slots.map(slot => slot.firstHashOnly), rows.length),
        exactMint: counts(slots.map(slot => slot.firstExactMint), rows.length),
        signedEnvelope: counts(slots.map(slot => slot.firstSignedEnvelope), rows.length),
        signedEnvelopeWhileHealthy: counts(healthy.map(slot => slot.firstSignedEnvelope), healthy.length) };
    });
    return {
      result: rows.length ? 'measured' : 'no_canonical_launch_samples',
      trackedTargets: byMint.size, sources: sourceMetrics, trackedInclusions: observed.length,
      canonicalLaunches: rows.length, noProofAtEnd: unverified, displacedOrRemoved, conflictingCanonicalInclusions: conflicts,
      droppedInclusions, droppedRemovals,
      signedEnvelopeAnySource: counts(rows.map(row => row.firstSignedEnvelope), rows.length),
      launches: rows,
      interpretation: '提前量 = 本进程最先收到且随后通过主链验证的开盘通知时间 − 对应来源首见同一交易哈希时间，正值表示本地更早，不证明早于封块。无有效开盘样本时覆盖率为 null；漏见可能来自数据源范围、丢包、非标准调用、缺签名字段或缓存淘汰，不证明交易走私有通道。签名一致不证明可成交。p50/p95 按最近秩计算，少于 20 个样本时 p95 等于样本最大值。',
    };
  }
  return { observePending, observeHash, onCandidate, onRemoved, summarize };
}
