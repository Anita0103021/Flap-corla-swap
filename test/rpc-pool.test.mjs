import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { keccak256 } from 'ethers';
import { createRpcPool, isDefinitelyNotSubmitted } from '../src/rpc-pool.mjs';

const fast = 'https://bsc-rpc.publicnode.com';
const backup = 'https://bsc-dataseed.bnbchain.org';
const third = 'https://bsc.nodereal.io';
const name = url => new URL(url).hostname;
const fail = (message, code = -32000, data) => ({ rpcError: { code, message, data } });
const limited = seconds => new Response('limited', { status: 429, headers: { 'retry-after': String(seconds) } });
const logFilter = [{ address: '0x4bdd60107d9a1da95e03be6b6e972fa57ea62fd3', fromBlock: '0x63f', toBlock: '0x640' }];
const tx = '0x' + 'ab'.repeat(80);

function fixture(t, handlers, options = {}) {
  const calls = [];
  let clock = 100_000;
  const provider = createRpcPool(Object.keys(handlers), {
    lowLatency: true, cooldownMs: 100, probeIntervalMs: 100_000, now: () => clock, ...options,
    fetch: async (url, { body, signal, headers, redirect }) => {
      const original = JSON.parse(typeof body === 'string' ? body : await new Response(body).text());
      const requests = Array.isArray(original) ? original : [original];
      const key = Object.keys(handlers).find(k => new URL(k).hostname === new URL(url).hostname);
      const handle = handlers[key];
      calls.push(...requests.map(request => ({ key, ...request, batch: Array.isArray(original), headers, redirect })));
      if (requests.length > 1 && options.rejectBatch === key) return new Response('batch unsupported', { status: 400 });
      const packets = [];
      for (const p of requests) {
        const v = await handle?.(p, signal);
        if (v instanceof Response) return v;
        const result = v === undefined ? p.method === 'eth_chainId' ? '0x38' :
          p.method === 'eth_blockNumber' ? '0x640' :
          p.method === 'eth_getLogs' ? [] :
          p.method === 'eth_simulateV1' ? [{ calls: [{ status: '0x1' }] }] :
          p.method === 'eth_gasPrice' ? '0x12' : '0x' : v;
        packets.push({ jsonrpc: '2.0', id: p.id, ...('rpcError' in Object(result) ? { error: result.rpcError } : { result }) });
      }
      return Response.json(Array.isArray(original) ? packets : packets[0]);
    },
  });
  t.after(() => provider.destroy());
  const op = method => calls.filter(x => x.method === method && x.id < 2_000_000_000);
  return { provider, op, calls, advance: n => { clock += n; } };
}

test('benchmarks chain 56, skips a wrong chain, and returns to the fastest RPC after Retry-After', async t => {
  let blocked = false;
  const { provider, op, calls, advance } = fixture(t, {
    [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(40); },
    [fast]: p => {
      if (blocked && p.method === 'eth_gasPrice') return limited(3);
      if (p.method === 'eth_gasPrice') return '0x11';
    },
    [third]: p => { if (p.method === 'eth_chainId') return '0x1'; },
  });
  assert.equal((await provider.getNetwork()).chainId, 56n);
  assert.equal(provider.rpcStatus().primary, name(fast));
  assert.equal(provider.rpcStatus().active, name(fast));
  assert.equal(provider.rpcStatus().endpoints.find(e => e.name === name(third)).state, 'wrong-chain');
  assert.equal(await provider.send('eth_gasPrice', []), '0x11');
  blocked = true;
  assert.equal(await provider.send('eth_gasPrice', []), '0x12');
  assert.equal(provider.rpcStatus().active, name(backup));
  assert.equal(provider.rpcStatus().primary, name(fast));
  assert.equal(provider.rpcStatus().endpoints.find(e => e.name === name(fast)).retryAt, 103_000);
  assert.equal(await provider.send('eth_gasPrice', []), '0x12');
  const before = calls.filter(x => x.key === fast && x.id >= 2_000_000_000).length;
  advance(2999);
  await provider.refreshRpc();
  assert.equal(calls.filter(x => x.key === fast && x.id >= 2_000_000_000).length, before);
  advance(1);
  blocked = false;
  await provider.refreshRpc();
  assert.equal(provider.rpcStatus().active, name(fast));
  assert.equal(await provider.send('eth_gasPrice', []), '0x11');
  assert.deepEqual(op('eth_gasPrice').map(x => x.key), [fast, fast, backup, backup, fast]);
});

