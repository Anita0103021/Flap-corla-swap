import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { getAddress, Interface, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { requireCorlaPool, verifyQuoteResolver } from '../src/corla.mjs';
import { MULTICALL3 } from '../src/dashboard-chain.mjs';
import { DIRECT_LAUNCH_PORTAL, POOL_LAUNCH_ABI } from '../src/pool-launch.mjs';
import { createFlapQuoteCatalog, inspectFlapQuoteCatalog, loadFlapQuoteCatalog } from '../src/quote-catalog.mjs';
import { QUOTE_ERC20 } from '../src/quote-assets.mjs';
import { createUiServer } from '../src/ui-server.mjs';

const actual = JSON.parse(await readFile(new URL('./fixtures/flap-corla-enabled-quotes.json', import.meta.url), 'utf8'));
const catalog = await loadFlapQuoteCatalog(() => assert.fail('default catalog must work offline'), '');
const bySymbol = symbol => catalog.assets.find(row => row.symbol === symbol);
const MULTI = new Interface([
  'function getChainId() view returns (uint256)', 'function getBlockNumber() view returns (uint256)',
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[])',
]);
const REGISTRY = new Interface([
  'function previewQuoteToken(address) view returns (uint8)',
  'function mintForLaunchSalt(bytes32) view returns (address)',
  'function quoteTokenFor(bytes32) view returns (address)',
]);
const enabled = new Set(actual.enabled.map(row => row.address));
function provider({ quoteOverrides = {}, decimalOverrides = {}, chain = 56n, height = actual.block } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    async getBlock(tag) { assert.equal(tag, 'latest'); return { number: actual.block }; },
    async call({ to, data, blockTag }) {
      calls++;
      assert.equal(to, MULTICALL3);
      assert.equal(blockTag, actual.block);
      const [batch] = MULTI.decodeFunctionData('aggregate3', data);
      assert.ok(batch.length <= 92);
      const make = (abi, fn, value) => [true, abi.encodeFunctionResult(fn, value)];
      const rows = batch.map(({ target, callData }, i) => {
        if (target === MULTICALL3) {
          return callData === MULTI.getFunction('getBlockNumber').selector ?
            make(MULTI, 'getBlockNumber', [height]) : make(MULTI, 'getChainId', [chain]);
        }
        if (target === DIRECT_LAUNCH_PORTAL) {
          const [kind, quote] = POOL_LAUNCH_ABI.decodeFunctionData('launchQuoteConfig', callData);
          assert.equal(kind, 0n);
          assert.equal(i % 3, 2);
          if (quoteOverrides[quote] === 'unknown') return [false, '0x'];
          if (quoteOverrides[quote] === 'no-price') return make(POOL_LAUNCH_ABI, 'launchQuoteConfig', [true, 0n]);
          return make(POOL_LAUNCH_ABI, 'launchQuoteConfig', [enabled.has(quote) || quoteOverrides[quote] === 'new', 1n]);
        }
        if (target === FACTORY) {
          const [quote] = REGISTRY.decodeFunctionData('previewQuoteToken', callData);
          return make(REGISTRY, 'previewQuoteToken', [decimalOverrides[quote] ?? catalog.assets.find(row => row.address === quote).decimals]);
        }
        assert.equal(callData, QUOTE_ERC20.getFunction('decimals').selector);
        return make(QUOTE_ERC20, 'decimals', [catalog.assets.find(row => row.address === target).decimals]);
      });
      return MULTI.encodeFunctionResult('aggregate3', [rows]);
    },
  };
}

test('the official candidates distinguish the seven verified quotes from 97 others, including ZCASH with no project yet', async () => {
  const result = await inspectFlapQuoteCatalog(provider(), catalog);
  assert.equal(result.cid, actual.cid);
  assert.equal(result.assets.length, actual.total);
  assert.deepEqual(result.assets.filter(row => row.status === 'enabled')
    .map(({ address, symbol, decimals }) => ({ address, symbol, decimals })), actual.enabled);
  assert.equal(result.assets.find(row => row.symbol === 'USDC').status, 'disabled');
  assert.equal(result.assets.find(row => row.symbol === 'XAUT').decimals, 6);
  assert.equal(result.assets.find(row => row.symbol === 'XAUT').status, 'disabled');
});

test('a newly enabled six-decimal candidate needs no hardcoded trading entry; missing or inconsistent state stays distinct', async () => {
  const xaut = bySymbol('XAUT').address, zcash = bySymbol('ZCASH').address;
  const fxion = bySymbol('FXIon').address, usdt = bySymbol('USDT').address;
  const rpc = provider({ quoteOverrides: { [xaut]: 'new', [zcash]: 'unknown', [usdt]: 'no-price' }, decimalOverrides: { [fxion]: 6 } });
  const result = await inspectFlapQuoteCatalog(rpc, { ...catalog, assets: catalog.assets.filter(x => [xaut, zcash, fxion, usdt].includes(x.address)) });
  const status = Object.fromEntries(result.assets.map(row => [row.symbol, row.status]));
  assert.deepEqual(status, { XAUT: 'enabled', ZCASH: 'unknown', FXIon: 'unverified', USDT: 'unverified' });
  await assert.rejects(inspectFlapQuoteCatalog(provider({ height: 1 }), catalog), /快照不一致/);
  await assert.rejects(inspectFlapQuoteCatalog(provider({ chain: 1n }), catalog), /快照不一致/);
});

