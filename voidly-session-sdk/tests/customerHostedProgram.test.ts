import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import {createCustomerHostedProgramJobs,parseOwnerAppProgram,type OwnerAppProgram,type CustomerHostedProgramJobs} from '../src/customerHosted';
import {programEntryIds} from '../src/customer-hosted/owner-app-program-client';
import {hostedMaterial,testPayer,completedHostedHistory} from './customerHosted.fixture';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const keys=generateKeyPairSync('rsa',{modulusLength:2048}),dirs:string[]=[],handles:CustomerHostedProgramJobs[]=[];
afterEach(()=>{for(const h of handles.splice(0))h.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.restoreAllMocks();});
async function fixture(twoInputs=false){
 const first=await hostedMaterial(),r=first.snapshot.review,V='voidpay.owner-app-program.v1' as const;
 const programId=hash(JSON.stringify([V,'owner-a','connection-a','program-request-a']));
 const scope={version:V,programId,connectionId:'connection-a',connectionScopeDigest:'d'.repeat(64),ownerId:'owner-a',appId:'app-a',service:r.original.service,
  payerAccount:r.original.lineage.payerAccount,inputs:[{inputDigest:r.original.inputDigest,inputByteLength:r.original.inputByteLength},...(twoInputs?[{inputDigest:hash('second exact input'),inputByteLength:18}]:[])],maxPerJobAtoms:'50000',maxTotalAtoms:twoInputs?'100000':'50000',
  maxActiveJobs:1,notBeforeMs:r.original.notBeforeMs,expiresAtMs:r.reviewedAtMs+3600000,
  operations:['status','entry','readiness','begin','read','claimForWallet','submit','recover'],dataDisclosure:'approved-inputs-and-original-results',paymentMode:'optional-finite-program',walletAuthorityGranted:false};
 const view={version:V,programId,requestId:'program-request-a',connectionId:'connection-a',appName:'Synthetic customer app',appOrigin:'https://customer.example',scope,
  programDigest:hash(JSON.stringify(scope)),state:'ready',preparedInputDigests:scope.inputs.map(i=>i.inputDigest),approvedAtMs:r.reviewedAtMs-1000,revokedAtMs:null,walletAuthorityGranted:false};
 const program=parseOwnerAppProgram(view),ids=programEntryIds(program,r.original.inputDigest);
 const original=await hostedMaterial('program-review-a',ids.reviewRequestId,'program-job-a');
 const m={...original,snapshot:{...original.snapshot,approval:{requestId:ids.approveRequestId,approvedAtMs:r.reviewedAtMs+1}}};
 const entry={version:V,programId,programDigest:program.programDigest,inputDigest:r.original.inputDigest,inputByteLength:r.original.inputByteLength,
  entryId:ids.entryId,review:m.snapshot,beginRequestId:ids.beginRequestId,prepared:true};
 const entries=new Map([[entry.inputDigest,{entry,m,ids}]]);
 if(twoInputs){const nextIds=programEntryIds(program,scope.inputs[1].inputDigest),original=await hostedMaterial('program-review-b',nextIds.reviewRequestId,'program-job-b',1,'second exact input');
  const next={...original,snapshot:{...original.snapshot,approval:{requestId:nextIds.approveRequestId,approvedAtMs:r.reviewedAtMs+1}}};
  entries.set(scope.inputs[1].inputDigest,{entry:{...entry,inputDigest:scope.inputs[1].inputDigest,inputByteLength:18,entryId:nextIds.entryId,review:next.snapshot,beginRequestId:nextIds.beginRequestId},m:next,ids:nextIds});
 }
 const credential={builderKey:'vpb_'+ 'a'.repeat(43),keyId:'customer-key-a',privateKey:keys.privateKey};
 const calls:string[]=[],requests:Record<string,unknown>[]=[];
 const state={current:true,unknown:'',changed:'',completed:false,before:(_op:string)=>{},status:'ready',error:'',errorStatus:403};
 const signal=new AbortController();
 const transport:typeof fetch=async(url,init)=>{
  const u=new URL(String(url)),op=u.pathname.split('/').at(-1)!;calls.push(op);state.before(op);
  expect(u.origin).toBe('https://voidly.ai');expect(u.pathname).toBe('/v0/market/connected-programs/'+op);expect(u.search+u.hash).toBe('');
  expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');expect(init?.referrerPolicy).toBe('no-referrer');
  const headers=new Headers(init?.headers);expect(headers.get('origin')).toBeNull();expect(headers.get('cookie')).toBeNull();
  expect(headers.get('x-voidpay-builder-key')).toBe(credential.builderKey);expect(headers.get('x-voidpay-buyer-consent')).toBeNull();
  const token=headers.get('authorization')!.slice(7),[h,p,s]=token.split('.');
  expect(verify('RSA-SHA256',Buffer.from(h+'.'+p),keys.publicKey,Buffer.from(s,'base64url'))).toBe(true);
  expect(JSON.parse(Buffer.from(h,'base64url').toString())).toEqual({alg:'RS256',typ:'voidpay-owner-app-program-delegation+jwt',kid:credential.keyId});
  const claims=JSON.parse(Buffer.from(p,'base64url').toString());expect(Object.keys(claims)).toEqual(['iss','aud','sub','app_id','connection_id','scope_digest','program_id','program_digest','operation','iat','nbf','exp','jti']);
  expect(claims).toMatchObject({iss:program.appOrigin,aud:'https://voidly.ai/v0/market/connected-programs',sub:'owner-a',app_id:'app-a',connection_id:'connection-a',
   scope_digest:scope.connectionScopeDigest,program_id:programId,program_digest:program.programDigest,operation:op,nbf:claims.iat});
  expect(claims.exp-claims.iat).toBeLessThanOrEqual(60);expect(claims.exp*1000).toBeLessThanOrEqual(scope.expiresAtMs);
  const body=JSON.parse(String(init?.body));requests.push(body);expect(body.programId).toBe(programId);
  const selected=entries.get(body.inputDigest)??entries.get(entry.inputDigest)!;const {entry:currentEntry,m:current,ids:currentIds}=selected;
  if(!['status','readiness'].includes(op))expect(body.inputDigest).toBe(currentEntry.inputDigest);
  if(['begin','read','claimForWallet','submit','recover'].includes(op))expect(body).toMatchObject({reviewId:current.snapshot.review.reviewId,reviewDigest:current.snapshot.reviewDigest});
  if(op==='begin')expect(body).toEqual({programId,inputDigest:currentEntry.inputDigest,reviewId:current.snapshot.review.reviewId,reviewDigest:current.snapshot.reviewDigest,requestId:currentIds.beginRequestId,selectedText:current.selection.selectedText});
  if(state.error)return Response.json({version:V,error:{code:state.error,retryAuthorized:false}},{status:state.errorStatus});
  let data:unknown;
  if(op==='status')data={...view,state:state.status};
  else if(op==='entry')data=state.changed==='entry'?{...currentEntry,beginRequestId:'replacement-begin'}:currentEntry;
  else if(op==='readiness')data={kind:'checkout-ready',checkoutReady:true,permissionId:r.permissionId,configurationDigest:r.configurationDigest,
   service:state.changed==='service'?{...r.original.service,version:'other'}:r.original.service,chain:r.budget.scope.chain,asset:r.budget.scope.asset,
   payerAccount:r.original.lineage.payerAccount,maxPerJobAtoms:r.budget.scope.maxPerJob,maxTotalAtoms:r.budget.maxTotal,maxActiveJobs:r.budget.maxActiveJobs,
   notBeforeMs:r.budget.scope.notBeforeMs,expiresAtMs:r.budget.scope.expiresAtMs,walletControlVerified:false,unattendedPayments:false,authorization:'wallet-per-job'};
  else if(op==='begin'||op==='read')data=current.view;
  else if(op==='claimForWallet')data=state.changed==='claim'?{...current.signing,original:{...current.signing.original,approval:{...current.signing.original.approval,
   terms:{...current.signing.original.approval.terms,amountAtoms:'50001'}}}}:current.signing;
  else if(op==='submit')data={kind:'provider-accepted',jobId:current.view.jobId,exposureId:'program-exposure',grantHash:current.signing.claim.kind==='original-wallet-request'?current.signing.claim.grantHash:'',payment:'unconfirmed'};
  else if(op==='recover')data=state.completed?await completedHostedHistory(current):{kind:'original-monetary-recovery',jobId:current.view.jobId,settlement:{kind:'not-checked'},delivery:null,result:{kind:'unknown',reason:'ORIGINAL_UNAVAILABLE'}};
  else throw Error('Unexpected operation');
  if(state.unknown===op)throw Error('Synthetic lost response');
  return Response.json({version:V,data});
 };
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'program-jobs-')));dirs.push(directory);
 const provider={async request(q:Parameters<Parameters<typeof createCustomerHostedProgramJobs>[0]['provider']['request']>[0]){
  if(q.method==='eth_accounts')return[testPayer.address];if(q.method==='eth_chainId')return'0x2105';expect(q.method).toBe('eth_signTypedData_v4');calls.push('sign');
  if(state.unknown==='sign')throw Error('Synthetic interrupted signer');const t=JSON.parse(q.params![1] as string);
  return testPayer.signTypedData(t.domain,{ReceiveWithAuthorization:t.types.ReceiveWithAuthorization},t.message);
 }};
 function open(p:OwnerAppProgram=program){const h=createCustomerHostedProgramJobs({directory,program:p,credential,lifetime:{isCurrent:()=>state.current,signal:signal.signal},provider,fetch:transport});handles.push(h);return h;}
 return {open,program,entry,ids,calls,requests,state,signal,credential,provider,transport,directory,text:m.selection.selectedText};
}
test('approved app program uses genuine operation assertions, fixed original IDs and the unchanged EIP3009 signer',async()=>{
 const f=await fixture(),h=f.open();f.state.before=op=>{if(['begin','claimForWallet','submit'].includes(op))expect(h.status().committedAtoms).toBe('50000');};
 expect(await h.run({selectedText:f.text})).toMatchObject({kind:'submitted',operationId:f.ids.entryId,payment:'unconfirmed'});
 expect(f.calls).toEqual(['status','entry','readiness','begin','entry','read','claimForWallet','sign','submit']);
 expect(h.status()).toMatchObject({committedAtoms:'50000',attempts:1});
 const before=f.calls.length;expect(await f.open().run({selectedText:f.text})).toMatchObject({kind:'original-recovery'});
 expect(f.calls.slice(before)).toEqual(['read','recover']);
 expect(f.requests.filter(r=>'selectedText'in r)).toHaveLength(1);
});
test.each(['begin','claimForWallet','sign','submit'])('unknown %s never allocates or signs another original after reopening',async phase=>{
 const f=await fixture(),h=f.open();f.state.unknown=phase;expect(await h.run({selectedText:f.text})).toMatchObject({kind:'recover-original'});
 expect(h.status().committedAtoms).toBe('50000');const before=f.calls.length;f.state.unknown='';
 expect(await f.open().run({selectedText:f.text})).toMatchObject({kind:'original-recovery'});
 expect(f.calls.slice(before).every(op=>['entry','read','recover'].includes(op))).toBe(true);
 expect(f.calls.filter(op=>op==='begin')).toHaveLength(1);expect(f.calls.filter(op=>op==='sign').length).toBeLessThanOrEqual(1);
});
test.each(['entry','service'])('changed %s is refused before an original or signature exists',async kind=>{
 const f=await fixture();f.state.changed=kind;expect(await f.open().run({selectedText:f.text})).toMatchObject({kind:'refused'});
 expect(f.calls).not.toContain('begin');expect(f.calls).not.toContain('sign');
});
test('changed claim cannot sign or submit; original reservation stays recoverable',async()=>{
 const f=await fixture();f.state.changed='claim';expect(await f.open().run({selectedText:f.text})).toMatchObject({kind:'recover-original'});
 expect(f.calls).not.toContain('sign');expect(f.calls).not.toContain('submit');
});
test('unapproved input and caller-supplied operation IDs never reach transport',async()=>{
 const f=await fixture(),h=f.open();expect(await h.run({selectedText:f.text+' extra'})).toMatchObject({kind:'refused',reason:'INPUT_NOT_APPROVED'});
 expect(await h.run({selectedText:f.text,operationId:'another'} as never)).toMatchObject({kind:'refused'});expect(f.calls).toEqual([]);
});
test('local revocation preserves recovery but prohibits another begin; expired/revoked app authority never falls back to an account',async()=>{
 const f=await fixture(),h=f.open();f.state.unknown='begin';await h.run({selectedText:f.text});h.revoke();f.state.unknown='';
 expect(await h.recover(f.entry.inputDigest)).toMatchObject({kind:'original-recovery'});
 const before=f.calls.length;f.state.error='FORBIDDEN';await expect(h.recover(f.entry.inputDigest)).rejects.toThrow();
 expect(f.calls.slice(before)).toEqual(['entry']);expect(f.calls.filter(op=>op==='begin')).toHaveLength(1);
 f.state.current=false;const count=f.calls.length;await expect(h.recover(f.entry.inputDigest)).rejects.toThrow();expect(f.calls.length).toBe(count);
});
test('concurrent handles use one fixed operation reservation and one begin/sign',async()=>{
 const f=await fixture(),a=f.open(),b=f.open();const outcomes=await Promise.all([a.run({selectedText:f.text}),b.run({selectedText:f.text})]);
 expect(outcomes.filter(x=>x.kind==='submitted')).toHaveLength(1);
 expect(f.calls.filter(x=>x==='begin')).toHaveLength(1);expect(f.calls.filter(x=>x==='sign')).toHaveLength(1);
});
test('program metadata parsing checks ordered digest, 1–32 distinct inputs and scope caps without assuming wallet authority',async()=>{
 const f=await fixture();expect(parseOwnerAppProgram({...f.program,scope:Object.fromEntries(Object.entries(f.program.scope).reverse())})).toEqual(f.program);
 for(const changes of [{walletAuthorityGranted:true},{maxActiveJobs:2},{maxTotalAtoms:'1'},{inputs:[]},{inputs:Array(33).fill(f.program.scope.inputs[0])}]){
  const scope={...f.program.scope,...changes};expect(()=>parseOwnerAppProgram({...f.program,scope,programDigest:hash(JSON.stringify(scope))})).toThrow();
 }
 expect(()=>parseOwnerAppProgram({...f.program,programDigest:'a'.repeat(64)})).toThrow();
 let invoked=false;const hostile={...f.program};Object.defineProperty(hostile,'scope',{enumerable:true,get(){invoked=true;return f.program.scope;}});
 expect(()=>parseOwnerAppProgram(hostile)).toThrow();expect(invoked).toBe(false);
});
test('a changed valid program cannot reset the durable budget for the same program ID',async()=>{
 const f=await fixture();f.open();const scope={...f.program.scope,maxTotalAtoms:'100000'};
 expect(()=>f.open(parseOwnerAppProgram({...f.program,scope,programDigest:hash(JSON.stringify(scope))}))).toThrow();
});

