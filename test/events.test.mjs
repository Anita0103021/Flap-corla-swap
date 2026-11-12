import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, ZeroAddress, id, zeroPadValue } from 'ethers';
import { FACTORY, parseMintLink } from '../src/config.mjs';
import { CORLA_CREATED_TOPIC, CORLA_LAUNCH_TOPIC, DIRECT_LAUNCH_PORTAL, decodeLaunchCandidate,
  discoverProjects, findLaunch, readLaunchCandidates, verifyLaunchCandidate } from '../src/events.mjs';
import { PANCAKE_FACTORY, WBNB } from '../src/market.mjs';

const target = {
  factory: FACTORY,
  mint: '0x4bdd60107d9a1da95e03be6b6e972fa57ea62fd3',
  token: '0x9b540b85d7dc7f3db4fbb7cebc45fb2214667777',
};
const pool = '0x31ad8087936d753c90128064e5341c880dc35a34';
const caller = '0xc9916620557cf3e705052801df75f6cee113a899';
const blockNumber = 133078952;
const blockHash = '0x' + '12'.repeat(32);
const txHash = '0x59b184bd258a6bf84c99acce7310018e651d74dcefa08f5b549f5a34f402def1';
const launchLog = {
  blockHash, blockNumber, address: target.mint, transactionHash: txHash, data: '0x',
  topics: [CORLA_LAUNCH_TOPIC, ...[target.token, pool, caller].map(addr => zeroPadValue(addr, 32))],
};
const portal = new Interface(['event FlapDirectLaunched(address,uint8,address,bytes32,bytes)']);
const pair = new Interface(['event Mint(address indexed sender,uint256,uint256)', 'event Sync(uint112,uint112)']);
const v2Factory = new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)']);
const state = { launched: true, pool };

function portalLog(portalPool = pool, quoteToken = ZeroAddress, schema = id('DirectLaunchV2(DirectLaunchV2Data)'), token = target.token) {
  const data = AbiCoder.defaultAbiCoder().encode(
    ['tuple(uint256,uint256,uint8,address,uint8,uint256,string,string,string,address,uint256,uint8,uint16)'],
    [[206n, 1794458112n, 0, quoteToken, 1, 1n, 'Token', 'Token', 'ipfs://sample', portalPool, 1000n, 0, 0]],
  );
  return { address: DIRECT_LAUNCH_PORTAL, ...portal.encodeEventLog('FlapDirectLaunched', [token, 0, caller, schema, data]) };
}
function pairLog(sender = DIRECT_LAUNCH_PORTAL, balance = 5n) {
  return { address: pool, ...pair.encodeEventLog('Mint', [sender, 50n, balance]) };
}
function openingLogs(token = target.token) {
  const wbnbFirst = WBNB.toLowerCase() < token.toLowerCase();
  const [token0, token1] = wbnbFirst ? [WBNB, token] : [token, WBNB];
  const amounts = wbnbFirst ? [5n, 50n] : [50n, 5n];
  const evidence = [
    { index: 37, address: PANCAKE_FACTORY, ...v2Factory.encodeEventLog('PairCreated', [token0, token1, pool, 9n]) },
    { index: 48, address: pool, ...pair.encodeEventLog('Sync', amounts) },
    { index: 49, address: pool, ...pair.encodeEventLog('Mint', [DIRECT_LAUNCH_PORTAL, ...amounts]) },
    { index: 51, ...portalLog(pool, ZeroAddress, undefined, token) },
    { index: 71, ...launchLog, topics: [CORLA_LAUNCH_TOPIC, ...[token, pool, caller].map(addr => zeroPadValue(addr, 32))] },
  ];
  return evidence.map(log => ({ blockHash, blockNumber, transactionHash: txHash, ...log }));
}
function receipt(overrides = {}) {
  return { status: 1, blockHash, blockNumber, hash: txHash, logs: [launchLog, portalLog(), pairLog()], ...overrides };
}
function provider(candidate = launchLog, details = receipt()) {
  return {
    async getLogs(filter) {
      assert.equal(filter.address, target.mint);
      assert.deepEqual(filter.topics, launchLog.topics.slice(0, 3));
      return candidate ? [candidate] : [];
    },
    async getTransactionReceipt(hash) {
      assert.equal(hash, txHash);
      return details;
    },
  };
}

test('requires the Corla mint log and matching Portal + seeded V2 LP receipt', async () => {
  const result = await findLaunch(provider(), target, state, blockNumber - 2, blockNumber);
  assert.equal(result.txHash, txHash);
  assert.equal(result.blockNumber, blockNumber);
  assert.equal(result.pool.toLowerCase(), pool);
  assert.equal(result.caller.toLowerCase(), caller);
});

