import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { MULTICALL3, readDashboardParticipants, readDashboardProjects, readDashboardWalletBalances } from '../src/dashboard-chain.mjs';

const MC = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256)',
  'function getChainId() view returns (uint256)',
  'function getEthBalance(address) view returns (uint256)',
]);
const REGISTRY = new Interface(['function deploymentIndexPlusOne(address) view returns (uint256)']);
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const target = (n, launched = false) => ({ mint: addr(100 + n), token: addr(500 + n), factory: FACTORY, launched });
const wallet = addr(75);
const fixture = [target(1), target(2, true)];

function createProvider({ targets = fixture, fail = () => false, emptyMulticall = false, chainId = 56n, failRequest,
  balance = () => 101n } = {}) {
  const requests = [];
  const calls = [];
  let heads = 0;
  let chainReads = 0;
  const response = (to, data, height) => {
    if (to === MULTICALL3) {
      const parsed = MC.parseTransaction({ data });
      if (parsed.name === 'getBlockNumber') return MC.encodeFunctionResult('getBlockNumber', [height]);
      if (parsed.name === 'getChainId') return MC.encodeFunctionResult('getChainId', [chainId]);
      if (parsed.name === 'getEthBalance') {
        const [account] = parsed.args;
        calls.push([to, parsed.name, account]);
        if (fail(to, parsed.name, account)) throw new Error('partial balance failure');
        return MC.encodeFunctionResult(parsed.name, [balance(account)]);
      }
    }
    if (to === FACTORY) {
      const { args: [mint] } = REGISTRY.parseTransaction({ data });
      calls.push([mint, 'deploymentIndexPlusOne']);
      if (fail(mint, 'deploymentIndexPlusOne')) throw new Error('bad registration');
      return REGISTRY.encodeFunctionResult('deploymentIndexPlusOne',
        [targets.some(t => t.mint.toLowerCase() === mint.toLowerCase()) ? 1 : 0]);
    }
    const t = targets.find(t => t.mint.toLowerCase() === to.toLowerCase());
    const { name, args } = CORLA_ABI.parseTransaction({ data });
    const firstArg = args.length ? args[0] : undefined;
    calls.push([to, name, firstArg]);
    if (fail(to, name, firstArg)) throw new Error('partial revert');
    const values = {
      factory: FACTORY, creator: addr(44), expectedToken: t.token,
      token: t.launched ? t.token : ZeroAddress, pool: t.launched ? addr(10) : ZeroAddress,
      quoteToken: ZeroAddress, pricePerLot: 10n, mintedLots: t.launched ? 10n : 4n,
      totalLots: 10n, tokensPerLot: 20n, fundingDeadline: 1200, whitelistEnabled: false,
      whitelistDeadline: 0, agentOnly: false, emergencyWithdrawn: false, launched: t.launched,
      maxMintsPerWallet: 1n, getMintState: t.launched ? [10n, 3] : [4n, 1],
      walletMintCount: 1n, claimed: false, refunded: false,
    };
    const value = values[name];
    return CORLA_ABI.encodeFunctionResult(name, Array.isArray(value) ? value : [value]);
  };
  return {
    requests, calls, get heads() { return heads; }, get chainReads() { return chainReads; },
    async getBlockNumber() { heads++; return 222; },
    async getNetwork() { chainReads++; return { chainId }; },
    async getBalance(account, blockTag) {
      requests.push(['getBalance', blockTag]);
      if (fail(MULTICALL3, 'getEthBalance', account)) throw new Error('balance unavailable');
      return balance(account);
    },
    async call({ to, data, blockTag }) {
      requests.push([to, blockTag]);
      const requestFailure = typeof failRequest === 'function' ? failRequest(requests.length) : failRequest;
      if (requestFailure) throw requestFailure;
      const height = blockTag === 'latest' ? 222 : blockTag;
      if (to !== MULTICALL3) return response(to, data, height);
      if (emptyMulticall) return '0x';
      const [batch] = MC.decodeFunctionData('aggregate3', data);
      return MC.encodeFunctionResult('aggregate3', [batch.map(([target, allowFailure, callData]) => {
        try { return [true, response(target, callData, height)]; }
        catch (e) { if (!allowFailure) throw e; return [false, '0x']; }
      })]);
    },
  };
}

test('two projects and height use one latest eth_call; on-chain identity stays checked', async () => {
  const p = createProvider();
  const rows = await readDashboardProjects(p, fixture);
  assert.deepEqual(p.requests, [[MULTICALL3, 'latest']]);
  assert.equal(p.heads, 0);
  assert.equal(p.chainReads, 0);
  assert.equal(rows.get(fixture[0].mint).token, ZeroAddress);
  assert.equal(rows.get(fixture[0].mint).pricePerLot, 10n);
  assert.equal(rows.get(fixture[0].mint).blockNumber, 222);
  assert.equal(rows.get(fixture[1].mint).launched, true);
  assert.equal(rows.get(fixture[1].mint).phase, 3);
  assert.equal(p.calls.filter(([, name]) => name === 'deploymentIndexPlusOne').length, 2);
});

test('a failed subcall only degrades its own project', async () => {
  const p = createProvider({ fail: (to, name) => to === fixture[0].mint && name === 'totalLots' });
  const rows = await readDashboardProjects(p, fixture, 250);
  assert.match(rows.get(fixture[0].mint).error, /无法读取/);
  assert.equal(rows.get(fixture[0].mint).blockNumber, 250);
  assert.equal(rows.get(fixture[1].mint).totalLots, 10n);
  assert.deepEqual(p.requests, [[MULTICALL3, 250]]);
});

