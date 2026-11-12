import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, parseEther } from 'ethers';
import { parseMintLink, loadConfig, checkBudget, FACTORY } from '../src/config.mjs';

const sample = 'https://flap.sh/apps/corla/mint/0xc402b65aa0a6ef7562a1580fd778397d6e817777?mint=0x4724ce75d772eda774147f6198f1a876811d6e19&factory=0xfba753f8b890eb35caa000c427f99ed5903ea517&catalogVersion=4&lang=zh';

test('only supported Corla URL, pinned factory and exact catalog v4', () => {
  assert.equal(parseMintLink(sample).factory, FACTORY);
  assert.throws(() => parseMintLink(sample.replace('flap.sh', 'flap.sh.attacker.invalid')));
  assert.throws(() => parseMintLink(sample.replace('catalogVersion=4', 'catalogVersion=5')));
  assert.throws(() => parseMintLink(sample.replace(FACTORY.toLowerCase(), ZeroAddress)));
  assert.throws(() => parseMintLink(sample + '&mint=0x4724ce75d772eda774147f6198f1a876811d6e19'));
});

test('budget includes maximum principal and gas for every eligible action', async () => {
  const cfg = await loadConfig('config.example.json');
  assert.equal(cfg.targets.length, 2);
  const wallets = [{}, {}];
  assert.equal(checkBudget(cfg, wallets), parseEther('0.2275'));
  assert.throws(() => checkBudget({ ...cfg, maxTotalWei: parseEther('0.227499') }, wallets));
  assert.throws(() => checkBudget(cfg, []));
});
