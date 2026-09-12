import { createHash, randomUUID } from 'node:crypto';
import { createAuthenticatedBuyerConsentAdapter, type BuyerConsentReview, type BuyerConsentSnapshot } from './invitedBuyerConsent';
import { createInvitedCheckoutTransport, type CheckoutSession, type CheckoutView, type CheckoutRecovery, type CheckoutCancelReceipt, type CheckoutSubmission } from './invitedCheckoutTransport';
import { canonical, equal, id, amount, integer, snapshot, record } from './monetaryProtocol';
import type { Eip1193Provider } from './original-payment-wallet';
import { openAutomaticBudget, requirePayment, AutomaticPaymentRefusal, type HostedOperation } from './sqlite-budget';
import { createHostedPaymentRunner } from './hosted-automatic-payment';
import { createHostedBuyerAdapter } from './hosted-onboarding-interface';

export type AutomaticHostedJobPolicy = Readonly<{
  version:'voidpay.customer-hosted-jobs.v1'; id:string;
  /** Displayed to and explicitly approved by the owner before installation. */
  ownerReviewed:BuyerConsentReview;
  inputs:readonly Readonly<{kind:'exact-bytes-v1';digest:string;byteLength:number}>[];
  notBeforeMs:number;expiresAtMs:number;maxPerJobAtoms:string;maxTotalAtoms:string;maxActiveJobs:number;
}>;
export type CustomerHostedJobRecovery =
 | Readonly<{kind:'original-recovery';operationId:string;result:CheckoutRecovery|CheckoutCancelReceipt}>
 | Readonly<{kind:'original-recovery';operationId:string;stage:string;review:BuyerConsentSnapshot|null;checkout:CheckoutView|null}>;
export type CustomerHostedJobOutcome = CustomerHostedJobRecovery
 | Readonly<{kind:'recover-original';operationId:string;stage:string}>
 | Readonly<{kind:'submitted';operationId:string;jobId:string;payment:'unconfirmed';submission:CheckoutSubmission}>
 | Readonly<{kind:'refused';reason:string}>;
export interface CustomerHostedJobs {
 run(input:Readonly<{operationId:string;selectedText:string}>):Promise<CustomerHostedJobOutcome>;
 recover(operationId:string):Promise<CustomerHostedJobRecovery>;
 status():Readonly<{policyId:string;revoked:boolean;committedAtoms:string;attempts:number;maxTotalAtoms:string}>;
 revoke():void;close():void;
}
type Body={reviewRequestId:string;approveRequestId:string;beginRequestId:string;
  inputDigest:string;inputByteLength:number;snapshot?:BuyerConsentSnapshot;checkout?:CheckoutView};
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const ORIGIN='https://voidly.ai';
function templateShape(r:BuyerConsentReview){
  record(r,['version','reviewId','requestId','permissionId','configurationDigest','reviewedAtMs','budget','allowance','original']);
  record(r.original,['version','lineage','service','receivingDigest','supplierManifestDigest','providerDid','sessionServiceRef','inputHandle','grantId','policyId',
    'authorizationRef','approvedBy','inputDigest','inputByteLength','disclosure','amountAtoms','notBeforeMs','expiresAtMs','maxDurationMs','requiredRemainingMs']);
  record(r.original.lineage,['context','membershipId','budgetId','budgetDigest','allowanceId','allowanceDigest','profileDigest','payerAccount']);
  record(r.original.service,['providerId','serviceId','version','definitionDigest']);
  for(const [value,fields] of [[r.budget,['version','budgetId','context','membershipId','authorizationRef','acceptedBy','scope','maxTotal','maxActiveJobs']],
    [r.allowance,['version','allowanceId','budgetId','context','membershipId','acceptedBy','scope']]] as const){
    record(value,fields);record(value.context,['tenantId','subjectId','appId']);
    record(value.scope,['version','profileDigest','chain','asset','payerAccount','services','maxPerJob','notBeforeMs','expiresAtMs']);
    requirePayment(value.scope.services.length===1,'INVALID_POLICY');
    for(const s of value.scope.services){record(s,['service','receivingDigest','recipient']);record(s.service,['providerId','serviceId','version','definitionDigest']);}
  }
  record(r.original.lineage.context,['tenantId','subjectId','appId']);
}
function scope(r:BuyerConsentReview){
  const {reviewId,requestId,reviewedAtMs,...fixed}=r;
  requirePayment(r.original.inputHandle===`${reviewId}:input`&&r.original.grantId===`${reviewId}:grant`
    &&r.original.policyId===`${reviewId}:policy`&&r.original.authorizationRef===`${reviewId}:disclosure`,'DERIVED_HANDLES_CHANGED');
  id(reviewId);id(requestId);integer(reviewedAtMs);
  const {inputHandle,grantId,policyId,authorizationRef,inputDigest,inputByteLength,...original}=r.original;
  return canonical({...fixed,original});
}
const ref=(s:BuyerConsentSnapshot)=>({reviewId:s.review.reviewId,reviewDigest:s.reviewDigest});

