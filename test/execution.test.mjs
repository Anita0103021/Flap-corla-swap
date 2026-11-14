import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Transaction, Wallet } from 'ethers';
import { DatabaseSync } from 'node:sqlite';
import { loadWallets, makeExecutor } from '../src/execution.mjs';
import { buildBuy, WBNB } from '../src/market.mjs';
import { createRpcPool } from '../src/rpc-pool.mjs';
import { MAX_SNIPE_ATTEMPTS } from '../src/snipe-limits.mjs';

const to = '0x0000000000000000000000000000000000000001';
const data = '0x12345678';
const tx = { to, data, value: 15n };
const canonicalHash = '0x' + 'ab'.repeat(32);
const forkHash = '0x' + 'cd'.repeat(32);
const receipt = (hash, from, status = 1, blockHash = canonicalHash, blockNumber = 42) => (
  { hash, from, status, blockNumber, blockHash }
);

const closeAfter = new WeakMap();
async function temp(t) {
  const parent = await realpath(tmpdir());
  const prefix = 'corla-executor-';
  const dir = await mkdtemp(join(parent, prefix));
  const closers = [];
  closeAfter.set(t, closers);
  t.after(async () => {
    for (const close of closers) close();
    const cleanupPath = await realpath(dir);
    assert.equal(dirname(cleanupPath), parent);
    assert.ok(basename(cleanupPath).startsWith(prefix));
    await rm(cleanupPath, { recursive: true, force: true });
  });
  return dir;
}

function fakeRpc() {
  const state = {
    fee: 100n, gas: 30_000n, chainId: '0x38', nonce: 5, latestNonce: 5, balance: 10_000_000n,
    attempts: 0, reads: 0, estimated: 0, receipts: new Map(), calls: [], head: 42,
    blocks: new Map([[42, canonicalHash]]),
  };
  return Object.assign(state, {
    async send(method) {
      if (method === 'eth_gasPrice') return '0x' + state.fee.toString(16);
      assert.equal(method, 'eth_chainId');
      return state.chainId;
    },
    async getFeeData() { return { gasPrice: state.fee }; },
    async estimateGas() { state.estimated++; return state.gas; },
    async call(request) { state.calls.push(request); return '0x'; },
    async getTransactionCount(_from, tag) { return tag === 'pending' ? state.nonce : state.latestNonce; },
    async getBalance() { return state.balance; },
    async getBlock(number) {
      return state.blocks.has(number) ? { number, hash: state.blocks.get(number) } : null;
    },
    async getBlockNumber() { return state.head; },
    async getTransactionReceipt(hash) { state.reads++; return state.receipts.get(hash) ?? null; },
    async waitForTransaction(hash) { return state.receipts.get(hash) ?? null; },
    async broadcastTransaction(raw) {
      state.attempts++;
      const parsed = Transaction.from(raw);
      state.signed = parsed;
      return { hash: parsed.hash };
    },
  });
}

function opts(provider, wallets, journalPath, override = {}) {
  return { provider, wallets, journalPath, live: true, maxGasPriceWei: 200n, gasLimitCap: 50_000n,
    receiptTimeoutMs: 0, ...override };
}

test('dry run reads both call and estimate, returns bounded gas, and never opens a journal', async (t) => {
  const wallet = { address: Wallet.createRandom().address };
  const rpc = fakeRpc();
  const db = join(await temp(t), 'state', 'dry.sqlite');
  const execute = makeExecutor(opts(rpc, [wallet], db, { live: false }));
  assert.deepEqual(await execute({ actionId: 'mint:example', wallet: wallet.address, tx }), {
    status: 'simulated', wallet: wallet.address, actionId: 'mint:example', gasLimit: '36000', gasPrice: '100',
  });
  assert.equal(rpc.estimated, 1);
  assert.deepEqual(rpc.calls, [{ ...tx, from: wallet.address, gasPrice: 100n }]);
  assert.equal(rpc.attempts, 0);
  assert.equal(await execute.reconcile('mint:example', wallet), null);
  assert.equal(existsSync(db), false);
  execute.close();
});

test('invalid chain, reverts, gas caps and malformed transaction fields fail before sending', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'guards.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'mint:one', wallet, tx };
  rpc.chainId = '0x1';
  await assert.rejects(execute(job), /Wrong RPC chain ID/);
  assert.equal(rpc.estimated, 0);
  rpc.chainId = '0x38';
  rpc.fee = 201n;
  await assert.rejects(execute(job), /Gas price .* exceeds/);
  rpc.fee = 200n;
  rpc.gas = 49_000n;
  await assert.rejects(execute(job), /Buffered gas limit .* exceeds/);
  rpc.gas = 30_000n;
  await assert.rejects(execute({ ...job, tx: { ...tx, data: '0x1' } }), /Invalid contract call data/);
  rpc.call = async () => { throw Object.assign(new Error('secret-test: not printed'), { code: 'CALL_EXCEPTION' }); };
  await assert.rejects(execute(job), { message: 'eth_call failed; not sent (CALL_EXCEPTION)' });
  rpc.call = async () => { throw Object.assign(new Error('raw secret not printed'), {
    code: 'CALL_EXCEPTION', reason: 'PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT',
  }); };
  await assert.rejects(execute(job), /最低到手量不足（超出滑点上限）；未发送/);
  assert.equal(rpc.attempts, 0);
  assert.equal(await execute.reconcile(job.actionId, wallet), null);
});

