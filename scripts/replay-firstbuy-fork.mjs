import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Contract, ContractFactory, Transaction, id, keccak256, parseEther, toQuantity } from 'ethers';
import { compileFirstBuy, startAnvil } from '../test/helpers/firstbuy-lab.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const quantity = x => typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x) ? BigInt(x) : undefined;
const localOnly = endpoint => {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('LOCAL_FORK_REQUIRED');
};

/** Restore the exact public signed envelope, not a newly signed replacement.
 * Never pass the returned raw transaction to an upstream/public provider. */
export function reconstructSignedBscTx(row) {
  if (!HASH.test(row?.hash ?? '') || !ADDRESS.test(row.from ?? '') || !ADDRESS.test(row.to ?? '') ||
      quantity(row.chainId) !== 56n || ![0n, 1n, 2n].includes(quantity(row.type ?? '0x0'))) throw new Error('INVALID_BSC_FIXTURE_TX');
  const type = Number(quantity(row.type ?? '0x0'));
  const tx = Transaction.from({ type, chainId: 56, nonce: Number(quantity(row.nonce)), to: row.to,
    gasLimit: quantity(row.gas), value: quantity(row.value), data: row.input,
    ...(type === 2 ? { maxFeePerGas: quantity(row.maxFeePerGas), maxPriorityFeePerGas: quantity(row.maxPriorityFeePerGas) }
      : { gasPrice: quantity(row.gasPrice) }),
    ...(type ? { accessList: row.accessList ?? [] } : {}),
    signature: { r: row.r, s: row.s, v: Number(quantity(row.yParity ?? row.v)) } });
  if (!same(tx.hash, row.hash) || !same(tx.from, row.from)) throw new Error('FIXTURE_SIGNATURE_MISMATCH');
  return tx;
}

