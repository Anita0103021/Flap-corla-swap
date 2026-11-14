import { Interface, ZeroAddress, keccak256 } from 'ethers';
import { FACTORY, MAX_MINT_BATCHES, address } from './config.mjs';
import { corlaPoolRoute } from './corla-creation.mjs';
import { readPoolQuoteConfig } from './pool-launch.mjs';
import { quoteAsset, readQuoteDecimals, requireQuoteFunds } from './quote-assets.mjs';

// The two catalog v4 samples are fixed-runtime proxies for this upgradeable
// beacon. Refuse unknown proxy variants or upgrades until their ABI is checked.
const BEACON = address('0xdf8d1028fabda0201dbaf577a660fd8223d5b160', 'Mint beacon');
const IMPLEMENTATION = address('0x9a2e15a581ce87f5d586745da78b9aeb01633583', 'Mint implementation');
const PROXY_HASH = '0xf2a797a10ac6f455a43f13be5d1ff68a386ce8a2617010db99189fb8bfc985ec';
const BEACON_HASH = '0x57bd57aa687d9f05ea198be550c316d6fd8e5d8146145d8c34b2a75dd557f416';
const IMPL_HASH = '0x14a2b6569fbf22f98704500d13da0142ebe67017c1b42b42b5bbba37abb647f8';
const FACTORY_PROXY_HASH = '0x18d9741e68a6903b5a967719313e2bee1308277ead710e1674562152c2e49dfa';
const FACTORY_IMPL_HASH = '0xc167ca41af9196a2bac3dfbd332f97b54f3cc382ef716b16e270416a7c8beaa4';
const FACTORY_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const CORLA_QUOTE_ABI = new Interface(['function mintQuote(bytes32 deploymentKey,bytes32[] proof)']);

export const CORLA_ABI = new Interface([
  'function factory() view returns (address)',
  'function creator() view returns (address)',
  'function expectedToken() view returns (address)',
  'function token() view returns (address)',
  'function pool() view returns (address)',
  'function quoteToken() view returns (address)',
  'function quoteTokenDecimals() view returns (uint8)',
  'function pricePerLot() view returns (uint256)',
  'function mintedLots() view returns (uint256)',
  'function totalLots() view returns (uint256)',
  'function activeLots() view returns (uint256)',
  'function tokensPerLot() view returns (uint256)',
  'function getMintState() view returns (uint256 activeLots, uint8 phase)',
  'function fundingDeadline() view returns (uint64)',
  'function whitelistEnabled() view returns (bool)',
  'function whitelistDeadline() view returns (uint64)',
  'function agentOnly() view returns (bool)',
  'function emergencyWithdrawn() view returns (bool)',
  'function launched() view returns (bool)',
  'function maxMintsPerWallet() view returns (uint256)',
  'function walletMintCount(address) view returns (uint256)',
  'function claimed(address) view returns (bool)',
  'function refunded(address) view returns (bool)',
  'function mint(bytes32[] proof) payable',
  'function claim()',
  'event Minted(address indexed wallet, uint256 mintedLots)',
  'event Launched(address indexed token, address indexed pool, address indexed lastMinter)',
  'event Claimed(address indexed wallet, uint256 amount)',
]);

const REGISTRY_ABI = new Interface([
  'function deploymentIndexPlusOne(address) view returns (uint256)',
  // Decode only the leading three static words of the factory's record.
  // ethers' decoder accepts the remaining words as trailing data.
  'function deployment(uint256) view returns (address mint, address creator, address expectedToken)',
  'function implementation() view returns (address)',
]);
const QUOTE_REGISTRY_ABI = new Interface([
  'function deployment(uint256) view returns (address mint,address creator,address expectedToken,bytes32,bytes32 deploymentKey)',
  'function mintForLaunchSalt(bytes32 resolverKey) view returns (address)',
  'function quoteTokenFor(bytes32 resolverKey) view returns (address)',
]);

async function call(provider, abi, to, name, blockTag, args = []) {
  const response = await provider.call({ to, data: abi.encodeFunctionData(name, args), blockTag });
  return abi.decodeFunctionResult(name, response);
}

