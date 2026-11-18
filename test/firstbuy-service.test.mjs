import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Interface, Wallet, id, parseEther, ZeroAddress } from 'ethers';
import { firstBuyArtifact } from '../src/firstbuy-contract.mjs';
import { createFirstBuyService } from '../src/firstbuy-service.mjs';
import { makeExecutor as makeRealExecutor } from '../src/execution.mjs';
import { openFirstBuyJournal } from '../src/firstbuy-runner.mjs';

const artifact=await firstBuyArtifact(),abi=new Interface(artifact.abi);
const mint='0x0000000000000000000000000000000000000002',token='0x0000000000000000000000000000000000000003';
const deployed='0x0000000000000000000000000000000000000005',factory='0xfba753f8b890eb35caa000c427f99ed5903ea517';
async function fixture(t){
  const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'corla-firstbuy-service-'));
  t.after(async()=>{const p=await realpath(root);assert.equal(dirname(p),parent);assert.ok(basename(p).startsWith('corla-firstbuy-service-'));await rm(p,{recursive:true,force:true});});
  const owner=Wallet.createRandom().address;
  const state={owner,deployed:false,armed:0,balance:0n,unlocks:0,writes:[],revision:'revision-a',local:true,prepareCalls:0,pending:false,settle:false,runnerCalls:0};
  const head={number:100,hash:id('head'),timestamp:Math.floor(Date.now()/1000)};
  const cfg={maxGasPriceWei:100_000_000n,gasLimitCap:2_000_000n,maxTotalWei:parseEther('0.5'),journalPath:join(root,'transactions.sqlite')};
  const draft={targetUrl:`https://flap.sh/apps/corla/mint/${token}?mint=${mint}&factory=${factory}&catalogVersion=4`,executorAddress:'',
    amountBnb:'0.05',maxAttempts:2,windowBlocks:60,deadlineSeconds:300,gasLimitCap:700000,maxGasPriceGwei:'0.1',gasBudgetBnb:'0.00014',maxTotalBnb:'0.5',ownerAddress:owner,callerAddresses:[owner]};
  const armParams={mint,token,amountIn:parseEther('0.05'),expectedReserveBnb:parseEther('5'),expectedReserveToken:parseEther('10000'),minOut:100n,
    validUntilBlock:160,deadline:head.timestamp+300,maxGasPriceWei:100_000_000n,maxBuyGas:540000,maxAttempts:2,maxBuyTaxBps:500,maxSellTaxBps:500,maxOpeningPremiumBps:1000,evidenceHash:id('proof')};
  const provider={getBlock:async()=>head,getNetwork:async()=>({chainId:56n}),getCode:async()=>state.deployed?artifact.expectedRuntime(owner):'0x',
    getBalance:async()=>state.balance,estimateGas:async()=>100000n,getTransactionReceipt:async hash=>hash===state.recoveryHash?
      state.returnReceipt?{hash,from:owner,to:deployed,status:1,blockNumber:100,blockHash:head.hash,logs:[{address:deployed,
        ...abi.encodeEventLog('AttemptResult',[id('intent'),1,false,0n,id('reason')])}]}:null:{contractAddress:deployed},
    async call({data,to}){
      if(to===mint){const read=new Interface(['function launched() view returns(bool)','function pool() view returns(address)']);const call=read.parseTransaction({data});return read.encodeFunctionResult(call.name,[call.name==='launched'?Boolean(state.opportunityGone):'0x0000000000000000000000000000000000000009']);}
      if(to==='0x0000000000000000000000000000000000000009'){
        const pair=new Interface(['function getReserves() view returns(uint112,uint112,uint32)']);
        return pair.encodeFunctionResult('getReserves',[parseEther('10000'),parseEther('6'),1]);
      }
      const tx=abi.parseTransaction({data});
      if(tx.name==='owner')return abi.encodeFunctionResult('owner',[owner]);
      if(tx.name==='operators')return abi.encodeFunctionResult('operators',[true]);
      if(tx.name==='readArm')return abi.encodeFunctionResult('readArm',[id('intent'),armParams,state.armed,0]);
      assert.fail('unexpected read '+tx.name);
    }};
  function apply(request){
    if(request.tx.to===null)state.deployed=true;
    else{const call=abi.parseTransaction(request.tx);
      if(call.name==='arm'){state.armed=1;state.balance+=request.tx.value;}
      if(call.name==='cancel')state.armed=3;
      if(call.name==='withdrawNative'){assert.equal(call.args[0],state.balance);state.balance-=call.args[0];}
    }
  }
  const makeExecutor=options=>{
    const fn=async request=>{state.writes.push(request);if(request.tx.to===null)assert.equal(options.allowContractCreation,true);
      await request.beforeSign?.();const txHash=id('transaction-'+state.writes.length);state.lastRequest=request;
      await state.onExecute?.({request,options,txHash});
      if(!state.pending)apply(request);
      return {actionId:request.actionId,txHash,status:state.pending?'pending':'confirmed'};};
    fn.reconcile=async actionId=>{if(state.settle){apply(state.lastRequest);return{actionId,status:'confirmed'};}return{actionId,status:'pending'};};
    fn.close=()=>{};return fn;
  };
  const build=()=>createFirstBuyService({rootDir:root,getConfig:()=>cfg,getConfigRevision:()=>state.revision,
    publicWallets:async()=>[{address:owner}],hasLocalUnlock:async()=>state.local,
    unlock:async()=>{state.unlocks++;return[{address:owner}];},provider:async()=>provider,makeExecutor,
    runExclusive:async({work})=>work({signal:new AbortController().signal,ready:()=>{},log:()=>{}}),
    artifact:async()=>artifact,prepareTarget:async()=>{state.prepareCalls++;if(state.prepareUnavailable)throw new Error('target cannot yet be hypothetically finalized');return{head,armParams,pool:'0x0000000000000000000000000000000000000009',floor:{verified:true,minOutRaw:'100',display:'100 raw'},evidence:{hash:id('proof')}};},
    journalFactory:options=>state.realJournal?openFirstBuyJournal(options):({close(){}}),runnerFactory:options=>{
      let phase='idle';return{plan:options.plan,status:()=>({phase}),async run(){
        state.runnerCalls++;
        await state.onRun?.(options);
        if(state.runUnknown){options.journal.acquire(options.plan,owner);state.recoveryHash=id('recovery');options.journal.stage(options.plan,owner,state.recoveryHash,0);phase='expired';return{phase,unresolved:true};}
        const observed=await options.readState({head});
        if(observed.state==='missed'){phase='missed';return{phase};}
        state.armed=2;state.balance=0n;phase='filled';return{phase};
      },async stop(){return{phase,unresolved:Boolean(state.runUnknown)};}};
    },
  });
  return{root,owner,state,provider,cfg,draft,armParams,build,service:await build()};
}

