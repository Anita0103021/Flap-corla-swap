import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getAddress } from 'ethers';
import { parseMintLink } from '../src/config.mjs';
import { LOW_LATENCY_RPC_TIMEOUT_MS } from '../src/rpc-config.mjs';
import { SNIPE_RACE_WINDOW_MS } from '../src/snipe-race.mjs';
import { MAX_SNIPE_ATTEMPTS } from '../src/snipe-limits.mjs';
import { createUiServer } from '../src/ui-server.mjs';

const prefix = 'corla-ui-test-';
const publicWallet = '0x000000000000000000000000000000000000beef';
const checkedWallet = getAddress(publicWallet);
const secondWallet = getAddress('0x000000000000000000000000000000000000dEaD');
const mockPassword = 'fixture-password-never-echo';
const mockKeyOne = 'fixture-not-a-real-key-one';
const mockKeyTwo = 'fixture-not-a-real-key-two';
const fakeConfigFile = new URL('../config.example.json', import.meta.url);

async function fixture(t, { chainId = 56n, localWallets = false, localConfig, beforeNetwork, beforeWalletImport,
  beforeInspect, beforeSummary, localUnlock, ...serverOptions } = {}) {
  const tempParent = await realpath(tmpdir());
  const rootDir = await mkdtemp(join(tempParent, prefix));
  let ui;
  t.after(async () => {
    try {
      await ui?.close();
    } finally {
      const path = await realpath(rootDir);
      assert.equal(dirname(path), tempParent);
      assert.ok(basename(path).startsWith(prefix));
      await rm(path, { recursive: true, force: true });
    }
  });
  await mkdir(join(rootDir, 'ui'));
  await copyFile(fakeConfigFile, join(rootDir, 'config.example.json'));
  if (localConfig) await writeFile(join(rootDir, 'config.local.json'), JSON.stringify(localConfig));
  await writeFile(join(rootDir, 'ui', 'index.html'), '<!doctype html><title>Corla UI Test</title>');
  await writeFile(join(rootDir, 'ui', 'styles.css'), 'body { color: navy }');
  await writeFile(join(rootDir, 'ui', 'app.js'), 'document.body.dataset.loaded = "yes";');
  await copyFile(new URL('../ui/themes.css', import.meta.url), join(rootDir, 'ui', 'themes.css'));
  await copyFile(new URL('../ui/theme.js', import.meta.url), join(rootDir, 'ui', 'theme.js'));
  if (localWallets) {
    await writeFile(join(rootDir, 'wallets.local.json'), JSON.stringify([
      { keystore: 'test-only-private-keystore.json', passwordEnv: 'CORLA_TEST_NON_SECRET_PASSWORD' },
    ]));
    await writeFile(join(rootDir, 'test-only-private-keystore.json'), JSON.stringify({
      address: publicWallet.slice(2), crypto: { ciphertext: 'fixture-never-serve-this' },
    }));
    await mkdir(join(rootDir, 'state'));
    await writeFile(join(rootDir, 'state', 'wallet-vault.json'), 'fixture-encrypted-vault-never-serve-this');
  }

  const observed = { providers: 0, destroyed: 0, inspections: [], discovery: [], unlocks: 0, imports: 0, removals: 0,
    executors: [], closed: 0, monitors: [], ticks: 0 };
  const head = 98765;
  let walletRows = localWallets ? [{ address: checkedWallet, label: '测试钱包', privateKey: mockKeyOne }] : [];
  const mockAuth = password => {
    if (password !== mockPassword) throw new Error('mock low-level error must not escape: ' + password);
  };
  const services = {
    makeProvider() {
      observed.providers++;
      return {
        async getNetwork() { await beforeNetwork?.(); return { chainId }; },
        async getBlockNumber() { return head; },
        async getBlock() { return { number: head, timestamp: 1794453000 }; },
        destroy() { observed.destroyed++; },
      };
    },
    async inspectMint(_provider, target, blockNumber) {
      observed.inspections.push({ token: target.token, blockNumber });
      await beforeInspect?.(target);
      return {
        token: target.token,
        pool: '0x0000000000000000000000000000000000000000',
        pricePerLot: 100000000000000000n,
        mintedLots: 4n,
        totalLots: 50n,
        maxMintsPerWallet: 7n,
        launched: false,
        blockNumber,
      };
    },
    async inspectParticipant(_provider, _target, wallet) {
      assert.equal(wallet.toLowerCase(), publicWallet);
      return { count: 1n, claimed: false, refunded: false };
    },
    async discoverProjects(_provider, from, to) {
      observed.discovery.push([from, to]);
      const { targets: [{ url }] } = JSON.parse(await readFile(fakeConfigFile, 'utf8'));
      return [{ ...parseMintLink(url), url, blockNumber: to }];
    },
    createWalletVault(file) {
      assert.equal(file, join(rootDir, 'state', 'wallet-vault.json'));
      return {
        async list() { return walletRows; },
        async verifyPassword(password) { mockAuth(password); },
        async importWallets({ password, privateKeys, label }) {
          observed.imports++;
          await beforeWalletImport?.();
          mockAuth(password);
          const added = privateKeys.map(key => {
            const address = key === mockKeyOne ? checkedWallet : key === mockKeyTwo ? secondWallet : null;
            if (!address || walletRows.some(w => w.address === address)) throw new Error('invalid or duplicate fixture key ' + key);
            return { address, label: label || '', privateKey: key };
          });
          walletRows = [...walletRows, ...added];
          return walletRows;
        },
        async removeWallet({ password, address }) {
          observed.removals++;
          mockAuth(password);
          if (!walletRows.some(w => w.address === address)) throw new Error('fixture wallet not found');
          walletRows = walletRows.filter(w => w.address !== address);
          return walletRows;
        },
        async unlock({ password, provider }) {
          observed.unlocks++;
          assert.equal(typeof provider?.getNetwork, 'function');
          mockAuth(password);
          return walletRows.map(({ address }) => ({ address }));
        },
      };
    },
    makeExecutor(options) {
      observed.executors.push(options);
      const execute = async () => { throw new Error('Fixture must not execute any transactions'); };
      execute.reconcile = async () => null;
      execute.close = () => { observed.closed++; };
      return execute;
    },
    makeMonitor(options) {
      observed.monitors.push(options);
      return async () => {
        observed.ticks++;
        const [target] = options.cfg.targets;
        options.log('project', { mint: target.mint, token: target.token, block: head, mintedLots: 4n, totalLots: 50n, launched: false });
        options.log('mint', { wallet: publicWallet, status: 'simulated' });
      };
    },
    async prepareSnipe({ cfg, wallets }) { return { targets: cfg.targets, wallets, armBlock: head }; },
    makeFastSnipe(options) {
      observed.monitors.push(options);
      return () => new Promise(ok => {
        if (options.signal.aborted) ok();
        else options.signal.addEventListener('abort', ok, { once: true });
      });
    },
  };
  if (localUnlock) services.createLocalWalletUnlock = () => localUnlock;
  if (beforeSummary) services.readDashboardProjects = async (_provider, targets) => {
    await beforeSummary(targets);
    return new Map(targets.map(target => [target.mint.toLowerCase(), { token: target.token, blockNumber: head }]));
  };
  ui = await createUiServer({ rootDir, port: 0, host: '127.0.0.1', services, ...serverOptions });
  const url = new URL(ui.url).origin;
  const initial = await fetch(url + '/api/bootstrap');
  assert.equal(initial.status, 200);
  const bootstrap = await initial.json();
  assert.ok(typeof bootstrap.sessionToken === 'string' && bootstrap.sessionToken.length >= 24);
  let configRevision = bootstrap.configRevision;
  assert.match(configRevision, /^[0-9a-f]{32}$/);
  const headers = {
    'Content-Type': 'application/json',
    Origin: url,
    'X-Corla-Session': bootstrap.sessionToken,
  };
  return {
    rootDir, url, bootstrap, head, observed, services,
    close: () => ui.close(),
    get(path) { return fetch(url + path, { headers }); },
    async post(path, body, extra = {}) {
      const merged = new Headers(headers);
      for (const [name, value] of Object.entries(extra)) {
        if (value === null) merged.delete(name);
        else merged.set(name, value);
      }
      if (path === '/api/config' || (path === '/api/start' && body.mode === 'live')) body = { configRevision, ...body };
      const response = await fetch(url + path, { method: 'POST', headers: merged, body: JSON.stringify(body) });
      if (path === '/api/config' && response.ok) configRevision = (await response.clone().json()).configRevision;
      return response;
    },
  };
}

