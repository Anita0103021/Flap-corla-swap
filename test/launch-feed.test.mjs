import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { zeroPadValue } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_LAUNCH_TOPIC, decodeLaunchCandidate } from '../src/events.mjs';
import { makeLaunchFeed } from '../src/launch-feed.mjs';

const target = { factory: FACTORY, mint: '0x4bdd60107d9a1da95e03be6b6e972fa57ea62fd3',
  token: '0x9b540b85d7dc7f3db4fbb7cebc45fb2214667777' };
const pool = '0x31ad8087936d753c90128064e5341c880dc35a34';
const caller = '0xc9916620557cf3e705052801df75f6cee113a899';
const txHash = '0x' + '10'.repeat(32);
const blockHash = '0x' + '20'.repeat(32);
const subscription = '0x1234';
const armBlock = 100;

function raw(block = 101, overrides = {}) {
  return {
    blockHash, blockNumber: '0x' + block.toString(16), address: target.mint, transactionHash: txHash, data: '0x',
    topics: [CORLA_LAUNCH_TOPIC, ...[target.token, pool, caller].map(addr => zeroPadValue(addr, 32))],
    ...overrides,
  };
}
function decoded(log = raw()) {
  return decodeLaunchCandidate(target, log, 0, 1000);
}
function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}
async function eventually(check, message) {
  const limit = Date.now() + 2000;
  for (;;) {
    if (check()) return;
    if (Date.now() >= limit) throw new Error(message);
    await sleep(10);
  }
}

function mockSockets({ wrongFirstChain = false } = {}) {
  const sockets = [];
  const requests = [];
  class WebSocket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
      this.number = sockets.length;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const request = JSON.parse(raw);
      requests.push({ ...request, socket: this.number });
      let result;
      if (request.method === 'eth_chainId') result = wrongFirstChain && this.number === 1 ? '0x1' : '0x38';
      if (request.method === 'eth_subscribe') result = subscription;
      if (request.method === 'eth_blockNumber') result = '0x65';
      queueMicrotask(() => this.message({ jsonrpc: '2.0', id: request.id, result }));
    }
    message(packet) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
    }
    log(log, id = subscription) {
      this.message({ method: 'eth_subscription', params: { subscription: id, result: log } });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.dispatchEvent(new Event('close'));
    }
  }
  return { WebSocket, sockets, requests };
}

test('WS first delivery does not wait for HTTP and overlap deduplicates it', async t => {
  const { WebSocket, sockets, requests } = mockSockets();
  const head = deferred();
  const phases = [];
  const calls = [];
  let scans = 0;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: () => head.promise },
    targets: [target], armBlock, windowBlocks: 10, scanMs: 100, wsUrl: 'wss://example.invalid/secret',
    onCandidate: candidate => { calls.push(candidate); },
    onStatus: status => phases.push(status),
    services: { WebSocket, readCandidates: async () => { scans++; return [decoded()]; } },
  });
  t.after(async () => { head.resolve(101); await feed.close(); });
  feed.start();
  await eventually(() => phases.some(s => s.phase === 'subscribed'), 'expected WSS subscription');
  assert.deepEqual(requests.map(r => r.method), ['eth_chainId', 'eth_subscribe']);
  assert.deepEqual(requests[1].params[1].address.map(a => a.toLowerCase()), [target.mint]);
  sockets[0].log(raw(100)); // pre-arm
  sockets[0].log(raw(), '0xabcd'); // other subscription
  sockets[0].log(raw());
  await eventually(() => calls.length === 1, 'WSS event should not wait for HTTP');
  assert.equal(calls[0].source, 'ws');
  assert.equal(scans, 0);
  head.resolve(101);
  await eventually(() => scans >= 2, 'HTTP overlap should remain active');
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(phases).includes('secret'), false);
});

test('wrong chain WS never subscribes and HTTP recovers a log indexed late', async t => {
  const { WebSocket, sockets, requests } = mockSockets({ wrongFirstChain: true });
  const phases = [];
  const calls = [];
  const ranges = [];
  let height = 101;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: async () => height },
    targets: [target], armBlock, windowBlocks: 10, scanMs: 100, wsUrl: 'wss://example.invalid',
    onCandidate: candidate => { calls.push(candidate); },
    onStatus: status => phases.push(status),
    services: { WebSocket, reconnectBaseMs: 20, readCandidates: async (_, __, from, to) => {
      ranges.push([from, to]);
      return height > 101 ? [decoded()] : [];
    } },
  });
  t.after(() => feed.close());
  feed.start();
  await eventually(() => ranges.length === 1, 'initial HTTP scan absent');
  assert.deepEqual(ranges[0], [101, 101]);
  height = 102;
  await eventually(() => calls.length === 1, 'late-indexed log not recovered');
  assert.equal(calls[0].source, 'http');
  assert.ok(ranges.some(([from, to]) => from === 101 && to === 102));
  assert.ok(phases.some(p => p.transport === 'ws' && p.phase === 'fallback'));
  assert.equal(requests.some(r => r.socket === 1 && r.method === 'eth_subscribe'), false);
  assert.ok(sockets[0].closed);
  assert.ok(requests.some(r => r.socket === 2 && r.method === 'eth_subscribe'));
});

