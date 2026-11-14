import { Interface } from 'ethers';

// Corla v4's stored launch params. Unlike a symbol or an external pool, these
// state exactly which payment asset and DEX the verified Mint will use.
const CREATION = new Interface([
  'function getCreationParams() view returns (tuple(tuple(uint256,uint256,uint32,bool,uint32,address[]),tuple(string name,string symbol,string meta,uint256 totalSupply,bytes32,address quoteToken,uint8 dexId,uint256,uint256,uint16,uint16,uint32,uint32,tuple(uint8,uint16,bytes)[],uint8,uint32,address[],uint256,bytes32,bytes,address) launch,tuple(uint8,address,uint128,bytes)))',
]);
const MAX_HEX_CHARS = 128 * 1024 * 2 + 2;

export async function readCorlaCreation(provider, mint, blockTag) {
  const raw = await provider.call({ to: mint, data: CREATION.encodeFunctionData('getCreationParams'), blockTag });
  if (typeof raw !== 'string' || raw.length > MAX_HEX_CHARS || raw === '0x') throw new Error('Corla 创建参数返回无效');
  return CREATION.decodeFunctionResult('getCreationParams', raw)[0];
}

export async function corlaPoolRoute(provider, mint, token, blockTag) {
  const { launch } = await readCorlaCreation(provider, mint, blockTag);
  if (launch.quoteToken !== token) throw new Error('Corla 创建参数与链上支付币不同');
  return launch.dexId === 0n ? 'pancake-v2' : 'unsupported';
}
