import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Transaction, Wallet, toQuantity } from 'ethers';
import { reconstructSignedBscTx } from '../scripts/replay-firstbuy-fork.mjs';

test('historical replay reconstructs exact signed envelopes without changing sender, nonce, input or fees', async () => {
  const signer = Wallet.createRandom();
  for (const type of [0, 1, 2]) {
    const tx = Transaction.from(await signer.signTransaction({ chainId: 56, type, nonce: 7,
      to: '0x' + '12'.repeat(20), value: 123n, gasLimit: 30000n, data: '0x12345678',
      ...(type === 2 ? { maxFeePerGas: 100n, maxPriorityFeePerGas: 90n } : { gasPrice: 100n }),
      ...(type ? { accessList: [] } : {}) }));
    const row = { hash: tx.hash, from: tx.from, to: tx.to, chainId: '0x38', type: toQuantity(type),
      nonce: toQuantity(tx.nonce), value: toQuantity(tx.value), gas: toQuantity(tx.gasLimit), input: tx.data,
      ...(type === 2 ? { maxFeePerGas: toQuantity(tx.maxFeePerGas), maxPriorityFeePerGas: toQuantity(tx.maxPriorityFeePerGas) }
        : { gasPrice: toQuantity(tx.gasPrice) }), accessList: tx.accessList,
      r: tx.signature.r, s: tx.signature.s, v: toQuantity(type === 0 ? tx.signature.networkV : tx.signature.yParity) };
    assert.equal(reconstructSignedBscTx(row).serialized, tx.serialized);
    assert.throws(() => reconstructSignedBscTx({ ...row, hash: '0x' + 'ab'.repeat(32) }), /SIGNATURE_MISMATCH/);
    assert.throws(() => reconstructSignedBscTx({ ...row, chainId: '0x1' }), /INVALID_BSC/);
  }
});

test('both historical replay CLIs are opt-in, show help offline, and expose no live flag', () => {
  for (const name of ['replay-firstbuy-fork.mjs', 'replay-firstbuy-simulate.mjs']) {
    const path = fileURLToPath(new URL('../scripts/' + name, import.meta.url));
    const help = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--fixture/);
    const bad = spawnSync(process.execPath, [path, '--live'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(bad.status, 1);
    assert.ok(!bad.stdout.includes('0x'));
  }
});
