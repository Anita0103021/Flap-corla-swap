import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_RPC_URLS, BUILTIN_WATCH_RPC_URLS, DEFAULT_BSC_RPC_URL, rpcPoolPlan,
  validateRpcBackupUrls } from '../src/rpc-config.mjs';
import { createUiServer } from '../src/ui-server.mjs';

test('public and explicitly configured RPC lists stay separate by use case', () => {
  const cfg = { rpcUrl: DEFAULT_BSC_RPC_URL };
  for (const role of ['dashboard', 'metadata', 'mint', 'snipe']) {
    const plan = rpcPoolPlan(cfg, role, {});
    assert.deepEqual(new Set(plan.urls.map(url => new URL(url).href)),
      new Set(BUILTIN_RPC_URLS.map(url => new URL(url).href)));
    assert.deepEqual(plan.requiredMethods, role === 'snipe' ? ['eth_simulateV1'] : []);
  }
  const watch = rpcPoolPlan(cfg, 'watch', {});
  assert.deepEqual(watch.urls.map(url => new URL(url).href), BUILTIN_WATCH_RPC_URLS.map(url => new URL(url).href));
  assert.deepEqual(watch.requiredMethods, ['eth_getLogs']);
  const notifications = rpcPoolPlan(cfg, 'notifications', {});
  assert.deepEqual(notifications.urls.map(url => new URL(url).href), BUILTIN_WATCH_RPC_URLS.map(url => new URL(url).href));
  assert.deepEqual(notifications.requiredMethods, ['eth_getLogs']);
  const history = rpcPoolPlan(cfg, 'catalogHistory', {});
  assert.deepEqual(history.urls, [DEFAULT_BSC_RPC_URL]);
  assert.deepEqual(history.requiredMethods, ['eth_getLogs']);
  assert.equal(history.requestTimeoutMs, 7500);

  const custom = { rpcUrl: 'https://custom.invalid/mainnet/key', rpcCustom: true };
  const fallback = 'https://backup.invalid/rpc';
  for (const role of ['dashboard', 'mint', 'metadata', 'snipe', 'discovery']) {
    assert.deepEqual(rpcPoolPlan(custom, role, {}).urls, [custom.rpcUrl]);
    assert.deepEqual(rpcPoolPlan(custom, role, { BSC_RPC_BACKUP_URLS: fallback }).urls, [custom.rpcUrl, fallback]);
  }
  assert.deepEqual(rpcPoolPlan(custom, 'snipe', {
    BSC_SNIPE_RPC_URL: 'https://private.invalid/orderflow',
    BSC_RPC_BACKUP_URLS: fallback,
  }).urls, ['https://private.invalid/orderflow']);
  assert.deepEqual(rpcPoolPlan(cfg, 'watch', {
    BSC_WATCH_RPC_URL: 'https://custom.invalid/ws-associated',
    BSC_WATCH_RPC_BACKUP_URLS: fallback + ', ' + fallback,
  }).urls, ['https://custom.invalid/ws-associated', fallback]);
  assert.deepEqual(rpcPoolPlan(cfg, 'notifications', {
    BSC_WATCH_RPC_URL: 'https://private.invalid/sniper',
    BSC_NOTIFICATIONS_RPC_URL: 'https://notifications.invalid/logs',
    BSC_NOTIFICATIONS_RPC_BACKUP_URLS: fallback,
  }).urls, ['https://notifications.invalid/logs', fallback]);
  assert.deepEqual(rpcPoolPlan(custom, 'catalogHistory', {
    BSC_CATALOG_HISTORY_RPC_URL: 'https://archive.invalid/logs',
    BSC_CATALOG_HISTORY_RPC_BACKUP_URLS: fallback,
  }).urls, ['https://archive.invalid/logs', fallback]);
  assert.deepEqual(rpcPoolPlan({ ...cfg, rpcBackupUrls: [] }, 'mint', {}).urls, [DEFAULT_BSC_RPC_URL]);
  assert.throws(() => validateRpcBackupUrls(['wss://foo.invalid/abc']), /HTTP/);
  assert.throws(() => validateRpcBackupUrls(Array(8).fill(fallback)), /7/);
});

test('RPC status uses persistent isolated pools and keeps the backup list out of the web config', async t => {
  const root = await mkdtemp(join(tmpdir(), 'corla-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL('../config.example.json', import.meta.url);
  await copyFile(source, join(root, 'config.example.json'));
  const config = JSON.parse(await readFile(source, 'utf8'));
  const secret = 'hidden-api-secret';
  config.rpcUrl = 'https://private.invalid/rpc';
  config.rpcBackupUrls = ['https://backup.invalid/v1/' + secret];
  await writeFile(join(root, 'config.local.json'), JSON.stringify(config));
  const plans = [];
  let destroyed = 0;
  const app = await createUiServer({ rootDir: root, services: {
    createRpcPool(urls, plan) {
      plans.push({ urls, required: plan.requiredMethods });
      return {
        getNetwork: async () => ({ chainId: 56n }),
        rpcStatus: () => ({ preferred: '节点 1', active: '节点 2',
          endpoints: [{ name: '节点 1', latencyMs: 20, status: 'cooldown', retryAt: 60000 },
            { name: '节点 2', latencyMs: 35, status: 'healthy', retryAt: null }] }),
        destroy() { destroyed++; },
      };
    },
    readCatalogPage: async () => ({ projects: [], total: 0, block: 12, nextCursor: null }),
  } });
  try {
    const boot = await (await fetch(app.url + '/api/bootstrap')).json();
    assert.equal(boot.config.rpcUrl, undefined);
    assert.equal(boot.config.rpcBackupUrls, undefined);
    const headers = { 'x-corla-session': boot.sessionToken, origin: app.url, 'content-type': 'application/json' };
    const rpc = app.url + '/api/rpc/status';
    assert.equal((await fetch(rpc)).status, 403);
    assert.equal((await fetch(rpc, { headers: { ...headers, origin: 'http://evil.invalid' } })).status, 403);
    assert.equal(plans.length, 0);
    const first = await (await fetch(rpc, { headers })).text();
    const pools = JSON.parse(first).pools;
    assert.deepEqual(pools.map(p => p.id), ['dashboard', 'metadata', 'mint', 'watch', 'snipe']);
    assert.equal(pools[0].active, '节点 2');
    assert.doesNotMatch(first, /private\.invalid|backup\.invalid|hidden-api-secret/);
    assert.deepEqual(plans.map(p => p.required), [[], [], [], ['eth_getLogs'], ['eth_simulateV1']]);
    assert.deepEqual(plans[4].urls, [config.rpcUrl, ...config.rpcBackupUrls]);
    const post = (path, body) => fetch(app.url + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await post('catalog', {})).status, 200);
    await fetch(rpc, { headers });
    assert.equal(plans.length, 5, 'status and catalog reuse warm pools');
    assert.equal((await post('config', { config: { ...boot.config, rpcBackupUrls: [] }, configRevision: boot.configRevision })).status, 400);
    assert.equal((await post('config', { config: boot.config, configRevision: boot.configRevision })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'config.local.json'), 'utf8')).rpcBackupUrls, config.rpcBackupUrls);
    assert.equal((await (await fetch(app.url + '/api/state')).json()).running, false);
  } finally {
    await app.close();
  }
  assert.equal(destroyed, 5);
});
