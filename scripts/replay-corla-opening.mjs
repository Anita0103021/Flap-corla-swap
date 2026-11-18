import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { AbiCoder, Interface, SigningKey, Transaction, ZeroAddress, computeAddress, formatEther, id, parseEther, toQuantity } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { DIRECT_LAUNCH_PORTAL } from '../src/events.mjs';
import { PANCAKE_FACTORY, ROUTER, ROUTER_ABI, WBNB, applyOpeningPriceGuard, discount, marketLimits, v2Output } from '../src/market.mjs';
import { buildPreopenBuyPlan, isVerifiedPreopenBuyPlan, preparePreopenMintSequence } from '../src/snipe-preopen.mjs';
import { makeSnipeRace } from '../src/snipe-race.mjs';
import { makeNodeRealBundleSubmitter } from '../src/snipe-bundle.mjs';

// De-identified regression fixture. Heights, hashes, timestamps and accounts
// are synthetic; no private run reports or real target identifiers are shipped.
// This is NOT an EVM/archive fork, a network endpoint, or a live test.
const historical = Object.freeze({
  blockNumber: 500, launchBlock: 501, mintedLots: 99, totalLots: 100,
  launchIndex: 86, firstBuyIndex: 87, pendingDelayMs: 459, confirmationDelayMs: 367,
  launchTxHash: id('synthetic-reference-launch'),
  firstBuyTxHash: id('synthetic-reference-first-buy'),
});
const head = Object.freeze({ number: historical.blockNumber, hash: id('synthetic-parent'), timestamp: 1_000_000 });
const launchBlockHash = id('synthetic-child');
const fork = { ...head, hash: id('synthetic-reorg') };
const addr = suffix => '0x' + suffix.padStart(40, '0');
const target = Object.freeze({ factory: FACTORY, mint: addr('33'), token: addr('44'), pricePerLot: parseEther('0.05') });
const pool = addr('55');
const seed = Object.freeze({ reserveQuote: parseEther('5'), reserveToken: parseEther('150000000') });
const trade = Object.freeze({ requirePreopen: true, repeatAttempts: 3, amountIn: parseEther('0.05'), minLiquidity: parseEther('1'),
  slippageBps: 1000, maxOpeningPremiumBps: 1000, deadlineSeconds: 12, maxBuyTaxBps: 500, maxSellTaxBps: 500,
  maxPriceImpactBps: 1000 });
const mintData = CORLA_ABI.encodeFunctionData('mint', [[]]);
const tax = 300n;
const nonce = 17;
const txGasPrice = 80_000_000n;
const mintGasLimit = 9_000_000n;
const buyGasEstimate = 225_000n;
const anchorTimeMs = 10_000;
const reportEpochMs = Date.parse('2000-01-01T00:00:00.000Z');
const portal = new Interface(['event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)']);
const factory = new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
  'function getPair(address,address) view returns (address)']);