function liveConfig(config) {
  const edited = structuredClone(config);
  edited.targets[0].autoClaim = true;
  return edited;
}

function liveBody(f, overrides = {}) {
  return { config: liveConfig(f.bootstrap.config), mode: 'live', confirmation: 'BSC LIVE',
    expectedWallets: [checkedWallet], password: mockPassword, ...overrides };
}

function noSecret(value, ...needles) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [mockPassword, mockKeyOne, mockKeyTwo, ...needles]) {
    assert.equal(raw.includes(secret), false, 'Response leaked confidential input');
  }
}

async function ok(response) {
  const body = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function eventually(check, timeout = 3000) {
  const until = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(30);
  } while (Date.now() < until);
  assert.fail('Timed out waiting for monitor state');
}

test('UI serves local assets but not wallet files, and rejects DNS rebinding', async t => {
  const f = await fixture(t, { localWallets: true });
  assert.equal(f.bootstrap.source, 'example');
  assert.equal(f.bootstrap.config.targets.length, 2);
  assert.equal(f.bootstrap.allowLive, true);
  assert.ok(f.bootstrap.config.targets.every(t => !t.mintBatches && !t.autoClaim && !t.buyOnLaunch));
  assert.ok(!JSON.stringify(f.bootstrap).includes('CORLA_TEST_NON_SECRET_PASSWORD'));
  noSecret(f.bootstrap);
  assert.deepEqual(Object.keys(f.bootstrap.config).filter(k => ['rpcUrl', 'walletFile', 'journalPath'].includes(k)), []);
  assert.match(await (await f.get('/')).text(), /Corla UI Test/);
  assert.match(await (await f.get('/app.js')).text(), /dataset\.loaded/);
  const palette = await f.get('/themes.css');
  assert.match(palette.headers.get('content-type'), /text\/css/);
  assert.match(await palette.text(), /data-theme/);
  const theme = await f.get('/theme.js');
  assert.match(theme.headers.get('content-type'), /text\/javascript/);
  assert.match(await theme.text(), /corla-desk:theme/);
  assert.match(theme.headers.get('content-security-policy'), /script-src 'self'/);
  const forbidden = await f.get('/wallets.local.json');
  assert.equal(forbidden.status, 404);
  assert.doesNotMatch(await forbidden.text(), /test-only-private-keystore/);
  assert.equal((await f.get('/test-only-private-keystore.json')).status, 404);
  const vaultFile = await f.get('/state/wallet-vault.json');
  assert.equal(vaultFile.status, 404);
  assert.doesNotMatch(await vaultFile.text(), /fixture-encrypted-vault/);
  const externalBootstrap = await fetch(f.url + '/api/bootstrap', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(externalBootstrap.status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = request(f.url + '/api/bootstrap', { headers: { Host: 'rebind.invalid' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(rebound >= 400, `Unexpected success with forged Host: ${rebound}`);
});

test('UI writes require both a valid session and the exact localhost origin', async t => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: 'https://foreign.invalid' },
    { Origin: null },
    { Origin: 'null' },
    { 'X-Corla-Session': 'wrong-token' },
    { 'X-Corla-Session': null },
  ]) {
    const response = await f.post('/api/config', { config: f.bootstrap.config }, headers);
    assert.ok(response.status === 401 || response.status === 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(existsSync(join(f.rootDir, 'config.local.json')), false);
  assert.equal(f.observed.providers, 0);
});

test('stale tabs cannot overwrite saved settings or start a reviewed live job against another revision', async t => {
  const f = await fixture(t, { localWallets: true });
  const { config, configRevision } = f.bootstrap;
  const current = await ok(await f.post('/api/config', { config: { ...config, pollMs: 1400 } }));
  assert.notEqual(current.configRevision, configRevision);
  const staleSave = await f.post('/api/config', { config: { ...config, maxTotalBnb: '0.1' }, configRevision });
  assert.equal(staleSave.status, 409);
  assert.equal((await staleSave.json()).code, 'CONFIG_STALE');
  const staleStart = await f.post('/api/start', liveBody(f, { configRevision }));
  assert.equal(staleStart.status, 409);
  assert.equal((await staleStart.json()).code, 'CONFIG_STALE');
  assert.equal(f.observed.unlocks, 0);
  assert.equal((await f.post('/api/config', { config, configRevision: undefined })).status, 409);
  const persisted = (await ok(await f.get('/api/bootstrap'))).config;
  assert.equal(persisted.pollMs, 1400);
  assert.equal(persisted.maxTotalBnb, config.maxTotalBnb);
});

test('state revisions skip unchanged payloads and explicitly reject stale browser sessions', async t => {
  const f = await fixture(t);
  const initial = await ok(await f.get('/api/state'));
  assert.equal(initial.configRevision, f.bootstrap.configRevision);
  const since = '/api/state?since=' + encodeURIComponent(initial.stateRevision);
  assert.deepEqual(await ok(await f.get(since)), { unchanged: true, stateRevision: initial.stateRevision });
  const expired = await fetch(f.url + since, { headers: { 'X-Corla-Session': 'old-session' } });
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'SESSION_EXPIRED');
  const saved = await ok(await f.post('/api/config', { config: { ...f.bootstrap.config, targets: [] } }));
  const updated = await ok(await f.get(since));
  assert.notEqual(updated.stateRevision, initial.stateRevision);
  assert.equal(updated.configRevision, saved.configRevision);
  assert.deepEqual(updated.projects, []);
  const delta = await ok(await f.get(since + '&afterLog=' + encodeURIComponent(initial.logCursor)));
  assert.equal(delta.logsDelta, true);
  assert.deepEqual(delta.logs, []);
  assert.equal(delta.logCursor, initial.logCursor);
});

test('a slow summary or draft project cannot bring back deleted saved projects', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { beforeSummary: () => { entered.resolve(); return release.promise; } });
  const body = { config: f.bootstrap.config, summaryOnly: true };
  const pending = f.post('/api/status', body);
  try {
    await entered.promise;
    await ok(await f.post('/api/config', { config: { ...body.config, targets: [] } }));
    release.resolve();
    assert.equal((await ok(await pending)).projects.length, 2);
    assert.deepEqual((await ok(await f.get('/api/state'))).projects, []);
    assert.equal((await ok(await f.post('/api/status', body))).projects.length, 2);
    assert.deepEqual((await ok(await f.get('/api/state'))).projects, []);
  } finally {
    release.resolve();
  }
});

