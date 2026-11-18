import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openSnipeBundleJournal } from '../src/snipe-bundle-journal.mjs';

const hash = byte => '0x' + byte.repeat(32);
const address = byte => '0x' + byte.repeat(20);
const intent = Object.freeze({ chainId: 56, mint: address('11'), token: address('22'), wallet: address('33'),
  nonce: 7, buyTxHash: hash('44'), parentBlock: 1, parentHash: hash('55'), targetBlock: 2,
  maxTimestamp: 10_000, mintHashes: [hash('66')] });

function fixture(t) {
  const base = realpathSync(tmpdir());
  const directory = mkdtempSync(join(base, 'corla-bundle-journal-'));
  const journals = [];
  t.after(() => {
    for (const journal of journals) journal.close();
    // Delete only the verified temp workspace created by this test.
    assert.equal(dirname(realpathSync(directory)), base);
    assert.match(basename(directory), /^corla-bundle-journal-/);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path: join(directory, 'bundle-intents.sqlite'), open(options = {}) {
    const journal = openSnipeBundleJournal({ directory, ...options });
    journals.push(journal);
    return journal;
  } };
}

test('journal atomically locks the buy intent and wallet nonce across instances and reopen; outcomes never release it', t => {
  const f = fixture(t), a = f.open(), b = f.open();
  assert.equal(a.lookup(intent), false);
  const reserved = a.reserve(intent);
  assert.equal(reserved.status, 'reserved');
  assert.equal(b.lookup(intent), true);
  assert.deepEqual(b.reserve(intent), { status: 'duplicate' });
  for (const modified of [
    { ...intent, buyTxHash: hash('77') }, // replacement raw/hash, same wallet nonce
    { ...intent, buyTxHash: hash('88'), nonce: 8 }, // same mint/wallet intent, fresh nonce
    { ...intent, buyTxHash: hash('99'), mint: address('77') }, // other project, same wallet nonce
  ]) assert.deepEqual(b.reserve(modified), { status: 'duplicate' });
  a.markOutcome(reserved.reservation, { status: 'unknown' });
  a.close(); b.close();
  const reopened = f.open();
  assert.equal(reopened.lookup({ ...intent, maxTimestamp: 1 }), true, 'deadline does not release an uncertain reservation');
  assert.deepEqual(reopened.reserve(intent), { status: 'duplicate' });
  const separate = { ...intent, mint: address('77'), buyTxHash: hash('99'), nonce: 8 };
  assert.equal(reopened.reserve(separate).status, 'reserved');
});

test('ACK, explicit refusal and crashed reserved state stay locked and only public allowlisted fields reach disk', t => {
  const f = fixture(t), journal = f.open();
  const sensitive = 'credential/DO_NOT_PERSIST';
  for (const [index, status] of ['accepted', 'refused', 'unknown', 'reserved'].entries()) {
    const row = { ...intent, nonce: 20 + index, mint: address(String(index + 4).repeat(2)),
      buyTxHash: hash((index + 10).toString(16).padStart(2, '0')), raw: sensitive, rpcUrl: sensitive, signature: sensitive };
    const reserved = journal.reserve(row);
    if (status !== 'reserved') journal.markOutcome(reserved.reservation, {
      status, ...(status === 'accepted' ? { bundleHash: hash('bb') } : {}), raw: sensitive,
    });
    assert.equal(journal.lookup(row), true);
  }
  const read = new DatabaseSync(f.path, { readOnly: true });
  try {
    const rows = read.prepare('SELECT * FROM bundle_intents ORDER BY nonce').all();
    assert.deepEqual(rows.map(row => row.status), ['accepted', 'refused', 'unknown', 'reserved']);
    assert.equal(rows[0].bundle_hash, hash('bb'));
    assert.equal(rows[0].mint_hashes, JSON.stringify(intent.mintHashes));
    assert.equal(JSON.stringify(rows).includes(sensitive), false);
  } finally { read.close(); }
  journal.close();
  assert.equal(readFileSync(f.path).includes(Buffer.from(sensitive)), false);
  const next = f.open();
  assert.equal(next.reserve({ ...intent, nonce: 20, mint: address('44'), buyTxHash: hash('77') }).status, 'duplicate');
});

test('existing foreign databases, altered schemas, corrupt input and escaped filenames fail closed without migrating user data', t => {
  const f = fixture(t);
  assert.throws(() => openSnipeBundleJournal(), /INVALID_PATH/);
  assert.throws(() => openSnipeBundleJournal({ directory: '.', fileName: 'x.sqlite' }), /INVALID_PATH/);
  for (const fileName of ['../state.sqlite', 'dir/x.sqlite', '..\\state.sqlite', ':memory:', 'file:memory:']) {
    assert.throws(() => f.open({ fileName }), /INVALID_PATH/);
  }
  const foreignFile = join(f.directory, 'foreign.sqlite');
  const foreign = new DatabaseSync(foreignFile);
  foreign.exec('CREATE TABLE private_wallet_data (value TEXT); INSERT INTO private_wallet_data VALUES (\'unchanged\')');
  foreign.close();
  const before = readFileSync(foreignFile);
  assert.throws(() => f.open({ fileName: 'foreign.sqlite' }), /UNAVAILABLE/);
  assert.deepEqual(readFileSync(foreignFile), before);
  const altered = f.open();
  altered.close();
  const tamper = new DatabaseSync(f.path);
  tamper.exec('CREATE TRIGGER unexpected AFTER INSERT ON bundle_intents BEGIN DELETE FROM bundle_intents; END');
  tamper.close();
  assert.throws(() => f.open(), /UNAVAILABLE/);
  writeFileSync(join(f.directory, 'corrupt.sqlite'), 'not a database');
  assert.throws(() => f.open({ fileName: 'corrupt.sqlite' }), /UNAVAILABLE/);
  mkdirSync(join(f.directory, 'not-file.sqlite'));
  assert.throws(() => f.open({ fileName: 'not-file.sqlite' }), /UNAVAILABLE/);
  linkSync(foreignFile, join(f.directory, 'linked.sqlite'));
  assert.throws(() => f.open({ fileName: 'linked.sqlite' }), /UNAVAILABLE/);
});

test('invalid intents/outcomes, closed handles, database locking and update failures do not silently unlock reservations', t => {
  const f = fixture(t), journal = f.open();
  for (const value of [undefined, { ...intent, chainId: 1 }, { ...intent, nonce: -1 },
    { ...intent, mintHashes: [] }, { ...intent, targetBlock: 3 }, { ...intent, buyTxHash: intent.mintHashes[0] }]) {
    assert.throws(() => journal.reserve(value), /INVALID_INTENT/);
  }
  const reservation = journal.reserve(intent).reservation;
  assert.throws(() => journal.markOutcome(reservation, { status: 'mined' }), /INVALID_OUTCOME/);
  assert.throws(() => journal.markOutcome(reservation, { status: 'accepted' }), /INVALID_OUTCOME/);
  assert.equal(journal.lookup(intent), true);
  const owner = new DatabaseSync(f.path, { timeout: 1 });
  owner.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => journal.markOutcome(reservation, { status: 'unknown' }), /UNAVAILABLE/);
  } finally { owner.exec('ROLLBACK'); owner.close(); }
  assert.throws(() => journal.lookup(intent), /UNAVAILABLE/, 'write errors poison this handle');
  journal.close();
  assert.throws(() => journal.lookup(intent), /UNAVAILABLE/);
  assert.deepEqual(f.open().reserve(intent), { status: 'duplicate' });
});