test('read-only prepare/status/preview never unlock, sign or deploy; preview confirmation is consumed once',async t=>{
  const f=await fixture(t);
  assert.equal((await f.service.status()).status,'not_configured');
  const prepared=await f.service.prepare(f.draft);assert.equal(prepared.status,'not_deployed');assert.equal(prepared.floor.verified,true);
  const preview=await f.service.preview('deploy',{draft:f.draft});assert.equal(preview.operation,'deploy');assert.ok(preview.summary.length>1);
  assert.equal(f.state.unlocks,0);assert.equal(f.state.writes.length,0);
  await f.service.confirm('deploy',{previewId:preview.previewId,confirmed:true});
  assert.equal(f.state.unlocks,1);assert.equal(f.state.writes.length,1);
  assert.equal((await f.service.status()).contractAddress,deployed);
  await assert.rejects(f.service.confirm('deploy',{previewId:preview.previewId,confirmed:true}),/过期或已使用/);
});

test('pure executor deployment works before a target is ready for final-Mint simulation, without floor, funding, arm or start',async t=>{
  const f=await fixture(t);f.state.prepareUnavailable=true;
  assert.equal((await f.service.status()).capabilities.deploy,true);
  const preview=await f.service.preview('deploy',{draft:f.draft});
  assert.equal(f.state.prepareCalls,0);assert.equal(f.state.unlocks,0);
  const onlyDeployment=await f.service.status();
  assert.equal(onlyDeployment.floor.verified,false);assert.equal(onlyDeployment.liveReady,false);
  assert.equal(onlyDeployment.capabilities.arm,false);
  await assert.rejects(f.service.preview('start',{planId:onlyDeployment.prepared.planId}),/尚未全部满足/);
  // The preview is deliberately single-use and a different preview invalidates
  // it; generate a fresh deployment preview for the explicit confirmation.
  const confirmed=await f.service.preview('deploy',{draft:f.draft});
  await f.service.confirm('deploy',{previewId:confirmed.previewId,confirmed:true});
  assert.equal(f.state.writes.length,1);assert.equal(f.state.writes[0].tx.to,null);assert.equal(f.state.writes[0].tx.value,0n);
  assert.equal(f.state.balance,0n);assert.equal(f.state.armed,0);assert.equal(f.state.runnerCalls,0);assert.equal(f.state.prepareCalls,0);
  const deployedStatus=await f.service.status();assert.equal(deployedStatus.capabilities.arm,false);assert.equal(deployedStatus.liveReady,false);
  await assert.rejects(f.service.preview('arm',{draft:f.draft}),/hypothetically finalized/);
  assert.equal(f.state.writes.length,1,'failed preparation never funds or arms');
});

