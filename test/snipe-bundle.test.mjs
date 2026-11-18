import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Transaction, Wallet, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI, CORLA_QUOTE_ABI } from '../src/corla.mjs';
import { ROUTER, ROUTER_ABI, WBNB } from '../src/market.mjs';
import { makeNodeRealBundleSubmitter } from '../src/snipe-bundle.mjs';
import { openSnipeBundleJournal } from '../src/snipe-bundle-journal.mjs';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// Random ephemeral keys are used only to produce deterministic-shape
// signatures in memory. All header and relay calls below are test doubles.
const minter = Wallet.createRandom();
const secondMinter = Wallet.createRandom();
const buyer = Wallet.createRandom();
const target = Object.freeze({ factory: FACTORY, mint: '0x' + '11'.repeat(20), token: '0x' + '22'.repeat(20), pricePerLot: 1_000n });
const parent = Object.freeze({ number: 42, hash: '0x' + 'de'.repeat(32), timestamp: 10_000 });
const deadline = parent.timestamp + 12;
const bundleHash = '0x' + 'ba'.repeat(32);
const quoteAsset = '0x' + '33'.repeat(20);
const deploymentKey = '0x' + '44'.repeat(32);
const quoteTarget = { ...target, quoteToken: quoteAsset, deploymentKey };
const buyMethod = 'swapExactETHForTokensSupportingFeeOnTransferTokens';
const quoteBuyMethod = 'swapExactTokensForTokensSupportingFeeOnTransferTokens';
const rpcOk = (packet, hash = bundleHash) => ({ jsonrpc: '2.0', id: packet.id, result: hash });
const rpcError = (packet, code, message) => ({ jsonrpc: '2.0', id: packet.id, error: { code, message } });
const sign = (key, tx) => key.signTransaction({ chainId: 56, type: 0, gasPrice: 80_000_000n, gasLimit: 500_000n, ...tx });
const hashOf = raw => Transaction.from(raw).hash;

async function fixture({ count = 1, quote = false, buyOverrides = {}, signer = buyer, mintOverrides = [] } = {}) {
  const buy = { to: ROUTER, value: quote ? 0n : 500n,
    data: quote ? ROUTER_ABI.encodeFunctionData(quoteBuyMethod, [500n, 121n, [quoteAsset, target.token], signer.address, deadline]) :
      ROUTER_ABI.encodeFunctionData(buyMethod, [121n, [WBNB, target.token], signer.address, deadline]),
    nonce: 30, ...buyOverrides };
  const mint = { to: quote ? FACTORY : target.mint, value: quote ? 0n : target.pricePerLot,
    data: quote ? CORLA_QUOTE_ABI.encodeFunctionData('mintQuote', [deploymentKey, []]) : CORLA_ABI.encodeFunctionData('mint', [[]]) };
  const mintRaws = await Promise.all(Array.from({ length: count }, (_, i) => {
    const { key = minter, ...override } = mintOverrides[i] ?? {};
    return sign(key, { ...mint, nonce: 44 + i, ...override });
  }));
  const buyRaw = await sign(signer, buy);
  return { mintRaws, buyRaw, expectedMintHashes: mintRaws.map(hashOf), expectedBuyHash: hashOf(buyRaw),
    parent, deadline, target: quote ? quoteTarget : target, expectedBuy: { ...buy, from: signer.address } };
}

const setup = ({ readLatestBlock = () => parent, respond = rpcOk, timeoutMs = 300, nowSeconds = () => parent.timestamp, ...options } = {}) => {
  const packets = [];
  let reads = 0;
  const submit = makeNodeRealBundleSubmitter({ timeoutMs, nowSeconds,
    readLatestBlock: ctx => { reads++; return readLatestBlock(ctx); },
    transport: (packet, ctx) => { packets.push(packet); return respond(packet, ctx); },
    ...options,
  });
  return { submit, packets, reads: () => reads };
};

function durableFixture(t) {
  const base = realpathSync(tmpdir()), directory = mkdtempSync(join(base, 'corla-bundle-adapter-'));
  const opened = [];
  t.after(() => {
    for (const journal of opened) journal.close();
    assert.equal(dirname(realpathSync(directory)), base);
    assert.match(basename(directory), /^corla-bundle-adapter-/);
    rmSync(directory, { recursive: true, force: true });
  });
  return { path: join(directory, 'bundle-intents.sqlite'), open() {
    const journal = openSnipeBundleJournal({ directory });
    opened.push(journal);
    return journal;
  } };
}

