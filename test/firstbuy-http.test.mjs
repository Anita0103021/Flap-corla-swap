import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { createUiServer } from '../src/ui-server.mjs';

async function fixture(t, services = {}) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'corla-firstbuy-http-'));
  await mkdir(join(root, 'ui'));
  for (const name of ['firstbuy.js', 'firstbuy.css']) await copyFile(new URL('../ui/' + name, import.meta.url), join(root, 'ui', name));
  await copyFile(new URL('../config.example.json', import.meta.url), join(root, 'config.example.json'));
  const calls = [];
  const app = await createUiServer({ rootDir: root, allowLive: false, services: {
    createFirstBuyService: async () => ({
      status: async () => { calls.push('status'); return { status: 'not_configured', submissionResolved: true }; },
      prepare: async () => { calls.push('prepare'); return { status: 'prepared' }; },
      ...services,
    }),
  } });
  t.after(async () => {
    await app.close();
    const path = await realpath(root);
    assert.equal(dirname(path), parent); assert.ok(basename(path).startsWith('corla-firstbuy-http-'));
    await rm(path, { recursive: true, force: true });
  });
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
  const headers = { 'X-Corla-Session': bootstrap.sessionToken, Origin: app.url };
  return { app, headers, calls };
}

test('firstbuy status uses authenticated GET as the real browser API helper does; unauthenticated reads are rejected', async t => {
  const f = await fixture(t);
  const response = await fetch(f.app.url + '/api/firstbuy/status', { headers: f.headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'not_configured');
  assert.deepEqual(f.calls, ['status']);
  assert.equal((await fetch(f.app.url + '/api/firstbuy/status')).status, 403);
  assert.equal((await fetch(f.app.url + '/api/firstbuy/status', { headers: { ...f.headers, Origin: 'https://foreign.invalid' } })).status, 403);
  assert.deepEqual(f.calls, ['status'], 'forged reads must not reach service reconciliation');
  assert.equal((await fetch(f.app.url + '/api/firstbuy/prepare', { headers: f.headers })).status, 404, 'GET must never be an alias for prepare or a money operation');
});

test('both firstbuy assets are served with correct content types without exposing local state', async t => {
  const f = await fixture(t);
  for (const [name, type] of [['firstbuy.js', 'text/javascript'], ['firstbuy.css', 'text/css']]) {
    const response = await fetch(f.app.url + '/' + name);
    assert.equal(response.status, 200); assert.ok(response.headers.get('Content-Type').startsWith(type));
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(f.app.url + '/firstbuy.local.json')).status, 404);
  assert.equal((await fetch(f.app.url + '/state/transactions.sqlite')).status, 404);
  assert.deepEqual(f.calls, []);
});
