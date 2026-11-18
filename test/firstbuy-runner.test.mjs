import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { Transaction, Wallet, id } from 'ethers';
import { makeExecutor } from '../src/execution.mjs';
import { checkedFirstBuyPlan, FIRSTBUY_ABI, makeFirstBuyRunner, openFirstBuyJournal } from '../src/firstbuy-runner.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const input = {
  contract: address(1), mint: address(2), token: address(3), recipient: address(4), intentId: id('synthetic-intent'), expectedCodeHash: id('synthetic-runtime'),
  amountIn: 5n, minOut: 100n, gasLimit: 300_000n, gasPrice: 100n, maxGasWei: 90_000_000n,
  maxAttempts: 3, startBlock: 100, endBlock: 200, deadline: 2000, intervalMs: 350,
};
const block = number => ({ number, timestamp: 1000 + number - 100, hash: id('block-' + number) });
const event = (name, args) => ({ address: input.contract, ...FIRSTBUY_ABI.encodeEventLog(name, args) });

async function fixture(t, options = {}) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'corla-firstbuy-runner-'));
  const path = join(root, 'transactions.sqlite'), wallet = Wallet.createRandom();
  const init = makeExecutor({ live: true, provider: {}, wallets: [], journalPath: path, maxGasPriceWei: 1n, gasLimitCap: 21000n });
  init.close();
  const journals = [openFirstBuyJournal({ journalPath: path })];
  t.after(async () => {
    for (const j of journals) j.close();
    const resolved = await realpath(root);
    assert.equal(dirname(resolved), parent); assert.ok(basename(resolved).startsWith('corla-firstbuy-runner-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const state = { head: block(100), nonce: 0, pendingNonce: 0, now: 1000, clock: 0,
    signatures: 0, sends: 0, arm: 'armed', receipts: new Map(), calls: [], codeHash: input.expectedCodeHash };
  const provider = {
    getBlock: async height => height === 'latest' ? state.head : block(height),
    getNetwork: async () => ({ chainId: 56n }),
    getTransactionCount: async (_wallet, tag) => tag === 'pending' ? state.pendingNonce : state.nonce,
    getBalance: async () => 1_000_000_000n,
    getTransactionReceipt: async hash => state.receipts.get(hash) ?? null,
  };
  const logs = [], plan = checkedFirstBuyPlan({ ...input, ...options.plan });
  const signer = { address: wallet.address, async signTransaction(tx) { state.signatures++; return wallet.signTransaction(tx); } };
  const readState = async () => ({ contract: plan.contract, intentId: plan.intentId, codeHash: state.codeHash, state: state.arm, attempts: 0 });
  const transport = async (raw, meta) => {
    assert.equal(journals[0].pending(plan.sessionId, wallet.address)?.tx_hash, meta.txHash, 'hash persisted before transport');
    const parsed = Transaction.from(raw);
    assert.equal(parsed.data, FIRSTBUY_ABI.encodeFunctionData('execute', [plan.intentId]));
    assert.equal(parsed.value, 0n); assert.equal(parsed.chainId, 56n);
    state.sends++; state.calls.push(parsed); state.pendingNonce = parsed.nonce + 1;
    if (options.throwTransport) throw new Error('secret endpoint or raw must not escape');
    return parsed.hash;
  };
  function runner(overrides = {}) {
    return makeFirstBuyRunner({ plan, journal: journals[0], provider, signer, readState, transport,
      log: (event, row) => logs.push({ event, ...row }), services: { nowSeconds: () => state.now, monotonic: () => state.clock }, ...overrides });
  }
  function mine(outcome = 'not_filled', height = 100) {
    const tx = state.calls.at(-1); assert.ok(tx);
    const filled = outcome === 'filled';
    const row = { hash: tx.hash, from: wallet.address, to: plan.contract, status: outcome === 'reverted' ? 0 : 1,
      blockNumber: height, blockHash: block(height).hash, index: 7,
      logs: outcome === 'invalid_receipt' || outcome === 'reverted' ? [] : [
        event('AttemptResult', [plan.intentId, 1, filled, filled ? 101n : 0n, id('synthetic-reason')]),
        ...(filled ? [event('Filled', [plan.intentId, plan.mint, plan.token, plan.recipient, plan.amountIn, 101n])] : []),
      ] };
    state.receipts.set(tx.hash, row); state.nonce = tx.nonce + 1; state.pendingNonce = state.nonce; state.head = block(height); state.clock += 350;
    return row;
  }
  return { path, wallet, journals, state, provider, plan, signer, logs, runner, mine };
}

test('disabled mode has no signer, RPC, journal or transport side effects and plans reject invalid policy', async () => {
  const bad = () => assert.fail('dependency must not be called');
  const runner = makeFirstBuyRunner({ plan: input, signer: { address: address(9), signTransaction: bad }, provider: { getBlock: bad }, readState: bad });
  assert.equal((await runner.step()).phase, 'disabled');
  for (const patch of [{ maxAttempts: 0 }, { maxAttempts: 1025 }, { maxGasWei: 1n }, { minOut: 0n }, { endBlock: 99 }, { intentId: '0x12' }]) {
    assert.throws(() => checkedFirstBuyPlan({ ...input, ...patch }), /FIRSTBUY_INVALID_PLAN/);
  }
});

test('known canonical false receipt at one confirmation permits the next fixed-intent nonce, without Pending Mint input', async t => {
  const f = await fixture(t), runner = f.runner();
  const first = await runner.step();
  assert.equal(first.phase, 'pending'); assert.equal(f.state.sends, 1);
  await runner.step(); assert.equal(f.state.sends, 1, 'pending is not a new-nonce retry');
  f.mine();
  const second = await runner.step();
  assert.equal(second.phase, 'pending'); assert.equal(f.state.sends, 2);
  assert.deepEqual(f.state.calls.map(tx => tx.nonce), [0, 1]);
  assert.ok(f.state.calls.every(tx => tx.data === f.plan.calldata && tx.gasPrice === f.plan.gasPrice));
  assert.equal(second.gasReserved, '60000000');
  const recorded=f.logs.find(row=>row.event==='firstbuy_receipt');
  assert.equal(recorded.bought,false);assert.equal(recorded.amountOut,undefined);
  assert.equal(recorded.receiptBlockHash,block(100).hash);assert.equal(recorded.receiptIndex,7);
  assert.ok(f.logs.filter(row=>['firstbuy_send','firstbuy_ack'].includes(row.event)).every(row=>row.contract===f.plan.contract&&row.to===f.plan.contract));
});

test('gas and attempt caps survive restart, retain failed-attempt cost, and cannot be loosened under the same contract intent', async t => {
  const f = await fixture(t, { plan: { maxGasWei: 60_000_000n } }), runner = f.runner();
  await runner.step(); f.mine('reverted'); await runner.step(); f.mine();
  assert.equal((await runner.step()).phase, 'exhausted');
  assert.equal(f.state.sends, 2);
  const reopened = openFirstBuyJournal({ journalPath: f.path }); f.journals.push(reopened);
  assert.equal((await f.runner({ journal: reopened }).step()).phase, 'exhausted');
  const changed = f.runner({ journal: reopened, plan: { ...f.plan, maxGasWei: 100_000_000n } });
  assert.equal((await changed.step()).code, 'FIRSTBUY_INTENT_CHANGED');
  assert.equal(f.state.sends, 2);
});

test('unknown transport result, multiple instances and stopped/restarted sessions never submit a fresh nonce', async t => {
  const f = await fixture(t, { throwTransport: true });
  const first = await f.runner().step();
  const other = openFirstBuyJournal({ journalPath: f.path }); f.journals.push(other);
  const second = await f.runner({ journal: other }).step();
  assert.equal(first.txHash, second.txHash); assert.equal(second.unresolved, true);
  assert.equal(f.state.signatures, 1); assert.equal(f.state.sends, 1);
  f.state.now = 2001;
  const expired = await f.runner({ journal: other }).run();
  assert.equal(expired.phase, 'expired'); assert.equal(expired.unresolved, true);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM firstbuy_wallet_leases').get().n, 1); } finally { db.close(); }
});

test('only a matching Filled event stops immediately and matures at three confirmations; ACK and false are not purchases', async t => {
  const f = await fixture(t), runner = f.runner();
  await runner.step(); const receipt = f.mine('filled');
  const seen = await runner.step();
  assert.equal(seen.phase, 'filled'); assert.equal(seen.unresolved, true); assert.equal(f.state.sends, 1);
  f.state.head = block(102);
  const mature = await runner.step();
  assert.equal(mature.phase, 'filled'); assert.equal(mature.unresolved, undefined);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM actions WHERE tx_hash=?').get(receipt.hash).status, 'confirmed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM firstbuy_wallet_leases').get().n, 0);
  } finally { db.close(); }
  assert.equal(f.state.sends, 1);
  const recorded=f.logs.find(row=>row.event==='firstbuy_receipt');
  assert.equal(recorded.bought,true);assert.equal(recorded.amountOut,101n);
  assert.equal(recorded.receiptBlockHash,receipt.blockHash);assert.equal(recorded.receiptIndex,7);
});

test('successful receipt without contract outcome evidence halts, while a changed runtime never signs', async t => {
  const f = await fixture(t), runner = f.runner();
  await runner.step(); f.mine('invalid_receipt');
  assert.equal((await runner.step()).phase, 'invalid_receipt'); assert.equal(f.state.sends, 1);
  const g = await fixture(t); g.state.codeHash = id('wrong-code');
  assert.equal((await g.runner().step()).code, 'FIRSTBUY_ARM_UNVERIFIED'); assert.equal(g.state.signatures, 0);
});

test('shallow reorg or nonce rollback pauses without a new signature or released cost', async t => {
  const f = await fixture(t), runner = f.runner();
  await runner.step(); f.mine(); await runner.step();
  // The second transaction is pending; first receipt is displaced.
  f.mine();
  f.provider.getBlock = async height => height === 'latest' ? f.state.head : { ...block(height), hash: id('fork') };
  const result = await runner.step();
  assert.equal(result.phase, 'pending'); // second receipt also cannot be made canonical
  assert.equal(f.state.sends, 2);
});

test('expiry, cancellation and an abort during signing cannot dispatch', async t => {
  for (const mode of ['expiry', 'cancelled', 'abort']) {
    const f = await fixture(t), controller = new AbortController();
    if (mode === 'expiry') f.state.now = 2000;
    if (mode === 'cancelled') f.state.arm = 'cancelled';
    const signer = mode === 'abort' ? { address: f.wallet.address, async signTransaction(tx) { const raw = await f.wallet.signTransaction(tx); controller.abort(); return raw; } } : f.signer;
    const result = await f.runner({ signer, signal: controller.signal }).step();
    assert.equal(f.state.sends, 0); assert.ok(['expired','cancelled','stopped'].includes(result.phase));
  }
});

test('a durable lease blocks the already-open legacy executor even between canonical failed attempts', async t => {
  const f = await fixture(t);
  let broadcasts = 0;
  const legacyProvider = {
    send: async method => method === 'eth_chainId' ? '0x38' : '0x64',
    estimateGas: async () => 30_000n, call: async () => '0x',
    getTransactionCount: async () => f.state.nonce, getBalance: async () => 1_000_000_000n,
    getBlock: async height => block(height), getBlockNumber: async () => f.state.head.number,
    getTransactionReceipt: async () => null, broadcastTransaction: async () => { broadcasts++; assert.fail('lease bypass'); },
  };
  const legacy = makeExecutor({ provider: legacyProvider, wallets: [f.wallet], live: true, journalPath: f.path,
    maxGasPriceWei: 200n, gasLimitCap: 50_000n, receiptTimeoutMs: 0 });
  f.journals.push(legacy);
  const runner = f.runner();
  await runner.step(); f.mine(); f.state.clock = 0;
  assert.equal((await runner.step()).phase, 'waiting');
  assert.equal(f.journals[0].pending(f.plan.sessionId, f.wallet.address), undefined);
  await assert.rejects(legacy({ wallet: f.wallet.address, actionId: 'bsc56:' + address(99) + ':mint',
    tx: { to: address(99), data: '0x12345678', value: 0n } }), /first-buy workspace/);
  assert.equal(broadcasts, 0);
});

test('timeout has an unknown delivery state and never permits a fresh hash; deadline is rechecked after signing', async t => {
  const f = await fixture(t);
  const runner = f.runner({ transport: () => new Promise(() => {}), services: {
    nowSeconds: () => f.state.now, monotonic: () => f.state.clock, submitTimeoutMs: 10,
  } });
  const result = await runner.step();
  assert.equal(result.phase, 'pending'); assert.equal(result.unresolved, true);
  const again = await runner.step(); assert.equal(again.txHash, result.txHash); assert.equal(f.state.signatures, 1);
  const g = await fixture(t);
  const signedAfterCutoff = g.runner({ signer: { address: g.wallet.address, async signTransaction(tx) {
    const raw = await g.wallet.signTransaction(tx); g.state.head = block(201); return raw;
  } } });
  assert.equal((await signedAfterCutoff.step()).phase, 'expired');
  assert.equal(g.state.sends, 0);
  assert.equal(g.journals[0].status(g.plan.sessionId).attempts, 0);
});

test('a dependency error while a signed hash is pending preserves unknown delivery in the returned result',async t=>{
  const f=await fixture(t),runner=f.runner();await runner.step();
  f.provider.getTransactionReceipt=async()=>{throw new Error('synthetic RPC unavailable');};
  const result=await runner.step();assert.equal(result.phase,'paused');assert.equal(result.unresolved,true);
  assert.equal(f.state.signatures,1);assert.equal(f.state.sends,1);
});

test('explicit stop releases only a never-dispatched lease; an unknown handoff keeps its lease and buy tombstone', async t => {
  const f = await fixture(t); f.state.codeHash = id('not-our-runtime');
  const runner = f.runner();
  assert.equal((await runner.step()).phase, 'paused');
  assert.equal((await runner.stop()).phase, 'stopped');
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM firstbuy_wallet_leases').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM one_shot_refusals').get().n, 0);
  } finally { db.close(); }
  const g = await fixture(t, { throwTransport: true }), pendingRunner = g.runner();
  await pendingRunner.step(); assert.equal((await pendingRunner.stop()).unresolved, true);
  const pendingDb = new DatabaseSync(g.path, { readOnly: true });
  try {
    assert.equal(pendingDb.prepare('SELECT count(*) AS n FROM firstbuy_wallet_leases').get().n, 1);
    assert.equal(pendingDb.prepare('SELECT count(*) AS n FROM one_shot_refusals').get().n, 1);
  } finally { pendingDb.close(); }
});