test('defaults to no read or outbound call; either missing dependency disables the adapter', async () => {
  const input = await fixture();
  const notCalled = () => assert.fail('disabled adapter touched a dependency');
  for (const opts of [undefined, { transport: notCalled }, { readLatestBlock: notCalled }]) {
    const outcome = await makeNodeRealBundleSubmitter(opts)(input);
    assert.deepEqual(outcome, { status: 'disabled', reason: 'transport_not_configured' });
  }
});

test('NodeReal request keeps exact signed 1–3 Mint raws then one buy and a strict single-slot upper bound', async () => {
  for (const count of [1, 2, 3]) {
    const input = await fixture({ count });
    const { submit, packets, reads } = setup({ respond: packet => rpcOk(packet) });
    const outcome = await submit(input);
    assert.equal(reads(), 1);
    assert.deepEqual(packets, [{ jsonrpc: '2.0', id: '1', method: 'eth_sendBundle', params: [{
      txs: [...input.mintRaws, input.buyRaw], maxBlockNumber: parent.number + 1, maxTimestamp: deadline,
      noMerge: true, revertingTxHashes: [],
    }] }]);
    assert.deepEqual(outcome, { status: 'accepted', reason: 'builder_ack', bundleHash,
      buyTxHash: input.expectedBuyHash, mintHashes: input.expectedMintHashes, parentBlock: parent.number,
      parentHash: parent.hash, targetBlock: parent.number + 1, maxTimestamp: deadline });
    assert(Object.isFrozen(packets[0].params[0].txs));
    assert(Object.isFrozen(outcome.mintHashes));
    assert(!JSON.stringify(outcome).includes(input.buyRaw));
  }
});

test('validates ERC-20 Mint factory key and exact Pancake buy, including type-2 Mint raws', async () => {
  const input = await fixture({ count: 2, quote: true, mintOverrides: [
    { type: 2, gasPrice: undefined, maxFeePerGas: 123n, maxPriorityFeePerGas: 120n }, { key: secondMinter, nonce: 7 },
  ] });
  const { submit, packets } = setup({ respond: packet => rpcOk(packet) });
  assert.equal((await submit(input)).status, 'accepted');
  assert.deepEqual(packets[0].params[0].txs, [...input.mintRaws, input.buyRaw]);
  const wrongKey = { ...input, target: { ...input.target, deploymentKey: '0x' + '55'.repeat(32) } };
  assert.deepEqual(await submit(wrongKey), { status: 'refused', reason: 'invalid_input' });
  const wrongQuote = { ...input, target: { ...input.target, quoteToken: ZeroAddress } };
  assert.deepEqual(await submit(wrongQuote), { status: 'refused', reason: 'invalid_input' });
});

test('rejects bad hashes, order, raw envelopes, wrong network, duplicated/gapped Mint or buyer-sender collision locally', async () => {
  const input = await fixture({ count: 2 });
  const [first, last] = input.mintRaws;
  const malformed = '0x1234';
  const variants = [
    { ...input, expectedBuyHash: bundleHash },
    { ...input, mintRaws: [last, first] },
    { ...input, mintRaws: [last, first], expectedMintHashes: [hashOf(last), hashOf(first)] },
    { ...input, mintRaws: [first, first], expectedMintHashes: [hashOf(first), hashOf(first)] },
    { ...input, mintRaws: [malformed, last], expectedMintHashes: [bundleHash, hashOf(last)] },
    { ...input, mintRaws: [], expectedMintHashes: [] },
    { ...input, expectedMintHashes: input.expectedMintHashes.slice(1) },
    { ...input, parent: { ...parent, number: Number.MAX_SAFE_INTEGER } },
    { ...input, target: { ...target, factory: buyer.address } },
    await fixture({ count: 4 }),
    await fixture({ buyOverrides: { chainId: 1 } }),
    await fixture({ mintOverrides: [{ chainId: 0 }] }),
    await fixture({ mintOverrides: [{ to: buyer.address }] }),
    await fixture({ mintOverrides: [{ value: target.pricePerLot + 1n }] }),
    await fixture({ mintOverrides: [{ key: buyer }] }),
    await fixture({ count: 2, mintOverrides: [{}, { nonce: 46 }] }),
  ];
  const { submit, reads, packets } = setup();
  for (const invalid of variants) assert.deepEqual(await submit(invalid), { status: 'refused', reason: 'invalid_input' });
  assert.equal(reads(), 0);
  assert.deepEqual(packets, []);
});

