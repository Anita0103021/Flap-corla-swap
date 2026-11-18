import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroAddress, id, parseEther, toQuantity } from 'ethers';
import { prepareFirstBuyTarget, isPreparedFirstBuyTarget } from '../src/firstbuy-prepare.mjs';
import { CORLA_ABI } from '../src/corla.mjs';
import { FACTORY } from '../src/config.mjs';
import { DIRECT_LAUNCH_PORTAL } from '../src/events.mjs';
import { PANCAKE_FACTORY, ROUTER, ROUTER_ABI, WBNB, v2Output } from '../src/market.mjs';
import { firstBuyArtifact } from '../src/firstbuy-contract.mjs';
const artifact=await firstBuyArtifact(),core=new Interface(artifact.abi);

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const target={factory:FACTORY,mint:addr(33),token:addr(44)},owner=addr(99),pool=addr(55);
const head={number:100,hash:id('public firstbuy prepare parent'),timestamp:1000000,provider:'MUST_NOT_BE_EXPORTED'};
const amount=parseEther('.05'), reserveQuote=parseEther('5'),reserveToken=parseEther('5000');
const state={phase:1,launched:false,emergencyWithdrawn:false,quoteToken:ZeroAddress,token:ZeroAddress,pool:ZeroAddress,
  totalLots:50n,mintedLots:49n,pricePerLot:parseEther('.1'),tokensPerLot:parseEther('100'),fundingDeadline:1003600n,
  maxMintsPerWallet:1n,creator:owner,poolRoute:'pancake_v2',quoteEnabled:true};
const token=new Interface(['function mainPool() view returns(address)','function buyTaxRate() view returns(uint16)',
  'function sellTaxRate() view returns(uint16)','function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const factory=new Interface(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
  'function getPair(address,address) view returns(address)']);