test('periodic probing automatically recovers and fails back without another user request', async t => {
  let blocked = true;
  const { provider } = fixture(t, {
    [fast]: p => blocked && p.method === 'eth_gasPrice' ? fail('Too Many Requests', -32005) : undefined,
    [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(28); },
  }, { now: Date.now, cooldownMs: 100 });
  await provider.readyRpc();
  assert.equal(provider.rpcStatus().active, name(fast));
  await provider.send('eth_gasPrice', []);
  assert.equal(provider.rpcStatus().active, name(backup));
  blocked = false;
  for (let i = 0; i < 40 && provider.rpcStatus().active !== name(fast); i++) await wait(15);
  assert.equal(provider.rpcStatus().active, name(fast));
});

test('checks method compatibility before arming and records method-specific fallback separately', async t => {
  const mock = {
    [fast]: p => p.method === 'eth_getLogs' ? fail('limit exceeded', -32005) : undefined,
    [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(35); },
    [third]: async p => {
      if (p.id >= 2_000_000_000 && p.method === 'eth_getLogs') await wait(38);
      if (p.method === 'eth_simulateV1') return fail('the method eth_simulateV1 does not exist/is not available', -32601);
    },
  };
  const watch = fixture(t, mock, { requiredMethods: ['eth_getLogs', 'eth_simulateV1'] });
  await watch.provider.readyRpc();
  assert.equal(watch.provider.rpcStatus().active, name(backup));
  assert.deepEqual(await watch.provider.send('eth_getLogs', logFilter), []);
  assert.deepEqual(watch.op('eth_getLogs').map(x => x.key), [backup]);
  const common = fixture(t, { [fast]: mock[fast], [backup]: mock[backup] });
  await common.provider.readyRpc();
  assert.equal(common.provider.rpcStatus().active, name(fast));
  for (let i = 0; i < 2; i++) assert.deepEqual(await common.provider.send('eth_getLogs', logFilter), []);
  assert.deepEqual(common.op('eth_getLogs').map(x => x.key), [fast, backup, backup]);
  assert.equal(common.provider.rpcStatus().endpoints.find(e => e.name === name(fast)).state, 'healthy');
  assert.equal(await common.provider.send('eth_gasPrice', []), '0x12');
  assert.deepEqual(common.op('eth_gasPrice').map(x => x.key), [fast]);
});

test('only a pinned block availability error is retried; contract reverts remain authoritative', async t => {
  let pinned = true;
  const { provider, op } = fixture(t, {
    [fast]: p => p.method === 'eth_getLogs' ? fail('block range extends beyond current head block') :
      p.method === 'eth_call' ? pinned ? fail('header not found') :
      fail('execution reverted: rate limit test', 3, '0x') : undefined,
    [backup]: async p => {
      if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(35);
      if (p.method === 'eth_call') return '0xab';
    },
  });
  const msg = [{ to: '0x0000000000000000000000000000000000000004', data: '0xab' }, '0x640'];
  assert.equal(await provider.send('eth_call', msg), '0xab');
  pinned = false;
  await assert.rejects(provider.send('eth_call', msg), { code: 'CALL_EXCEPTION' });
  assert.deepEqual(op('eth_call').map(x => x.key), [fast, backup, fast]);
  assert.deepEqual(await provider.send('eth_getLogs', logFilter), []);
  assert.deepEqual(op('eth_getLogs').map(x => x.key), [fast, backup]);
  assert.equal(provider.rpcStatus().active, name(fast));
});