test('cannot pass a tip, approval, sell, wrong recipient, looser output, or altered deadline as the checked buy', async () => {
  const approve = new Interface(['function approve(address,uint256)']);
  const good = await fixture();
  const calldata = (minimum, path, recipient, expiration = deadline) =>
    ROUTER_ABI.encodeFunctionData(buyMethod, [minimum, path, recipient, expiration]);
  const alteredMin = await fixture({ buyOverrides: { data: calldata(120n, [WBNB, target.token], buyer.address) } });
  const invalidBuys = [
    { ...alteredMin, expectedBuy: good.expectedBuy },
    { ...good, deadline: deadline + 1 },
    await fixture({ buyOverrides: { to: buyer.address, data: '0x' } }),
    await fixture({ buyOverrides: { to: target.token, value: 0n, data: approve.encodeFunctionData('approve', [ROUTER, 5n]) } }),
    await fixture({ buyOverrides: { value: 0n, data: ROUTER_ABI.encodeFunctionData(
      'swapExactTokensForETHSupportingFeeOnTransferTokens', [1n, 1n, [target.token, WBNB], buyer.address, deadline]) } }),
    await fixture({ buyOverrides: { data: calldata(1n, [WBNB, target.token], minter.address) } }),
    await fixture({ buyOverrides: { data: calldata(1n, [WBNB, quoteAsset, target.token], buyer.address) } }),
    await fixture({ buyOverrides: { data: calldata(0n, [WBNB, target.token], buyer.address) } }),
    await fixture({ buyOverrides: { data: calldata(1n, [WBNB, target.token], buyer.address) + '00' } }),
  ];
  const { submit, packets } = setup();
  for (const invalid of invalidBuys) assert.equal((await submit(invalid)).reason, 'invalid_input');
  assert.deepEqual(packets, []);
});

test('stale parent, reorg, clock errors, deadline passage and pre-dispatch abort never hand off signed txs', async () => {
  const input = await fixture();
  for (const latest of [null, { ...parent, number: parent.number + 1 }, { ...parent, hash: bundleHash },
    { ...parent, timestamp: parent.timestamp + 1 }]) {
    const { submit, packets } = setup({ readLatestBlock: () => latest });
    assert.equal((await submit(input)).reason, 'parent_changed');
    assert.equal(packets.length, 0);
  }
  for (const nowSeconds of [() => deadline, () => Number.NaN, () => { throw Error(input.buyRaw); }]) {
    const { submit, packets, reads } = setup({ nowSeconds });
    assert.equal((await submit(input)).reason, 'expired');
    assert.equal(reads(), 0);
    assert.equal(packets.length, 0);
  }
  let wallTime = deadline - 1;
  const beforeDispatch = setup({ nowSeconds: () => wallTime, readLatestBlock: () => { wallTime = deadline; return parent; } });
  assert.equal((await beforeDispatch.submit(input)).reason, 'expired');
  assert.equal(beforeDispatch.packets.length, 0);
  const ctrl = new AbortController();
  const abortAtRead = setup({ readLatestBlock: () => { ctrl.abort(input.buyRaw); return parent; } });
  assert.equal((await abortAtRead.submit({ ...input, signal: ctrl.signal })).reason, 'aborted_before_submit');
  assert.equal(abortAtRead.packets.length, 0);
  const headerHang = setup({ timeoutMs: 10, readLatestBlock: () => new Promise(() => {}) });
  assert.equal((await headerHang.submit(input)).reason, 'parent_unverified');
  assert.equal(headerHang.packets.length, 0);
});

