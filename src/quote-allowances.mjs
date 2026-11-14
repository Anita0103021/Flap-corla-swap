import { FACTORY, quoteSpendRows } from './config.mjs';
import { createCorlaInspectionScope, inspectMint, inspectParticipant, isCorlaFundingClosed, requireCorlaPool } from './corla.mjs';
import { ROUTER } from './market.mjs';
import { QUOTE_ERC20, readQuoteDecimals, readQuoteFunds } from './quote-assets.mjs';

// The ERC-20 spender is never supplied by a project or a browser. Group all
// reviewed spends by wallet and token before using that spender's allowance.
export async function prepareQuoteAllowances({ provider, cfg, wallets, execute, signal, log, inspect = inspectMint }) {
  const rows = quoteSpendRows(cfg, wallets);
  if (!rows.length) return 0;
  const head = await provider.getBlock('latest');
  if (!Number.isSafeInteger(head?.number)) throw new Error('支付币预检缺少链上区块');
  const scope = createCorlaInspectionScope(provider, head.number);
  const checks = new Map();
  const groups = new Map();
  for (const row of rows) {
    signal?.throwIfAborted();
    const key = row.target.mint + ':' + row.kind;
    if (!checks.has(key)) {
      const project = await inspect(provider, row.target, head.number, scope);
      // No spending approval is needed after funding or solely to claim.
      if (isCorlaFundingClosed(project) ||
          (Number.isSafeInteger(head.timestamp) && BigInt(head.timestamp) >= project.fundingDeadline) ||
          project.mintedLots >= project.totalLots || (row.kind === 'mint' && project.agentOnly)) {
        checks.set(key, null);
      } else {
        requireCorlaPool(project);
        if (project.quoteToken !== row.quoteToken || project.quoteDecimals !== row.quoteDecimals ||
            project.phase !== 1 || (row.kind === 'mint' && project.pricePerLot > row.target.mintQuote.priceLimit)) {
          throw new Error('项目支付币、价格或筹资状态已变化，请刷新后重新核对');
        }
        checks.set(key, project);
      }
    }
    const project = checks.get(key);
    if (!project) continue;
    const spender = row.kind === 'mint' ? FACTORY : ROUTER;
    let required = row.amount;
    if (row.kind === 'mint') {
      const { count } = await inspectParticipant(provider, row.target, row.wallet.address, head.number);
      const goal = BigInt(row.target.mintBatches) < project.maxMintsPerWallet
        ? BigInt(row.target.mintBatches) : project.maxMintsPerWallet;
      if (count >= goal || project.mintedLots >= project.totalLots) continue;
      const left = project.totalLots - project.mintedLots;
      const remaining = goal - count;
      required = (remaining < left ? remaining : left) * project.pricePerLot;
    }
    const id = [row.wallet.address, row.quoteToken, spender].join(':').toLowerCase();
    const group = groups.get(id) ?? { ...row, spender, amount: 0n, targets: [] };
    if (group.quoteDecimals !== row.quoteDecimals) throw new Error('同一支付币的配置精度不一致');
    group.amount += required;
    group.targets.push(row.target);
    if (group.amount >= (1n << 256n)) throw new Error('支付币授权总额超出范围');
    groups.set(id, group);
  }
  if (!groups.size) return 0;
  // Check all balances first so an obvious shortage leaves allowances alone.
  const requiredByWallet = new Map();
  for (const group of groups.values()) {
    const key = (group.wallet.address + ':' + group.quoteToken).toLowerCase();
    requiredByWallet.set(key, (requiredByWallet.get(key) ?? 0n) + group.amount);
  }
  for (const group of groups.values()) {
    const { quoteToken, wallet, spender, amount, quoteDecimals } = group;
    const [{ balance, allowance }, decimals, gasBalance] = await Promise.all([
      readQuoteFunds(provider, quoteToken, wallet.address, spender, head.number),
      readQuoteDecimals(provider, quoteToken, head.number),
      provider.getBalance(wallet.address, head.number),
    ]);
    if (decimals !== quoteDecimals || balance < requiredByWallet.get((wallet.address + ':' + quoteToken).toLowerCase())) {
      throw new Error('支付币余额不足或精度与配置不符：' + quoteToken);
    }
    if (gasBalance <= 0n) throw new Error('参与钱包缺少 BNB Gas');
    group.allowance = allowance;
  }
  let updated = 0;
  for (const group of groups.values()) {
    const { wallet, quoteToken, spender, amount } = group;
    if (group.allowance >= amount) continue;
    for (const value of group.allowance === 0n ? [amount] : [0n, amount]) {
      signal?.throwIfAborted();
      const nonce = await provider.getTransactionCount(wallet.address, 'latest');
      const tx = { to: quoteToken, value: 0n, data: QUOTE_ERC20.encodeFunctionData('approve', [spender, value]) };
      const actionId = ['bsc56', 'quote-approval', quoteToken.toLowerCase(), spender.toLowerCase(), nonce, value].join(':');
      const result = await execute({ actionId, wallet, tx, receiptWaitMs: 12_000, beforeSign: async () => {
        const fresh = await provider.getBlock('latest');
        if (!Number.isSafeInteger(fresh?.number) || fresh.number < head.number) throw new Error('支付币预检快照过期');
        const freshScope = createCorlaInspectionScope(provider, fresh.number);
        const [{ balance, allowance }, ...states] = await Promise.all([
          readQuoteFunds(provider, quoteToken, wallet.address, spender, fresh.number),
          ...group.targets.map(target => inspect(provider, target, fresh.number, freshScope)),
        ]);
        if (balance < amount || (value === 0n ? allowance === 0n || allowance >= amount : allowance !== 0n) ||
            states.some(state => isCorlaFundingClosed(state) || state.phase !== 1 || state.quoteToken !== quoteToken ||
              state.quoteDecimals !== group.quoteDecimals || state.mintedLots >= state.totalLots ||
              (Number.isSafeInteger(fresh.timestamp) && BigInt(fresh.timestamp) >= state.fundingDeadline))) {
          throw new Error('支付币余额或额度已变化，请重新核对后启动');
        }
        for (const state of states) requireCorlaPool(state);
        const approved = await provider.call({ ...tx, from: wallet.address });
        if (approved !== '0x' && approved !== QUOTE_ERC20.encodeFunctionResult('approve', [true])) {
          throw new Error('支付币合约未认可该笔授权');
        }
      } });
      log('quote_approval', { quoteToken, quoteDecimals: group.quoteDecimals, spender, wallet: wallet.address, approvalAmount: value, ...result });
      if (result.status !== 'confirmed' || result.actionId !== actionId) {
        throw new Error('支付币授权尚未确认或未成功。请在链上核对授权交易，再启动。');
      }
      const { allowance } = await readQuoteFunds(provider, quoteToken, wallet.address, spender, 'latest');
      if (allowance !== value) throw new Error('支付币授权回执与实际额度不符');
      updated++;
    }
  }
  return updated;
}
