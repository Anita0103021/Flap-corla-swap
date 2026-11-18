import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ContractFactory, Interface, JsonRpcProvider, SigningKey, computeAddress, getCreateAddress, keccak256, parseEther, toQuantity } from 'ethers';
import { firstBuyArtifact } from '../src/firstbuy-contract.mjs';
import { BUILTIN_WATCH_RPC_URLS } from '../src/rpc-config.mjs';
import { FACTORY } from '../src/config.mjs';
import { prepareFirstBuyTarget } from '../src/firstbuy-prepare.mjs';
import { reconstructSignedBscTx } from './replay-firstbuy-fork.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const TOKEN = new Interface(['function balanceOf(address) view returns(uint256)']);

/** Actual historical node-EVM execution with CREATE and real protocol state.
 * This is NOT an Anvil pass, network-race test, or full historical block replay.
 * RPC whitelist below contains no broadcast/sendTransaction method. */
export async function replayFirstBuyHistoricalSimulation({ fixturePath, preparedPath, rpcUrls = BUILTIN_WATCH_RPC_URLS } = {}) {
  const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  const [fixture, prepared] = await Promise.all([json(fixturePath), json(preparedPath)]);
  const launch = reconstructSignedBscTx(fixture.entries[0].transaction), competitor = reconstructSignedBscTx(fixture.entries[1].transaction);
  const parent = Number(fixture.before.number), parentHash = fixture.before.hash, timestamp = Number(fixture.before.timestamp);
  assert.equal(prepared.head.number, parent);
  assert.ok(same(prepared.head.hash, parentHash));
  assert.ok(same(prepared.mint, launch.to));
  const rpc = new URL(rpcUrls[0]);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.search || rpc.hash) throw new Error('PUBLIC_HTTPS_RPC_REQUIRED');
  const READ_ONLY = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getCode',
    'eth_call', 'eth_getStorageAt', 'eth_blockNumber', 'eth_getLogs', 'eth_simulateV1']);
  class HistoricalReadOnlyProvider extends JsonRpcProvider {
    send(method, params) {
      if (!READ_ONLY.has(method)) throw new Error('READ_ONLY_METHOD_REQUIRED');
      return super.send(method, params);
    }
  }
  const provider = new HistoricalReadOnlyProvider(rpc.href, 56, { cacheTimeout: -1, batchMaxCount: 1 });
  const report = { schemaVersion: 1, mode: 'historical_eth_simulateV1_real_evm', passed: false, time: new Date().toISOString(),
    parentBlock: parent, parentBlockHash: parentHash,
    originalLaunchHash: launch.hash, originalCompetitorHash: competitor.hash,
    interpretation: '节点在真实历史父块执行生产执行器CREATE及自定义调用顺序；只有公开测试owner的原生余额被覆盖，不修改协议storage、真实minter资格、nonce或Token余额。不是完整历史块/网络传播/Builder排名回放。',
    effects: { broadcasts: 0, realDeployments: 0, realWallets: 0, overrideKind: 'public_test_owner_native_balance_only' }, scenarios: [] };
  let stage = 'verify_parent';
  try {
    assert.equal((await provider.getNetwork()).chainId, 56n);
    const header = await provider.getBlock(parent);
    assert.ok(same(header.hash, parentHash));
    const owner = computeAddress(new SigningKey(keccak256(Buffer.from('corla-firstbuy-public-historical-fixture-v1'))).publicKey);
    stage = 'verify_test_owner_nonce';
    const nonce = await provider.getTransactionCount(owner, parent);
    assert.equal(nonce, 0, 'public fixture owner must have no historical nonce');
    stage = 'verify_test_owner_code';
    assert.equal(await provider.getCode(owner, parent), '0x', 'test owner must not have historical contract code');
    const address = getCreateAddress({ from: owner, nonce });
    stage = 'verify_test_create_address';
    assert.equal(await provider.getCode(address, parent), '0x', 'CREATE address must be empty at parent');
    stage = 'prepare_historical_anchor';
    const pinned = new Proxy(provider, { get(object, key) {
      if (key === 'getBlock') return block => object.getBlock(block === 'latest' ? parent : block);
      const value = Reflect.get(object, key);
      return typeof value === 'function' ? value.bind(object) : value;
    } });
    const saved = prepared.armParams;
    const plan = await prepareFirstBuyTarget({ provider: pinned, target: { factory: FACTORY, mint: launch.to, token: prepared.token }, owner,
      settings: { amountIn: BigInt(saved.amountIn), gasLimit: BigInt(saved.maxBuyGas) + 160_000n,
        maxGasPriceWei: BigInt(saved.maxGasPriceWei), maxAttempts: Number(saved.maxAttempts),
        windowBlocks: Number(saved.validUntilBlock) - parent, deadlineSeconds: Number(saved.deadline) - timestamp },
      simulationSenders: [launch.from] });
    report.anchorPreparation = { owner, evidenceHash: plan.evidence.hash, parentHash: plan.evidence.parentHash,
      kind: plan.evidence.kind, hypotheticalSenderAndOwnerNativeBalanceOverride: true, protocolStorageOverride: false,
      actualScenarioOverrides: 'public_fixture_owner_native_balance_only' };
    const artifact = await firstBuyArtifact(), abi = new Interface(artifact.abi);
    const init = (await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(owner, [])).data;
    const p = { ...plan.armParams };
    // Hash is an identifier, never an on-chain proof of this read-only result.
    report.anchorEvidenceHash = p.evidenceHash;
    const create = { from: owner, nonce: toQuantity(nonce), data: init, gas: toQuantity(5_000_000) };
    const call = (name, args = [], extra = {}) => ({ from: owner, to: address, data: abi.encodeFunctionData(name, args), gas: toQuantity(2_000_000), ...extra });
    const arm = call('arm', [p], { value: toQuantity(BigInt(p.amountIn)) });
    const intent = keccak256((await import('ethers')).AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'address', 'address', 'uint256', abi.getFunction('arm').inputs[0]], [56, address, owner, 1, p]));
    const execute = call('execute', [intent], { gasPrice: toQuantity(BigInt(p.maxGasPriceWei)) });
    const originalCall = tx => ({ from: tx.from, to: tx.to, value: toQuantity(tx.value), data: tx.data,
      nonce: toQuantity(tx.nonce), gas: toQuantity(tx.gasLimit),
      ...(tx.type === 2 ? { maxFeePerGas: toQuantity(tx.maxFeePerGas), maxPriorityFeePerGas: toQuantity(tx.maxPriorityFeePerGas) }
        : { gasPrice: toQuantity(tx.gasPrice) }) });
    const mint = originalCall(launch), rival = originalCall(competitor);
    const ownerView = call('owner'), readArm = call('readArm');
    const tokenBalance = { from: owner, to: prepared.token, data: TOKEN.encodeFunctionData('balanceOf', [owner]) };
    function events(row, name) {
      return (row.logs ?? []).flatMap(log => {
        if (!same(log.address, address)) return [];
        try { const decoded = abi.parseLog(log); return decoded?.name === name ? [decoded.args] : []; }
        catch { return []; }
      });
    }
    async function simulate(calls) {
      // There are no stateDiff/storage/code/nonce overrides in this request.
      const result = await provider.send('eth_simulateV1', [{ blockStateCalls: [{
        blockOverrides: { time: toQuantity(timestamp + 1), gasLimit: toQuantity(50_000_000) },
        stateOverrides: { [owner]: { balance: toQuantity(parseEther('100')) } }, calls,
      }], validation: false }, toQuantity(parent)]);
      assert.ok(Array.isArray(result) && result.length === 1);
      assert.ok(same(result[0].parentHash, parentHash));
      assert.equal(Number(result[0].number), parent + 1);
      assert.equal(Number(result[0].timestamp), timestamp + 1);
      assert.equal(result[0].calls.length, calls.length);
      return result[0].calls;
    }
    stage = 'mint_then_firstbuy';
    const won = await simulate([create, ownerView, arm, execute, mint, execute, execute, readArm, tokenBalance]);
    assert.equal(won[0].status, '0x1', 'production CREATE succeeds');
    assert.ok(same(abi.decodeFunctionResult('owner', won[1].returnData)[0], owner));
    assert.equal(won[2].status, '0x1', 'arm succeeds against actual pinned Corla identity');
    assert.equal(won[3].status, '0x1');
    assert.equal(abi.decodeFunctionResult('execute', won[3].returnData)[0], false);
    assert.equal(events(won[3], 'Filled').length, 0);
    assert.equal(won[4].status, '0x1', 'real final minter succeeds without eligibility overrides');
    assert.equal(won[5].status, '0x1');
    const filled = events(won[5], 'Filled');
    assert.equal(filled.length, 1, 'real Router purchase emits Filled');
    assert.ok(same(filled[0].intentId, intent));
    assert.ok(same(filled[0].recipient, owner));
    assert.ok(filled[0].amountOut >= BigInt(p.minOut));
    assert.equal(abi.decodeFunctionResult('execute', won[5].returnData)[0], true);
    assert.equal(won[6].status, '0x0', 'duplicate purchase is rejected');
    const state = abi.decodeFunctionResult('readArm', won[7].returnData);
    assert.equal(state[2], 2n);
    assert.equal(state[3], 2n);
    assert.equal(TOKEN.decodeFunctionResult('balanceOf', won[8].returnData)[0], filled[0].amountOut);
    report.scenarios.push({ name: 'create_arm_before_open_no_buy_then_mint_firstbuy_once', passed: true,
      beforeOpenBought: false, afterMintBought: true, duplicateRejected: true,
      netOutRaw: filled[0].amountOut.toString(), amountOutMin: p.minOut.toString(),
      preopenAttemptGas: BigInt(won[3].gasUsed).toString(), successfulAttemptGas: BigInt(won[5].gasUsed).toString() });

    stage = 'competitor_before_firstbuy';
    const lost = await simulate([create, ownerView, arm, execute, mint, rival, execute, readArm, tokenBalance,
      call('cancel', [intent]), call('withdrawNative', [BigInt(p.amountIn)])]);
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.equal(lost[i].status, '0x1', 'real calls and cancellation/withdrawal succeed');
    assert.equal(abi.decodeFunctionResult('execute', lost[6].returnData)[0], false);
    assert.equal(events(lost[6], 'Filled').length, 0);
    assert.equal(events(lost[6], 'AttemptResult')[0].bought, false);
    assert.equal(TOKEN.decodeFunctionResult('balanceOf', lost[8].returnData)[0], 0n);
    assert.equal(events(lost[10], 'NativeWithdrawn')[0].amount, BigInt(p.amountIn));
    report.scenarios.push({ name: 'real_competitor_before_guard_refuses_then_recovers_full_principal', passed: true,
      bought: false, fullPrincipalWithdrawnWei: p.amountIn.toString(), failedAttemptGas: BigInt(lost[6].gasUsed).toString(),
      reasonHash: events(lost[6], 'AttemptResult')[0].reasonHash });
    const last = await provider.getBlock(parent);
    assert.ok(same(last.hash, parentHash), 'historical parent remains canonical');
    report.executorTemplateCodeHash = artifact.expectedCodeHash(owner);
    report.passed = true;
  } catch (error) {
    report.failedStage = stage;
    report.failureCode = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'HISTORICAL_EVM_VALIDATION_FAILED';
    const detail = error.info?.error?.message ?? error.error?.message ?? error.cause?.message ?? error.shortMessage;
    if (typeof detail === 'string') report.failureSummary = detail.replace(/https?:\/\/\S+/g, '<rpc>')
      .replace(/0x[0-9a-fA-F]{66,}/g, '<hex-data>').slice(0, 300);
    if (error.code === 'ERR_ASSERTION') report.assertion = String(error.message).split('\n', 1)[0].slice(0, 160);
  } finally { provider.destroy(); }
  const directory = join(ROOT, 'reports', 'firstbuy-fork');
  await mkdir(directory, { recursive: true });
  const reportPath = join(directory, 'simulate-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, reportPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, fixture: { type: 'string' }, prepared: { type: 'string' }, rpc: { type: 'string' } } });
    if (values.help) console.log('node scripts/replay-firstbuy-simulate.mjs --fixture <private chain-evidence.json> --prepared <private prepared-parent.json> [--rpc <read-only HTTPS RPC>]\nActual historical eth_simulateV1, not mock or local Anvil; no broadcast/signing.');
    else {
      if (!values.fixture || !values.prepared) throw new Error('PRIVATE_FIXTURE_REQUIRED');
      const result = await replayFirstBuyHistoricalSimulation({ fixturePath: resolve(values.fixture), preparedPath: resolve(values.prepared),
        ...(values.rpc ? { rpcUrls: [values.rpc] } : {}) });
      console.log(JSON.stringify({ passed: result.report.passed, reportPath: result.reportPath,
        failedStage: result.report.failedStage, failureCode: result.report.failureCode, assertion: result.report.assertion, scenarios: result.report.scenarios }, null, 2));
      if (!result.report.passed) process.exitCode = 1;
    }
  } catch { console.error('Historical EVM simulation could not start; use --help and validate the private input files.'); process.exitCode = 1; }
}