const READS = [
  'factory', 'creator', 'expectedToken', 'token', 'pool', 'quoteToken', 'pricePerLot',
  'mintedLots', 'totalLots', 'tokensPerLot', 'fundingDeadline', 'whitelistEnabled',
  'whitelistDeadline', 'agentOnly', 'emergencyWithdrawn', 'launched', 'maxMintsPerWallet',
];
// Only regular funding is automated here. Phase 5 is Flap's refund window
// with its own conditions; it is not the normal last-lot opening strategy.
export const isCorlaFundingClosed = state => state.launched || state.emergencyWithdrawn || [2, 4, 5, 6].includes(state.phase);

const inspectionScopes = new WeakMap();
function inspectImplementation(provider, at) {
  return Promise.all([
    provider.getCode(BEACON, at),
    call(provider, REGISTRY_ABI, BEACON, 'implementation', at),
    provider.getCode(IMPLEMENTATION, at),
  ]).then(([beaconCode, [implementation], implCode]) =>
    keccak256(beaconCode) === BEACON_HASH && implementation === IMPLEMENTATION && keccak256(implCode) === IMPL_HASH);
}

// Share only within a single pinned inspection wave; do not cache upgrades
// across ticks or reuse a verification result for a different provider/block.
export function createCorlaInspectionScope(provider, blockNumber) {
  const scope = Object.freeze({});
  inspectionScopes.set(scope, { provider, blockNumber });
  return scope;
}

async function verifyQuoteFactory(provider, at, shared) {
  const inspect = async () => {
    const [proxyCode, slot] = await Promise.all([
      provider.getCode(FACTORY, at), provider.getStorage(FACTORY, FACTORY_IMPL_SLOT, at),
    ]);
    if (keccak256(proxyCode) !== FACTORY_PROXY_HASH || !/^0x0{24}[\da-f]{40}$/i.test(slot) ||
        keccak256(await provider.getCode(address('0x' + slot.slice(-40), 'Factory implementation'), at)) !== FACTORY_IMPL_HASH) {
      throw new Error('Corla ERC-20 支付入口的实现已变化；停止构建交易');
    }
  };
  await (shared ? shared.quoteFactory ??= inspect() : inspect());
}

export async function verifyQuoteResolver(provider, key, mint, token, at) {
  if (!/^0x[\da-f]{64}$/i.test(key ?? '') || /^0x0{64}$/i.test(key)) throw new Error('Corla 工厂登记键无效');
  const [[mappedMint], [mappedToken]] = await Promise.all(['mintForLaunchSalt', 'quoteTokenFor']
    .map(name => call(provider, QUOTE_REGISTRY_ABI, FACTORY, name, at, [key])));
  if (mappedMint !== mint || mappedToken !== token) throw new Error('Corla 工厂登记键与 Mint 或底池资产不一致');
}

async function projectQuoteDecimals(provider, mint, token, at) {
  const [current, [recorded]] = await Promise.all([
    readQuoteDecimals(provider, token, at),
    call(provider, CORLA_ABI, mint, 'quoteTokenDecimals', at),
  ]);
  return BigInt(current) === recorded ? current : null;
}

function poolSupport(provider, token, at, scope) {
  if (!scope) return readPoolQuoteConfig(provider, token, at);
  const reads = scope.poolQuotes ??= new Map();
  if (!reads.has(token)) reads.set(token, readPoolQuoteConfig(provider, token, at));
  return reads.get(token);
}

export function requireCorlaPool(state) {
  if (state.poolRoute === 'unsupported') throw new Error('项目开盘池不是 Corla 当前使用的 PancakeSwap V2 直连池；未发送');
  if (state.quoteEnabled === false) throw new Error('Flap Portal 当前未开放该项目的底池资产；未发送');
  if (state.poolRoute === null || state.quoteEnabled === null) throw new Error('暂未核验该项目的 Flap 底池或交易路径；未发送');
}