test('preview merges the same contract read without blocking a different project', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked;
  const f = await fixture(t, { beforeInspect: target => {
    if (target.token !== blocked) return;
    entered.resolve();
    return release.promise;
  } });
  const [first, second] = f.bootstrap.config.targets;
  blocked = parseMintLink(first.url).token;
  const pending = f.post('/api/project/preview', { url: first.url });
  try {
    await entered.promise;
    const duplicate = f.post('/api/project/preview', { url: first.url });
    const other = await ok(await f.post('/api/project/preview', { url: second.url }));
    assert.equal(other.project.token, parseMintLink(second.url).token);
    release.resolve();
    assert.deepEqual(await ok(await pending), await ok(await duplicate));
    assert.equal(f.observed.inspections.filter(row => row.token === blocked).length, 1);
  } finally {
    release.resolve();
  }
});

test('oversized streaming requests receive 413 without waiting for the body to end', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const req = request(f.url + '/api/config', { method: 'POST', headers: {
      Origin: f.url, 'X-Corla-Session': f.bootstrap.sessionToken, 'Content-Type': 'application/json',
    } }, res => {
      res.resume();
      res.once('end', () => { resolve([res.statusCode, res.headers.connection]); req.destroy(); });
      res.once('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('Expected 413 before the client sent EOF')));
    req.once('error', reject);
    req.write(Buffer.alloc(129 * 1024));
  });
  assert.deepEqual(result, [413, 'close']);
  assert.equal((await ok(await f.get('/api/bootstrap'))).configRevision, f.bootstrap.configRevision);
});

test('UI validates project URLs, persists editable local settings, and reads production wallet status without unlocking', async t => {
  const f = await fixture(t, { localWallets: true });
  const config = structuredClone(f.bootstrap.config);
  const invalid = structuredClone(config);
  invalid.targets[0].url = invalid.targets[0].url.replace('flap.sh', 'attacker.invalid');
  assert.ok(!(await f.post('/api/config', { config: invalid })).ok);
  assert.equal(existsSync(join(f.rootDir, 'config.local.json')), false);
  for (const hidden of ['rpcUrl', 'walletFile', 'journalPath']) {
    const injected = { ...config, [hidden]: 'https://attacker.invalid/' };
    assert.ok(!(await f.post('/api/config', { config: injected })).ok);
  }
  config.pollMs = 500;
  const saved = await ok(await f.post('/api/config', { config }));
  assert.deepEqual(saved.config.targets, config.targets);
  const reopened = await ok(await f.get('/api/bootstrap'));
  assert.equal(reopened.source, 'local');
  assert.equal(reopened.config.pollMs, 500);
  const persisted = JSON.parse(await readFile(join(f.rootDir, 'config.local.json'), 'utf8'));
  const original = JSON.parse(await readFile(fakeConfigFile, 'utf8'));
  for (const key of ['rpcUrl', 'walletFile', 'journalPath']) {
    assert.equal(persisted[key], original[key]);
    assert.equal(reopened.config[key], undefined);
  }
  const status = await ok(await f.post('/api/status', { config }));
  assert.equal(status.projects.length, config.targets.length);
  assert.equal(status.projects[0].mintedLots, '4');
  assert.equal(status.projects[0].pricePerLot, '100000000000000000');
  assert.equal(status.projects[0].participants[0].count, '1');
  assert.equal(status.projects[0].participants[0].wallet, checkedWallet);
  assert.equal(f.observed.inspections[0].blockNumber, f.head);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
  const state = await ok(await f.get('/api/state'));
  assert.equal(state.running, false);
  assert.equal(state.mode, 'idle');
});

test('UI can remove all projects and add one back without starting a trading job', async t => {
  const f = await fixture(t, { localWallets: true });
  const emptyConfig = { ...f.bootstrap.config, targets: [] };
  assert.deepEqual((await ok(await f.post('/api/config', { config: emptyConfig }))).config.targets, []);
  assert.deepEqual((await ok(await f.get('/api/bootstrap'))).config.targets, []);
  assert.deepEqual((await ok(await f.post('/api/status', { config: emptyConfig }))).projects, []);
  assert.ok(!(await f.post('/api/start', liveBody(f, { config: emptyConfig }))).ok);
  assert.equal(f.observed.providers, 0);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
  const target = f.bootstrap.config.targets[0];
  assert.deepEqual((await ok(await f.post('/api/config', { config: { ...emptyConfig, targets: [target] } }))).config.targets, [target]);
});