test('returns verified opening reserves from the ordered factory, Sync and seed Mint receipt in both token orders', async () => {
  for (const token of [target.token, '0xff00000000000000000000000000000000007777']) {
    const current = { ...target, token };
    const logs = openingLogs(token);
    const candidate = decodeLaunchCandidate(current, logs.at(-1), blockNumber, blockNumber);
    const result = await verifyLaunchCandidate(provider(launchLog, receipt({ logs })), candidate);
    assert.deepEqual(result?.openingReserves, { reserveBnb: 5n, reserveToken: 50n });
  }
  const result = await findLaunch(provider(launchLog, receipt({ logs: openingLogs() })), target, state, blockNumber, blockNumber);
  assert.deepEqual(result?.openingReserves, { reserveBnb: 5n, reserveToken: 50n });
});

test('untrusted, ambiguous or inconsistent opening evidence never supplies reserves but does not alter the legacy proof', async () => {
  const [created, sync, mint, direct, launch] = openingLogs();
  const candidate = {
    ...decodeLaunchCandidate(target, launchLog, blockNumber, blockNumber),
    openingReserves: { reserveBnb: 1n, reserveToken: 1n },
  };
  for (const [reason, logs] of [
    ['missing Sync', [created, mint, direct, launch]],
    ['missing factory', [sync, mint, direct, launch]],
    ['forged factory', [{ ...created, address: caller }, sync, mint, direct, launch]],
    ['wrong factory pair', [{ ...created,
      ...v2Factory.encodeEventLog('PairCreated', [target.token, WBNB, caller, 9n]) }, sync, mint, direct, launch]],
    ['wrong token order', [{ ...created,
      ...v2Factory.encodeEventLog('PairCreated', [WBNB, target.token, pool, 9n]) }, sync, mint, direct, launch]],
    ['duplicate factory', [created, created, sync, mint, direct, launch]],
    ['duplicate Sync', [created, sync, mint, sync, direct, launch]],
    ['duplicate Mint', [created, sync, mint, mint, direct, launch]],
    ['duplicate Portal', [created, sync, mint, direct, direct, launch]],
    ['duplicate launch', [created, sync, mint, direct, launch, launch]],
    ['wrong receipt metadata', [created, { ...sync, blockHash: '0x' + 'ff'.repeat(32) }, mint, direct, launch]],
    ['removed Sync', [created, { ...sync, removed: true }, mint, direct, launch]],
    ['unseeded excess reserves', [created, { ...sync, ...pair.encodeEventLog('Sync', [51n, 5n]) }, mint, direct, launch]],
    ['trailing Sync data', [created, { ...sync, data: sync.data + '00' }, mint, direct, launch]],
    ['missing log index', [created, { ...sync, index: undefined }, mint, direct, launch]],
    ['incorrect log index', [created, sync, { ...mint, index: 50 }, direct, launch]],
    ['Sync after Mint', [created, mint, sync, direct, launch]],
    ['Portal before seed', [created, direct, sync, mint, launch]],
    ['unrelated intervening event', [created, sync, { address: caller }, mint, direct, launch]],
  ]) {
    const result = await verifyLaunchCandidate(provider(launchLog, receipt({ logs })), candidate);
    assert.ok(result, reason);
    assert.equal(Object.hasOwn(result, 'openingReserves'), false, reason);
  }
});

test('never treats a filled or already launched project as a fresh launch without log evidence', async () => {
  assert.equal(await findLaunch({}, target, { launched: false, pool }, blockNumber - 1, blockNumber), null);
  assert.equal(await findLaunch(provider(null), target, state, blockNumber + 1, blockNumber + 2), null);
  assert.equal(await findLaunch(provider({ ...launchLog, removed: true }), target, state, blockNumber, blockNumber), null);
  assert.equal(await findLaunch(provider(launchLog, receipt({ blockHash: '0x' + '34'.repeat(32) })), target, state, blockNumber, blockNumber), null);
  assert.equal(await findLaunch(provider(launchLog, receipt({ status: 0 })), target, state, blockNumber, blockNumber), null);
});

test('rejects a mismatched pool, non-native quote, invalid schema, or unseeded pair', async () => {
  const wrongPool = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
  for (const logs of [
    [launchLog, portalLog(wrongPool), pairLog()],
    [launchLog, portalLog(pool, wrongPool), pairLog()],
    [launchLog, portalLog(pool, ZeroAddress, blockHash), pairLog()],
    [launchLog, portalLog(), pairLog(DIRECT_LAUNCH_PORTAL, 0n)],
    [launchLog, portalLog(), pairLog(caller)],
    [launchLog, portalLog()],
    [portalLog(), pairLog()],
  ]) {
    assert.equal(await findLaunch(provider(launchLog, receipt({ logs })), target, state, blockNumber, blockNumber), null);
  }
});

