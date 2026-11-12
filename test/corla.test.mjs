import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, parseEther, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { buildClaim, buildMint, CORLA_ABI, createCorlaInspectionScope, inspectMint } from '../src/corla.mjs';

const WALLET = '0x1234567890123456789012345678901234567890';
const target = {
  mint: '0x4724ce75d772eda774147f6198f1a876811d6e19',
  token: '0xc402b65aa0a6ef7562a1580fd778397d6e817777',
  factory: FACTORY,
  mintBatches: 1,
  maxMintPriceWei: parseEther('0.1'),
  autoClaim: true,
};
const block = { number: 123, timestamp: 1000 };
const active = {
  phase: 1, launched: false, emergencyWithdrawn: false, blockNumber: 123,
  fundingDeadline: 1100n, whitelistEnabled: false, whitelistDeadline: 0n, agentOnly: false,
  mintedLots: 4n, totalLots: 50n, pricePerLot: parseEther('0.1'), tokensPerLot: parseEther('1'), maxMintsPerWallet: 1n,
};

function walletProvider({
  count = 0n, latestCount = count, latestMinted = active.mintedLots,
  claimed = false, refunded = false, balance = parseEther('1'),
  latest = { number: 124, timestamp: 1001 }, latestState = {},
} = {}) {
  const replies = { ...active, maxMintsPerWallet: 3n, walletMintCount: count, claimed, refunded, mintedLots: latestMinted, ...latestState };
  return {
    async getBlock(tag) { assert.equal(tag, 'latest'); return latest; },
    async call({ to, data, blockTag }) {
      assert.equal(to, target.mint);
      assert.ok(blockTag === block.number || blockTag === latest.number);
      const { name, args } = CORLA_ABI.parseTransaction({ data });
      if (['walletMintCount', 'claimed', 'refunded'].includes(name)) assert.equal(args[0], WALLET);
      if (name === 'getMintState') return CORLA_ABI.encodeFunctionResult(name, [4n, replies.phase]);
      assert.ok(name in replies);
      return CORLA_ABI.encodeFunctionResult(name, [name === 'walletMintCount' && blockTag === latest.number ? latestCount : replies[name]]);
    },
    async getBalance(wallet, blockTag) {
      assert.equal(wallet, WALLET);
      assert.equal(blockTag, block.number);
      return balance;
    },
  };
}

test('builds observed empty-proof native mint, one lot and exact price', async () => {
  const plan = await buildMint(walletProvider(), target, active, WALLET, block);
  assert.deepEqual(plan.tx, {
    to: target.mint,
    data: '0xb77a147b' + '20'.padStart(64, '0') + '0'.repeat(64),
    value: parseEther('0.1'),
  });
  assert.equal(plan.details.lotsRemaining, 46n);
  assert.equal(plan.details.batches, 1);
  assert.equal(plan.details.mintOrdinal, 1);
  assert.equal(await plan.beforeSign(), 46n);
});

test('counts existing batches, clamps the goal, and still builds only one lot per transaction', async () => {
  const multi = { ...target, mintBatches: 4 };
  const state = { ...active, maxMintsPerWallet: 3n };
  const plan = await buildMint(walletProvider({ count: 2n }), multi, state, WALLET, block);
  assert.equal(plan.details.mintOrdinal, 3);
  assert.equal(plan.details.mintGoal, 3);
  assert.equal(plan.details.walletMintCount, 2n);
  assert.equal(plan.tx.value, active.pricePerLot);
  assert.equal(await buildMint(walletProvider({ count: 3n }), multi, state, WALLET, block), null);
  assert.equal(await buildMint(walletProvider({ count: 1n }), multi, active, WALLET, block), null);
  assert.equal(await buildMint(walletProvider(), { ...multi, mintBatches: 33 }, state, WALLET, block), null);
});

test('latest count and remaining supply guards reject stale mint calldata', async () => {
  const multi = { ...target, mintBatches: 4 };
  const state = { ...active, maxMintsPerWallet: 3n };
  const countMoved = await buildMint(walletProvider({ count: 1n, latestCount: 2n }), multi, state, WALLET, block);
  await assert.rejects(countMoved.beforeSign(), /次数已变化/);
  const closed = await buildMint(walletProvider({ latestMinted: state.totalLots }), multi, state, WALLET, block);
  await assert.rejects(closed.beforeSign(), /已重组或铸满/);
  const reorg = await buildMint(walletProvider({ latestMinted: 1n }), multi, state, WALLET, block);
  await assert.rejects(reorg.beforeSign(), /已重组或铸满/);
});

test('a mint prepared during funding must still pass deadline, current phase and terms before signing', async () => {
  const expired = await buildMint(walletProvider({ latest: { number: 124, timestamp: 1003 } }),
    target, { ...active, fundingDeadline: 1002n }, WALLET, block);
  await assert.rejects(expired.beforeSign(), /募集已截止/);
  for (const latestState of [
    { phase: 2 }, { emergencyWithdrawn: true }, { whitelistEnabled: true, whitelistDeadline: 1002n },
    { fundingDeadline: 1001n }, { agentOnly: true }, { pricePerLot: parseEther('0.2') }, { maxMintsPerWallet: 0n },
  ]) {
    const plan = await buildMint(walletProvider({ latestState }), target, active, WALLET, block);
    await assert.rejects(plan.beforeSign(), /阶段或交易参数已变化/);
  }
});

