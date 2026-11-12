import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createUiServer } from '../src/ui-server.mjs';

async function readFrames(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  async function next(type) {
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        const frame = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (!type || frame.type === type) return frame;
      } else {
        const { value, done } = await reader.read();
        if (done) throw new Error('Notification stream ended before ' + type);
        buffered += value;
      }
    }
  }
  assert.deepEqual(await next(), { type: 'ready' });
  assert.deepEqual(await next(), { type: 'status', status: 'syncing' });
  return { next, close: () => reader.cancel() };
}

test('desktop notification stream is opt-in, local, shared and filtered by type without replay', { timeout: 9_000 }, async t => {
  const parent = await realpath(tmpdir());
  const prefix = 'corla-notification-test-';
  const rootDir = await mkdtemp(join(parent, prefix));
  let app;
  const first = Promise.withResolvers();
  const entered = Promise.withResolvers();
  t.after(async () => {
    first.resolve();
    await app?.close();
    const path = await realpath(rootDir);
    assert.equal(dirname(path), parent);
    assert.ok(basename(path).startsWith(prefix));
    await rm(path, { recursive: true, force: true });
  });
  await copyFile(new URL('../config.example.json', import.meta.url), join(rootDir, 'config.example.json'));
  const observed = { plans: [], enabled: [], destroyed: 0, walletsUnlocked: 0 };
  let watcherSignal;
  app = await createUiServer({ rootDir, services: {
    createRpcPool(_urls, plan) {
      observed.plans.push(plan);
      return { getNetwork: async () => ({ chainId: 56n }), destroy: () => { observed.destroyed++; } };
    },
    createWalletVault: () => ({
      list: async () => [],
      unlock: async () => { observed.walletsUnlocked++; throw new Error('Read-only stream must not unlock wallets'); },
    }),
    createNotificationFeed: () => async ({ enabled, signal }) => {
      watcherSignal = signal;
      observed.enabled.push(enabled);
      if (observed.enabled.length === 1) {
        entered.resolve();
        await first.promise;
        return { events: [{ id: 'early-burst', kind: 'burst', mintedLots: 21n }, { id: 'old-white', kind: 'whitelist' }] };
      }
      return { events: [{ id: 'white', kind: 'whitelist' }, { id: 'burst', kind: 'burst' }] };
    },
  } });
  const { sessionToken } = await (await fetch(app.url + '/api/bootstrap')).json();
  const endpoint = app.url + '/api/notifications/stream';
  const headers = { 'X-Corla-Session': sessionToken, 'Content-Type': 'application/json', Origin: app.url };
  const expired = await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-Corla-Session': 'old' },
    body: JSON.stringify({ enabled: { whitelist: true, burst: false } }) });
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'SESSION_EXPIRED');
  const foreign = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.invalid' },
    body: JSON.stringify({ enabled: { whitelist: true, burst: false } }) });
  assert.equal(foreign.status, 403);
  const subscribe = (enabled, signal) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ enabled }), signal });
  assert.equal((await subscribe({ whitelist: false, burst: false })).status, 400);
  assert.equal((await subscribe({ whitelist: 'true', burst: false })).status, 400);
  assert.equal(observed.plans.length, 0, 'an inactive browser does not allocate a notification RPC');
  const burst = await readFrames(await subscribe({ whitelist: false, burst: true }, AbortSignal.timeout(7_000)));
  await entered.promise;
  const white = await readFrames(await subscribe({ whitelist: true, burst: false }, AbortSignal.timeout(7_000)));
  first.resolve();
  assert.deepEqual((await burst.next('event')).event, { id: 'early-burst', kind: 'burst', mintedLots: '21' });
  const results = await Promise.all([burst.next('event'), white.next('event')]);
  assert.deepEqual(results.map(row => row.event.id), ['burst', 'white']);
  assert.deepEqual(observed.enabled.slice(0, 2), [{ whitelist: false, burst: true }, { whitelist: true, burst: true }]);
  assert.equal(observed.plans.length, 1);
  assert.deepEqual(observed.plans[0].requiredMethods, ['eth_getLogs']);
  assert.equal(observed.walletsUnlocked, 0);
  await Promise.all([burst.close(), white.close()]);
  for (let i = 0; !watcherSignal?.aborted && i < 50; i++) await delay(10);
  assert.equal(watcherSignal.aborted, true);
  assert.equal(observed.destroyed, 1);
});
