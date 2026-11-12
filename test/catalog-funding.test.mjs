import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, zeroPadValue } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { CORLA_LAUNCH_TOPIC } from '../src/events.mjs';
import { readCatalogFundingTimes } from '../src/catalog-funding.mjs';

const MINTED = CORLA_ABI.getEvent('Minted').topicHash;
const date = 1_794_400_000;
const time = n => date + Math.floor(n / 2);
const word = n => '0x' + n.toString(16).padStart(64, '0');
const address = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
const wallet = address(0xdef);
function row(index, { from = 18_000, deadline = 24000, top = 20000, launched = true, minted = 100n } = {}) {
  const mint = address(100 + index);
  const token = address(200 + index);
  const pool = address(300 + index);
  return { project: { factory: FACTORY, mint, token, totalLots: 100n, createdAt: time(from), fundingDeadline: time(deadline) },
    snapshot: { mint, token, pool, block: top, totalLots: 100n, mintedLots: minted, launched } };
}
function event(project, height, nonce, { launch = false, value = 100n } = {}) {
  const { mint, token, pool } = project.snapshot;
  const encoded = launch ? CORLA_ABI.encodeEventLog('Launched', [token, pool, wallet]) :
    CORLA_ABI.encodeEventLog('Minted', [wallet, value]);
  return { ...encoded, address: mint, blockNumber: height, blockHash: word(height), transactionHash: word(nonce), removed: false };
}
function fixture({ head = 20_020, events = [], receipt = {}, blocks = {}, limit = Infinity, error } = {}) {
  const calls = { logs: [], receipt: [], block: [] };
  const network = {
    async getBlock(n) {
      calls.block.push(n);
      const block = n === 'latest' ? head : n;
      return { number: block, hash: word(block), timestamp: time(block), ...blocks[block] };
    },
    async getLogs(f) {
      calls.logs.push(f);
      if (error) throw error;
      if (f.toBlock - f.fromBlock + 1 > limit) throw new Error('exceed maximum block range: ' + limit);
      return events.filter(e => f.address.includes(e.address) && e.topics[0] === f.topics[0] &&
        (!f.topics[1] || f.topics[1].includes(e.topics[1])) && e.blockNumber >= f.fromBlock && e.blockNumber <= f.toBlock);
    },
    async getTransactionReceipt(hash) {
      calls.receipt.push(hash);
      const logs = events.filter(e => e.transactionHash === hash);
      assert.ok(logs.length);
      const [log] = logs;
      return { status: 1, hash, blockNumber: log.blockNumber, blockHash: log.blockHash, logs, ...receipt[hash] };
    },
  };
  return { network, calls, moveHead: value => { head = value; } };
}
const expected = (r, at) => ({ mint: r.project.mint, token: r.project.token,
  filledAt: time(at), blockNumber: at, blockHash: word(at) });

test('coalesces recent launched projects and returns exact block time only for a final Minted in the launch receipt', async () => {
  const [r1, r2, r3] = [row(1), row(2), row(3, { minted: 9n })];
  const events = [
    event(r1, 18201, 1, { value: 99n }),
    event(r1, 18304, 2),
    event(r1, 18304, 2, { launch: true }),
    event(r2, 18552, 3),
    event(r2, 18552, 3, { launch: true }),
  ];
  const { network, calls } = fixture({ events });
  assert.deepEqual(await readCatalogFundingTimes(network, [r1, r2, r3]), [expected(r1, 18304), expected(r2, 18552)]);
  assert.equal(calls.logs.length, 1);
  assert.deepEqual(calls.logs[0].topics, [CORLA_LAUNCH_TOPIC, [r1, r2].map(r => zeroPadValue(r.project.token, 32))]);
  assert.deepEqual(calls.receipt, [word(2), word(3)]);
  assert.equal(time(18304) - r1.project.createdAt, 152);
});

test('supports full-not-launched, waits out the stable-head margin, and resumes from its safe scan cursor', async () => {
  const project = row(4, { launched: false, from: 19500, top: 20019 });
  const { network, calls, moveHead } = fixture({ events: [event(project, 20019, 11)] });
  assert.deepEqual(await readCatalogFundingTimes(network, [project]), []);
  assert.equal(calls.logs.at(-1).toBlock, 20_012);
  moveHead(20_034);
  assert.deepEqual(await readCatalogFundingTimes(network, [project]), [expected(project, 20019)]);
  assert.equal(calls.logs.at(-1).fromBlock, 20_013);
  assert.deepEqual(calls.logs.at(-1).topics, [MINTED]);
});

test('can prove a separate final mint when the launch transaction did not contain it', async () => {
  const project = row(5);
  const { network, calls } = fixture({ events: [
    event(project, 19001, 9, { value: 99n }), event(project, 19003, 10), event(project, 19201, 11, { launch: true }),
  ] });
  assert.deepEqual(await readCatalogFundingTimes(network, [project]), []);
  assert.deepEqual(await readCatalogFundingTimes(network, [project]), [expected(project, 19003)]);
  assert.deepEqual(calls.receipt, [word(11), word(10)]);
});

