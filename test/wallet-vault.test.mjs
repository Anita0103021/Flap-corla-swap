import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
import { createWalletVault } from '../src/wallet-vault.mjs';

const password = 'vault-fixture-only-2026!';
const otherPassword = 'different-fixture-password';
const safeError = pattern => error => error.code === 'WALLET_VAULT' &&
  pattern.test(error.message) && !error.message.includes(password) && !error.message.includes(otherPassword);

async function fixture(t) {
  const tmp = await realpath(tmpdir());
  const prefix = 'corla-wallet-vault-test-';
  const dir = await mkdtemp(join(tmp, prefix));
  t.after(async () => {
    const actual = await realpath(dir);
    assert.equal(dirname(actual), tmp);
    assert.ok(basename(actual).startsWith(prefix));
    await rm(actual, { recursive: true, force: true });
  });
  const file = join(dir, 'state', 'wallet-vault.json');
  return { file, vault: createWalletVault(file) };
}

test('encrypts wallet keys at rest and restores the exact connected signers on restart', async t => {
  const { file, vault } = await fixture(t);
  const wallet = Wallet.createRandom();
  const row = { address: wallet.address, label: '交易组 A' };
  assert.equal(await vault.exists(), false);
  assert.deepEqual(await vault.list(), []);
  await assert.rejects(vault.importWallets({ password: 'short', privateKeys: [wallet.privateKey] }), safeError(/至少/));
  assert.deepEqual(await vault.importWallets({ password, privateKeys: [wallet.privateKey], label: row.label }), [row]);
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.toLowerCase().includes(wallet.privateKey.slice(2).toLowerCase()));
  assert.ok(!raw.includes(password));
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['ciphertext', 'format', 'iv', 'salt', 'tag', 'version', 'wallets']);
  const reopened = createWalletVault(file);
  const provider = {};
  assert.equal(await reopened.exists(), true);
  assert.deepEqual(await reopened.list(), [row]);
  const [signer] = await reopened.unlock({ password, provider });
  assert.equal(signer.address, wallet.address);
  assert.equal(signer.privateKey, wallet.privateKey);
  assert.equal(signer.provider, provider);
  assert.deepEqual(await readdir(dirname(file)), ['wallet-vault.json']);
});

test('requires the existing password for every mutation and keeps it after removing the final wallet', async t => {
  const { file, vault } = await fixture(t);
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  await vault.importWallets({ password, privateKeys: [a.privateKey] });
  await assert.rejects(vault.unlock({ password: otherPassword }), safeError(/密码错误/));
  await assert.rejects(vault.importWallets({ password: otherPassword, privateKeys: [b.privateKey] }), safeError(/密码错误/));
  await assert.rejects(vault.removeWallet({ password: otherPassword, address: a.address }), safeError(/密码错误/));
  assert.deepEqual(await vault.list(), [{ address: a.address, label: '' }]);
  assert.deepEqual(await vault.removeWallet({ password, address: a.address.toLowerCase() }), []);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).wallets, []);
  const reopened = createWalletVault(file);
  assert.equal(await reopened.exists(), true);
  await assert.rejects(reopened.importWallets({ password: otherPassword, privateKeys: [b.privateKey] }), safeError(/密码错误/));
  assert.deepEqual(await reopened.importWallets({ password, privateKeys: [b.privateKey] }), [{ address: b.address, label: '' }]);
});

test('validates entire batch, refuses duplicates, and prevents accidental secret labels', async t => {
  const { file, vault } = await fixture(t);
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const invalid = '0x' + '0'.repeat(64);
  await assert.rejects(vault.importWallets({ password, privateKeys: [invalid] }), safeError(/有效的 EVM/));
  await assert.rejects(vault.importWallets({ password, privateKeys: [a.privateKey], label: '不要存:' + a.privateKey }), safeError(/备注无效/));
  await assert.rejects(vault.importWallets({ password, privateKeys: [a.privateKey], label: password }), safeError(/备注无效/));
  await assert.rejects(vault.importWallets({ password, privateKeys: [a.privateKey, b.privateKey], label: '备注' }), safeError(/批量导入/));
  await assert.rejects(vault.importWallets({ password, privateKeys: [a.privateKey, a.privateKey] }), safeError(/重复钱包/));
  assert.deepEqual(await vault.list(), []);
  const imported = await vault.importWallets({ password, privateKeys: a.privateKey + '\n' + b.privateKey.slice(2) });
  assert.deepEqual(imported.map(row => row.address), [a.address, b.address]);
  const before = await readFile(file, 'utf8');
  await assert.rejects(vault.importWallets({ password, privateKeys: [a.privateKey] }), safeError(/重复钱包/));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('authenticates public metadata and detects ciphertext tampering before signing', async t => {
  const { file, vault } = await fixture(t);
  const a = Wallet.createRandom();
  await vault.importWallets({ password, privateKeys: [a.privateKey], label: '真实备注' });
  const original = JSON.parse(await readFile(file, 'utf8'));
  const clone = structuredClone(original);
  clone.wallets[0].label = '伪造备注';
  await writeFile(file, JSON.stringify(clone), 'utf8');
  await assert.rejects(vault.unlock({ password }), safeError(/密码错误|损坏/));
  original.ciphertext = (original.ciphertext[0] === 'a' ? 'b' : 'a') + original.ciphertext.slice(1);
  await writeFile(file, JSON.stringify(original), 'utf8');
  await assert.rejects(vault.removeWallet({ password, address: a.address }), safeError(/密码错误|损坏/));
});

test('concurrent mutations from independent vault instances preserve both entries', async t => {
  const { file, vault } = await fixture(t);
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  await Promise.all([
    vault.importWallets({ password, privateKeys: [a.privateKey] }),
    createWalletVault(file).importWallets({ password, privateKeys: [b.privateKey] }),
  ]);
  const rows = await vault.list();
  assert.deepEqual(rows.map(row => row.address), [a.address, b.address]);
  assert.deepEqual(await readdir(dirname(file)), ['wallet-vault.json']);
});
