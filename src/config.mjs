import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getAddress, isAddress, parseUnits, ZeroAddress } from 'ethers';
import { DEFAULT_BSC_RPC_URL, MAX_BROADCAST_CONCURRENCY, validateRpcBackupUrls, validateRpcUrl } from './rpc-config.mjs';
import { quoteUnits } from './quote-assets.mjs';
import { MAX_SNIPE_ATTEMPTS } from './snipe-limits.mjs';

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

export function snipeTargetUrl(row) { return typeof row === 'string' ? row : row?.url; }

export function snipeSettingsForTarget(settings, target) {
  return target.snipeQuote ? { ...settings, ...target.snipeQuote } : settings;
}

function configuredQuote(row, fields) {
  if ([row.quoteToken, row.quoteDecimals, ...fields.map(key => row[key])].every(value => value === undefined)) return null;
  const quoteToken = address(row.quoteToken, '支付代币');
  const quoteDecimals = int(row.quoteDecimals, '支付代币精度', 0, 255);
  return { quoteToken, quoteDecimals };
}

export function snipeOpeningDefaults({ requirePreopen, repeatAttempts }) {
  // A saved round count without a policy is from the older opt-in mode.
  const noChase = requirePreopen === undefined ? repeatAttempts === undefined : requirePreopen;
  return {
    requirePreopen: noChase,
    repeatAttempts: repeatAttempts === undefined ? (noChase === true ? 2 : 1) : repeatAttempts,
  };
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
    const t = options(raw, ['url', 'mintBatches', 'maxMintPriceBnb', 'autoClaim', 'buyOnLaunch', 'mintWallets',
      'quoteToken', 'quoteDecimals', 'maxMintPriceQuote'], 'targets[]');
    const link = parseMintLink(t.url);
    const quote = configuredQuote(t, ['maxMintPriceQuote']);
    if (quote && (quote.quoteToken === link.token || quote.quoteToken === link.mint || t.maxMintPriceBnb !== undefined)) {
      throw new Error('Mint 的支付代币与价格保护配置冲突');
    }
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
      ...link, mintBatches,
      maxMintPriceWei: mintBatches > 0 && !quote ? units(t.maxMintPriceBnb, 'maxMintPriceBnb') : 0n,
      ...(quote ? { mintQuote: { ...quote, priceLimit: mintBatches > 0 ?
        quoteUnits(t.maxMintPriceQuote, quote.quoteDecimals, '单批价格保护') : 0n } } : {}),
      autoClaim: bool(t.autoClaim, 'autoClaim', false),
      ...(mintWallets === undefined ? {} : { mintWallets }), buyOnLaunch: false,
    };
  });
  const snipeUrls = snipeTargetUrls(cfg);
  if (!Array.isArray(snipeUrls) || snipeUrls.length > 32) throw new Error('狙击列表最多包含 32 个明确指定的 Corla 链接');
  const sniperTargets = snipeUrls.map(raw => {
    const row = typeof raw === 'string' ? { url: raw } : options(raw,
      ['url', 'quoteToken', 'quoteDecimals', 'amountQuote', 'minLiquidityQuote'], 'snipeTargets[]');
    const link = parseMintLink(row.url);
    const quote = configuredQuote(row, ['amountQuote', 'minLiquidityQuote']);
    if (quote && (quote.quoteToken === link.token || quote.quoteToken === link.mint)) throw new Error('狙击支付币与目标合约重复');
    return { ...link, mintBatches: 0, maxMintPriceWei: 0n, autoClaim: false, buyOnLaunch: true,
      ...(quote ? { snipeQuote: { ...quote,
        amountIn: quoteUnits(row.amountQuote, quote.quoteDecimals, '单钱包买入额'),
        minLiquidity: quoteUnits(row.minLiquidityQuote, quote.quoteDecimals, '最低支付币储备'),
      } } : {}) };
  });
  uniqueTargets(mintTargets, 'Mint 列表');
  uniqueTargets(sniperTargets, '狙击列表');
  const union = new Map(mintTargets.map(t => [t.mint, t]));
  for (const t of sniperTargets) {
    const existing = union.get(t.mint);
    if (existing && existing.token !== t.token) throw new Error('两个工作区的项目地址不一致');
    if (existing?.mintQuote && t.snipeQuote && (t.snipeQuote.quoteToken !== existing.mintQuote.quoteToken ||
        t.snipeQuote.quoteDecimals !== existing.mintQuote.quoteDecimals)) {
      throw new Error('两个工作区的支付代币不一致');
    }
    union.set(t.mint, existing ? { ...existing, buyOnLaunch: true, ...(t.snipeQuote ? { snipeQuote: t.snipeQuote } : {}) } : t);
  }
  uniqueTargets([...union.values()], '工作区配置');
  const targets = workspace === 'mint' ? mintTargets : workspace === 'snipe' ? sniperTargets : [...union.values()];
  if (!allowEmptyTargets && !targets.length) throw new Error('请先添加至少一个明确指定的 Corla 项目');
  const s = options(cfg.snipe ?? {}, [
    'amountBnb', 'walletCount', 'minLiquidityBnb', 'slippageBps', 'maxBuyTaxBps',
    'maxSellTaxBps', 'maxPriceImpactBps', 'windowBlocks', 'deadlineSeconds', 'scanMs', 'repeatAttempts',
    'maxOpeningPremiumBps', 'requirePreopen', 'broadcastConcurrency',
  ], 'snipe');
  const broadcastConcurrency = int(s.broadcastConcurrency === undefined ? 1 : s.broadcastConcurrency,
    '并发线程数 (snipe.broadcastConcurrency)', 1, MAX_BROADCAST_CONCURRENCY);
  const opening = snipeOpeningDefaults(s);
  const repeatAttempts = int(opening.repeatAttempts,
    '并发次数 (snipe.repeatAttempts)', 1, MAX_SNIPE_ATTEMPTS);
  let snipe = null;
  if (targets.some(t => t.buyOnLaunch)) {
    const needsNative = targets.some(t => t.buyOnLaunch && !t.snipeQuote);
    snipe = {
      amountIn: needsNative || s.amountBnb !== undefined ? units(s.amountBnb, 'snipe.amountBnb') : 0n,
      walletCount: int(s.walletCount ?? 1, 'snipe.walletCount', 1, 32),
      minLiquidity: needsNative || s.minLiquidityBnb !== undefined ? units(s.minLiquidityBnb, 'snipe.minLiquidityBnb') : 0n,
      slippageBps: int(s.slippageBps ?? 1000, 'snipe.slippageBps', 1, 1000),
      maxOpeningPremiumBps: int(s.maxOpeningPremiumBps === undefined ? 1000 : s.maxOpeningPremiumBps, 'snipe.maxOpeningPremiumBps', 0, 1000),
      requirePreopen: bool(opening.requirePreopen, 'snipe.requirePreopen', true),
      maxBuyTaxBps: int(s.maxBuyTaxBps ?? 500, 'snipe.maxBuyTaxBps', 0, 2000),
      maxSellTaxBps: int(s.maxSellTaxBps ?? 500, 'snipe.maxSellTaxBps', 0, 2000),
      maxPriceImpactBps: int(s.maxPriceImpactBps ?? 1000, 'snipe.maxPriceImpactBps', 1, 1000),
      windowBlocks: int(s.windowBlocks ?? 15, 'snipe.windowBlocks', 1, 100),
      deadlineSeconds: int(s.deadlineSeconds ?? 12, 'snipe.deadlineSeconds', 5, 60),
      scanMs: int(s.scanMs ?? 350, 'snipe.scanMs', 200, 5000),
      broadcastConcurrency,
      repeatAttempts,
    };
    if (snipe.requirePreopen && repeatAttempts < 2) {
      throw new Error('「没抢到开盘就不追」需要将并发次数设为 2–' + MAX_SNIPE_ATTEMPTS);
    }
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

export function quoteSpendRows(cfg, wallets) {
  const rows = [];
  for (const target of cfg.targets) {
    if (target.mintBatches && target.mintQuote) {
      for (const wallet of mintWalletsFor(target, wallets)) rows.push({ target, wallet, kind: 'mint',
        ...target.mintQuote, amount: BigInt(target.mintBatches) * target.mintQuote.priceLimit });
    }
    if (target.buyOnLaunch && target.snipeQuote) {
      for (const wallet of wallets.slice(0, cfg.snipe.walletCount)) rows.push({ target, wallet, kind: 'buy',
        ...target.snipeQuote, amount: target.snipeQuote.amountIn });
    }
  }
  return rows;
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
    if (t.buyOnLaunch) cap += BigInt(cfg.snipe.walletCount) * BigInt(cfg.snipe.repeatAttempts ?? 1) * (gas + (t.snipeQuote ? 0n : cfg.snipe.amountIn));
  }
  const approvals = new Set(quoteSpendRows(cfg, wallets).map(row =>
    [row.kind, row.quoteToken, (typeof row.wallet === 'string' ? row.wallet : row.wallet?.address)?.toLowerCase()].join(':')));
  cap += BigInt(approvals.size) * 2n * gas; // reset + bounded approval, if needed
  if (cap <= 0n) throw new Error('没有启用任何交易动作');
  if (cfg.maxTotalWei === null || cap > cfg.maxTotalWei) throw new Error('未设置 maxTotalBnb，或超出最坏情况总预算: ' + cap + ' wei');
  return cap;
}
