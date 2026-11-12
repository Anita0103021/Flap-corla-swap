import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Wallet } from 'ethers';
import { createUiServer } from '../src/ui-server.mjs';

test('real encrypted vault integrates with live-only UI and mocked execution', async t => {
  const temp = await realpath(tmpdir());
  const prefix = 'corla-ui-vault-flow-';
  const rootDir = await mkdtemp(join(temp, prefix));
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      const target = await realpath(rootDir);
      assert.equal(dirname(target), temp);
      assert.ok(basename(target).startsWith(prefix));
      await rm(target, { recursive: true, force: true });
    }
  });
  await copyFile(new URL('../config.example.json', import.meta.url), join(rootDir, 'config.example.json'));
  let executorCreated = 0;
  const fixture = Wallet.createRandom();
  const password = 'non-secret isolated test password';
  // Only ethers local crypto and localhost HTTP are real; chain and executor are mocks.
  app = await createUiServer({ rootDir, services: {
    makeProvider: () => ({ getNetwork: async () => ({ chainId: 56n }), getBlockNumber: async () => 100, destroy() {} }),
    makeExecutor: ({ live, wallets }) => {
      assert.equal(live, true);
      assert.deepEqual(wallets.map(w => w.address), [fixture.address]);
      executorCreated++;
      return () => { throw new Error('Transaction executor must not be invoked in this test'); };
    },
    makeMonitor: () => async () => {},
  } });
  const bootstrap = async () => {
    const res = await fetch(app.url + '/api/bootstrap');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes(fixture.privateKey) && !body.includes(password));
    return JSON.parse(body);
  };
  let boot = await bootstrap();
  assert.equal(boot.allowLive, true);
  assert.deepEqual(boot.liveWallets, []);
  const post = (path, data) => fetch(app.url + '/api/' + path, { method: 'POST', headers: {
    Origin: app.url, 'X-Corla-Session': boot.sessionToken, 'Content-Type': 'application/json',
  }, body: JSON.stringify(data) });

  const imported = await post('wallets/import', { password, privateKeys: [fixture.privateKey], label: 'fixture' });
  assert.equal(imported.status, 200);
  assert.deepEqual(await imported.json(), { wallets: [{ address: fixture.address, label: 'fixture' }] });
  const disk = await readFile(join(rootDir, 'state', 'wallet-vault.json'), 'utf8');
  assert.ok(!disk.includes(fixture.privateKey.slice(2)) && !disk.includes(password));
  boot = await bootstrap();
  assert.equal(boot.liveWalletReady, true);
  assert.deepEqual(boot.liveWallets, [fixture.address]);
  assert.equal((await post('start', { mode: 'simulation', config: boot.config })).status, 400);
  const config = structuredClone(boot.config);
  config.targets[0].autoClaim = true;
  const request = { mode: 'live', confirmation: 'BSC LIVE', config, configRevision: boot.configRevision,
    expectedWallets: boot.liveWallets };
  assert.equal((await post('start', { ...request, password: 'deliberately-wrong-password' })).status, 400);
  assert.equal(executorCreated, 0);
  const launched = await post('start', { ...request, password });
  assert.equal(launched.status, 200);
  assert.equal((await launched.json()).mode, 'live');
  assert.equal(executorCreated, 1);
  assert.equal((await post('wallets/remove', { password, address: fixture.address })).status, 409);
  assert.equal((await (await post('stop', {})).json()).mode, 'idle');
  const removed = await post('wallets/remove', { password, address: fixture.address });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { wallets: [] });
  assert.deepEqual((await bootstrap()).walletVault, []);
});