test('rejects noncanonical, out-of-window, removed or reverted fill evidence', async () => {
  const [reorg, expired, removed, reverted] = [row(6), row(7, { deadline: 18200 }), row(8), row(9)];
  const events = [
    event(reorg, 19100, 17), event(reorg, 19100, 17, { launch: true }),
    event(expired, 18300, 18), event(expired, 18300, 18, { launch: true }),
    { ...event(removed, 19300, 19), removed: true }, event(removed, 19300, 19, { launch: true }),
    event(reverted, 19400, 20), event(reverted, 19400, 20, { launch: true }),
  ];
  const { network } = fixture({ events, blocks: { 19100: { hash: word(0xff) } }, receipt: { [word(20)]: { status: 0 } } });
  assert.deepEqual(await readCatalogFundingTimes(network, [reorg, expired, removed, reverted]), []);
});

test('retries bounded explicit range limits without rescanning completed windows or amplifying 429', async () => {
  const project = row(10, { from: 100, top: 19_000, launched: false });
  const { network, calls } = fixture({ limit: 5000, events: [event(project, 18_777, 12)] });
  assert.deepEqual(await readCatalogFundingTimes(network, [project], { maxLogQueries: 2 }), []);
  const through = calls.logs.at(-1).toBlock;
  assert.ok(through > 100 && through < 6000);
  assert.deepEqual(await readCatalogFundingTimes(network, [project]), [expected(project, 18_777)]);
  assert.equal(calls.logs[2].fromBlock, through + 1);
  const rate = fixture({ error: Object.assign(new Error('block range: rate limit'), { status: 429 }) });
  assert.deepEqual(await readCatalogFundingTimes(rate.network, [project]), []);
  assert.equal(rate.calls.logs.length, 1);
});

test('ignores non-registry and inconsistent snapshots before RPC and aborts cleanly', async () => {
  const project = row(11);
  const { network, calls } = fixture();
  const invalid = [
    null,
    { ...project, project: { ...project.project, factory: address(1) } },
    { ...project, snapshot: { ...project.snapshot, totalLots: 101n } },
    { ...project, snapshot: { ...project.snapshot, token: address(1) } },
    { ...project, snapshot: { ...project.snapshot, block: 'latest' } },
  ];
  assert.deepEqual(await readCatalogFundingTimes(network, invalid), []);
  assert.deepEqual(calls.block, []);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readCatalogFundingTimes(network, [project], { signal: abort.signal }), { name: 'AbortError' });
});

test('splits successful oversized log arrays and retains the reduced range across budget-limited rounds', async () => {
  const project = row(12, { from: 10_000, top: 16_000, launched: false });
  const partial = event(project, 10_001, 100, { value: 99n });
  const events = Array.from({ length: 4200 }, (_, i) => ({ ...partial, blockNumber: 10_001 + i, blockHash: word(10_001 + i) }));
  events.push(event(project, 14_201, 200));
  const { network, calls } = fixture({ events });
  assert.deepEqual(await readCatalogFundingTimes(network, [project], { maxLogQueries: 1 }), []);
  const first = calls.logs[0];
  assert.deepEqual(await readCatalogFundingTimes(network, [project], { maxLogQueries: 1 }), []);
  assert.equal(calls.logs[1].fromBlock, first.fromBlock);
  assert.ok(calls.logs[1].toBlock < first.toBlock);
  assert.deepEqual(await readCatalogFundingTimes(network, [project], { maxLogQueries: 2 }), [expected(project, 14_201)]);
  assert.equal(calls.logs[2].fromBlock, calls.logs[1].toBlock + 1);
});

test('splits by address when one dense block is still too large', async () => {
  const projects = [row(13, { from: 1, top: 1, launched: false }), row(14, { from: 1, top: 1, launched: false })];
  const events = projects.flatMap((project, i) => [
    ...Array(2100).fill(event(project, 1, 100 + i, { value: 99n })),
    event(project, 1, 200 + i),
  ]);
  const { network, calls } = fixture({ events });
  assert.deepEqual(await readCatalogFundingTimes(network, projects), projects.map(project => expected(project, 1)));
  assert.ok(calls.logs.some(call => call.fromBlock === 1 && call.toBlock === 1 && call.address.length === 2));
  assert.deepEqual(calls.logs.slice(-2).map(call => call.address.length), [1, 1]);
});

test('uses independent fast block and receipt reads and publishes verified partial hits', async () => {
  const r = row(12);
  const events = [event(r, 18400, 20), event(r, 18400, 20, { launch: true })];
  const logs = fixture({ events });
  const blocks = fixture({ events });
  const published = [];
  const result = await readCatalogFundingTimes(logs.network, [r], {
    blockProvider: blocks.network, onResult: x => published.push(x),
  });
  assert.deepEqual(result, [expected(r, 18400)]);
  assert.deepEqual(published, result);
  assert.equal(logs.calls.logs.length, 1);
  assert.deepEqual(logs.calls.block, []);
  assert.deepEqual(logs.calls.receipt, []);
  assert.deepEqual(blocks.calls.receipt, [word(20)]);
  assert.ok(blocks.calls.block.includes(18400));
});
