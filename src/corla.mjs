import { Interface, ZeroAddress, keccak256 } from 'ethers';
import { FACTORY, MAX_MINT_BATCHES, address } from './config.mjs';

// The two catalog v4 samples are fixed-runtime proxies for this upgradeable
// beacon. Refuse unknown proxy variants or upgrades until their ABI is checked.
const BEACON = address('0xdf8d1028fabda0201dbaf577a660fd8223d5b160', 'Mint beacon');
const IMPLEMENTATION = address('0x9a2e15a581ce87f5d586745da78b9aeb01633583', 'Mint implementation');
const PROXY_HASH = '0xf2a797a10ac6f455a43f13be5d1ff68a386ce8a2617010db99189fb8bfc985ec';
const BEACON_HASH = '0x57bd57aa687d9f05ea198be550c316d6fd8e5d8146145d8c34b2a75dd557f416';
const IMPL_HASH = '0x14a2b6569fbf22f98704500d13da0142ebe67017c1b42b42b5bbba37abb647f8';

export const CORLA_ABI = new Interface([
  'function factory() view returns (address)',
  'function creator() view returns (address)',
  'function expectedToken() view returns (address)',
  'function token() view returns (address)',
  'function pool() view returns (address)',
  'function quoteToken() view returns (address)',
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

async function call(provider, abi, to, name, blockTag, args = []) {
  const response = await provider.call({ to, data: abi.encodeFunctionData(name, args), blockTag });
  return abi.decodeFunctionResult(name, response);
}

const READS = [
  'factory', 'creator', 'expectedToken', 'token', 'pool', 'quoteToken', 'pricePerLot',
  'mintedLots', 'totalLots', 'tokensPerLot', 'fundingDeadline', 'whitelistEnabled',
  'whitelistDeadline', 'agentOnly', 'emergencyWithdrawn', 'launched', 'maxMintsPerWallet',
];

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

export async function inspectMint(provider, target, blockTag, scope) {
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
  const [registeredMint, registeredCreator, registeredToken] =
    await call(provider, REGISTRY_ABI, FACTORY, 'deployment', at, [index[0] - 1n]);
  if (state.factory !== FACTORY || registeredMint !== mint || state.creator !== registeredCreator ||
      state.expectedToken !== expectedToken || registeredToken !== expectedToken) {
    throw new Error('Corla 工厂记录、Mint 和 Token 地址不一致');
  }
  state.activeLots = phase[0];
  state.phase = Number(phase[1]);
  state.blockNumber = at;
  if (state.quoteToken !== ZeroAddress) throw new Error('仅支持使用 BNB 支付的 Corla Mint');
  if (state.pricePerLot <= 0n || state.totalLots <= 0n || state.activeLots > state.mintedLots ||
      state.mintedLots > state.totalLots || state.tokensPerLot <= 0n || state.maxMintsPerWallet <= 0n ||
      (state.launched && (state.phase !== 3 || state.token !== expectedToken || state.pool === ZeroAddress)) ||
      (!state.launched && (state.phase === 3 || state.token !== ZeroAddress || state.pool !== ZeroAddress))) {
    throw new Error('Corla Mint 返回不支持或不一致的状态');
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
  const [[launched], [token], [actualPool], [implementation], [emergencyWithdrawn]] = await Promise.all([
    call(provider, CORLA_ABI, target.mint, 'launched', blockTag),
    call(provider, CORLA_ABI, target.mint, 'token', blockTag),
    call(provider, CORLA_ABI, target.mint, 'pool', blockTag),
    call(provider, REGISTRY_ABI, BEACON, 'implementation', blockTag),
    call(provider, CORLA_ABI, target.mint, 'emergencyWithdrawn', blockTag),
  ]);
  if (!launched || emergencyWithdrawn || token !== target.token || actualPool !== pool || implementation !== IMPLEMENTATION) {
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
  if (goal === 0n || state.launched || state.emergencyWithdrawn || state.phase !== 1 ||
      state.agentOnly || state.mintedLots >= state.totalLots || typeof target.maxMintPriceWei !== 'bigint' ||
      state.pricePerLot > target.maxMintPriceWei) return null;
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
  if (count >= goal || balance <= state.pricePerLot) return null;
  return {
    tx: { to: target.mint, data: CORLA_ABI.encodeFunctionData('mint', [[]]), value: state.pricePerLot },
    details: {
      wallet, batches: 1, pricePerLot: state.pricePerLot, lotsRemaining: state.totalLots - state.mintedLots,
      walletMintCount: count, mintOrdinal: Number(count + 1n), mintGoal: Number(goal),
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
      const [[latestCount], [latestMinted], [, phase], [deadline], [whitelist], [whitelistDeadline],
        [agentOnly], [emergency], [price], [walletCap], [total]] = await Promise.all([
        call(provider, CORLA_ABI, target.mint, 'walletMintCount', at, [wallet]),
        ...['mintedLots', 'getMintState', 'fundingDeadline', 'whitelistEnabled', 'whitelistDeadline',
          'agentOnly', 'emergencyWithdrawn', 'pricePerLot', 'maxMintsPerWallet', 'totalLots']
          .map(name => call(provider, CORLA_ABI, target.mint, name, at)),
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