test('only matching RPC protocol ACK is accepted; explicit standard request rejection is not a vendor duplicate', async () => {
  const input = await fixture();
  for (const [respond, expected] of [
    [packet => rpcOk(packet, bundleHash.toUpperCase().replace('0X', '0x')), 'accepted'],
    [packet => rpcOk(packet, input.expectedBuyHash), 'unknown'],
    [packet => rpcOk(packet, input.expectedMintHashes[0]), 'unknown'],
    [packet => rpcOk(packet, '0x' + '00'.repeat(32)), 'unknown'],
    [packet => ({ ...rpcOk(packet), id: 1 }), 'unknown'],
    [packet => ({ ...rpcOk(packet), jsonrpc: '1.0' }), 'unknown'],
    [packet => ({ ...rpcOk(packet), error: { code: -32602, message: input.buyRaw } }), 'unknown'],
    [packet => rpcError(packet, -32602, input.buyRaw), 'refused'],
    [packet => rpcError(packet, -38000, 'bundle already exist: ' + input.buyRaw), 'unknown'],
    [() => { throw new Error('credential/example:' + input.buyRaw); }, 'unknown'],
    [() => ({ get result() { throw new Error(input.buyRaw); } }), 'unknown'],
  ]) {
    const { submit, packets } = setup({ respond });
    const output = await submit(input);
    assert.equal(output.status, expected);
    assert.equal(output.bundleHash, expected === 'accepted' ? bundleHash : undefined);
    assert(!JSON.stringify(output).includes(input.buyRaw));
    assert(!JSON.stringify(output).includes('credential'));
    const duplicate = await submit(input);
    assert.equal(duplicate.reason, 'previously_attempted');
    assert.equal(duplicate.status, 'unknown');
    assert.equal(packets.length, 1);
  }
});

test('transport abort/timeout stays unknown, including late reply; concurrent same-wallet same-nonce orders get one handoff', async () => {
  const input = await fixture();
  const second = await fixture({ buyOverrides: { gasPrice: 90_000_000n } }); // new hash, same wallet nonce
  assert.notEqual(input.expectedBuyHash, second.expectedBuyHash);
  let seenSignal;
  const timeout = setup({ timeoutMs: 15, respond: (_packet, { signal }) => {
    seenSignal = signal;
    return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(input.buyRaw)), 30));
  } });
  const outcomes = await Promise.all([timeout.submit(input), timeout.submit(second), timeout.submit(input)]);
  assert.equal(timeout.packets.length, 1);
  assert.equal(outcomes.filter(row => row.status === 'unknown').length, 3);
  assert.equal(outcomes.filter(row => row.reason === 'delivery_unverified').length, 1);
  assert.equal(outcomes.filter(row => row.reason === 'previously_attempted').length, 2);
  assert.equal(seenSignal.aborted, true);

  const ctrl = new AbortController();
  const canceled = setup({ respond: (packet, { signal }) => {
    ctrl.abort(input.buyRaw);
    assert.equal(signal.aborted, true);
    return rpcOk(packet); // Too late to classify the post as not submitted.
  } });
  assert.equal((await canceled.submit({ ...input, signal: ctrl.signal })).status, 'unknown');
  assert.equal((await canceled.submit(input)).reason, 'previously_attempted');
  assert.equal(canceled.packets.length, 1);
});

test('durable adapter commits before transport and prevents cross-instance/restart repeats, even after expiry', async t => {
  const f = durableFixture(t), firstJournal = f.open(), secondJournal = f.open();
  const input = await fixture();
  const second = await fixture({ buyOverrides: { gasPrice: 95_000_000n } });
  const first = setup({ journal: firstJournal, async respond(packet) {
    const read = new DatabaseSync(f.path, { readOnly: true });
    try {
      const stored = read.prepare('SELECT status,buy_tx_hash,nonce FROM bundle_intents').get();
      assert.equal(stored.status, 'reserved', 'durable reservation must exist before any external handoff');
      assert.equal(stored.buy_tx_hash, input.expectedBuyHash);
      assert.equal(stored.nonce, 30);
    } finally { read.close(); }
    return rpcOk(packet);
  } });
  const other = setup({ journal: secondJournal });
  const outcomes = await Promise.all([first.submit(input), other.submit(second)]);
  assert.equal(outcomes[0].status, 'accepted');
  assert.equal(outcomes[1].reason, 'previously_attempted');
  assert.equal(first.packets.length + other.packets.length, 1);
  firstJournal.close(); secondJournal.close();
  const restarted = setup({ journal: f.open(), nowSeconds: () => deadline + 100 });
  assert.equal((await restarted.submit(input)).reason, 'previously_attempted');
  assert.equal(restarted.reads(), 0, 'prior attempt must be checked before revalidation or expiry classification');
  assert.equal(restarted.packets.length, 0);
  const freshNonce = await fixture({ buyOverrides: { nonce: 31 } });
  assert.equal((await restarted.submit(freshNonce)).reason, 'previously_attempted', 'same intent cannot escape with a new nonce');
});

