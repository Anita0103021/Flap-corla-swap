import { getAddress, Interface, ZeroAddress } from 'ethers';

export const QUOTE_ERC20 = new Interface([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

export function quoteAsset(value = ZeroAddress) {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value)) throw new Error('支付代币地址无效');
  return getAddress(value);
}

async function read(provider, token, name, args, blockTag) {
  const result = await provider.call({ to: token, data: QUOTE_ERC20.encodeFunctionData(name, args), blockTag });
  if (typeof result !== 'string' || !/^0x[\da-f]{64}$/i.test(result)) {
    throw new Error('支付代币的 ' + name + ' 返回值无效');
  }
  const [value] = QUOTE_ERC20.decodeFunctionResult(name, result);
  if (QUOTE_ERC20.encodeFunctionResult(name, [value]).toLowerCase() !== result.toLowerCase()) {
    throw new Error('支付代币的 ' + name + ' 返回值无效');
  }
  return value;
}

export async function readQuoteDecimals(provider, token, blockTag) {
  return token === ZeroAddress ? 18 : Number(await read(provider, token, 'decimals', [], blockTag));
}

export async function readQuoteFunds(provider, token, wallet, spender, blockTag) {
  const [balance, allowance] = await Promise.all([
    read(provider, token, 'balanceOf', [wallet], blockTag),
    read(provider, token, 'allowance', [wallet, spender], blockTag),
  ]);
  return { balance, allowance };
}

export async function requireQuoteFunds(provider, token, wallet, spender, amount, blockTag) {
  if (quoteAsset(token) === ZeroAddress) return;
  const { balance, allowance } = await readQuoteFunds(provider, token, wallet, spender, blockTag);
  if (balance < amount || allowance < amount) throw new Error('支付代币余额或授权额度不足；未发送');
}

export function quoteUnits(value, decimals, label) {
  if (typeof value !== 'string' || value.length > 340 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(label + ' 必须是十进制字符串');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(label + ' 超出支付代币精度');
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (amount <= 0n || amount >= (1n << 256n)) throw new Error(label + ' 金额超出范围');
  return amount;
}

export function formatQuoteUnits(amount, decimals) {
  const digits = BigInt(amount).toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