const pair = new Interface(['event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const token = new Interface(['function mainPool() view returns (address)', 'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)', 'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const portalData = AbiCoder.defaultAbiCoder().encode(
  ['tuple(uint256,uint256,uint8,address,uint8,uint256,string,string,string,address,uint256,uint8,uint16)'],
  [[1, head.timestamp + 1, 0, ZeroAddress, 1, 1, 'Offline mock', 'MOCK', '', pool, seed.reserveToken, 0, 0]],
);
const eventLog = (abi, name, address, args) => ({ address, ...abi.encodeEventLog(abi.getEvent(name), args) });
const ok = (returnData = '0x', logs = [], gasUsed = 21_000n) => ({ status: '0x1', returnData, logs, gasUsed: toQuantity(gasUsed) });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// The fixed keys are public test vectors, computed from these labels. No
// Wallet/provider is instantiated or connected. Never use these accounts.
function offlineSigner(label) {
  const key = new SigningKey(id(`public-offline-corla-replay-v1/${label}`));
  return { address: computeAddress(key.publicKey), sign(call) {
    const unsigned = Transaction.from({ ...call, type: 0, chainId: 56 });
    unsigned.signature = key.sign(unsigned.unsignedHash);
    return Transaction.from(unsigned.serialized);
  } };
}

function signedMint(signer, gasPrice = txGasPrice) {
  const tx = signer.sign({ to: target.mint, data: mintData, value: target.pricePerLot, nonce, gasLimit: mintGasLimit, gasPrice });
  return { tx, frame: { to: tx.to, from: tx.from, hash: tx.hash, type: '0x0', nonce: toQuantity(tx.nonce), gas: toQuantity(tx.gasLimit),
    value: toQuantity(tx.value), input: tx.data, gasPrice: toQuantity(tx.gasPrice), r: tx.signature.r, s: tx.signature.s,
    v: toQuantity(tx.signature.networkV), blockNumber: null } };
}

function quoteAt(reserves) {
  const quoted = v2Output(trade.amountIn, reserves.reserveQuote, reserves.reserveToken);
  const limits = marketLimits({ ...reserves, amountIn: trade.amountIn, quoted, buyTax: tax, sellTax: tax, settings: trade });
  return applyOpeningPriceGuard({ ...reserves, ...limits, quoted, buyTax: tax, sellTax: tax }, seed, tax, trade);
}

const gross = v2Output(trade.amountIn, seed.reserveQuote, seed.reserveToken);
const initialQuote = quoteAt(seed);
const NET_OUT = discount(gross, tax);
function reservesAfter(input) {
  return { reserveQuote: seed.reserveQuote + input,
    reserveToken: seed.reserveToken - v2Output(input, seed.reserveQuote, seed.reserveToken) };
}
const netAt = r => discount(v2Output(trade.amountIn, r.reserveQuote, r.reserveToken), tax);
function firstRejectedInput() {
  let low = 0n, high = parseEther('2');
  // The single-swap counterfactual is monotone; solve the actual integer
  // boundary instead of assuming slippage equals linear reserve movement.
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (netAt(reservesAfter(mid)) < initialQuote.amountOutMin) high = mid;
    else low = mid;
  }
  return high;
}
function launchLogs(from) {
  return [eventLog(CORLA_ABI, 'Minted', target.mint, [from, historical.totalLots]),
    eventLog(CORLA_ABI, 'Launched', target.mint, [target.token, pool, from]),
    eventLog(portal, 'FlapDirectLaunched', DIRECT_LAUNCH_PORTAL,
      [target.token, 0, target.mint, id('DirectLaunchV2(DirectLaunchV2Data)'), portalData]),
    eventLog(factory, 'PairCreated', PANCAKE_FACTORY, [target.token, WBNB, pool, 1]),
    eventLog(pair, 'Mint', pool, [DIRECT_LAUNCH_PORTAL, seed.reserveToken, seed.reserveQuote]),
    eventLog(pair, 'Sync', pool, [seed.reserveToken, seed.reserveQuote])];
}

function checkBuy(call, recipient, expectedMin = initialQuote.amountOutMin) {
  assert.equal(call.to, ROUTER);
  assert.equal(BigInt(call.value), trade.amountIn);
  const { name, args } = ROUTER_ABI.parseTransaction(call);
  assert.equal(name, 'swapExactETHForTokensSupportingFeeOnTransferTokens');
  assert.equal(args[0], expectedMin);
  assert.deepEqual([...args[1]], [WBNB, target.token]);
  assert.equal(args[2], recipient);
  assert.equal(args[3], BigInt(head.timestamp + trade.deadlineSeconds));
  return args[0];
}