test('wrong-chain and rate limits do not fan out into direct requests', async () => {
  const chain = createProvider({ chainId: 1n });
  await assert.rejects(readDashboardProjects(chain, fixture), /不是 BSC/);
  assert.equal(chain.requests.length, 1);
  const limited = createProvider({ failRequest: new Error('HTTP 429') });
  await assert.rejects(readDashboardProjects(limited, fixture), /429/);
  assert.equal(limited.requests.length, 1);
  assert.equal(limited.heads, 0);
});

test('old snapshot blocks without Multicall fall back to bounded reads at the same pin', async () => {
  const p = createProvider({ emptyMulticall: true });
  const rows = await readDashboardProjects(p, fixture, 73);
  assert.equal(rows.get(fixture[0].mint).blockNumber, 73);
  assert.ok(p.requests.every(([, tag]) => tag === 73));
  assert.equal(p.chainReads, 1);
  assert.equal(p.heads, 0);
});

test('larger snapshots split into bounded aggregates at one shared height', async () => {
  const targets = Array.from({ length: 25 }, (_, i) => target(i));
  const p = createProvider({ targets });
  const rows = await readDashboardProjects(p, targets);
  assert.equal(p.heads, 1);
  assert.deepEqual(p.requests, Array(3).fill([MULTICALL3, 222]));
  assert.equal(rows.size, 25);
  assert.ok([...rows.values()].every(row => row.blockNumber === 222));
});

test('one unavailable aggregate chunk does not erase valid rows from another', async () => {
  const targets = Array.from({ length: 13 }, (_, i) => target(i));
  const p = createProvider({ targets,
    failRequest: count => count === 2 ? Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) : undefined });
  const rows = await readDashboardProjects(p, targets);
  assert.equal(rows.get(targets[0].mint).totalLots, 10n);
  assert.match(rows.get(targets[12].mint).error, /RPC 暂时不可用/);
  assert.equal(rows.get(targets[12].mint).blockNumber, 222);
});

test('participant detail batches wallets and isolates an unavailable wallet', async () => {
  const missing = addr(76);
  const p = createProvider({ fail: (_to, name, w) => name === 'claimed' && w.toLowerCase() === missing });
  const result = await readDashboardParticipants(p, fixture[0], [wallet, { address: missing }], 224);
  assert.deepEqual({ ...result[0], wallet: result[0].wallet.toLowerCase() }, { wallet, count: 1n, claimed: false, refunded: false });
  assert.match(result[1].error, /无法读取/);
  assert.deepEqual(p.requests, [[MULTICALL3, 224]]);
});

test('wallet picker reads balances and verified shares in one pinned call; missing is not zero', async () => {
  const missing = addr(76);
  const p = createProvider({
    balance: account => account.toLowerCase() === wallet ? 0n : 101n,
    fail: (_to, name, account) => ['getEthBalance', 'refunded'].includes(name) && account.toLowerCase() === missing,
  });
  const result = await readDashboardWalletBalances(p, fixture[0], [wallet, missing]);
  assert.deepEqual(p.requests, [[MULTICALL3, 'latest']]);
  assert.deepEqual(p.calls.slice(0, 2).map(row => row[1]), ['getEthBalance', 'getEthBalance']);
  assert.equal(result.block, 222);
  assert.equal(result.project.block, result.block);
  assert.equal(result.project.launched, false);
  assert.equal(result.project.token.toLowerCase(), fixture[0].token);
  assert.deepEqual(result.wallets.map(row => ({ ...row, address: row.address.toLowerCase() })), [
    { address: wallet, balanceWei: 0n, mintedLots: 1n, hasUnclaimedShare: true },
    { address: missing, balanceWei: null, mintedLots: 1n },
  ]);
});

test('balance-only and unverified project responses never contain project share data', async () => {
  const p = createProvider();
  const unavailable = { ...fixture[0], token: addr(950) };
  for (const target of [null, unavailable]) {
    const result = await readDashboardWalletBalances(p, target, [wallet]);
    assert.deepEqual({ ...result, wallets: result.wallets.map(row => ({ ...row, address: row.address.toLowerCase() })) },
      { block: 222, wallets: [{ address: wallet, balanceWei: 101n }] });
  }
  assert.deepEqual(await readDashboardWalletBalances(p, null, []), { block: null, wallets: [] });
  assert.equal(p.requests.length, 2);
  await assert.rejects(readDashboardWalletBalances(p, null, Array(33).fill(wallet)), /32/);
  await assert.rejects(readDashboardWalletBalances(p, null, [wallet, wallet]), /重复/);
});

test('balance compatibility fallback uses native RPC at the same pinned height', async () => {
  const p = createProvider({ emptyMulticall: true });
  const result = await readDashboardWalletBalances(p, fixture[0], [wallet], 73);
  assert.equal(result.wallets[0].balanceWei, 101n);
  assert.equal(result.wallets[0].hasUnclaimedShare, true);
  assert.ok(p.requests.some(([method]) => method === 'getBalance'));
  assert.ok(p.requests.every(([, tag]) => tag === 73));
  assert.equal(p.chainReads, 1);
  assert.equal(p.heads, 0);
});
