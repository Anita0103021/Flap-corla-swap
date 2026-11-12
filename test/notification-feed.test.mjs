import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroHash, getAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { createNotificationFeed } from '../src/notification-feed.mjs';

const START = 1_790_000_000;
const address = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const wallet = address(9_999_999);
const burstOnly = { burst: true };
const whitelistOnly = { whitelist: true };
const registryAbi = new Interface([
  'function deploymentCount() view returns(uint256)',
  'function getDeployments(uint256 offset,uint256 limit) view returns((address mint,address creator,address token,bytes32,bytes32,bytes32,uint256 createdAt,uint256 fundingDeadline,uint256 totalLots,uint256 pricePerLot)[])',
]);

function row(n, { created = 0, deadline = 1000, total = 6n, whitelist = false } = {}) {
  return { mint: address(n), token: address(n + 100_000), creator: wallet, factory: FACTORY,
    createdAt: START + created, fundingDeadline: START + deadline, totalLots: total, whitelist };
}
function fixture({ tip = 100, projects = [row(1)], clock = n => START + n, rawRegistry = false } = {}) {
  let current = tip, fail, id = 0;
  const logs = [], created = [], queries = [], registry = [], changes = new Map();
  function header(n) { return { number: n, timestamp: clock(n), hash: changes.get(n) ?? hash(n + 1000) }; }
  const entries = block => projects.filter(project => project.createdAt <= clock(block));
  const readDeployments = (_provider, n, offset, count) => {
    registry.push({ n, offset, count });
    return entries(n).slice(offset, offset + count);
  };
  const provider = {
    async getBlock(tag) { return header(tag === 'latest' ? current : tag); },
    async call({ to, data, blockTag }) {
      assert.equal(rawRegistry, true);
      assert.equal(to, FACTORY);
      const req = registryAbi.parseTransaction({ data });
      if (req.name === 'deploymentCount') return registryAbi.encodeFunctionResult(req.name, [entries(blockTag).length]);
      const rows = readDeployments(this, blockTag, ...Array.from(req.args, Number));
      return registryAbi.encodeFunctionResult(req.name, [rows.map(p => [
        p.mint, p.creator, p.token, ZeroHash, ZeroHash, ZeroHash, p.createdAt, p.fundingDeadline, p.totalLots, 1n,
      ])]);
    },
    async getLogs({ address: addresses, topics, fromBlock, toBlock }) {
      assert.ok(addresses.length && addresses.length <= 8, 'queries must fit the public endpoint address cap');
      assert.deepEqual(topics, [CORLA_ABI.getEvent('Minted').topicHash]);
      queries.push({ fromBlock, toBlock, addresses });
      const failed = fail?.(addresses, fromBlock, toBlock);
      if (failed) throw failed;
      return logs.filter(log => addresses.includes(log.address) && log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
  };
  const poll = createNotificationFeed({ provider, services: {
    ...(!rawRegistry ? { readDeploymentCount: (_provider, n) => entries(n).length, readDeployments } : {}),
    discoverProjects(_provider, from, to) { return created.filter(project => project.blockNumber >= from && project.blockNumber <= to); },
    readDashboardProjects(_provider, candidates, n) {
      return new Map(candidates.map(project => [project.mint.toLowerCase(), {
        blockNumber: n, whitelistEnabled: project.whitelist, whitelistDeadline: BigInt(project.createdAt + 3600),
      }]));
    },
  } });
  return {
    poll: (enabled = burstOnly, signal) => poll({ enabled, signal }),
    move: n => { current = n; },
    fail: predicate => { fail = predicate; },
    reorg: (n, newHash = hash(9_000 + n)) => { changes.set(n, newHash); },
    queries, registry, projects, logs,
    mint(project, n, count, override = {}) {
      const event = CORLA_ABI.encodeEventLog(CORLA_ABI.getEvent('Minted'), [wallet, count]);
      const log = { address: project.mint, blockNumber: n, blockHash: header(n).hash, index: id,
        transactionHash: hash(++id + 10_000), ...event, ...override };
      logs.push(log);
      return log;
    },
    create(project, n) {
      projects.push(project);
      created.push({ ...project, blockNumber: n, blockHash: header(n).hash });
    },
  };
}

test('whitelist only alerts new whitelist deployments, independent of any burst or board page', async () => {
  const f = fixture({ projects: [] });
  f.create(row(1, { created: 90, whitelist: true }), 90);
  assert.deepEqual((await f.poll(whitelistOnly)).events, []);
  const wanted = row(2, { created: 101, whitelist: true });
  f.create(wanted, 101);
  f.create(row(3, { created: 102 }), 102);
  f.move(102);
  const { events } = await f.poll(whitelistOnly);
  assert.deepEqual(events.map(e => [e.kind, e.token, e.at, e.whitelistDeadline]),
    [['whitelist', wanted.token, START + 101, START + 3701]]);
  assert.equal(new URL(events[0].url).searchParams.get('mint'), wanted.mint);
  assert.deepEqual((await f.poll(whitelistOnly)).events, []);
  assert.equal(f.queries.length, 0);
});

test('enabling whitelist after a disabled period takes a new baseline and has no historical alert', async () => {
  const f = fixture();
  await f.poll({ whitelist: true, burst: true });
  await f.poll(burstOnly);
  f.create(row(2, { created: 101, whitelist: true }), 101);
  f.move(102);
  assert.deepEqual((await f.poll({ whitelist: true, burst: true })).events, []);
  f.create(row(3, { created: 103, whitelist: true }), 103);
  f.move(103);
  assert.equal((await f.poll(whitelistOnly)).events[0].mint, row(3).mint);
});

test('strict greater-than one third triggers on the crossing block without waiting and includes exact 60-second boundary', async () => {
  const project = row(1, { total: 6n });
  const f = fixture({ tip: 119, projects: [project], rawRegistry: true });
  f.mint(project, 60, 1n);
  f.mint(project, 119, 2n);
  assert.deepEqual((await f.poll()).events, []);
  f.mint(project, 120, 3n);
  f.move(120);
  const { events } = await f.poll();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].kind, events[0].mintedLots, events[0].totalLots, events[0].windowSeconds, events[0].at],
    ['burst', '3', '6', 60, START + 120]);
  assert.match(events[0].id, /^burst:/);
  assert.deepEqual((await f.poll()).events, []);
});

