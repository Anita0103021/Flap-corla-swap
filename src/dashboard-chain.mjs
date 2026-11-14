import { Interface, ZeroAddress } from 'ethers';
import { CHAIN_ID, FACTORY, address } from './config.mjs';
import { CORLA_ABI } from './corla.mjs';
import { QUOTE_ERC20 } from './quote-assets.mjs';

// BSC deployment listed by the Multicall3 maintainers. Only eth_call uses it;
// live actions still use inspectMint / verifySnipeState and never this module.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)',
  'function getBlockNumber() view returns (uint256)',
  'function getChainId() view returns (uint256)',
  'function getEthBalance(address) view returns (uint256)',
]);
const REGISTRY = new Interface(['function deploymentIndexPlusOne(address) view returns (uint256)']);
const PROJECT_CHUNK = 12;
const DIRECT_CHUNK = 24;
const PROJECT_READS = [
  'factory', 'creator', 'expectedToken', 'token', 'pool', 'quoteToken', 'pricePerLot',
  'mintedLots', 'totalLots', 'tokensPerLot', 'fundingDeadline', 'whitelistEnabled',
  'whitelistDeadline', 'agentOnly', 'emergencyWithdrawn', 'launched', 'maxMintsPerWallet', 'getMintState',
];
const PARTICIPANT_READS = ['walletMintCount', 'claimed', 'refunded'];
const equals = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const chunks = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) },
  (_, i) => rows.slice(i * size, (i + 1) * size));

function item(target, abi, name, args = []) {
  return { target, data: abi.encodeFunctionData(name, args) };
}
function checkedBlock(tag) {
  if (tag === undefined || tag === 'latest') return 'latest';
  if (!Number.isSafeInteger(tag) || tag < 0) throw new Error('快照区块号无效');
  return tag;
}
function parseBlock(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('快照区块号无效');
  return n;
}
function decode(abi, name, result) {
  if (typeof result !== 'string' || result === '0x') throw new Error('合约未返回数据');
  return abi.decodeFunctionResult(name, result);
}
function chainError() {
  const err = new Error('RPC 不是 BSC 主网 (chain ID 56)');
  err.code = 'DASHBOARD_CHAIN';
  return err;
}

async function aggregate(provider, calls, blockTag) {
  const batch = [
    [MULTICALL3, false, MULTICALL.encodeFunctionData('getBlockNumber')],
    [MULTICALL3, false, MULTICALL.encodeFunctionData('getChainId')],
    ...calls.map(({ target, data }) => [target, true, data]),
  ];
  const response = await provider.call({
    to: MULTICALL3, data: MULTICALL.encodeFunctionData('aggregate3', [batch]), blockTag,
  });
  const [result] = decode(MULTICALL, 'aggregate3', response);
  if (result.length !== batch.length || !result[0].success || !result[1].success) throw new Error('批量读取返回结果不完整');
  const [number] = decode(MULTICALL, 'getBlockNumber', result[0].returnData);
  const [chainId] = decode(MULTICALL, 'getChainId', result[1].returnData);
  if (chainId !== CHAIN_ID) throw chainError();
  const blockNumber = parseBlock(number);
  if (blockTag !== 'latest' && blockNumber !== blockTag) throw new Error('批量读取返回了错误的区块');
  return { blockNumber, data: result.slice(2).map(({ success, returnData }) => success ? returnData : null) };
}

