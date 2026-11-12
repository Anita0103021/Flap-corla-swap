import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getAddress, isAddress, parseUnits, ZeroAddress } from 'ethers';
import { DEFAULT_BSC_RPC_URL, validateRpcBackupUrls, validateRpcUrl } from './rpc-config.mjs';

export const CHAIN_ID = 56n;
export const FACTORY = getAddress('0xfba753f8b890eb35caa000c427f99ed5903ea517');
export const MAX_MINT_BATCHES = 32;

export function address(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || !isAddress(value) || value === ZeroAddress) {
    throw new Error(label + ' 不是有效的非零 EVM 地址');
  }
  return getAddress(value);
}

export function parseMintLink(input) {
  if (typeof input !== 'string') throw new Error('Corla 链接必须为字符串');
  let url;
  try { url = new URL(input); } catch { throw new Error('不是有效的 Corla 链接'); }
  const path = /^\/apps\/corla\/mint\/(0x[0-9a-fA-F]{40})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://flap.sh' || url.username || url.password || !path) {
    throw new Error('仅接受 https://flap.sh/apps/corla/mint/<Token> 链接');
  }
  const param = name => {
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) throw new Error('Corla 链接必须包含唯一的 ' + name);
    return values[0];
  };
  const token = address(path[1], 'Token');
  const mint = address(param('mint'), 'Mint');
  const factory = address(param('factory'), 'Factory');
  if (factory !== FACTORY || param('catalogVersion') !== '4' || token === mint) {
    throw new Error('仅支持已核实的 Corla v4 工厂');
  }
  return { token, mint, factory };
}

