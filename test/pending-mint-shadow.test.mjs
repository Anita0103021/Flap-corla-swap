import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { armPendingTargets, decodePendingMint, makePendingMintShadow, makePendingTransactionFeed, pendingWsUrl } from '../src/pending-mint-shadow.mjs';

const hashOf = byte => '0x' + byte.repeat(32);
const addr = byte => '0x' + byte.repeat(20);
const target = { factory: FACTORY, mint: addr('01'), token: addr('02'), pricePerLot: 5n };
const second = { factory: FACTORY, mint: addr('03'), token: addr('04'), pricePerLot: 7n };
const third = { factory: FACTORY, mint: addr('05'), token: addr('06'), pricePerLot: 7n };
const map = new Map([[target.mint, target], [second.mint, second]]);
const txHash = hashOf('ad');
const blockHash = hashOf('aa');
const input = CORLA_ABI.encodeFunctionData('mint', [[]]);
const tx = (patch = {}) => ({ hash: txHash, from: addr('a1'), to: target.mint, input, value: '0x5', ...patch });
const launch = (patch = {}) => ({ target, mint: target.mint, token: target.token, blockNumber: 101, blockHash, txHash, source: 'ws', ...patch });

test('decodes only canonical pending Mint calldata for allowlisted direct targets and the pinned lot price', () => {
  assert.deepEqual(decodePendingMint(tx(), map), { mint: target.mint, hash: txHash });
  assert.deepEqual(decodePendingMint(tx({ input: CORLA_ABI.encodeFunctionData('mint', [[hashOf('cd')]]) }), map),
    { mint: target.mint, hash: txHash });
  assert.equal(decodePendingMint(tx({ to: third.mint }), map), null);
  assert.equal(decodePendingMint(tx({ to: second.mint }), map), null);
  assert.equal(decodePendingMint(tx({ value: '0x6' }), map), null);
  assert.equal(decodePendingMint(tx({ blockHash }), map), null);
  assert.equal(decodePendingMint(tx({ blockNumber: '0x1' }), map), null);
  assert.equal(decodePendingMint(tx({ input: '0xdeadbeef' }), map), null);
  assert.equal(decodePendingMint(tx({ input: input + '00'.repeat(32) }), map), null);
  assert.equal(decodePendingMint(tx({ input: input + '00'.repeat(5000) }), map), null);
  assert.equal(decodePendingMint(tx({ hash: [txHash] }), map), null);
});

test('arming pins full Corla inspection, excludes closed and unverifiable projects, fails on reorg', async () => {
  const header = { number: 100, hash: blockHash, timestamp: 1_799_999_999 };
  const provider = { getBlock: async n => {
    assert.ok(n === 'latest' || n === 100); return header;
  } };
  const inspect = async (rpc, target, block) => {
    assert.equal(rpc, provider);
    assert.equal(block, 100);
    if (target.mint === third.mint) throw new Error('not a registered contract');
    return { phase: target.mint === second.mint ? 2 : 1, fundingDeadline: BigInt(header.timestamp) + 10n,
      mintedLots: 4n, totalLots: 5n, pricePerLot: 5n };
  };
  const result = await armPendingTargets(provider, [target, second, third], { inspect });
  assert.equal(result.armBlock, 100);
  assert.deepEqual(result.targets, [target]);
  assert.deepEqual(result.excluded.map(item => item.reason), ['not_active_funding', 'verification_unavailable_or_failed']);
  await assert.rejects(armPendingTargets({ getBlock: async n => n === 'latest' ? header : { ...header, hash: hashOf('ff') } },
    [target], { inspect: async () => ({ phase: 2 }) }), /不再是主链/);
  await assert.rejects(armPendingTargets(provider, [target, target], { inspect }), /不重复/);
});

test('exact hash lead uses the first pending and confirmed observations, not delayed verification', async () => {
  let now = 100;
  const observations = [];
  const tracker = makePendingMintShadow({ targets: [target], armBlock: 100, clock: () => now,
    pendingStatus: () => ({ healthy: true, mode: 'full' }),
    provider: { getBlock: async number => ({ number, hash: blockHash }) },
    verify: async () => { now += 20; return true; }, onObservation: row => observations.push(row),
  });
  assert.equal(tracker.observePending(tx()), true);
  now = 120;
  tracker.observePending(tx()); // duplicate must not overwrite first arrival
  now = 230;
  await tracker.onCandidate(launch());
  await tracker.onCandidate(launch({ source: 'http' })); // confirmation dedupe
  const summary = await tracker.summarize();
  assert.equal(observations.length, 1);
  assert.equal(summary.canonicalLaunches, 1);
  assert.equal(summary.canonicalLaunchesDuringHealthyFullFeed, 1);
  assert.equal(summary.matchesDuringHealthyFullFeed, 1);
  assert.equal(summary.launches[0].leadMs, 130);
  assert.equal(summary.launches[0].confirmedSource, 'ws');
});