test('journal errors are fail-closed; ACK followed by persistence failure becomes unknown and cannot trigger a new handoff', async t => {
  const input = await fixture(), f = durableFixture(t), journal = f.open();
  const diskError = 'credential/raw/' + input.buyRaw;
  const failReserve = setup({ journal: { ...journal, reserve() { throw new Error(diskError); } } });
  const reserveResult = await failReserve.submit(input);
  assert.equal(reserveResult.status, 'unknown');
  assert.equal(reserveResult.reason, 'journal_unavailable');
  assert.equal(failReserve.packets.length, 0);
  assert.equal(JSON.stringify(reserveResult).includes(diskError), false);
  const failFinalize = setup({ journal: { ...journal, markOutcome() { throw new Error(diskError); } } });
  const ackResult = await failFinalize.submit(input);
  assert.equal(ackResult.status, 'unknown');
  assert.equal(ackResult.reason, 'journal_update_failed');
  assert.equal(failFinalize.packets.length, 1);
  journal.close();
  const reopened = setup({ journal: f.open() });
  assert.equal((await reopened.submit(input)).reason, 'previously_attempted');
  assert.equal(reopened.packets.length, 0);
  const read = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(read.prepare('SELECT status FROM bundle_intents').get().status, 'reserved'); }
  finally { read.close(); }
});

test('unknown delivery is persisted, while expiry during the durable commit does not dispatch or remove its intent', async t => {
  const input = await fixture(), f = durableFixture(t), journal = f.open();
  const ambiguous = setup({ journal, respond: () => { throw new Error('offline disconnect'); } });
  assert.equal((await ambiguous.submit(input)).reason, 'delivery_unverified');
  const read = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(read.prepare('SELECT status FROM bundle_intents').get().status, 'unknown'); }
  finally { read.close(); }
  journal.close();
  const reopened = setup({ journal: f.open(), nowSeconds: () => deadline + 1 });
  assert.equal((await reopened.submit(input)).reason, 'previously_attempted');

  const isolated = durableFixture(t), isolatedJournal = isolated.open();
  let now = parent.timestamp;
  const expiredAtCommit = setup({ nowSeconds: () => now, journal: { ...isolatedJournal, reserve(row) {
    const reservation = isolatedJournal.reserve(row);
    now = deadline;
    return reservation;
  } } });
  const outcome = await expiredAtCommit.submit(input);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.reason, 'reserved_not_dispatched');
  assert.equal(expiredAtCommit.packets.length, 0);
  assert.equal((await expiredAtCommit.submit(input)).reason, 'previously_attempted');
});

test('async journal dependencies never qualify as a committed reservation and never leak rejected promises', async t => {
  const input = await fixture(), f = durableFixture(t), journal = f.open();
  for (const method of ['lookup', 'reserve', 'markOutcome']) {
    const asyncWrong = setup({ journal: { ...journal, [method]() { return Promise.reject(new Error('fixture rejection')); } } });
    const output = await asyncWrong.submit(input);
    assert.equal(output.status, 'unknown');
    assert.equal(output.reason, method === 'markOutcome' ? 'journal_update_failed' : 'journal_unavailable');
    assert.equal(asyncWrong.packets.length, method === 'markOutcome' ? 1 : 0);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('real SQLite write contention refuses handoff, and contention after an ACK cannot report accepted', async t => {
  const input = await fixture(), before = durableFixture(t), beforeJournal = before.open();
  const blockingBefore = new DatabaseSync(before.path, { timeout: 1 });
  blockingBefore.exec('BEGIN IMMEDIATE');
  const noHandoff = setup({ journal: beforeJournal });
  try {
    const result = await noHandoff.submit(input);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'journal_unavailable');
    assert.equal(noHandoff.packets.length, 0);
  } finally { blockingBefore.exec('ROLLBACK'); blockingBefore.close(); }

  const after = durableFixture(t), afterJournal = after.open();
  const blockingAfter = new DatabaseSync(after.path, { timeout: 1 });
  const ackNotPersisted = setup({ journal: afterJournal, respond: packet => {
    blockingAfter.exec('BEGIN IMMEDIATE');
    return rpcOk(packet);
  } });
  try {
    const result = await ackNotPersisted.submit(input);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, 'journal_update_failed');
    assert.equal(ackNotPersisted.packets.length, 1);
  } finally { blockingAfter.exec('ROLLBACK'); blockingAfter.close(); }
  afterJournal.close();
  const restarted = setup({ journal: after.open() });
  assert.equal((await restarted.submit(input)).reason, 'previously_attempted');
  assert.equal(restarted.packets.length, 0);
});