test('UI discover uses a bounded recent block window and does not enable trading', async t => {
  const f = await fixture(t);
  const { config } = f.bootstrap;
  for (const blocks of [0, 50001, 1.5]) {
    assert.ok(!(await f.post('/api/discover', { config, blocks })).ok);
  }
  assert.equal(f.observed.discovery.length, 0);
  const { projects } = await ok(await f.post('/api/discover', { config, blocks: 70 }));
  assert.deepEqual(f.observed.discovery, [[f.head - 69, f.head]]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].url, config.targets[0].url);
  assert.equal(f.observed.executors.length, 0);
  assert.equal(existsSync(join(f.rootDir, 'config.local.json')), false);
});

test('service control requires a local session and an exact fixed action', async t => {
  const accepted = [];
  const f = await fixture(t, { allowLive: false, onLifecycle: action => { accepted.push(action); } });
  const route = '/api/local/lifecycle', payload = { action: 'restart' };
  const health = await ok(await f.get('/api/health'));
  assert.deepEqual(health, { service: 'corla-desk', instance: f.bootstrap.serviceInstance, action: null });
  assert.match(health.instance, /^[a-f0-9]{16}$/);
  assert.equal(f.bootstrap.serviceControls, true);
  assert.equal((await f.get(route)).status, 404);
  assert.equal((await f.post(route, payload, { 'X-Corla-Session': null })).status, 403);
  assert.equal((await f.post(route, payload, { Origin: null })).status, 403);
  assert.equal((await f.post(route, payload, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const body of [{}, { action: 'run' }, { ...payload, path: 'fixture.mjs' }]) {
    assert.equal((await f.post(route, body)).status, 400);
  }
  assert.deepEqual(accepted, []);
  const response = await f.post(route, payload);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), payload);
  assert.deepEqual(accepted, ['restart']);
  assert.equal((await ok(await f.get('/api/health'))).action, 'restart');
  assert.equal((await f.post(route, { action: 'exit' })).status, 409);
  assert.equal((await f.post('/api/config', { config: f.bootstrap.config })).status, 409);
  assert.deepEqual(accepted, ['restart']);
});

test('service exit awaits an active job stopping before taking down the health listener', async t => {
  const network = Promise.withResolvers(), shutdown = Promise.withResolvers();
  const f = await fixture(t, {
    allowLive: false, allowSimulation: true, beforeNetwork: () => network.promise,
    onLifecycle: action => {
      assert.equal(action, 'exit');
      const task = f.close();
      shutdown.resolve(task);
      return task;
    },
  });
  const start = f.post('/api/start', { mode: 'simulation', config: f.bootstrap.config });
  try {
    await eventually(async () => (await ok(await f.get('/api/state'))).starting);
    assert.equal((await f.post('/api/local/lifecycle', { action: 'exit' })).status, 202);
    await eventually(async () => (await ok(await f.get('/api/state'))).stopping);
    assert.equal((await ok(await f.get('/api/health'))).action, 'exit');
  } finally { network.resolve(); }
  assert.equal((await start).status, 400);
  await shutdown.promise;
  assert.equal(f.observed.executors.length, 0);
  assert.equal(f.observed.destroyed, 1);
  await assert.rejects(f.get('/api/health'));
});

test('service control is unavailable in embedded servers without a process owner', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.serviceControls, false);
  assert.equal((await f.post('/api/local/lifecycle', { action: 'exit' })).status, 409);
  assert.equal((await ok(await f.get('/api/health'))).action, null);
});

test('service exit waits for a wallet save to finish before accepting shutdown', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const accepted = [];
  const f = await fixture(t, {
    onLifecycle: action => { accepted.push(action); },
    beforeWalletImport: () => { entered.resolve(); return release.promise; },
  });
  const saving = f.post('/api/wallets/import', { password: mockPassword, privateKeys: [mockKeyOne] });
  try {
    await Promise.race([entered.promise, saving.then(res => assert.fail('wallet write finished before its gate: ' + res.status))]);
    assert.equal((await f.post('/api/local/lifecycle', { action: 'exit' })).status, 409);
    assert.deepEqual(accepted, []);
  } finally { release.resolve(); }
  assert.equal((await saving).status, 200);
  assert.equal((await f.post('/api/local/lifecycle', { action: 'exit' })).status, 202);
  assert.deepEqual(accepted, ['exit']);
});

test('UI simulation emits project and action updates, blocks another start, and stops cleanly', async t => {
  const f = await fixture(t, { allowLive: false, allowSimulation: true });
  const config = structuredClone(f.bootstrap.config);
  config.watchWallets = [publicWallet];
  config.pollMs = 300;
  const started = await ok(await f.post('/api/start', { config, mode: 'simulation' }));
  assert.equal(started.running, true);
  assert.equal(started.mode, 'simulation');
  assert.equal(f.observed.executors.length, 1);
  assert.equal(f.observed.executors[0].live, false);
  assert.deepEqual(f.observed.executors[0].wallets.map(w => w.address.toLowerCase()), [publicWallet]);
  assert.equal(f.observed.unlocks, 0);
  assert.ok(!(await f.post('/api/start', { config, mode: 'simulation' })).ok);
  const observed = await eventually(async () => {
    const state = await ok(await f.get('/api/state'));
    return state.logs.some(l => l.event === 'mint' && l.status === 'simulated') && state.projects.length && state;
  });
  assert.equal(observed.projects[0].mintedLots, '4');
  const stopped = await ok(await f.post('/api/stop', {}));
  assert.equal(stopped.running, false);
  assert.equal(stopped.mode, 'idle');
  const changed = '/api/state?since=' + encodeURIComponent(observed.stateRevision);
  const tail = await ok(await f.get(changed + '&afterLog=' + encodeURIComponent(observed.logCursor)));
  assert.equal(tail.logsDelta, true);
  assert.equal(tail.logs.at(-1).event, 'watch_stopped');
  const fallback = await ok(await f.get(changed + '&afterLog=another-process%3A0'));
  assert.equal(fallback.logsDelta, undefined);
  assert.deepEqual(fallback.logs, stopped.logs);
  assert.deepEqual([...observed.logs, ...tail.logs].slice(-150), fallback.logs);
  assert.equal(tail.logCursor, fallback.logCursor);
  assert.equal(f.observed.closed, 1);
  assert.equal(f.observed.destroyed, 1);
  const ticks = f.observed.ticks;
  await delay(350);
  assert.equal(f.observed.ticks, ticks);
});