test('two finite exact inputs share a durable cap; only completed original recovery opens the next active slot',async()=>{
 const f=await fixture(true),h=f.open();expect(await h.run({selectedText:f.text})).toMatchObject({kind:'submitted'});
 expect(await h.run({selectedText:'second exact input'})).toMatchObject({kind:'refused',reason:'ACTIVE_JOB_LIMIT'});
 f.state.completed=true;expect(await h.recover(f.entry.inputDigest)).toMatchObject({kind:'original-recovery',result:{settlement:{kind:'accounted'},result:{kind:'opened'}}});
 expect(await h.run({selectedText:'second exact input'})).toMatchObject({kind:'submitted'});
 expect(h.status()).toMatchObject({committedAtoms:'100000',attempts:2});
 expect(new Set(f.requests.filter(r=>'selectedText'in r).map(r=>r.requestId)).size).toBe(2);
 expect(f.calls.filter(op=>op==='begin')).toHaveLength(2);
 const before=f.calls.length;expect(await f.open().run({selectedText:f.text})).toMatchObject({kind:'original-recovery'});
 expect(f.calls.slice(before)).toEqual(['read','recover']);
});
test('expired authority and invalid app credentials refuse before network, and abort cannot resume the identity',async()=>{
 const f=await fixture(),h=f.open();f.signal.abort();expect(await h.run({selectedText:f.text})).toMatchObject({kind:'refused',reason:'AUTH_REQUIRED'});expect(f.calls).toEqual([]);
 const g=await fixture();vi.spyOn(Date,'now').mockReturnValue(g.program.scope.expiresAtMs+1);
 expect(await g.open().run({selectedText:g.text})).toMatchObject({kind:'refused',reason:'PROGRAM_EXPIRED'});expect(g.calls).toEqual([]);
 expect(()=>createCustomerHostedProgramJobs({directory:g.directory,program:g.program,credential:{...g.credential,builderKey:'full-account-token'},
  lifetime:{isCurrent:()=>true,signal:new AbortController().signal},provider:g.provider,fetch:g.transport})).toThrow('INVALID_PROGRAM_CREDENTIAL');
});
test('an unapproved program can be revoked and displayed without becoming execution authority',async()=>{
 const f=await fixture();const revoked=parseOwnerAppProgram({...f.program,approvedAtMs:null,preparedInputDigests:[],state:'revoked',revokedAtMs:Date.now()});
 expect(revoked.approvedAtMs).toBeNull();expect(()=>f.open(revoked)).toThrow('PROGRAM_APPROVAL_REQUIRED');expect(f.calls).toEqual([]);
});
