import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Interface, formatEther, getAddress, keccak256, parseEther, parseUnits, ZeroAddress } from 'ethers';
import { parseMintLink } from './config.mjs';
import { FACTORY } from './config.mjs';
import { firstBuyArtifact } from './firstbuy-contract.mjs';
import { checkedFirstBuyPlan, makeFirstBuyRunner, openFirstBuyJournal } from './firstbuy-runner.mjs';
import { WBNB } from './market.mjs';
const FUNDING_STATE_ABI=new Interface(['function launched() view returns(bool)','function pool() view returns(address)']);
const RESERVES_ABI=new Interface(['function getReserves() view returns(uint112,uint112,uint32)']);

const keys = new Set(['targetUrl','executorAddress','amountBnb','maxAttempts','windowBlocks','deadlineSeconds',
  'gasLimitCap','maxGasPriceGwei','gasBudgetBnb','maxTotalBnb','ownerAddress','callerAddresses']);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const encode = value => JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
const digest = value => createHash('sha256').update(encode(value)).digest('hex');
const error = (message, status=400) => Object.assign(new Error(message), { status });
const check = (value,message) => { if(!value)throw error(message); };
const integer = (value,min,max) => { const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
  check(Number.isSafeInteger(n)&&n>=min&&n<=max,'首买整数参数无效');return n; };
const address = value => {const a=getAddress(value);check(a!==ZeroAddress,'首买地址不能为零');return a;};
const decimal = (value,decimals) => {check(typeof value==='string'&&/^(?:0|[1-9]\d{0,30})(?:\.\d+)?$/.test(value),'首买金额必须是普通十进制数字');const n=parseUnits(value,decimals);check(n>0n,'首买金额必须大于零');return n;};
const ARM_FIELDS = ['mint','token','amountIn','expectedReserveBnb','expectedReserveToken','minOut','validUntilBlock','deadline',
  'maxGasPriceWei','maxBuyGas','maxAttempts','maxBuyTaxBps','maxSellTaxBps','maxOpeningPremiumBps','evidenceHash'];
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch{return false;}};

/** Backend coordinator. All key access and spending are behind a one-shot
 * preview confirmation AND the host's globally-exclusive task callback. */
