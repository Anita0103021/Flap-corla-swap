import { getAddress, Interface } from 'ethers';
import { quoteAsset } from './quote-assets.mjs';

// Flap's BSC Pool Launch Portal, not the Bonding Curve Portal.
export const DIRECT_LAUNCH_PORTAL = getAddress('0x000042108465206185a077edc3f3fd2b49060000');
const DIRECT_V2_POOL_TAX = 0;
export const POOL_LAUNCH_ABI = new Interface([
  'function launchQuoteConfig(uint8 kind,address quoteToken) view returns (bool enabled,uint256 quotePriceUsd)',
]);

export function poolQuoteQuery(token) {
  return { to: DIRECT_LAUNCH_PORTAL,
    data: POOL_LAUNCH_ABI.encodeFunctionData('launchQuoteConfig', [DIRECT_V2_POOL_TAX, quoteAsset(token)]) };
}

export function decodePoolQuoteConfig(raw) {
  if (typeof raw !== 'string' || !/^0x[\da-f]{128}$/i.test(raw)) throw new Error('Flap 底池配置返回格式无效');
  const result = POOL_LAUNCH_ABI.decodeFunctionResult('launchQuoteConfig', raw);
  if (POOL_LAUNCH_ABI.encodeFunctionResult('launchQuoteConfig', result).toLowerCase() !== raw.toLowerCase()) {
    throw new Error('Flap 底池配置返回格式无效');
  }
  return { enabled: result.enabled, quotePriceUsd: result.quotePriceUsd };
}

export async function readPoolQuoteConfig(provider, token, blockTag) {
  return decodePoolQuoteConfig(await provider.call({ ...poolQuoteQuery(token), blockTag }));
}