async function exercise(scenario, variant = {}) {
  const minter = offlineSigner('minter');
  const buyer = offlineSigner('buyer');
  const mint = signedMint(minter);
  const replacement = signedMint(minter, txGasPrice + txGasPrice / 5n);
  const activeMint = scenario === 'nonce-replacement' ? replacement : mint;
  // Simplified single swap, not a replay of the real competitor's swaps.
  const competitorInput = variant.competitorInput ?? (scenario === 'competitor-before-buy' ? parseEther('2') : undefined);
  const competing = competitorInput === undefined ? undefined : reservesAfter(competitorInput);
  const competitionNet = competing && netAt(competing);
  const competitorRevert = Boolean(competing && competitionNet < initialQuote.amountOutMin);
  const lead = variant.lead ?? 400;
  const bundleMode = variant.bundleMode;
  const unknownReceipt = scenario === 'receipt-unknown' || bundleMode === 'ack-no-inclusion' || bundleMode === 'delivery-unknown';
  const launch = { mint: target.mint, token: target.token, pool, blockNumber: historical.launchBlock,
    blockHash: launchBlockHash, txHash: activeMint.tx.hash, source: 'wss' };
  const logs = [];
  let clock = anchorTimeMs - lead, race, announced = false, simulations = 0, signatures = 0, mockSubmissions = 0;
  const feeds = [];
  let receiptPolls = 0, inspected = 0, canonicalReads = 0, rejectedPrice = false, signedSequenceMatches = false, chosenReplacement = false;
  let pendingResult, mockFailure, latestReads = 0, bundleResult, bundleHandoffs = 0;
  function announce(confirmationMs = 0) {
    if (announced) return;
    announced = true;
    clock = anchorTimeMs;
    race.noteLaunchSignal(launch, clock);
    clock += confirmationMs;
    race.noteConfirmed(launch, clock);
  }
  function sendFrame(frame, source = 0) {
    feeds[source].onTransaction(frame, { mode: 'full', seen: clock, receivedAtMs: reportEpochMs + clock - anchorTimeMs });
  }
  const provider = {
    async getBlock(tag) {
      if (tag === 'latest') {
        latestReads++;
        if (latestReads > 1 && variant.deadlineRemaining !== undefined) return {
          number: head.number + 1, hash: id('synthetic-newer-block'), timestamp: head.timestamp + trade.deadlineSeconds - variant.deadlineRemaining,
        };
        return head;
      }
      assert.equal(tag, head.number);
      canonicalReads++;
      if (scenario === 'parent-reorg' || scenario === 'parent-reorg-before-sign' && canonicalReads > 1) return fork;
      return head;
    },
    async getCode(address, at) {
      assert.equal(address, target.token);
      assert.ok(at === head.number || variant.deadlineRemaining !== undefined && at === head.number + 1);
      return '0x';
    },
    async getTransactionCount(address, at) {
      assert.ok(same(address, minter.address));
      assert.ok(at === head.number || variant.deadlineRemaining !== undefined && at === head.number + 1);
      return nonce + (scenario === 'nonce-consumed' ? 1 : 0);
    },
    async getBalance(address, at) {
      assert.equal(address, minter.address); assert.equal(at, head.number); return parseEther('1');
    },
    async send(...args) {
      try { return this.simulate(...args); }
      catch (error) { mockFailure ??= error; throw error; }
    },
    simulate(method, [payload, at]) {
      assert.equal(method, 'eth_simulateV1', 'mock provider accepts only the local simulation method');
      assert.equal(at, toQuantity(head.number));
      simulations++;
      const { calls, blockOverrides, stateOverrides } = payload.blockStateCalls[0];
      assert.equal(payload.blockStateCalls.length, 1);
      assert.equal(blockOverrides.time, toQuantity(head.timestamp + 1));
      assert.equal(stateOverrides, undefined);
      assert.equal(calls.length, simulations === 1 ? 6 : 9);
      const expected = activeMint.tx;
      assert.deepEqual(calls[0], { from: expected.from, to: expected.to, nonce: toQuantity(expected.nonce), gas: toQuantity(expected.gasLimit),
        value: toQuantity(expected.value), data: expected.data, gasPrice: toQuantity(expected.gasPrice) });
      assert.deepEqual(calls.slice(1, 6).map(call => [call.from, call.to, call.data]), [
        [buyer.address, target.token, token.encodeFunctionData('mainPool')],
        [buyer.address, target.token, token.encodeFunctionData('buyTaxRate')],
        [buyer.address, target.token, token.encodeFunctionData('sellTaxRate')],
        [buyer.address, PANCAKE_FACTORY, factory.encodeFunctionData('getPair', [WBNB, target.token])],
        [buyer.address, ROUTER, ROUTER_ABI.encodeFunctionData('getAmountsOut', [trade.amountIn, [WBNB, target.token]])],
      ]);
      const result = [ok('0x', launchLogs(expected.from), 7_100_036n), ok(token.encodeFunctionResult('mainPool', [pool])),
        ok(token.encodeFunctionResult('buyTaxRate', [tax])), ok(token.encodeFunctionResult('sellTaxRate', [tax])),
        ok(factory.encodeFunctionResult('getPair', [pool])), ok(ROUTER_ABI.encodeFunctionResult('getAmountsOut', [[trade.amountIn, gross]]))];
      if (simulations === 2) {
        const [buy, approve, sell] = calls.slice(6);
        assert.equal(buy.from, buyer.address);
        const minOut = checkBuy(buy, buyer.address);
        assert.deepEqual(approve, { from: buyer.address, to: target.token, data: token.encodeFunctionData('approve', [ROUTER, minOut]) });
        assert.equal(sell.from, buyer.address);
        assert.equal(sell.to, ROUTER);
        const decoded = ROUTER_ABI.parseTransaction(sell);
        assert.equal(decoded.name, 'swapExactTokensForETHSupportingFeeOnTransferTokens');
        assert.deepEqual([decoded.args[0], decoded.args[1], [...decoded.args[2]], decoded.args[3], decoded.args[4]],
          [minOut, initialQuote.reverseMin, [target.token, WBNB], buyer.address, BigInt(head.timestamp + trade.deadlineSeconds)]);
        const sold = v2Output(discount(minOut, tax), seed.reserveToken - gross, seed.reserveQuote + trade.amountIn);
        result.push(ok('0x', [eventLog(pair, 'Swap', pool, [ROUTER, 0, trade.amountIn, gross, 0, buyer.address]),
          eventLog(token, 'Transfer', target.token, [pool, buyer.address, NET_OUT])], buyGasEstimate), ok('0x01'),
        ok('0x', [eventLog(pair, 'Swap', pool, [ROUTER, discount(minOut, tax), 0, 0, sold, buyer.address])]));
        if (scenario === 'launch-during-simulation') announce();
      }
      return [{ parentHash: head.hash, number: toQuantity(head.number + 1), timestamp: blockOverrides.time, calls: result }];
    },
  };
  const inspectMint = async (p, checked, at) => {
    inspected++;
    assert.equal(p, provider);
    assert.ok(same(checked.mint, target.mint) && same(checked.token, target.token));
    assert.equal(at, head.number);
    return { blockNumber: at, phase: 1, launched: false, emergencyWithdrawn: false, quoteToken: ZeroAddress,
      token: ZeroAddress, pool: ZeroAddress, poolRoute: 'pancake_v2', quoteEnabled: true, fundingDeadline: BigInt(head.timestamp + 86_400),
      pricePerLot: target.pricePerLot, mintedLots: BigInt(historical.mintedLots), totalLots: BigInt(historical.totalLots) };
  };
  const execute = {
    async race(request) {
      // Exercise production beforeSign/beforeDispatch and branding; there is
      // no real executor, submission method, transaction journal, or WebSocket.
      await request.beforeSign();
      request.beforeDispatch();
      const plan = request.preopenPlan;
      assert.ok(isVerifiedPreopenBuyPlan(plan));
      assert.equal(plan.pendingHash, activeMint.tx.hash);
      assert.equal(plan.quoteBlock, head.number);
      assert.equal(plan.pool, pool);
      assert.equal(plan.gasEstimate, buyGasEstimate);
      assert.equal(plan.amountOutMin, initialQuote.amountOutMin);
      const minOut = checkBuy(request.tx, buyer.address);
      signatures++;
      const buy = buyer.sign({ ...request.tx, nonce: 8, gasLimit: 270_000n, gasPrice: txGasPrice });
      const exact = [activeMint.tx.serialized, buy.serialized].map(raw => Transaction.from(raw));
      assert.deepEqual(exact.map(tx => tx.hash), [plan.pendingHash, buy.hash]);
      assert.deepEqual(exact.map(tx => tx.from), [minter.address, buyer.address]);
      assert.ok(exact.every(tx => tx.chainId === 56n));
      assert.equal(checkBuy(exact[1], buyer.address), minOut);
      signedSequenceMatches = true;
      chosenReplacement = scenario === 'nonce-replacement' && exact[0].hash === replacement.tx.hash && replacement.tx.hash !== mint.tx.hash;
      if (bundleMode) {
        const relay = makeNodeRealBundleSubmitter({
          nowSeconds: () => head.timestamp,
          readLatestBlock: async () => bundleMode === 'stale-parent' ? fork : head,
          async transport(packet) {
            bundleHandoffs++;
            try {
              assert.equal(packet.method, 'eth_sendBundle');
              assert.deepEqual(packet.params, [{ txs: exact.map(tx => tx.serialized), maxBlockNumber: head.number + 1,
                maxTimestamp: plan.deadline, noMerge: true, revertingTxHashes: [] }]);
            } catch (error) { mockFailure ??= error; throw error; }
            if (bundleMode === 'delivery-unknown') throw new Error('synthetic disconnect after accepting request');
            return { jsonrpc: '2.0', id: packet.id, result: id('synthetic-relay-ack') };
          },
        });
        const input = { mintRaws: [exact[0].serialized], buyRaw: exact[1].serialized,
          expectedMintHashes: plan.pendingHashes, expectedBuyHash: buy.hash, parent: head, deadline: plan.deadline,
          target, expectedBuy: { ...request.tx, from: buyer.address } };
        bundleResult = await relay(input);
        if (bundleMode === 'stale-parent') {
          assert.equal(bundleResult.status, 'refused');
          assert.equal(bundleResult.reason, 'parent_changed');
          throw new Error('mock builder path rejected a changed parent before delivery');
        }
        assert.equal(bundleResult.status, bundleMode === 'delivery-unknown' ? 'unknown' : 'accepted');
        if (bundleMode === 'delivery-unknown') {
          const duplicate = await relay(input);
          assert.equal(duplicate.reason, 'previously_attempted');
        }
      }
      mockSubmissions++;
      request.onBroadcast('send', { txHash: buy.hash });
      // Mock chain ordering only. No real Builder was contacted and a
      // simulated revert does NOT estimate real gas cost or inclusion chance.
      announce();
      if (competing) {
        assert.equal(competitionNet < minOut, competitorRevert);
        try { assert.equal(quoteAt(competing).quotedNetOut, competitionNet); }
        catch (err) {
          assert.match(err.message, /超过开盘价溢价上限/);
          assert.equal(err.priceEvidence.openingAmountOutMin, minOut);
          assert.equal(err.priceEvidence.quotedNetOut, competitionNet);
          rejectedPrice = true;
        }
        assert.equal(rejectedPrice, competitorRevert, 'the interposed swap must be subject to the original price floor');
      }
      pendingResult = { actionId: request.actionId, attempt: 1, txHash: buy.hash, status: 'pending' };
      return unknownReceipt ? pendingResult : { ...pendingResult, status: competitorRevert ? 'failed' : 'confirmed', receiptBlock: historical.launchBlock };
    },
    async raceStatus() { receiptPolls++; assert.ok(pendingResult); return pendingResult; },
  };

  const abort = new AbortController();
  race = makeSnipeRace({ provider,
    prepared: { armBlock: head.number, pendingTargets: [target], wallets: [{ address: buyer.address }],
      pendingWsUrl: 'wss://offline.invalid/', pendingWsBackupUrls: variant.duplicateLag === undefined ? [] : ['wss://backup.offline.invalid/'] },
    settings: trade, signal: abort.signal, execute, log: (event, detail) => logs.push({ event, ...detail }), services: {
      nowMs: () => clock, delay: async ms => { clock += ms; },
      makePendingTransactionFeed(options) {
        assert.equal(options.wsUrl, feeds.length === 0 ? 'wss://offline.invalid/' : 'wss://backup.offline.invalid/');
        feeds.push(options);
        return { start: () => options.onStatus({ mode: 'full', healthy: true, hasFullPayload: true }), close() {} };
      },
      preparePreopenMintSequence: (p, t, candidates, settings, block, opts) =>
        preparePreopenMintSequence(p, t, candidates, settings, block, { ...opts, services: { inspectMint } }),
      buildPreopenBuyPlan,
    } });
  try {
    race.start();
    if (scenario === 'historical-late-459ms' || scenario === 'unknown-pending') {
      announce(historical.confirmationDelayMs);
      if (scenario === 'historical-late-459ms') {
        clock = anchorTimeMs + historical.pendingDelayMs;
        sendFrame(mint.frame);
      }
    } else {
      sendFrame(scenario === 'forged-mint-hash' ? { ...mint.frame, hash: id('fabricated-hash') } : mint.frame);
      if (scenario === 'nonce-replacement') sendFrame(replacement.frame);
      if (variant.duplicateLag !== undefined) {
        clock += variant.duplicateLag;
        sendFrame(mint.frame, 1); // same hash from an independent feed
      }
    }
    await tick(); // all test RPC promises settle without wall-clock latency
    announce();
    if (variant.duplicateLag !== undefined) {
      clock = anchorTimeMs + variant.unknownLag;
      sendFrame(mint.frame, 1); // same hash after confirmation, still deduplicated
      sendFrame(replacement.frame, 1); // unrelated same-nonce hash arriving after launch
    }
  } finally { await race.close(); }
  // Production deliberately masks simulator errors; don't mask our own mock assertions.
  if (mockFailure) throw mockFailure;
  const skipped = logs.filter(e => e.event === 'buy_skipped').map(e => e.error);
  const observed = logs.find(e => e.event === 'snipe_pending');
  const matched = logs.find(e => e.event === 'snipe_pending_match');
  const outcomes = logs.filter(e => e.event === 'snipe_race_outcome');
  const gate = logs.filter(e => e.event === 'snipe_pending_gate').at(-1);
  const mode = logs.filter(e => e.event === 'snipe_race_mode').at(-1);
  const send = logs.find(e => e.event === 'snipe_send');
  // These are synthetic, injected-clock deltas, not CPU/RPC/Builder timings.
  // Persist them beside the variant so replays can explain each gate decision.
  const simulatedTimingsMs = { ...(gate?.headMs === undefined ? {} : { head: gate.headMs }),
    ...(gate?.proofMs === undefined ? {} : { proof: gate.proofMs }),
    ...(mode?.planMs === undefined ? {} : { plan: mode.planMs }),
    ...(mode?.quoteMs === undefined ? {} : { inputToPlan: mode.quoteMs }),
    ...(send?.elapsedMs === undefined ? {} : { inputToHandoff: send.elapsedMs }) };
  return { scenario, inspected, simulations, signatures, mockSubmissions, receiptPolls, signedSequenceMatches, chosenReplacement,
    pendingFrames: logs.filter(e => e.event === 'snipe_pending').length, canonicalReads,
    pendingAfterLaunchMs: observed?.afterLaunchSignal ? observed.pendingReceivedAtMs - reportEpochMs : null,
    matchedPending: matched?.matchedPending ?? false, pendingLeadMs: matched?.leadMs ?? null,
    stage: gate?.preopenStage ?? null, simulatedTimingsMs,
    mockReceiptStatus: outcomes.at(-1)?.status ?? null,
    priceGuardRejected: rejectedPrice, projectedCompetitorNetOut: competing ? formatEther(competitionNet) : null,
    ...(bundleMode ? { bundleStatus: bundleResult?.status ?? null, bundleReason: bundleResult?.reason ?? null, bundleHandoffs } : {}),
    openingMinOut: formatEther(initialQuote.amountOutMin), skipped,
    ...(Object.keys(variant).length ? { variant: { ...variant, ...(competing ? { competitorInput: formatEther(competitorInput) } : {}) } } : {}) };
}