/** The customer's trusted host is the delegation boundary. The agent receives
 * run/recover only; policy/session/signer installation are explicit owner work. */
export function createCustomerHostedJobs(options:Readonly<{
  directory:string;policy:AutomaticHostedJobPolicy;session:CheckoutSession;
  provider:Eip1193Provider;fetch?:typeof fetch;signingTimeoutMs?:number;
}>):Readonly<CustomerHostedJobs>{
  const [major,minor]=process.versions.node.split('.').map(Number);
  requirePayment(major>24||(major===24&&minor>=15),'NODE_24_15_REQUIRED');
  const p=snapshot(options.policy,131072) as AutomaticHostedJobPolicy;
  record(p,['version','id','ownerReviewed','inputs','notBeforeMs','expiresAtMs','maxPerJobAtoms','maxTotalAtoms','maxActiveJobs']);
  requirePayment(p.version==='voidpay.customer-hosted-jobs.v1'&&Array.isArray(p.inputs)&&p.inputs.length>0&&p.inputs.length<=32,'INVALID_POLICY');
  id(p.id);integer(p.notBeforeMs);integer(p.expiresAtMs);amount(p.maxPerJobAtoms);amount(p.maxTotalAtoms);integer(p.maxActiveJobs);
  const native=p.ownerReviewed;templateShape(native);
  const b=native.budget,template=scope(native),inputs=new Set<string>();
  requirePayment(p.notBeforeMs<p.expiresAtMs&&p.notBeforeMs>=b.scope.notBeforeMs&&p.expiresAtMs<=b.scope.expiresAtMs
    &&p.maxPerJobAtoms===native.original.amountAtoms&&BigInt(p.maxPerJobAtoms)<=BigInt(p.maxTotalAtoms)
    &&BigInt(p.maxTotalAtoms)<=BigInt(b.maxTotal)&&p.maxActiveJobs>=1&&p.maxActiveJobs<=b.maxActiveJobs,'POLICY_SCOPE_MISMATCH');
  for(const input of p.inputs){record(input,['kind','digest','byteLength']);requirePayment(input.kind==='exact-bytes-v1'&&/^[0-9a-f]{64}$/.test(input.digest)
    &&Number.isSafeInteger(input.byteLength)&&input.byteLength>=0&&input.byteLength<=16384,'INVALID_INPUT_TEMPLATE');
    const key=canonical([input.digest,input.byteLength]);requirePayment(!inputs.has(key),'DUPLICATE_TEMPLATE');inputs.add(key);}
  const session=Object.freeze({...options.session}),fetcher=options.fetch??globalThis.fetch.bind(globalThis);
  const provider=options.provider,signRequest=provider?.request;
  requirePayment(typeof fetcher==='function'&&typeof signRequest==='function','INVALID_CONFIGURATION');
  const signer:Eip1193Provider={request(r){requirePayment(provider.request===signRequest,'CUSTOMER_SIGNER_CHANGED');return signRequest.call(provider,r);}};
  const store=openAutomaticBudget(options.directory,{id:p.id,body:canonical(p),maxTotalAtoms:Number(p.maxTotalAtoms),notBeforeMs:p.notBeforeMs,expiresAtMs:p.expiresAtMs});
  const current=()=>requirePayment(!session.signal.aborted&&session.isCurrent(),'AUTH_REQUIRED');
  function decoded(op:HostedOperation){return JSON.parse(op.body) as Body;}
  function checkReview(s:BuyerConsentSnapshot,body:Body){
    requirePayment(s.reviewDigest===hash(canonical(s.review))&&scope(s.review)===template&&s.review.requestId===body.reviewRequestId
      &&s.review.original.inputDigest===body.inputDigest&&s.review.original.inputByteLength===body.inputByteLength
      &&s.review.reviewedAtMs>=p.notBeforeMs&&s.review.reviewedAtMs<p.expiresAtMs,'REVIEW_SCOPE_CHANGED');
  }
  function adapters(operationId?:string){
    const transport:typeof fetch=(url,init)=>{
      current();const u=new URL(String(url),ORIGIN);
      requirePayment(u.origin===ORIGIN&&!u.search&&!u.hash&&!u.username&&!u.password&&init?.method==='POST'&&typeof init.body==='string'
        &&/^\/v0\/market\/(buyer-onboarding\/readiness|buyer-consent\/(reviewScope|approveScope|readScope)|checkout\/(begin|read|claimForWallet|submit|recover))$/.test(u.pathname),'OPERATION_REFUSED');
      const operation=u.pathname.split('/').at(-1)!;
      if(['reviewScope','approveScope','begin'].includes(operation)){
        requirePayment(operationId,'OPERATION_REQUIRED');
        const op=store.operation(operationId!),body=op&&decoded(op),request=JSON.parse(init!.body as string);
        requirePayment(body,'OPERATION_REQUIRED');
        const stages={reviewScope:'review_intent',approveScope:'approve_intent',begin:'begin_intent'} as const;
        store.assertOperationStage(operationId!,stages[operation as keyof typeof stages],Date.now());
        requirePayment(request.requestId===(operation==='reviewScope'?body!.reviewRequestId:operation==='approveScope'?body!.approveRequestId:body!.beginRequestId),'REQUEST_CHANGED');
        if(operation!=='reviewScope')requirePayment(body!.snapshot&&request.reviewId===body!.snapshot.review.reviewId&&request.reviewDigest===body!.snapshot.reviewDigest,'REVIEW_CHANGED');
        if(operation!=='approveScope')requirePayment(typeof request.selectedText==='string'&&hash(request.selectedText)===body!.inputDigest
          &&new TextEncoder().encode(request.selectedText).length===body!.inputByteLength,'INPUT_CHANGED');
      }
      const headers=new Headers(init!.headers);headers.set('origin',ORIGIN);headers.set('accept-encoding','identity');
      return fetcher(u.href,{...init,headers,redirect:'error',credentials:'omit'});
    };
    return {transport,consent:createAuthenticatedBuyerConsentAdapter(session,transport),checkout:createInvitedCheckoutTransport(session,transport),onboarding:createHostedBuyerAdapter(session,transport)};
  }
  function payment(op:HostedOperation){
    const body=decoded(op);requirePayment(body.snapshot?.approval,'APPROVAL_REQUIRED');
    return createHostedPaymentRunner({...options,provider:signer,session,fetch:adapters(op.operationId).transport},p,
      Object.freeze({...store,reserve:(value:Parameters<typeof store.reserve>[0],now:number)=>store.adoptOperation(op.operationId,value,now)}),
      requestId=>requestId===body.reviewRequestId?body.snapshot:undefined);
  }
  const unknown=(operationId:string)=>Object.freeze({kind:'recover-original' as const,operationId,stage:store.operation(operationId)?.stage??'unknown'});
  async function recover(operationId:string):Promise<CustomerHostedJobRecovery>{
    id(operationId);const op=store.operation(operationId);requirePayment(op,'ORIGINAL_REQUIRED');
    const body=decoded(op!),api=adapters(operationId);
    if(op!.paymentJobId){
      const result=await payment(op!).recover(body.reviewRequestId);current();
      if(result.kind==='original-monetary-recovery'&&result.settlement.kind==='accounted'&&result.result.kind==='opened'&&op!.stage==='payment_intent')
        store.transitionOperation(operationId,'payment_intent','result_observed',op!.body,Date.now(),false);
      return Object.freeze({kind:'original-recovery' as const,operationId,result});
    }
    const observed=await api.consent.readScope({requestId:body.reviewRequestId});current();
    if(observed)checkReview(observed,body);
    if(observed?.approval){requirePayment(observed.approval.requestId===body.approveRequestId,'APPROVAL_CHANGED');
      const checkout=await api.checkout.read(ref(observed));current();
      return Object.freeze({kind:'original-recovery' as const,operationId,stage:op!.stage,review:observed,checkout});}
    return Object.freeze({kind:'original-recovery' as const,operationId,stage:op!.stage,review:observed,checkout:null});
  }
  return Object.freeze({
    async run(input:Readonly<{operationId:string;selectedText:string}>):Promise<CustomerHostedJobOutcome>{
      let operationId:string|undefined,reserved=false;
      try{
        operationId=id(input.operationId);const text=input.selectedText;
        requirePayment(typeof text==='string','INVALID_INPUT');const inputByteLength=new TextEncoder().encode(text).length,inputDigest=hash(text);
        requirePayment(inputs.has(canonical([inputDigest,inputByteLength])),'INPUT_NOT_APPROVED');
        const binding=canonical({inputDigest,inputByteLength,amount:p.maxPerJobAtoms}),old=store.operation(operationId);
        if(old){requirePayment(old.binding===binding,'OPERATION_CONFLICT');return recover(operationId);}
        current();const api=adapters(operationId),ready=await api.onboarding.readiness();current();
        requirePayment(ready.kind==='checkout-ready'&&ready.permissionId===native.permissionId&&ready.configurationDigest===native.configurationDigest
          &&equal(ready.service,native.original.service)&&ready.payerAccount===b.scope.payerAccount&&ready.maxPerJobAtoms===b.scope.maxPerJob
          &&ready.maxTotalAtoms===b.maxTotal&&ready.maxActiveJobs===b.maxActiveJobs&&ready.notBeforeMs===b.scope.notBeforeMs&&ready.expiresAtMs===b.scope.expiresAtMs,'READINESS_CHANGED');
        const body:Body={reviewRequestId:randomUUID(),approveRequestId:randomUUID(),beginRequestId:randomUUID(),inputDigest,inputByteLength};
        if(!store.reserveOperation({operationId,binding,body:canonical(body),amountAtoms:Number(p.maxPerJobAtoms)},Date.now(),p.maxActiveJobs))return unknown(operationId);
        reserved=true;
        body.snapshot=await api.consent.reviewScope({requestId:body.reviewRequestId,selectedText:text});current();checkReview(body.snapshot,body);
        requirePayment(body.snapshot.approval===null,'UNEXPECTED_APPROVAL');
        store.transitionOperation(operationId,'review_intent','approve_intent',canonical(body),Date.now());
        const approved=await api.consent.approveScope({...ref(body.snapshot),requestId:body.approveRequestId});current();checkReview(approved,body);
        requirePayment(approved.approval?.requestId===body.approveRequestId&&equal(approved.review,body.snapshot.review),'APPROVAL_CHANGED');body.snapshot=approved;
        store.transitionOperation(operationId,'approve_intent','begin_intent',canonical(body),Date.now());
        body.checkout=await api.checkout.begin({...ref(approved),requestId:body.beginRequestId,selectedText:text});current();
        requirePayment(body.checkout.phase==='wallet-ready'&&body.checkout.jobId&&body.checkout.amountAtoms===p.maxPerJobAtoms,'ORIGINAL_UNCONFIRMED');
        store.transitionOperation(operationId,'begin_intent','prepared',canonical(body),Date.now());
        const outcome=await payment(store.operation(operationId)!).payApproved(body.reviewRequestId);
        return outcome.kind==='submitted'?Object.freeze({...outcome,operationId}):unknown(operationId);
      }catch(e){return reserved&&operationId?unknown(operationId):Object.freeze({kind:'refused' as const,reason:e instanceof AutomaticPaymentRefusal?e.code:'ORIGINAL_UNCONFIRMED'});}
    },
    recover,status:store.status,revoke:store.revoke,close:store.close,
  });
}