export async function inspectMint(provider, target, blockTag, scope, { requireQuoteMint = false, verifyPool = false } = {}) {
  const mint = address(target.mint, 'Mint');
  const expectedToken = address(target.token, 'Token');
  if (address(target.factory, 'Factory') !== FACTORY || mint === expectedToken) {
    throw new Error('不支持此 Corla 工厂或 Mint 地址');
  }
  // Snapshot all view calls to one block to avoid mixed state at launch.
  const at = blockTag ?? await provider.getBlockNumber();
  const shared = inspectionScopes.get(scope);
  const implementation = shared?.provider === provider && shared.blockNumber === at
    ? (shared.implementation ??= inspectImplementation(provider, at))
    : inspectImplementation(provider, at);
  const [index, phase, mintCode, knownImplementation, ...rows] = await Promise.all([
    call(provider, REGISTRY_ABI, FACTORY, 'deploymentIndexPlusOne', at, [mint]),
    call(provider, CORLA_ABI, mint, 'getMintState', at),
    provider.getCode(mint, at), implementation,
    ...READS.map(name => call(provider, CORLA_ABI, mint, name, at)),
  ]);
  if (index[0] === 0n) throw new Error('Mint 未在 Corla 工厂登记');
  if (keccak256(mintCode) !== PROXY_HASH || !knownImplementation) {
    throw new Error('Corla Mint 的代理或实现已变更；停止构建交易');
  }
  const state = Object.fromEntries(READS.map((name, i) => [name, rows[i][0]]));
  const tokenQuote = state.quoteToken !== ZeroAddress;
  state.activeLots = phase[0];
  state.phase = Number(phase[1]);
  state.blockNumber = at;
  const funding = !state.launched && !state.emergencyWithdrawn && state.phase === 1;
  const checkPool = funding && (verifyPool || requireQuoteMint || target.mintBatches || target.buyOnLaunch);
  const useScope = shared?.provider === provider && shared.blockNumber === at ? shared : null;
  const [[registeredMint, registeredCreator, registeredToken, , deploymentKey], , decimals, market] = await Promise.all([
    call(provider, tokenQuote ? QUOTE_REGISTRY_ABI : REGISTRY_ABI, FACTORY, 'deployment', at, [index[0] - 1n]),
    tokenQuote && (requireQuoteMint || checkPool) ? verifyQuoteFactory(provider, at, useScope) : null,
    // Missing metadata blocks spending but does not discard claimable shares.
    tokenQuote ? projectQuoteDecimals(provider, mint, state.quoteToken, at).catch(() => null) : null,
    checkPool ? Promise.all([
      corlaPoolRoute(provider, mint, state.quoteToken, at).catch(() => null),
      poolSupport(provider, state.quoteToken, at, useScope).catch(() => null),
    ]) : null,
  ]);
  if (state.factory !== FACTORY || registeredMint !== mint || state.creator !== registeredCreator ||
      state.expectedToken !== expectedToken || registeredToken !== expectedToken) {
    throw new Error('Corla 工厂记录、Mint 和 Token 地址不一致');
  }
  if (state.pricePerLot <= 0n || state.totalLots <= 0n || state.activeLots > state.mintedLots ||
      state.mintedLots > state.totalLots || state.tokensPerLot <= 0n || state.maxMintsPerWallet <= 0n ||
      (state.launched && (state.phase !== 3 || state.token !== expectedToken || state.pool === ZeroAddress)) ||
      (!state.launched && (state.phase === 3 || state.token !== ZeroAddress || state.pool !== ZeroAddress))) {
    throw new Error('Corla Mint 返回不支持或不一致的状态');
  }
  if (tokenQuote) {
    if (state.quoteToken === mint || state.quoteToken === expectedToken || /^0x0{64}$/i.test(deploymentKey)) {
      throw new Error('Corla 支付代币或工厂登记键无效');
    }
    state.quoteDecimals = decimals;
    state.deploymentKey = deploymentKey;
    if (requireQuoteMint || checkPool) await verifyQuoteResolver(provider, deploymentKey, mint, state.quoteToken, at);
  }
  if (market) {
    const [poolRoute, support] = market;
    state.poolRoute = poolRoute;
    state.quoteEnabled = support ? support.enabled && (!tokenQuote || support.quotePriceUsd > 0n) : null;
  }
  return state;
}

export async function inspectParticipant(provider, target, walletAddress, blockTag) {
  const wallet = address(walletAddress, 'Wallet');
  const at = blockTag ?? await provider.getBlockNumber();
  const [[count], [claimed], [refunded]] = await Promise.all(
    ['walletMintCount', 'claimed', 'refunded']
      .map(name => call(provider, CORLA_ABI, target.mint, name, at, [wallet])),
  );
  return { count, claimed, refunded };
}