function assertFreshPlan(result, lead = 400) {
  assert.equal(result.matchedPending, true);
  assert.equal(result.pendingLeadMs, lead);
  assert.equal(result.inspected, 1);
  assert.equal(result.stage, 'ready');
  assert.equal(result.simulations, 2);
  assert.equal(result.signatures, 1);
  assert.equal(result.mockSubmissions, 1);
  assert.ok(result.signedSequenceMatches);
}
function assertNoSign(result) {
  assert.equal(result.signatures, 0);
  assert.equal(result.mockSubmissions, 0);
  assert.equal(result.mockReceiptStatus, null);
}

const cases = new Map([
  ['historical-late-459ms', result => {
    assertNoSign(result);
    assert.equal(result.inspected, 0);
    assert.equal(result.matchedPending, false);
    assert.equal(result.pendingAfterLaunchMs, 459);
    assert.equal(result.pendingFrames, 1);
  }],
  ['exact-signed-sequence', result => {
    assertFreshPlan(result);
    assert.equal(result.mockReceiptStatus, 'confirmed');
    assert.deepEqual(result.skipped, []);
  }],
  ['competitor-before-buy', result => {
    assertFreshPlan(result);
    assert.ok(result.priceGuardRejected);
    assert.ok(parseEther(result.projectedCompetitorNetOut) < parseEther(result.openingMinOut));
    assert.equal(result.mockReceiptStatus, 'failed');
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /收到开盘信号/);
  }],
  ['nonce-replacement', result => {
    assertFreshPlan(result);
    assert.equal(result.pendingFrames, 2);
    assert.ok(result.chosenReplacement);
    assert.equal(result.mockReceiptStatus, 'confirmed');
    assert.deepEqual(result.skipped, []);
  }],
  ['nonce-consumed', result => {
    assertNoSign(result);
    assert.equal(result.simulations, 0);
    assert.equal(result.stage, 'stale_pending');
    assert.deepEqual(result.skipped, []);
  }],
  ['parent-reorg', result => {
    assertNoSign(result);
    assert.equal(result.simulations, 2);
    assert.equal(result.canonicalReads, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /父块已经重组/);
  }],
  ['parent-reorg-before-sign', result => {
    assertNoSign(result);
    assert.equal(result.simulations, 2);
    assert.equal(result.canonicalReads, 2);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /过期或重组/);
  }],
  ['launch-during-simulation', result => {
    assertNoSign(result);
    assert.equal(result.simulations, 2);
    assert.equal(result.pendingLeadMs, 400);
    assert.deepEqual(result.skipped, []);
  }],
  ['unknown-pending', result => {
    assertNoSign(result);
    assert.equal(result.inspected, 0);
    assert.equal(result.pendingFrames, 0);
    assert.equal(result.matchedPending, false);
  }],
  ['receipt-unknown', result => {
    assertFreshPlan(result);
    assert.equal(result.mockReceiptStatus, 'pending');
    assert.ok(result.receiptPolls > 0);
    assert.deepEqual(result.skipped, []);
  }],
  ['forged-mint-hash', result => {
    assertNoSign(result);
    assert.equal(result.simulations, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /签名与交易哈希/);
  }],
]);