test('fails closed on incompatible phase, deadlines, wallet/agent restrictions, and price', async () => {
  for (const overrides of [
    { phase: 2 }, { launched: true }, { emergencyWithdrawn: true },
    { fundingDeadline: 999n }, { whitelistEnabled: true, whitelistDeadline: 1000n },
    { agentOnly: true }, { mintedLots: 50n }, { pricePerLot: parseEther('0.2') },
  ]) {
    assert.equal(await buildMint({}, target, { ...active, ...overrides }, WALLET, block), null);
  }
  assert.equal(await buildMint({}, { ...target, mintBatches: 0 }, active, WALLET, block), null);
  assert.equal(await buildMint(walletProvider({ count: 1n }), target, active, WALLET, block), null);
  assert.equal(await buildMint(walletProvider({ balance: active.pricePerLot }), target, active, WALLET, block), null);
  await assert.rejects(buildMint(walletProvider(), target, active, WALLET, { ...block, number: 124 }), /快照/);
  assert.ok(await buildMint(walletProvider(), target, {
    ...active, whitelistEnabled: true, whitelistDeadline: 999n,
  }, WALLET, block));
});

test('builds observed zero-value claim only for an eligible participant', async () => {
  const launched = { ...active, launched: true };
  const plan = await buildClaim(walletProvider({ count: 2n }), target, launched, WALLET);
  assert.deepEqual(plan.tx, { to: target.mint, data: '0x4e71d92d', value: 0n });
  assert.equal(plan.details.expectedClaimAmount, parseEther('2'));
  assert.equal(await buildClaim(walletProvider(), target, launched, WALLET), null);
  assert.equal(await buildClaim(walletProvider({ count: 1n, claimed: true }), target, launched, WALLET), null);
  assert.equal(await buildClaim(walletProvider({ count: 1n, refunded: true }), target, launched, WALLET), null);
  assert.equal(await buildClaim({}, target, active, WALLET), null);
  assert.equal(await buildClaim({}, { ...target, autoClaim: false }, launched, WALLET), null);
  const restricted = { ...target, mintWallets: [FACTORY] };
  assert.equal(await buildClaim({}, restricted, launched, WALLET), null);
  assert.equal(await buildMint({}, restricted, active, WALLET, block), null);
});

test('rejects a non-canonical or zero factory before RPC', async () => {
  await assert.rejects(inspectMint({}, { ...target, factory: WALLET }, block.number), /工厂/);
  await assert.rejects(inspectMint({}, { ...target, factory: ZeroAddress }, block.number), /非零/);
});

test('shared inspection deduplicates Beacon/implementation reads only at the same provider and block', async () => {
  const abi = new Interface(['function implementation() view returns (address)',
    'function deploymentIndexPlusOne(address) view returns (uint256)']);
  const impl = '0x9a2e15a581ce87f5d586745da78b9aeb01633583';
  const beacon = '0xdf8d1028fabda0201dbaf577a660fd8223d5b160';
  const reads = [];
  const provider = {
    async getCode(to, at) { reads.push([to.toLowerCase(), at]); return '0x'; },
    async call({ data, blockTag }) {
      const registry = abi.parseTransaction({ data });
      if (registry?.name === 'implementation') {
        reads.push(['implementation()', blockTag]);
        return abi.encodeFunctionResult(registry.name, [impl]);
      }
      if (registry) return abi.encodeFunctionResult(registry.name, [1n]);
      const { name } = CORLA_ABI.parseTransaction({ data });
      if (name === 'getMintState') return CORLA_ABI.encodeFunctionResult(name, [1n, 1]);
      const type = CORLA_ABI.getFunction(name).outputs[0].type;
      return CORLA_ABI.encodeFunctionResult(name, [type === 'address' ? ZeroAddress : type === 'bool' ? false : 1n]);
    },
  };
  const scope = createCorlaInspectionScope(provider, block.number);
  const other = { ...target, mint: WALLET };
  const result = await Promise.allSettled([
    inspectMint(provider, target, block.number, scope), inspectMint(provider, other, block.number, scope),
    inspectMint(provider, target, block.number + 1, scope), inspectMint({ ...provider }, target, block.number, scope),
  ]);
  assert.ok(result.every(row => row.status === 'rejected' && /代理或实现已变更/.test(row.reason.message)));
  for (const label of [beacon, impl, 'implementation()']) {
    assert.deepEqual(reads.filter(([addr]) => addr === label).map(([, at]) => at).sort(), [123, 123, 124]);
  }
  assert.ok(reads.some(([addr]) => addr === WALLET.toLowerCase()));
});

test('ABI topic hashes match BSC receipts', () => {
  assert.equal(CORLA_ABI.getEvent('Minted').topicHash, '0x30385c845b448a36257a6a1716e6ad2e1bc2cbe333cde1e69fe849ad6511adfe');
  assert.equal(CORLA_ABI.getEvent('Launched').topicHash, '0x33a8c95f5f2db419267a319b5eae65e50fdbec72a10c6e0bc380268275dee1e4');
  assert.equal(CORLA_ABI.getEvent('Claimed').topicHash, '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a');
});