test('scans a combined allowlist without cross-matching the token of another mint', async () => {
  const other = { factory: FACTORY, mint: '0x4724ce75d772eda774147f6198f1a876811d6e19',
    token: '0xc402b65aa0a6ef7562a1580fd778397d6e817777' };
  const fake = {
    async getLogs({ address, topics, fromBlock, toBlock }) {
      assert.deepEqual(address.map(a => a.toLowerCase()), [target.mint, other.mint]);
      assert.deepEqual(topics.map(t => Array.isArray(t) ? t.map(x => x.toLowerCase()) : t),
        [CORLA_LAUNCH_TOPIC, [target.token, other.token].map(a => zeroPadValue(a, 32))]);
      assert.deepEqual([fromBlock, toBlock], [blockNumber - 1, blockNumber]);
      return [launchLog, { ...launchLog, address: other.mint }, { ...launchLog, removed: true },
        { ...launchLog, blockNumber: blockNumber + 1 }];
    },
  };
  const matches = await readLaunchCandidates(fake, [target, other], blockNumber - 1, blockNumber);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].target, target);
  assert.equal(matches[0].txHash, txHash);
});

test('an RPC throttle does not recursively amplify a log query', async () => {
  let calls = 0;
  const error = Object.assign(new Error('rate limit exceeded'), { info: { error: { code: -32005 } } });
  const fake = { async getLogs() { calls++; throw error; } };
  await assert.rejects(readLaunchCandidates(fake, [target], blockNumber - 5, blockNumber), { message: 'rate limit exceeded' });
  assert.equal(calls, 1);
});

test('fast WebSocket log parser accepts hex heights but receipt verification is independent', async () => {
  const raw = { ...launchLog, blockNumber: '0x' + blockNumber.toString(16) };
  const candidate = decodeLaunchCandidate(target, raw, blockNumber, blockNumber);
  assert.equal(candidate.blockNumber, blockNumber);
  assert.equal(candidate.token.toLowerCase(), target.token);
  assert.equal(decodeLaunchCandidate(target, { ...raw, removed: 'true' }, blockNumber, blockNumber), null);
  const removed = decodeLaunchCandidate(target, { ...raw, removed: true }, blockNumber, blockNumber, { allowRemoved: true });
  assert.equal(removed.removed, true);
  assert.equal(await verifyLaunchCandidate({}, removed), null);
  assert.equal(await verifyLaunchCandidate(provider(launchLog, null), candidate), null);
  assert.equal(await verifyLaunchCandidate(provider(launchLog, receipt({ logs: [launchLog, pairLog()] })), candidate), null);
  assert.equal((await verifyLaunchCandidate(provider(), { ...candidate, source: 'ws' })).source, 'ws');
});

test('discovery filters the pinned factory, handles provider range limits, and returns usable Corla URLs', async () => {
  const sample = {
    mint: '0x4724ce75d772eda774147f6198f1a876811d6e19',
    creator: '0x869569fcd304f67afef8fadf47c3d700775344ae',
    token: '0xc402b65aa0a6ef7562a1580fd778397d6e817777',
  };
  const from = 133075574;
  const creation = {
    address: FACTORY, blockHash, blockNumber: from + 1,
    transactionHash: '0x26f1b6119a1633723ebe5c08129a97f67f8afb5eb886d6d9a26af71cef3d21f7',
    topics: [CORLA_CREATED_TOPIC, ...Object.values(sample).map(addr => zeroPadValue(addr, 32))],
  };
  let reads = 0;
  const mock = {
    async getLogs(filter) {
      reads++;
      assert.equal(filter.address, FACTORY);
      assert.deepEqual(filter.topics, [CORLA_CREATED_TOPIC]);
      if (filter.toBlock > filter.fromBlock) throw new Error('log query range must not exceed 1 blocks');
      if (filter.fromBlock === creation.blockNumber) return [creation, creation, { ...creation, address: pool }];
      return [];
    },
  };
  const projects = await discoverProjects(mock, from, from + 1);
  assert.equal(reads, 3);
  assert.equal(projects.length, 1);
  const [result] = projects;
  assert.equal(result.txHash, creation.transactionHash);
  assert.equal(result.creator.toLowerCase(), sample.creator);
  assert.deepEqual(parseMintLink(result.url), { factory: FACTORY, mint: result.mint, token: result.token });
  await assert.rejects(discoverProjects(mock, 0, 50000), /50000/);
});