export async function createFirstBuyService({ rootDir, getConfig, getConfigRevision, publicWallets, hasLocalUnlock,
  unlock, provider: getProvider, releaseProvider=()=>{}, runExclusive, makeExecutor, log=()=>{}, prepareTarget,
  artifact: artifactFn=firstBuyArtifact, runnerFactory=makeFirstBuyRunner, journalFactory=openFirstBuyJournal } = {}) {
  const file=join(rootDir,'firstbuy.local.json');
  let saved={version:1}, prepared=null, activeRunner=null, current='not_configured', pendingSetup=null, pendingCompetition=null;
  const previews=new Map();
  try {const value=JSON.parse(await readFile(file,'utf8'));if(value.version===1){
    saved={version:1,...(value.contractAddress&&value.ownerAddress?{contractAddress:address(value.contractAddress),ownerAddress:address(value.ownerAddress)}:{}),
      setupReservedWei:/^\d{1,78}$/.test(value.setupReservedWei??'')?value.setupReservedWei:'0'};
    if(['deploy','arm','cancel','withdraw'].includes(value.pendingSetup?.operation)&&
      (value.pendingSetup.txHash===undefined||/^0x[0-9a-f]{64}$/i.test(value.pendingSetup.txHash))&&
      /^firstbuy:(deploy|arm|cancel|withdraw):[0-9a-f]{64}$/.test(value.pendingSetup.actionId??'')){
      pendingSetup={operation:value.pendingSetup.operation,txHash:value.pendingSetup.txHash,actionId:value.pendingSetup.actionId,owner:address(value.pendingSetup.owner),pid:value.pendingSetup.pid};
      saved.pendingSetup=pendingSetup;
    }
    if(value.pendingCompetition){
      const plan={...value.pendingCompetition.plan};
      for(const key of ['amountIn','minOut','gasLimit','gasPrice','maxGasWei'])plan[key]=BigInt(plan[key]);
      pendingCompetition={plan:checkedFirstBuyPlan(plan),caller:address(value.pendingCompetition.caller),pid:value.pendingCompetition.pid};
      saved.pendingCompetition=pendingCompetition;
    }
    if(value.lastCompetition&&/^0x[0-9a-f]{64}$/i.test(value.lastCompetition.intentId??'')&&
      ['filled','missed','expired','exhausted','stopped','paused'].includes(value.lastCompetition.state)){
      saved.lastCompetition={contract:address(value.lastCompetition.contract),intentId:value.lastCompetition.intentId,state:value.lastCompetition.state};
    }
  }}
  catch(e){if(e.code!=='ENOENT')throw error('无法读取firstbuy.local.json');}
  const save=async()=>{const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';try{await writeFile(temp,encode(saved)+'\n',{flag:'wx',mode:0o600,flush:true});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}};
  const walletsKey=async()=>digest((await publicWallets()).map(w=>address(w.address).toLowerCase()).sort());
  function setupAction(row){
    const path=getConfig().journalPath;if(!existsSync(path))return null;
    const db=new DatabaseSync(path,{readOnly:true});
    try{return db.prepare('SELECT tx_hash,status FROM actions WHERE wallet=? AND action_id=?').get(row.owner,row.actionId)??null;}finally{db.close();}
  }
  async function normalize(input) {
    check(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>keys.has(k)),'首买配置包含不支持的字段');
    const target=parseMintLink(input.targetUrl), owner=address(input.ownerAddress);
    check(Array.isArray(input.callerAddresses)&&input.callerAddresses.length===1,'当前首买模式仅支持一个执行钱包，不能假装多钱包并行');
    const caller=address(input.callerAddresses[0]);check(caller===owner,'当前首买模式要求部署钱包与唯一执行钱包相同');
    const allowed=await publicWallets();check(allowed.some(w=>same(w.address,owner)),'请选择已导入的钱包');
    const cfg=getConfig(), draft={...input,ownerAddress:owner,callerAddresses:[caller],executorAddress:input.executorAddress?address(input.executorAddress):'',
      maxAttempts:integer(input.maxAttempts,1,1024),windowBlocks:integer(input.windowBlocks,1,2400),deadlineSeconds:integer(input.deadlineSeconds,10,1800),gasLimitCap:integer(input.gasLimitCap,310000,1660000)};
    const units={amountIn:decimal(draft.amountBnb,18),gasPrice:decimal(draft.maxGasPriceGwei,9),gasBudget:decimal(draft.gasBudgetBnb,18),maxTotal:decimal(draft.maxTotalBnb,18)};
    const worst=BigInt(draft.maxAttempts)*BigInt(draft.gasLimitCap)*units.gasPrice;
    check(BigInt(draft.gasLimitCap)<=cfg.gasLimitCap&&units.gasPrice<=cfg.maxGasPriceWei,'首买每笔Gas超过全局策略上限');
    check(units.gasBudget>=worst&&units.amountIn+worst<=units.maxTotal,'首买总预算不足以覆盖全部最坏尝试');
    check(cfg.maxTotalWei!==null&&units.amountIn+worst<=cfg.maxTotalWei,'首买支出超过全局总预算或全局预算未设置');
    return {draft,target,owner,caller,cfg,units,worst,key:digest(draft)};
  }
  async function artifactFor(owner){const artifact=await artifactFn();return {artifact,abi:new Interface(artifact.abi),codeHash:artifact.expectedCodeHash(owner)};}
  async function verifyContract(provider,config,head) {
    const contract=config.draft.executorAddress||(same(saved.ownerAddress,config.owner)?saved.contractAddress:'');
    if(!contract)return null;
    const {artifact,abi,codeHash}=await artifactFor(config.owner);
    const code=await provider.getCode(contract,head.number);check(code!=='0x'&&keccak256(code)===codeHash,'执行器不是本版本编译的预期owner合约');
    const read=async(name,args=[])=>abi.decodeFunctionResult(name,await provider.call({to:contract,blockTag:head.number,data:abi.encodeFunctionData(name,args)}));
    const [[owner],[operator],arm]=await Promise.all([read('owner'),read('operators',[config.caller]),read('readArm')]);
    check(same(owner,config.owner)&&(config.exitOnly||operator===true),'执行器owner或执行钱包授权不匹配');
    return {contract,artifact,abi,codeHash,arm,authorized:operator===true};
  }
  function assertParams(actual,expected){for(const name of ARM_FIELDS){const a=actual[name],b=expected[name];check(typeof b==='string'?same(a,b):BigInt(a)===BigInt(b),'链上预置参数与已核验计划不同：'+name);}}
  const requirePrepared=()=>{check(prepared&&prepared.expiresAt>Date.now(),'请重新生成有效的只读准备结果');check(prepared.revision===getConfigRevision(),'配置已改变，请重新准备首买');return prepared;};
  async function withProvider(work){const cfg=getConfig(),provider=await getProvider(cfg);try{return await work(provider,cfg);}finally{releaseProvider(provider);}}
  async function prepare(draft) {
    check(!pendingSetup&&!pendingCompetition,'上一项提交仍待核对，不能生成新预置');
    const config=await normalize(draft);
    let existingArm;
    const proof=await withProvider(async provider=>{
      const fn=prepareTarget??(await import('./firstbuy-prepare.mjs')).prepareFirstBuyTarget;
      const proof=await fn({provider,target:config.target,owner:config.owner,settings:{amountIn:config.units.amountIn,
        maxAttempts:config.draft.maxAttempts,windowBlocks:config.draft.windowBlocks,deadlineSeconds:config.draft.deadlineSeconds,
        gasLimit:BigInt(config.draft.gasLimitCap),maxGasPriceWei:config.units.gasPrice}});
      const contract=await verifyContract(provider,config,await provider.getBlock('latest'));
      if(contract&&Number(contract.arm[2])===1){
        const params=contract.arm[1];
        for(const name of ARM_FIELDS.filter(k=>!['deadline','validUntilBlock','evidenceHash'].includes(k))){
          const actual=params[name],expected=proof.armParams[name];
          check(typeof expected==='string'?same(actual,expected):BigInt(actual)===BigInt(expected),'现有预置与新准备参数不同，请先取消旧预置');
        }
        check(BigInt(params.deadline)<=BigInt(proof.armParams.deadline)&&BigInt(params.validUntilBlock)<=BigInt(proof.armParams.validUntilBlock),
          '新窗口比现有预置更严格，请先取消旧预置');
        existingArm=Object.fromEntries(ARM_FIELDS.map(name=>[name,params[name]]));
      }
      return proof;
    });
    check(proof?.floor?.verified===true&&BigInt(proof.floor.minOutRaw)>0n&&proof.armParams,'没有可信开盘储备和价格底线，不能准备首买');
    prepared={id:randomBytes(16).toString('hex'),config,proof:existingArm?{...proof,armParams:existingArm}:proof,
      expiresAt:existingArm?Number(existingArm.deadline)*1000:Date.now()+120000,revision:getConfigRevision(),walletKey:await walletsKey()};
    current='prepared';return status();
  }
  async function status() {
    if(pendingCompetition&&!activeRunner)await withProvider(async(provider)=>{
      let journal;
      const recovery=pendingCompetition,plan=recovery.plan;
      try{
        const config={owner:plan.recipient,caller:recovery.caller,draft:{executorAddress:plan.contract},exitOnly:true};
        const contract=await verifyContract(provider,config,await provider.getBlock('latest'));
        check(same(contract.arm[0],plan.intentId)&&same(contract.codeHash,plan.expectedCodeHash),'未决首买意图已改变，不能自动解锁');
        journal=journalFactory({journalPath:getConfig().journalPath});
        if(!journal.status(plan.sessionId)){
          if(recovery.pid!==process.pid&&alive(recovery.pid))return;
          pendingCompetition=null;delete saved.pendingCompetition;await save();return;
        }
        journal.markTerminal(plan.sessionId,Number(contract.arm[2])===2?'filled':'stopped');
        const runner=makeFirstBuyRunner({plan,journal,provider,signer:{address:recovery.caller,signTransaction:()=>{throw error('只读核对禁止签名');}},
          readState:()=>{throw error('只读核对不得开启新执行');},transport:()=>{throw error('只读核对禁止广播');}});
        const result=await runner.step();
        if(!result.unresolved&&result.phase!=='paused'){
          saved.lastCompetition={contract:plan.contract,intentId:plan.intentId,state:result.phase};
          pendingCompetition=null;delete saved.pendingCompetition;await save();
          current=result.phase==='filled'?'succeeded':'stopped';
        }
      }finally{journal?.close();}
    }).catch(()=>{});
    if(pendingSetup)await withProvider(async(provider,cfg)=>{
      let checker;
      try{
        if(!pendingSetup.txHash){
          const action=setupAction(pendingSetup);
          if(action){pendingSetup.txHash=action.tx_hash;saved.pendingSetup=pendingSetup;await save();}
          else{
            if(pendingSetup.pid===process.pid||alive(pendingSetup.pid))return;
            pendingSetup=null;delete saved.pendingSetup;await save();current='blocked';return;
          }
        }
        checker=makeExecutor({provider,wallets:[{address:pendingSetup.owner,signTransaction:()=>{throw error('只读回执核对禁止签名');}}],
          live:true,journalPath:cfg.journalPath,maxGasPriceWei:cfg.maxGasPriceWei,gasLimitCap:cfg.gasLimitCap,confirmations:3,receiptTimeoutMs:0});
        const row=await checker.reconcile(pendingSetup.actionId,pendingSetup.owner);
        if(!row||row.status==='pending')return;
        if(row.status==='confirmed'&&pendingSetup.operation==='deploy'){
          const receipt=await provider.getTransactionReceipt(pendingSetup.txHash),deployed=address(receipt.contractAddress);
          const {codeHash}=await artifactFor(pendingSetup.owner);
          check(keccak256(await provider.getCode(deployed))===codeHash,'部署代码核验失败');
          saved.contractAddress=deployed;saved.ownerAddress=pendingSetup.owner;
        }
        if(row.status==='confirmed'&&pendingSetup.operation==='arm'&&prepared)prepared.expiresAt=Number(prepared.proof.armParams.deadline)*1000;
        pendingSetup=null;delete saved.pendingSetup;await save();current=row.status==='failed'?'blocked':'prepared';
      }finally{checker?.close();}
    }).catch(()=>{});
    const base={supported:true,singleLane:true,chainId:56,status:current,observedAt:Date.now(),liveReady:false,
      contractAddress:prepared?.config.draft.executorAddress||saved.contractAddress||'',
      capabilities:{deploy:false,arm:false,cancel:false,withdraw:false},requirements:[],submissionResolved:!pendingSetup&&!pendingCompetition,
      ...(prepared?{prepared:{planId:prepared.id,expiresAt:prepared.expiresAt},floor:prepared.proof.floor,
        ...(!prepared.deploymentOnly?{expectedReserve:{display:`${formatEther(prepared.proof.armParams.expectedReserveBnb)} BNB / ${prepared.proof.armParams.expectedReserveToken} raw token`}}:{})}:{})};
    if(pendingSetup||pendingCompetition&&!activeRunner){base.status='settling';base.unknownSubmission=true;base.txHash=pendingSetup?.txHash;return base;}
    if(activeRunner){const row=activeRunner.status();base.running=['pending','waiting','idle'].includes(row.phase);base.status=row.phase==='filled'?'succeeded':row.phase==='pending'?'running':row.phase==='waiting'?'running':row.phase==='paused'?'blocked':row.phase;return {...base,attempts:row.attempts,gasReserved:row.gasReserved};}
    if(!prepared){
      if(!saved.contractAddress)base.capabilities.deploy=await hasLocalUnlock()&&(await publicWallets()).length>0;
      if(saved.contractAddress&&saved.ownerAddress)try{
        const imported=(await publicWallets()).some(row=>same(row.address,saved.ownerAddress));
        const local=await hasLocalUnlock();
        return await withProvider(async provider=>{
          const cfg={owner:saved.ownerAddress,caller:saved.ownerAddress,draft:{executorAddress:saved.contractAddress},exitOnly:true};
          const contract=await verifyContract(provider,cfg,await provider.getBlock('latest'));
          const balance=await provider.getBalance(contract.contract),reserved=Number(contract.arm[2])===1?BigInt(contract.arm[1].amountIn):0n;
          base.ownerAddress=saved.ownerAddress;base.status=Number(contract.arm[2])===1?'awaiting_authorization':'not_configured';
          base.capabilities.cancel=imported&&local&&Number(contract.arm[2])===1;
          base.capabilities.withdraw=imported&&local&&balance>reserved;
          return base;
        });
      }catch{}
      return base;
    }
    const planExpired=prepared.expiresAt<=Date.now();
    const unlockReady=await hasLocalUnlock();
    base.requirements.push({code:'local_unlock',label:'已启用本机钱包免密解锁（仅确认写操作时解锁）',met:unlockReady});
    base.requirements.push({code:'floor',label:'已核验首买储备及最低到手量',met:prepared.proof.floor.verified===true});
    base.capabilities.deploy=!base.contractAddress&&unlockReady;
    try {
      return await withProvider(async provider=>{
        const head=await provider.getBlock('latest'),contract=await verifyContract(provider,{...prepared.config,exitOnly:true},head);
        base.requirements.push({code:'executor',label:'执行器代码、owner和唯一执行钱包授权已核验',met:Boolean(contract)});
        if(!contract){base.status='not_deployed';return base;}
        base.contractAddress=contract.contract;
        if(prepared.deploymentOnly){base.status='not_configured';return base;}
        const [intent,params,state]=contract.arm;
        const armed=Number(state)===1;
        let paramsMatch=true;
        if(armed&&prepared.proof.floor.verified)try{assertParams(params,prepared.proof.armParams);}catch{paramsMatch=false;}
        base.requirements.push({code:'operator',label:'唯一执行钱包已获执行授权',met:contract.authorized});
        base.requirements.push({code:'armed',label:'链上已预置本次固定目标、金额、储备和最低到手量',met:armed&&paramsMatch});
        const closedIntent=same(saved.lastCompetition?.contract,contract.contract)&&same(saved.lastCompetition?.intentId,intent);
        base.requirements.push({code:'unused_intent',label:'此固定意图没有已结束的本地竞争会话，不能重启重置预算',met:!closedIntent});
        const balance=await provider.getBalance(contract.contract,head.number);
        base.capabilities.cancel=armed&&unlockReady;
        base.capabilities.withdraw=balance>(armed?BigInt(params.amountIn):0n)&&unlockReady;
        base.requirements.push({code:'funded',label:'执行器已备妥一次买入本金',met:balance>=prepared.config.units.amountIn});
        base.requirements.push({code:'window',label:'区块与时间窗口尚未结束',met:head.number<=Number(params.validUntilBlock)&&head.timestamp<Number(params.deadline)});
        base.capabilities.arm=prepared.proof.floor.verified===true&&!planExpired&&!armed&&![2,4].includes(Number(state))&&unlockReady;
        base.liveReady=!planExpired&&armed&&base.requirements.every(row=>row.met)&&prepared.revision===getConfigRevision();
        base.status=Number(state)===2?'succeeded':closedIntent?'blocked':planExpired?'expired':base.liveReady?'ready':'awaiting_authorization';
        return base;
      });
    }catch(e){base.status='blocked';base.requirements.push({code:'verification',label:'执行器或预置参数核验失败，需重新准备',met:false});return base;}
  }
  async function preview(operation,body) {
    check(!pendingSetup&&!pendingCompetition,'上一项交易结果仍不明，先核对原交易');
    const exit=operation==='cancel'||operation==='withdraw';
    let p;
    if(exit){
      check(body.draft&&typeof body.draft==='object'&&Object.keys(body.draft).every(k=>['executorAddress','ownerAddress'].includes(k)),'退出只需要执行器和owner地址');
      const owner=address(body.draft.ownerAddress),contractAddress=address(body.draft.executorAddress||saved.contractAddress);
      check((await publicWallets()).some(w=>same(w.address,owner)),'请选择已导入的owner钱包');
      const cfg=getConfig(),config={owner,caller:owner,cfg,exitOnly:true,draft:{ownerAddress:owner,callerAddresses:[owner],executorAddress:contractAddress},
        units:{amountIn:0n,gasPrice:cfg.maxGasPriceWei},worst:0n};
      const contract=await withProvider(async provider=>verifyContract(provider,config,await provider.getBlock('latest')));
      check(contract,'执行器核验失败');
      const params=Object.fromEntries(ARM_FIELDS.map(name=>[name,contract.arm[1][name]]));
      config.target=params.mint!==ZeroAddress&&params.token!==ZeroAddress?{factory:FACTORY,mint:params.mint,token:params.token}:null;
      prepared={id:randomBytes(16).toString('hex'),config,proof:{armParams:params,floor:{verified:false,minOutRaw:'0',display:'退出操作不生成买入底线'}},
        expiresAt:Date.now()+120000,revision:getConfigRevision(),walletKey:await walletsKey()};p=prepared;
    }else if(operation==='deploy'){
      // Deployment is reusable infrastructure, not an opening trade. It must
      // be possible long before the final Mint and must never fabricate a
      // verified floor, fund the executor or make arm/start available.
      const config=await normalize(body.draft);
      prepared={id:randomBytes(16).toString('hex'),config,deploymentOnly:true,
        proof:{floor:{verified:false,minOutRaw:'0',display:'仅部署执行器；目标价格底线尚未准备'}},
        expiresAt:Date.now()+120000,revision:getConfigRevision(),walletKey:await walletsKey()};
      p=prepared;
    }else if(operation==='start'){p=requirePrepared();check(body.planId===p.id,'首买计划已改变');}
    else {
      const normalized=await normalize(body.draft);
      if(!prepared||prepared.deploymentOnly||prepared.config.key!==normalized.key||prepared.expiresAt<=Date.now())await prepare(body.draft);
      p=requirePrepared();
    }
    const summary=[],token=randomBytes(32).toString('hex');
    let tx,setupWei=0n;
    if(operation==='start'){
      const ready=await status();check(ready.liveReady&&ready.status==='ready','首买条件尚未全部满足');
      summary.push(`唯一执行钱包 ${p.config.owner}`,`买入 ${formatEther(p.config.units.amountIn)} BNB；最多 ${p.config.draft.maxAttempts} 次`,
        `竞争Gas最坏 ${formatEther(p.config.worst)} BNB；成功仅一次，别人先买则不追价`,`截止区块 ${p.proof.armParams.validUntilBlock}，时间 ${p.proof.armParams.deadline}`);
    } else await withProvider(async provider=>{
      const head=await provider.getBlock('latest'),contract=await verifyContract(provider,p.config,head);
      const {artifact,abi}=await artifactFor(p.config.owner);
      if(operation==='deploy'){
        check(!contract,'已经存在执行器，不重复部署');
        tx={to:null,value:0n,data:artifact.bytecode+abi.encodeDeploy([p.config.owner,[p.config.caller]]).slice(2)};
        summary.push(`在BSC部署owner=${p.config.owner}的固定执行器`, '部署仅消耗Gas，不会自动注资或开始买入');
      }else if(operation==='arm'){
        check(contract,'请先部署并核验执行器');check(Number(contract.arm[2])!==1,'已有预置，不能重复arm');
        const balance=await provider.getBalance(contract.contract,head.number),topUp=balance<p.config.units.amountIn?p.config.units.amountIn-balance:0n;
        tx={to:contract.contract,value:topUp,data:abi.encodeFunctionData('arm',[p.proof.armParams])};
        summary.push(`预置固定目标 ${p.config.target.token}`,`本次向执行器补入 ${formatEther(topUp)} BNB；本金留在执行器直到买成或主动撤回`,
          `最低到账 ${p.proof.floor.minOutRaw} raw；价格底线不能在重试时下调`);
      }else if(operation==='cancel'){
        check(contract&&Number(contract.arm[2])===1,'没有可取消的链上预置');
        tx={to:contract.contract,value:0n,data:abi.encodeFunctionData('cancel',[contract.arm[0]])};
        summary.push(`取消执行器 ${contract.contract} 的当前固定意图`,'不自动撤回本金；取消确认后可单独预览撤回');
      }else if(operation==='withdraw'){
        check(contract,'执行器不存在');
        const balance=await provider.getBalance(contract.contract,head.number),reserved=Number(contract.arm[2])===1?BigInt(contract.arm[1].amountIn):0n;
        check(balance>reserved,'没有可撤回的非预留BNB；需先取消预置后才能撤回本金');
        const available=balance-reserved;
        tx={to:contract.contract,value:0n,data:abi.encodeFunctionData('withdrawNative',[available])};
        summary.push(`撤回可用余额 ${formatEther(available)} BNB 到固定owner ${p.config.owner}`,
          `保持链上预置预留金额 ${formatEther(reserved)} BNB；网页不能指定任意金额或接收人`);
      }else throw error('未知首买操作');
      const estimate=await provider.estimateGas({...tx,from:p.config.owner,gasPrice:p.config.units.gasPrice});
      const gas=(BigInt(estimate)*120n+99n)/100n;
      check(gas<=p.config.cfg.gasLimitCap,'部署/预置Gas超过全局每笔上限');
      setupWei=gas*p.config.units.gasPrice;
      check(p.config.cfg.maxTotalWei!==null&&(exit?setupWei:p.config.units.amountIn+p.config.worst+setupWei+BigInt(saved.setupReservedWei??'0'))<=p.config.cfg.maxTotalWei,'设置操作与竞争支出超过全局预算');
      summary.push(`本次Gas最坏 ${formatEther(setupWei)} BNB（竞争预算之外，仍受全局预算约束）`);
    });
    const row={operation,planId:p.id,expiresAt:Date.now()+45000,revision:p.revision,walletKey:await walletsKey(),tx,setupWei};
    previews.clear();previews.set(token,row);
    return {previewId:token,operation,expiresAt:row.expiresAt,summary};
  }
  async function confirm(operation,body) {
    check(!pendingSetup&&!pendingCompetition,'上一项交易结果仍不明，不能确认新的设置或启动');
    const row=previews.get(body.previewId);previews.delete(body.previewId);
    check(body.confirmed===true&&row&&row.operation===operation&&row.expiresAt>Date.now(),'确认预览已过期或已使用');
    const p=requirePrepared();check(row.planId===p.id&&row.revision===getConfigRevision()&&row.walletKey===await walletsKey(),'钱包或配置已改变，请重新预览');
    check(await hasLocalUnlock(),'请先在钱包管理启用本机免密码解锁，再确认首买操作');
    return runExclusive({operation,background:operation==='start',target:p.config.target,work:async({signal,log:jobLog=log,ready=()=>{}})=>{
      const provider=await getProvider(p.config.cfg);let executor,journal;
      try{
        const unlocked=await unlock(provider),owner=unlocked.find(w=>same(w.address,p.config.owner));check(owner,'解锁后的钱包清单已改变');
        check(await walletsKey()===row.walletKey,'钱包清单已改变');signal.throwIfAborted();
        if(operation!=='start'){
          executor=makeExecutor({provider,wallets:[owner],live:true,journalPath:p.config.cfg.journalPath,
            maxGasPriceWei:p.config.units.gasPrice,gasLimitCap:p.config.cfg.gasLimitCap,confirmations:3,receiptTimeoutMs:12000,
            ...(operation==='deploy'?{allowContractCreation:true}:{})});
          const actionId=`firstbuy:${operation}:${digest(row.tx)}`;
          saved.setupReservedWei=(BigInt(saved.setupReservedWei??'0')+row.setupWei).toString();await save();
          pendingSetup={operation,actionId,owner:owner.address,pid:process.pid};saved.pendingSetup=pendingSetup;await save();
          let result;
          try{result=await executor({actionId,wallet:owner.address,tx:row.tx,signal,beforeSign:async()=>{
            signal.throwIfAborted();check(row.revision===getConfigRevision()&&row.walletKey===await walletsKey(),'确认状态已改变');
            check(Date.now()<row.expiresAt&&Date.now()<p.expiresAt,'预览已过期');
          }});}catch(e){
            const action=setupAction(pendingSetup);
            if(action){pendingSetup.txHash=action.tx_hash;saved.pendingSetup=pendingSetup;}
            else{pendingSetup=null;delete saved.pendingSetup;}
            await save();throw e;
          }
          if(result.actionId!==actionId||['failed','skipped'].includes(result.status)){
            const action=setupAction(pendingSetup);
            if(!action||['confirmed','failed'].includes(action.status)){pendingSetup=null;delete saved.pendingSetup;await save();}
            check(result.actionId===actionId,'该钱包有其他交易未决，本次设置操作未提交');
            throw error('设置交易已失败，未预置或启动买入');
          }
          if(result.status!=='confirmed'){
            pendingSetup={operation,actionId,txHash:result.txHash,owner:owner.address,pid:process.pid};saved.pendingSetup=pendingSetup;await save();
            current='settling';return {status:'settling',unknownSubmission:true,txHash:result.txHash};
          }
          if(operation==='deploy'){
            const receipt=await provider.getTransactionReceipt(result.txHash),contractAddress=address(receipt.contractAddress);
            const {codeHash}=await artifactFor(p.config.owner);check(keccak256(await provider.getCode(contractAddress))===codeHash,'部署代码核验失败');
            saved={...saved,version:1,ownerAddress:p.config.owner,contractAddress};await save();
          }else if(operation==='arm'){
            const head=await provider.getBlock('latest'),contract=await verifyContract(provider,p.config,head);assertParams(contract.arm[1],p.proof.armParams);
            check(Number(contract.arm[2])===1,'链上预置未生效');p.expiresAt=Number(p.proof.armParams.deadline)*1000;
          }
          pendingSetup=null;delete saved.pendingSetup;await save();
          current='prepared';return {status:current,txHash:result.txHash,submissionResolved:true,...await status()};
        }
        const latest=await provider.getBlock('latest'),contract=await verifyContract(provider,p.config,latest);check(contract,'执行器不存在');
        assertParams(contract.arm[1],p.proof.armParams);check(Number(contract.arm[2])===1,'执行器未处于可执行状态');
        executor=makeExecutor({provider,wallets:[owner],live:true,journalPath:p.config.cfg.journalPath,
          maxGasPriceWei:p.config.units.gasPrice,gasLimitCap:p.config.cfg.gasLimitCap,confirmations:3,receiptTimeoutMs:0});
        executor.close();executor=null;
        journal=journalFactory({journalPath:p.config.cfg.journalPath});
        const plan=checkedFirstBuyPlan({contract:contract.contract,mint:p.config.target.mint,token:p.config.target.token,recipient:p.config.owner,
          intentId:contract.arm[0],expectedCodeHash:contract.codeHash,amountIn:p.config.units.amountIn,minOut:BigInt(p.proof.floor.minOutRaw),
          gasLimit:BigInt(p.config.draft.gasLimitCap),gasPrice:p.config.units.gasPrice,maxGasWei:p.config.units.gasBudget,
          maxAttempts:p.config.draft.maxAttempts,startBlock:latest.number,endBlock:Number(p.proof.armParams.validUntilBlock),deadline:Number(p.proof.armParams.deadline)});
        // A block hash pins all reads to one canonical state. Reuse only that
        // single head (including the before-send recheck), never a height-only
        // or time-based cache that could conceal a shallow reorg.
        let cachedHeadKey,cachedReadState;
        const readState=({head})=>{
          const key=head.number+':'+head.hash;
          if(key===cachedHeadKey)return cachedReadState;
          cachedHeadKey=key;
          cachedReadState=(async()=>{const current=await verifyContract(provider,p.config,head);assertParams(current.arm[1],p.proof.armParams);
            let state=['none','armed','filled','cancelled','exhausted'][Number(current.arm[2])];
            if(state==='armed'&&(head.number>plan.endBlock||head.timestamp>=plan.deadline))state='expired';
            if(state==='armed'){
              const [launched]=FUNDING_STATE_ABI.decodeFunctionResult('launched',await provider.call({to:plan.mint,blockTag:head.number,data:FUNDING_STATE_ABI.encodeFunctionData('launched')}));
              if(launched){
                const pool=address(p.proof.pool);
                const [reported,raw]=await Promise.all([
                  provider.call({to:plan.mint,blockTag:head.number,data:FUNDING_STATE_ABI.encodeFunctionData('pool')}),
                  provider.call({to:pool,blockTag:head.number,data:RESERVES_ABI.encodeFunctionData('getReserves')}),
                ]);
                const [actualPool]=FUNDING_STATE_ABI.decodeFunctionResult('pool',reported),reserves=RESERVES_ABI.decodeFunctionResult('getReserves',raw);
                const quoteFirst=WBNB.toLowerCase()<plan.token.toLowerCase();
                const reserveBnb=reserves[quoteFirst?0:1],reserveToken=reserves[quoteFirst?1:0];
                if(!same(actualPool,pool)||reserveBnb!==BigInt(p.proof.armParams.expectedReserveBnb)||reserveToken!==BigInt(p.proof.armParams.expectedReserveToken))state='missed';
              }
            }
            return {contract:current.contract,intentId:current.arm[0],codeHash:current.codeHash,state,attempts:Number(current.arm[3])};
          })().catch(e=>{if(cachedHeadKey===key){cachedHeadKey=undefined;cachedReadState=undefined;}throw e;});
          return cachedReadState;
        };
        activeRunner=runnerFactory({plan,journal,provider,signer:owner,signal,log:jobLog,readState,
          transport:(raw,{signal:submitSignal})=>provider.submitRawTransaction(raw,{signal:submitSignal,singleSubmission:true,broadcastConcurrency:1}),
        });
        pendingCompetition={plan,caller:owner.address,pid:process.pid};saved.pendingCompetition=pendingCompetition;await save();
        current='running';ready();const result=await activeRunner.run();
        if(!result.unresolved){pendingCompetition=null;delete saved.pendingCompetition;}
        saved.lastCompetition={contract:plan.contract,intentId:plan.intentId,state:result.phase};await save();
        current=result.phase==='filled'?'succeeded':result.phase==='paused'?'blocked':result.phase;return result;
      }finally{
        if(activeRunner){
          const result=await activeRunner.stop().catch(()=>({unresolved:true}));
          if(result.unresolved){pendingCompetition={plan:activeRunner.plan,caller:p.config.owner,pid:process.pid};saved.pendingCompetition=pendingCompetition;await save();}
          activeRunner=null;
        }
        executor?.close();journal?.close();releaseProvider(provider);
      }
    }});
  }
  return Object.freeze({status,prepare,preview,confirm,stop:async()=>{if(activeRunner)return activeRunner.stop();return {status:'stopped'};}});
}