test('live executor persists signed hash before broadcasting and validates receipt status', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const db = join(await temp(t), 'live.sqlite');
  const execute = makeExecutor(opts(rpc, [wallet], db, { confirmations: 2 }));
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'claim:one', wallet, tx };
  rpc.broadcastTransaction = async (raw) => {
    const parsed = Transaction.from(raw);
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const verify = new DatabaseSync(db, { readOnly: true });
    try {
      const row = verify.prepare('SELECT * FROM actions WHERE wallet=?').get(wallet.address);
      assert.equal(row.tx_hash, parsed.hash);
      assert.equal(row.status, 'pending');
      assert.equal(row.action_id, job.actionId);
    } finally {
      verify.close();
    }
    assert.equal(parsed.from, wallet.address);
    assert.equal(parsed.chainId, 56n);
    assert.equal(parsed.nonce, 5);
    assert.equal(parsed.gasLimit, 36_000n);
    assert.equal(parsed.gasPrice, 100n);
    assert.equal(parsed.data, data);
    assert.equal(parsed.value, 15n);
    assert.equal(parsed.to, to);
    rpc.attempts++;
    rpc.receipts.set(parsed.hash, { ...receipt(parsed.hash, wallet.address), confirmations: async () => 99 });
    return { hash: parsed.hash };
  };
  const result = await execute(job);
  assert.equal(rpc.attempts, 1);
  assert.equal(result.status, 'pending');
  rpc.head = 43;
  assert.equal((await execute.reconcile(job.actionId, wallet.address)).status, 'confirmed');
  rpc.head = 42;
  assert.equal((await execute.reconcile(job.actionId, wallet.address)).status, 'pending');
  rpc.head = 43;
  assert.equal((await execute({ ...job, tx: undefined })).status, 'confirmed');
  assert.equal(rpc.attempts, 1);
});

test('a stale launch rejected at the pre-sign guard never reserves or broadcasts a transaction', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'stale.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'buy:stale', wallet, tx,
    beforeSign: async () => { throw new Error('launch expired'); } };
  await assert.rejects(execute(job), /launch expired/);
  assert.equal(rpc.estimated, 1);
  assert.equal(rpc.attempts, 0);
  assert.equal(await execute.reconcile(job.actionId, wallet), null);
});

test('fast broadcast submits one raw RPC call and does not wait on a receipt before returning', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const send = rpc.send;
  const times = [];
  rpc.send = async (method, params) => {
    if (method !== 'eth_sendRawTransaction') return send(method);
    rpc.attempts++;
    assert.equal(params.length, 1);
    const parsed = Transaction.from(params[0]);
    assert.equal(parsed.chainId, 56n);
    assert.equal(parsed.from, wallet.address);
    return parsed.hash;
  };
  rpc.broadcastTransaction = () => assert.fail('wrapper not used in fast mode');
  const exec = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'fast.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => exec.close());
  const result = await exec({ actionId: 'buy:fast', wallet, tx, onBroadcast: (stage, payload) => times.push([stage, payload.txHash]) });
  assert.equal(result.status, 'pending');
  assert.deepEqual(times, [['send', result.txHash], ['ack', result.txHash]]);
  assert.equal(rpc.attempts, 1);
  assert.equal(rpc.reads, 0);
});

test('one signing and journal reservation back a concurrent RPC wave, including an ambiguous response', async t => {
  const account = Wallet.createRandom();
  let signatures = 0;
  const wallet = {
    address: account.address,
    async signTransaction(request) { signatures++; return account.signTransaction(request); },
  };
  const rpc = fakeRpc();
  const dbPath = join(await temp(t), 'fanout.sqlite');
  const posts = [];
  const nodes = ['https://node-one.invalid', 'https://node-two.invalid'];
  const pool = createRpcPool(nodes, {
    fetch: async (url, { body }) => {
      const p = JSON.parse(typeof body === 'string' ? body : await new Response(body).text());
      if (p.method === 'eth_sendRawTransaction') {
        const signed = Transaction.from(p.params[0]);
        posts.push({ node: new URL(url).origin, raw: p.params[0], hash: signed.hash });
        return new Response(null, { status: 504 }); // The node might still have received it.
      }
      assert.ok(['eth_chainId', 'eth_blockNumber'].includes(p.method));
      return Response.json({ id: p.id, jsonrpc: '2.0', result: p.method === 'eth_chainId' ? '0x38' : '0x100' });
    },
  });
  const dispatches = [];
  rpc.submitRawTransaction = (raw, options) => {
    assert.equal(options.singleSubmission, true);
    assert.equal(options.broadcastConcurrency, 2);
    const signed = Transaction.from(raw);
    const read = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = read.prepare('SELECT tx_hash, nonce, status FROM actions').get();
      assert.equal(row.tx_hash, signed.hash);
      assert.equal(row.nonce, signed.nonce);
      assert.equal(row.status, 'pending');
    } finally { read.close(); }
    return pool.submitRawTransaction(raw, { ...options, onDispatch(count) {
      dispatches.push(count);
      options.onDispatch(count);
    } });
  };
  const executor = makeExecutor(opts(rpc, [wallet], dbPath, { directBroadcast: true, broadcastConcurrency: 2 }));
  closeAfter.get(t).push(() => { executor.close(); pool.destroy(); });
  const broadcasts = [];
  const request = { actionId: 'buy:fanout', wallet, tx, singleSubmission: true, onBroadcast: (stage, meta) =>
    broadcasts.push([stage, meta.txHash, meta.broadcastConcurrency]) };
  const pending = await executor(request);
  assert.equal(pending.status, 'pending');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(p => p.node).sort(), nodes);
  assert.equal(posts[0].raw, posts[1].raw);
  assert.equal(posts[0].hash, pending.txHash);
  assert.deepEqual(dispatches, [2]);
  assert.equal((await executor(request)).txHash, pending.txHash);
  assert.equal(posts.length, 2);
  assert.equal(signatures, 1);
  assert.deepEqual(broadcasts, [['send', pending.txHash, 2]]);
});