test('stale low-latency nodes and chain verification failures are never used', async t => {
  const { provider, op } = fixture(t, {
    [fast]: p => p.method === 'eth_blockNumber' ? '0x520' : undefined,
    [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(36); },
  });
  assert.equal(await provider.getBlockNumber(), 0x640);
  assert.equal(provider.rpcStatus().endpoints.find(e => e.name === name(fast)).reason, 'stale-head');
  assert.deepEqual(op('eth_blockNumber').map(x => x.key), [backup]);
  const wrong = fixture(t, { [fast]: p => p.method === 'eth_chainId' ? '0x1' : undefined });
  await assert.rejects(wrong.provider.getNetwork(), /chain ID 56/);
  await assert.rejects(wrong.provider.send('eth_gasPrice', []), /chain ID 56/);
  assert.equal(wrong.op('eth_gasPrice').length, 0);
});

test('a read timeout switches immediately to a healthy standby', async t => {
  const { provider, op } = fixture(t, {
    [fast]: async (p, signal) => {
      if (p.id < 2_000_000_000 && p.method === 'eth_getBalance') await wait(300, undefined, { signal });
    },
    [backup]: async p => {
      if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(38);
      if (p.method === 'eth_getBalance') return '0x11';
    },
  }, { requestTimeoutMs: 25 });
  assert.equal(await provider.send('eth_getBalance', ['0x0000000000000000000000000000000000000004', 'latest']), '0x11');
  assert.deepEqual(op('eth_getBalance').map(x => x.key), [fast, backup]);
  assert.equal(provider.rpcStatus().endpoints.find(e => e.name === name(fast)).reason, 'timeout');
  assert.equal(provider.rpcStatus().active, name(backup));
});

test('an in-flight success does not undo a newer rate-limit cooldown', async t => {
  let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const { provider } = fixture(t, {
    [fast]: async p => {
      if (p.method === 'eth_gasPrice') { started(); await hold; return '0x11'; }
      if (p.method === 'eth_getBalance') return limited(3);
    },
    [backup]: async p => {
      if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(40);
      if (p.method === 'eth_getBalance') return '0x21';
    },
  });
  const request = provider.send('eth_gasPrice', []);
  await entered;
  try {
    assert.equal(await provider.send('eth_getBalance', []), '0x21');
    assert.equal(provider.rpcStatus().active, name(backup));
  } finally { release(); }
  assert.equal(await request, '0x11');
  assert.equal(provider.rpcStatus().active, name(backup));
});

test('mixed batches preserve successes and retry only the throttled read', async t => {
  const { provider, op } = fixture(t, {
    [fast]: p => p.method === 'eth_getBalance' ? fail('request quota exceeded', -32005) : undefined,
    [backup]: async p => {
      if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(30);
      if (p.method === 'eth_getBalance') return '0x21';
    },
  });
  await provider.readyRpc();
  assert.deepEqual(await Promise.all([provider.send('eth_gasPrice', []), provider.send('eth_getBalance', [])]), ['0x12', '0x21']);
  assert.deepEqual(op('eth_gasPrice').map(x => [x.key, x.batch]), [[fast, true]]);
  assert.deepEqual(op('eth_getBalance').map(x => [x.key, x.batch]), [[fast, true], [backup, false]]);
});

test('gateways that reject JSON-RPC batches are learned without invalidating the node', async t => {
  const { provider, op } = fixture(t, { [fast]: () => undefined }, { rejectBatch: fast });
  await provider.readyRpc();
  await Promise.all([provider.send('eth_gasPrice', []), provider.send('eth_getBalance', [])]);
  await Promise.all([provider.send('eth_gasPrice', []), provider.send('eth_getBalance', [])]);
  assert.deepEqual(op('eth_gasPrice').map(x => x.batch), [true, false, false]);
  assert.equal(provider.rpcStatus().active, name(fast));
});