test('only confirmed arm funds the exact plan; start requires a second one-shot confirmation and valid floor',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});assert.equal(f.state.balance,0n);
  await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});assert.equal(f.state.balance,parseEther('0.05'));
  const ready=await f.service.status();assert.equal(ready.status,'ready');assert.equal(ready.liveReady,true);
  const preview=await f.service.preview('start',{planId:ready.prepared.planId});assert.equal(f.state.runnerCalls,0);
  await f.service.confirm('start',{previewId:preview.previewId,confirmed:true});assert.equal(f.state.runnerCalls,1);
  assert.equal((await f.service.status()).status,'succeeded');
});

test('wallet policy, global caps and local-unlock requirement reject before money operations',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.prepare({...f.draft,callerAddresses:[f.owner,f.owner]}),/一个执行钱包/);
  await assert.rejects(f.service.prepare({...f.draft,gasBudgetBnb:'0.00001'}),/预算不足/);
  await assert.rejects(f.service.prepare({...f.draft,maxGasPriceGwei:'0.2',gasBudgetBnb:'0.1'}),/全局策略/);
  await f.service.prepare(f.draft);const preview=await f.service.preview('deploy',{draft:f.draft});
  f.state.revision='revision-b';await assert.rejects(f.service.confirm('deploy',{previewId:preview.previewId,confirmed:true}),/配置已改变/);
  assert.equal(f.state.unlocks,0);
  await f.service.prepare(f.draft);const noUnlock=await f.service.preview('deploy',{draft:f.draft});f.state.local=false;
  await assert.rejects(f.service.confirm('deploy',{previewId:noUnlock.previewId,confirmed:true}),/本机免密码/);assert.equal(f.state.unlocks,0);
});

test('unknown setup is persisted and resolved after restart without unlocking or resubmission',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);const preview=await f.service.preview('deploy',{draft:f.draft});
  f.state.pending=true;
  const result=await f.service.confirm('deploy',{previewId:preview.previewId,confirmed:true});assert.equal(result.unknownSubmission,true);
  const contents=await readFile(join(f.root,'firstbuy.local.json'),'utf8');assert.ok(contents.includes('pendingSetup'));
  const restarted=await f.build();assert.equal((await restarted.status()).unknownSubmission,true);assert.equal(f.state.unlocks,1);
  f.state.settle=true;
  const resolved=await restarted.status();assert.equal(resolved.submissionResolved,true);assert.equal(resolved.contractAddress,deployed);
  assert.equal(f.state.writes.length,1);assert.equal(f.state.unlocks,1);
});

test('cancel/withdraw require only executor+owner, never a tradable target or new simulation, and cannot choose arbitrary amount/recipient',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});
  const count=f.state.prepareCalls,exit={draft:{executorAddress:deployed,ownerAddress:f.owner}};
  await assert.rejects(f.service.preview('withdraw',exit),/没有可撤回/);
  const cancel=await f.service.preview('cancel',exit);assert.equal(f.state.prepareCalls,count);
  await f.service.confirm('cancel',{previewId:cancel.previewId,confirmed:true});assert.equal(f.state.armed,3);
  const restarted=await f.build();
  assert.equal((await restarted.status()).capabilities.withdraw,true,'fund recovery must remain accessible without a prepared/tradable target after restart');
  const withdraw=await f.service.preview('withdraw',exit);assert.equal(f.state.prepareCalls,count);
  await f.service.confirm('withdraw',{previewId:withdraw.previewId,confirmed:true});assert.equal(f.state.balance,0n);
  await assert.rejects(f.service.preview('withdraw',{draft:{...exit.draft,amount:'100'}}),/只需要/);
});

test('an already-bought pool is a terminal miss, never another unchanged-price race session',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});
  const state=await f.service.status(),preview=await f.service.preview('start',{planId:state.prepared.planId});
  f.state.opportunityGone=true;
  assert.equal((await f.service.confirm('start',{previewId:preview.previewId,confirmed:true})).phase,'missed');
  assert.equal((await f.service.status()).liveReady,false);
  assert.equal((await f.service.status()).status,'blocked');
});

test('competition unknown survives restart and only reconciles its original hash without unlocking or restarting',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});
  const init=makeRealExecutor({provider:{},wallets:[],live:true,journalPath:f.cfg.journalPath,maxGasPriceWei:100n,gasLimitCap:21000n});init.close();
  f.state.realJournal=true;f.state.runUnknown=true;
  const ready=await f.service.status(),preview=await f.service.preview('start',{planId:ready.prepared.planId});
  await f.service.confirm('start',{previewId:preview.previewId,confirmed:true});
  const unlocks=f.state.unlocks,writes=f.state.writes.length,restarted=await f.build();
  assert.equal((await restarted.status()).unknownSubmission,true);
  await assert.rejects(restarted.preview('cancel',{draft:{ownerAddress:f.owner,executorAddress:deployed}}),/结果仍不明/);
  f.state.returnReceipt=true;
  assert.equal((await restarted.status()).submissionResolved,true);
  assert.equal(f.state.unlocks,unlocks);assert.equal(f.state.writes.length,writes);assert.equal(f.state.runnerCalls,1);
});