function rawCid(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let acc = 0, bits = 0, out = 'b';
  for (const byte of Buffer.concat([Buffer.from([1, 0x55, 0x12, 32]), createHash('sha256').update(bytes).digest()])) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(acc >> bits) & 31]; }
  }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

test('a newer published CID is verified byte-for-byte and limited to the fixed gateway', async () => {
  const asset = { chainId: 56, address: ZeroAddress, symbol: 'BNB', decimals: 18, category: 'featured' };
  const body = JSON.stringify({ schemaVersion: 1, chainId: 56, assets: [asset] });
  const cid = rawCid(body);
  const read = await loadFlapQuoteCatalog(async (url, options) => {
    assert.equal(url, 'https://flap.mypinata.cloud/ipfs/' + cid);
    assert.equal(options.redirect, 'error');
    return new Response(body);
  }, cid);
  const { chainId, ...projection } = asset;
  assert.deepEqual(read, { cid, assets: [projection] });
  await assert.rejects(loadFlapQuoteCatalog(async () => new Response(body + ' '), cid), /CID 校验失败/);
  await assert.rejects(loadFlapQuoteCatalog(() => assert.fail('external host not allowed'), 'https://untrusted.test'), /CID 无效/);
});

test('concurrent directory requests coalesce; cached data is explicitly stale on a failed refresh', async () => {
  let time = 0, loads = 0, probes = 0, fail = false;
  const check = createFlapQuoteCatalog({
    now: () => time,
    load: async () => { loads++; return catalog; },
    inspect: async () => { probes++; if (fail) throw new Error('RPC timeout'); return { assets: [], block: actual.block }; },
  });
  const [a, b] = await Promise.all([check(), check()]);
  assert.equal(a, b);
  assert.equal(await check(), a);
  assert.equal(loads, 1);
  assert.equal(probes, 1);
  time = 30_001; fail = true;
  assert.deepEqual(await check(), { ...a, stale: true });
});

test('factory resolver must bind both actual Mint and actual quote asset', async () => {
  const { address: quote } = bySymbol('ZCASH');
  const mint = getAddress('0x' + '11'.repeat(20));
  const key = '0x' + '32'.repeat(32);
  let mappedQuote = quote;
  const rpc = { async call({ to, blockTag, data }) {
    assert.equal(to, FACTORY);
    assert.equal(blockTag, actual.block);
    const { name, args } = REGISTRY.parseTransaction({ data });
    assert.equal(args[0], key);
    return REGISTRY.encodeFunctionResult(name, [name === 'quoteTokenFor' ? mappedQuote : mint]);
  } };
  await verifyQuoteResolver(rpc, key, mint, quote, actual.block);
  mappedQuote = bySymbol('USDT').address;
  await assert.rejects(verifyQuoteResolver(rpc, key, mint, quote, actual.block), /底池资产不一致/);
  await assert.rejects(verifyQuoteResolver(rpc, '0x' + '00'.repeat(32), mint, quote, actual.block), /登记键无效/);
  assert.throws(() => requireCorlaPool({ quoteEnabled: false }), /未开放/);
  assert.throws(() => requireCorlaPool({ poolRoute: 'unsupported' }), /直连池/);
});

test('desktop quote directory reads the authorized local API without starting a wallet or executor', async t => {
  const parent = await realpath(tmpdir());
  const prefix = 'corla-quote-dir-';
  const root = await mkdtemp(join(parent, prefix));
  let app;
  t.after(async () => {
    await app?.close();
    const resolved = await realpath(root);
    assert.equal(dirname(resolved), parent);
    assert.ok(basename(resolved).startsWith(prefix));
    await rm(resolved, { recursive: true, force: true });
  });
  await copyFile(new URL('../config.example.json', import.meta.url), join(root, 'config.example.json'));
  let hits = 0;
  let failure = false;
  app = await createUiServer({ rootDir: root, allowLive: false, services: {
    makeProvider: () => ({ getNetwork: async () => ({ chainId: 56n }), destroy() {} }),
    makeExecutor: () => assert.fail('never execute directory queries'),
    createFlapQuoteCatalog: () => async () => {
      hits++;
      if (failure) throw Object.assign(new Error('missing internal data file'), { code: 'ENOENT' });
      return { block: actual.block, assets: actual.enabled };
    },
  } });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  const read = (body = {}, origin = app.url) => fetch(app.url + '/api/catalog/quote-assets', { method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-corla-session': boot.sessionToken },
    body: JSON.stringify(body) });
  assert.equal((await read({}, 'https://untrusted.test')).status, 403);
  assert.equal((await read({ url: 'https://untrusted.test' })).status, 400);
  assert.deepEqual(await (await read()).json(), { block: actual.block, assets: actual.enabled });
  assert.equal(hits, 1);
  failure = true;
  const missing = await read();
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: '底池目录暂时读取失败，请稍后重试', code: 'QUOTE_CATALOG_UNAVAILABLE' });
  assert.equal((await (await fetch(app.url + '/api/state')).json()).running, false);
});