test('a prepared fee overlaps exact preflight but cannot bypass a fresh wallet check', { timeout: 3000 }, async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const balanceGate = Promise.withResolvers();
  const preflight = Promise.withResolvers();
  rpc.getBalance = async () => balanceGate.promise;
  rpc.estimateGas = async () => { preflight.resolve(); return 30_000n; };
  rpc.submitRawTransaction = async () => { rpc.attempts++; throw new Error('must not submit'); };
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'warm-guards.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => execute.close());
  const preparedWallet = execute.prepare({ wallet });
  await preparedWallet;
  const attempt = execute({ actionId: 'buy:prep-guard', wallet, tx, singleSubmission: true, preparedWallet });
  try {
    await preflight.promise;
    assert.equal(rpc.attempts, 0);
  } finally { balanceGate.resolve(0n); }
  await assert.rejects(attempt, /Wallet balance is below/);
  assert.equal(rpc.attempts, 0);
  assert.equal(await execute.reconcile('buy:prep-guard', wallet), null);
});

test('a fresh changed fee invalidates warm preflight and is used for the only signature', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const seenGas = [];
  const checkedGas = [];
  rpc.estimateGas = async request => { seenGas.push(request.gasPrice); return 30_000n; };
  rpc.call = async request => { checkedGas.push(request.gasPrice); return '0x'; };
  rpc.submitRawTransaction = async (raw, options) => {
    rpc.attempts++;
    assert.equal(options.singleSubmission, true);
    const signed = Transaction.from(raw);
    assert.equal(signed.gasPrice, 110n);
    return signed.hash;
  };
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'warm-fee.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => execute.close());
  const preparedWallet = execute.prepare({ wallet });
  await preparedWallet;
  rpc.fee = 110n;
  const result = await execute({ actionId: 'buy:prep-new-fee', wallet, tx, singleSubmission: true, preparedWallet });
  assert.equal(result.status, 'pending');
  assert.deepEqual(seenGas, [100n, 110n]);
  assert.deepEqual(checkedGas, [110n]);
  assert.equal(rpc.attempts, 1);
});

test('a fresh router call can reject slippage after warm estimation without sending', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  rpc.call = async request => {
    assert.equal(request.gasLimit, 36_000n, 'final simulation uses the exact gas limit');
    throw Object.assign(new Error('sensitive raw revert not echoed'), {
      code: 'CALL_EXCEPTION', revert: { args: ['PancakeRouter: INSUFFICIENT_OUTPUT_AMOUNT'] },
    });
  };
  rpc.submitRawTransaction = async () => { rpc.attempts++; throw new Error('must not submit'); };
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'warm-latest-price.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => execute.close());
  const preparedWallet = execute.prepare({ wallet });
  await preparedWallet;
  await assert.rejects(execute({ actionId: 'buy:prep-latest-price', wallet, tx, singleSubmission: true, preparedWallet }),
    /最低到手量不足/);
  assert.equal(rpc.attempts, 0);
});

test('broadcast ambiguity never exposes raw tx or repeats after restart; revert is terminal', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const options = opts(rpc, [wallet], join(await temp(t), 'resume.sqlite'));
  const job = { actionId: 'bsc56:0x0000000000000000000000000000000000000001:mint:2', wallet, tx };
  let execute = makeExecutor(options);
  rpc.broadcastTransaction = async (raw) => {
    rpc.attempts++;
    assert.equal(Transaction.from(raw).from, wallet.address);
    throw new Error(`Injected transport error with raw tx ${raw}`);
  };
  const sent = await execute(job);
  assert.equal(sent.status, 'pending');
  assert.match(sent.reason, /^Broadcast outcome unknown/);
  assert.match(sent.txHash, /^0x[a-f0-9]{64}$/);
  execute.close();
  execute = makeExecutor(options);
  closeAfter.get(t).push(() => execute.close());
  const recovered = await execute.reconcilePending(wallet);
  assert.equal(recovered.actionId, job.actionId);
  assert.equal(recovered.txHash, sent.txHash);
  assert.equal((await execute(job)).txHash, sent.txHash);
  assert.equal((await execute({ ...job, actionId: 'claim:two' })).status, 'pending');
  assert.equal(rpc.attempts, 1);
  rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address, 0));
  assert.equal((await execute.reconcile(job.actionId, wallet)).status, 'failed');
  assert.equal(await execute.reconcilePending(wallet), null);
  assert.equal((await execute(job)).status, 'failed');
  await assert.rejects(execute({ ...job, actionId: 'claim:two' }), /stale nonce/);
  assert.equal(rpc.attempts, 1);
});

test('stop during async signing does not reserve or broadcast', async t => {
  const key = Wallet.createRandom();
  const rpc = fakeRpc();
  const stop = new AbortController();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const wallet = {
    address: key.address,
    async signTransaction(request) {
      entered.resolve();
      await gate.promise;
      return key.signTransaction(request);
    },
  };
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'stop-signing.sqlite'), { signal: stop.signal }));
  closeAfter.get(t).push(() => execute.close());
  const work = execute({ actionId: 'buy:stop-sign', wallet, tx });
  await entered.promise;
  stop.abort();
  gate.resolve();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(rpc.attempts, 0);
  assert.equal(await execute.reconcile('buy:stop-sign', wallet), null);
});

