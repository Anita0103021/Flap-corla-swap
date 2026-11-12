import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AbiCoder, Interface, ZeroAddress, ZeroHash } from 'ethers';
import { FACTORY, address } from '../src/config.mjs';
import { createProjectMetadata, FLAP_IMAGE_ORIGIN, ipfsPath } from '../src/project-metadata.mjs';

const abi = AbiCoder.defaultAbiCoder();
const paramsType = 'tuple(tuple(uint256,uint256,uint32,bool,uint32,address[]),tuple(string,string,string,uint256,bytes32,address,uint8,uint256,uint256,uint16,uint16,uint32,uint32,tuple(uint8,uint16,bytes)[],uint8,uint32,address[],uint256,bytes32,bytes,address),tuple(uint8,address,uint128,bytes))';
const factory = new Interface([
  'function deploymentIndexPlusOne(address) view returns (uint256)',
  'function deployment(uint256) view returns (address,address,address)',
]);
const target = {
  factory: FACTORY,
  mint: address('0x4724ce75d772eda774147f6198f1a876811d6e19', 'Mint'),
  token: address('0xc402b65aa0a6ef7562a1580fd778397d6e817777', 'Token'),
};
const creator = '0x0000000000000000000000000000000000000011';
const image = 'bafkreif352bc7teyw4xh3dfo44nehfgn5qsiowxwohgei5gvyidggceicm';
const imageUrl = FLAP_IMAGE_ORIGIN + '/ipfs/' + image;
const cidv0 = 'Qm' + 'A'.repeat(44);
const initialSupply = 100n * 10n ** 18n;

function rawCid(body) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const digest = createHash('sha256').update(body).digest();
  let out = 'b', bits = 0, acc = 0;
  for (const byte of Buffer.concat([Buffer.from([1, 0x55, 0x12, 32]), digest])) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) out += alphabet[(acc >>> (bits -= 5)) & 31];
  }
  if (bits) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

function chain({ meta, name = '挑战100万u一个', symbol = '蝴蝶校长C总', index = 2n, registeredToken = target.token,
  blockTag = 'latest', supply = initialSupply }) {
  const calls = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      assert.equal(request.blockTag, blockTag);
      if (request.to === target.mint) {
        assert.equal(request.data, '0xbd4d3c40');
        return abi.encode([paramsType], [[
          [50, 100, 1, false, 0, []],
          [name, symbol, meta, supply, ZeroHash, ZeroAddress, 0, 0, 0, 300, 300, 0, 0, [], 0, 0, [], 0, ZeroHash, '0x', ZeroAddress],
          [0, ZeroAddress, 0, '0x'],
        ]]);
      }
      assert.equal(request.to, FACTORY);
      const call = factory.parseTransaction({ data: request.data });
      if (call.name === 'deploymentIndexPlusOne') {
        assert.equal(call.args[0], target.mint);
        return factory.encodeFunctionResult(call.name, [index]);
      }
      assert.equal(call.name, 'deployment');
      assert.equal(call.args[0], index - 1n);
      return factory.encodeFunctionResult(call.name, [target.mint, creator, registeredToken]);
    },
  };
}

test('uses the registered Mint creation tuple before deployment; concurrent lookups share verified media', async () => {
  const body = JSON.stringify({ image: 'ipfs://' + image, name: 'ignored metadata name', description: '  示例\n项目  ' });
  const cid = rawCid(body);
  const provider = chain({ meta: cid, blockTag: 42 });
  let fetches = 0;
  const store = createProjectMetadata({ fetchImpl: async (url, options) => {
    fetches++;
    assert.equal(url, FLAP_IMAGE_ORIGIN + '/ipfs/' + cid);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Response(body, { headers: { 'content-type': 'text/plain' } });
  } });
  const expected = { mint: target.mint, token: target.token, name: '挑战100万u一个', symbol: '蝴蝶校长C总', image: imageUrl,
    description: '示例 项目', initialSupply: initialSupply.toString() };
  assert.deepEqual(await Promise.all([store.lookup(provider, target, 42), store.lookup(provider, target, 42)]), [expected, expected]);
  assert.deepEqual(await store.lookup({}, target), expected);
  assert.equal(provider.calls.length, 3);
  assert.equal(fetches, 1);
});

test('rejects unregistered projects and a mismatched token before fetching metadata', async () => {
  const store = createProjectMetadata({ fetchImpl: () => assert.fail('must not fetch unbound content') });
  assert.equal(await store.lookup(chain({ meta: cidv0, registeredToken: creator }), target), null);
  const otherStore = createProjectMetadata({ fetchImpl: () => assert.fail('must not fetch unregistered content') });
  assert.equal(await otherStore.lookup(chain({ meta: cidv0, index: 0n }), target), null);
  assert.equal(await otherStore.lookup({}, { ...target, factory: creator }), null);
});