function seededCases(seed) {
  // Mulberry32: deterministic even for seed 0, never consults system entropy.
  let state = seed;
  const next = (min, max) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return min + ((t ^ t >>> 14) >>> 0) % (max - min + 1);
  };
  const lead = next(12, 500);
  const deadlineRemaining = next(1, 3);
  const duplicateLag = next(1, lead - 1);
  const unknownLag = next(1, 800);
  const boundary = firstRejectedInput();
  const offset = BigInt(next(1, 250_000)) * 1_000_000_000n;
  return [
    ['seeded-cross-feed-duplicates', result => {
      assertFreshPlan(result, lead);
      assert.equal(result.pendingFrames, 2, 'duplicates on another feed cannot overwrite the first arrival');
      assert.equal(result.mockReceiptStatus, 'confirmed');
      assert.deepEqual(result.skipped, []);
    }, { lead, duplicateLag, unknownLag }],
    ['seeded-sign-deadline', result => {
      assert.equal(result.simulations, 2);
      assert.equal(result.canonicalReads, 2);
      if (deadlineRemaining <= 2) {
        assertNoSign(result);
        assert.equal(result.skipped.length, 1);
        assert.match(result.skipped[0], /过期或重组/);
      } else {
        assertFreshPlan(result, lead);
        assert.equal(result.mockReceiptStatus, 'confirmed');
        assert.deepEqual(result.skipped, []);
      }
    }, { lead, deadlineRemaining }],
    ...[false, true].map(above => [above ? 'seeded-price-above-cap' : 'seeded-price-below-cap', result => {
      assertFreshPlan(result, lead);
      assert.equal(result.priceGuardRejected, above);
      assert.equal(result.mockReceiptStatus, above ? 'failed' : 'confirmed');
      assert.equal(result.skipped.length, above ? 1 : 0);
      if (above) assert.match(result.skipped[0], /收到开盘信号/);
    }, { lead, competitorInput: above ? boundary + offset : boundary - offset }]),
    ...['ack-included', 'ack-no-inclusion', 'delivery-unknown', 'stale-parent'].map(bundleMode => [
      `ordered-bundle-${bundleMode}`, result => {
        if (bundleMode === 'stale-parent') {
          assert.equal(result.bundleStatus, 'refused');
          assert.equal(result.bundleReason, 'parent_changed');
          assert.equal(result.bundleHandoffs, 0);
          assert.equal(result.mockSubmissions, 0);
          assert.equal(result.mockReceiptStatus, null);
        } else {
          assertFreshPlan(result, lead);
          assert.equal(result.bundleStatus, bundleMode === 'delivery-unknown' ? 'unknown' : 'accepted');
          assert.equal(result.bundleHandoffs, 1);
          assert.equal(result.mockReceiptStatus, bundleMode === 'ack-included' ? 'confirmed' : 'pending');
          if (bundleMode !== 'ack-included') assert.ok(result.receiptPolls > 0);
        }
      }, { lead, bundleMode },
    ]),
  ];
}