test('stop after staging but before RPC releases only that unsent reservation', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const stop = new AbortController();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'stop-before-rpc.sqlite'), { signal: stop.signal }));
  closeAfter.get(t).push(() => execute.close());
  await assert.rejects(execute({ actionId: 'buy:stop-rpc', wallet, tx, onBroadcast: () => stop.abort() }), { name: 'AbortError' });
  assert.equal(await execute.reconcile('buy:stop-rpc', wallet), null);
  assert.equal(rpc.attempts, 0);
});

test('stop after submission preserves the hash and allows later receipt reconciliation', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const stop = new AbortController();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  rpc.submitRawTransaction = async (raw, { signal }) => {
    assert.equal(signal, stop.signal);
    rpc.attempts++;
    entered.resolve();
    await gate.promise;
    return Transaction.from(raw).hash;
  };
  rpc.waitForTransaction = () => assert.fail('stop should skip optional receipt wait');
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'stop-after-rpc.sqlite'), {
    receiptTimeoutMs: 500, signal: stop.signal,
  }));
  closeAfter.get(t).push(() => execute.close());
  const work = execute({ actionId: 'buy:stop-after-send', wallet, tx });
  await entered.promise;
  stop.abort();
  gate.resolve();
  const sent = await work;
  assert.equal(sent.status, 'pending');
  assert.equal((await execute.reconcilePending(wallet)).txHash, sent.txHash);
  rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address));
  assert.equal((await execute.reconcilePending(wallet)).status, 'confirmed');
  assert.equal(rpc.attempts, 1);
});

test('verified pre-submit refusal releases a fresh nonce; a forged code never does', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const database = join(await temp(t), 'all-limited.sqlite');
  const pool = createRpcPool(['https://local-only.invalid/'], {
    fetch: async (_url, { body }) => {
      const p = JSON.parse(body);
      if (p.method === 'eth_sendRawTransaction') {
        rpc.attempts++;
        const read = new DatabaseSync(database, { readOnly: true });
        try {
          const row = read.prepare('SELECT * FROM actions WHERE wallet=?').get(wallet.address);
          assert.equal(row.tx_hash, Transaction.from(p.params[0]).hash);
          assert.equal(row.status, 'pending');
          assert.ok(!JSON.stringify(row).includes(p.params[0]));
        } finally { read.close(); }
        return new Response(null, { status: 429 });
      }
      return Response.json({ id: p.id, jsonrpc: '2.0', result: p.method === 'eth_chainId' ? '0x38' : '0x2a' });
    },
  });
  t.after(() => pool.destroy());
  rpc.submitRawTransaction = pool.submitRawTransaction.bind(pool);
  let execute = makeExecutor(opts(rpc, [wallet], database));
  await assert.rejects(execute({ actionId: 'mint:refused', wallet, tx }), { code: 'TRANSACTION_NOT_SUBMITTED' });
  assert.equal(await execute.reconcile('mint:refused', wallet), null);
  execute.close();
  rpc.submitRawTransaction = async () => {
    rpc.attempts++;
    throw Object.assign(new Error('fake rate limit'), { code: 'TRANSACTION_NOT_SUBMITTED', status: 429 });
  };
  execute = makeExecutor(opts(rpc, [wallet], database));
  closeAfter.get(t).push(() => execute.close());
  const sent = await execute({ actionId: 'claim:reuse-only-unsent-nonce', wallet, tx });
  assert.equal(sent.status, 'pending');
  assert.match(sent.reason, /outcome unknown/);
  assert.equal((await execute.reconcilePending(wallet)).txHash, sent.txHash);
  assert.equal((await execute({ actionId: 'mint:blocked', wallet, tx })).txHash, sent.txHash);
  assert.equal(rpc.attempts, 2);
});

test('one-shot refusal is terminal across restart without holding the unused nonce', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const database = join(await temp(t), 'one-shot.sqlite');
  const pool = createRpcPool(['https://one-shot.invalid/'], {
    fetch: async (_url, { body }) => {
      const p = JSON.parse(typeof body === 'string' ? body : await new Response(body).text());
      if (p.method === 'eth_sendRawTransaction') {
        rpc.attempts++;
        return new Response(null, { status: 429 });
      }
      return Response.json({ id: p.id, jsonrpc: '2.0', result: p.method === 'eth_chainId' ? '0x38' : '0x2a' });
    },
  });
  t.after(() => pool.destroy());
  const policies = [];
  rpc.submitRawTransaction = (raw, options) => {
    policies.push(options.singleSubmission);
    return pool.submitRawTransaction(raw, options);
  };
  const options = opts(rpc, [wallet], database);
  let execute = makeExecutor(options);
  const buy = { actionId: 'buy:one-shot', wallet, tx, singleSubmission: true };
  await assert.rejects(execute(buy), { code: 'TRANSACTION_NOT_SUBMITTED' });
  assert.equal(await execute.reconcilePending(wallet), null);
  execute.close();
  execute = makeExecutor(options);
  closeAfter.get(t).push(() => execute.close());
  const refusal = await execute.reconcile(buy.actionId, wallet);
  assert.equal(refusal.status, 'skipped');
  assert.equal(refusal.txHash, undefined);
  assert.deepEqual(await execute(buy), refusal);
  // A different action can use the same nonce because HTTP 429 did not consume it.
  rpc.submitRawTransaction = async (raw, { singleSubmission }) => {
    policies.push(singleSubmission);
    rpc.attempts++;
    const parsed = Transaction.from(raw);
    assert.equal(parsed.nonce, rpc.nonce);
    return parsed.hash;
  };
  const later = await execute({ actionId: 'mint:reuse-unused-nonce', wallet, tx });
  assert.equal(later.status, 'pending');
  assert.deepEqual(policies, [true, false]);
  assert.equal(rpc.attempts, 2);
});

