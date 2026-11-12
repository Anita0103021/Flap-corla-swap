import assert from 'node:assert/strict';
import test from 'node:test';
import { mintDefaultBatches, mintWalletFunding, mintWalletQuota } from '../ui/mint-wallet-selection.js';

const BNB = 10n ** 18n;
const price = BNB / 20n;
const gas = BNB / 400n;
const active = {
  launched: false, emergencyWithdrawn: false, phase: 1, pricePerLot: String(price),
  mintedLots: '5', totalLots: '100', maxMintsPerWallet: '3',
};
function picker(overrides = {}) {
  return mintWalletFunding({
    batches: 1, autoClaim: true, project: active, gasWei: gas,
    wallet: { balanceWei: String(BNB), mintedLots: '0', hasUnclaimedShare: false },
    ...overrides,
  });
}

test('requires native mint amount and gas with exact wei comparisons', () => {
  const needWei = price + 2n * gas;
  const wallet = { balanceWei: String(needWei), mintedLots: '0', hasUnclaimedShare: false };
  assert.deepEqual(picker({ wallet }), { status: 'sufficient', needWei });
  assert.deepEqual(picker({ wallet: { ...wallet, balanceWei: String(needWei - 1n) } }), { status: 'insufficient', needWei });
  assert.deepEqual(picker({ wallet, autoClaim: false }), { status: 'sufficient', needWei: price + gas });
});

test('uses remaining target lots, per-address cap, and available supply', () => {
  const wallet = { balanceWei: BNB, mintedLots: 1n, hasUnclaimedShare: true };
  assert.deepEqual(picker({ wallet, batches: 5 }), { status: 'sufficient', needWei: 2n * (price + gas) + gas });
  assert.deepEqual(picker({ wallet, batches: 5, project: { ...active, mintedLots: '99' } }),
    { status: 'sufficient', needWei: price + 2n * gas });
  assert.deepEqual(picker({ wallet, batches: 5, project: { ...active, mintedLots: '100' } }),
    { status: 'sufficient', needWei: gas });
  assert.deepEqual(picker({ wallet, autoClaim: false }), { status: 'idle', needWei: 0n });
});

test('claim-only and already launched projects reserve gas only for an unclaimed share', () => {
  const wallet = { balanceWei: gas, hasUnclaimedShare: true };
  assert.deepEqual(picker({ wallet, batches: 0 }), { status: 'sufficient', needWei: gas });
  const launched = { launched: true, emergencyWithdrawn: false, phase: 3 };
  assert.deepEqual(picker({ wallet, project: launched, batches: 32 }), { status: 'sufficient', needWei: gas });
  assert.deepEqual(picker({ wallet: { ...wallet, balanceWei: '0' }, project: launched }), { status: 'insufficient', needWei: gas });
  assert.deepEqual(picker({ wallet: { ...wallet, hasUnclaimedShare: false }, project: launched }), { status: 'idle', needWei: 0n });
  assert.deepEqual(picker({ wallet, project: launched, autoClaim: false }), { status: 'idle', needWei: 0n });
});

test('withdrawn, expired, and disabled plans are not selected; temporary whitelist is not excluded', () => {
  const wallet = { balanceWei: BNB, mintedLots: '1', hasUnclaimedShare: true };
  assert.deepEqual(picker({ wallet, project: { ...active, phase: '2' } }), { status: 'idle', needWei: 0n });
  assert.deepEqual(picker({ wallet, project: { ...active, emergencyWithdrawn: true } }), { status: 'idle', needWei: 0n });
  assert.deepEqual(picker({ batches: 0, autoClaim: false, project: null, wallet: null }), { status: 'idle', needWei: 0n });
  assert.deepEqual(picker({ project: { ...active, whitelistEnabled: true }, batches: 2 }), { status: 'sufficient', needWei: 2n * price + 3n * gas });
  assert.deepEqual(picker({ project: { ...active, agentOnly: true }, wallet }), { status: 'sufficient', needWei: gas });
});

test('unknown RPC, participant, project, or gas data never qualifies a wallet', () => {
  assert.deepEqual(picker({ wallet: { balanceWei: null, mintedLots: '0' } }), { status: 'unknown', needWei: price + 2n * gas });
  for (const changes of [
    { wallet: { balanceWei: BNB } }, { wallet: { balanceWei: BNB }, batches: 0 },
    { project: null }, { project: { ...active, pricePerLot: '0' } },
    { project: { ...active, mintedLots: '101' } }, { project: { ...active, maxMintsPerWallet: null } },
    { project: { ...active, phase: 4 } }, { gasWei: 0n }, { batches: 33 }, { batches: '1.5' },
  ]) assert.deepEqual(picker(changes), { status: 'unknown', needWei: null });
});

test('displayed quota is the contract cap minus each wallet’s own count, independent of balance or project supply', () => {
  const one = { ...active, maxMintsPerWallet: '1' };
  assert.deepEqual(mintWalletQuota(one, { mintedLots: '0', balanceWei: null }),
    { minted: 0n, cap: 1n, remaining: 1n, stop: null });
  assert.deepEqual(mintWalletQuota(one, { mintedLots: '1', balanceWei: BNB }),
    { minted: 1n, cap: 1n, remaining: 0n, stop: null });
  assert.deepEqual(mintWalletQuota({ ...active, mintedLots: '99' }, { mintedLots: '1' }),
    { minted: 1n, cap: 3n, remaining: 2n, stop: null });
  assert.equal(mintWalletQuota(one, { mintedLots: '2' }).remaining, 0n);
});

test('unknown quota does not display as zero, and a closed project is not presented as mintable', () => {
  assert.equal(mintWalletQuota(active, { balanceWei: BNB }), null);
  assert.equal(mintWalletQuota({ ...active, maxMintsPerWallet: null }, { mintedLots: '0' }), null);
  assert.equal(mintWalletQuota({ ...active, launched: true }, { mintedLots: '0' }).stop, 'launched');
  assert.equal(mintWalletQuota({ ...active, phase: 2 }, { mintedLots: '0' }).stop, 'closed');
  assert.equal(mintWalletQuota({ ...active, mintedLots: '100' }, { mintedLots: '0' }).stop, 'sold-out');
});

test('new targets default to the per-address cap only when the project has enough lots', () => {
  const project = { ...active, maxMintsPerWallet: '18' };
  assert.equal(mintDefaultBatches(project), 18);
  assert.equal(mintDefaultBatches({ ...project, mintedLots: '82' }), 18);
  assert.equal(mintDefaultBatches({ ...project, mintedLots: '83' }), 1);
  assert.equal(mintDefaultBatches({ ...project, mintedLots: '99' }), 1);
  assert.equal(mintDefaultBatches({ ...project, maxMintsPerWallet: '40', mintedLots: '60' }), 32);
  assert.equal(mintDefaultBatches({ ...project, maxMintsPerWallet: '40', mintedLots: '65' }), 1);
});

test('new targets distinguish a finished sale from unavailable contract data', () => {
  assert.equal(mintDefaultBatches({ ...active, mintedLots: '100' }), 0);
  assert.equal(mintDefaultBatches({ ...active, phase: 2 }), 0);
  assert.equal(mintDefaultBatches({ ...active, launched: true }), 0);
  assert.equal(mintDefaultBatches({ ...active, emergencyWithdrawn: true }), 0);
  for (const project of [null, { ...active, error: 'RPC failure' }, { ...active, mintedLots: null },
    { ...active, mintedLots: '101' }, { ...active, maxMintsPerWallet: '0' }, { ...active, phase: undefined }]) {
    assert.equal(mintDefaultBatches(project), null);
  }
});