const pair=new Interface(['event Mint(address indexed sender,uint256 amount0,uint256 amount1)','event Sync(uint112 reserve0,uint112 reserve1)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const portal=new Interface(['event FlapDirectLaunched(address token,uint8 kind,address creator,bytes32 schemaId,bytes data)']);
const event=(abi,name,address,args)=>({address,...abi.encodeEventLog(name,args)});
const ok=(returnData='0x',logs=[],gasUsed='0x5208')=>({status:'0x1',returnData,logs,gasUsed});
const settings={amountIn:amount,gasLimit:700000n,maxGasPriceWei:100000000n,maxAttempts:120,windowBlocks:600,deadlineSeconds:300};

function fixture({badOutput=false,reorg=false,statePatch={},wrongChain=false,amountIn=amount,badExecutor=false,
  falseBalance=false,rpcError=false,publicList=[],eligibleSender=owner,gasLimit=settings.gasLimit}={}){
  let simulations=0;
  const gross=v2Output(amountIn,reserveQuote,reserveToken), net=gross*9700n/10000n;
  const data=AbiCoder.defaultAbiCoder().encode(['tuple(uint256,uint256,uint8,address,uint8,uint256,string,string,string,address,uint256,uint8,uint16)'],
    [[1,head.timestamp+1,0,ZeroAddress,1,1,'Mock','MOCK','',pool,reserveToken*2n,0,0]]);
  const provider={getNetwork:async()=>({chainId:wrongChain?1n:56n}),getBlock:async tag=>tag==='latest'||!reorg?head:{...head,hash:id('changed')},
    getCode:async()=> '0x',getTransactionCount:async()=>0,
    call:async({data})=>{const parsed=CORLA_ABI.parseTransaction({data});assert.equal(parsed.name,'walletMintCount');
      return CORLA_ABI.encodeFunctionResult('walletMintCount',[parsed.args[0].toLowerCase()===eligibleSender.toLowerCase()?0:1]);},
    async send(method,[payload,at]){
      assert.equal(method,'eth_simulateV1');assert.equal(at,toQuantity(head.number));
      assert.equal(payload.validation,false);
      const block=payload.blockStateCalls[0],calls=block.calls;
      assert.equal(block.blockOverrides.time,toQuantity(head.timestamp+1));
      const hypotheticalSender=calls[0].to===undefined?calls[3].from:calls[0].from;
      assert.deepEqual(Object.keys(block.stateOverrides).sort(),[...new Set([hypotheticalSender,owner])].sort());
      for(const override of Object.values(block.stateOverrides))assert.deepEqual(Object.keys(override),['balance'],'no contract storage/nonce override is allowed');
      simulations++;
      if(rpcError)throw Object.assign(new Error('secret RPC url must not escape'),{code:'SERVER_ERROR'});
      const full=calls[0].to===undefined;
      const sender=full?calls[3].from:calls[0].from;
      const rows=[ok('0x',[
        event(CORLA_ABI,'Minted',target.mint,[sender,50]),event(CORLA_ABI,'Launched',target.mint,[target.token,pool,sender]),
        event(portal,'FlapDirectLaunched',DIRECT_LAUNCH_PORTAL,[target.token,0,target.mint,id('DirectLaunchV2(DirectLaunchV2Data)'),data]),
        event(factory,'PairCreated',PANCAKE_FACTORY,[target.token,WBNB,pool,1]),event(pair,'Mint',pool,[DIRECT_LAUNCH_PORTAL,reserveToken,reserveQuote]),
        event(pair,'Sync',pool,[reserveToken,reserveQuote]),
      ]),ok(token.encodeFunctionResult('mainPool',[pool])),ok(token.encodeFunctionResult('buyTaxRate',[300])),
      ok(token.encodeFunctionResult('sellTaxRate',[300])),ok(factory.encodeFunctionResult('getPair',[pool])),
      ok(ROUTER_ABI.encodeFunctionResult('getAmountsOut',[[amountIn,gross]])),ok(token.encodeFunctionResult('decimals',[18]))];
      if(calls.length===10){
        const buy=ROUTER_ABI.parseTransaction(calls[7]),sell=ROUTER_ABI.parseTransaction(calls[9]);
        assert.equal(buy.args[0],(net*10000n+10999n)/11000n);
        rows.push(ok('0x',[event(pair,'Swap',pool,[ROUTER,0,amountIn,gross,0,owner]),
          event(token,'Transfer',target.token,[pool,owner,badOutput?1n:net])],toQuantity(236542)),ok(),
        ok('0x',[event(pair,'Swap',pool,[ROUTER,sell.args[0],0,0,sell.args[1],owner])]));
      }
      if(full){
        assert.equal(calls.length,8);
        assert.equal(BigInt(calls[5].gas),gasLimit,'the exact requested outer Gas limit is actually simulated');
        const params=core.parseTransaction(calls[2]).args[0],intent=core.parseTransaction(calls[5]).args[0],executor=calls[5].to;
        const result=[ok(),ok(core.encodeFunctionResult('owner',[owner])),ok(core.encodeFunctionResult('arm',[intent])),rows[0],
          ok(token.encodeFunctionResult('balanceOf',[0])),
          ok(core.encodeFunctionResult('execute',[!badExecutor]),[
            ...(!badExecutor?[event(core,'Filled',executor,[intent,target.mint,target.token,owner,amountIn,net])]:[]),
            event(core,'AttemptResult',executor,[intent,1,!badExecutor,badExecutor?0:net,id('mock reason')]),
          ],toQuantity(450000)),
          ok(token.encodeFunctionResult('balanceOf',[badExecutor?0:falseBalance?net+1n:net])),
          ok(core.encodeFunctionResult('readArm',[intent,params,badExecutor?1:2,1]))];
        return [{parentHash:head.hash,number:toQuantity(101),timestamp:block.blockOverrides.time,calls:result}];
      }
      return [{parentHash:head.hash,number:toQuantity(101),timestamp:block.blockOverrides.time,calls:rows}];
    }};
  return {simulations:()=>simulations,run:()=>prepareFirstBuyTarget({provider,target,owner,settings:{...settings,amountIn,gasLimit},services:{
    inspectMint:async()=>({...state,...statePatch}),readCorlaCreation:async()=>[[0,0,0,0,0,publicList]],firstBuyArtifact:async()=>artifact,
  }})};
}

test('hypothetical final mint proves the initial floor without real pending, signing, or protocol-state overrides',async()=>{
  const f=fixture(),plan=await f.run();
  assert.equal(f.simulations(),3);assert.equal(isPreparedFirstBuyTarget(plan),true);
  assert.equal(isPreparedFirstBuyTarget({...plan}),false);
  assert.equal(plan.armParams.expectedReserveBnb,reserveQuote);assert.equal(plan.armParams.expectedReserveToken,reserveToken);
  assert.equal(plan.evidence.notRealPending,true);assert.equal(plan.evidence.nativeBalanceOverrideOnly,true);
  assert.equal(plan.evidence.productionExecutorValidated,true);assert.equal(plan.evidence.executorBuyGas,'450000');
  assert.deepEqual(Object.keys(plan.head),['number','hash','timestamp']);
  assert.equal(JSON.stringify(plan.head).includes('MUST_NOT_BE_EXPORTED'),false);
  assert.equal(Object.isFrozen(plan.armParams),true);
});

test('status=1 without Filled or a contradictory recipient balance cannot brand an executable plan',async()=>{
  await assert.rejects(fixture({badExecutor:true}).run(),/指定 Gas 内买成/);
  await assert.rejects(fixture({falseBalance:true}).run(),/指定 Gas 内买成/);
  await assert.rejects(fixture({gasLimit:516542n}).run(),/Gas 上限不足/);
});

test('used public whitelist identities do not consume the twenty actual-simulation slots',async()=>{
  const publicList=Array.from({length:51},(_,i)=>addr(1000+i)),eligibleSender=publicList.at(-1);
  const f=fixture({publicList,eligibleSender}),plan=await f.run();
  assert.equal(plan.evidence.sender.toLowerCase(),eligibleSender.toLowerCase());
  assert.equal(plan.evidence.candidateScanCount,52);
  assert.equal(plan.evidence.candidateSimulationCount,1);
  assert.equal(f.simulations(),3);
});

test('RPC failures are not swallowed and mislabelled as minter eligibility failures',async()=>{
  const f=fixture({rpcError:true});
  await assert.rejects(f.run(),error=>error.code==='FIRSTBUY_SIMULATION_RPC_UNAVAILABLE' && !error.message.includes('secret'));
  assert.equal(f.simulations(),1);
});

test('wrong chain, nonfinal target, deployed/quote/phase changes refuse before any money movement',async()=>{
  for(const options of [{wrongChain:true},{statePatch:{mintedLots:48n}},{statePatch:{quoteToken:addr(123)}},
    {statePatch:{phase:3,launched:true}}]){
    const f=fixture(options);await assert.rejects(f.run());assert.equal(f.simulations(),0);
  }
});

test('fake minimum delivery or a changed canonical parent cannot brand a prepared plan',async()=>{
  await assert.rejects(fixture({badOutput:true}).run(),/最低到账/);
  await assert.rejects(fixture({reorg:true}).run(),/重组/);
});

test('preparation enforces the same ten-percent initial-reserve bound as the on-chain arm before setup spending',async()=>{
  const f=fixture({amountIn:parseEther('0.53')});
  await assert.rejects(f.run(),/初始 BNB 储备的 10%/);
  assert.equal(f.simulations(),1,'reject before preparing the second buy/sell simulation or any transaction');
});
