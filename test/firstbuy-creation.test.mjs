import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Wallet, Transaction } from 'ethers';
import { makeExecutor } from '../src/execution.mjs';

test('zero-value bounded contract creation is opt-in and uses the original hash/nonce journal', async t => {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'corla-firstbuy-creation-'));
  const closers = [];
  t.after(async () => {
    for (const e of closers) e.close();
    const p = await realpath(root); assert.equal(dirname(p), parent); assert.ok(basename(p).startsWith('corla-firstbuy-creation-'));
    await rm(p, { recursive: true, force: true });
  });
  const wallet = Wallet.createRandom(); let submits = 0;
  const provider = { send: async method => method === 'eth_chainId' ? '0x38' : '0x64',
    getTransactionCount: async () => 0, getBalance: async () => 1_000_000_000n,
    estimateGas: async () => 30000n, call: async () => '0x', getTransactionReceipt: async () => null,
    async broadcastTransaction(raw) { const tx = Transaction.from(raw); assert.equal(tx.to, null); assert.equal(tx.value, 0n); submits++; return { hash: tx.hash }; } };
  const make = (name, options = {}) => { const e = makeExecutor({ provider, wallets: [wallet], live: true,
    journalPath: join(root, name + '.sqlite'), maxGasPriceWei: 100n, gasLimitCap: 50000n, receiptTimeoutMs: 0, ...options }); closers.push(e); return e; };
  const tx = { to: null, value: 0n, data: '0x60006000f3' };
  await assert.rejects(make('default')({ actionId: 'deploy:test', wallet: wallet.address, tx }), /creation is not enabled/);
  const enabled = make('enabled', { allowContractCreation: true });
  const pending = await enabled({ actionId: 'deploy:test', wallet: wallet.address, tx });
  assert.equal(pending.status, 'pending'); assert.equal(submits, 1);
  await enabled({ actionId: 'deploy:test', wallet: wallet.address, tx }); assert.equal(submits, 1);
  for (const bad of [{ ...tx, value: 1n }, { ...tx, data: '0x' + '60'.repeat(49153) }]) {
    await assert.rejects(make('bad-' + closers.length, { allowContractCreation: true })({ actionId: 'deploy:bad', wallet: wallet.address, tx: bad }), /zero value and bounded/);
  }
});