test('UI serializes start, stop and config save during an in-flight chain check', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { allowLive: false, allowSimulation: true, beforeNetwork: () => gate.promise });
  const { config } = f.bootstrap;
  const firstStart = f.post('/api/start', { config, mode: 'simulation' });
  try {
    await eventually(async () => (await ok(await f.get('/api/state'))).starting);
    assert.equal((await f.post('/api/start', { config, mode: 'simulation' })).status, 409);
    assert.equal((await f.post('/api/config', { config })).status, 409);
    const stopping = f.post('/api/stop', {});
    await eventually(async () => (await ok(await f.get('/api/state'))).stopping);
    gate.resolve();
    assert.ok(!(await firstStart).ok);
    assert.equal((await ok(await stopping)).mode, 'idle');
    assert.equal(f.observed.executors.length, 0);
    assert.equal(f.observed.destroyed, 1);
  } finally { gate.resolve(); }
});

test('Production rejects simulation, wrong-chain RPC, and live without exact confirmation', async t => {
  const wrongChain = await fixture(t, { chainId: 1n, localWallets: true });
  const response = await wrongChain.post('/api/start', liveBody(wrongChain));
  assert.ok(!response.ok);
  assert.equal(wrongChain.observed.executors.length, 0);
  assert.equal(wrongChain.observed.unlocks, 0);
  assert.equal((await ok(await wrongChain.get('/api/state'))).running, false);
  const production = await fixture(t, { localWallets: true });
  assert.equal(production.bootstrap.allowLive, true);
  assert.ok(!(await production.post('/api/start', { config: production.bootstrap.config, mode: 'simulation' })).ok);
  for (const confirmation of [undefined, 'bsc live', 'yes']) {
    assert.ok(!(await production.post('/api/start', liveBody(production, { confirmation }))).ok);
  }
  assert.equal(production.observed.unlocks, 0);
  assert.equal(production.observed.providers, 0);
  assert.equal(production.observed.executors.length, 0);
  const testing = await fixture(t, { allowLive: false, allowSimulation: true, localWallets: true });
  assert.equal(testing.bootstrap.allowLive, false);
  assert.ok(!(await testing.post('/api/start', liveBody(testing))).ok);
  assert.equal(testing.observed.unlocks, 0);
  assert.equal(testing.observed.providers, 0);
});

test('UI live start requires vault authentication, enabled actions, and the exact confirmed wallet set', async t => {
  const f = await fixture(t, { localWallets: true });
  const config = liveConfig(f.bootstrap.config);
  assert.deepEqual(f.bootstrap.liveWallets, [checkedWallet]);
  const body = liveBody(f, { config });
  for (const expectedWallets of [undefined, [], [secondWallet]]) {
    assert.ok(!(await f.post('/api/start', { ...body, expectedWallets })).ok);
    assert.equal(f.observed.executors.length, 0);
  }
  assert.ok(!(await f.post('/api/start', { ...body, config: f.bootstrap.config })).ok, 'First-run samples must not arm automatically');
  const lowBudget = { ...config, maxTotalBnb: '0.0001' };
  assert.ok(!(await f.post('/api/start', { ...body, config: lowBudget })).ok);
  const wrongPassword = 'long-wrong-password-never-echo';
  const badAuth = await f.post('/api/start', { ...body, password: wrongPassword });
  assert.ok(!badAuth.ok);
  noSecret(await badAuth.text(), wrongPassword);
  assert.ok(!(await f.post('/api/start', { ...body, password: undefined })).ok);
  assert.equal(f.observed.executors.length, 0);
  const live = await ok(await f.post('/api/start', body));
  assert.equal(live.mode, 'live');
  assert.equal(f.observed.executors.length, 1);
  assert.equal(f.observed.executors[0].live, true);
  assert.equal(f.observed.executors[0].confirmations, 3);
  assert.equal(f.observed.executors[0].signal, f.observed.monitors[0].signal);
  assert.equal(f.observed.executors[0].signal.aborted, false);
  assert.deepEqual(f.observed.executors[0].wallets, [{ address: checkedWallet }]);
  assert.equal((await f.post('/api/wallets/remove', { password: mockPassword, address: checkedWallet })).status, 409);
  assert.equal((await f.post('/api/wallets/import', { password: mockPassword, privateKeys: [mockKeyTwo] })).status, 409);
  assert.equal(f.observed.removals, 0);
  assert.equal(f.observed.imports, 0);
  noSecret(await ok(await f.get('/api/state')), wrongPassword);
  assert.equal((await ok(await f.post('/api/stop', {}))).running, false);
  assert.equal(f.observed.executors[0].signal.aborted, true);
});

test('Windows local unlock requires the original password once, never bypasses live confirmation, and is revocable', async t => {
  let protectedPassword;
  let reads = 0, writes = 0;
  const localUnlock = {
    supported: true,
    async exists() { return protectedPassword !== undefined; },
    async save(password) { writes++; protectedPassword = password; },
    async read() { reads++; if (!protectedPassword) throw new Error('fixture has no remembered credential'); return protectedPassword; },
    async remove() { protectedPassword = undefined; },
  };
  const f = await fixture(t, { localWallets: true, localUnlock });
  assert.equal(f.bootstrap.walletLocalUnlockSupported, true);
  assert.equal(f.bootstrap.walletLocalUnlock, false);
  const denied = await f.post('/api/wallets/remember-local-unlock', { password: 'wrong-fixture-password' });
  assert.equal(denied.status, 400);
  noSecret(await denied.text(), 'wrong-fixture-password');
  assert.equal(writes, 0);
  const started = await ok(await f.post('/api/start', liveBody(f, { rememberLocalUnlock: true })));
  assert.equal(started.walletLocalUnlock, true);
  assert.equal(writes, 1);
  noSecret(started);
  assert.equal((await f.post('/api/wallets/forget-local-unlock', {})).status, 409);
  await ok(await f.post('/api/stop', {}));
  const passwordless = liveBody(f, { useLocalUnlock: true, password: undefined });
  assert.equal((await f.post('/api/start', { ...passwordless, confirmation: 'wrong' })).status, 403);
  assert.equal(reads, 0);
  assert.equal((await ok(await f.post('/api/start', passwordless))).mode, 'live');
  assert.equal(reads, 1);
  await ok(await f.post('/api/stop', {}));
  assert.equal((await f.get('/state/wallet-unlock.dpapi')).status, 404);
  assert.deepEqual(await ok(await f.post('/api/wallets/forget-local-unlock', {})), { walletLocalUnlock: false });
  assert.equal((await f.post('/api/start', passwordless)).status, 400);
  assert.equal(f.observed.executors.length, 2);
  assert.deepEqual(await ok(await f.post('/api/wallets/remember-local-unlock', { password: mockPassword })), { walletLocalUnlock: true });
  assert.deepEqual((await ok(await f.post('/api/wallets/import', { privateKeys: [mockKeyTwo], useLocalUnlock: true })))
    .wallets.map(row => row.address), [checkedWallet, secondWallet]);
});