test('removed inclusion is tombstoned but same tx in a new block can be seen', async t => {
  const { WebSocket, sockets, requests } = mockSockets();
  const seen = [];
  const removed = [];
  let replays = 0;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: async () => 102 },
    targets: [target], armBlock, windowBlocks: 10, scanMs: 100, wsUrl: 'wss://example.invalid',
    onCandidate: candidate => { seen.push(candidate); return false; },
    onRemoved: candidate => { removed.push(candidate); },
    services: { WebSocket, readCandidates: async () => { replays++; return replays > 1 ? [decoded()] : []; } },
  });
  t.after(() => feed.close());
  feed.start();
  await eventually(() => requests.length === 2, 'no subscription request');
  sockets[0].log(raw());
  await eventually(() => seen.length === 1, 'initial event absent');
  sockets[0].log(raw(101, { removed: true }));
  sockets[0].log(raw(102, { blockHash: '0x' + '99'.repeat(32) }));
  await eventually(() => seen.length === 2 && removed.length === 1, 'reorg event not delivered');
  await eventually(() => replays >= 4, 'HTTP replays absent');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].blockHash, seen[1].blockHash);
  assert.equal(seen[0].txHash, seen[1].txHash);
});

test('allows bounded retry of a not-yet-indexed receipt and abort stops all polling', async t => {
  const abort = new AbortController();
  const seen = [];
  let scans = 0;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: async () => 103 },
    targets: [target], armBlock, windowBlocks: 10, scanMs: 100, signal: abort.signal,
    onCandidate: candidate => { seen.push(candidate); return seen.length > 1; },
    services: { readCandidates: async () => { scans++; return [decoded()]; } },
  });
  t.after(() => feed.close());
  feed.start();
  await eventually(() => seen.length === 2, 'candidate was not retried');
  assert.equal(seen[0].observedAtMs, seen[1].observedAtMs);
  assert.ok(Number.isFinite(seen[0].observedAtMonotonicMs));
  assert.equal(seen[0].observedAtMonotonicMs, seen[1].observedAtMonotonicMs);
  abort.abort();
  await feed.close();
  const final = scans;
  await sleep(130);
  assert.equal(scans, final);
});

test('transient retry attempts remain bounded even while the head stalls', async t => {
  let attempts = 0, scans = 0;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: async () => 103 }, targets: [target], armBlock, windowBlocks: 10, scanMs: 100,
    onCandidate: () => { attempts++; return false; },
    services: { readCandidates: async () => { scans++; return [decoded()]; } },
  });
  t.after(() => feed.close());
  feed.start();
  await eventually(() => attempts === 4, 'bounded retries did not finish');
  const completedAt = scans;
  await eventually(() => scans >= completedAt + 10, 'HTTP feed did not keep scanning');
  assert.equal(attempts, 4);
});

test('rate limited HTTP reports a sanitized backoff and keeps its scan cursor', async t => {
  const status = [];
  const ranges = [];
  let height = 101;
  const feed = makeLaunchFeed({
    provider: { getBlockNumber: async () => height },
    targets: [target], armBlock, windowBlocks: 10, scanMs: 100,
    onCandidate: () => {},
    onStatus: update => status.push(update),
    services: { readCandidates: async (_, __, from, to) => {
      ranges.push([from, to]);
      if (ranges.length === 1) throw Object.assign(new Error('https://example.invalid/private-rpc'), { code: -32005 });
      return [];
    } },
  });
  t.after(() => feed.close());
  feed.start();
  await eventually(() => status.some(s => s.reason === 'rpc_limited'), 'missing throttle status');
  height = 105;
  await eventually(() => ranges.length === 2, 'scan did not resume');
  assert.deepEqual(status.find(s => s.reason === 'rpc_limited'),
    { transport: 'http', phase: 'retrying', reason: 'rpc_limited', retryMs: 250 });
  assert.deepEqual(ranges, [[101, 101], [101, 105]]);
  assert.equal(JSON.stringify(status).includes('private-rpc'), false);
});
