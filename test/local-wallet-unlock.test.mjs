import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalWalletUnlock } from '../src/local-wallet-unlock.mjs';

const pass = '  synthetic-本机-emoji🧪\n\u0000quotes: `$()  ';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'corla-dpapi-test-'));
  const path = join(dir, 'wallet-unlock.json');
  t.after(async () => {
    await rm(path, { force: true });
    await rmdir(dir);
  });
  return { dir, path };
}

test('Windows DPAPI saves an encrypted credential and the same Windows account reads the original bytes', {
  skip: process.platform !== 'win32',
}, async t => {
  const { dir, path } = await temporary(t);
  const store = createLocalWalletUnlock(path);
  assert.equal(store.supported, true);
  assert.equal(await store.exists(), false);
  await assert.rejects(store.read(), { code: 'LOCAL_WALLET_UNLOCK' });
  await store.save(pass);
  assert.equal(await store.exists(), true);
  assert.equal(await createLocalWalletUnlock(path).read(), pass);
  const onDisk = await readFile(path, 'utf8');
  assert.ok(!onDisk.includes('synthetic-'));
  assert.ok(!onDisk.includes(Buffer.from(pass).toString('hex')));
  assert.deepEqual(await readdir(dir), ['wallet-unlock.json']);
  const record = JSON.parse(onDisk);
  const bytes = Buffer.from(record.protected, 'hex');
  bytes[Math.floor(bytes.length / 2)] ^= 0x80;
  await writeFile(path, JSON.stringify({ ...record, protected: bytes.toString('hex') }));
  await assert.rejects(store.read(), { code: 'LOCAL_WALLET_UNLOCK' });
  await store.remove();
  await store.remove();
  assert.equal(await store.exists(), false);
});

test('invalid, oversized and wrong-user records fail closed; failed protect does not replace an earlier record', async t => {
  const { path } = await temporary(t);
  let allowed = true;
  const store = createLocalWalletUnlock(path, {
    platform: 'win32',
    async protect() {
      if (!allowed) throw new Error('synthetic DPAPI failure');
      return Buffer.from('synthetic encrypted blob');
    },
    async unprotect() { throw new Error('synthetic wrong user'); },
  });
  await store.save(pass);
  const original = await readFile(path, 'utf8');
  assert.equal(await store.exists(), true);
  await assert.rejects(store.read(), { code: 'LOCAL_WALLET_UNLOCK' });
  allowed = false;
  await assert.rejects(store.save(pass), { code: 'LOCAL_WALLET_UNLOCK' });
  assert.equal(await readFile(path, 'utf8'), original);
  for (const invalid of ['not json', '{}', 'a'.repeat(8192 + 512)]) {
    await writeFile(path, invalid);
    assert.equal(await store.exists(), false);
    await assert.rejects(store.read(), { code: 'LOCAL_WALLET_UNLOCK' });
  }
});

test('non-Windows platforms do not create an unprotected fallback file', async t => {
  const { path } = await temporary(t);
  const store = createLocalWalletUnlock(path, { platform: 'linux' });
  assert.equal(store.supported, false);
  assert.equal(await store.exists(), false);
  await assert.rejects(store.save(pass), { code: 'LOCAL_WALLET_UNLOCK' });
  await assert.rejects(store.read(), { code: 'LOCAL_WALLET_UNLOCK' });
  await assert.rejects(store.remove(), { code: 'LOCAL_WALLET_UNLOCK' });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});
