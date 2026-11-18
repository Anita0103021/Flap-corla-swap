import { ContractFactory, Interface, ZeroAddress, AbiCoder, getAddress, getCreateAddress, keccak256, toQuantity, formatUnits } from 'ethers';
import { FACTORY } from './config.mjs';
import { inspectMint, requireCorlaPool, CORLA_ABI } from './corla.mjs';
import { readCorlaCreation } from './corla-creation.mjs';
import { verifySimulatedCorlaLaunch } from './snipe-preopen.mjs';
import { ROUTER, ROUTER_ABI, PANCAKE_FACTORY, WBNB, marketLimits, applyOpeningPriceGuard, v2Output } from './market.mjs';
import { firstBuyArtifact } from './firstbuy-contract.mjs';

const TOKEN = new Interface(['function mainPool() view returns(address)', 'function buyTaxRate() view returns(uint16)',
  'function sellTaxRate() view returns(uint16)', 'function decimals() view returns(uint8)', 'function approve(address,uint256) returns(bool)',
  'function balanceOf(address) view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const PAIR = new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const FACTORY_ABI = new Interface(['function getPair(address,address) view returns(address)']);
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const guard = (ok, reason) => { if (!ok) throw new Error(reason); };
const int = (x,min,max) => Number.isSafeInteger(x) && x>=min && x<=max;
const hash = x => typeof x==='string' && /^0x[0-9a-f]{64}$/i.test(x);
const uint = x => typeof x==='string' && /^0x[0-9a-f]{1,64}$/i.test(x);
const typedError=(message,code)=>Object.assign(new Error(message),{code});
const plans = new WeakSet();
export const isPreparedFirstBuyTarget = plan => plans.has(plan);

/** Read-only counterfactual launch evidence, NOT a real pending transaction.
 * Only the hypothetical sender/recipient native balances are overridden. No
 * contract storage, eligibility, launch status or token balances are changed.
 * If no valid hypothetical final minter is found the mode remains unavailable. */
export async function prepareFirstBuyTarget({ provider, target, owner, settings, simulationSenders = [], services = {} }) {
  guard((await provider.getNetwork()).chainId===56n, '首买准备只支持 BSC 56');
  owner=getAddress(owner);
  guard(owner!==ZeroAddress && same(target.factory,FACTORY), '首买目标或接收钱包无效');
  const head=await provider.getBlock('latest');
  guard(int(head?.number,0,Number.MAX_SAFE_INTEGER-4096) && hash(head.hash) && int(head.timestamp,1,Number.MAX_SAFE_INTEGER-3600), '无法核验准备区块');
  const amountIn=settings?.amountIn, gasLimit=BigInt(settings?.gasLimit ?? 0), maxGasPriceWei=BigInt(settings?.maxGasPriceWei ?? 0);
  guard(typeof amountIn==='bigint' && amountIn>0n && gasLimit>=400_000n && gasLimit<=1_660_000n &&
    maxGasPriceWei>0n && maxGasPriceWei<=100_000_000_000n && int(settings.maxAttempts,1,1024) &&
    int(settings.windowBlocks,1,2400) && int(settings.deadlineSeconds,5,1800), '首买金额、Gas 或窗口超出范围');
  const state=await (services.inspectMint ?? inspectMint)(provider,target,head.number);
  requireCorlaPool(state);
  guard(!state.launched && !state.emergencyWithdrawn && state.phase===1 && state.quoteToken===ZeroAddress &&
    state.token===ZeroAddress && state.pool===ZeroAddress && state.totalLots-state.mintedLots===1n &&
    state.fundingDeadline>BigInt(head.timestamp+5), '预置首买仅接受尚未开盘、原生 BNB 且剩余最后一份的已核验项目');
  guard(await provider.getCode(target.token,head.number)==='0x','目标 Token 已部署，不能准备首买');
  const creation=await (services.readCorlaCreation ?? readCorlaCreation)(provider,target.mint,head.number);
  const cap=Number(state.fundingDeadline-BigInt(head.timestamp));
  const deadline=head.timestamp+Math.min(settings.deadlineSeconds,cap);
  const trade={amountIn,slippageBps:1000,maxOpeningPremiumBps:1000,maxPriceImpactBps:1000,
    maxBuyTaxBps:500,maxSellTaxBps:500,deadlineSeconds:deadline-head.timestamp};
  const query=[
    {to:target.token,data:TOKEN.encodeFunctionData('mainPool')},
    {to:target.token,data:TOKEN.encodeFunctionData('buyTaxRate')},
    {to:target.token,data:TOKEN.encodeFunctionData('sellTaxRate')},
    {to:PANCAKE_FACTORY,data:FACTORY_ABI.encodeFunctionData('getPair',[WBNB,target.token])},
    {to:ROUTER,data:ROUTER_ABI.encodeFunctionData('getAmountsOut',[amountIn,[WBNB,target.token]])},
    {to:target.token,data:TOKEN.encodeFunctionData('decimals')},
  ];
  const publicList=Array.isArray(creation?.[0]?.[5]) ? creation[0][5] : [];
  const candidates=[...new Set([...simulationSenders, owner, state.creator,...publicList].filter(Boolean).map(getAddress))]
    .filter(address=>address!==ZeroAddress);
  const senderList=candidates.slice(0,512);
  guard(senderList.length>0,'没有可核验的假设末笔发送地址');
  async function simulate(sender,calls) {
    const balances=Object.fromEntries([sender,owner].map(address=>[address,{balance:toQuantity(100n*10n**18n)}]));
    let response;
    try { response=await provider.send('eth_simulateV1',[{blockStateCalls:[{
      blockOverrides:{time:toQuantity(head.timestamp+1)}, stateOverrides:balances,calls,
    }],validation:false},toQuantity(head.number)]); }
    catch { throw typedError('RPC 无法完成只读顺序模拟，未生成价格底线；请检查节点能力或限流后重试','FIRSTBUY_SIMULATION_RPC_UNAVAILABLE'); }
    const block=Array.isArray(response)&&response.length===1?response[0]:null;
    guard(block && same(block.parentHash,head.hash) && uint(block.number) && BigInt(block.number)===BigInt(head.number)+1n &&
      uint(block.timestamp) && BigInt(block.timestamp)===BigInt(head.timestamp)+1n && Array.isArray(block.calls) &&
      block.calls.length===calls.length, '节点返回的只读模拟区块或调用数量不完整');
    if(!block.calls.every(row=>row.status==='0x1')) throw typedError('假设末笔或连续买卖模拟未全部成功','FIRSTBUY_HYPOTHETICAL_CALL_REVERTED');
    return block.calls;
  }
  let selected,preview,mintCall, scanned=0, eligible=0, simulated=0;
  // Scan public eligibility without limiting the search to the first twenty
  // already-used wallets. Only eligible identities consume the simulation cap.
  for(let offset=0;offset<senderList.length && !selected && simulated<20;offset+=32){
    const wave=senderList.slice(offset,offset+32);
    let counts;
    try { counts=await Promise.all(wave.map(async sender=>{
      const count=await provider.call({to:target.mint,data:CORLA_ABI.encodeFunctionData('walletMintCount',[sender]),blockTag:head.number});
      return CORLA_ABI.decodeFunctionResult('walletMintCount',count)[0];
    })); } catch { throw typedError('RPC 无法完成公开候选额度核验，未生成价格底线；请稍后重试','FIRSTBUY_PREPARATION_RPC_UNAVAILABLE'); }
    scanned+=wave.length;
    for(let i=0;i<wave.length && !selected && simulated<20;i++){
      const sender=wave[i];
      if(counts[i]>=state.maxMintsPerWallet)continue;
      eligible++;
      const call={from:sender,to:target.mint,data:CORLA_ABI.encodeFunctionData('mint',[[]]),value:toQuantity(state.pricePerLot),gas:toQuantity(14_500_000)};
      simulated++;
      try {
        preview=await simulate(sender,[call,...query.map(row=>({from:owner,...row}))]);
        selected=sender;mintCall=call;
      } catch(error) {
        if(error.code!=='FIRSTBUY_HYPOTHETICAL_CALL_REVERTED')throw error;
      }
    }
  }
  guard(selected && preview,'无法在不修改合约资格的情况下完成假设末笔；不会伪造价格底线');
  function verify(results){
    const seed=verifySimulatedCorlaLaunch(results[0],target,selected,state.totalLots,WBNB);
    const decode=(abi,name,row)=>{
      const values=abi.decodeFunctionResult(name,row.returnData);
      guard(same(abi.encodeFunctionResult(name,values),row.returnData),'模拟返回值不完整');return values;
    };
    const mainPool=decode(TOKEN,'mainPool',results[1])[0],buyTax=decode(TOKEN,'buyTaxRate',results[2])[0],
      sellTax=decode(TOKEN,'sellTaxRate',results[3])[0],pair=decode(FACTORY_ABI,'getPair',results[4])[0],
      amounts=decode(ROUTER_ABI,'getAmountsOut',results[5])[0],decimals=decode(TOKEN,'decimals',results[6])[0];
    guard(same(mainPool,seed.pool) && same(pair,seed.pool) && amounts.length===2 && amounts[0]===amountIn &&
      amounts[1]===v2Output(amountIn,seed.reserveQuote,seed.reserveToken) && decimals<=36n,'模拟池、支付路径或报价不一致');
    return {...seed,buyTax,sellTax,quoted:amounts[1],decimals:Number(decimals)};
  }
  const seed=verify(preview);
  guard(amountIn*10n<=seed.reserveQuote,'买入金额不能超过已核验初始 BNB 储备的 10%（与链上执行器一致）');
  const limits=applyOpeningPriceGuard({...seed,...marketLimits({...seed,amountIn,settings:trade})},seed,seed.buyTax,trade);
  const buy={from:owner,to:ROUTER,value:toQuantity(amountIn),data:ROUTER_ABI.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens',
    [limits.amountOutMin,[WBNB,target.token],owner,deadline])};
  const approve={from:owner,to:target.token,data:TOKEN.encodeFunctionData('approve',[ROUTER,limits.amountOutMin])};
  const sell={from:owner,to:ROUTER,data:ROUTER_ABI.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens',
    [limits.amountOutMin,limits.reverseMin,[target.token,WBNB],owner,deadline])};
  const actual=await simulate(selected,[mintCall,...query.map(row=>({from:owner,...row})),buy,approve,sell]);
  const checked=verify(actual);
  guard(Object.keys(seed).every(key=>seed[key]===checked[key]),'两次假设开盘模拟不一致');
  const bought=actual[7],sold=actual[9];
  const logValues=(row,abi,event,address)=>(row.logs??[]).filter(log=>same(log.address,address)).flatMap(log=>{
    try{const d=abi.parseLog(log);return d?.name===event?[d.args]:[]}catch{return[]}
  });
  const swaps=logValues(bought,PAIR,'Swap',seed.pool),reverse=logValues(sold,PAIR,'Swap',seed.pool);
  const received=logValues(bought,TOKEN,'Transfer',target.token).filter(row=>same(row.from,seed.pool)&&same(row.to,owner)).reduce((n,row)=>n+row.value,0n);
  guard(swaps.length===1 && same(swaps[0].sender,ROUTER) && same(swaps[0].to,owner) &&
    (seed.quoteFirst?swaps[0].amount0In:swaps[0].amount1In)===amountIn && received>=limits.amountOutMin && reverse.length===1 &&
    (seed.quoteFirst?reverse[0].amount0Out:reverse[0].amount1Out)>=limits.reverseMin,'没有核验到最低到账和可卖出结果');
  const gas=uint(bought.gasUsed)?BigInt(bought.gasUsed):0n;
  const maxBuyGas=Number(gasLimit-200_000n);
  guard(gas>=21_000n && gas+120_000n<=BigInt(maxBuyGas),'每笔 Gas 上限不足以覆盖已模拟买入和执行器检查');
  const canonical=await provider.getBlock(head.number);
  guard(canonical?.hash===head.hash,'准备父块已重组，请重新准备');
  const evidenceHash=keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256','bytes32','address','address','address','uint256','uint256','uint256','uint256','uint256','uint256'],
    [56,head.hash,target.mint,target.token,owner,amountIn,seed.reserveQuote,seed.reserveToken,limits.amountOutMin,seed.buyTax,seed.sellTax]));
  const armParams=Object.freeze({mint:getAddress(target.mint),token:getAddress(target.token),amountIn,
    expectedReserveBnb:seed.reserveQuote,expectedReserveToken:seed.reserveToken,minOut:limits.amountOutMin,
    validUntilBlock:head.number+settings.windowBlocks,deadline,maxGasPriceWei,maxBuyGas,maxAttempts:settings.maxAttempts,
    maxBuyTaxBps:500,maxSellTaxBps:500,maxOpeningPremiumBps:1000,evidenceHash});
  const [artifact, ownerNonce]=await Promise.all([
    (services.firstBuyArtifact ?? firstBuyArtifact)(),provider.getTransactionCount(owner,head.number),
  ]);
  guard(int(ownerNonce,0,Number.MAX_SAFE_INTEGER),'无法核验首买准备钱包 nonce');
  const executor=getCreateAddress({from:owner,nonce:ownerNonce});
  guard(!same(executor,target.mint) && !same(executor,target.token) && await provider.getCode(executor,head.number)==='0x',
    '无法使用未部署的首买预审 CREATE 地址');
  const abi=new Interface(artifact.abi);
  const deploy=(await new ContractFactory(artifact.abi,artifact.bytecode).getDeployTransaction(owner,[])).data;
  const intentId=keccak256(AbiCoder.defaultAbiCoder().encode(
    ['uint256','address','address','uint256',abi.getFunction('arm').inputs[0]],[56,executor,owner,1,armParams]));
  const atExecutor=(name,args=[],extra={})=>({from:owner,to:executor,data:abi.encodeFunctionData(name,args),gas:toQuantity(1_500_000),...extra});
  let full;
  try { full=await simulate(selected,[
    {from:owner,nonce:toQuantity(ownerNonce),data:deploy,gas:toQuantity(5_000_000)},
    atExecutor('owner'),atExecutor('arm',[armParams],{value:toQuantity(amountIn)}),mintCall,
    {from:owner,to:target.token,data:TOKEN.encodeFunctionData('balanceOf',[owner])},
    atExecutor('execute',[intentId],{gas:toQuantity(gasLimit),gasPrice:toQuantity(maxGasPriceWei)}),
    {from:owner,to:target.token,data:TOKEN.encodeFunctionData('balanceOf',[owner])},atExecutor('readArm'),
  ]); } catch(error) {
    if(error.code==='FIRSTBUY_HYPOTHETICAL_CALL_REVERTED') throw typedError('生产首买执行器完整预审失败，可能 Gas 不足或池状态变化；未生成可成交计划','FIRSTBUY_EXECUTOR_SIMULATION_FAILED');
    throw error;
  }
  const decodeCore=(name,index)=>abi.decodeFunctionResult(name,full[index].returnData);
  guard(same(decodeCore('owner',1)[0],owner),'首买预审执行器 owner 不一致');
  const identity=verifySimulatedCorlaLaunch(full[3],target,selected,state.totalLots,WBNB);
  guard(identity.pool===seed.pool && identity.reserveQuote===seed.reserveQuote && identity.reserveToken===seed.reserveToken,
    '生产执行器预审与初始流动性证据不一致');
  const filled=logValues(full[5],abi,'Filled',executor),attempt=logValues(full[5],abi,'AttemptResult',executor);
  const [beforeBalance]=TOKEN.decodeFunctionResult('balanceOf',full[4].returnData);
  const [afterBalance]=TOKEN.decodeFunctionResult('balanceOf',full[6].returnData);
  const armed=decodeCore('readArm',7);
  guard(decodeCore('execute',5)[0]===true && filled.length===1 && attempt.length===1 && attempt[0].bought===true &&
    same(filled[0].intentId,intentId) && same(filled[0].mint,target.mint) && same(filled[0].token,target.token) &&
    same(filled[0].recipient,owner) && filled[0].amountIn===amountIn && afterBalance>=beforeBalance &&
    afterBalance-beforeBalance===filled[0].amountOut && filled[0].amountOut>=limits.amountOutMin &&
    same(attempt[0].intentId,intentId) && attempt[0].attempt===1n && attempt[0].amountOut===filled[0].amountOut &&
    same(armed.intentId,intentId) && armed.state===2n && armed.attempts===1n,
  '生产首买执行器未在指定 Gas 内买成；不会把 status=1 的失败尝试作为可成交计划');
  const executorGas=uint(full[5].gasUsed)?BigInt(full[5].gasUsed):0n;
  guard(executorGas>=21_000n && executorGas<=gasLimit,'生产首买执行器 Gas 证据无效');
  const finalCanonical=await provider.getBlock(head.number);
  guard(finalCanonical?.hash===head.hash,'首买完整预审父块已重组，请重新准备');
  const result=Object.freeze({head:Object.freeze({number:head.number,hash:head.hash,timestamp:head.timestamp}),mint:target.mint,token:target.token,owner,
    armParams,floor:Object.freeze({verified:true,minOutRaw:limits.amountOutMin.toString(),display:formatUnits(limits.amountOutMin,seed.decimals)}),
    evidence:Object.freeze({hash:evidenceHash,kind:'hypothetical-final-mint',sender:selected,parentBlock:head.number,parentHash:head.hash,
      nativeBalanceOverrideOnly:true,notRealPending:true,routerBuyGas:gas.toString(),executorBuyGas:executorGas.toString(),
      productionExecutorValidated:true,candidateScanCount:scanned,candidateEligibleCount:eligible,
      candidateSimulationCount:simulated,candidateScanTruncated:candidates.length>senderList.length,
      buyTaxBps:seed.buyTax.toString(),sellTaxBps:seed.sellTax.toString()}),
    pool:seed.pool});
  plans.add(result);return result;
}