test('raw broadcast retries identical bytes only on explicit rejection; ambiguous errors never rebroadcast', async t => {
  const run = async (outcome, allowed) => {
    const { provider, op } = fixture(t, {
      [fast]: p => p.method === 'eth_sendRawTransaction' ? outcome() : undefined,
      [backup]: async p => {
        if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(30);
        if (p.method === 'eth_sendRawTransaction') return '0x' + '01'.repeat(32);
      },
    });
    const send = provider.send('eth_sendRawTransaction', [tx]);
    if (allowed) assert.equal(await send, '0x' + '01'.repeat(32));
    else await assert.rejects(send, e => !e.message.includes(tx) && !isDefinitelyNotSubmitted(e));
    assert.deepEqual(op('eth_sendRawTransaction').map(p => [p.key, p.params[0], p.batch]),
      [[fast, tx, false], ...(allowed ? [[backup, tx, false]] : [])]);
  };
  await run(() => limited(1), true);
  await run(() => fail('Rate limit reached', -32005), false);
  await run(() => fail('broadcast status unknown: upstream rate limit', 429), false);
  await run(() => fail('limit exceeded', -32005), false);
  await run(() => new Response('', { status: 502 }), false);
  await run(() => fail('nonce too low (' + tx + ')'), false);
});

test('one-shot raw submission never uses a standby after the first POST, including HTTP 429', async t => {
  for (const [response, definite] of [[() => limited(3), true], [() => fail('rate limit', 429), false],
    [() => new Response('', { status: 504 }), false]]) {
    const { provider, op } = fixture(t, {
      [fast]: p => p.method === 'eth_sendRawTransaction' ? response() : undefined,
      [backup]: async p => {
        if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(30);
        if (p.method === 'eth_sendRawTransaction') return '0x' + '01'.repeat(32);
      },
    });
    await assert.rejects(provider.submitRawTransaction(tx, { singleSubmission: true }), error =>
      isDefinitelyNotSubmitted(error, keccak256(tx)) === definite && !error.message.includes(tx));
    assert.deepEqual(op('eth_sendRawTransaction').map(p => [p.key, p.params[0], p.batch]), [[fast, tx, false]]);
  }
});

