import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseMintLink } from '../src/config.mjs';
import { createUiServer } from '../src/ui-server.mjs';

test('token board pages and status stay read-only, isolated and cached', async t => {
  const base = await realpath(tmpdir());
  const prefix = 'corla-board-test-';
  const rootDir = await mkdtemp(join(base, prefix));
  let app;
  t.after(async () => {
    await app?.close();
    const dir = await realpath(rootDir);
    assert.equal(dirname(dir), base);
    assert.ok(basename(dir).startsWith(prefix));
    await rm(dir, { recursive: true, force: true });
  });
  await copyFile(new URL('../config.example.json', import.meta.url), join(rootDir, 'config.example.json'));
  let pageCalls = 0;
  let resolves = 0;
  let statusReads = 0;
  let addresses;
  app = await createUiServer({ rootDir, services: {
    makeProvider: () => ({ getNetwork: async () => ({ chainId: 56n }), destroy() {} }),
    readCatalogPage: async (_provider, { cursor, limit }) => {
      pageCalls++;
      assert.equal(limit, 1);
      return { projects: [addresses[cursor ? 1 : 0]], total: 2, nextCursor: cursor ? null : '1' };
    },
    findCatalogAddress: async (_provider, address) => {
      resolves++;
      return addresses.find(row => row.token === address || row.mint === address) ?? null;
    },
    readDashboardProjects: async (_provider, targets, blockTag) => {
      statusReads++;
      assert.equal(blockTag, 'latest');
      return new Map(targets.map(target => [target.mint.toLowerCase(), {
        blockNumber: 9000, pricePerLot: 100000000000000000n, mintedLots: 12n, totalLots: 50n, launched: false,
      }]));
    },
    makeExecutor: () => assert.fail('catalog must not start an executor'),
  } });
  const get = async route => (await fetch(app.url + route)).json();
  const boot = await get('/api/bootstrap');
  addresses = boot.config.targets.map(({ url }) => ({ ...parseMintLink(url), url }));
  const headers = { 'content-type': 'application/json', origin: app.url, 'x-corla-session': boot.sessionToken };
  const post = (route, data, options = {}) => fetch(app.url + route, { method: 'POST',
    headers: { ...headers, ...options }, body: JSON.stringify(data) });
  const first = await post('/api/catalog', { limit: 1 });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { projects: [addresses[0]], total: 2, nextCursor: '1' });
  assert.equal((await post('/api/catalog', { limit: 1 })).status, 200);
  assert.equal(pageCalls, 1);
  assert.deepEqual(await (await post('/api/catalog/resolve', { address: addresses[0].token })).json(), { project: addresses[0] });
  assert.equal(resolves, 0, 'an address already present on the board can use its cached record');
  assert.deepEqual(await (await post('/api/catalog/resolve', { address: addresses[1].token })).json(), { project: addresses[1] });
  assert.equal(resolves, 1);
  const second = await post('/api/catalog', { cursor: '1', limit: 1 });
  assert.deepEqual(await second.json(), { projects: [addresses[1]], total: 2, nextCursor: null });
  assert.equal(pageCalls, 2);
  const status = await post('/api/catalog/status', { urls: addresses.map(row => row.url) });
  assert.equal(status.status, 200);
  const rows = (await status.json()).projects;
  assert.deepEqual(rows.map(row => row.block), [9000, 9000]);
  assert.deepEqual(rows.map(row => row.mintedLots), ['12', '12']);
  assert.deepEqual((await (await post('/api/catalog/status', { urls: addresses.map(row => row.url) })).json()).projects, rows);
  assert.equal(statusReads, 1, 'near-simultaneous tabs share a successful catalog snapshot');
  assert.equal((await post('/api/catalog/status', { urls: ['https://example.com/token'] })).status, 400);
  assert.equal((await post('/api/catalog', { limit: 33 })).status, 400);
  assert.equal((await post('/api/catalog', { limit: 1 }, { origin: 'https://external.invalid' })).status, 403);
  assert.deepEqual((await get('/api/bootstrap')).config, boot.config);
  const active = await get('/api/state');
  assert.deepEqual(active.projects, []);
  assert.equal(active.running, false);
  const time = Date.now() + 1500;
  t.mock.method(Date, 'now', () => time);
  assert.equal((await post('/api/catalog', { limit: 1 })).status, 200);
  assert.equal(pageCalls, 2, 'normal navigation can use the first-page cache');
  assert.equal((await post('/api/catalog', { limit: 1, refresh: true })).status, 200);
  assert.equal(pageCalls, 3, 'foreground auto-refresh bypasses the longer navigation cache');
});