test('UI vault imports and removes wallets without leaking password or private-key fields', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.bootstrap.walletVault, []);
  assert.equal(f.bootstrap.liveWalletReady, false);
  const password = mockPassword;
  const first = { password, privateKeys: [mockKeyOne], label: '铸造钱包' };
  const removeFirst = { password, address: checkedWallet };
  assert.equal((await f.post('/api/wallets/import', first, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.post('/api/wallets/remove', removeFirst, { 'X-Corla-Session': null })).status, 403);
  assert.equal(f.observed.imports, 0);
  assert.equal(f.observed.removals, 0);
  const added = await ok(await f.post('/api/wallets/import', first));
  assert.deepEqual(added.wallets, [{ address: checkedWallet, label: '铸造钱包' }]);
  noSecret(added);
  const loaded = await ok(await f.get('/api/bootstrap'));
  assert.deepEqual(loaded.walletVault, added.wallets);
  assert.deepEqual(loaded.liveWallets, [checkedWallet]);
  assert.equal(loaded.liveWalletCount, 1);
  assert.equal(loaded.liveWalletReady, true);
  noSecret(loaded);
  const badPassword = 'wrong-local-fixture-password';
  for (const [route, payload] of [
    ['/api/wallets/import', { ...first, privateKeys: [mockKeyTwo], password: badPassword }],
    ['/api/wallets/remove', { ...removeFirst, password: badPassword }],
  ]) {
    const rejected = await f.post(route, payload);
    assert.ok(!rejected.ok);
    noSecret(await rejected.text(), badPassword);
  }
  const duplicate = await f.post('/api/wallets/import', first);
  assert.ok(!duplicate.ok);
  noSecret(await duplicate.text());
  const removed = await ok(await f.post('/api/wallets/remove', removeFirst));
  assert.deepEqual(removed.wallets, []);
  assert.equal((await ok(await f.get('/api/bootstrap'))).liveWalletReady, false);
  assert.equal(f.observed.providers, 0);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
});

test('UI does not arm a live task while the wallet set is being changed', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { localWallets: true, beforeWalletImport: () => gate.promise });
  const pending = f.post('/api/wallets/import', { password: mockPassword, privateKeys: [mockKeyTwo] });
  try {
    await eventually(() => f.observed.imports === 1);
    assert.equal((await f.post('/api/start', liveBody(f))).status, 409);
    assert.equal((await f.post('/api/wallets/remove', { password: mockPassword, address: checkedWallet })).status, 409);
    assert.equal(f.observed.providers, 0);
    assert.equal(f.observed.unlocks, 0);
    gate.resolve();
    const updated = await ok(await pending);
    assert.deepEqual(updated.wallets.map(w => w.address), [checkedWallet, secondWallet]);
  } finally { gate.resolve(); }
});

test('workspace bootstrap migrates legacy buy switches without arming first-run samples', async t => {
  const fresh = await fixture(t);
  assert.deepEqual(fresh.bootstrap.config.snipeTargets, []);
  assert.equal(fresh.bootstrap.config.snipe.requirePreopen, true);
  assert.equal(fresh.bootstrap.config.snipe.repeatAttempts, 2);
  const old = JSON.parse(await readFile(fakeConfigFile, 'utf8'));
  delete old.snipeTargets;
  delete old.snipe.requirePreopen;
  old.snipe.repeatAttempts = 1;
  old.targets[0].buyOnLaunch = true;
  old.targets[1].buyOnLaunch = false;
  const legacy = await fixture(t, { localConfig: old });
  assert.equal(legacy.bootstrap.source, 'local');
  assert.deepEqual(legacy.bootstrap.config.snipeTargets, [old.targets[0].url]);
  assert.equal(legacy.bootstrap.config.snipe.requirePreopen, false);
  assert.equal(legacy.bootstrap.config.snipe.repeatAttempts, 1);
  assert.equal(JSON.parse(await readFile(join(legacy.rootDir, 'config.local.json'), 'utf8')).snipeTargets, undefined);

  const edited = { ...legacy.bootstrap.config, snipeTargets: [] };
  assert.deepEqual((await ok(await legacy.post('/api/config', { config: edited }))).config.snipeTargets, []);
  assert.deepEqual((await ok(await legacy.get('/api/bootstrap'))).config.snipeTargets, []);
  assert.equal(legacy.observed.executors.length, 0);
});