// Full factory/proxy provenance is checked when arming the sniper. In the
// event-critical path, verify the beacon and actual Corla market in one wave.
export async function verifySnipeState(provider, target, pool, blockTag) {
  const quoteToken = quoteAsset(target.quoteToken);
  const [[launched], [token], [actualPool], [implementation], [emergencyWithdrawn], quote] = await Promise.all([
    call(provider, CORLA_ABI, target.mint, 'launched', blockTag),
    call(provider, CORLA_ABI, target.mint, 'token', blockTag),
    call(provider, CORLA_ABI, target.mint, 'pool', blockTag),
    call(provider, REGISTRY_ABI, BEACON, 'implementation', blockTag),
    call(provider, CORLA_ABI, target.mint, 'emergencyWithdrawn', blockTag),
    quoteToken === ZeroAddress ? null : call(provider, CORLA_ABI, target.mint, 'quoteToken', blockTag),
  ]);
  if (!launched || emergencyWithdrawn || token !== target.token || actualPool !== pool ||
      implementation !== IMPLEMENTATION || (quote && quote[0] !== quoteToken)) {
    throw new Error('Corla 当前开盘状态或实现与事件不一致');
  }
}

function allowsMintWallet(target, wallet) {
  return target.mintWallets === undefined ||
    target.mintWallets.some(allowed => allowed.toLowerCase() === wallet.toLowerCase());
}

// mintBatches is the desired total per address, not the count to add on each
// invocation. Contract maxMintsPerWallet can be smaller than the UI setting.
function mintGoal(target, state) {
  const batches = target.mintBatches;
  if (!Number.isSafeInteger(batches) || batches < 1 || batches > MAX_MINT_BATCHES ||
      typeof state.maxMintsPerWallet !== 'bigint' || state.maxMintsPerWallet <= 0n) return 0n;
  return BigInt(batches) < state.maxMintsPerWallet ? BigInt(batches) : state.maxMintsPerWallet;
}