test('funding history validates registry and status, resolves in background, and caches only verified times', async t => {
  const base = await realpath(tmpdir());
  const prefix = 'corla-funding-test-';
  const rootDir = await mkdtemp(join(base, prefix));
  await copyFile(new URL('../config.example.json', import.meta.url), join(rootDir, 'config.example.json'));
  let entries;
  let historyReads = 0;
  let lastBatch;
  let release;
  let finish;
  const gate = new Promise(ok => { release = ok; });
  const completion = new Promise(ok => { finish = ok; });
  const app = await createUiServer({ rootDir, services: {
    makeProvider: (_url, plan) => ({ plan, getNetwork: async () => ({ chainId: 56n }), destroy() {} }),
    readCatalogPage: async () => ({ projects: entries, total: entries.length, nextCursor: null, block: 9000 }),
    readDashboardProjects: async (_provider, targets) => new Map(targets.map(target => {
      const full = target.mint === entries[0].mint;
      return [target.mint.toLowerCase(), { blockNumber: 9000, mintedLots: full ? 50n : 12n, totalLots: 50n, launched: full }];
    })),
    readCatalogFundingTimes: async (provider, batch, { signal, onResult }) => {
      historyReads++;
      lastBatch = batch;
      assert.deepEqual(provider.plan.requiredMethods, ['eth_getLogs']);
      assert.equal(signal.aborted, false);
      await gate;
      onResult({ mint: entries[0].mint, token: entries[0].token, filledAt: 1057, blockNumber: 8980, blockHash: '0x' + '12'.repeat(32) });
      await completion;
      return [];
    },
    makeExecutor: () => assert.fail('catalog history must not start an executor'),
  } });
  t.after(async () => {
    release();
    finish();
    await app.close();
    const dir = await realpath(rootDir);
    assert.equal(dirname(dir), base);
    assert.ok(basename(dir).startsWith(prefix));
    await rm(dir, { recursive: true, force: true });
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json();
  entries = boot.config.targets.map(({ url }) => ({
    ...parseMintLink(url), url, createdAt: 1000, fundingDeadline: 2000, totalLots: 50n,
  }));
  const headers = { 'content-type': 'application/json', origin: app.url, 'x-corla-session': boot.sessionToken };
  const urls = entries.map(row => row.url);
  const post = (route, data, extra = {}) => fetch(app.url + '/api/catalog' + route, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data), signal: AbortSignal.timeout(2000),
  });
  const history = () => post('/funding-times', { urls });
  assert.equal((await post('/funding-times', { urls }, { origin: 'https://external.invalid' })).status, 403);
  assert.equal((await post('/funding-times', { urls: Array(19).fill(urls[0]) })).status, 400);
  assert.deepEqual(await (await history()).json(), { projects: [] });
  assert.equal((await post('', {})).status, 200);
  assert.deepEqual(await (await history()).json(), { projects: [] }, 'registration alone cannot queue historical reads');
  assert.equal((await post('/status', { urls })).status, 200);
  assert.equal((await post('/funding-times', { urls: [urls[0], 'https://invalid.example'] })).status, 400);
  assert.equal(historyReads, 0, 'malformed batch does not queue valid prefix');
  assert.deepEqual(await (await history()).json(), { projects: [], retryAfterMs: 3000 });
  assert.equal((await post('/status', { urls })).status, 200, 'pending history does not block normal polling');
  assert.deepEqual(await (await history()).json(), { projects: [], retryAfterMs: 3000 });
  assert.equal(historyReads, 1, 'pending history deduplicates concurrent requests');
  assert.deepEqual(lastBatch.map(row => row.project.mint), [entries[0].mint]);
  release();
  let result;
  for (let i = 0; i < 25; i++) {
    result = await (await history()).json();
    if (result.projects.length) break;
    await wait(20);
  }
  assert.deepEqual(result.projects, [{ mint: entries[0].mint, token: entries[0].token,
    filledAt: 1057, blockNumber: 8980, blockHash: '0x' + '12'.repeat(32) }]);
  finish();
  assert.equal(historyReads, 1, 'history cache is reused');
  const active = await (await fetch(app.url + '/api/state')).json();
  assert.deepEqual(active.projects, []);
  assert.equal(active.running, false);
});
