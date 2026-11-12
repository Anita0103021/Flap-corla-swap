import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress } from 'ethers';
import { FACTORY, parseMintLink } from '../src/config.mjs';
import { MULTICALL3 } from '../src/dashboard-chain.mjs';
import { MAX_CATALOG_PAGE, findCatalogAddress, readCatalogPage } from '../src/catalog.mjs';

const REGISTRY = new Interface([
  'function deploymentCount() view returns(uint256)',
  'function deploymentIndexPlusOne(address) view returns(uint256)',
  'function getDeployments(uint256,uint256) view returns((address,address,address,bytes32,bytes32,bytes32,uint256,uint256,uint256,uint256)[])',
]);
const MULTI = new Interface([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[])',
  'function getChainId() view returns(uint256)',
  'function getBlockNumber() view returns(uint256)',
]);
const zeroHash = '0x' + '00'.repeat(32);
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const createRow = index => [addr(1 + index), addr(50_000 + index), addr(100_000 + index), zeroHash, zeroHash, zeroHash,
  1_794_457_000 + index, 1_794_543_400 + index, 50, 10n ** 17n];

function fixture({ total = 37, height = 133096879, chain = 56, shorten = false, badIndex = false, failPage } = {}) {
  const state = { total, height, pages: [], snapshots: 0, directLookups: 0, concurrent: 0, peak: 0 };
  const provider = { async call({ to, data, blockTag }) {
    if (to === MULTICALL3) {
      assert.equal(blockTag, 'latest');
      state.snapshots++;
      const [calls] = MULTI.decodeFunctionData('aggregate3', data);
      const results = calls.map(call => {
        if (call.target === MULTICALL3) {
          const method = MULTI.parseTransaction({ data: call.callData }).name;
          return [true, MULTI.encodeFunctionResult(method, [method === 'getChainId' ? chain : state.height])];
        }
        assert.equal(call.target, FACTORY);
        const request = REGISTRY.parseTransaction({ data: call.callData });
        if (request.name === 'deploymentCount') return [true, REGISTRY.encodeFunctionResult('deploymentCount', [state.total])];
        assert.equal(request.name, 'deploymentIndexPlusOne');
        state.directLookups++;
        const mintNo = Number(BigInt(request.args[0]));
        const indexPlusOne = badIndex ? state.total + 1 : mintNo <= state.total ? mintNo : 0;
        return [true, REGISTRY.encodeFunctionResult('deploymentIndexPlusOne', [indexPlusOne])];
      });
      return MULTI.encodeFunctionResult('aggregate3', [results]);
    }
    assert.equal(to, FACTORY);
    assert.equal(blockTag, state.height);
    const [start, count] = REGISTRY.decodeFunctionData('getDeployments', data).map(Number);
    assert.ok(count > 0 && count <= 100);
    state.pages.push([start, count]);
    state.concurrent++;
    state.peak = Math.max(state.peak, state.concurrent);
    try {
      await Promise.resolve();
      if (start === failPage) throw new Error('unavailable page ' + start);
      const rows = Array.from({ length: Math.min(state.total - start, count) - Number(shorten) }, (_, i) => createRow(start + i));
      return REGISTRY.encodeFunctionResult('getDeployments', [rows]);
    } finally { state.concurrent--; }
  } };
  return { provider, state };
}

test('reads native Corla pages newest first at one block and remains stable when a new project appends', async () => {
  const { provider, state } = fixture();
  const one = await readCatalogPage(provider);
  assert.equal(one.total, 37);
  assert.equal(one.nextCursor, '19');
  assert.equal(one.block, state.height);
  assert.equal(one.projects.length, 18);
  assert.deepEqual(one.projects.slice(0, 2).map(p => p.index), [36, 35]);
  assert.deepEqual(parseMintLink(one.projects[0].url), { mint: addr(37), token: addr(100036), factory: FACTORY });
  assert.equal(one.projects[0].creator, addr(50036));
  assert.equal(one.projects[0].createdAt, 1_794_457_036);
  assert.equal(one.projects[0].fundingDeadline, 1_794_543_436);
  assert.equal(one.projects[0].totalLots, 50n);
  assert.equal(one.projects[0].pricePerLot, 10n ** 17n);
  state.total = 38;
  state.height++;
  const two = await readCatalogPage(provider, { cursor: one.nextCursor });
  assert.equal(two.nextCursor, '1');
  assert.deepEqual(two.projects.slice(0, 2).map(p => p.index), [18, 17]);
  const tail = await readCatalogPage(provider, { cursor: two.nextCursor });
  assert.equal(tail.nextCursor, null);
  assert.deepEqual(tail.projects.map(p => p.index), [0]);
  assert.deepEqual(state.pages, [[19, 18], [1, 18], [0, 1]]);
});

test('does not fetch zero rows, and rejects invalid client cursor and size before RPC', async () => {
  const { provider, state } = fixture({ total: 0 });
  assert.deepEqual(await readCatalogPage(provider), { total: 0, block: state.height, projects: [], nextCursor: null });
  await assert.rejects(readCatalogPage(provider, { cursor: '1e2' }), /页码/);
  await assert.rejects(readCatalogPage(provider, { cursor: 1 }), /页码/);
  await assert.rejects(readCatalogPage(provider, { limit: MAX_CATALOG_PAGE + 1 }), /每页/);
  assert.equal(state.snapshots, 1);
  assert.equal(state.pages.length, 0);
});

test('resolves Mint directly and an older Token with bounded parallel native pages', async () => {
  const { provider, state } = fixture({ total: 330 });
  const mint = await findCatalogAddress(provider, addr(22).toLowerCase());
  assert.equal(mint.token, addr(100021));
  assert.deepEqual(state.pages, [[21, 1]]);
  const token = await findCatalogAddress(provider, addr(100007).toLowerCase());
  assert.equal(token.mint, addr(8));
  assert.equal(token.index, 7);
  assert.deepEqual(state.pages.slice(1), [[230, 100], [130, 100], [30, 100], [0, 30]]);
  assert.equal(state.peak, 3);
  assert.equal(await findCatalogAddress(provider, addr(999)), null);
});

test('rejects wrong chain, inconsistent index and incomplete pages instead of returning a false empty result', async () => {
  await assert.rejects(readCatalogPage(fixture({ chain: 97 }).provider), /BSC 主网/);
  await assert.rejects(findCatalogAddress(fixture({ badIndex: true }).provider, addr(33)), /索引/);
  await assert.rejects(readCatalogPage(fixture({ shorten: true }).provider), /不完整/);
  await assert.rejects(findCatalogAddress(fixture({ shorten: true }).provider, addr(100004)), /不完整/);
});

test('returns a verified exact match despite a failing sibling page, but never reports a false miss', async () => {
  const { provider } = fixture({ total: 330, failPage: 130 });
  assert.equal((await findCatalogAddress(provider, addr(100329))).index, 329);
  await assert.rejects(findCatalogAddress(provider, addr(999)), /unavailable page 130/);
});