test('two separate processes racing the same durable reservation admit only one submitter', async t => {
  const f = fixture(t);
  f.open().close();
  const source = `
    import { once } from 'node:events';
    import { openSnipeBundleJournal } from ${JSON.stringify(new URL('../src/snipe-bundle-journal.mjs', import.meta.url).href)};
    const journal = openSnipeBundleJournal({ directory: process.argv[1] });
    console.log(JSON.stringify({ready:true}));
    await once(process.stdin, 'data');
    console.log(JSON.stringify({result: journal.reserve(JSON.parse(process.argv[2])).status}));
    journal.close();
    process.stdin.destroy();
  `;
  function child() {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, JSON.stringify(intent)], {
      cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', error = '', onReady;
    const ready = new Promise(resolveReady => { onReady = resolveReady; });
    proc.stdout.setEncoding('utf8').on('data', part => { output += part; if (output.includes('"ready":true')) onReady(); });
    proc.stderr.setEncoding('utf8').on('data', part => { error += part; });
    proc.stdin.on('error', () => {});
    const timeout = setTimeout(() => proc.kill(), 6000);
    const done = new Promise((resolveDone, reject) => {
      proc.once('error', reject);
      proc.once('close', code => {
        clearTimeout(timeout);
        onReady();
        if (code !== 0) reject(new Error(`fixture child failed ${code}: ${error}`));
        else resolveDone(JSON.parse(output.trim().split('\n').at(-1)).result);
      });
    });
    // Avoid an unhandled rejection if setup fails before reaching the barrier.
    done.catch(() => {});
    t.after(() => { clearTimeout(timeout); proc.kill(); });
    return { ready, done, release: () => proc.stdin.end('go\n') };
  }
  const children = [child(), child()];
  await Promise.all(children.map(child => child.ready));
  children.forEach(child => child.release());
  assert.deepEqual((await Promise.all(children.map(child => child.done))).sort(), ['duplicate', 'reserved']);
  assert.equal(f.open().lookup(intent), true);
});
