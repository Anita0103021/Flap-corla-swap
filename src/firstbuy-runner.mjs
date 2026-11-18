import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Interface, Transaction, ZeroAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const FIRSTBUY_ABI = new Interface([
  'function execute(bytes32 intentId) returns (bool bought)',
  'event Filled(bytes32 indexed intentId,address indexed mint,address indexed token,address recipient,uint256 amountIn,uint256 amountOut)',
  'event AttemptResult(bytes32 indexed intentId,uint16 attempt,bool bought,uint256 amountOut,bytes32 reasonHash)',
]);
const HASH = /^0x[0-9a-f]{64}$/i, INTENT = /^[0-9a-f]{64}$/;
const lower = v => typeof v === 'string' ? v.toLowerCase() : '';
const same = (a, b) => Boolean(lower(a)) && lower(a) === lower(b);
const isInt = n => Number.isSafeInteger(n) && n >= 0;
const terminal = new Set(['filled', 'missed', 'cancelled', 'exhausted', 'expired', 'stopped', 'invalid_receipt']);
const failure = code => Object.assign(new Error(code), { code });
const guard = (condition, code = 'FIRSTBUY_INVALID_PLAN') => { if (!condition) throw failure(code); };
const addr = value => { const v = getAddress(value); guard(v !== ZeroAddress); return v; };
const uint = value => { guard(typeof value === 'bigint' && value >= 0n && value < 1n << 256n); return value; };