async function boundedJson(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('FIXTURE_TOO_LARGE');
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function replayFirstBuyFork({ fixturePath, anchorPath, rpc = 'https://bsc-rpc.publicnode.com', outputDirectory } = {}) {
  const [fixture, anchor] = await Promise.all([boundedJson(fixturePath), boundedJson(anchorPath ?? join(dirname(fixturePath), 'state-and-price.json'))]);
  const launch = fixture.entries?.[0], competitor = fixture.entries?.[1];
  if (fixture.chainId !== 56 || !launch?.transaction || !competitor?.transaction || !fixture.before || !fixture.head ||
      !same(launch.receipt?.blockHash, fixture.head.hash) || !same(competitor.receipt?.blockHash, fixture.head.hash) ||
      quantity(launch.receipt.status) !== 1n || quantity(competitor.receipt.status) !== 1n ||
      quantity(fixture.before.number) + 1n !== quantity(fixture.head.number) ||
      !same(anchor.canonicalLaunch?.hash, launch.hash) || anchor.canonicalLaunch.block !== Number(quantity(fixture.head.number))) {
    throw new Error('INCONSISTENT_FORK_FIXTURE');
  }
  const launchTx = reconstructSignedBscTx(launch.transaction), competitorTx = reconstructSignedBscTx(competitor.transaction);
  const price = anchor.priceCounterfactual;
  const amount = parseEther(price.amountInBnb);
  const forkBlock = Number(quantity(fixture.before.number)), parentTime = Number(quantity(fixture.before.timestamp));
  const report = { schemaVersion: 1, mode: 'local_historical_state_fork', passed: false, time: new Date().toISOString(),
    inputSha256: createHash('sha256').update(await readFile(fixturePath)).digest('hex'),
    parentBlock: forkBlock, parentBlockHash: fixture.before.hash,
    originalLaunchHash: launch.hash, originalFirstBuyHash: competitor.hash,
    interpretation: '真实父块状态在本机Anvil分叉，部署执行器后构造相对交易顺序。不是完整历史块/网络传播/Builder排名重放；本地手续费排序只用于确定测试顺序。',
    effects: { upstreamWrites: 0, realWallets: 0, realDeployments: 0 }, scenarios: [] };
  let lab, stage = 'start_fork';
  try {
    lab = await startAnvil({ forkUrl: rpc, forkBlock, timeoutMs: 60000 });
    localOnly(lab.endpoint);
    const { provider } = lab;
    const localParent = await provider.send('eth_getBlockByNumber', [toQuantity(forkBlock), false]);
    assert.equal(localParent.hash.toLowerCase(), fixture.before.hash.toLowerCase(), 'fork parent hash');
    await provider.send('anvil_setBlockTimestampInterval', [1]);
    const owner = await provider.getSigner(0), ownerAddress = await owner.getAddress();
    // These nonce assertions stop the replay rather than silently altering a
    // real signed sender's nonce or injecting a fake account balance.
    assert.equal(await provider.getTransactionCount(launchTx.from), launchTx.nonce, 'original minter nonce at parent');
    assert.equal(await provider.getTransactionCount(competitorTx.from), competitorTx.nonce, 'competitor nonce at parent');
    stage = 'deploy_local';
    const art = (await compileFirstBuy())['contracts/CorlaFirstBuyExecutor.sol'].CorlaFirstBuyExecutor;
    const executor = await new ContractFactory(art.abi, art.evm.bytecode.object, owner).deploy(ownerAddress, []);
    await executor.waitForDeployment();
    const address = await executor.getAddress();
    report.executorRuntimeHash = keccak256(await provider.getCode(address));
    const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
    const params = { mint: launchTx.to, token: anchor.canonicalLaunch.token ??
        fixture.entries[0].receipt.logs.flatMap(log => log.topics?.length === 4 && same(log.address, launchTx.to) &&
          log.data === '0x' ? ['0x' + log.topics[1].slice(-40)] : [])[0],
      amountIn: amount, expectedReserveBnb: parseEther(price.initialReserveBnb), expectedReserveToken: BigInt(price.initialReserveTokenRaw),
      minOut: BigInt(price.openingMinimumOutRaw), validUntilBlock: Number(quantity(head.number)) + 2048,
      deadline: parentTime + 1000, maxGasPriceWei: 100_000_000_000n, maxBuyGas: 1_300_000,
      maxAttempts: 8, maxBuyTaxBps: 500, maxSellTaxBps: 500, maxOpeningPremiumBps: 1000,
      evidenceHash: id('private-historical-anchor:' + report.inputSha256) };
    if (!ADDRESS.test(params.token ?? '')) throw new Error('NO_UNIQUE_FIXTURE_TOKEN');
    stage = 'arm_local';
    const armReceipt = await (await executor.arm(params, { value: amount, gasLimit: 2_000_000 })).wait();
    assert.equal(armReceipt.status, 1);
    const arm = await executor.readArm(), intent = arm.intentId;
    assert.equal(arm.state, 1n);
    report.localArm = { block: armReceipt.blockNumber, initialEscrowWei: amount.toString(), amountOutMin: params.minOut.toString() };
    const token = new Contract(params.token, ['function balanceOf(address) view returns(uint256)'], provider);
    const events = (receipt, name) => receipt.logs.flatMap(log => {
      if (!same(log.address, address)) return [];
      try { const parsed = executor.interface.parseLog(log); return parsed?.name === name ? [parsed.args] : []; }
      catch { return []; }
    });
    async function receipt(hash) {
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        const result = await provider.getTransactionReceipt(hash);
        if (result) {
          const canonical = await provider.getBlock(result.blockNumber);
          if (!same(canonical?.hash, result.blockHash) || result.blockNumber <= forkBlock) throw new Error('RECEIPT_NOT_LOCAL_CANONICAL');
          return result;
        }
        await new Promise(ok => setTimeout(ok, 100));
      }
      throw new Error('LOCAL_REPLAY_RECEIPT_TIMEOUT');
    }
    async function sendSigned(tx) {
      localOnly(lab.endpoint);
      const hash = await provider.send('eth_sendRawTransaction', [tx.serialized]);
      assert.equal(hash.toLowerCase(), tx.hash.toLowerCase());
      return hash;
    }
    stage = 'before_open';
    const beforeOpen = await (await executor.execute(intent, { gasLimit: 1_600_000, gasPrice: 100_000_000n })).wait();
    assert.equal(beforeOpen.status, 1);
    assert.equal(events(beforeOpen, 'Filled').length, 0);
    assert.equal(events(beforeOpen, 'AttemptResult')[0]?.bought, false);
    assert.equal(await provider.getBalance(address), amount);
    report.scenarios.push({ name: 'before_open_no_purchase', passed: true, attempts: Number((await executor.readArm()).attempts),
      gasUsed: beforeOpen.gasUsed.toString(), principalPreserved: true });
    const snapshot = await provider.send('evm_snapshot', []);

    // Sorting by fee is an explicitly controlled local ordering, not a claim
    // about real validators. Both public signed transactions are unmodified.
    const mintFee = launchTx.gasPrice ?? launchTx.maxFeePerGas;
    const rivalFee = competitorTx.gasPrice ?? competitorTx.maxFeePerGas;
    const ownFee = (mintFee < rivalFee ? mintFee : rivalFee) - 1n;
    if (ownFee <= 0n) throw new Error('FIXTURE_FEE_ORDER_UNAVAILABLE');
    async function orderedBlock(includeCompetitor) {
      await provider.send('evm_setAutomine', [false]);
      try {
        const mintHash = await sendSigned(launchTx);
        const competitorHash = includeCompetitor ? await sendSigned(competitorTx) : null;
        const our = await executor.execute(intent, { gasLimit: 1_600_000, gasPrice: ownFee });
        await provider.send('evm_mine', []);
        const [mintReceipt, rivalReceipt, ourReceipt] = await Promise.all([
          receipt(mintHash), competitorHash ? receipt(competitorHash) : null, receipt(our.hash),
        ]);
        assert.equal(mintReceipt.status, 1, 'original final Mint must really launch on local fork');
        assert.equal(mintReceipt.blockNumber, ourReceipt.blockNumber, 'Mint and guarded attempt share the locally constructed block');
        assert.ok(mintReceipt.index < ourReceipt.index, 'local order Mint before guarded attempt');
        if (rivalReceipt) {
          assert.equal(rivalReceipt.status, 1, 'original competitor must really buy on local fork');
          assert.equal(rivalReceipt.blockNumber, ourReceipt.blockNumber);
          assert.ok(mintReceipt.index < rivalReceipt.index && rivalReceipt.index < ourReceipt.index);
        }
        return { mintReceipt, rivalReceipt, ourReceipt };
      } finally { await provider.send('evm_setAutomine', [true]); }
    }
    stage = 'first_buy_order';
    const won = await orderedBlock(false);
    const filled = events(won.ourReceipt, 'Filled');
    assert.equal(won.ourReceipt.status, 1);
    assert.equal(filled.length, 1, 'production executor must buy on actual fork, not a mocked router');
    assert.equal(filled[0].intentId, intent);
    assert.equal(filled[0].recipient, ownerAddress);
    assert.ok(filled[0].amountOut >= params.minOut);
    assert.equal(await token.balanceOf(ownerAddress), filled[0].amountOut);
    assert.equal((await executor.readArm()).state, 2n);
    const balanceAfter = await provider.getBalance(address);
    assert.equal(balanceAfter, 0n);
    let secondRejected = false;
    try { await executor.execute.staticCall(intent); } catch { secondRejected = true; }
    assert.equal(secondRejected, true);
    report.scenarios.push({ name: 'mint_then_guarded_buy_same_block', passed: true,
      localBlock: won.ourReceipt.blockNumber, mintIndex: won.mintReceipt.index, ourIndex: won.ourReceipt.index,
      gasUsed: won.ourReceipt.gasUsed.toString(), netTokenOutRaw: filled[0].amountOut.toString(), duplicateRejected: true });

    stage = 'competitor_first_order';
    assert.equal(await provider.send('evm_revert', [snapshot]), true);
    const lost = await orderedBlock(true);
    assert.equal(lost.ourReceipt.status, 1);
    assert.equal(events(lost.ourReceipt, 'Filled').length, 0);
    const failed = events(lost.ourReceipt, 'AttemptResult');
    assert.equal(failed[0]?.bought, false);
    assert.equal(await provider.getBalance(address), amount);
    assert.equal(await token.balanceOf(ownerAddress), 0n);
    report.scenarios.push({ name: 'competitor_then_guarded_buy_refused', passed: true,
      localBlock: lost.ourReceipt.blockNumber, mintIndex: lost.mintReceipt.index, competitorIndex: lost.rivalReceipt.index,
      ourIndex: lost.ourReceipt.index, gasUsed: lost.ourReceipt.gasUsed.toString(), principalPreserved: true,
      reasonHash: failed[0].reasonHash });
    report.passed = true;
    stage = 'complete';
  } catch (error) {
    report.failedStage = stage;
    report.failureCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'FORK_VALIDATION_FAILED';
    const detail = error.info?.error?.message ?? error.error?.message ?? error.cause?.message ?? error.shortMessage;
    if (typeof detail === 'string') report.failureSummary = detail.replace(/https?:\/\/\S+/g, '<rpc>')
      .replace(/0x[0-9a-fA-F]{66,}/g, '<hex-data>').slice(0, 400);
    // Assertion messages here are fixed developer-written strings. Arbitrary
    // RPC errors can contain raw envelopes or access URLs and are not stored.
    if (error.code === 'ERR_ASSERTION') report.assertion = String(error.message).split('\n', 1)[0].slice(0, 180);
  } finally {
    await lab?.close();
  }
  const directory = outputDirectory ?? join(ROOT, 'reports', 'firstbuy-fork');
  await mkdir(directory, { recursive: true });
  const name = 'fork-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  await writeFile(join(directory, name), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return { report, reportPath: join(directory, name) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, fixture: { type: 'string' }, anchor: { type: 'string' }, rpc: { type: 'string' } } });
    if (values.help) console.log('node scripts/replay-firstbuy-fork.mjs --fixture <private chain-evidence.json> [--anchor <state-and-price.json>] [--rpc <public HTTPS RPC>]\nOnly a local Anvil fork receives writes. No user wallets, upstream broadcast, or real deployment.');
    else {
      if (!values.fixture) throw new Error('FIXTURE_REQUIRED');
      const result = await replayFirstBuyFork({ fixturePath: resolve(values.fixture), anchorPath: values.anchor && resolve(values.anchor), rpc: values.rpc });
      console.log(JSON.stringify({ passed: result.report.passed, reportPath: result.reportPath,
        failedStage: result.report.failedStage, failureCode: result.report.failureCode, scenarios: result.report.scenarios }, null, 2));
      if (!result.report.passed) process.exitCode = 1;
    }
  } catch { console.error('Local fork replay could not start; use --help and check the private fixture paths.'); process.exitCode = 1; }
}