test('sniper concurrency and round settings survive saving, reload, and execution setup', async t => {
  const f = await fixture(t, { localWallets: true });
  const original = f.bootstrap.config;
  const strategy = { ...original.snipe, broadcastConcurrency: 4, repeatAttempts: 12 };
  const invalid = { ...original, snipe: { ...strategy, broadcastConcurrency: 9 } };
  assert.equal((await f.post('/api/config', { config: invalid })).status, 400);
  const config = { ...original, snipeTargets: [original.targets[0].url], snipe: strategy };
  const saved = await ok(await f.post('/api/config', { config }));
  assert.deepEqual(saved.config.snipe, strategy);
  const disk = JSON.parse(await readFile(join(f.rootDir, 'config.local.json'), 'utf8'));
  assert.deepEqual(disk.snipe, strategy);
  const reopened = await ok(await f.get('/api/bootstrap'));
  assert.deepEqual(reopened.config.snipe, strategy);
  assert.deepEqual(reopened.snipeTiming, { retryWindowMs: SNIPE_RACE_WINDOW_MS, rpcTimeoutMs: LOW_LATENCY_RPC_TIMEOUT_MS,
    maxAttempts: MAX_SNIPE_ATTEMPTS });
  const run = await ok(await f.post('/api/start', liveBody(f, { config: reopened.config, workspace: 'snipe' })));
  assert.equal(run.workspace, 'snipe');
  assert.equal(f.observed.executors[0].broadcastConcurrency, 4);
  assert.equal(f.observed.monitors[0].settings.repeatAttempts, 12);
  assert.equal(f.observed.monitors[0].settings.requirePreopen, true);
  assert.equal((await ok(await f.post('/api/stop', { workspace: 'snipe' }))).running, false);
  const report = await readFile(join(f.rootDir, run.snipeReport), 'utf8');
  const { settings } = JSON.parse(report.split('\n')[0]);
  assert.equal(settings.broadcastConcurrency, 4);
  assert.equal(settings.repeatAttempts, 12);
  assert.equal(settings.requirePreopen, true);
  const optedOut = { ...reopened.config, snipe: { ...strategy, requirePreopen: false, repeatAttempts: 1 } };
  await ok(await f.post('/api/config', { config: optedOut }));
  assert.deepEqual((await ok(await f.get('/api/bootstrap'))).config.snipe, optedOut.snipe);
});

const snipeBodyFor = f => liveBody(f, { workspace: 'snipe', config: {
  ...f.bootstrap.config, snipeTargets: [f.bootstrap.config.targets[0].url],
} });
async function readRun(f, state) {
  assert.match(state.snipeReport, /^reports\/snipe-runs\/snipe-[\w-]+\.ndjson$/);
  return (await readFile(join(f.rootDir, state.snipeReport), 'utf8')).trim().split('\n').map(JSON.parse);
}

test('a report is opened before the first RPC check; startup failure is written before the API returns', async t => {
  const f = await fixture(t, { chainId: 1n, localWallets: true });
  assert.equal((await ok(await f.get('/api/state'))).snipeReport, null);
  assert.equal((await f.post('/api/start', snipeBodyFor(f))).status, 400);
  const state = await ok(await f.get('/api/state'));
  const rows = await readRun(f, state);
  assert.equal(state.running, false);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
  assert.deepEqual(rows.map(row => row.event), ['run_start', 'watch_error', 'run_end']);
  assert.equal(rows[0].armBlock, undefined);
  assert.equal(rows.at(-1).dropped, 0);
  noSecret(rows, f.bootstrap.sessionToken, checkedWallet);
});

test('a report storage error stops sniper setup before RPC, wallet unlock or execution', async t => {
  const f = await fixture(t, { localWallets: true });
  await writeFile(join(f.rootDir, 'reports'), 'test fixture blocking directory creation');
  const response = await f.post('/api/start', snipeBodyFor(f));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /狙击测速记录/);
  const state = await ok(await f.get('/api/state'));
  assert.equal(state.running, false);
  assert.equal(state.snipeReport, null);
  assert.equal(f.observed.providers, 0);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
});

test('canceling a sniper before arming still leaves a complete report', async t => {
  const gate = Promise.withResolvers(), checking = Promise.withResolvers();
  const f = await fixture(t, { localWallets: true, beforeNetwork: () => {
    checking.resolve(); return gate.promise;
  } });
  const starting = f.post('/api/start', snipeBodyFor(f));
  let stopping;
  try {
    await checking.promise;
    const state = await ok(await f.get('/api/state'));
    assert.equal(state.starting, true);
    const active = await readRun(f, state);
    assert.deepEqual(active.map(row => row.event), ['run_start']);
    stopping = f.post('/api/stop', { workspace: 'snipe' });
    await eventually(async () => (await ok(await f.get('/api/state'))).stopping);
    gate.resolve();
    assert.equal((await starting).status, 400);
    const stopped = await ok(await stopping);
    assert.equal(stopped.snipeReport, state.snipeReport);
    assert.deepEqual((await readRun(f, stopped)).map(row => row.event), ['run_start', 'watch_stopped', 'run_end']);
    assert.equal(f.observed.executors.length, 0);
  } finally { gate.resolve(); await Promise.allSettled([starting, stopping]); }
});