// A transport timeout/rate-limit must not expand a failed request into hundreds
// of calls. Direct fallback is for missing Multicall / call-size compatibility.
function fallbackAllowed(e) {
  if (['DASHBOARD_CHAIN', 'NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'CANCELLED'].includes(e?.code)) return false;
  if (e?.info?.error?.code === -32005 || /\b429\b|too many requests|rate limit/i.test(e?.shortMessage || e?.message || '')) return false;
  return true;
}

async function readCalls(provider, calls, blockTag) {
  try { return await aggregate(provider, calls, blockTag); }
  catch (e) {
    if (!fallbackAllowed(e)) throw e;
    // Keep even the direct fallback pinned; do not combine arbitrary latest
    // results from different blocks on a high-frequency chain.
    const [network, block] = await Promise.all([
      provider.getNetwork(), blockTag === 'latest' ? provider.getBlockNumber() : blockTag,
    ]);
    if (network?.chainId !== CHAIN_ID) throw chainError();
    const blockNumber = parseBlock(block);
    const data = [];
    for (const group of chunks(calls, DIRECT_CHUNK)) {
      data.push(...await Promise.all(group.map(async ({ target, data, direct }) => {
        try { return await (direct ? direct(provider, blockNumber) : provider.call({ to: target, data, blockTag: blockNumber })); }
        catch { return null; }
      })));
    }
    return { blockNumber, data };
  }
}

function projectCalls(target) {
  return [
    item(FACTORY, REGISTRY, 'deploymentIndexPlusOne', [target.mint]),
    ...PROJECT_READS.map(name => item(target.mint, CORLA_ABI, name)),
  ];
}
function parseProject(target, row, blockNumber) {
  try {
    const [index] = decode(REGISTRY, 'deploymentIndexPlusOne', row[0]);
    if (index === 0n) return { error: 'Mint 未在 Corla 工厂登记', blockNumber };
    const state = {};
    for (let i = 0; i < PROJECT_READS.length; i++) {
      const name = PROJECT_READS[i];
      const values = decode(CORLA_ABI, name, row[i + 1]);
      if (name === 'getMintState') {
        state.activeLots = values[0];
        state.phase = Number(values[1]);
      } else state[name] = values[0];
    }
    if (!equals(state.factory, FACTORY) || !equals(state.expectedToken, target.token)) {
      return { error: 'Corla Mint 与配置的 Token 地址不一致', blockNumber };
    }
    if (equals(state.quoteToken, target.token) || equals(state.quoteToken, target.mint)) {
      return { error: 'Corla 支付代币与项目地址冲突', blockNumber };
    }
    if (state.pricePerLot <= 0n || state.totalLots <= 0n || state.activeLots > state.mintedLots ||
        state.mintedLots > state.totalLots || state.tokensPerLot <= 0n || state.maxMintsPerWallet <= 0n ||
        (state.launched && (state.phase !== 3 || !equals(state.token, target.token) || state.pool === ZeroAddress)) ||
        (!state.launched && (state.phase === 3 || state.token !== ZeroAddress || state.pool !== ZeroAddress))) {
      return { error: 'Corla Mint 返回不支持或不一致的状态', blockNumber };
    }
    return { ...state, blockNumber };
  } catch {
    return { error: '无法读取 Corla Mint 链上状态', blockNumber };
  }
}

/**
 * Display only. For up to 12 targets, 'latest' gets both the block number and
 * all rows in one RPC call. Larger sets are pinned before bounded fan-out.
 */
export async function readDashboardProjects(provider, targets, blockTag = 'latest') {
  const out = new Map();
  if (!targets.length) return out;
  let tag = checkedBlock(blockTag);
  const valid = [];
  for (const target of targets) {
    const mint = address(target.mint, 'Mint');
    const token = address(target.token, 'Token');
    if (!equals(target.factory, FACTORY) || mint === token) {
      out.set(mint.toLowerCase(), { error: '不支持此 Corla 工厂或 Mint 地址' });
    } else valid.push({ ...target, mint, token });
  }
  if (tag === 'latest' && valid.length > PROJECT_CHUNK) tag = parseBlock(await provider.getBlockNumber());
  const batches = chunks(valid, PROJECT_CHUNK);
  const groups = await Promise.allSettled(batches.map(async group => {
    const { data, blockNumber } = await readCalls(provider, group.flatMap(projectCalls), tag);
    const width = PROJECT_READS.length + 1;
    return group.map((t, i) => [t.mint.toLowerCase(), parseProject(t, data.slice(i * width, (i + 1) * width), blockNumber)]);
  }));
  const badChain = groups.find(row => row.status === 'rejected' && row.reason?.code === 'DASHBOARD_CHAIN');
  if (badChain) throw badChain.reason;
  if (groups.length && groups.every(group => group.status === 'rejected')) throw groups[0].reason;
  for (const [i, group] of groups.entries()) {
    if (group.status === 'fulfilled') for (const row of group.value) out.set(...row);
    else for (const { mint } of batches[i]) out.set(mint.toLowerCase(), { error: '该批次 RPC 暂时不可用', blockNumber: tag });
  }
  return out;
}

// Display-only enrichment. Optional metadata may fail without discarding a
// verified Mint snapshot; never assume 18 decimals for an unknown ERC-20.
export async function readCatalogQuoteMetadata(provider, tokens, blockTag) {
  const tag = checkedBlock(blockTag);
  if (tag === 'latest' || tokens.length > 32) throw new Error('报价代币元数据需要固定区块且最多 32 个');
  const addresses = [...new Set(tokens.map(token => address(token, '支付代币')))];
  if (!addresses.length) return new Map();
  const calls = addresses.flatMap(token => ['symbol', 'decimals'].map(name => item(token, QUOTE_ERC20, name)));
  // One bounded batch; do not fan out metadata retries on a failing endpoint.
  const { data } = await aggregate(provider, calls, tag);
  return new Map(addresses.map((token, i) => {
    let quoteSymbol = null, quoteDecimals = null;
    const symbolData = data[i * 2], decimalsData = data[i * 2 + 1];
    if (typeof symbolData === 'string' && symbolData.length <= 258) {
      try {
        const [symbol] = decode(QUOTE_ERC20, 'symbol', symbolData);
        if (/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,15}$/.test(symbol)) quoteSymbol = symbol;
      } catch { /* ERC-20 metadata is optional. */ }
    }
    if (typeof decimalsData === 'string' && /^0x0{62}[0-9a-f]{2}$/i.test(decimalsData)) {
      quoteDecimals = Number(BigInt(decimalsData));
    }
    return [token.toLowerCase(), { quoteSymbol, quoteDecimals }];
  }));
}

// Wallet details are independent from project refresh, with no extra per-wallet
// RPC latency when aggregate3 is available. Only public addresses are used.
export async function readDashboardParticipants(provider, target, addresses, blockTag = 'latest') {
  if (!addresses.length) return [];
  if (addresses.length > 32) throw new Error('最多读取 32 个钱包');
  const mint = address(target.mint, 'Mint');
  if (!equals(target.factory, FACTORY)) throw new Error('不支持此 Corla 工厂');
  const wallets = addresses.map(w => address(typeof w === 'string' ? w : w?.address, '参与钱包'));
  const { data } = await readCalls(provider, wallets.flatMap(wallet =>
    PARTICIPANT_READS.map(name => item(mint, CORLA_ABI, name, [wallet]))), checkedBlock(blockTag));
  return wallets.map((wallet, i) => {
    try {
      const [[count], [claimed], [refunded]] = PARTICIPANT_READS.map((name, j) => decode(CORLA_ABI, name, data[i * 3 + j]));
      return { wallet, count, claimed, refunded };
    } catch { return { wallet, error: '无法读取该钱包的 Corla 份额' }; }
  });
}

/**
 * Read the native BSC balance and, for a verified Corla row, wallet shares
 * from one block. This is display data, never a live execution precheck.
 */
export async function readDashboardWalletBalances(provider, target, addresses, blockTag = 'latest') {
  if (addresses.length > 32) throw new Error('最多读取 32 个钱包');
  if (!addresses.length) return { block: null, wallets: [] };
  const wallets = addresses.map(wallet => address(wallet, '参与钱包'));
  if (new Set(wallets).size !== wallets.length) throw new Error('参与钱包包含重复地址');
  let project;
  if (target) {
    const mint = address(target.mint, 'Mint');
    const token = address(target.token, 'Token');
    if (!equals(target.factory, FACTORY) || mint === token) throw new Error('不支持此 Corla 工厂或 Mint 地址');
    project = { ...target, mint, token };
  }
  // Fetch actual balances before querying any project contract inside the
  // simulated aggregate. Keep getBalance available when Multicall is absent.
  const balanceCalls = wallets.map(wallet => ({
    ...item(MULTICALL3, MULTICALL, 'getEthBalance', [wallet]),
    direct: async (rpc, at) => MULTICALL.encodeFunctionResult('getEthBalance', [await rpc.getBalance(wallet, at)]),
  }));
  const projectReads = project ? projectCalls(project) : [];
  const shareCalls = project ? wallets.flatMap(wallet =>
    PARTICIPANT_READS.map(name => item(project.mint, CORLA_ABI, name, [wallet]))) : [];
  const { blockNumber: block, data } = await readCalls(provider,
    [...balanceCalls, ...projectReads, ...shareCalls], checkedBlock(blockTag));
  const chain = project ? parseProject(project, data.slice(wallets.length, wallets.length + projectReads.length), block) : null;
  const verified = Boolean(chain && !chain.error);
  const tokenQuote = verified && chain.quoteToken !== ZeroAddress;
  let payments = [];
  if (tokenQuote) {
    try {
      payments = (await readCalls(provider, wallets.flatMap(wallet => [
        item(chain.quoteToken, QUOTE_ERC20, 'balanceOf', [wallet]),
        item(chain.quoteToken, QUOTE_ERC20, 'allowance', [wallet, FACTORY]),
      ]), block)).data;
    } catch (e) { if (e?.code === 'DASHBOARD_CHAIN') throw e; }
  }
  const at = wallets.length + projectReads.length;
  const rows = wallets.map((wallet, i) => {
    const row = { address: wallet, balanceWei: null };
    try { [row.balanceWei] = decode(MULTICALL, 'getEthBalance', data[i]); } catch { /* Unknown is not zero. */ }
    if (tokenQuote) {
      row.quoteBalance = null;
      row.quoteAllowance = null;
      try { [row.quoteBalance] = decode(QUOTE_ERC20, 'balanceOf', payments[2 * i]); } catch { /* Unknown is not zero. */ }
      try { [row.quoteAllowance] = decode(QUOTE_ERC20, 'allowance', payments[2 * i + 1]); } catch { /* Unknown is not zero. */ }
    }
    if (verified) {
      const start = at + i * PARTICIPANT_READS.length;
      try {
        const [count] = decode(CORLA_ABI, 'walletMintCount', data[start]);
        row.mintedLots = count;
        const [claimed] = decode(CORLA_ABI, 'claimed', data[start + 1]);
        const [refunded] = decode(CORLA_ABI, 'refunded', data[start + 2]);
        row.hasUnclaimedShare = count > 0n && !claimed && !refunded;
      } catch { /* Partial share reads do not qualify as a verified claim status. */ }
    }
    return row;
  });
  return { block, wallets: rows, ...(verified ? {
    project: { ...chain, block, mint: project.mint, token: project.token, deployedToken: chain.token },
  } : {}) };
}