export const REPLAY_SCHEMA_VERSION = 2;
export const REPLAY_SCENARIO_NAMES = Object.freeze([...cases.keys(),
  'seeded-cross-feed-duplicates', 'seeded-sign-deadline', 'seeded-price-above-cap', 'seeded-price-below-cap',
  ...['ack-included', 'ack-no-inclusion', 'delivery-unknown', 'stale-parent'].map(mode => `ordered-bundle-${mode}`),
]);

export async function replayCorlaOpening({ seed: seedNumber = 0 } = {}) {
  if (!Number.isInteger(seedNumber) || seedNumber < 0 || seedNumber > 0xffff_ffff) throw new RangeError('seed must be uint32');
  const scenarios = [];
  for (const [name, verify, variant] of [...cases, ...seededCases(seedNumber)]) {
    let result;
    try {
      result = await exercise(name, variant);
      verify(result);
      scenarios.push({ ...result, name, passed: true });
    } catch (error) {
      scenarios.push({ scenario: name, ...result, name, passed: false, assertion: error.message });
    }
  }
  return { schemaVersion: REPLAY_SCHEMA_VERSION, mode: 'offline-mock-historical-parent', seed: seedNumber,
    scenarioCount: REPLAY_SCENARIO_NAMES.length, timingBasis: 'injected-synthetic-clock', historicalParent: historical,
    historicalOpeningMath: { amountInBnb: formatEther(trade.amountIn), reserveWbnb: formatEther(seed.reserveQuote),
      reserveTokens: formatEther(seed.reserveToken), buyTaxBps: Number(tax), openingNetOut: formatEther(NET_OUT),
      openingMinOut: formatEther(initialQuote.amountOutMin), pricePremiumCapBps: trade.maxOpeningPremiumBps },
    sideEffects: { networkRequests: 0, liveTransactions: 0, walletFiles: 0 }, passed: scenarios.every(row => row.passed), scenarios };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const usage = 'Usage: node scripts/replay-corla-opening.mjs [--json] [--seed <uint32>]';
  let seedNumber, json = false, invalid = false;
  if (!(args.length === 1 && args[0] === '--help')) for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--seed' && seedNumber === undefined && /^\d{1,10}$/.test(args[i + 1] ?? '')) {
      seedNumber = Number(args[++i]);
      if (seedNumber > 0xffff_ffff) invalid = true;
    } else invalid = true;
  }
  if (invalid) {
    console.error(usage);
    process.exitCode = 2;
  } else if (args[0] === '--help') {
    console.log(usage);
    console.log('De-identified offline Corla replay. No network, config, wallets, or broadcasting. JSON on stdout by default.');
  } else {
    const result = await replayCorlaOpening({ seed: seedNumber });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  }
}
