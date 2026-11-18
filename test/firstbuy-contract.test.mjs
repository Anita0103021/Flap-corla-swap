import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Contract, ContractFactory, id, parseEther, toQuantity, ZeroAddress } from 'ethers';
import { compileFirstBuy, startAnvil } from './helpers/firstbuy-lab.mjs';

const MAIN = 'contracts/CorlaFirstBuyExecutor.sol';
const MOCK = 'test/fixtures/FirstBuyMocks.sol';
const compiled = await compileFirstBuy({ [MOCK]: { content: await readFile(new URL('./fixtures/FirstBuyMocks.sol', import.meta.url), 'utf8') } });
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const TOKEN = '0x000000000000000000000000000000000000cafe';
const AMOUNT = parseEther('.05'), QUOTE = parseEther('5'), TOKENS = parseEther('5000');
const GAS = 1_000_000;
const sent = async tx => (await tx).wait();
const code = (file, name) => '0x' + compiled[file][name].evm.deployedBytecode.object;

async function fixture(t, { production = false, maxAttempts = 3 } = {}) {
  const lab = await startAnvil();
  t.after(() => lab.close());
  const { provider } = lab, owner = await provider.getSigner(0), operator = await provider.getSigner(1), stranger = await provider.getSigner(2);
  const ownerAddress = await owner.getAddress(), operatorAddress = await operator.getAddress();
  const deploy = async (file, name, ...args) => {
    const art = compiled[file][name];
    const contract = await new ContractFactory(art.abi, art.evm.bytecode.object, owner).deploy(...args);
    await contract.waitForDeployment(); return contract;
  };
  const mint = await deploy(MOCK, 'FirstBuyMockMint', TOKEN);
  const pair = await deploy(MOCK, 'FirstBuyMockPair', TOKEN, WBNB);
  const exec = production ? await deploy(MAIN, 'CorlaFirstBuyExecutor', ownerAddress, [operatorAddress]) :
    await deploy(MOCK, 'FirstBuyHarness', ownerAddress, [operatorAddress]);
  await provider.send('anvil_setCode', [ROUTER, code(MOCK, 'FirstBuyMockRouter')]);
  await provider.send('anvil_setCode', [FACTORY, code(MOCK, 'FirstBuyMockFactory')]);
  const router = new Contract(ROUTER, compiled[MOCK].FirstBuyMockRouter.abi, owner);
  const factory = new Contract(FACTORY, compiled[MOCK].FirstBuyMockFactory.abi, owner);
  await sent(factory.setPair(await pair.getAddress()));
  await sent(pair.setReserves(QUOTE, TOKENS));
  await sent(router.configure(TOKEN, parseEther('50'), false));
  const head = await provider.send('eth_getBlockByNumber', ['latest', false]);
  const params = { mint: await mint.getAddress(), token: TOKEN, amountIn: AMOUNT, expectedReserveBnb: QUOTE,
    expectedReserveToken: TOKENS, minOut: parseEther('1'), validUntilBlock: Number(head.number) + 200,
    deadline: Number(head.timestamp) + 600, maxGasPriceWei: 10_000_000_000n, maxBuyGas: 700_000,
    maxAttempts, maxBuyTaxBps: 500, maxSellTaxBps: 500, maxOpeningPremiumBps: 1000, evidenceHash: id('public-test-anchor') };
  async function arm(patch = {}) {
    await sent(exec.arm({ ...params, ...patch }, { value: AMOUNT, gasLimit: 1_500_000 }));
    return (await exec.readArm()).intentId;
  }
  async function launch() {
    await provider.send('anvil_setCode', [TOKEN, code(MOCK, 'FirstBuyMockToken')]);
    const token = new Contract(TOKEN, compiled[MOCK].FirstBuyMockToken.abi, owner);
    await sent(token.configure(await pair.getAddress(), 300, 300));
    await sent(mint.launch(await pair.getAddress()));
    return token;
  }
  const execute = (intentId, signer = operator, options = {}) => sent(exec.connect(signer).execute(intentId, { gasLimit: GAS, gasPrice: 100_000_000n, ...options }));
  const events = (receipt, name) => receipt.logs.flatMap(log => { try { const parsed = exec.interface.parseLog(log); return parsed?.name === name ? [parsed] : []; } catch { return []; } });
  return { ...lab, exec, mint, pair, router, factory, owner, operator, stranger, ownerAddress, params, arm, launch, execute, events };
}

test('production identity pins reject an arbitrary local Mint instead of trusting the test harness', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { production: true });
  await assert.rejects(f.arm(), /revert|CALL_EXCEPTION/);
  assert.equal((await f.exec.readArm()).state, 0n);
  const bytes = compiled[MAIN].CorlaFirstBuyExecutor.evm.deployedBytecode.object.length / 2;
  assert.ok(bytes < 24_576, 'production runtime must fit EIP-170');
});

