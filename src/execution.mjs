import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Interface, Transaction, Wallet, ZeroAddress, getAddress, isHexString } from 'ethers';
import { ROUTER, WBNB } from './market.mjs';
import { isDefinitelyNotSubmitted } from './rpc-pool.mjs';
import { isVerifiedPreopenBuyPlan } from './snipe-preopen.mjs';

const BSC = 56n;
const UINT256_MAX = (1n << 256n) - 1n;
const REORG_MONITOR_DEPTH = 12;
const RACE_MAX_ATTEMPTS = 5;
const RACE_BUY = new Interface([
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable',
]);

function addressOf(wallet) {
  return getAddress(typeof wallet === 'string' ? wallet : wallet?.address);
}

function uint(value, name, min = 0n) {
  if (typeof value !== 'bigint' &&
    !(typeof value === 'number' && Number.isSafeInteger(value)) &&
    !(typeof value === 'string' && /^(?:[0-9]+|0x[0-9a-fA-F]+)$/.test(value))) {
    throw new Error(`${name} must be an integer`);
  }
  const result = BigInt(value);
  if (result < min || result > UINT256_MAX) throw new Error(`${name} out of range`);
  return result;
}

function checkedActionId(actionId) {
  if (typeof actionId !== 'string' || !/^[\w:.+/@-]{1,320}$/.test(actionId)) {
    throw new Error('Invalid actionId (use a stable ASCII identifier)');
  }
  return actionId;
}

function checkedRaceBase(actionId) {
  if (typeof actionId !== 'string' || !/^bsc56:0x[0-9a-f]{40}:buy$/.test(actionId)) {
    throw new Error('Race requires the canonical Corla buy actionId');
  }
  return actionId;
}

const raceAttemptId = (actionId, ordinal) => actionId + ':race:' + ordinal;
const fitsRaceIntent = (stored, intent) => stored.token === intent.token && stored.amount_in === intent.amountIn &&
  BigInt(stored.min_out) <= BigInt(intent.minOut);

/** Load encrypted ethers JSON keystores; passwords only come from the specified environment variables. */
export async function loadWallets(provider, path) {
  const manifestPath = resolve(path);
  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Cannot read wallet manifest JSON');
  }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('Wallet manifest must be a nonempty array of {keystore,passwordEnv}');
  }
  const result = [];
  const seen = new Set();
  for (const [index, entry] of manifest.entries()) {
    const number = index + 1;
    if (entry === null || typeof entry !== 'object' || typeof entry.keystore !== 'string' ||
      !entry.keystore || typeof entry.passwordEnv !== 'string' ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry.passwordEnv)) {
      throw new Error(`Invalid wallet manifest entry #${number}`);
    }
    const password = process.env[entry.passwordEnv];
    if (!password) throw new Error(`Wallet entry #${number} password environment variable is unset`);
    let wallet;
    try {
      const encrypted = (await readFile(resolve(dirname(manifestPath), entry.keystore), 'utf8')).replace(/^\uFEFF/, '');
      wallet = (await Wallet.fromEncryptedJson(encrypted, password)).connect(provider);
    } catch {
      // Decryption errors can contain the password or content; never forward them.
      throw new Error(`Cannot decrypt wallet entry #${number}`);
    }
    const address = addressOf(wallet);
    if (seen.has(address)) throw new Error('Duplicate wallet in manifest');
    seen.add(address);
    result.push(wallet);
  }
  return result;
}