test('one-shot live submission refuses an unbounded generic transport before signing', async t => {
  const wallet = Wallet.createRandom();
  let signed = 0;
  const signer = { address: wallet.address, async signTransaction() { signed++; assert.fail('Must not sign'); } };
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [signer], join(await temp(t), 'generic.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  await assert.rejects(execute({ actionId: 'buy:generic', wallet, tx, singleSubmission: true }), /RPC 不支持单次提交/);
  assert.equal(signed, 0);
  assert.equal(rpc.attempts, 0);
});

const raceBase = 'bsc56:0x000000000000000000000000000000000000002a:buy';
const raceTx = (wallet, minOut = 100n, amountIn = 15n, token = to) =>
  buildBuy({ amountOutMin: minOut, path: [WBNB, token] }, wallet.address,
    { amountIn, deadlineSeconds: 8 }, { number: 42, timestamp: 1794590000 });

function raceRpc() {
  const rpc = fakeRpc();
  rpc.submitRawTransaction = async (raw, policy) => {
    assert.equal(policy.singleSubmission, true);
    rpc.attempts++;
    const signed = Transaction.from(raw);
    assert.equal(signed.nonce, rpc.nonce);
    return signed.hash;
  };
  return rpc;
}

test('race waits on unknown or noncanonical outcome, repeats after one canonical revert, and stops on success', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const executor = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'race-canonical.sqlite'), {
    directBroadcast: true, confirmations: 3,
  }));
  closeAfter.get(t).push(() => executor.close());
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 3 };
  assert.equal(await executor.raceStatus(raceBase, wallet), null);
  const first = await executor.race(request);
  assert.equal(first.status, 'pending');
  assert.equal(first.actionId, raceBase);
  assert.equal(first.attempt, 1);
  assert.equal(first.attemptActionId, raceBase + ':race:1');
  assert.equal((await executor.race(request)).txHash, first.txHash);
  rpc.receipts.set(first.txHash, receipt(first.txHash, wallet.address, 0, forkHash));
  assert.equal((await executor.raceStatus(raceBase, wallet)).status, 'pending');
  assert.equal((await executor.race(request)).attempt, 1);
  assert.equal(rpc.attempts, 1);
  rpc.receipts.set(first.txHash, receipt(first.txHash, wallet.address, 0));
  assert.equal((await executor.raceStatus(raceBase, wallet)).status, 'failed');
  rpc.nonce = rpc.latestNonce = 6;
  const second = await executor.race(request);
  assert.equal(second.attempt, 2);
  rpc.blocks.set(43, forkHash);
  rpc.head = 43;
  rpc.receipts.set(second.txHash, receipt(second.txHash, wallet.address, 1, forkHash, 43));
  assert.equal((await executor.raceStatus(raceBase, wallet)).status, 'confirmed');
  assert.equal((await executor.race(request)).txHash, second.txHash);
  assert.equal((await executor({ ...request, singleSubmission: true })).txHash, second.txHash);
  assert.equal(rpc.attempts, 2);
});

test('race cap survives restart and a legacy base action prevents a second trade', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const options = opts(rpc, [wallet], join(await temp(t), 'race-restart.sqlite'), { directBroadcast: true });
  let executor = makeExecutor(options);
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 1 };
  const first = await executor.race(request);
  executor.close();
  executor = makeExecutor(options);
  closeAfter.get(t).push(() => executor.close());
  rpc.receipts.set(first.txHash, receipt(first.txHash, wallet.address, 0));
  rpc.nonce = rpc.latestNonce = 6;
  assert.equal((await executor.race({ ...request, maxAttempts: 5 })).status, 'exhausted');
  assert.equal((await executor({ ...request, singleSubmission: true })).status, 'skipped');
  const legacy = { ...request, actionId: raceBase.replace('2a:buy', '2b:buy'), singleSubmission: true };
  const second = await executor(legacy);
  assert.equal((await executor.race({ ...legacy, maxAttempts: 2 })).txHash, second.txHash);
  rpc.receipts.set(second.txHash, receipt(second.txHash, wallet.address, 0));
  assert.equal((await executor.race({ ...legacy, maxAttempts: 2 })).status, 'exhausted');
  assert.equal(rpc.attempts, 2);
});