export function checkedFirstBuyPlan(input) {
  const plan = {
    contract: addr(input?.contract), mint: addr(input?.mint), token: addr(input?.token), recipient: addr(input?.recipient),
    intentId: lower(input?.intentId), expectedCodeHash: lower(input?.expectedCodeHash),
    amountIn: uint(input?.amountIn), minOut: uint(input?.minOut), gasLimit: uint(input?.gasLimit), gasPrice: uint(input?.gasPrice),
    maxGasWei: uint(input?.maxGasWei), maxAttempts: input?.maxAttempts,
    startBlock: input?.startBlock, endBlock: input?.endBlock, deadline: input?.deadline,
    intervalMs: input?.intervalMs ?? 350,
  };
  guard(HASH.test(plan.intentId) && !/^0x0{64}$/.test(plan.intentId) && HASH.test(plan.expectedCodeHash) &&
    !/^0x0{64}$/.test(plan.expectedCodeHash) && plan.mint !== plan.token && plan.contract !== plan.token &&
    plan.amountIn > 0n && plan.minOut > 0n && plan.gasLimit >= 141_000n && plan.gasLimit <= 5_000_000n &&
    plan.gasPrice > 0n && plan.gasPrice <= 100_000_000_000n && plan.maxGasWei >= plan.gasLimit * plan.gasPrice &&
    isInt(plan.maxAttempts) && plan.maxAttempts >= 1 && plan.maxAttempts <= 1024 &&
    isInt(plan.startBlock) && isInt(plan.endBlock) && plan.endBlock >= plan.startBlock &&
    plan.endBlock - plan.startBlock <= 100_000 && isInt(plan.deadline) && plan.deadline > 0 &&
    isInt(plan.intervalMs) && plan.intervalMs >= 100 && plan.intervalMs <= 30_000);
  plan.calldata = FIRSTBUY_ABI.encodeFunctionData('execute', [plan.intentId]);
  const encoded = JSON.stringify(plan, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  plan.sessionId = keccak256(toUtf8Bytes(encoded)).slice(2);
  return Object.freeze(plan);
}

const schema = `
CREATE TABLE IF NOT EXISTS firstbuy_sessions (
  session_id TEXT PRIMARY KEY, contract TEXT NOT NULL, intent_id TEXT NOT NULL, mint TEXT NOT NULL,
  plan_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, gas_reserved TEXT NOT NULL,
  updated_at TEXT NOT NULL, UNIQUE(contract,intent_id)
) STRICT;
CREATE TABLE IF NOT EXISTS firstbuy_wallet_leases (
  wallet TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES firstbuy_sessions(session_id)
) STRICT;
CREATE TABLE IF NOT EXISTS firstbuy_attempts (
  session_id TEXT NOT NULL REFERENCES firstbuy_sessions(session_id), ordinal INTEGER NOT NULL,
  wallet TEXT NOT NULL, action_id TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE, gas_reserved TEXT NOT NULL,
  outcome TEXT NOT NULL, PRIMARY KEY(session_id,ordinal), UNIQUE(wallet,action_id)
) STRICT;`;

/** Explicitly shares the original executor database. Never creates/migrates its
 * core tables. The legacy executor must also check firstbuy_wallet_leases in
 * its stage transaction; this module does not claim otherwise. */
export function openFirstBuyJournal({ journalPath } = {}) {
  guard(typeof journalPath === 'string' && isAbsolute(journalPath), 'FIRSTBUY_EXISTING_JOURNAL_REQUIRED');
  let db;
  try {
    const file = realpathSync(journalPath), entry = lstatSync(journalPath);
    guard(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, 'FIRSTBUY_JOURNAL_UNAVAILABLE');
    db = new DatabaseSync(file, { timeout: 100 });
    db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    guard(['wallet','action_id','tx_hash','nonce','status','updated_at'].every(c => columns('actions').includes(c)) &&
      ['tx_hash','block_height','block_hash','orphaned','stable'].every(c => columns('receipt_evidence').includes(c)) &&
      ['wallet','action_id'].every(c => columns('one_shot_refusals').includes(c)) &&
      ['wallet','base_action_id'].every(c => columns('race_attempts').includes(c)) &&
      db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='pending_wallet'").get()?.sql?.includes("status = 'pending'"),
      'FIRSTBUY_EXECUTOR_SCHEMA_REQUIRED');
    db.exec(schema);
  } catch {
    try { db?.close(); } catch {}
    throw failure('FIRSTBUY_JOURNAL_UNAVAILABLE');
  }
  let closed = false;
  const ensure = () => guard(!closed, 'FIRSTBUY_JOURNAL_CLOSED');
  const now = () => new Date().toISOString();
  const baseFor = plan => `bsc56:${plan.mint.toLowerCase()}:buy`;
  const encode = plan => JSON.stringify(plan, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  const session = id => db.prepare('SELECT * FROM firstbuy_sessions WHERE session_id=?').get(id);
  const joined = `SELECT a.*, f.ordinal, f.outcome, f.session_id, e.block_height,e.block_hash,e.orphaned,e.stable
    FROM firstbuy_attempts f JOIN actions a ON a.wallet=f.wallet AND a.action_id=f.action_id
    LEFT JOIN receipt_evidence e ON e.tx_hash=a.tx_hash`;
  function transaction(work) {
    ensure(); db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function acquire(plan, wallet) {
    wallet = addr(wallet);
    return transaction(() => {
      const original = db.prepare('SELECT * FROM firstbuy_sessions WHERE contract=? AND intent_id=?').get(plan.contract, plan.intentId);
      guard(!original || original.session_id === plan.sessionId && original.plan_json === encode(plan), 'FIRSTBUY_INTENT_CHANGED');
      // A stopped plan can still be inspected/reconciled after its lease was
      // released without reopening a previously spent ordinary-buy ID.
      if (original && terminal.has(original.status)) return original;
      const lease = db.prepare('SELECT session_id FROM firstbuy_wallet_leases WHERE wallet=?').get(wallet);
      guard(!lease || lease.session_id === plan.sessionId, 'FIRSTBUY_WALLET_LEASED');
      const own = db.prepare('SELECT 1 FROM firstbuy_attempts WHERE session_id=? AND wallet=? LIMIT 1').get(plan.sessionId, wallet);
      const base = baseFor(plan);
      const spent = db.prepare('SELECT 1 FROM actions WHERE wallet=? AND action_id=?').get(wallet, base) ||
        db.prepare('SELECT 1 FROM race_attempts WHERE wallet=? AND base_action_id=?').get(wallet, base) ||
        db.prepare('SELECT 1 FROM one_shot_refusals WHERE wallet=? AND action_id=?').get(wallet, base);
      guard(own || lease || !spent, 'FIRSTBUY_PROJECT_ALREADY_ATTEMPTED');
      const pending = db.prepare(`SELECT a.tx_hash FROM actions a LEFT JOIN receipt_evidence e ON a.tx_hash=e.tx_hash
        WHERE a.wallet=? AND (a.status='pending' OR e.orphaned=1) LIMIT 1`).get(wallet);
      if (pending) guard(db.prepare('SELECT 1 FROM firstbuy_attempts WHERE session_id=? AND tx_hash=?').get(plan.sessionId, pending.tx_hash), 'FIRSTBUY_WALLET_PENDING');
      if (!original) db.prepare('INSERT INTO firstbuy_sessions VALUES(?,?,?,?,?,\'active\',0,\'0\',?)')
        .run(plan.sessionId, plan.contract, plan.intentId, plan.mint, encode(plan), now());
      if (!lease && !terminal.has(original?.status)) {
        db.prepare('INSERT INTO firstbuy_wallet_leases VALUES(?,?)').run(wallet, plan.sessionId);
      }
      return session(plan.sessionId);
    });
  }
  function stage(plan, wallet, hash, nonce) {
    guard(HASH.test(hash ?? '') && isInt(nonce), 'FIRSTBUY_INVALID_STAGE'); wallet = addr(wallet);
    return transaction(() => {
      const s = session(plan.sessionId), lease = db.prepare('SELECT * FROM firstbuy_wallet_leases WHERE wallet=?').get(wallet);
      guard(s?.status === 'active' && lease?.session_id === plan.sessionId, 'FIRSTBUY_NOT_ACTIVE');
      guard(s.plan_json === encode(plan), 'FIRSTBUY_INTENT_CHANGED');
      guard(s.attempts < plan.maxAttempts && BigInt(s.gas_reserved) + plan.gasLimit * plan.gasPrice <= plan.maxGasWei, 'FIRSTBUY_BUDGET_EXHAUSTED');
      const pending = db.prepare(`SELECT 1 FROM actions a LEFT JOIN receipt_evidence e ON a.tx_hash=e.tx_hash
        WHERE a.wallet=? AND (a.status='pending' OR e.orphaned=1) LIMIT 1`).get(wallet);
      guard(!pending, 'FIRSTBUY_WALLET_PENDING');
      const maxNonce = db.prepare('SELECT max(nonce) AS n FROM actions WHERE wallet=?').get(wallet).n;
      guard(maxNonce === null || nonce > maxNonce, 'FIRSTBUY_NONCE_ROLLBACK');
      const ordinal = s.attempts + 1, actionId = `${baseFor(plan)}:firstbuy:${plan.intentId.slice(2)}:${ordinal}`;
      const gas = plan.gasLimit * plan.gasPrice;
      db.prepare("INSERT INTO actions VALUES(?,?,?,?,'pending',?)").run(wallet, actionId, hash.toLowerCase(), nonce, now());
      db.prepare("INSERT INTO firstbuy_attempts VALUES(?,?,?,?,?,?,'pending')")
        .run(plan.sessionId, ordinal, wallet, actionId, hash.toLowerCase(), gas.toString());
      db.prepare('INSERT OR IGNORE INTO one_shot_refusals VALUES(?,?)').run(wallet, baseFor(plan));
      db.prepare('UPDATE firstbuy_sessions SET attempts=?,gas_reserved=?,updated_at=? WHERE session_id=?')
        .run(ordinal, (BigInt(s.gas_reserved) + gas).toString(), now(), plan.sessionId);
      return db.prepare(joined + ' WHERE f.tx_hash=?').get(hash.toLowerCase());
    });
  }
  function finish(row, receipt, outcome, depth) {
    return transaction(() => {
      guard(['not_filled','filled','reverted','invalid_receipt'].includes(outcome) && (receipt.status === 0 || receipt.status === 1), 'FIRSTBUY_INVALID_OUTCOME');
      db.prepare('UPDATE actions SET status=?,updated_at=? WHERE tx_hash=?').run(receipt.status ? 'confirmed' : 'failed', now(), row.tx_hash);
      db.prepare(`INSERT INTO receipt_evidence VALUES(?,?,?,0,?) ON CONFLICT(tx_hash) DO UPDATE SET
        block_height=excluded.block_height,block_hash=excluded.block_hash,orphaned=0,stable=excluded.stable`)
        .run(row.tx_hash, receipt.blockNumber, receipt.blockHash.toLowerCase(), Number(depth >= 12));
      db.prepare('UPDATE firstbuy_attempts SET outcome=? WHERE tx_hash=?').run(outcome, row.tx_hash);
      return db.prepare(joined + ' WHERE f.tx_hash=?').get(row.tx_hash);
    });
  }
  function markTerminal(id, state) {
    guard(terminal.has(state), 'FIRSTBUY_INVALID_STATUS');
    return transaction(() => {
      db.prepare("UPDATE firstbuy_sessions SET status=?,updated_at=? WHERE session_id=? AND status='active'").run(state, now(), id);
      db.prepare(`DELETE FROM firstbuy_wallet_leases WHERE session_id=? AND wallet NOT IN
        (SELECT a.wallet FROM actions a JOIN firstbuy_attempts f ON a.tx_hash=f.tx_hash LEFT JOIN receipt_evidence e ON e.tx_hash=a.tx_hash
        WHERE f.session_id=? AND (a.status='pending' OR e.orphaned=1))`).run(id, id);
      return session(id);
    });
  }
  return Object.freeze({ acquire, stage, finish, markTerminal,
    status(id) { ensure(); return session(id); },
    pending(id, wallet) { ensure(); return db.prepare(joined + " WHERE f.session_id=? AND a.wallet=? AND (a.status='pending' OR e.orphaned=1) ORDER BY f.ordinal LIMIT 1").get(id, addr(wallet)); },
    recent(wallet) { ensure(); return db.prepare(`SELECT a.*,e.block_height,e.block_hash,e.orphaned,e.stable FROM actions a
      JOIN receipt_evidence e ON e.tx_hash=a.tx_hash WHERE a.wallet=? AND (e.stable=0 OR e.orphaned=1)`).all(addr(wallet)); },
    orphan(row) { return transaction(() => db.prepare('UPDATE receipt_evidence SET orphaned=1,stable=0 WHERE tx_hash=?').run(row.tx_hash)); },
    stable(row) { return transaction(() => db.prepare('UPDATE receipt_evidence SET stable=1 WHERE tx_hash=?').run(row.tx_hash)); },
    close() { if (!closed) { closed = true; db.close(); } },
  });
}

function outcomeFor(receipt, plan) {
  if (receipt.status === 0) return 'reverted';
  const logs = receipt.logs?.filter(row => same(row.address, plan.contract) && !row.removed) ?? [];
  const parsed = logs.flatMap(row => { try { return [FIRSTBUY_ABI.parseLog(row)]; } catch { return []; } }).filter(Boolean);
  const filled = parsed.filter(row => row.name === 'Filled' && same(row.args.intentId, plan.intentId));
  const attempts = parsed.filter(row => row.name === 'AttemptResult' && same(row.args.intentId, plan.intentId));
  if (attempts.length !== 1) return 'invalid_receipt';
  const result = attempts[0].args;
  if (result.bought === false && result.amountOut === 0n && filled.length === 0) return 'not_filled';
  if (result.bought && filled.length === 1) {
    const row = filled[0].args;
    if (same(row.mint, plan.mint) && same(row.token, plan.token) && same(row.recipient, plan.recipient) &&
        row.amountIn === plan.amountIn && row.amountOut >= plan.minOut && result.amountOut === row.amountOut) return 'filled';
  }
  return 'invalid_receipt';
}

/** No network/signing by default. Dependencies are explicit and the caller must
 * verify the deployed artifact/immutable arm parameters in readState. Runs one
 * nonce lane, not an unbounded or parallel-nonce spray. */
export function makeFirstBuyRunner({ plan: supplied, journal, provider, signer, readState, transport, signal, log = () => {}, services = {} } = {}) {
  const plan = checkedFirstBuyPlan(supplied);
  const { nowSeconds = () => Math.floor(Date.now() / 1000), monotonic = () => performance.now(), delay = sleep, submitTimeoutMs = 700 } = services;
  guard(isInt(submitTimeoutMs) && submitTimeoutMs >= 1 && submitTimeoutMs <= 5000, 'FIRSTBUY_INVALID_TIMEOUT');
  const wallet = signer?.address ? addr(signer.address) : undefined;
  const enabled = Boolean(journal && provider && wallet && typeof signer.signTransaction === 'function' &&
    typeof readState === 'function' && typeof transport === 'function');
  let phase = 'idle', inFlight, nextAt = 0, stopping = false;
  const stopped = () => stopping || signal?.aborted;
  const emit = (event, fields) => { try { log(event, { mint: plan.mint, token: plan.token, intentId: plan.intentId,
    contract: plan.contract, to: plan.contract, ...fields }); } catch {} };
  const snapshot = extra => {
    let saved;
    try { saved = journal?.status(plan.sessionId); } catch { /* closed/broken journal cannot enable submission */ }
    return { phase, sessionId: plan.sessionId, ...(saved ? { attempts: saved.attempts, gasReserved: saved.gas_reserved } : {}), ...extra };
  };
  const readHead = async () => {
    const head = await provider.getBlock('latest');
    guard(isInt(head?.number) && HASH.test(head.hash ?? '') && isInt(head.timestamp), 'FIRSTBUY_HEAD_UNVERIFIED');
    return head;
  };
  async function reconcile(row, head) {
    const receipt = await provider.getTransactionReceipt(row.tx_hash);
    if (!receipt || !same(receipt.hash ?? receipt.transactionHash, row.tx_hash) || !same(receipt.from, wallet) ||
        !same(receipt.to, plan.contract) || ![0,1].includes(receipt.status) || !isInt(receipt.blockNumber) ||
        !HASH.test(receipt.blockHash ?? '')) return false;
    const block = await provider.getBlock(receipt.blockNumber);
    if (block?.number !== receipt.blockNumber || !same(block.hash, receipt.blockHash) || head.number < receipt.blockNumber) return false;
    const depth = head.number - receipt.blockNumber + 1, outcome = outcomeFor(receipt, plan);
    if (outcome === 'filled') {
      // Stop immediately, even before the successful receipt matures.
      journal.markTerminal(plan.sessionId, 'filled'); phase = 'filled';
      if (depth < 3) return false;
    }
    journal.finish(row, receipt, outcome, depth);
    if (outcome === 'filled' || outcome === 'invalid_receipt') journal.markTerminal(plan.sessionId, outcome);
    let amountOut;
    if(outcome==='filled')for(const log of receipt.logs??[])if(same(log.address,plan.contract))try{
      const item=FIRSTBUY_ABI.parseLog(log);if(item?.name==='Filled'&&same(item.args.intentId,plan.intentId))amountOut=item.args.amountOut;
    }catch{}
    emit('firstbuy_receipt', { txHash: row.tx_hash, attempt: row.ordinal, status: outcome, receiptBlock: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash, ...(isInt(receipt.index??receipt.transactionIndex)?{receiptIndex:receipt.index??receipt.transactionIndex}:{}),
      bought: outcome==='filled', ...(amountOut===undefined?{}:{amountOut}), confirmations: depth });
    return true;
  }
  async function work() {
    if (!enabled) { phase = 'disabled'; return snapshot(); }
    journal.acquire(plan, wallet);
    const head = await readHead();
    const pending = journal.pending(plan.sessionId, wallet);
    if (pending && !await reconcile(pending, head)) {
      phase = journal.status(plan.sessionId).status === 'filled' ? 'filled' : 'pending';
      return snapshot({ txHash: pending.tx_hash, unresolved: true });
    }
    let current = journal.status(plan.sessionId);
    if (terminal.has(current.status)) { journal.markTerminal(plan.sessionId, current.status); phase = current.status; return snapshot(); }
    if (stopped()) { phase = 'stopped'; journal.markTerminal(plan.sessionId, phase); return snapshot(); }
    const now = nowSeconds();
    guard(isInt(now), 'FIRSTBUY_CLOCK_UNVERIFIED');
    if (now >= plan.deadline || head.timestamp >= plan.deadline || head.number > plan.endBlock) {
      phase = 'expired'; journal.markTerminal(plan.sessionId, phase); return snapshot();
    }
    if (current.attempts >= plan.maxAttempts || BigInt(current.gas_reserved) + plan.gasLimit * plan.gasPrice > plan.maxGasWei) {
      phase = 'exhausted'; journal.markTerminal(plan.sessionId, phase); return snapshot();
    }
    if (head.number < plan.startBlock || monotonic() < nextAt) { phase = 'waiting'; return snapshot(); }
    guard(BigInt((await provider.getNetwork()).chainId) === 56n, 'FIRSTBUY_WRONG_NETWORK');
    const state = await readState({ plan, head, signal });
    guard(same(state?.contract, plan.contract) && same(state.intentId, plan.intentId) && same(state.codeHash, plan.expectedCodeHash), 'FIRSTBUY_ARM_UNVERIFIED');
    if (terminal.has(state.state)) { phase = state.state; journal.markTerminal(plan.sessionId, phase); return snapshot(); }
    guard(state.state === 'armed' && isInt(state.attempts) && state.attempts < plan.maxAttempts, 'FIRSTBUY_ARM_UNVERIFIED');
    const recent = journal.recent(wallet);
    const canonical = await Promise.all(recent.map(async row => {
      const block = await provider.getBlock(row.block_height);
      if (!block || block.number !== row.block_height || !HASH.test(block.hash ?? '')) throw failure('FIRSTBUY_RECEIPT_UNVERIFIED');
      if (!same(block.hash, row.block_hash)) { journal.orphan(row); return false; }
      if (head.number - row.block_height + 1 >= 12) journal.stable(row);
      return !row.orphaned;
    }));
    guard(canonical.every(Boolean), 'FIRSTBUY_RECEIPT_REORG');
    const [latestNonce, pendingNonce, balance] = await Promise.all([
      provider.getTransactionCount(wallet, 'latest'), provider.getTransactionCount(wallet, 'pending'), provider.getBalance(wallet),
    ]);
    guard(isInt(latestNonce) && latestNonce === pendingNonce, 'FIRSTBUY_NONCE_PENDING');
    guard(typeof balance === 'bigint' && balance >= plan.gasLimit * plan.gasPrice, 'FIRSTBUY_GAS_BALANCE');
    const request = { chainId: 56, type: 0, to: plan.contract, data: plan.calldata, value: 0n,
      nonce: latestNonce, gasLimit: plan.gasLimit, gasPrice: plan.gasPrice };
    const raw = await signer.signTransaction(request);
    guard(typeof raw === 'string' && raw.length <= 8192, 'FIRSTBUY_SIGNED_PLAN_CHANGED');
    const signed = Transaction.from(raw);
    guard(signed.isSigned() && same(signed.from, wallet) && signed.chainId === 56n && signed.type === 0 &&
      same(signed.to, plan.contract) && signed.data === plan.calldata && signed.value === 0n &&
      signed.nonce === latestNonce && signed.gasLimit === plan.gasLimit && signed.gasPrice === plan.gasPrice, 'FIRSTBUY_SIGNED_PLAN_CHANGED');
    if (stopped() || nowSeconds() >= plan.deadline) { phase = 'stopped'; journal.markTerminal(plan.sessionId, phase); return snapshot(); }
    const dispatchHead = await readHead();
    if (dispatchHead.number > plan.endBlock || dispatchHead.timestamp >= plan.deadline || nowSeconds() >= plan.deadline) {
      phase = 'expired'; journal.markTerminal(plan.sessionId, phase); return snapshot();
    }
    const [before, finalLatestNonce, finalPendingNonce] = await Promise.all([
      readState({ plan, head: dispatchHead, signal }), provider.getTransactionCount(wallet, 'latest'), provider.getTransactionCount(wallet, 'pending'),
    ]);
    guard(same(before?.contract, plan.contract) && same(before.intentId, plan.intentId) && same(before.codeHash, plan.expectedCodeHash), 'FIRSTBUY_ARM_UNVERIFIED');
    if (terminal.has(before.state)) { phase = before.state; journal.markTerminal(plan.sessionId, phase); return snapshot(); }
    guard(before.state === 'armed', 'FIRSTBUY_ARM_UNVERIFIED');
    guard(finalLatestNonce === latestNonce && finalPendingNonce === latestNonce, 'FIRSTBUY_NONCE_CHANGED');
    if (stopped() || nowSeconds() >= plan.deadline) { phase = 'stopped'; journal.markTerminal(plan.sessionId, phase); return snapshot(); }
    const row = journal.stage(plan, wallet, signed.hash, signed.nonce);
    phase = 'pending'; nextAt = monotonic() + plan.intervalMs;
    emit('firstbuy_send', { txHash: signed.hash, attempt: row.ordinal, gasReserved: (plan.gasLimit * plan.gasPrice).toString() });
    // Hash and worst-case fee are durably reserved before any handoff. Any
    // error/invalid ACK after invocation remains pending under this same hash.
    const controller = new AbortController();
    let stopResolve;
    const stoppedDelivery = new Promise(resolve => { stopResolve = resolve; });
    const cancel = () => { stopResolve(null); controller.abort(); };
    const timer = setTimeout(cancel, submitTimeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const ack = await Promise.race([stoppedDelivery,
        Promise.resolve().then(() => controller.signal.aborted ? null : transport(raw, { txHash: signed.hash, signal: controller.signal }))]);
      if (same(typeof ack === 'string' ? ack : ack?.hash, signed.hash)) emit('firstbuy_ack', { txHash: signed.hash, attempt: row.ordinal });
    } catch { /* no new nonce, no release, no endpoint/error payload logging */ }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    return snapshot({ txHash: row.tx_hash, unresolved: true });
  }
  function step() {
    if (inFlight) return inFlight;
    inFlight = work().catch(error => {
      phase = 'paused';
      const code = typeof error?.code === 'string' && /^FIRSTBUY_[A-Z_]+$/.test(error.code) ? error.code : 'FIRSTBUY_DEPENDENCY_UNAVAILABLE';
      emit('firstbuy_paused', { code });
      // A dependency outage while reconciling is still an unknown handoff;
      // callers must not clear durable recovery metadata on a paused result.
      let unresolved=true;
      try { unresolved=Boolean(journal?.pending(plan.sessionId,wallet)); } catch {}
      return snapshot({ code, unresolved });
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }
  async function runLoop() {
    for (;;) {
      const result = await step();
      if (terminal.has(result.phase) && !(result.phase === 'filled' && result.unresolved) || ['disabled', 'paused'].includes(result.phase)) return result;
      if (stopped() || nowSeconds() >= plan.deadline) {
        if (result.phase === 'filled') return result;
        phase = stopped() ? 'stopped' : 'expired';
        journal.markTerminal(plan.sessionId, phase);
        return snapshot({ unresolved: result.unresolved === true, ...(result.txHash ? { txHash: result.txHash } : {}) });
      }
      try { await delay(plan.intervalMs, undefined, { signal }); }
      catch { return { ...result, phase: 'stopped' }; }
    }
  }
  async function run() {
    emit('firstbuy_start', { contract: plan.contract, codeHash: plan.expectedCodeHash, mode: 'guarded', startBlock: plan.startBlock, endBlock: plan.endBlock,
      deadline: plan.deadline, maxAttempts: plan.maxAttempts, amountIn: plan.amountIn, amountOutMin: plan.minOut,
      gasLimit: plan.gasLimit, gasPrice: plan.gasPrice, maxGasWei: plan.maxGasWei });
    const result = await runLoop();
    emit('firstbuy_end', { contract: plan.contract, status: result.phase, attempts: result.attempts,
      gasReserved: result.gasReserved, unresolved: result.unresolved === true });
    return result;
  }
  async function stop() {
    stopping = true;
    if (inFlight) await inFlight;
    if (enabled && journal.status(plan.sessionId)) {
      journal.markTerminal(plan.sessionId, 'stopped');
      phase = journal.status(plan.sessionId).status;
      return snapshot({ unresolved: Boolean(journal.pending(plan.sessionId, wallet)) });
    }
    phase = 'stopped'; return snapshot();
  }
  return Object.freeze({ step, run, stop, status: () => snapshot(), plan });
}