test('before opening execute receipts can succeed but do not buy; attempt cap persists and principal is withdrawable', { timeout: 60_000 }, async t => {
  const f = await fixture(t, { maxAttempts: 2 }), intent = await f.arm();
  for (const n of [1n, 2n]) {
    const receipt = await f.execute(intent);
    assert.equal(receipt.status, 1);
    assert.equal(f.events(receipt, 'Filled').length, 0);
    assert.equal(f.events(receipt, 'AttemptResult')[0].args.bought, false);
    assert.equal((await f.exec.readArm()).attempts, n);
    assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT);
  }
  assert.equal((await f.exec.readArm()).state, 4n);
  await assert.rejects(f.execute(intent), /revert|CALL_EXCEPTION/);
  await sent(f.exec.withdrawNative(AMOUNT));
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), 0n);
});

test('an exact untouched pool buys once for the owner and never for the operator', { timeout: 60_000 }, async t => {
  const f = await fixture(t), intent = await f.arm(), token = await f.launch();
  const receipt = await f.execute(intent), filled = f.events(receipt, 'Filled');
  assert.equal(filled.length, 1);
  assert.equal(filled[0].args.intentId, intent);
  assert.equal(filled[0].args.recipient, f.ownerAddress);
  assert.equal(filled[0].args.amountIn, AMOUNT);
  assert.equal(filled[0].args.amountOut, parseEther('50'));
  assert.equal(await token.balanceOf(f.ownerAddress), parseEther('50'));
  assert.equal(await token.balanceOf(await f.operator.getAddress()), 0n);
  assert.equal((await f.exec.readArm()).state, 2n);
  assert.equal(await f.exec.spentMint(await f.mint.getAddress()), true);
  await assert.rejects(f.execute(intent), /revert|CALL_EXCEPTION/);
  await assert.rejects(f.arm(), /revert|CALL_EXCEPTION/);
});

test('another buyer changing the reserves, excess tax, or a bad route never spends escrow', { timeout: 60_000 }, async t => {
  const f = await fixture(t), intent = await f.arm(), token = await f.launch();
  await sent(f.pair.setReserves(QUOTE + parseEther('1.5'), TOKENS));
  let receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'AttemptResult')[0].args.bought, false);
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT);
  await sent(f.pair.setReserves(QUOTE, TOKENS));
  await sent(token.configure(await f.pair.getAddress(), 501, 300));
  receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'AttemptResult')[0].args.bought, false);
  assert.equal(await token.balanceOf(f.ownerAddress), 0n);
  await sent(token.configure(await f.pair.getAddress(), 300, 300));
  await sent(f.factory.setPair(ZeroAddress));
  receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'Filled').length, 0);
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT);
});

test('the executor independently checks balance delta even if a router ignores minimum output', { timeout: 60_000 }, async t => {
  const f = await fixture(t), intent = await f.arm(), token = await f.launch();
  await sent(f.router.configure(TOKEN, 1n, false));
  const receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'Filled').length, 0);
  assert.equal(f.events(receipt, 'AttemptResult')[0].args.bought, false);
  assert.equal(await token.balanceOf(f.ownerAddress), 0n, 'failed inner frame rolls back minted tokens');
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT, 'failed inner frame rolls back principal transfer');
  assert.equal(await f.exec.spentMint(await f.mint.getAddress()), false);
});

test('unauthorized callers, wrong intent, cancellation and expiry cannot consume reserved principal', { timeout: 60_000 }, async t => {
  const f = await fixture(t), intent = await f.arm();
  await assert.rejects(f.execute(intent, f.stranger), /revert|CALL_EXCEPTION/);
  await assert.rejects(f.execute(id('wrong')), /revert|CALL_EXCEPTION/);
  await assert.rejects(sent(f.exec.withdrawNative(1n)), /revert|CALL_EXCEPTION/);
  assert.equal((await f.exec.readArm()).attempts, 0n);
  await sent(f.exec.cancel(intent));
  await assert.rejects(f.execute(intent), /revert|CALL_EXCEPTION/);
  await sent(f.exec.withdrawNative(AMOUNT));
  const next = await f.arm();
  await f.provider.send('evm_increaseTime', [601]);
  await f.provider.send('evm_mine', []);
  await assert.rejects(f.execute(next), /revert|CALL_EXCEPTION/);
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT);
});

test('gas-price refusal is outside the attempt counter; bounded failure data and router reentry do not bypass locks', { timeout: 60_000 }, async t => {
  const f = await fixture(t), intent = await f.arm();
  await assert.rejects(f.execute(intent, f.operator, { gasPrice: 11_000_000_000n }), /revert|CALL_EXCEPTION/);
  assert.equal((await f.exec.readArm()).attempts, 0n);
  const token = await f.launch();
  await sent(f.router.configureBomb());
  let receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'AttemptResult')[0].args.bought, false);
  assert.equal((await f.exec.readArm()).attempts, 1n);
  assert.equal(await f.provider.getBalance(await f.exec.getAddress()), AMOUNT);
  // Restore the mock router code/storage at a fresh address slot before
  // testing authorized reentry; the real fixed Router has no such control.
  await f.provider.send('anvil_setStorageAt', [ROUTER, toQuantity(2), '0x' + '0'.repeat(64)]);
  await sent(f.router.configureReentry(await f.exec.getAddress(), intent));
  await sent(f.exec.setOperator(ROUTER, true));
  receipt = await f.execute(intent);
  assert.equal(f.events(receipt, 'Filled').length, 1);
  assert.equal(await token.balanceOf(f.ownerAddress), parseEther('50'));
});
