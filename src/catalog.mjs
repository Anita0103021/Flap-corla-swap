import { Interface } from 'ethers';
import { CHAIN_ID, FACTORY, address, int } from './config.mjs';
import { MULTICALL3 } from './dashboard-chain.mjs';

// Verified on the BSC Corla v4 factory. getDeployments is zero-based,
// ascending, and accepts at most 100 records; reverse locally for browsing.
const ENTRY = '(address mint,address creator,address token,bytes32,bytes32,bytes32,uint256 createdAt,uint256 fundingDeadline,uint256 totalLots,uint256 pricePerLot)';
const REGISTRY = new Interface([
  'function deploymentCount() view returns(uint256)',
  'function deploymentIndexPlusOne(address) view returns(uint256)',
  'function getDeployments(uint256 offset,uint256 limit) view returns(' + ENTRY + '[])',
]);
const AGGREGATE = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns(tuple(bool success,bytes returnData)[] returnData)',
  'function getBlockNumber() view returns(uint256)',
  'function getChainId() view returns(uint256)',
]);

export const MAX_CATALOG_PAGE = 32;
export const MAX_CATALOG_ADDRESS_SCAN = 2500;
const FACTORY_PAGE_SIZE = 100;
const SCAN_CONCURRENCY = 3;
const RAW_HEX = /^0x[0-9a-fA-F]+$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function number(value, label) {
  return int(Number(value), label, 0, Number.MAX_SAFE_INTEGER);
}

function readCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(cursor)) throw new Error('看板页码无效');
  return number(cursor, '看板页码');
}

async function snapshot(provider, lookup) {
  const entries = [
    [MULTICALL3, false, AGGREGATE.encodeFunctionData('getChainId')],
    [MULTICALL3, false, AGGREGATE.encodeFunctionData('getBlockNumber')],
    [FACTORY, false, REGISTRY.encodeFunctionData('deploymentCount')],
  ];
  if (lookup) entries.push([FACTORY, false, REGISTRY.encodeFunctionData('deploymentIndexPlusOne', [lookup])]);
  const raw = await provider.call({ to: MULTICALL3, data: AGGREGATE.encodeFunctionData('aggregate3', [entries]), blockTag: 'latest' });
  if (typeof raw !== 'string' || raw.length > 4096 || !RAW_HEX.test(raw)) throw new Error('工厂快照返回数据无效');
  const [result] = AGGREGATE.decodeFunctionResult('aggregate3', raw);
  if (result.length !== entries.length || result.some(row => !row.success)) throw new Error('无法读取 Corla 工厂快照');
  const [chainId] = AGGREGATE.decodeFunctionResult('getChainId', result[0].returnData);
  if (chainId !== CHAIN_ID) throw new Error('Corla 看板只支持 BSC 主网');
  const [block] = AGGREGATE.decodeFunctionResult('getBlockNumber', result[1].returnData);
  const [total] = REGISTRY.decodeFunctionResult('deploymentCount', result[2].returnData);
  const [indexPlusOne] = lookup ? REGISTRY.decodeFunctionResult('deploymentIndexPlusOne', result[3].returnData) : [0n];
  const height = number(block, '快照区块');
  const size = number(total, '项目数量');
  if (indexPlusOne > total) throw new Error('Corla 工厂索引超出登记范围');
  return { block: height, total: size, indexPlusOne: Number(indexPlusOne) };
}

async function readRows(provider, block, offset, count) {
  if (count === 0) return [];
  const raw = await provider.call({
    to: FACTORY,
    data: REGISTRY.encodeFunctionData('getDeployments', [offset, count]),
    blockTag: block,
  });
  // ABI shape: offset + length + exactly 10 static words per registered row.
  if (typeof raw !== 'string' || raw.length !== 2 + 64 * (2 + count * 10) || !RAW_HEX.test(raw)) {
    throw new Error('Corla 工厂分页不完整，未显示未核验结果');
  }
  const [rows] = REGISTRY.decodeFunctionResult('getDeployments', raw);
  if (rows.length !== count) throw new Error('Corla 工厂分页数量异常');
  return rows.map((entry, i) => {
    const mint = address(entry.mint, 'Mint');
    const token = address(entry.token, 'Token');
    const creator = address(entry.creator, '创建者');
    const createdAt = number(entry.createdAt, '创建时间');
    const fundingDeadline = number(entry.fundingDeadline, '筹资截止时间');
    if (mint === token || fundingDeadline < createdAt || entry.totalLots <= 0n || entry.pricePerLot <= 0n) {
      throw new Error('Corla 工厂登记记录无效');
    }
    const query = new URLSearchParams({ mint, factory: FACTORY, catalogVersion: '4', lang: 'zh' });
    return { mint, token, creator, factory: FACTORY, index: offset + i, createdAt, fundingDeadline,
      totalLots: entry.totalLots, pricePerLot: entry.pricePerLot,
      url: 'https://flap.sh/apps/corla/mint/' + token + '?' + query };
  });
}

/** A fresh pinned registry view; cursor is an exclusive index, not an offset
 * from head, so newly appended projects cannot shift already-read pages. */
export async function readCatalogPage(provider, { cursor, limit = 18 } = {}) {
  const upper = readCursor(cursor);
  int(limit, '每页数量', 1, MAX_CATALOG_PAGE);
  const { block, total } = await snapshot(provider);
  const end = Math.min(upper ?? total, total);
  const start = Math.max(0, end - limit);
  const projects = (await readRows(provider, block, start, end - start)).reverse();
  return { projects, nextCursor: start > 0 ? String(start) : null, total, block };
}

/**
 * Direct index for a registered Mint; the deployed v4 factory exposes no
 * reverse token address index, so Token lookup scans bounded native pages.
 * A partial page is an error, never falsely reported as "not found".
 */
export async function findCatalogAddress(provider, input) {
  const lookup = address(input, 'Token 或 Mint 地址');
  const { block, total, indexPlusOne } = await snapshot(provider, lookup);
  if (indexPlusOne > 0) {
    const [row] = await readRows(provider, block, indexPlusOne - 1, 1);
    if (!same(row.mint, lookup) && !same(row.token, lookup)) throw new Error('Corla 工厂索引与查询地址不一致');
    return row;
  }
  const minimum = Math.max(0, total - MAX_CATALOG_ADDRESS_SCAN);
  for (let end = total; end > minimum;) {
    const group = [];
    for (let i = 0; i < SCAN_CONCURRENCY && end > minimum; i++) {
      const start = Math.max(minimum, end - FACTORY_PAGE_SIZE);
      group.push(readRows(provider, block, start, end - start));
      end = start;
    }
    const results = await Promise.allSettled(group);
    const match = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .find(row => same(row.token, lookup) || same(row.mint, lookup));
    if (match) return match;
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  if (minimum > 0) throw new Error('此地址未在最近 ' + MAX_CATALOG_ADDRESS_SCAN + ' 个项目中找到；已达查询上限');
  return null;
}