test('only accepts a safe IPFS reference, normalizing known gateway paths to Flap', () => {
  assert.equal(ipfsPath(image), image);
  assert.equal(ipfsPath('ipfs://ipfs/' + image + '/icons/logo.png'), image + '/icons/logo.png');
  assert.equal(ipfsPath('https://ipfs.io/ipfs/' + image), image);
  for (const value of [
    'http://127.0.0.1/ipfs/' + image, 'https://evil.invalid/ipfs/' + image,
    FLAP_IMAGE_ORIGIN + '.invalid/ipfs/' + image, FLAP_IMAGE_ORIGIN + '/ipfs/' + image + '/..',
    image + '/%2e%2e/logo.png', image + '/../logo.png', image + '//logo.png',
    image + '?q=123', image + '#fragment', 'data:image/png;base64,YQ==',
  ]) assert.equal(ipfsPath(value), null, value);
});

test('rejects a CID digest mismatch, hostile image path and oversized response without losing on-chain names', async () => {
  const bad = JSON.stringify({ image: 'http://127.0.0.1/logo' });
  const body = JSON.stringify({ image });
  const cases = [
    { meta: rawCid(body), payload: JSON.stringify({ image: cidv0, description: '摘要被篡改' }) },
    { meta: rawCid(bad), payload: bad },
    { meta: cidv0, payload: 'x'.repeat(49 * 1024) },
  ];
  for (const { meta, payload } of cases) {
    const store = createProjectMetadata({ fetchImpl: async () => new Response(payload, { headers: { 'content-type': 'application/json' } }) });
    const got = await store.lookup(chain({ meta, name: '蝴蝶\u202E人生' }), target);
    assert.equal(got.name, '蝴蝶 人生');
    assert.equal(got.image, undefined);
    assert.equal(got.description, undefined);
  }
});

test('keeps optional description plain, bounded and independent of an invalid image', async () => {
  const body = JSON.stringify({ image: 'http://127.0.0.1/private',
    description: ' 项目\u202E说明 <b>原文</b>\n' + '🦋'.repeat(185) });
  const store = createProjectMetadata({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  const got = await store.lookup(chain({ meta: rawCid(body), supply: 0n }), target);
  assert.equal(Array.from(got.description).length, 180);
  assert.ok(got.description.startsWith('项目 说明 <b>原文</b> '));
  assert.ok(got.description.endsWith('🦋'));
  assert.equal(got.image, undefined);
  assert.equal(Object.hasOwn(got, 'initialSupply'), false);
});

test('does not add description fields when metadata has no valid description', async () => {
  const body = JSON.stringify({ image, description: { html: '<img>' } });
  const store = createProjectMetadata({ fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  const got = await store.lookup(chain({ meta: rawCid(body), supply: 0n }), target);
  assert.deepEqual(got, { mint: target.mint, token: target.token, name: '挑战100万u一个', symbol: '蝴蝶校长C总', image: imageUrl });
});

test('preserves verified image and description after a transient gateway failure, with a short retry TTL', async () => {
  const body = JSON.stringify({ image, description: '缓存描述' });
  let now = 0, fetches = 0, unavailable = true;
  const provider = chain({ meta: rawCid(body) });
  const store = createProjectMetadata({ ttlMs: 100, partialTtlMs: 10, errorTtlMs: 5, now: () => now,
    fetchImpl: async () => {
      fetches++;
      if (unavailable) throw new Error('temporary gateway failure');
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    },
  });
  const partial = await store.lookup(provider, target);
  assert.equal(partial.image, undefined);
  assert.equal(partial.retryAfterMs, 10);
  now = 11;
  unavailable = false;
  const full = await store.lookup(provider, target);
  assert.equal(full.image, imageUrl);
  assert.equal(full.description, '缓存描述');
  assert.equal(full.retryAfterMs, undefined);
  unavailable = true;
  now = 112;
  const stale = await store.lookup(provider, target);
  assert.deepEqual(stale, { ...full, retryAfterMs: 10 });
  now = 121;
  assert.deepEqual(await store.lookup(provider, target), stale);
  assert.equal(fetches, 3);
  now = 123;
  unavailable = false;
  assert.deepEqual(await store.lookup(provider, target), full);
  assert.equal(fetches, 4);
});