test('counts one lot per unique Minted event, not the cumulative field, and drops events older than 60 seconds', async () => {
  const project = row(1, { total: 9n });
  const f = fixture({ projects: [project] });
  f.mint(project, 40, 4n); // Will be 61 seconds old at the next event.
  const dup = f.mint(project, 100, 5n);
  f.logs.push(dup);
  assert.deepEqual((await f.poll()).events, []);
  f.mint(project, 101, 6n);
  f.mint(project, 101, 7n);
  f.move(101);
  assert.deepEqual((await f.poll()).events, [], 'exactly 3/9 is not anomalous');
  f.mint(project, 102, 8n);
  f.move(102);
  const events = (await f.poll()).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].mintedLots, '4');
  f.mint(project, 103, 9n);
  f.move(103);
  assert.deepEqual((await f.poll()).events, [], 'remaining above threshold is not a new crossing');
});

test('does not prune history before an earlier crossing within a multi-block catch-up wave', async () => {
  const project = row(1);
  const f = fixture({ projects: [project] });
  f.mint(project, 100, 1n);
  await f.poll();
  f.mint(project, 130, 2n);
  f.mint(project, 140, 3n);
  f.move(165);
  assert.equal((await f.poll()).events[0].at, START + 140);
});

test('registry pagination is bounded and never omits an old still-active project or alerts on partial groups', async () => {
  const projects = Array.from({ length: 840 }, (_, i) => row(i + 1, { deadline: i >= 1 && i <= 770 ? 10 : 1000 }));
  const old = projects[0], newest = projects.at(-1);
  const f = fixture({ projects });
  f.mint(old, 99, 1n);
  f.mint(old, 100, 2n);
  const first = await f.poll();
  assert.equal(first.status, 'syncing');
  assert.equal(f.registry.length, 8);
  assert.equal(f.queries.length, 0);
  f.mint(old, 101, 3n);
  f.move(101);
  const second = await f.poll();
  assert.equal(second.status, 'syncing');
  assert.deepEqual(second.events, []);
  assert.equal(f.registry.at(-1).offset, 800);
  assert.equal(f.queries.length, 8);
  const third = await f.poll();
  assert.equal(third.status, 'monitoring');
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].mint, old.mint);
  assert.ok(f.queries.some(query => query.addresses.includes(newest.mint)));
});

test('falls back on explicit range limits but not rate limiting; does not advance until every query succeeds', async () => {
  const f = fixture();
  let before = f.queries.length;
  f.fail(() => Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 }));
  assert.equal((await f.poll()).status, 'degraded');
  assert.equal(f.queries.length - before, 1);
  before = f.queries.length;
  f.fail((_addresses, from, to) => to - from >= 31 && new Error('maximum block range exceeded'));
  const recovered = await f.poll();
  assert.equal(recovered.status, 'monitoring');
  assert.ok(f.queries.length - before > 1);
});

test('does not notify with orphaned Minted logs and handles a reorg without duplicate canonical alert', async () => {
  const project = row(1);
  const f = fixture({ projects: [project] });
  f.mint(project, 99, 1n);
  f.mint(project, 100, 2n);
  await f.poll();
  const log = f.mint(project, 101, 3n);
  f.move(101);
  f.reorg(101);
  const unverified = await f.poll();
  assert.equal(unverified.status, 'degraded');
  assert.deepEqual(unverified.events, []);
  f.reorg(101, log.blockHash);
  assert.equal((await f.poll()).events.length, 1);
  f.reorg(101, hash(200_000));
  log.blockHash = hash(200_000);
  assert.deepEqual((await f.poll()).events, [], 'same mint/tx/log inclusion cannot notify twice');
});

test('timestamp-based warm lookback covers over 130 recent BSC blocks and abort prevents a scan', async () => {
  const project = { ...row(1), createdAt: START, fundingDeadline: START + 1000 };
  const f = fixture({ projects: [project], tip: 400, clock: n => START + Math.floor(n * 0.45) });
  f.mint(project, 267, 1n);
  f.mint(project, 395, 2n);
  await f.poll();
  assert.ok(f.queries[0].fromBlock <= 267);
  f.mint(project, 401, 3n);
  f.move(401);
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => f.poll(burstOnly, c.signal), { name: 'AbortError' });
  assert.equal((await f.poll()).events[0].mintedLots, '3');
});
