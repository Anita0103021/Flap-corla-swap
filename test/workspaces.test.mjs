import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAddress, parseEther } from 'ethers';
import { checkBudget, mintWalletsFor, parseMintLink, validateConfig } from '../src/config.mjs';

const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
const firstUrl = example.targets[0].url;
const secondUrl = example.targets[1].url;
const firstWallet = getAddress('0x000000000000000000000000000000000000beef');
const secondWallet = getAddress('0x000000000000000000000000000000000000dead');
const missingWallet = getAddress('0x000000000000000000000000000000000000face');
const wallets = [{ address: firstWallet }, { address: secondWallet }];
const configFor = (cfg, workspace) => validateConfig(cfg, process.cwd(), { allowEmptyTargets: true, workspace });

function raw() {
  return {
    ...structuredClone(example),
    gasLimitCap: 10_000_000,
    maxGasPriceGwei: '0.25',
    maxTotalBnb: '1',
    targets: [{ url: firstUrl, mintBatches: 3, maxMintPriceBnb: '0.1', autoClaim: true, mintWallets: [secondWallet.toLowerCase()] }],
    snipeTargets: [secondUrl],
    snipe: { ...example.snipe, amountBnb: '0.4', walletCount: 1 },
  };
}

test('opening guard is on for old configurations, cannot be widened beyond 10%, and no-chase requires the pending lane', () => {
  const cfg = raw();
  delete cfg.snipe.maxOpeningPremiumBps;
  delete cfg.snipe.requirePreopen;
  assert.equal(configFor(cfg, 'snipe').snipe.maxOpeningPremiumBps, 1000);
  assert.equal(configFor(cfg, 'snipe').snipe.requirePreopen, false);
  for (const invalid of [null, '1000', 1001, -1, 0.5]) {
    cfg.snipe.maxOpeningPremiumBps = invalid;
    assert.throws(() => configFor(cfg, 'snipe'), /maxOpeningPremiumBps/);
  }
  cfg.snipe.maxOpeningPremiumBps = 0;
  cfg.snipe.requirePreopen = true;
  assert.throws(() => configFor(cfg, 'snipe'), /没抢到开盘就不追/);
  cfg.snipe.repeatAttempts = 3;
  assert.equal(configFor(cfg, 'snipe').snipe.maxOpeningPremiumBps, 0);
  assert.equal(configFor(cfg, 'snipe').snipe.requirePreopen, true);
});

test('Mint and snipe workspaces independently compile different allowlists and actions', () => {
  const cfg = raw();
  const mint = configFor(cfg, 'mint');
  assert.deepEqual(mint.targets, [{
    ...parseMintLink(firstUrl),
    mintBatches: 3, maxMintPriceWei: parseEther('0.1'), autoClaim: true,
    mintWallets: [secondWallet], buyOnLaunch: false,
  }]);
  assert.equal(mint.snipe, null);
  const snipe = configFor(cfg, 'snipe');
  assert.deepEqual(snipe.targets, [{
    ...parseMintLink(secondUrl),
    mintBatches: 0, maxMintPriceWei: 0n, autoClaim: false, buyOnLaunch: true,
  }]);
  assert.equal(snipe.snipe.amountIn, parseEther('0.4'));
  assert.throws(() => configFor(cfg, 'anything-else'), /工作区/);
});

test('allowlists may overlap without duplicate status rows or cross-workspace actions', () => {
  const cfg = { ...raw(), snipeTargets: [firstUrl] };
  assert.equal(configFor(cfg, 'mint').targets[0].buyOnLaunch, false);
  assert.equal(configFor(cfg, 'snipe').targets[0].mintBatches, 0);
  const merged = configFor(cfg, 'all');
  assert.equal(merged.targets.length, 1);
  assert.equal(merged.targets[0].mintBatches, 3);
  assert.equal(merged.targets[0].buyOnLaunch, true);
  assert.throws(() => configFor({ ...cfg, snipeTargets: [firstUrl, firstUrl] }, 'snipe'), /重复/);
  assert.throws(() => configFor({ ...cfg, snipeTargets: [firstUrl.replace('flap.sh', 'attacker.invalid')] }, 'snipe'), /flap\.sh/);
});

test('legacy buyOnLaunch migrates only when no explicit snipeTargets list is stored', () => {
  const cfg = raw();
  delete cfg.snipeTargets;
  cfg.targets[0].buyOnLaunch = true;
  assert.equal(configFor(cfg, 'snipe').targets[0].mint, parseMintLink(firstUrl).mint);
  assert.equal(configFor(cfg, 'mint').targets[0].buyOnLaunch, false);
  assert.deepEqual(configFor({ ...cfg, snipeTargets: [] }, 'snipe').targets, []);
  const onlySnipe = { ...cfg, targets: [], snipeTargets: [secondUrl] };
  assert.deepEqual(configFor(onlySnipe, 'mint').targets, []);
  assert.equal(configFor(onlySnipe, 'snipe').targets.length, 1);
});

test('Mint goal is an integer 0–32 and selected wallets are nonempty unique checksummed addresses', () => {
  const cfg = raw();
  assert.equal(configFor(cfg, 'mint').targets[0].mintWallets[0], secondWallet);
  cfg.targets[0].mintBatches = 32;
  assert.equal(configFor(cfg, 'mint').targets[0].mintBatches, 32);
  for (const invalid of [-1, 1.5, 33, '2']) {
    cfg.targets[0].mintBatches = invalid;
    assert.throws(() => configFor(cfg, 'mint'), /目标次数/);
  }
  cfg.targets[0].mintBatches = 0;
  assert.equal(configFor(cfg, 'mint').targets[0].autoClaim, true);
  for (const invalid of [[], [firstWallet, firstWallet.toLowerCase()], ['not an address']]) {
    cfg.targets[0].mintWallets = invalid;
    assert.throws(() => configFor(cfg, 'mint'), /钱包/);
  }
});

test('scope budgets count one gas allowance per requested batch and charge selected wallets only', () => {
  const cfg = raw();
  const mint = configFor(cfg, 'mint');
  assert.deepEqual(mintWalletsFor(mint.targets[0], wallets), [wallets[1]]);
  // Per selected wallet: 3 * (0.1 BNB principal + 0.0025 BNB gas) + 0.0025 BNB claim gas.
  assert.equal(checkBudget(mint, wallets), parseEther('0.31'));
  assert.equal(checkBudget(mint, [firstWallet, secondWallet.toLowerCase()]), parseEther('0.31'));
  assert.equal(checkBudget(configFor(cfg, 'snipe'), wallets), parseEther('0.4025'));
  assert.equal(checkBudget(configFor(cfg, 'all'), wallets), parseEther('0.7125'));
  assert.throws(() => checkBudget({ ...mint, maxTotalWei: parseEther('0.3099999') }, wallets), /总预算/);
  delete cfg.targets[0].mintWallets;
  assert.equal(checkBudget(configFor(cfg, 'mint'), wallets), parseEther('0.62'));
  cfg.targets[0].mintWallets = [missingWallet];
  assert.throws(() => checkBudget(configFor(cfg, 'mint'), wallets), /不在钱包库/);
  assert.equal(checkBudget(configFor(cfg, 'snipe'), wallets), parseEther('0.4025'));
  cfg.targets[0].mintWallets = [secondWallet];
  cfg.targets[0].mintBatches = 0;
  assert.equal(checkBudget(configFor(cfg, 'mint'), wallets), parseEther('0.0025'));
});
