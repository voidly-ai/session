// Ported synthetic customer-owned SDK tests. All HTTP and wallet requests stay in-process.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createCustomerHostedJobs, createHostedBuyerAdapter, createAuthenticatedBuyerConsentAdapter, type AutomaticHostedJobPolicy } from '../src/customerHosted';
import { hostedMaterial,testPayer,completedHostedHistory } from './customerHosted.fixture';
import type { BuyerConsentSnapshot } from '../src/customer-hosted/invitedBuyerConsent';
const dirs:string[]=[],handles:{close():void}[]=[];
afterEach(()=>{for(const h of handles.splice(0))h.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});vi.restoreAllMocks();});
test('public Node setup and consent adapters use their fixed absolute destination without a custom transport',async()=>{
  const {snapshot:{review:r}}=await hostedMaterial();
  const session={accessToken:'synthetic-default-account',isCurrent:()=>true,signal:new AbortController().signal};
  const requests:{url:string;body:unknown}[]=[];
  const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const address=String(url),headers=new Headers(init?.headers),body=JSON.parse(String(init?.body));requests.push({url:address,body});
    expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
    expect(headers.get('origin')).toBe('https://voidly.ai');expect(headers.get('authorization')).toBe('Bearer '+session.accessToken);
    if(address==='https://voidly.ai/v0/market/buyer-onboarding/readiness')return Response.json({version:'voidpay.hosted-buyer-readiness.v1',data:{
      kind:'checkout-ready',checkoutReady:true,permissionId:r.permissionId,configurationDigest:r.configurationDigest,service:r.original.service,
      chain:r.budget.scope.chain,asset:r.budget.scope.asset,payerAccount:r.original.lineage.payerAccount,maxPerJobAtoms:r.budget.scope.maxPerJob,
      maxTotalAtoms:r.budget.maxTotal,maxActiveJobs:r.budget.maxActiveJobs,notBeforeMs:r.budget.scope.notBeforeMs,expiresAtMs:r.budget.scope.expiresAtMs,
      walletControlVerified:false,unattendedPayments:false,authorization:'wallet-per-job'}});
    expect(address).toBe('https://voidly.ai/v0/market/buyer-consent/readScope');
    return Response.json({version:'voidpay.invited-buyer-consent.v0',data:null});
  });
  await expect(createHostedBuyerAdapter(session).readiness()).resolves.toMatchObject({kind:'checkout-ready',permissionId:r.permissionId});
  await expect(createAuthenticatedBuyerConsentAdapter(session).readScope({requestId:'default-original'})).resolves.toBeNull();
  expect(transport).toHaveBeenCalledTimes(2);expect(requests).toEqual([
    {url:'https://voidly.ai/v0/market/buyer-onboarding/readiness',body:{}},
    {url:'https://voidly.ai/v0/market/buyer-consent/readScope',body:{requestId:'default-original'}},
  ]);
});
async function fixture(total='100000',maxActive=2){
  const anchor=await hostedMaterial('owner-template','owner-review','owner-not-begun',maxActive),r=anchor.snapshot.review;
  const policy:AutomaticHostedJobPolicy={version:'voidpay.customer-hosted-jobs.v1',id:'owner-policy',ownerReviewed:r,
    inputs:[{kind:'exact-bytes-v1',digest:r.original.inputDigest,byteLength:r.original.inputByteLength}],notBeforeMs:r.original.notBeforeMs,
    expiresAtMs:r.original.expiresAtMs,maxPerJobAtoms:'50000',maxTotalAtoms:total,maxActiveJobs:maxActive};
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'hosted-jobs-test-')));dirs.push(dir);
  const records=new Map<string,Awaited<ReturnType<typeof hostedMaterial>>>(),approvals=new Map<string,BuyerConsentSnapshot>(),calls:string[]=[],budgets=new Set<string>();
  const state={unknown:'',changedService:false,changedInput:false,completed:false,released:false,wrongRelease:false,before:(op:string)=>{},current:true};
  const session={accessToken:'synthetic-own-account',isCurrent:()=>state.current,signal:new AbortController().signal};
  const fetcher:typeof fetch=async(url,init)=>{
    expect(new URL(String(url)).origin).toBe('https://voidly.ai');expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
    const op=String(url).split('/').at(-1)!,body=JSON.parse(String(init?.body));calls.push(op);state.before(op);
    let data:unknown,version='voidpay.invited-checkout.v0';
    const m=[...records.values()].find(x=>x.snapshot.review.reviewId===body.reviewId);
    if(op==='readiness'){version='voidpay.hosted-buyer-readiness.v1';data={kind:'checkout-ready',checkoutReady:true,permissionId:r.permissionId,
      configurationDigest:r.configurationDigest,service:state.changedService?{...r.original.service,version:'unapproved'}:r.original.service,
      chain:r.budget.scope.chain,asset:r.budget.scope.asset,payerAccount:r.original.lineage.payerAccount,maxPerJobAtoms:r.budget.scope.maxPerJob,
      maxTotalAtoms:r.budget.maxTotal,maxActiveJobs:r.budget.maxActiveJobs,notBeforeMs:r.budget.scope.notBeforeMs,expiresAtMs:r.budget.scope.expiresAtMs,
      walletControlVerified:false,unattendedPayments:false,authorization:'wallet-per-job'};}
    else if(op==='reviewScope'){version='voidpay.invited-buyer-consent.v0';
      const next=await hostedMaterial('review-'+records.size,body.requestId,'job-'+records.size,maxActive);records.set(body.requestId,next);
      data={...next.snapshot,approval:null};if(state.changedInput)data={...data as object,review:{...next.snapshot.review,original:{...next.snapshot.review.original,inputDigest:'f'.repeat(64)}}};}
    else if(op==='readScope'){version='voidpay.invited-buyer-consent.v0';const found=records.get(body.requestId);data=found?(approvals.get(body.requestId)??{...found.snapshot,approval:null}):null;}
    else if(op==='approveScope'){version='voidpay.invited-buyer-consent.v0';expect(m).toBeDefined();
      const approved={...m!.snapshot,approval:{requestId:body.requestId,approvedAtMs:Date.now()}};approvals.set(m!.snapshot.review.requestId,approved);
      budgets.add(approved.review.budget.budgetId);data=approved;}
    else if(op==='begin'||op==='read')data=m!.view;
    else if(op==='claimForWallet')data=m!.signing;
    else if(op==='submit')data={kind:'provider-accepted',jobId:m!.view.jobId,exposureId:'exposure-'+m!.view.jobId,
      grantHash:m!.signing.claim.kind==='original-wallet-request'?m!.signing.claim.grantHash:'',payment:'unconfirmed'};
    else if(op==='recover')data=state.released?{kind:'original-monetary-recovery',jobId:m!.view.jobId,settlement:{kind:'not-checked'},delivery:null,
      result:{kind:'not-started',reason:'AUTHORIZATION_EXPIRED_UNUSED'},budgetRecovery:{kind:'original-expired-unused-released',jobId:state.wrongRelease?'different-job':m!.view.jobId,
        claimId:'claim-a',releaseId:'release-a',preparedDigest:'c'.repeat(64),amountAtoms:'50000',recordedAtMs:Date.now(),evidenceDigest:'e'.repeat(64),
        finalizedBlock:{number:'0x1',hash:'0x'+'a'.repeat(64),timestamp:Math.ceil(Date.now()/1000)}}}:
      state.completed?await completedHostedHistory(m!):{kind:'original-monetary-recovery',jobId:m!.view.jobId,settlement:{kind:'not-checked'},delivery:null,result:{kind:'unknown',reason:'ORIGINAL_UNAVAILABLE'}};
    else throw Error('Unrecognized route');
    if(state.unknown===op)throw Error('Synthetic response lost AFTER recorded operation');
    return new Response(JSON.stringify({version,data}),{headers:{'content-type':'application/json'}});
  };
  function open(selected=policy){const h=createCustomerHostedJobs({directory:dir,policy:selected,session,fetch:fetcher,provider:{async request(q){
    if(q.method==='eth_accounts')return[testPayer.address];if(q.method==='eth_chainId')return'0x2105';expect(q.method).toBe('eth_signTypedData_v4');calls.push('sign');
    const t=JSON.parse(q.params![1] as string);return testPayer.signTypedData(t.domain,{ReceiveWithAuthorization:t.types.ReceiveWithAuthorization},t.message);
  }}});handles.push(h);return h;}
  return{policy,open,calls,state,records,budgets,input:{operationId:'external-job-a',selectedText:anchor.selection.selectedText}};
}
test('one owner policy creates two fresh original reviews/jobs under the same native budget and reserves before approve',async()=>{
  const f=await fixture(),h=f.open();f.state.before=op=>{if(op==='reviewScope'||op==='approveScope')expect(BigInt(h.status().committedAtoms)).toBeGreaterThanOrEqual(50000n);};
  expect(await h.run(f.input)).toMatchObject({kind:'submitted',operationId:f.input.operationId,payment:'unconfirmed'});
  expect(await h.run({...f.input,operationId:'external-job-b'})).toMatchObject({kind:'submitted'});
  expect(f.records.size).toBe(2);expect(f.budgets.size).toBe(1);expect(h.status()).toMatchObject({committedAtoms:'100000',attempts:2});
  for(const op of ['reviewScope','approveScope','begin','claimForWallet','sign','submit'])expect(f.calls.filter(x=>x===op)).toHaveLength(2);
  const effects=f.calls.filter(x=>!['readiness','read','readScope','recover'].includes(x)).length;
  expect(await f.open().run(f.input)).toMatchObject({kind:'original-recovery'});
  expect(f.calls.filter(x=>!['readiness','read','readScope','recover'].includes(x))).toHaveLength(effects);
  expect(await h.run({...f.input,operationId:'over-budget'})).toMatchObject({kind:'refused',reason:'BUDGET_EXHAUSTED'});
  expect(f.records.size).toBe(2);
});
test.each(['reviewScope','approveScope','begin'])('unknown %s preserves original IDs and performs only reads on reentry',async operation=>{
  const f=await fixture(),h=f.open();f.state.unknown=operation;
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original'});const before=[...f.calls];
  f.state.unknown='';expect(await f.open().run(f.input)).toMatchObject({kind:'original-recovery'});
  expect(f.calls.slice(before.length).every(x=>['readScope','read','recover'].includes(x))).toBe(true);
  expect(f.records.size).toBe(1);expect(f.calls.filter(x=>x===operation)).toHaveLength(1);expect(f.calls).not.toContain('sign');
});
test('changed bytes/service and immutable policy reset cannot consume approval or native budget',async()=>{
  const f=await fixture(),h=f.open();
  expect(await h.run({...f.input,selectedText:f.input.selectedText+' secret'})).toMatchObject({kind:'refused',reason:'INPUT_NOT_APPROVED'});expect(f.calls).toEqual([]);
  f.state.changedService=true;expect(await h.run(f.input)).toMatchObject({kind:'refused',reason:'READINESS_CHANGED'});expect(f.records.size).toBe(0);
  expect(()=>f.open({...f.policy,maxTotalAtoms:'150000'})).toThrow('POLICY_IMMUTABLE');
});
test('a revoked policy after native review blocks approval and preserves the reservation',async()=>{
  const f=await fixture(),h=f.open();f.state.before=op=>{if(op==='reviewScope')h.revoke();};
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original'});expect(f.calls).not.toContain('approveScope');expect(h.status().committedAtoms).toBe('50000');
});
test('an ambiguous payment submission stays reserved and cannot sign or submit again after revoke and reopen',async()=>{
  const f=await fixture(),h=f.open();f.state.unknown='submit';
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original'});h.revoke();const before=f.calls.length;
  f.state.unknown='';expect(await f.open().run(f.input)).toMatchObject({kind:'original-recovery'});
  expect(f.calls.slice(before).every(op=>['readScope','read','recover'].includes(op))).toBe(true);
  for(const op of ['reviewScope','approveScope','begin','claimForWallet','sign','submit'])expect(f.calls.filter(x=>x===op)).toHaveLength(1);
  expect(h.status().committedAtoms).toBe('50000');
});
test('two processes entering the same external operation cannot duplicate review or payment',async()=>{
  const f=await fixture(),a=f.open(),b=f.open();const outcomes=await Promise.all([a.run(f.input),b.run(f.input)]);
  expect(outcomes.filter(x=>x.kind==='submitted')).toHaveLength(1);
  for(const op of ['reviewScope','approveScope','begin','claimForWallet','sign','submit'])expect(f.calls.filter(x=>x===op)).toHaveLength(1);
});
test('one active slot opens for a second job only after accounted/opened original recovery, without refunding the lifetime cap',async()=>{
  const f=await fixture('100000',1),h=f.open();expect(await h.run(f.input)).toMatchObject({kind:'submitted'});
  expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'refused',reason:'ACTIVE_JOB_LIMIT'});
  f.state.completed=true;expect(await h.recover(f.input.operationId)).toMatchObject({kind:'original-recovery',result:{settlement:{kind:'accounted'},result:{kind:'opened'}}});
  expect(h.status().committedAtoms).toBe('50000');
  expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'submitted'});expect(h.status().committedAtoms).toBe('100000');
});
test('prepared interruption recovers the same job and only a native release opens its slot without refunding the cap',async()=>{
  const f=await fixture('100000',1),h=f.open();f.state.unknown='readScope';
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original',stage:'prepared'});
  expect(h.status()).toMatchObject({committedAtoms:'50000',attempts:0});expect(f.calls).not.toContain('sign');
  f.state.unknown='';const before=f.calls.length;
  expect(await h.recover(f.input.operationId)).toMatchObject({kind:'original-recovery',stage:'prepared',result:{budgetRecovery:null}});
  expect(f.calls.slice(before)).toEqual(['read','recover']);
  expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'refused',reason:'ACTIVE_JOB_LIMIT'});
  f.state.released=true;f.state.wrongRelease=true;
  await expect(h.recover(f.input.operationId)).rejects.toThrow();
  expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'refused',reason:'ACTIVE_JOB_LIMIT'});
  f.state.wrongRelease=false;
  expect(await h.recover(f.input.operationId)).toMatchObject({kind:'original-recovery',stage:'release_observed',result:{budgetRecovery:{kind:'released'}}});
  expect(await f.open().run(f.input)).toMatchObject({kind:'original-recovery',stage:'release_observed'});
  expect(f.calls.filter(x=>x==='begin')).toHaveLength(1);expect(f.calls).not.toContain('sign');
  expect(h.status()).toMatchObject({committedAtoms:'50000',attempts:0});
  f.state.released=false;expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'submitted'});
  expect(h.status().committedAtoms).toBe('100000');
  expect(await h.run({...f.input,operationId:'third'})).toMatchObject({kind:'refused',reason:'BUDGET_EXHAUSTED'});
});
test('an interrupted wallet disclosure also retains its debit when native unused recovery releases the active slot',async()=>{
  const f=await fixture('100000',1),h=f.open();f.state.unknown='claimForWallet';
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original',stage:'payment_intent'});
  expect(h.status()).toMatchObject({committedAtoms:'50000',attempts:1});expect(f.calls).not.toContain('sign');
  f.state.unknown='';f.state.released=true;
  expect(await f.open().recover(f.input.operationId)).toMatchObject({kind:'original-recovery',result:{budgetRecovery:{kind:'released'}}});
  expect(h.status().committedAtoms).toBe('50000');
  f.state.released=false;expect(await h.run({...f.input,operationId:'second'})).toMatchObject({kind:'submitted'});
  expect(h.status()).toMatchObject({committedAtoms:'100000',attempts:2});
});
test('policy expiry after review refuses approval instead of creating a replacement scope',async()=>{
  const f=await fixture(),h=f.open();f.state.before=op=>{if(op==='reviewScope')vi.spyOn(Date,'now').mockReturnValue(f.policy.expiresAtMs+1);};
  expect(await h.run(f.input)).toMatchObject({kind:'recover-original'});expect(f.calls).not.toContain('approveScope');expect(f.calls).not.toContain('begin');
});