export function int(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + ' 范围: ' + min + '–' + max);
  return value;
}
export function units(value, label, decimals = 18, zero = false) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(label + ' 必须是十进制字符串');
  let result;
  try { result = parseUnits(value, decimals); } catch { throw new Error(label + ' 精度过高'); }
  if (!zero && result <= 0n) throw new Error(label + ' 必须大于 0');
  return result;
}
function options(object, keys, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(name + ' 必须是对象');
  const unknown = Object.keys(object).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(name + ' 存在未知字段: ' + unknown.join(', '));
  return object;
}
function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(label + ' 必须是布尔值');
  return value;
}
function pathIn(dir, value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' 必须是文件路径');
  return resolve(dir, value);
}
export async function readJson(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadConfig(file) {
  const dir = dirname(resolve(file));
  return validateConfig(await readJson(file), dir);
}

// Existing configs used a buyOnLaunch switch on each Mint row. An explicit
// snipeTargets list (including []) supersedes those legacy switches.
export function snipeTargetUrls(input) {
  if (input.snipeTargets !== undefined) return input.snipeTargets;
  if (!Array.isArray(input.targets)) return [];
  return input.targets.filter(t => t?.buyOnLaunch === true).map(t => t.url);
}

function uniqueTargets(targets, label) {
  if (new Set(targets.map(t => t.mint)).size !== targets.length ||
      new Set(targets.map(t => t.token)).size !== targets.length) throw new Error(label + '包含重复项目');
}

export function validateConfig(input, dir, { allowEmptyTargets = false, workspace = 'all' } = {}) {
  const cfg = options(input, [
    'rpcUrl', 'rpcBackupUrls', 'pollMs', 'targets', 'watchWallets', 'walletFile', 'journalPath',
    'maxGasPriceGwei', 'gasLimitCap', 'maxTotalBnb', 'snipe', 'snipeTargets',
  ], '配置');
  if (!['all', 'mint', 'snipe'].includes(workspace)) throw new Error('未知工作区');
  const rpcUrl = process.env.BSC_RPC_URL || cfg.rpcUrl || DEFAULT_BSC_RPC_URL;
  const normalizedRpc = validateRpcUrl(rpcUrl);
  const rpcCustom = Boolean(process.env.BSC_RPC_URL) || normalizedRpc !== validateRpcUrl(DEFAULT_BSC_RPC_URL);
  const rpcBackupUrls = cfg.rpcBackupUrls === undefined ? undefined : validateRpcBackupUrls(cfg.rpcBackupUrls);
  if (!Array.isArray(cfg.targets) || cfg.targets.length > 32) {
    throw new Error('Mint 项目列表最多包含 32 个明确指定的 Corla 链接');
  }
  const mintTargets = cfg.targets.map(raw => {
    const t = options(raw, ['url', 'mintBatches', 'maxMintPriceBnb', 'autoClaim', 'buyOnLaunch', 'mintWallets'], 'targets[]');
    const mintBatches = int(t.mintBatches ?? 0, '每钱包 Mint 目标次数', 0, MAX_MINT_BATCHES);
    let mintWallets;
    if (t.mintWallets !== undefined) {
      if (!Array.isArray(t.mintWallets) || t.mintWallets.length < 1 || t.mintWallets.length > 32) {
        throw new Error('项目选择的钱包必须为 1–32 个地址；使用全部钱包请省略选择');
      }
      mintWallets = t.mintWallets.map(wallet => address(wallet, '参与钱包'));
      if (new Set(mintWallets).size !== mintWallets.length) throw new Error('参与钱包包含重复地址');
    }
    bool(t.buyOnLaunch, 'buyOnLaunch', false); // legacy field, migration only
    return {
      ...parseMintLink(t.url), mintBatches,
      maxMintPriceWei: mintBatches > 0 ? units(t.maxMintPriceBnb, 'maxMintPriceBnb') : 0n,
      autoClaim: bool(t.autoClaim, 'autoClaim', false),
      ...(mintWallets === undefined ? {} : { mintWallets }), buyOnLaunch: false,
    };
  });
  const snipeUrls = snipeTargetUrls(cfg);
  if (!Array.isArray(snipeUrls) || snipeUrls.length > 32) throw new Error('狙击列表最多包含 32 个明确指定的 Corla 链接');
  const sniperTargets = snipeUrls.map(url => ({
    ...parseMintLink(url), mintBatches: 0, maxMintPriceWei: 0n, autoClaim: false, buyOnLaunch: true,
  }));
  uniqueTargets(mintTargets, 'Mint 列表');
  uniqueTargets(sniperTargets, '狙击列表');
  const union = new Map(mintTargets.map(t => [t.mint, t]));
  for (const t of sniperTargets) {
    const existing = union.get(t.mint);
    if (existing && existing.token !== t.token) throw new Error('两个工作区的项目地址不一致');
    union.set(t.mint, existing ? { ...existing, buyOnLaunch: true } : t);
  }
  uniqueTargets([...union.values()], '工作区配置');
  const targets = workspace === 'mint' ? mintTargets : workspace === 'snipe' ? sniperTargets : [...union.values()];
  if (!allowEmptyTargets && !targets.length) throw new Error('请先添加至少一个明确指定的 Corla 项目');
  const s = options(cfg.snipe ?? {}, [
    'amountBnb', 'walletCount', 'minLiquidityBnb', 'slippageBps', 'maxBuyTaxBps',
    'maxSellTaxBps', 'maxPriceImpactBps', 'windowBlocks', 'deadlineSeconds', 'scanMs', 'repeatAttempts',
    'maxOpeningPremiumBps', 'requirePreopen',
  ], 'snipe');
  let snipe = null;
  if (targets.some(t => t.buyOnLaunch)) {
    snipe = {
      amountIn: units(s.amountBnb, 'snipe.amountBnb'),
      walletCount: int(s.walletCount ?? 1, 'snipe.walletCount', 1, 32),
      minLiquidity: units(s.minLiquidityBnb, 'snipe.minLiquidityBnb'),
      slippageBps: int(s.slippageBps ?? 1000, 'snipe.slippageBps', 1, 1000),
      maxOpeningPremiumBps: int(s.maxOpeningPremiumBps === undefined ? 1000 : s.maxOpeningPremiumBps, 'snipe.maxOpeningPremiumBps', 0, 1000),
      requirePreopen: bool(s.requirePreopen, 'snipe.requirePreopen', false),
      maxBuyTaxBps: int(s.maxBuyTaxBps ?? 500, 'snipe.maxBuyTaxBps', 0, 2000),
      maxSellTaxBps: int(s.maxSellTaxBps ?? 500, 'snipe.maxSellTaxBps', 0, 2000),
      maxPriceImpactBps: int(s.maxPriceImpactBps ?? 1000, 'snipe.maxPriceImpactBps', 1, 1000),
      windowBlocks: int(s.windowBlocks ?? 15, 'snipe.windowBlocks', 1, 100),
      deadlineSeconds: int(s.deadlineSeconds ?? 12, 'snipe.deadlineSeconds', 5, 60),
      scanMs: int(s.scanMs ?? 350, 'snipe.scanMs', 200, 5000),
      repeatAttempts: int(s.repeatAttempts ?? 1, 'snipe.repeatAttempts', 1, 5),
    };
    if (snipe.requirePreopen && snipe.repeatAttempts < 2) throw new Error('「没抢到开盘就不追」需要将最多提交次数设为 2–5');
  }
  const watch = cfg.watchWallets ?? [];
  if (!Array.isArray(watch) || watch.length > 32) throw new Error('watchWallets 必须是至多 32 个地址的数组');
  const watchWallets = watch.map(a => ({ address: address(a, 'watchWallets[]') }));
  if (new Set(watchWallets.map(w => w.address)).size !== watchWallets.length) throw new Error('watchWallets 存在重复地址');
  return {
    rpcUrl, rpcCustom, rpcBackupUrls, targets, snipe, watchWallets, workspace,
    walletFile: pathIn(dir, cfg.walletFile ?? 'wallets.local.json', 'walletFile'),
    journalPath: pathIn(dir, cfg.journalPath ?? 'state/transactions.sqlite', 'journalPath'),
    pollMs: int(cfg.pollMs ?? 1500, 'pollMs', 300, 30000),
    maxGasPriceWei: units(cfg.maxGasPriceGwei ?? '1', 'maxGasPriceGwei', 9),
    gasLimitCap: BigInt(int(cfg.gasLimitCap ?? 10000000, 'gasLimitCap', 21000, 15000000)),
    maxTotalWei: cfg.maxTotalBnb === undefined ? null : units(cfg.maxTotalBnb, 'maxTotalBnb'),
  };
}

export function mintWalletsFor(target, wallets) {
  if (target.mintWallets === undefined) return wallets;
  const byAddress = new Map(wallets.flatMap(w => {
    const address = typeof w === 'string' ? w : w?.address;
    return typeof address === 'string' ? [[address.toLowerCase(), w]] : [];
  }));
  return target.mintWallets.map(address => {
    const wallet = byAddress.get(address.toLowerCase());
    if (!wallet) throw new Error('所选参与钱包已不在钱包库中，请重新选择：' + address);
    return wallet;
  });
}

// Upfront worst-case cap, including a full gas allowance for every potential transaction.
export function checkBudget(cfg, wallets) {
  if (!wallets.length || wallets.length > 32) throw new Error('交易模式需要 1–32 个钱包');
  if (cfg.snipe && cfg.snipe.walletCount > wallets.length) throw new Error('snipe.walletCount 大于已加载的钱包数');
  const gas = cfg.gasLimitCap * cfg.maxGasPriceWei;
  let cap = 0n;
  for (const t of cfg.targets) {
    const n = t.mintBatches || t.autoClaim ? BigInt(mintWalletsFor(t, wallets).length) : 0n;
    if (t.mintBatches) cap += n * BigInt(t.mintBatches) * (gas + t.maxMintPriceWei);
    if (t.autoClaim) cap += n * gas;
    if (t.buyOnLaunch) cap += BigInt(cfg.snipe.walletCount) * BigInt(cfg.snipe.repeatAttempts ?? 1) * (gas + cfg.snipe.amountIn);
  }
  if (cap <= 0n) throw new Error('没有启用任何交易动作');
  if (cfg.maxTotalWei === null || cap > cfg.maxTotalWei) throw new Error('未设置 maxTotalBnb，或超出最坏情况总预算: ' + cap + ' wei');
  return cap;
}
