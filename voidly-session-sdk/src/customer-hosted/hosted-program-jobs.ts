import {createHash} from 'node:crypto';
import {createProgramClient,parseOwnerAppProgram,parseProgramEntry,programEntryIds,type OwnerAppProgram,type OwnerAppProgramCredential,type ProgramEntry,type ProgramLifetime} from './owner-app-program-client';
import {createProgramCheckoutTransport,type CheckoutView} from './invitedCheckoutTransport';
import {createHostedPaymentRunner} from './hosted-automatic-payment';
import {openAutomaticBudget,requirePayment,AutomaticPaymentRefusal,type HostedOperation} from './sqlite-budget';
import {canonical,equal,record} from './monetaryProtocol';
import type {Eip1193Provider} from './original-payment-wallet';
import type {CustomerHostedJobOutcome,CustomerHostedJobRecovery} from './hosted-automatic-jobs';
export interface CustomerHostedProgramJobs {
 run(input:Readonly<{selectedText:string}>):Promise<CustomerHostedJobOutcome>;
 recover(inputDigest:string):Promise<CustomerHostedJobRecovery>;
 status():Readonly<{policyId:string;revoked:boolean;committedAtoms:string;attempts:number;maxTotalAtoms:string}>;
 revoke():void;close():void;
}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
type Body={entry:ProgramEntry;checkout?:CheckoutView};
export function createCustomerHostedProgramJobs(options:Readonly<{
 directory:string;program:OwnerAppProgram;credential:OwnerAppProgramCredential;lifetime:ProgramLifetime;
 provider:Eip1193Provider;fetch?:typeof fetch;signingTimeoutMs?:number;
}>):Readonly<CustomerHostedProgramJobs>{
 const [major,minor]=process.versions.node.split('.').map(Number);requirePayment(major>24||major===24&&minor>=15,'NODE_24_15_REQUIRED');
 const program=parseOwnerAppProgram(options.program),p=program.scope;
 requirePayment(program.approvedAtMs!==null,'PROGRAM_APPROVAL_REQUIRED');
 const client=createProgramClient(program,options.credential,options.lifetime,options.fetch??globalThis.fetch.bind(globalThis));
 const provider=options.provider,signRequest=provider?.request;
 requirePayment(typeof signRequest==='function','CUSTOMER_SIGNER_REQUIRED');
 const signer:Eip1193Provider={request(r){requirePayment(provider.request===signRequest,'CUSTOMER_SIGNER_CHANGED');return signRequest.call(provider,r);}};
 const store=openAutomaticBudget(options.directory,{id:program.programId,body:canonical({scope:p,programDigest:program.programDigest,appOrigin:program.appOrigin,approvedAtMs:program.approvedAtMs}),
  maxTotalAtoms:Number(p.maxTotalAtoms),notBeforeMs:p.notBeforeMs,expiresAtMs:p.expiresAtMs});
 const ref=(e:ProgramEntry)=>({reviewId:e.review.review.reviewId,reviewDigest:e.review.reviewDigest});
 function decoded(op:HostedOperation):Body{
  const r=record(JSON.parse(op.body),['entry'],['checkout']);
  const entry=parseProgramEntry(r.entry,program,JSON.parse(op.binding).inputDigest);
  return {entry,...(r.checkout?{checkout:r.checkout as CheckoutView}:{})};
 }
 function transport(operationId:string){
  const op=store.operation(operationId);requirePayment(op,'ORIGINAL_REQUIRED');const {entry}=decoded(op!);
  return client.transport(entry.inputDigest,(operation,body)=>{
   client.current();requirePayment(body.reviewId===entry.review.review.reviewId&&body.reviewDigest===entry.review.reviewDigest,'REVIEW_CHANGED');
   if(operation==='begin'){
    store.assertOperationStage(operationId,'begin_intent',Date.now());
    requirePayment(body.requestId===entry.beginRequestId&&typeof body.selectedText==='string'&&hash(body.selectedText)===entry.inputDigest
     &&Buffer.byteLength(body.selectedText)===entry.inputByteLength,'INPUT_CHANGED');
   }
  });
 }
 function payment(op:HostedOperation){
  const body=decoded(op);
  return createHostedPaymentRunner({session:client.session,provider:signer,fetch:transport(op.operationId),signingTimeoutMs:options.signingTimeoutMs},p,
   Object.freeze({...store,reserve:(v:Parameters<typeof store.reserve>[0],now:number)=>store.adoptOperation(op.operationId,v,now)}),
   requestId=>requestId===body.entry.review.review.requestId?body.entry.review:undefined,{
    consent:{async readScope({requestId}){requirePayment(requestId===body.entry.review.review.requestId,'REVIEW_CHANGED');return(await client.entry(body.entry.inputDigest)).review;}},
    checkout:wire=>createProgramCheckoutTransport(client.session,wire),
   });
 }
 const unknown=(operationId:string)=>Object.freeze({kind:'recover-original' as const,operationId,stage:store.operation(operationId)?.stage??'unknown'});
 async function recover(inputDigest:string):Promise<CustomerHostedJobRecovery>{
  const {entryId:operationId}=programEntryIds(program,inputDigest),op=store.operation(operationId);requirePayment(op,'ORIGINAL_REQUIRED');
  const body=decoded(op!);client.current();
  if(op!.paymentJobId){
   const result=await payment(op!).recover(body.entry.review.review.requestId);client.current();
   if(result.kind==='original-monetary-recovery'&&result.settlement.kind==='accounted'&&result.result.kind==='opened'&&op!.stage==='payment_intent')
    store.transitionOperation(operationId,'payment_intent','result_observed',op!.body,Date.now(),false);
   if((result.kind==='original-unclaimed-cancelled'||result.budgetRecovery?.kind==='released')&&op!.stage==='payment_intent')
    store.transitionOperation(operationId,'payment_intent','release_observed',op!.body,Date.now(),false);
   return Object.freeze({kind:'original-recovery',operationId,result});
  }
  const entry=await client.entry(inputDigest);client.current();requirePayment(equal(entry,body.entry),'PROGRAM_ENTRY_CHANGED');
  const checkout=createProgramCheckoutTransport(client.session,transport(operationId)),view=await checkout.read(ref(entry));client.current();
  if(view?.jobId){
   requirePayment(view.amountAtoms===p.maxPerJobAtoms&&(!body.checkout||view.jobId===body.checkout.jobId&&view.checkoutId===body.checkout.checkoutId
    &&view.expiresAtMs===body.checkout.expiresAtMs),'ORIGINAL_CHANGED');
   const result=await checkout.recover(ref(entry));client.current();
   if((result.kind==='original-unclaimed-cancelled'||result.budgetRecovery?.kind==='released')&&op!.stage!=='release_observed')
    store.transitionOperation(operationId,op!.stage,'release_observed',op!.body,Date.now(),false);
   return Object.freeze({kind:'original-recovery',operationId,stage:store.operation(operationId)!.stage,review:entry.review,checkout:view,result});
  }
  return Object.freeze({kind:'original-recovery',operationId,stage:op!.stage,review:entry.review,checkout:null});
 }
 return Object.freeze({
  async run(input:Readonly<{selectedText:string}>):Promise<CustomerHostedJobOutcome>{
   let operationId:string|undefined,reserved=false;
   try{
    const value=record(input,['selectedText']);requirePayment(typeof value.selectedText==='string','INVALID_INPUT');const text=value.selectedText as string,inputDigest=hash(text);
    const allowed=p.inputs.find(i=>i.inputDigest===inputDigest);requirePayment(allowed&&Buffer.byteLength(text)===allowed.inputByteLength,'INPUT_NOT_APPROVED');
    operationId=programEntryIds(program,inputDigest).entryId;
    if(store.operation(operationId))return recover(inputDigest);
    client.current();requirePayment((await client.status()).state==='ready','PROGRAM_NOT_READY');client.current();
    const entry=await client.entry(inputDigest);client.current();
    const readiness=await client.readiness(),native=entry.review.review;client.current();
    requirePayment(readiness.kind==='checkout-ready'&&readiness.permissionId===native.permissionId&&readiness.configurationDigest===native.configurationDigest
     &&equal(readiness.service,p.service)&&readiness.payerAccount===p.payerAccount&&readiness.maxPerJobAtoms===native.budget.scope.maxPerJob
     &&readiness.maxTotalAtoms===native.budget.maxTotal&&readiness.maxActiveJobs===native.budget.maxActiveJobs
     &&readiness.notBeforeMs===native.budget.scope.notBeforeMs&&readiness.expiresAtMs===native.budget.scope.expiresAtMs,'READINESS_CHANGED');
    const body:Body={entry},binding=canonical({inputDigest,inputByteLength:allowed!.inputByteLength,amount:p.maxPerJobAtoms});
    if(!store.reserveOperation({operationId,binding,body:canonical(body),amountAtoms:Number(p.maxPerJobAtoms)},Date.now(),p.maxActiveJobs))return unknown(operationId);
    reserved=true;
    store.transitionOperation(operationId,'review_intent','begin_intent',canonical(body),Date.now());
    const checkout=createProgramCheckoutTransport(client.session,transport(operationId));
    body.checkout=await checkout.begin({...ref(entry),requestId:entry.beginRequestId,selectedText:text});client.current();
    requirePayment(body.checkout.phase==='wallet-ready'&&body.checkout.jobId&&body.checkout.amountAtoms===p.maxPerJobAtoms,'ORIGINAL_UNCONFIRMED');
    store.transitionOperation(operationId,'begin_intent','prepared',canonical(body),Date.now());
    const outcome=await payment(store.operation(operationId)!).payApproved(entry.review.review.requestId);
    return outcome.kind==='submitted'?Object.freeze({...outcome,operationId}):unknown(operationId);
   }catch(error){return reserved&&operationId?unknown(operationId):Object.freeze({kind:'refused',reason:error instanceof AutomaticPaymentRefusal?error.code:'ORIGINAL_UNCONFIRMED'});}
  },recover,status:store.status,revoke:store.revoke,close:store.close,
 });
}