test('pending after first confirmed arrival never changes a miss during receipt retries', async () => {
  let now = 100, canVerify = false;
  const tracker = makePendingMintShadow({ targets: [target], armBlock: 100, clock: () => now,
    pendingStatus: () => ({ mode: 'hash_only', healthy: false }),
    provider: { getBlock: async number => ({ number, hash: blockHash }) }, verify: async () => canVerify,
  });
  tracker.observePending(tx({ hash: hashOf('ba') })); // different mint tx same project
  now = 140;
  assert.equal(await tracker.onCandidate(launch()), false);
  now = 180;
  tracker.observePending(tx());
  canVerify = true;
  await tracker.onCandidate(launch({ source: 'http' }));
  const summary = await tracker.summarize();
  assert.equal(summary.canonicalLaunches, 1);
  assert.equal(summary.unmatchedCanonicalLaunches, 1);
  assert.equal(summary.canonicalLaunchesDuringHealthyFullFeed, 0);
  assert.equal(summary.launches[0].leadMs, null);
  assert.equal(summary.launches[0].pendingMode, 'hash_only');
});

test('misses cannot be inferred from pre-arm logs, stale pending, unverifiable receipts or reorgs', async () => {
  let now = 100, canonical = blockHash, available = true;
  const tracker = makePendingMintShadow({ targets: [target], armBlock: 100, clock: () => now,
    provider: { getBlock: async number => available ? { number, hash: canonical } : null }, verify: async () => true,
  });
  tracker.observePending(tx());
  await tracker.onCandidate(launch({ blockNumber: 100 }));
  now += 121_000;
  await tracker.onCandidate(launch());
  assert.equal((await tracker.summarize()).launches[0].leadMs, null);
  canonical = hashOf('ef');
  const reorg = await tracker.summarize();
  assert.equal(reorg.canonicalLaunches, 0);
  assert.equal(reorg.displacedOrRemoved, 1);
  available = false;
  assert.equal((await tracker.summarize()).noProofAtEnd, 1);
  tracker.onRemoved(launch());
  assert.equal((await tracker.summarize()).displacedOrRemoved, 1);
});

function sockets({ chain = '0x38', reject = false } = {}) {
  const instances = [], requests = [];
  class WebSocket extends EventTarget {
    constructor() {
      super();
      instances.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      const req = JSON.parse(text);
      requests.push(req);
      if (req.method === 'eth_chainId') queueMicrotask(() => this.frame({ id: req.id, result: chain }));
      if (req.method === 'eth_subscribe') queueMicrotask(() => this.frame(reject ? { id: req.id, error: { code: -32602 } } :
        { id: req.id, result: '0xabc' }));
    }
    frame(packet) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(packet) }));
    }
    push(result, subscription = '0xabc') {
      this.frame({ method: 'eth_subscription', params: { subscription, result } });
    }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  return { WebSocket, instances, requests };
}

test('full-object WebSocket negotiates BSC, reports hash-only or mixed without any hash lookups, stops on abort', async t => {
  const { WebSocket, instances, requests } = sockets();
  const stop = new AbortController();
  const observed = [], status = [];
  let now = 100;
  const feed = makePendingTransactionFeed({ wsUrl: 'wss://example.invalid/credentials', signal: stop.signal,
    services: { WebSocket, clock: () => now, maxPerSecond: 4 },
    onTransaction: row => observed.push(row.hash), onStatus: row => status.push(row.mode) });
  t.after(() => feed.close());
  feed.start();
  await nextTick();
  assert.deepEqual(requests.map(({ method, params }) => [method, params]), [
    ['eth_chainId', []], ['eth_subscribe', ['newPendingTransactions', true]],
  ]);
  assert.equal(feed.status().mode, 'subscribed_no_payload');
  now += 1000;
  instances[0].push(txHash);
  assert.equal(feed.status().mode, 'hash_only');
  assert.equal(feed.status().healthy, false);
  instances[0].push(tx(), '0xwrong');
  instances[0].push(tx());
  assert.equal(feed.status().mode, 'mixed');
  instances[0].push(tx({ hash: hashOf('da') }));
  instances[0].push(tx({ hash: hashOf('db') })); // over local processing cap
  assert.deepEqual(observed, [txHash, hashOf('da')]);
  assert.equal(feed.status().droppedMessages, 1);
  stop.abort();
  assert.equal(instances[0].closed, true);
  instances[0].push(tx());
  assert.equal(observed.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(status).includes('credentials'), false);
});

test('unsupported pending feed or wrong chain is explicitly excluded, not counted as 0% coverage', async () => {
  for (const item of [
    { opts: { reject: true }, mode: 'unsupported', methods: 2 },
    { opts: { chain: '0x1' }, mode: 'chain_unverified', methods: 1 },
  ]) {
    const { WebSocket, instances, requests } = sockets(item.opts);
    const feed = makePendingTransactionFeed({ wsUrl: 'ws://127.0.0.1:8546', onTransaction: () => assert.fail(), services: { WebSocket } });
    try {
      feed.start();
      await nextTick();
      assert.equal(feed.status().mode, item.mode);
      assert.equal(feed.status().healthy, false);
      assert.equal(requests.length, item.methods);
      assert.equal(instances[0].closed, true);
    } finally { feed.close(); }
  }
  assert.throws(() => pendingWsUrl('ws://example.invalid/credential'), { message: '待打包订阅需要 wss:// 或本机 ws:// 地址' });
});