function openJournal(path) {
  if (typeof path !== 'string' || !path || path === ':memory:') {
    throw new Error('Live execution requires a persistent journal path');
  }
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') ?? {};
  if (!DatabaseSync) throw new Error('Node.js 24 with node:sqlite is required for live execution');
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 1000 });
  try {
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS actions (
        wallet TEXT NOT NULL,
        action_id TEXT NOT NULL,
        tx_hash TEXT NOT NULL UNIQUE,
        nonce INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(wallet, action_id),
        UNIQUE(wallet, nonce)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS pending_wallet ON actions(wallet) WHERE status = 'pending';
      CREATE TABLE IF NOT EXISTS receipt_evidence (
        tx_hash TEXT PRIMARY KEY REFERENCES actions(tx_hash),
        block_height INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        orphaned INTEGER NOT NULL CHECK(orphaned IN (0,1)),
        stable INTEGER NOT NULL CHECK(stable IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS one_shot_refusals (
        wallet TEXT NOT NULL,
        action_id TEXT NOT NULL,
        PRIMARY KEY(wallet, action_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS race_attempts (
        wallet TEXT NOT NULL,
        base_action_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5),
        action_id TEXT NOT NULL,
        max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
        PRIMARY KEY(wallet, base_action_id, attempt),
        UNIQUE(wallet, action_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS race_intents (
        wallet TEXT NOT NULL,
        base_action_id TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        min_out TEXT NOT NULL,
        PRIMARY KEY(wallet, base_action_id)
      ) STRICT;
    `);
    const joined = `SELECT a.*, e.block_height, e.block_hash, e.orphaned, e.stable
      FROM actions a LEFT JOIN receipt_evidence e ON e.tx_hash=a.tx_hash`;
    const byId = db.prepare(`${joined} WHERE a.wallet=? AND a.action_id=?`);
    const pending = db.prepare(`${joined} WHERE a.wallet=? AND (a.status='pending' OR e.orphaned=1)
      ORDER BY a.nonce LIMIT 1`);
    const recent = db.prepare(`${joined} WHERE a.wallet=? AND e.orphaned=0 AND e.stable=0
      ORDER BY a.nonce DESC`);
    const watched = db.prepare(`${joined} WHERE a.wallet=? AND (e.orphaned=1 OR e.stable=0)
      ORDER BY a.nonce`);
    const maxNonce = db.prepare('SELECT max(nonce) AS n FROM actions WHERE wallet=?');
    const insert = db.prepare("INSERT INTO actions VALUES(?,?,?,?,'pending',?)");
    const update = db.prepare('UPDATE actions SET status=?, updated_at=? WHERE tx_hash=?');
    const setEvidence = db.prepare(`INSERT INTO receipt_evidence VALUES(?,?,?,0,?)
      ON CONFLICT(tx_hash) DO UPDATE SET block_height=excluded.block_height, block_hash=excluded.block_hash,
      orphaned=0, stable=excluded.stable`);
    const orphan = db.prepare(`UPDATE receipt_evidence SET orphaned=1, stable=0
      WHERE tx_hash=? AND block_height=? AND block_hash=?`);
    const mature = db.prepare(`UPDATE receipt_evidence SET stable=1
      WHERE tx_hash=? AND block_height=? AND block_hash=? AND orphaned=0`);
    const release = db.prepare(`DELETE FROM actions WHERE wallet=? AND action_id=? AND tx_hash=? AND status='pending'
      AND NOT EXISTS (SELECT 1 FROM receipt_evidence WHERE tx_hash=actions.tx_hash)`);
    const refused = db.prepare('SELECT 1 FROM one_shot_refusals WHERE wallet=? AND action_id=?');
    const sealRefusal = db.prepare('INSERT OR IGNORE INTO one_shot_refusals VALUES(?,?)');
    const attempts = db.prepare('SELECT * FROM race_attempts WHERE wallet=? AND base_action_id=? ORDER BY attempt');
    const recordAttempt = db.prepare('INSERT INTO race_attempts VALUES(?,?,?,?,?)');
    const intent = db.prepare('SELECT token,amount_in,min_out FROM race_intents WHERE wallet=? AND base_action_id=?');
    const recordIntent = db.prepare('INSERT INTO race_intents VALUES(?,?,?,?,?)');
    return {
      find: (wallet, actionId) => byId.get(wallet, actionId),
      refused: (wallet, actionId) => Boolean(refused.get(wallet, actionId)),
      pending: (wallet) => pending.get(wallet),
      recent: (wallet) => recent.all(wallet),
      watched: (wallet) => watched.all(wallet),
      attempts: (wallet, base) => attempts.all(wallet, base),
      intent: (wallet, base) => intent.get(wallet, base),
      markOrphaned(row) {
        orphan.run(row.tx_hash, row.block_height, row.block_hash);
        return byId.get(row.wallet, row.action_id) ?? row;
      },
      markStable(row) {
        mature.run(row.tx_hash, row.block_height, row.block_hash);
        return byId.get(row.wallet, row.action_id) ?? row;
      },
      releaseNotSubmitted(row, seal = false) {
        const erase = () => release.run(row.wallet, row.action_id, row.tx_hash).changes === 1;
        if (!seal) return erase();
        // Keep a terminal one-shot ID even though the refused nonce is safe
        // to reuse. Both changes are atomic across UI/CLI and restarts.
        db.exec('BEGIN IMMEDIATE');
        try {
          const released = erase();
          if (released) sealRefusal.run(row.wallet, row.action_id);
          db.exec('COMMIT');
          return released;
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      finish: (row, status, evidence) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = byId.get(row.wallet, row.action_id);
          if (current?.tx_hash === row.tx_hash && current.block_hash === row.block_hash &&
              current.block_height === row.block_height && current.orphaned === row.orphaned) {
            update.run(status, new Date().toISOString(), row.tx_hash);
            setEvidence.run(row.tx_hash, evidence.height, evidence.hash, Number(evidence.depth >= REORG_MONITOR_DEPTH));
          }
          db.exec('COMMIT');
          return byId.get(row.wallet, row.action_id) ?? row;
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      stage(wallet, actionId, hash, nonce, race) {
        // This synchronous transaction is also the cross-process reservation. No
        // network access occurs under the SQLite write lock.
        db.exec('BEGIN IMMEDIATE');
        try {
          if (refused.get(wallet, actionId)) {
            db.exec('COMMIT');
            return { refused: true };
          }
          if (race) {
            const prior = attempts.all(wallet, race.base);
            const original = intent.get(wallet, race.base);
            const incompatible = Boolean(byId.get(wallet, race.base) || refused.get(wallet, race.base)) ||
              (prior.length > 0 && !original) || (original && !fitsRaceIntent(original, race.intent)) ||
              prior.length + 1 !== race.attempt || race.attempt > (prior[0]?.max_attempts ?? race.maxAttempts) ||
              prior.some((entry, i) => {
                const row = byId.get(wallet, entry.action_id);
                const proof = race.prior[i];
                // Verify the exact durable evidence that the caller checked
                // outside the SQLite lock. A concurrent reorg/reconciliation
                // or another process staging an attempt invalidates it.
                if (row) return row.status !== 'failed' || row.orphaned !== 0 || !row.block_hash ||
                  row.tx_hash !== proof?.txHash || row.block_hash !== proof?.blockHash;
                return !proof?.refused || !refused.get(wallet, entry.action_id);
              });
            if (incompatible) { db.exec('COMMIT'); return { raceConflict: true }; }
          } else if (attempts.all(wallet, actionId).length) {
            // Toggling from race back to one-shot is not a fresh purchase.
            db.exec('COMMIT');
            return { raceConflict: true };
          }
          const previous = byId.get(wallet, actionId) ?? pending.get(wallet);
          if (previous) {
            db.exec('COMMIT');
            return { previous };
          }
          const latestNonce = maxNonce.get(wallet).n;
          if (latestNonce !== null && nonce <= latestNonce) {
            throw new Error('RPC returned a stale nonce; no transaction was broadcast');
          }
          insert.run(wallet, actionId, hash, nonce, new Date().toISOString());
          if (race) {
            recordAttempt.run(wallet, race.base, race.attempt, actionId, race.maxAttempts);
            if (race.attempt === 1) recordIntent.run(wallet, race.base, race.intent.token, race.intent.amountIn, race.intent.minOut);
          }
          db.exec('COMMIT'); // Persist the hash before the signed payload ever leaves the process.
          return { staged: byId.get(wallet, actionId) };
        } catch (error) {
          if (db.isTransaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function checkRequest(tx) {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction is missing');
  const to = getAddress(tx.to);
  if (to === ZeroAddress) throw new Error('Transaction cannot target the zero address');
  const data = tx.data;
  if (!isHexString(data, true) || data.length < 10) throw new Error('Invalid contract call data');
  return { to, data: data.toLowerCase(), value: uint(tx.value ?? 0n, 'Transaction value') };
}

function parseRaceBuy(call, address) {
  if (call.to !== ROUTER || call.value <= 0n) throw new Error('Race requires the Pancake router and a positive buy amount');
  try {
    const parsed = RACE_BUY.parseTransaction({ data: call.data });
    const [minOut, path, recipient, deadline] = parsed.args;
    if (minOut <= 0n || deadline <= 0n || recipient !== address || path.length !== 2 || path[0] !== WBNB ||
        path[1] === ZeroAddress || path[1] === WBNB || RACE_BUY.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== call.data) {
      throw new Error();
    }
    return { token: path[1].toLowerCase(), amountIn: String(call.value), minOut: String(minOut), deadline };
  } catch {
    throw new Error('Race must be an exact WBNB-to-token buy with nonzero minimum output');
  }
}

function requirePreopenBuy(call, address, beforeSign, gasEstimate, plan, base, intent) {
  if (typeof beforeSign !== 'function') {
    throw new Error('Pre-open race requires the verified Pancake buy plan and a final signing guard');
  }
  // The coordinator is internal, but don't accept any unbranded estimate
  // even there. The private builder-side WeakSet binds the exact transaction
  // to successful ordered simulation, not a plain caller-provided object.
  if (!isVerifiedPreopenBuyPlan(plan) || plan.recipient?.toLowerCase() !== address.toLowerCase() ||
      plan.mint?.toLowerCase() !== base.split(':')[1] ||
      plan.tx.to !== call.to || plan.tx.data.toLowerCase() !== call.data ||
      plan.tx.value !== call.value || plan.gasEstimate !== gasEstimate) {
    throw new Error('Pre-open race requires the original verified ordered simulation plan');
  }
  if (intent.minOut !== String(plan.amountOutMin) || intent.deadline !== BigInt(plan.deadline) ||
      intent.token !== plan.token?.toLowerCase()) {
    throw new Error('Pre-open race must be an exact WBNB-to-token buy with nonzero minimum output');
  }
}

function safeCallError(label, error) {
  // Ethers/RPC exceptions may include raw transaction data or RPC credentials.
  // Keep only known error codes; untrusted revert text is intentionally excluded.
  const code = typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code)
    ? ` (${error.code})` : '';
  return new Error(label + code);
}
function preflightError(stage, error) {
  if (error?.code === 'CALL_EXCEPTION') {
    // Only translate exact allowlisted revert reasons; never log provider
    // URLs, calldata, arbitrary contract text, or RPC request bodies.
    const reasons = [error.reason, error.revert?.args?.[0]];
    if (reasons.includes('PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT')) {
      return new Error('最低到手量不足（超出滑点上限）；未发送');
    }
    if (reasons.includes('PancakeRouter: EXPIRED')) return new Error('买单报价已过期；未发送');
  }
  return safeCallError(stage + ' failed; not sent', error);
}

function resultFor(row, reason, status = row.orphaned ? 'pending' : row.status) {
  const result = { status, wallet: row.wallet, actionId: row.action_id, txHash: row.tx_hash };
  if (row.block_hash) {
    result.receiptBlock = row.block_height;
    result.receiptStable = status !== 'pending' && row.stable === 1;
  }
  if (reason) result.reason = reason;
  if (status === 'failed') result.reason = 'On-chain receipt has status 0 (reverted)';
  return result;
}

const refusedResult = (wallet, actionId) => ({
  status: 'skipped', wallet, actionId, reason: '该笔单次提交未被节点接受，不会重发',
});

function blockHashAt(block, height) {
  return block?.number === height && isHexString(block.hash, 32) ? block.hash.toLowerCase() : null;
}

/**
 * Returns execute({actionId,wallet,tx:{to,data,value},gasLimitFloor?,beforeSign?,singleSubmission?}), plus
 * reconcile(actionId,wallet) and close(). Keep action IDs stable across runs.
 * A pending/failed action is never broadcast again. Pending can mean broadcast
 * outcome is unknown. A gas floor cannot bypass the cap or balance checks.
 */
export function makeExecutor({
  provider, wallets, live = false, maxGasPriceWei, gasLimitCap, journalPath,
  confirmations = 1, receiptTimeoutMs = 12_000, directBroadcast = false, signal,
}) {
  const gasPriceCap = uint(maxGasPriceWei, 'Gas price cap', 1n);
  const gasCap = uint(gasLimitCap, 'Gas limit cap', 21_000n);
  if (typeof live !== 'boolean') throw new Error('live must be a boolean');
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 ||
    !Number.isSafeInteger(receiptTimeoutMs) || receiptTimeoutMs < 0 || receiptTimeoutMs > 120_000) {
    throw new Error('Invalid receipt policy');
  }
  if (!Array.isArray(wallets)) throw new Error('Wallets must be an array');
  const configured = new Map();
  for (const wallet of wallets) {
    const address = addressOf(wallet);
    if (address === ZeroAddress || configured.has(address)) throw new Error('Invalid or duplicate wallet address');
    if (live && typeof wallet.signTransaction !== 'function') throw new Error('Live wallet cannot sign transactions');
    configured.set(address, wallet);
  }
  const journal = live ? openJournal(journalPath) : null;
  const inflight = new Map();
  const prepTickets = new WeakMap();
  let warmingFee;
  let closed = false;

  const fee = () => typeof provider.send === 'function' ? provider.send('eth_gasPrice', []) :
    provider.getFeeData().then(row => row.gasPrice);
  const estimateBuy = request => Promise.resolve().then(() => provider.estimateGas(request))
    .catch(error => { throw preflightError('eth_estimateGas', error); });
  const simulateBuy = request => Promise.resolve().then(() => provider.call(request))
    .catch(error => { throw preflightError('eth_call', error); });
  const beginPreflight = request => Promise.all([estimateBuy(request), simulateBuy(request)]);

  function prepare({ wallet } = {}) {
    if (!live || !directBroadcast || closed || signal?.aborted) return null;
    const address = addressOf(wallet);
    if (!configured.has(address)) return null;
    // Share a very recent candidate-triggered fee request across wallets.
    // The ticket is opaque, and a warmed fee never replaces the current fee,
    // balance, nonce, and chain checks used for the signed transaction.
    const now = performance.now();
    if (!warmingFee || now - warmingFee.started >= 300) {
      const sample = { started: now, value: null };
      sample.ready = Promise.resolve().then(fee).then(value => { sample.value = uint(value, 'RPC gas price', 1n); })
        .catch(() => {});
      warmingFee = sample;
    }
    const ticket = warmingFee.ready.then(() => null);
    prepTickets.set(ticket, { address, sample: warmingFee });
    return ticket;
  }

  function serialized(wallet, work) {
    if (closed) throw new Error('Executor is closed');
    const address = addressOf(wallet);
    if (!configured.has(address)) throw new Error('Wallet is not configured');
    const previous = inflight.get(address) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => work(address, configured.get(address)));
    inflight.set(address, task);
    return task.finally(() => {
      if (inflight.get(address) === task) inflight.delete(address);
    });
  }

  async function checkNetwork() {
    let chainId;
    try {
      chainId = BigInt(typeof provider.send === 'function'
        ? await provider.send('eth_chainId', [])
        : (await provider.getNetwork()).chainId);
    } catch (error) {
      throw safeCallError('Cannot verify RPC chain ID', error);
    }
    if (chainId !== BSC) throw new Error(`Wrong RPC chain ID (${chainId}); expected BNB Smart Chain (56)`);
  }

  const latestHead = () => Promise.resolve().then(() => provider.getBlockNumber()).catch(() => null);
  const shareHead = () => {
    let head;
    return () => head ??= latestHead();
  };

  async function refresh(row, receipt, readHead = latestHead, requiredDepth = confirmations) {
    const unverified = reason => resultFor(row, reason, 'pending');
    try {
      if (row.block_hash) {
        const [block, head] = await Promise.all([
          Promise.resolve().then(() => provider.getBlock(row.block_height)).catch(() => null),
          // Depth was already proven when stored. A transient head read failure
          // must not turn a matching canonical block into a suspected reorg.
          readHead(),
        ]);
        const canonicalHash = blockHashAt(block, row.block_height);
        if (canonicalHash === row.block_hash) {
          const depth = Number.isSafeInteger(head) ? head - row.block_height + 1 : null;
          if (depth !== null && depth < requiredDepth) {
            return unverified('Waiting for the configured number of confirmations');
          }
          if (row.orphaned) {
            if ((depth ?? 1) < requiredDepth) return unverified('Waiting for the configured number of confirmations');
            return resultFor(journal.finish(row, row.status, { height: row.block_height, hash: row.block_hash, depth: depth ?? 1 }));
          }
          if (!row.stable && (depth ?? 0) >= REORG_MONITOR_DEPTH) {
            row = journal.markStable(row);
          }
          return resultFor(row);
        }
        if (!row.orphaned) {
          if (!canonicalHash) return unverified('Canonical block unavailable; do not resubmit');
          // Keep terminal action and nonce history intact, but quarantine the
          // wallet until the same hash is seen again on the canonical chain.
          row = journal.markOrphaned(row);
          if (!row.orphaned) return resultFor(row);
        }
      }
      receipt ??= await provider.getTransactionReceipt(row.tx_hash);
      if (!receipt || receipt.hash?.toLowerCase() !== row.tx_hash ||
        receipt.from?.toLowerCase() !== row.wallet.toLowerCase() ||
        (receipt.status !== 0 && receipt.status !== 1) ||
        !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
        !isHexString(receipt.blockHash, 32)) {
        return unverified(row.orphaned ? 'Previously confirmed block was reorganized; do not resubmit'
          : 'Receipt not confirmed; do not resubmit');
      }
      const height = receipt.blockNumber;
      const hash = receipt.blockHash.toLowerCase();
      const [canonical, head] = await Promise.all([
        provider.getBlock(height),
        readHead(),
      ]);
      if (blockHashAt(canonical, height) !== hash) {
        return unverified('Receipt block is not verified on the canonical chain; do not resubmit');
      }
      const depth = Number.isSafeInteger(head) ? head - height + 1 : 1;
      if (depth < requiredDepth) return unverified('Waiting for the configured number of confirmations');
      return resultFor(journal.finish(row, receipt.status === 1 ? 'confirmed' : 'failed', { height, hash, depth }));
    } catch {
      return unverified('Could not verify the receipt; do not resubmit');
    }
  }

  async function checkRecent(rows) {
    const head = shareHead();
    for (const row of rows) {
      const outcome = await refresh(row, null, head);
      if (outcome.status === 'pending') return outcome;
    }
    return null;
  }

  const normalizedRace = (row, base, attempt, id) => ({
    ...row, actionId: base, attempt, attemptActionId: id,
  });

  async function inspectRace(base, address) {
    const legacy = journal.find(address, base);
    if (legacy || journal.refused(address, base)) {
      if (legacy) await checkNetwork();
      const result = legacy ? await refresh(legacy) : refusedResult(address, base);
      return { latest: normalizedRace(result.status === 'pending' || result.status === 'confirmed' ? result :
        { ...result, status: 'exhausted', reason: '该项目已有旧版单次提交记录，不会补单' }, base, 0, base), blocked: true };
    }
    const entries = journal.attempts(address, base);
    if (!entries.length) return { prior: [], latest: null, entries };
    const rows = entries.map(entry => journal.find(address, entry.action_id));
    if (rows.some(Boolean)) await checkNetwork();
    const head = shareHead();
    const outcomes = await Promise.all(entries.map(async (entry, i) => {
      const row = rows[i];
      if (row) {
        const outcome = await refresh(row, null, head, 1);
        const verified = journal.find(address, entry.action_id);
        return { result: normalizedRace(outcome, base, entry.attempt, entry.action_id),
          proof: outcome.status === 'failed' && verified?.status === 'failed' && verified?.orphaned === 0 && verified.block_hash
            ? { txHash: verified.tx_hash, blockHash: verified.block_hash } : null };
      }
      if (journal.refused(address, entry.action_id)) {
        return { result: normalizedRace({ ...refusedResult(address, entry.action_id),
          reason: '该次未被节点接收，已计入次数上限' }, base, entry.attempt, entry.action_id), proof: { refused: true } };
      }
      return { result: normalizedRace({ wallet: address, status: 'pending', reason: '历史抢单状态未明，不会补发' },
        base, entry.attempt, entry.action_id), proof: null };
    }));
    const blocked = outcomes.find(outcome => !outcome.proof);
    return { entries, maxAttempts: entries[0].max_attempts, prior: outcomes.map(outcome => outcome.proof),
      blocked: Boolean(blocked), latest: (blocked ?? outcomes.at(-1)).result };
  }

  function normalRaceResult(status) {
    return status?.status === 'confirmed' || status?.status === 'pending' ? status : {
      ...status, status: 'skipped', reason: '该项目已有连续抢单记录，不会用单次模式重复买入',
    };
  }

  async function runAction({ actionId, tx, gasLimitFloor, beforeSign, onBroadcast, singleSubmission, preparedWallet }, address, signer, race) {
      signal?.throwIfAborted();
      if (journal?.refused(address, actionId)) return refusedResult(address, actionId);
      // Generic providers may internally retry 429s/redirects. Strict live
      // one-shot execution requires the explicitly bounded transport.
      if (live && singleSubmission && typeof provider.submitRawTransaction !== 'function') {
        throw new Error('RPC 不支持单次提交；未发送');
      }
      if (!directBroadcast) await checkNetwork();
      if (journal) {
        const existing = journal.find(address, actionId);
        if (existing) {
          if (directBroadcast) await checkNetwork();
          return refresh(existing);
        }
        const previous = journal.pending(address);
        const recent = journal.recent(address).filter(row => !race?.knownActionIds.has(row.action_id));
        if (previous || recent.length) {
          if (directBroadcast) await checkNetwork();
          const outcome = (previous ? await refresh(previous) : null);
          const blocking = outcome?.status === 'pending' ? outcome : await checkRecent(recent);
          if (blocking) {
            return { ...blocking, reason: 'Previous action for this wallet is unresolved; this action was not sent' };
          }
        }
      }
      const call = { ...checkRequest(tx), from: address };
      const preopenEstimate = race?.gasEstimate;
      if (preopenEstimate !== undefined) requirePreopenBuy(call, address, beforeSign, preopenEstimate, race.preopenPlan, race.base, race.intent);
      const floor = gasLimitFloor === undefined ? 0n : uint(gasLimitFloor, 'Gas limit floor', 1n);
      if (floor > gasCap) throw new Error(`Gas limit floor ${floor} exceeds configured cap ${gasCap}`);
      const walletBegan = performance.now();
      const prepared = singleSubmission && live && directBroadcast ? prepTickets.get(preparedWallet) : undefined;
      const warmed = prepared?.address === address && walletBegan - prepared.sample.started <= 900 ? prepared.sample.value : null;
      const early = preopenEstimate === undefined && warmed !== null && warmed <= gasPriceCap
        ? estimateBuy({ ...call, gasPrice: warmed }).then(value => ({ value }), error => ({ error })) : null;
      let gasPrice, gasLimit;
      let nonce, latestNonce, balance;
      try {
        const [currentFee, pendingNonce, confirmedNonce, walletBalance] = await Promise.all([
          fee(),
          live ? provider.getTransactionCount(address, 'pending') : null,
          live ? provider.getTransactionCount(address, 'latest') : null,
          live ? provider.getBalance(address, 'pending') : null,
          directBroadcast ? checkNetwork() : null,
        ]);
        gasPrice = uint(currentFee, 'RPC gas price', 1n);
        nonce = pendingNonce;
        latestNonce = confirmedNonce;
        balance = walletBalance;
      } catch (error) {
        throw safeCallError('Could not obtain wallet nonce/balance or RPC gas price; not sent', error);
      }
      signal?.throwIfAborted();
      if (gasPrice > gasPriceCap) throw new Error(`Gas price ${gasPrice} wei exceeds configured cap ${gasPriceCap}`);
      const walletChecksMs = Math.round(performance.now() - walletBegan);
      let preflightOverlapped = Boolean(early && warmed === gasPrice && walletChecksMs <= 250);
      const preflightBegan = preflightOverlapped ? walletBegan : performance.now();
      const request = { ...call, gasPrice };
      let estimated;
      if (preopenEstimate !== undefined) {
        // This estimate comes only from the internal ordered
        // final-Mint→buy simulation. A direct eth_call before the pool
        // exists necessarily reverts, so the distinct race path must use
        // its own signing guard and still enforce all budget/nonce checks.
        estimated = preopenEstimate;
      } else if (preflightOverlapped) {
        const ready = await early;
        if (ready.error) throw ready.error;
        estimated = ready.value;
        // Never reuse a speculative market simulation. Only overlap the gas
        // estimate; the actual buy is still called against latest state.
        if (performance.now() - walletBegan > 350) {
          preflightOverlapped = false;
          [estimated] = await beginPreflight(request);
        }
      } else [estimated] = await beginPreflight(request);
      gasLimit = (uint(estimated, 'Gas estimate', 21_000n) * 120n + 99n) / 100n;
      if (floor > gasLimit) gasLimit = floor;
      if (gasLimit > gasCap) throw new Error(`Buffered gas limit ${gasLimit} exceeds configured cap ${gasCap}`);
      const gas = { gasLimit: String(gasLimit), gasPrice: String(gasPrice) };
      if (!live) return { status: 'simulated', wallet: address, actionId, ...gas };

      if (!Number.isSafeInteger(nonce) || nonce < 0 || nonce !== latestNonce) {
        throw new Error('Wallet has an external pending transaction or invalid nonce; not sent');
      }
      if (uint(balance, 'Wallet balance') < call.value + gasLimit * gasPrice) {
        throw new Error('Wallet balance is below transaction value plus maximum gas cost; not sent');
      }
      if (preflightOverlapped) {
        // Check the exact fee and estimated+buffered gas against latest state
        // after wallet checks. A new block can make the earlier estimate too
        // low or make minOut fail; neither is a reason to send blindly.
        signal?.throwIfAborted();
        await simulateBuy({ ...request, gasLimit });
      }
      const preflightMs = Math.round(performance.now() - preflightBegan);
      signal?.throwIfAborted();
      if (beforeSign !== undefined) {
        if (typeof beforeSign !== 'function') throw new Error('Invalid pre-sign check; not sent');
        await beforeSign();
      }
      signal?.throwIfAborted();

      const signBegan = performance.now();
      let signed, hash;
      try {
        signed = await signer.signTransaction({ ...call, type: 0, chainId: BSC, nonce, gasLimit, gasPrice });
        const parsed = Transaction.from(signed);
        if (!parsed.hash || parsed.from !== address || parsed.to !== call.to ||
          parsed.data !== call.data || parsed.value !== call.value || parsed.chainId !== BSC ||
          parsed.type !== 0 || parsed.nonce !== nonce || parsed.gasLimit !== gasLimit || parsed.gasPrice !== gasPrice) {
          throw new Error('Signed fields differ from checked fields');
        }
        hash = parsed.hash.toLowerCase();
      } catch (error) {
        signal?.throwIfAborted();
        throw safeCallError('Transaction signing/verification failed; not sent', error);
      }
      const signMs = Math.round(performance.now() - signBegan);

      signal?.throwIfAborted(); // Do not leave a reservation for an aborted signing attempt.
      const { staged, previous, refused, raceConflict } = journal.stage(address, actionId, hash, nonce, race);
      if (raceConflict) {
        const current = await inspectRace(race?.base ?? actionId, address);
        return current.latest ? (race ? current.latest : normalRaceResult(current.latest)) :
          { status: 'pending', wallet: address, actionId, reason: '抢单记录已变化，本次未发送' };
      }
      if (refused) return refusedResult(address, actionId);
      if (previous) {
        const outcome = await refresh(previous);
        return previous.action_id === actionId ? outcome : {
          ...outcome,
          status: 'pending',
          reason: 'Another process won the wallet reservation; this action was not sent',
        };
      }
      // The hook observes timing only, never sees signed calldata.
      const sendTelemetry = { txHash: hash, walletChecksMs, preflightMs, preflightOverlapped, signMs,
        ...(race ? { attempt: race.attempt, attemptActionId: actionId } : {}) };
      try { onBroadcast?.('send', sendTelemetry); } catch { /* telemetry cannot change send outcome */ }
      if (signal?.aborted && journal.releaseNotSubmitted(staged, Boolean(race))) signal.throwIfAborted();
      if (signal?.aborted) return { ...resultFor(staged, 'Stopped before submission; check journal'), ...gas };
      let response;
      try {
        response = typeof provider.submitRawTransaction === 'function'
          ? { hash: await provider.submitRawTransaction(signed, { signal, singleSubmission }) }
          : directBroadcast
            ? { hash: await provider.send('eth_sendRawTransaction', [signed]) }
            : await provider.broadcastTransaction(signed);
      } catch (error) {
        if (isDefinitelyNotSubmitted(error, hash) && journal.releaseNotSubmitted(staged, singleSubmission)) {
          signal?.throwIfAborted();
          if (race) return { ...refusedResult(address, actionId), reason: '该次未被节点接收，已计入次数上限', ...gas };
          throw Object.assign(new Error('RPC definitively refused submission; no transaction was sent'), {
            code: 'TRANSACTION_NOT_SUBMITTED',
          });
        }
        // An RPC transport error does not mean the transaction was not submitted.
        return { ...resultFor(staged, 'Broadcast outcome unknown; check receipt without resubmitting'), ...gas };
      }
      if (typeof response?.hash !== 'string' || response.hash.toLowerCase() !== hash) {
        return { ...resultFor(staged, 'RPC did not return the expected hash; check receipt without resubmitting'), ...gas };
      }
      try { onBroadcast?.('ack', sendTelemetry); } catch { /* telemetry cannot change send outcome */ }
      if (signal?.aborted || (directBroadcast && !receiptTimeoutMs)) {
        return { ...resultFor(staged, 'RPC 已接收，等待链上回执'), ...gas };
      }
      let receipt;
      if (receiptTimeoutMs) {
        try {
          receipt = await provider.waitForTransaction(hash, confirmations, receiptTimeoutMs);
        } catch {
          // Query again by the locally derived hash; never send a replacement.
        }
      }
      return { ...await refresh(staged, receipt, latestHead, race ? 1 : confirmations), ...gas };
  }

  async function execute(input) {
    const actionId = checkedActionId(input.actionId);
    if (/^bsc56:0x[0-9a-f]{40}:buy:race:[1-5]$/.test(actionId)) throw new Error('Race ordinal actionId is reserved');
    const { singleSubmission = false } = input;
    if (typeof singleSubmission !== 'boolean') throw new Error('Invalid raw submission policy');
    return serialized(input.wallet, async (address, signer) => {
      if (journal?.attempts(address, actionId).length) {
        const { latest } = await inspectRace(actionId, address);
        return normalRaceResult(latest);
      }
      return runAction({ ...input, actionId, singleSubmission }, address, signer);
    });
  }

  execute.race = async input => {
    const { wallet, gasEstimate, maxAttempts, preopenPlan } = input;
    const base = checkedRaceBase(input.actionId);
    if (!live || !directBroadcast) throw new Error('Continuous race requires the direct live executor');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > RACE_MAX_ATTEMPTS) {
      throw new Error('Race attempts must be between 1 and 5');
    }
    return serialized(wallet, async (address, signer) => {
      signal?.throwIfAborted();
      const history = await inspectRace(base, address);
      if (history.blocked) return history.latest;
      const cap = Math.min(maxAttempts, history.maxAttempts ?? maxAttempts);
      const attempt = history.entries.length + 1;
      if (attempt > cap) return { ...history.latest, status: 'exhausted', reason: '已达到抢单次数上限，不再提交' };
      const tx = checkRequest(input.tx);
      const intent = parseRaceBuy(tx, address);
      const original = journal.intent(address, base);
      if ((history.entries.length && !original) || (original && !fitsRaceIntent(original, intent))) {
        throw new Error('Race buy differs from the persisted token/amount or weakens its original minimum output; not sent');
      }
      const actionId = raceAttemptId(base, attempt);
      const result = await runAction({ ...input, tx, actionId, singleSubmission: true }, address, signer, {
        base, attempt, maxAttempts: cap, gasEstimate, preopenPlan, intent, prior: history.prior,
        knownActionIds: new Set(history.entries.map(row => row.action_id)),
      });
      if (result.actionId === base) return result;
      if (result.actionId !== actionId) {
        return { ...result, blockedActionId: result.actionId, actionId: base };
      }
      return normalizedRace(result, base, attempt, actionId);
    });
  };
  execute.raceStatus = async (actionId, wallet) => {
    const base = checkedRaceBase(actionId);
    if (!journal) return null;
    return serialized(wallet, async address => {
      signal?.throwIfAborted();
      return (await inspectRace(base, address)).latest;
    });
  };
  execute.prepare = prepare;
  execute.reconcile = async (actionId, wallet) => {
    actionId = checkedActionId(actionId);
    if (!journal) return null;
    return serialized(wallet, async (address) => {
      const existing = journal.find(address, actionId);
      if (!existing) {
        if (journal.refused(address, actionId)) return refusedResult(address, actionId);
        if (journal.attempts(address, actionId).length) {
          return normalRaceResult((await inspectRace(actionId, address)).latest);
        }
        return null;
      }
      await checkNetwork();
      return refresh(existing);
    });
  };
  // Check unresolved reservations (including observed reorgs) and immature
  // confirmations without scanning every possible mint ordinal on restart.
  execute.reconcilePending = async wallet => {
    if (!journal) return null;
    return serialized(wallet, async address => {
      const existing = journal.pending(address);
      const recent = existing ? [] : journal.recent(address);
      if (!existing && !recent.length) return null;
      await checkNetwork();
      return existing ? refresh(existing) : checkRecent(recent);
    });
  };
  // Optional background check of canonical evidence, including across a
  // restart. A healthy, unchanged confirmation does not need a new event.
  execute.reconcileRecent = async wallet => {
    if (!journal) return [];
    return serialized(wallet, async address => {
      const watched = journal.watched(address);
      if (!watched.length) return [];
      await checkNetwork();
      const head = shareHead();
      const outcomes = [];
      for (const row of watched) {
        const outcome = await refresh(row, null, head);
        if (row.orphaned || outcome.status === 'pending') outcomes.push(outcome);
      }
      return outcomes;
    });
  };
  execute.close = () => {
    if (inflight.size !== 0) throw new Error('Cannot close executor while actions are running');
    if (!closed) journal?.close();
    closed = true;
  };
  return execute;
}