export async function buildMint(provider, target, state, walletAddress, block) {
  const goal = mintGoal(target, state);
  const quoteToken = quoteAsset(state.quoteToken);
  const tokenQuote = quoteToken !== ZeroAddress;
  const priceLimit = tokenQuote ? target.mintQuote?.priceLimit : target.maxMintPriceWei;
  if (goal === 0n || state.launched || state.emergencyWithdrawn || state.phase !== 1 ||
      state.agentOnly || state.mintedLots >= state.totalLots) return null;
  requireCorlaPool(state);
  if ((tokenQuote && (target.mintQuote?.quoteToken !== quoteToken || target.mintQuote.quoteDecimals !== state.quoteDecimals ||
      !/^0x[\da-f]{64}$/i.test(state.deploymentKey ?? '') || /^0x0{64}$/i.test(state.deploymentKey))) || (!tokenQuote && target.mintQuote)) {
    throw new Error('Mint 支付代币与已确认配置不一致');
  }
  if (typeof priceLimit !== 'bigint' || state.pricePerLot > priceLimit) return null;
  if (!block || block.number !== state.blockNumber || !Number.isSafeInteger(block.timestamp)) {
    throw new Error('Mint 快照和区块不一致');
  }
  const now = BigInt(block.timestamp);
  if (now >= state.fundingDeadline || (state.whitelistEnabled && now <= state.whitelistDeadline)) return null;
  const wallet = address(walletAddress, 'Wallet');
  if (!allowsMintWallet(target, wallet)) return null;
  const [[count], balance] = await Promise.all([
    call(provider, CORLA_ABI, target.mint, 'walletMintCount', block.number, [wallet]),
    provider.getBalance(wallet, block.number),
  ]);
  if (count >= goal || balance <= (tokenQuote ? 0n : state.pricePerLot)) return null;
  if (tokenQuote) await requireQuoteFunds(provider, quoteToken, wallet, FACTORY, state.pricePerLot, block.number);
  return {
    tx: tokenQuote
      ? { to: FACTORY, data: CORLA_QUOTE_ABI.encodeFunctionData('mintQuote', [state.deploymentKey, []]), value: 0n }
      : { to: target.mint, data: CORLA_ABI.encodeFunctionData('mint', [[]]), value: state.pricePerLot },
    details: {
      wallet, batches: 1, pricePerLot: state.pricePerLot, lotsRemaining: state.totalLots - state.mintedLots,
      walletMintCount: count, mintOrdinal: Number(count + 1n), mintGoal: Number(goal),
      ...(tokenQuote ? { quoteToken, quoteDecimals: state.quoteDecimals } : {}),
    },
    // Executor does this immediately before signing. Reject a stale ordinal
    // instead of accidentally adding to an already incremented wallet total.
    beforeSign: async () => {
      const latest = await provider.getBlock('latest');
      if (!latest || !Number.isSafeInteger(latest.number) || latest.number < block.number ||
          !Number.isSafeInteger(latest.timestamp) || latest.timestamp < block.timestamp ||
          (latest.number === block.number && block.hash && latest.hash !== block.hash)) {
        throw new Error('无法确认最新 Mint 区块；等待下一轮核对');
      }
      const latestTime = BigInt(latest.timestamp);
      if (latestTime >= state.fundingDeadline) throw new Error('Mint 募集已截止；未发送');
      const at = latest.number;
      const fields = ['mintedLots', 'fundingDeadline', 'whitelistEnabled', 'whitelistDeadline',
        'agentOnly', 'emergencyWithdrawn', 'pricePerLot', 'maxMintsPerWallet', 'totalLots'];
      const latestParameters = async () => {
        if (tokenQuote) {
          const fresh = await inspectMint(provider, target, at, undefined, { requireQuoteMint: true });
          requireCorlaPool(fresh);
          if (fresh.quoteToken !== quoteToken || fresh.quoteDecimals !== state.quoteDecimals ||
              fresh.deploymentKey !== state.deploymentKey) throw new Error('Mint 支付入口或代币已变化；未发送');
          return [BigInt(fresh.phase), ...fields.map(name => fresh[name])];
        }
        const [rows, support] = await Promise.all([
          Promise.all(['getMintState', ...fields].map(name => call(provider, CORLA_ABI, target.mint, name, at))),
          state.quoteEnabled ? readPoolQuoteConfig(provider, ZeroAddress, at) : null,
        ]);
        if (support) requireCorlaPool({ quoteEnabled: support.enabled });
        const [[, phase], ...values] = rows;
        return [phase, ...values.map(row => row[0])];
      };
      const [[latestCount], [phase, latestMinted, deadline, whitelist, whitelistDeadline,
        agentOnly, emergency, price, walletCap, total]] = await Promise.all([
        call(provider, CORLA_ABI, target.mint, 'walletMintCount', at, [wallet]),
        latestParameters(),
        tokenQuote ? requireQuoteFunds(provider, quoteToken, wallet, FACTORY, state.pricePerLot, at) : null,
      ]);
      if (latestCount !== count) throw new Error('该钱包链上 Mint 次数已变化；等待下一轮核对');
      if (phase !== 1n || latestTime >= deadline || agentOnly || emergency ||
          (whitelist && latestTime <= whitelistDeadline) || price !== state.pricePerLot || latestCount >= walletCap) {
        throw new Error('Mint 阶段或交易参数已变化；未发送');
      }
      if (total !== state.totalLots || latestMinted < state.mintedLots || latestMinted >= total) {
        throw new Error('链上 Mint 进度已重组或铸满；等待下一轮核对');
      }
      return total - latestMinted;
    },
  };
}

export async function buildClaim(provider, target, state, walletAddress) {
  if (!target.autoClaim || !state.launched || state.emergencyWithdrawn) return null;
  const wallet = address(walletAddress, 'Wallet');
  if (!allowsMintWallet(target, wallet)) return null;
  const { count, claimed, refunded } = await inspectParticipant(provider, target, wallet, state.blockNumber);
  if (count === 0n || claimed || refunded) return null;
  return {
    tx: { to: target.mint, data: CORLA_ABI.encodeFunctionData('claim'), value: 0n },
    details: { wallet, walletMintCount: count, expectedClaimAmount: count * state.tokensPerLot },
  };
}
