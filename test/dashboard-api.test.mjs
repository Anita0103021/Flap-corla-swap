import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUiServer } from '../src/ui-server.mjs';

test('fast project snapshots reuse their own provider and do not wait for wallet details or metadata', async t => {
  const base = await realpath(tmpdir());
  const prefix = 'corla-dashboard-test-';
  const rootDir = await mkdtemp(join(base, prefix));
  let app;
  const remote = Promise.withResolvers();
  const metadataStarted = Promise.withResolvers();
  t.after(async () => {
    remote.resolve();
    await app?.close();
    const dir = await realpath(rootDir);
    assert.equal(dirname(dir), base);
    assert.ok(basename(dir).startsWith(prefix));
    await rm(dir, { recursive: true, force: true });
  });
  await copyFile(new URL('../config.example.json', import.meta.url), join(rootDir, 'config.example.json'));
  let providers = 0;
  let quickReads = 0;
  let detailReads = 0;
  const address = '0x000000000000000000000000000000000000dEaD';
  app = await createUiServer({ rootDir, services: {
    makeProvider() { providers++; return { getNetwork: async () => ({ chainId: 56n }), getBlockNumber: async () => 9876, destroy() {} }; },
    createWalletVault: () => ({ list: async () => [{ address }] }),
    readDashboardProjects: async (_provider, targets, at) => {
      quickReads++;
      assert.equal(at, 'latest');
      return new Map(targets.map(target => [target.mint.toLowerCase(), { blockNumber: 9876, mintedLots: 7n, totalLots: 50n }]));
    },
    readDashboardParticipants: async (_provider, _target, addresses, at) => {
      detailReads++;
      assert.deepEqual(addresses, [address]);
      assert.equal(at, 9876);
      return [{ wallet: address, count: 1n, claimed: false }];
    },
    createProjectMetadata: () => ({ lookup: async (_provider, target) => {
      metadataStarted.resolve();
      await remote.promise;
      return { token: target.token, mint: target.mint, name: '只读测试项目' };
    } }),
  } });
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
  const opts = { method: 'POST', headers: { 'content-type': 'application/json', origin: app.url, 'x-corla-session': bootstrap.sessionToken } };
  const post = async (route, data) => {
    const r = await fetch(app.url + route, { ...opts, body: JSON.stringify(data) });
    assert.equal(r.status, 200);
    return r.json();
  };
  const [first] = bootstrap.config.targets;
  const imageTask = post('/api/project/metadata', { urls: [first.url] });
  await metadataStarted.promise;
  try {
    const request = { config: bootstrap.config, workspace: 'mint', summaryOnly: true };
    const one = await post('/api/status', request);
    const two = await post('/api/status', request);
    assert.equal(one.projects[0].mintedLots, '7');
    assert.equal(two.projects[0].block, 9876);
    assert.ok(Number.isInteger(one.elapsedMs));
    assert.ok(!Object.hasOwn(one.projects[0], 'participants'));
    assert.equal(quickReads, 2);
    assert.equal(detailReads, 0);
    const details = await post('/api/project/participants', { url: first.url });
    assert.deepEqual(details, { block: 9876, participants: [{ wallet: address, count: '1', claimed: false }] });
    assert.deepEqual(await post('/api/project/participants', { url: first.url }), details);
    assert.equal(detailReads, 1);
    assert.equal(providers, 2, 'the catalog provider is isolated; status and wallet queries share one warm provider');
  } finally { remote.resolve(); }
  assert.equal((await imageTask).projects[0].name, '只读测试项目');
});

test('wallet balance endpoint is same-origin, only reads imported public addresses and preserves null', async t => {
  const base = await realpath(tmpdir());
  const prefix = 'corla-balance-test-';
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
  const a = '0x000000000000000000000000000000000000dEaD';
  const b = '0x0000000000000000000000000000000000000001';
  const fakeSecret = 'fixture-sensitive-field';
  let rows = [{ address: a, privateKey: fakeSecret }, { address: b, password: fakeSecret }];
  let reads = 0;
  let opens = 0;
  app = await createUiServer({ rootDir, services: {
    makeProvider() {
      opens++;
      return { getNetwork: async () => ({ chainId: 56n }), destroy() {} };
    },
    createWalletVault: () => ({ list: async () => rows, unlock: () => assert.fail('must not unlock') }),
    makeExecutor: () => assert.fail('must not create executor'),
    readDashboardWalletBalances: async (_provider, target, addresses) => {
      reads++;
      assert.deepEqual(addresses, [a, b]);
      const wallets = [{ address: a, balanceWei: 0n }, { address: b, balanceWei: null }];
      if (!target) return { block: 9877, wallets };
      return { block: 9876, wallets: [{ ...wallets[0], mintedLots: 1n, hasUnclaimedShare: true }, wallets[1]],
        project: { mint: target.mint, token: target.token, block: 9876 } };
    },
  } });
  const { sessionToken, config } = await (await fetch(app.url + '/api/bootstrap')).json();
  const endpoint = app.url + '/api/project/wallet-balances';
  const headers = { 'content-type': 'application/json', origin: app.url, 'x-corla-session': sessionToken };
  const post = (data, override = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(data) });
  assert.equal((await post({}, { 'x-corla-session': '' })).status, 403);
  assert.equal((await post({}, { origin: 'http://elsewhere.invalid' })).status, 403);
  assert.equal((await post({ addresses: [b] })).status, 400);
  assert.equal((await post({ url: 'https://example.org' })).status, 400);
  assert.equal(opens, 0);

  const req = { url: config.targets[0].url };
  const [one, two] = await Promise.all([post(req), post(req)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const text = await one.text();
  assert.equal(text.includes(fakeSecret), false);
  assert.deepEqual(JSON.parse(text).wallets, [
    { address: a, balanceWei: '0', mintedLots: '1', hasUnclaimedShare: true },
    { address: b, balanceWei: null },
  ]);
  assert.equal(JSON.parse(text).block, 9876);
  assert.equal(await two.text(), text);
  assert.equal(await (await post(req)).text(), text);
  assert.equal(reads, 1, 'requests for a single project and wallet set are coalesced and cached');
  assert.equal(opens, 1, 'balance reads use one warm dashboard provider');

  assert.deepEqual(await (await post({})).json(), { block: 9877, wallets: [
    { address: a, balanceWei: '0' }, { address: b, balanceWei: null },
  ] });
  rows = Array(33).fill({ address: a });
  assert.equal((await post({})).status, 400);
  rows = [];
  assert.deepEqual(await (await post({})).json(), { block: null, wallets: [] });
  assert.equal(reads, 2, 'empty and oversized vault lists never reach RPC');
  const active = await (await fetch(app.url + '/api/state')).json();
  assert.deepEqual(active.projects, []);
  assert.equal(active.running, false);
});
