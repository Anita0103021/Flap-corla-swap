import { formatEther, formatUnits, getAddress, Interface, keccak256, toQuantity, ZeroAddress } from 'ethers';
import { FACTORY } from '../src/config.mjs';
import { CORLA_LAUNCH_TOPIC, decodeLaunchCandidate, portalLaunchQuote, verifyLaunchCandidate } from '../src/events.mjs';
import { ROUTER, WBNB } from '../src/market.mjs';
import { BUILTIN_WATCH_RPC_URLS } from '../src/rpc-config.mjs';
import { createRpcPool } from '../src/rpc-pool.mjs';
import { formatQuoteUnits, readQuoteDecimals } from '../src/quote-assets.mjs';

// A public-chain forensic comparison only: no local configuration, wallets,
// private RPC credentials, signing, or write methods.
const [launchHash, buyHash, ...extra] = process.argv.slice(2);
const validHash = hash => typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash);
if (extra.length || !validHash(launchHash) || !validHash(buyHash)) {
  console.error('Usage: node scripts/inspect-corla-first-buy.mjs <launch-hash> <buy-hash>');
  process.exit(2);
}
const swapAbi = new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const pairAbi = new Interface(['function token0() view returns(address)', 'function token1() view returns(address)']);
const low = x => x?.toLowerCase();
const provider = createRpcPool(BUILTIN_WATCH_RPC_URLS, { requiredMethods: ['eth_getLogs'] });
try {
  const read = method => hash => provider.send(method, [hash]);
  const tx = read('eth_getTransactionByHash');
  const receipt = read('eth_getTransactionReceipt');
  const [launch, buy, launchReceipt, buyReceipt] = await Promise.all([
    tx(launchHash), tx(buyHash), receipt(launchHash), receipt(buyHash),
  ]);
  if (![launch, buy, launchReceipt, buyReceipt].every(Boolean)) throw new Error('Transaction or receipt missing');
  if (launchReceipt.status !== '0x1' || buyReceipt.status !== '0x1') throw new Error('Both transactions must succeed');
  const h = Number(launchReceipt.blockNumber);
  const tag = toQuantity(h);
  const logs = launchReceipt.logs.filter(log => low(log.topics?.[0]) === CORLA_LAUNCH_TOPIC);
  if (logs.length !== 1 || ![1, 2].every(i => /^0x0{24}[a-f0-9]{40}$/i.test(logs[0].topics?.[i] ?? ''))) {
    throw new Error('No unique Corla launch event');
  }
  const tokenAddr = getAddress('0x' + logs[0].topics[1].slice(-40));
  const poolAddr = getAddress('0x' + logs[0].topics[2].slice(-40));
  const launchQuotes = launchReceipt.logs.map(log => portalLaunchQuote(log, tokenAddr, poolAddr)).filter(x => x !== null);
  if (launchQuotes.length !== 1) throw new Error('No unique Portal payment asset');
  const [quoteToken] = launchQuotes;
  const payment = quoteToken === ZeroAddress ? WBNB : quoteToken;
  const candidate = decodeLaunchCandidate({
    factory: FACTORY, mint: getAddress(logs[0].address), token: tokenAddr, quoteToken,
  }, logs[0], h, h);
  const proven = await verifyLaunchCandidate(provider, candidate);
  if (!proven?.openingReserves) throw new Error('No matching Corla launch, Portal and liquidity evidence');
  const { pool, token } = proven;
  const [head, nextHead, buyHead, beforeCode, afterCode, swapLogs, order] = await Promise.all([
    provider.send('eth_getBlockByNumber', [tag, true]),
    provider.getBlock(h + 1),
    provider.getBlock(Number(buyReceipt.blockNumber)),
    provider.getCode(buy.to, h - 1),
    provider.getCode(buy.to, h),
    provider.getLogs({ address: pool, topics: [swapAbi.getEvent('Swap').topicHash], fromBlock: h, toBlock: h + 1 }),
    Promise.all(['token0', 'token1'].map(async name => {
      const result = await provider.call({ to: pool, data: pairAbi.encodeFunctionData(name), blockTag: h });
      return low(pairAbi.decodeFunctionResult(name, result)[0]);
    })),
  ]);
  if (low(head?.hash) !== low(launchReceipt.blockHash) || low(buyHead?.hash) !== low(buyReceipt.blockHash)) {
    throw new Error('Receipts did not match the canonical blocks');
  }
  if (!order.includes(low(token)) || !order.includes(low(payment))) throw new Error('Unexpected pool payment asset');
  if (!nextHead?.hash || swapLogs.some(log => log.removed || low(log.address) !== low(pool) ||
      low(log.blockHash) !== low(log.blockNumber === h ? head.hash : log.blockNumber === h + 1 ? nextHead.hash : undefined))) {
    throw new Error('Swap logs did not match the canonical pair and blocks');
  }
  const quoteFirst = order[0] === low(payment);
  const buys = swapLogs.flatMap(log => {
    const { args } = swapAbi.parseLog(log);
    const paid = args[quoteFirst ? 'amount0In' : 'amount1In'];
    const tokenOut = args[quoteFirst ? 'amount1Out' : 'amount0Out'];
    return paid > 0n && tokenOut > 0n ? [{ log, paid }] : [];
  }).sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.transactionIndex - b.log.transactionIndex);
  const matched = buys.filter(row => low(row.log.transactionHash) === low(buyHash));
  const rawPayment = matched.reduce((sum, row) => sum + row.paid, 0n);
  const quoteDecimals = await readQuoteDecimals(provider, quoteToken, h).catch(() => null);
  const sameCall = t => low(t.to) === low(buy.to) && t.input === buy.input;
  const comparable = head.transactions.filter(sameCall);
  const samples = await Promise.allSettled(comparable.slice(0, 64).map(t => receipt(t.hash)));
  const verified = samples.flatMap(row => row.status === 'fulfilled' && low(row.value?.blockHash) === low(head.hash) ? [row.value] : []);
  const failed = verified.filter(row => row.status === '0x0');
  const before = await Promise.all([3, 2, 1].filter(offset => h >= offset).map(async offset => {
    const block = h - offset;
    const prior = await provider.send('eth_getBlockByNumber', [toQuantity(block), true]);
    return { block, sameDestinationAndInput: prior.transactions.filter(sameCall).length };
  }));
  console.log(JSON.stringify({
    launch: { hash: launchHash, block: h, index: Number(launchReceipt.transactionIndex) },
    suppliedBuy: { hash: buyHash, block: Number(buyReceipt.blockNumber), index: Number(buyReceipt.transactionIndex),
      firstBuyInScannedBlocks: Boolean(buys.length && low(buys[0].log.transactionHash) === low(buyHash)),
      ...(quoteToken === ZeroAddress ? { poolWbnbIn: formatEther(rawPayment) } : {
        paymentToken: payment, poolQuoteInUnits: rawPayment.toString(),
        poolQuoteIn: quoteDecimals === null ? null : formatQuoteUnits(rawPayment, quoteDecimals),
      }),
      standardRouterDestination: low(buy.to) === low(ROUTER), destination: buy.to,
      calldataBytes: (buy.input.length - 2) / 2, selector: buy.input.slice(0, 10), valueBnb: formatEther(buy.value),
      gasUsed: Number(buyReceipt.gasUsed), gasPriceGwei: formatUnits(buyReceipt.effectiveGasPrice, 9),
      gasPaidBnb: formatEther(BigInt(buyReceipt.gasUsed) * BigInt(buyReceipt.effectiveGasPrice)),
      destinationAlreadyDeployed: beforeCode !== '0x', destinationCodeUnchanged: keccak256(beforeCode) === keccak256(afterCode) },
    relatedCallsInLaunchBlock: { sameDestinationAndInput: comparable.length, distinctSenders: new Set(comparable.map(t => low(t.from))).size,
      checkedReceipts: verified.length, successful: verified.filter(row => row.status === '0x1').length, reverted: failed.length,
      revertedGasPaidBnb: formatEther(failed.reduce((sum, row) => sum + BigInt(row.gasUsed) * BigInt(row.effectiveGasPrice), 0n)) },
    sameCallBeforeLaunch: before,
    buyCounts: [h, h + 1].map(block => ({ block, count: buys.filter(row => row.log.blockNumber === block).length })),
  }, null, 2));
} catch (error) {
  console.error(error?.code || error?.message || 'Read-only inspection failed');
  process.exitCode = 1;
} finally {
  provider.destroy();
}