test('upgrading the five-round journal preserves prior reservations and enables later ordinals on new projects', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const path = join(await temp(t), 'race-upgrade.sqlite');
  const options = opts(rpc, [wallet], path, { directBroadcast: true });
  const firstExecutor = makeExecutor(options);
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 5 };
  let first;
  try {
    first = await firstExecutor.race(request);
    assert.equal(first.attempt, 1);
    assert.equal(first.status, 'pending');
  } finally { firstExecutor.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE old_race_attempts (
        wallet TEXT NOT NULL,
        base_action_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5),
        action_id TEXT NOT NULL,
        max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
        PRIMARY KEY(wallet, base_action_id, attempt),
        UNIQUE(wallet, action_id)
      ) STRICT;
      INSERT INTO old_race_attempts SELECT * FROM race_attempts;
      DROP TABLE race_attempts;
      ALTER TABLE old_race_attempts RENAME TO race_attempts;
      COMMIT;`);
  } finally { db.close(); }
  const executor = makeExecutor(options);
  closeAfter.get(t).push(() => executor.close());
  const bigger = { ...request, maxAttempts: MAX_SNIPE_ATTEMPTS };
  let current = await executor.race(bigger);
  assert.equal(current.status, 'pending');
  assert.equal(current.txHash, first.txHash);
  assert.equal(rpc.attempts, 1);
  function revert(tx) {
    rpc.receipts.set(tx.txHash, receipt(tx.txHash, wallet.address, 0));
    rpc.latestNonce = ++rpc.nonce;
  }
  revert(current);
  for (let round = 2; round <= 5; round++) {
    current = await executor.race(bigger);
    assert.equal(current.attempt, round);
    revert(current);
  }
  assert.equal((await executor.race(bigger)).status, 'exhausted');
  assert.equal(rpc.attempts, 5);
  const newProject = { ...bigger, actionId: raceBase.replace('2a:buy', '2b:buy') };
  for (let round = 1; round <= MAX_SNIPE_ATTEMPTS; round++) {
    current = await executor.race(newProject);
    assert.equal(current.attemptActionId, newProject.actionId + ':race:' + round);
    assert.equal(current.status, 'pending');
    revert(current);
  }
  assert.equal((await executor.race(newProject)).status, 'exhausted');
  assert.equal(rpc.attempts, 5 + MAX_SNIPE_ATTEMPTS);
  await assert.rejects(executor({ ...newProject, actionId: newProject.actionId + ':race:12' }), /reserved/);
});

test('a race closed during signing leaves no reservation or RPC POST', async t => {
  const wallet = Wallet.createRandom();
  const slowSigner = { address: wallet.address, async signTransaction(request) {
    const raw = await wallet.signTransaction(request);
    closed = true;
    return raw;
  } };
  let closed = false;
  const rpc = raceRpc();
  const executor = makeExecutor(opts(rpc, [slowSigner], join(await temp(t), 'race-expired-sign.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => executor.close());
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 6,
    beforeDispatch() { if (closed) throw new Error('closed in test'); } };
  await assert.rejects(executor.race(request), /closed in test/);
  assert.equal(await executor.raceStatus(raceBase, wallet), null);
  assert.equal(rpc.attempts, 0);
});

test('definite raw refusal consumes a race attempt but does not reserve its nonce', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const pool = createRpcPool(['https://race-refusal.invalid/'], {
    fetch: async (_url, { body }) => {
      const p = JSON.parse(typeof body === 'string' ? body : await new Response(body).text());
      if (p.method === 'eth_sendRawTransaction') {
        rpc.attempts++;
        return new Response(null, { status: 429 });
      }
      return Response.json({ id: p.id, jsonrpc: '2.0', result: p.method === 'eth_chainId' ? '0x38' : '0x2a' });
    },
  });
  t.after(() => pool.destroy());
  const accepted = rpc.submitRawTransaction;
  rpc.submitRawTransaction = pool.submitRawTransaction.bind(pool);
  const executor = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'race-refused.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => executor.close());
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 2 };
  const first = await executor.race(request);
  assert.equal(first.status, 'skipped');
  assert.equal(first.attempt, 1);
  assert.equal(await executor.reconcilePending(wallet), null);
  assert.equal((await executor.raceStatus(raceBase, wallet)).status, 'skipped');
  rpc.submitRawTransaction = accepted;
  const second = await executor.race(request);
  assert.equal(second.status, 'pending');
  assert.equal(second.attempt, 2);
  assert.equal(rpc.attempts, 2);
});

test('pre-open gas path rejects a forged plan or missing final guard before signing', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  rpc.estimateGas = () => assert.fail('Pool does not exist yet, use the ordered simulation estimate');
  rpc.call = () => assert.fail('Pool does not exist yet, do not simulate the buy by itself');
  const executor = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'race-preopen.sqlite'), { directBroadcast: true }));
  closeAfter.get(t).push(() => executor.close());
  const block = { number: 42, timestamp: 1794590000 };
  const settings = { amountIn: 15n, deadlineSeconds: 8 };
  const buy = min => buildBuy({ amountOutMin: min, path: [WBNB, to] }, wallet.address, settings, block);
  const unsigned = buy(100n);
  const request = { actionId: raceBase, wallet, tx: unsigned, maxAttempts: 2, gasEstimate: 25_000n,
    preopenPlan: Object.freeze({ tx: Object.freeze(unsigned), gasEstimate: 25_000n, recipient: wallet.address, amountOutMin: 100n }) };
  await assert.rejects(executor.race(request), /final signing guard/);
  await assert.rejects(executor.race({ ...request, beforeSign: () => {} }), /original verified ordered simulation/);
  assert.equal(await executor.raceStatus(raceBase, wallet), null);
  assert.equal(rpc.attempts, 0);
});

test('the race reservation blocks another executor and ordinary one-shot atomically', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const accept = rpc.submitRawTransaction;
  rpc.submitRawTransaction = async (raw, policy) => {
    entered.resolve();
    await gate.promise;
    return accept(raw, policy);
  };
  const options = opts(rpc, [wallet], join(await temp(t), 'race-concurrent.sqlite'), { directBroadcast: true });
  const a = makeExecutor(options), b = makeExecutor(options);
  closeAfter.get(t).push(() => a.close(), () => b.close());
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 3 };
  const first = a.race(request);
  await entered.promise;
  try {
    assert.equal((await b.race(request)).attempt, 1);
    assert.equal((await b({ ...request, singleSubmission: true })).status, 'pending');
    await assert.rejects(b({ ...request, actionId: raceBase + ':race:1', singleSubmission: true }), /reserved/);
  } finally { gate.resolve(); }
  assert.equal((await first).status, 'pending');
  assert.equal(rpc.attempts, 1);
});

test('restart cannot lower the original minOut, increase amount, or change the race token', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const options = opts(rpc, [wallet], join(await temp(t), 'race-price-floor.sqlite'), { directBroadcast: true });
  const firstExecutor = makeExecutor(options);
  const request = { actionId: raceBase, wallet, tx: raceTx(wallet), maxAttempts: 3 };
  const first = await firstExecutor.race(request);
  firstExecutor.close();
  const executor = makeExecutor(options);
  closeAfter.get(t).push(() => executor.close());
  rpc.receipts.set(first.txHash, receipt(first.txHash, wallet.address, 0));
  rpc.nonce = rpc.latestNonce = 6;
  for (const other of [raceTx(wallet, 99n), raceTx(wallet, 100n, 16n),
    raceTx(wallet, 100n, 15n, '0x0000000000000000000000000000000000000011')]) {
    await assert.rejects(executor.race({ ...request, tx: other }), /weakens its original minimum output/);
  }
  assert.equal(rpc.attempts, 1);
  assert.equal((await executor.race(request)).attempt, 2);
  assert.equal(rpc.attempts, 2);
});

test('ERC-20 race keeps the original quote asset and principal after restart', async t => {
  const wallet = Wallet.createRandom();
  const rpc = raceRpc();
  const usdt = '0x0000000000000000000000000000000000000035';
  const other = '0x0000000000000000000000000000000000000036';
  const options = opts(rpc, [wallet], join(await temp(t), 'erc20-race.sqlite'), { directBroadcast: true });
  const build = (quoteToken, amountIn = 35_000_000n) =>
    buildBuy({ amountOutMin: 100n, path: [quoteToken, to] }, wallet.address,
      { amountIn, quoteToken, deadlineSeconds: 8 }, { number: 42, timestamp: 1794590000 });
  const request = { actionId: raceBase, wallet, tx: build(usdt), quoteToken: usdt, maxAttempts: 3 };
  assert.equal(request.tx.value, 0n);
  const original = makeExecutor(options);
  const first = await original.race(request);
  assert.equal(first.status, 'pending');
  original.close();
  rpc.receipts.set(first.txHash, receipt(first.txHash, wallet.address, 0));
  rpc.nonce = rpc.latestNonce = 6;
  const executor = makeExecutor(options);
  closeAfter.get(t).push(() => executor.close());
  for (const change of [{ tx: build(other), quoteToken: other }, { tx: build(usdt, 35_000_001n) },
    { tx: raceTx(wallet, 100n, 35_000_000n), quoteToken: undefined }]) {
    await assert.rejects(executor.race({ ...request, ...change }), /weakens its original minimum output/);
  }
  assert.equal(rpc.attempts, 1);
  assert.equal((await executor.race(request)).attempt, 2);
  assert.equal(rpc.attempts, 2);
});

for (const status of [0, 1]) {
  test(`an orphan receipt with status ${status} stays pending; only the canonical hash is terminal`, async t => {
    const wallet = Wallet.createRandom();
    const rpc = fakeRpc();
    const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'orphan-first.sqlite')));
    closeAfter.get(t).push(() => execute.close());
    const sent = await execute({ actionId: 'mint:branch', wallet, tx });
    rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address, status, forkHash));
    assert.match((await execute.reconcilePending(wallet)).reason, /not verified on the canonical chain/);
    rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address, status));
    assert.equal((await execute.reconcilePending(wallet)).status, status === 1 ? 'confirmed' : 'failed');
  });
}

test('an indexed receipt can disappear safely; a confirmed reorg quarantines the wallet across restarts', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const options = opts(rpc, [wallet], join(await temp(t), 'reorg.sqlite'));
  let execute = makeExecutor(options);
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'mint:reorg', wallet, tx };
  const sent = await execute(job);
  rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address));
  assert.equal((await execute.reconcilePending(wallet)).status, 'confirmed');
  rpc.receipts.delete(sent.txHash);
  assert.equal((await execute.reconcile(job.actionId, wallet)).status, 'confirmed');
  rpc.blocks.delete(42);
  assert.match((await execute.reconcile(job.actionId, wallet)).reason, /block unavailable/);
  rpc.blocks.set(42, forkHash);
  assert.match((await execute.reconcilePending(wallet)).reason, /reorganized/);
  execute.close();
  execute = makeExecutor(options);
  rpc.nonce = rpc.latestNonce = 6;
  const blocked = await execute({ ...job, actionId: 'claim:blocked' });
  assert.equal(blocked.status, 'pending');
  assert.equal(blocked.txHash, sent.txHash);
  assert.equal(rpc.attempts, 1);
  rpc.blocks.set(43, canonicalHash);
  rpc.head = 43;
  rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address, 1, canonicalHash, 43));
  assert.equal((await execute.reconcilePending(wallet)).status, 'confirmed');
  assert.equal(await execute.reconcilePending(wallet), null);
  assert.equal(rpc.attempts, 1);
});

test('background receipt evidence checks stop at bounded maturity, while explicit reconciliation still checks', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'stable.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  const actionId = 'buy:reorg-monitor';
  const sent = await execute({ actionId, wallet, tx });
  rpc.receipts.set(sent.txHash, receipt(sent.txHash, wallet.address));
  const early = await execute.reconcilePending(wallet);
  assert.equal(early.receiptBlock, 42);
  assert.equal(early.receiptStable, false);
  rpc.blocks.set(42, forkHash);
  const [orphaned] = await execute.reconcileRecent(wallet);
  assert.equal(orphaned.txHash, sent.txHash);
  assert.equal(orphaned.status, 'pending');
  rpc.blocks.set(42, canonicalHash);
  rpc.receipts.clear(); // The prior canonical proof is enough for the same block hash.
  rpc.head = 53;
  const [restored] = await execute.reconcileRecent(wallet);
  assert.equal(restored.status, 'confirmed');
  assert.equal(restored.receiptStable, true);
  rpc.blocks.set(42, forkHash);
  assert.deepEqual(await execute.reconcileRecent(wallet), []);
  assert.equal((await execute.reconcile(actionId, wallet)).status, 'pending');
  assert.equal(rpc.attempts, 1);
});

test('a pre-upgrade terminal action acquires canonical evidence without replacing its journal row', async t => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const path = join(await temp(t), 'previous-version.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const before = new DatabaseSync(path);
  const hash = '0x' + 'fe'.repeat(32);
  before.exec(`CREATE TABLE actions (
    wallet TEXT NOT NULL, action_id TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
    nonce INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','confirmed','failed')),
    updated_at TEXT NOT NULL, PRIMARY KEY(wallet, action_id), UNIQUE(wallet, nonce)
  ) STRICT`);
  before.prepare('INSERT INTO actions VALUES (?,?,?,?,?,?)').run(wallet.address, 'mint:old', hash, 4, 'confirmed', 'before-upgrade');
  before.close();
  const execute = makeExecutor(opts(rpc, [wallet], path));
  closeAfter.get(t).push(() => execute.close());
  assert.equal((await execute.reconcile('mint:old', wallet)).status, 'pending');
  rpc.receipts.set(hash, receipt(hash, wallet.address));
  const reconciled = await execute.reconcile('mint:old', wallet);
  assert.equal(reconciled.status, 'confirmed');
  assert.equal(reconciled.txHash, hash);
  assert.equal(reconciled.receiptBlock, 42);
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(after.prepare('SELECT nonce FROM actions').all().map(row => row.nonce), [4]);
  } finally { after.close(); }
  assert.equal(rpc.attempts, 0);
});

test('two executors sharing a journal do not broadcast competing same-wallet actions', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const options = opts(rpc, [wallet], join(await temp(t), 'concurrent.sqlite'));
  const a = makeExecutor(options);
  const b = makeExecutor(options);
  closeAfter.get(t).push(() => { a.close(); b.close(); });
  const results = await Promise.all([
    a({ actionId: 'mint:a', wallet, tx }),
    b({ actionId: 'buy:b', wallet, tx }),
  ]);
  assert.equal(rpc.attempts, 1);
  assert.equal(results[0].txHash, results[1].txHash);
  assert.equal(results[0].status, 'pending');
  assert.equal(results[1].status, 'pending');
});

test('live mode fails closed when external pending nonce or balance is unsafe', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'nonce.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'mint:a', wallet, tx };
  rpc.nonce = 6;
  await assert.rejects(execute(job), /external pending transaction/);
  rpc.latestNonce = 6;
  rpc.balance = 3_600_014n;
  await assert.rejects(execute(job), /Wallet balance is below/);
  assert.equal(rpc.attempts, 0);
});

test('gas floor increases the signed limit without bypassing the cap or balance check', async (t) => {
  const wallet = Wallet.createRandom();
  const rpc = fakeRpc();
  const execute = makeExecutor(opts(rpc, [wallet], join(await temp(t), 'floor.sqlite')));
  closeAfter.get(t).push(() => execute.close());
  const job = { actionId: 'mint:last', wallet, tx };
  await assert.rejects(execute({ ...job, gasLimitFloor: 50_001n }), /Gas limit floor .* exceeds/);
  rpc.balance = 4_999_999n;
  await assert.rejects(execute({ ...job, gasLimitFloor: 50_000n }), /Wallet balance is below/);
  assert.equal(rpc.attempts, 0);
  rpc.balance = 5_000_015n;
  assert.equal((await execute({ ...job, gasLimitFloor: 50_000n })).gasLimit, '50000');
  assert.equal(rpc.signed.gasLimit, 50_000n);
});

test('loadWallets decrypts a relative keystore without exposing errors or plaintext secrets', async (t) => {
  const dir = await temp(t);
  const wallet = new Wallet(Wallet.createRandom().privateKey);
  const passwordEnv = 'CORLA_TEST_KEYSTORE_ONLY';
  const previous = process.env[passwordEnv];
  const password = 'this-is-an-ephemeral-test-password';
  t.after(() => {
    if (previous === undefined) delete process.env[passwordEnv];
    else process.env[passwordEnv] = previous;
  });
  process.env[passwordEnv] = password;
  await mkdir(join(dir, 'keys'));
  await writeFile(join(dir, 'keys', 'w.json'), await wallet.encrypt(password));
  const manifest = join(dir, 'wallets.json');
  const record = { keystore: 'keys/w.json', passwordEnv };
  await writeFile(manifest, '\uFEFF' + JSON.stringify([record]));
  const [signer] = await loadWallets(fakeRpc(), manifest);
  assert.equal(signer.address, wallet.address);
  assert.equal(typeof signer.signTransaction, 'function');
  process.env[passwordEnv] = 'WRONG-' + password;
  await assert.rejects(loadWallets(fakeRpc(), manifest), { message: 'Cannot decrypt wallet entry #1' });
});
