import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const APPLICATION_ID = 0x43424a31; // CBJ1: never reuse the live executor database.
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 100_000;
const TOKEN = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const ZERO_HASH = '0x' + '0'.repeat(64);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const int = value => Number.isSafeInteger(value) && value >= 0;
const isAddress = value => ADDRESS.test(value) && value !== ZERO_ADDRESS;
const isHash = value => HASH.test(value) && value !== ZERO_HASH;
const unavailable = () => new Error('SNIPE_BUNDLE_JOURNAL_UNAVAILABLE');
const normalizeSql = sql => String(sql).replace(/\s+/g, ' ').trim().replace(/;$/, '');
const TABLE_SQL = `CREATE TABLE bundle_intents (
  chain_id INTEGER NOT NULL CHECK(chain_id = 56),
  mint TEXT NOT NULL,
  token TEXT NOT NULL,
  wallet TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK(nonce >= 0),
  buy_tx_hash TEXT NOT NULL,
  parent_block INTEGER NOT NULL CHECK(parent_block >= 0),
  parent_hash TEXT NOT NULL,
  target_block INTEGER NOT NULL CHECK(target_block = parent_block + 1),
  max_timestamp INTEGER NOT NULL CHECK(max_timestamp > 0),
  mint_hashes TEXT NOT NULL,
  reservation_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('reserved','accepted','refused','unknown')),
  bundle_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(chain_id, mint, wallet),
  UNIQUE(chain_id, wallet, nonce),
  UNIQUE(chain_id, buy_tx_hash)
) STRICT`;

function checkedIntent(input) {
  const { chainId, nonce, parentBlock, targetBlock, maxTimestamp } = input ?? {};
  const [mint, token, wallet, buyTxHash, parentHash] = [input?.mint, input?.token, input?.wallet,
    input?.buyTxHash, input?.parentHash].map(lower);
  if (chainId !== 56 || !isAddress(mint) || !isAddress(token) || mint === token || !isAddress(wallet) ||
      !isHash(buyTxHash) || !isHash(parentHash) || !int(nonce) || !int(parentBlock) ||
      !int(targetBlock) || targetBlock !== parentBlock + 1 || !int(maxTimestamp) || maxTimestamp === 0 ||
      !Array.isArray(input?.mintHashes) || input.mintHashes.length < 1 || input.mintHashes.length > 3) {
    throw new Error('SNIPE_BUNDLE_JOURNAL_INVALID_INTENT');
  }
  const mintHashes = input.mintHashes.map(lower);
  if (!mintHashes.every(isHash) || new Set([buyTxHash, ...mintHashes]).size !== mintHashes.length + 1) {
    throw new Error('SNIPE_BUNDLE_JOURNAL_INVALID_INTENT');
  }
  return { chainId, mint, token, wallet, nonce, buyTxHash, parentBlock, parentHash, targetBlock, maxTimestamp, mintHashes };
}

/**
 * Separate durable reservation store, explicitly opened by a future caller.
 * There is no default state directory and no live executor/wallet integration.
 * `directory` must already exist and be absolute. Only a simple SQLite basename
 * is accepted; symlink/hardlink targets and unrelated databases are rejected.
 *
 * All methods are synchronous: a FULL-synchronous COMMIT returns before handoff.
 * Reserved/accepted/refused/unknown entries are permanent tombstones. Expiry is
 * NOT evidence that an earlier submission did not execute; there is no release
 * or retry method. Public identifiers only, never calldata/signatures/endpoints.
 */