test('competition recovery metadata is flushed before the runner can stage, including an exception after staging',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});
  const init=makeRealExecutor({provider:{},wallets:[],live:true,journalPath:f.cfg.journalPath,maxGasPriceWei:100n,gasLimitCap:21000n});init.close();
  f.state.realJournal=true;f.state.runUnknown=true;
  f.state.onRun=async options=>{
    const marker=JSON.parse(await readFile(join(f.root,'firstbuy.local.json'),'utf8')).pendingCompetition;
    assert.equal(marker.plan.sessionId,options.plan.sessionId);assert.equal(marker.caller,f.owner);
    assert.equal(marker.plan.maxGasWei,options.plan.maxGasWei.toString());
    assert.equal(options.journal.status(options.plan.sessionId),undefined,'marker must precede the first session/hash stage');
    options.journal.acquire(options.plan,f.owner);f.state.recoveryHash=id('crashed-run');
    options.journal.stage(options.plan,f.owner,f.state.recoveryHash,0);
    throw new Error('simulated crash immediately after the signed hash was staged');
  };
  const ready=await f.service.status(),preview=await f.service.preview('start',{planId:ready.prepared.planId});
  await assert.rejects(f.service.confirm('start',{previewId:preview.previewId,confirmed:true}),/simulated crash/);
  const restarted=await f.build(),unlocks=f.state.unlocks,writes=f.state.writes.length;
  assert.equal((await restarted.status()).unknownSubmission,true);
  f.state.returnReceipt=true;
  assert.equal((await restarted.status()).submissionResolved,true);
  assert.equal(f.state.unlocks,unlocks);assert.equal(f.state.writes.length,writes);assert.equal(f.state.runnerCalls,1);
});

test('setup pre-stage marker recovers a journaled hash even if the executor throws before returning',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const init=makeRealExecutor({provider:{},wallets:[],live:true,journalPath:f.cfg.journalPath,maxGasPriceWei:100n,gasLimitCap:21000n});init.close();
  f.state.onExecute=async({request,txHash})=>{
    const marker=JSON.parse(await readFile(join(f.root,'firstbuy.local.json'),'utf8')).pendingSetup;
    assert.equal(marker.actionId,request.actionId);assert.equal(marker.owner,f.owner);assert.equal(marker.txHash,undefined);
    const db=new DatabaseSync(f.cfg.journalPath);
    try{db.prepare("INSERT INTO actions VALUES(?,?,?,?,'pending',?)").run(f.owner,request.actionId,txHash,0,new Date().toISOString());}finally{db.close();}
    throw new Error('simulated executor interruption after durable stage');
  };
  const preview=await f.service.preview('deploy',{draft:f.draft});
  await assert.rejects(f.service.confirm('deploy',{previewId:preview.previewId,confirmed:true}),/simulated executor interruption/);
  const marker=JSON.parse(await readFile(join(f.root,'firstbuy.local.json'),'utf8')).pendingSetup;
  assert.equal(marker.txHash,id('transaction-1'));
  const restarted=await f.build();assert.equal((await restarted.status()).unknownSubmission,true);
  f.state.settle=true;assert.equal((await restarted.status()).submissionResolved,true);
  assert.equal(f.state.unlocks,1);assert.equal(f.state.writes.length,1);
});

test('competition reuses verification only for the identical canonical head hash, never a replacement head at the same height',async t=>{
  const f=await fixture(t);await f.service.prepare(f.draft);
  const deploy=await f.service.preview('deploy',{draft:f.draft});await f.service.confirm('deploy',{previewId:deploy.previewId,confirmed:true});
  const arm=await f.service.preview('arm',{draft:f.draft});await f.service.confirm('arm',{previewId:arm.previewId,confirmed:true});
  let reads=0;const getCode=f.provider.getCode;f.provider.getCode=async(...args)=>{reads++;return getCode(...args);};
  f.state.onRun=async options=>{
    const head=await f.provider.getBlock('latest'),before=reads;
    const a=await options.readState({head}),b=await options.readState({head});
    assert.equal(a.state,'armed');assert.equal(b,a);assert.equal(reads,before+1);
    f.state.opportunityGone=true;
    const fork=await options.readState({head:{...head,hash:id('replacement-head')}});
    assert.equal(fork.state,'missed');assert.equal(reads,before+2);
  };
  const ready=await f.service.status(),preview=await f.service.preview('start',{planId:ready.prepared.planId});
  assert.equal((await f.service.confirm('start',{previewId:preview.previewId,confirmed:true})).phase,'missed');
});