test('one-shot raw submission prevents native fetch from replaying the POST on HTTP 421', async t => {
  let posts = 0;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const packet = JSON.parse(text);
    if (packet.method === 'eth_sendRawTransaction') {
      posts++;
      assert.equal(Number(req.headers['content-length']), Buffer.byteLength(text));
      assert.equal(packet.params[0], tx);
      res.writeHead(421).end();
    } else {
      const result = packet.method === 'eth_chainId' ? '0x38' : '0x640';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: packet.id, result }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createRpcPool(['http://127.0.0.1:' + server.address().port]);
  t.after(async () => {
    provider.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(provider.submitRawTransaction(tx, { singleSubmission: true }), /submission outcome unknown/);
  assert.equal(posts, 1);
});

test('stopping during an explicit raw rejection does not hand the transaction to the standby', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stop = new AbortController();
  const { provider, op } = fixture(t, {
    [fast]: async p => {
      if (p.method === 'eth_sendRawTransaction') { entered.resolve(); await release.promise; return limited(3); }
    },
    [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(40); },
  });
  const request = provider.submitRawTransaction(tx, { signal: stop.signal });
  await entered.promise;
  stop.abort();
  release.resolve();
  await assert.rejects(request, e => isDefinitelyNotSubmitted(e, keccak256(tx)) &&
    !isDefinitelyNotSubmitted(e, keccak256('0x12')));
  assert.deepEqual(op('eth_sendRawTransaction').map(p => p.key), [fast]);
  await assert.rejects(provider.submitRawTransaction(tx, { signal: stop.signal }), e => isDefinitelyNotSubmitted(e));
  assert.equal(op('eth_sendRawTransaction').length, 1);
});

test('all attempted HTTP 429s are definite refusals but a later ambiguous result is not', async t => {
  for (const second of [() => limited(2), () => new Response(null, { status: 503 })]) {
    const { provider, op } = fixture(t, {
      [fast]: p => p.method === 'eth_sendRawTransaction' ? limited(1) : undefined,
      [backup]: async p => {
        if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(35);
        if (p.method === 'eth_sendRawTransaction') return second();
      },
    });
    await assert.rejects(provider.submitRawTransaction(tx), error =>
      isDefinitelyNotSubmitted(error) === (second().status === 429) && !error.message.includes(tx));
    assert.deepEqual(op('eth_sendRawTransaction').map(p => p.key), [fast, backup]);
  }
});

test('a receipt null tries bounded alternate healthy nodes without penalizing them', async t => {
  const hash = '0x' + '02'.repeat(32);
  const found = { transactionHash: hash, blockHash: '0x' + '03'.repeat(32) };
  let indexing = true;
  const fourth = 'https://bsc.drpc.org';
  const mock = (delay, result = () => null) => async p => {
    if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber' && delay) await wait(delay);
    if (p.method === 'eth_getTransactionReceipt') return result();
  };
  const { provider, op } = fixture(t, {
    [fast]: mock(0),
    [backup]: mock(35, () => indexing ? found : null),
    [third]: mock(60),
    [fourth]: mock(95),
  });
  assert.deepEqual(await provider.send('eth_getTransactionReceipt', [hash]), found);
  assert.deepEqual(op('eth_getTransactionReceipt').map(p => p.key), [fast, backup]);
  indexing = false;
  assert.equal(await provider.send('eth_getTransactionReceipt', [hash]), null);
  assert.deepEqual(op('eth_getTransactionReceipt').slice(2).map(p => p.key), [fast, backup, third]);
  assert.ok(provider.rpcStatus().endpoints.every(e => e.state === 'healthy'));
});

test('oversized RPC bodies are cancelled both on Content-Length and on streaming byte limit', async t => {
  const chunks = ['{"partial":"', '你'.repeat(150), '"}'].map(s => new TextEncoder().encode(s));
  for (const withLength of [false, true]) {
    let pulled = 0, cancelled = false;
    const { provider, op } = fixture(t, {
      [fast]: p => p.method === 'eth_getLogs' ? new Response(new ReadableStream({
        pull(c) {
          // Stay open after the over-limit chunk to verify the read does not
          // await EOF and cancels the remaining body.
          if (pulled < chunks.length) c.enqueue(chunks[pulled++]);
        },
        cancel() { cancelled = true; },
      }), { headers: withLength ? { 'content-length': '10000' } : {} }) : undefined,
      [backup]: async p => { if (p.id >= 2_000_000_000 && p.method === 'eth_blockNumber') await wait(30); },
    }, { maxResponseBytes: 256 });
    assert.deepEqual(await provider.send('eth_getLogs', logFilter), []);
    assert.equal(cancelled, true);
    assert.ok(withLength ? pulled <= 1 : pulled >= 2);
    assert.deepEqual(op('eth_getLogs').map(p => p.key), [fast, backup]);
    assert.ok(provider.rpcStatus().endpoints.every(e => e.state === 'healthy'));
  }
});

test('status and errors never reveal custom RPC URL or credentials and transport does not follow redirects', async t => {
  const custom = 'http://username:p%40ssword@127.0.0.1:8555/private-key?q=query-key';
  const { provider, op } = fixture(t, {
    [custom]: p => p.method === 'eth_gasPrice' ? fail('provider says ' + custom + ' username p@ssword private-key query-key') : undefined,
  });
  await provider.readyRpc();
  assert.equal(provider.rpcStatus().active, '自定义 RPC 1');
  await assert.rejects(provider.send('eth_gasPrice', []), e =>
    !/username|p@ssword|p%40ssword|private-key|query-key|127\.0\.0\.1/.test(e.message + JSON.stringify(e)));
  assert.equal(op('eth_gasPrice')[0].redirect, 'error');
  assert.equal(op('eth_gasPrice')[0].headers.authorization, 'Basic ' + Buffer.from('username:p@ssword').toString('base64'));
});