test('pending receive time is saved while the run is active, and the latest path survives restart', async t => {
  const f = await fixture(t, { localWallets: true });
  const body = snipeBodyFor(f);
  const run = await ok(await f.post('/api/start', body));
  const { log, cfg: armedConfig } = f.observed.monitors[0];
  const { mint, token } = armedConfig.targets[0];
  const pendingTxHash = '0x' + 'fa'.repeat(32);
  const pendingReceivedAtMs = Date.now() - 17;
  log('snipe_pending', { mint, token, pendingTxHash, pendingReceivedAtMs, pendingMode: 'full', wallet: checkedWallet,
    raw: mockKeyOne, secret: mockPassword });
  const pending = await eventually(async () => {
    try { return (await readRun(f, run)).find(row => row.event === 'snipe_pending'); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  });
  assert.equal(pending.pendingTxHash, pendingTxHash);
  assert.equal(pending.pendingReceivedAtMs, pendingReceivedAtMs);
  assert.equal(pending.pendingMode, 'full');
  assert.equal(pending.time, new Date(pendingReceivedAtMs).toISOString());
  noSecret(pending, f.bootstrap.sessionToken, checkedWallet);
  const stopped = await ok(await f.post('/api/stop', { workspace: 'snipe' }));
  const oldRows = await readRun(f, stopped);
  assert.equal(oldRows.find(row => row.event === 'watch_started').armBlock, f.head);
  assert.equal(oldRows.at(-1).event, 'run_end');
  const next = await ok(await f.post('/api/start', body));
  assert.notEqual(next.snipeReport, stopped.snipeReport);
  await ok(await f.post('/api/stop', { workspace: 'snipe' }));
  assert.deepEqual(await readRun(f, stopped), oldRows);
  const reopened = await createUiServer({ rootDir: f.rootDir, services: f.services });
  try {
    assert.equal((await ok(await fetch(reopened.url + '/api/state'))).snipeReport, next.snipeReport);
    assert.equal((await fetch(reopened.url + '/' + next.snipeReport)).status, 404);
  } finally { await reopened.close(); }
});

test('scoped workspace status and preview use verified Corla links without unlocking', async t => {
  const f = await fixture(t);
  const [mint, snipe] = f.bootstrap.config.targets;
  const config = { ...f.bootstrap.config, targets: [mint], snipeTargets: [snipe.url] };
  const mintToken = parseMintLink(mint.url).token;
  const snipeToken = parseMintLink(snipe.url).token;
  assert.equal((await f.post('/api/status', { config, workspace: 'unknown' })).status, 400);
  assert.equal((await f.post('/api/project/preview', { url: mint.url }, { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.post('/api/project/preview', { url: mint.url.replace('flap.sh', 'attacker.invalid') })).status, 400);
  assert.equal(f.observed.providers, 0);

  const scopedMint = await ok(await f.post('/api/status', { config, workspace: 'mint' }));
  assert.deepEqual(scopedMint.projects.map(project => project.token), [mintToken]);
  const scopedSnipe = await ok(await f.post('/api/status', { config, workspace: 'snipe' }));
  assert.deepEqual(scopedSnipe.projects.map(project => project.token), [snipeToken]);
  const merged = await ok(await f.get('/api/state'));
  assert.deepEqual(merged.projects.map(project => project.token).sort(), [mintToken, snipeToken].sort());
  const all = await ok(await f.post('/api/status', { config }));
  assert.deepEqual(all.projects.map(project => project.token).sort(), [mintToken, snipeToken].sort());
  const preview = (await ok(await f.post('/api/project/preview', { url: snipe.url }))).project;
  assert.equal(preview.token, snipeToken);
  assert.equal(preview.pricePerLot, '100000000000000000');
  assert.equal(preview.maxMintsPerWallet, '7');
  assert.equal(preview.block, f.head);
  assert.equal(f.observed.unlocks, 0);
  assert.equal(f.observed.executors.length, 0);
});

test('live workspaces isolate their trade plans and enforce a single running job', async t => {
  const f = await fixture(t, { localWallets: true });
  const wallets = [checkedWallet, secondWallet];
  await ok(await f.post('/api/wallets/import', { password: mockPassword, privateKeys: [mockKeyTwo] }));
  const [mint, snipe] = f.bootstrap.config.targets;
  const config = {
    ...f.bootstrap.config,
    // Only one wallet is selected, so this intentionally tight budget fits exactly.
    maxGasPriceGwei: '0.25', gasLimitCap: 10_000_000, maxTotalBnb: '0.31',
    targets: [{ ...mint, mintBatches: 3, maxMintPriceBnb: '0.1', autoClaim: true, mintWallets: [secondWallet] }],
    snipeTargets: [snipe.url], snipe: { ...f.bootstrap.config.snipe, amountBnb: '0.4', walletCount: 1 },
  };
  const body = liveBody(f, { config, expectedWallets: wallets, workspace: 'mint' });
  for (const workspace of ['all', 'invalid']) {
    assert.equal((await f.post('/api/start', { ...body, workspace })).status, 400);
  }
  const withoutSelection = structuredClone(body);
  delete withoutSelection.config.targets[0].mintWallets;
  assert.equal((await f.post('/api/start', withoutSelection)).status, 400);
  const missingWallet = structuredClone(body);
  missingWallet.config.targets[0].mintWallets = [getAddress('0x000000000000000000000000000000000000face')];
  assert.equal((await f.post('/api/start', missingWallet)).status, 400);
  assert.equal((await f.post('/api/start', { ...body, workspace: 'snipe' })).status, 400);
  assert.equal(f.observed.unlocks, 0);

  const mintRun = await ok(await f.post('/api/start', body));
  assert.equal(mintRun.workspace, 'mint');
  assert.equal((await ok(await f.get('/api/state'))).workspace, 'mint');
  assert.equal(mintRun.logs.find(log => log.event === 'watch_started').worstCaseBnb, '0.31');
  const mintCfg = f.observed.monitors[0].cfg;
  assert.equal(mintCfg.snipe, null);
  assert.equal(mintCfg.targets.length, 1);
  assert.equal(mintCfg.targets[0].mintBatches, 3);
  assert.deepEqual(mintCfg.targets[0].mintWallets, [secondWallet]);
  assert.equal(mintCfg.targets[0].autoClaim, true);
  assert.equal(mintCfg.targets[0].buyOnLaunch, false);
  assert.equal((await f.post('/api/start', { ...body, workspace: 'snipe' })).status, 409);
  assert.equal((await f.post('/api/stop', { workspace: 'snipe' })).status, 409);
  assert.equal((await ok(await f.get('/api/state'))).workspace, 'mint');
  assert.equal((await ok(await f.post('/api/stop', { workspace: 'mint' }))).workspace, null);

  // Then arm only the other job. Its low budget must ignore Mint purchases/claims entirely.
  const snipeBody = { ...body, workspace: 'snipe', config: {
    ...config, maxTotalBnb: '0.025',
    snipe: { ...config.snipe, amountBnb: '0.01' },
  } };
  const snipeRun = await ok(await f.post('/api/start', snipeBody));
  assert.equal(snipeRun.workspace, 'snipe');
  assert.match(snipeRun.snipeReport, /^reports\/snipe-runs\/snipe-[\w-]+\.ndjson$/);
  assert.equal(snipeRun.logs.filter(log => log.event === 'watch_started').at(-1).worstCaseBnb, '0.025');
  const snipeCfg = f.observed.monitors[1].cfg;
  assert.equal(snipeCfg.targets.length, 1);
  assert.equal(snipeCfg.targets[0].token, parseMintLink(snipe.url).token);
  assert.equal(snipeCfg.targets[0].mintBatches, 0);
  assert.equal(snipeCfg.targets[0].autoClaim, false);
  assert.equal(snipeCfg.targets[0].buyOnLaunch, true);
  assert.equal((await ok(await f.post('/api/stop', { workspace: 'snipe' }))).running, false);
  const reportText = await readFile(join(f.rootDir, snipeRun.snipeReport), 'utf8');
  noSecret(reportText, f.bootstrap.sessionToken, checkedWallet, secondWallet);
  const rows = reportText.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].event, 'run_start');
  assert.equal(rows.at(-1).event, 'run_end');
  assert.equal(rows.filter(row => row.event === 'watch_started').length, 1);
  assert.equal(f.observed.executors.length, 2);
});