export function openSnipeBundleJournal({ directory, fileName = 'bundle-intents.sqlite' } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) ||
      typeof fileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.sqlite$/.test(fileName)) {
    throw new Error('SNIPE_BUNDLE_JOURNAL_INVALID_PATH');
  }
  let db, file;
  try {
    const dir = realpathSync(directory);
    if (!lstatSync(dir).isDirectory()) throw unavailable();
    file = join(dir, fileName);
    try {
      const descriptor = openSync(file, 'wx', 0o600);
      closeSync(descriptor);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || realpathSync(file) !== file) throw unavailable();
    // The timeout is deliberately bounded: this journal must not silently hold
    // up a time-sensitive caller indefinitely when another process owns a lock.
    db = new DatabaseSync(file, { timeout: 50 });
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      const application = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (application === 0 && version === 0 && objects.length === 0) {
        db.exec(`${TABLE_SQL}; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
      } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION || objects.length !== 1 ||
          objects[0].type !== 'table' || objects[0].name !== 'bundle_intents' ||
          normalizeSql(objects[0].sql) !== normalizeSql(TABLE_SQL)) throw unavailable();
      if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw unavailable();
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } catch {
    try { db?.close(); } catch { /* opening errors remain sanitized */ }
    throw unavailable();
  }

  let closed = false, failed = false;
  const ensure = () => { if (closed || failed) throw unavailable(); };
  let query, insert, update;
  try {
    query = db.prepare(`SELECT 1 FROM bundle_intents WHERE chain_id = ? AND
      ((mint = ? AND wallet = ?) OR (wallet = ? AND nonce = ?) OR buy_tx_hash = ?) LIMIT 1`);
    insert = db.prepare(`INSERT INTO bundle_intents
      (chain_id,mint,token,wallet,nonce,buy_tx_hash,parent_block,parent_hash,target_block,max_timestamp,
        mint_hashes,reservation_token,status,bundle_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'reserved',NULL,?,?)`);
    update = db.prepare(`UPDATE bundle_intents SET status = ?, bundle_hash = ?, updated_at = ?
      WHERE buy_tx_hash = ? AND reservation_token = ? AND status = 'reserved'`);
  } catch {
    try { db.close(); } catch { /* all setup failures stay sanitized */ }
    throw unavailable();
  }
  const find = row => Boolean(query.get(row.chainId, row.mint, row.wallet, row.wallet, row.nonce, row.buyTxHash));

  function lookup(input) {
    ensure();
    const row = checkedIntent(input);
    try { return find(row); }
    catch { failed = true; throw unavailable(); }
  }
  function reserve(input) {
    ensure();
    const row = checkedIntent(input);
    try {
      db.exec('BEGIN IMMEDIATE');
      if (find(row)) { db.exec('COMMIT'); return Object.freeze({ status: 'duplicate' }); }
      if (db.prepare('SELECT count(*) AS n FROM bundle_intents').get().n >= MAX_ENTRIES) throw unavailable();
      const reservationToken = randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      insert.run(row.chainId, row.mint, row.token, row.wallet, row.nonce, row.buyTxHash, row.parentBlock,
        row.parentHash, row.targetBlock, row.maxTimestamp, JSON.stringify(row.mintHashes), reservationToken, now, now);
      db.exec('COMMIT');
      return Object.freeze({ status: 'reserved', reservation: Object.freeze({ buyTxHash: row.buyTxHash, reservationToken }) });
    } catch {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* fail closed */ }
      failed = true;
      throw unavailable();
    }
  }
  function markOutcome(reservation, outcome) {
    ensure();
    const hash = lower(reservation?.buyTxHash), token = reservation?.reservationToken;
    const status = outcome?.status;
    const bundleHash = outcome?.bundleHash === undefined ? null : lower(outcome.bundleHash);
    if (!isHash(hash) || !TOKEN.test(token ?? '') || !['accepted', 'refused', 'unknown'].includes(status) ||
        (status === 'accepted' ? !isHash(bundleHash ?? '') : bundleHash !== null)) {
      throw new Error('SNIPE_BUNDLE_JOURNAL_INVALID_OUTCOME');
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      if (update.run(status, bundleHash, new Date().toISOString(), hash, token).changes !== 1) throw unavailable();
      db.exec('COMMIT');
      return true;
    } catch {
      try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* fail closed */ }
      failed = true;
      throw unavailable();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch { throw unavailable(); }
  }
  return Object.freeze({ lookup, reserve, markOutcome, close });
}
