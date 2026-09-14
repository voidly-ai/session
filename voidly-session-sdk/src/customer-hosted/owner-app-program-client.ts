import {createHash,randomUUID,sign,KeyObject} from 'node:crypto';
import {record,snapshot,canonical,equal,id,amount,integer} from './monetaryProtocol';
import {parseBuyerService,parseHostedBuyerReadiness,hostedPayer} from './hosted-onboarding-interface';
import {parseBuyerConsentSnapshot,type BuyerConsentSnapshot,type BuyerConsentServiceRef} from './invitedBuyerConsent';
import {readCheckoutResponseBody,type CheckoutSession} from './invitedCheckoutTransport';
import {requirePayment,AutomaticPaymentRefusal} from './sqlite-budget';
export const OWNER_APP_PROGRAM_VERSION='voidpay.owner-app-program.v1' as const;
const OPERATIONS=['status','entry','readiness','begin','read','claimForWallet','submit','recover'] as const;
const ORIGIN='https://voidly.ai',PREFIX='/v0/market/connected-programs/';
const STATUSES:Readonly<Record<string,number>>={AUTH_REQUIRED:401,FORBIDDEN:403,NOT_FOUND:404,INVALID_INPUT:400,CONFLICT:409,EXPIRED:410,UNAVAILABLE:503,OUTCOME_UNKNOWN:503};
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const digest=(v:unknown)=>{requirePayment(typeof v==='string'&&/^[0-9a-f]{64}$/.test(v),'PROGRAM_CHANGED');return v as string;};
export type OwnerAppProgramScope=Readonly<{
 version:typeof OWNER_APP_PROGRAM_VERSION;programId:string;connectionId:string;connectionScopeDigest:string;ownerId:string;appId:string;service:BuyerConsentServiceRef;
 payerAccount:string;inputs:readonly Readonly<{inputDigest:string;inputByteLength:number}>[];maxPerJobAtoms:string;maxTotalAtoms:string;maxActiveJobs:number;
 notBeforeMs:number;expiresAtMs:number;operations:typeof OPERATIONS;dataDisclosure:'approved-inputs-and-original-results';paymentMode:'optional-finite-program';walletAuthorityGranted:false;
}>;
export type OwnerAppProgram=Readonly<{
 version:typeof OWNER_APP_PROGRAM_VERSION;programId:string;requestId:string;connectionId:string;appName:string;appOrigin:string;scope:OwnerAppProgramScope;programDigest:string;
 state:'reviewed'|'preparing'|'ready'|'revoked'|'expired';preparedInputDigests:readonly string[];approvedAtMs:number|null;revokedAtMs:number|null;walletAuthorityGranted:false;
}>;
export type OwnerAppProgramCredential=Readonly<{builderKey:string;keyId:string;privateKey:KeyObject}>;
export type ProgramLifetime=Pick<CheckoutSession,'isCurrent'|'signal'>;
export type ProgramEntry=Readonly<{version:typeof OWNER_APP_PROGRAM_VERSION;programId:string;programDigest:string;inputDigest:string;inputByteLength:number;
 entryId:string;review:BuyerConsentSnapshot;beginRequestId:string;prepared:boolean}>;
export function parseOwnerAppProgram(value:unknown):OwnerAppProgram {
 const r=record(snapshot(value,131072),['version','programId','requestId','connectionId','appName','appOrigin','scope','programDigest','state','preparedInputDigests','approvedAtMs','revokedAtMs','walletAuthorityGranted']);
 const s=record(r.scope,['version','programId','connectionId','connectionScopeDigest','ownerId','appId','service','payerAccount','inputs','maxPerJobAtoms','maxTotalAtoms','maxActiveJobs','notBeforeMs','expiresAtMs','operations','dataDisclosure','paymentMode','walletAuthorityGranted']);
 requirePayment(Array.isArray(s.inputs)&&s.inputs.length>=1&&s.inputs.length<=32,'INVALID_PROGRAM');
 const seen=new Set<string>(),inputs=(s.inputs as unknown[]).map(v=>{const x=record(v,['inputDigest','inputByteLength']),d=digest(x.inputDigest),n=integer(x.inputByteLength);
  requirePayment(n<=16384&&!seen.has(d),'INVALID_PROGRAM_INPUTS');seen.add(d);return Object.freeze({inputDigest:d,inputByteLength:n});});
 const start=integer(s.notBeforeMs),end=integer(s.expiresAtMs),per=amount(s.maxPerJobAtoms),total=amount(s.maxTotalAtoms);
 requirePayment(s.version===OWNER_APP_PROGRAM_VERSION&&s.walletAuthorityGranted===false&&s.paymentMode==='optional-finite-program'
  &&s.dataDisclosure==='approved-inputs-and-original-results'&&equal(s.operations,OPERATIONS)&&s.maxActiveJobs===1&&end>start&&end-start<=86400000
  &&BigInt(per)*BigInt(inputs.length)<=BigInt(total),'INVALID_PROGRAM_SCOPE');
 const scope:OwnerAppProgramScope=Object.freeze({version:OWNER_APP_PROGRAM_VERSION,programId:id(s.programId),connectionId:id(s.connectionId),connectionScopeDigest:digest(s.connectionScopeDigest),
  ownerId:id(s.ownerId),appId:id(s.appId),service:parseBuyerService(s.service),payerAccount:hostedPayer(s.payerAccount),inputs:Object.freeze(inputs),maxPerJobAtoms:per,maxTotalAtoms:total,
  maxActiveJobs:1,notBeforeMs:start,expiresAtMs:end,operations:Object.freeze([...OPERATIONS]) as typeof OPERATIONS,dataDisclosure:'approved-inputs-and-original-results',paymentMode:'optional-finite-program',walletAuthorityGranted:false});
 const programId=id(r.programId),requestId=id(r.requestId),connectionId=id(r.connectionId),programDigest=digest(r.programDigest);
 requirePayment(r.version===OWNER_APP_PROGRAM_VERSION&&r.walletAuthorityGranted===false&&programId===scope.programId&&connectionId===scope.connectionId
  &&programId===hash(JSON.stringify([OWNER_APP_PROGRAM_VERSION,scope.ownerId,connectionId,requestId]))&&programDigest===hash(JSON.stringify(scope))
  &&typeof r.appName==='string'&&r.appName.length>0&&r.appName.length<=120&&typeof r.appOrigin==='string','INVALID_PROGRAM');
 const origin=new URL(r.appOrigin as string);requirePayment(origin.protocol==='https:'&&origin.origin===r.appOrigin,'INVALID_APP_ORIGIN');
 requirePayment(typeof r.state==='string'&&['reviewed','preparing','ready','revoked','expired'].includes(r.state)&&Array.isArray(r.preparedInputDigests),'INVALID_PROGRAM_STATE');
 const prepared=(r.preparedInputDigests as unknown[]).map(digest);requirePayment(new Set(prepared).size===prepared.length&&prepared.every(d=>seen.has(d)),'INVALID_PROGRAM_STATE');
 const approved=r.approvedAtMs===null?null:integer(r.approvedAtMs),revoked=r.revokedAtMs===null?null:integer(r.revokedAtMs);
 requirePayment((approved===null||approved>=start&&approved<end)&&(revoked===null||revoked>=start&&(approved===null||revoked>=approved))
  &&(r.state!=='ready'||approved!==null&&revoked===null&&prepared.length===inputs.length),'INVALID_PROGRAM_STATE');
 return Object.freeze({version:OWNER_APP_PROGRAM_VERSION,programId,requestId,connectionId,appName:r.appName as string,appOrigin:r.appOrigin as string,scope,programDigest,
  state:r.state as OwnerAppProgram['state'],preparedInputDigests:Object.freeze(prepared),approvedAtMs:approved,revokedAtMs:revoked,walletAuthorityGranted:false});
}
export function programEntryIds(program:OwnerAppProgram,inputDigest:string){
 requirePayment(program.scope.inputs.some(v=>v.inputDigest===inputDigest),'INPUT_NOT_APPROVED');
 const entryId=hash(JSON.stringify([OWNER_APP_PROGRAM_VERSION,program.programId,inputDigest]));
 return {entryId,reviewRequestId:'oap-review-'+entryId,approveRequestId:'oap-approve-'+entryId,beginRequestId:'oap-begin-'+entryId};
}
export function parseProgramEntry(value:unknown,program:OwnerAppProgram,inputDigest:string):ProgramEntry {
 const r=record(snapshot(value,65536),['version','programId','programDigest','inputDigest','inputByteLength','entryId','review','beginRequestId','prepared']);
 const ids=programEntryIds(program,inputDigest),input=program.scope.inputs.find(i=>i.inputDigest===inputDigest)!,s=parseBuyerConsentSnapshot(r.review),o=s.review.original,b=s.review.budget,p=program.scope;
 requirePayment(r.version===OWNER_APP_PROGRAM_VERSION&&r.programId===program.programId&&r.programDigest===program.programDigest&&r.inputDigest===inputDigest
  &&r.inputByteLength===input.inputByteLength&&r.entryId===ids.entryId&&r.beginRequestId===ids.beginRequestId&&r.prepared===true
  &&s.review.requestId===ids.reviewRequestId&&s.approval?.requestId===ids.approveRequestId&&s.reviewDigest===hash(canonical(s.review))
  &&o.inputDigest===inputDigest&&o.inputByteLength===input.inputByteLength&&equal(o.service,p.service)&&o.lineage.payerAccount===p.payerAccount
  &&o.amountAtoms===p.maxPerJobAtoms&&BigInt(p.maxTotalAtoms)<=BigInt(b.maxTotal)&&p.maxActiveJobs<=b.maxActiveJobs
  &&p.notBeforeMs>=b.scope.notBeforeMs&&p.expiresAtMs<=b.scope.expiresAtMs,'PROGRAM_ENTRY_CHANGED');
 return Object.freeze({version:OWNER_APP_PROGRAM_VERSION,programId:program.programId,programDigest:program.programDigest,inputDigest,inputByteLength:input.inputByteLength,
  entryId:ids.entryId,review:s,beginRequestId:ids.beginRequestId,prepared:true});
}
export function createProgramClient(program:OwnerAppProgram,credential:OwnerAppProgramCredential,lifetime:ProgramLifetime,fetcher:typeof fetch){
 const c=record(credential,['builderKey','keyId','privateKey']),l=record(lifetime,['isCurrent','signal']);
 requirePayment(typeof c.builderKey==='string'&&/^vpb_[A-Za-z0-9_-]{43}$/.test(c.builderKey)&&typeof fetcher==='function'
  &&c.privateKey instanceof KeyObject&&c.privateKey.type==='private'&&c.privateKey.asymmetricKeyType==='rsa'
  &&(c.privateKey.asymmetricKeyDetails?.modulusLength??0)>=2048&&typeof l.isCurrent==='function'&&l.signal instanceof AbortSignal,'INVALID_PROGRAM_CREDENTIAL');
 const builderKey=c.builderKey as string,keyId=id(c.keyId),privateKey=c.privateKey as KeyObject,isCurrent=l.isCurrent as ()=>boolean,signal=l.signal as AbortSignal;
 let lost=false;
 function current(){if(lost||signal.aborted){lost=true;throw new AutomaticPaymentRefusal('AUTH_REQUIRED');}try{if(isCurrent.call(lifetime))return;}catch{}lost=true;throw new AutomaticPaymentRefusal('AUTH_REQUIRED');}
 const session=Object.freeze({signal,isCurrent:()=>{try{current();return true;}catch{return false;}}});
 function dispatch(operation:typeof OPERATIONS[number],body:Record<string,unknown>,requestSignal:AbortSignal){
  current();requirePayment(!requestSignal.aborted&&OPERATIONS.includes(operation),'OPERATION_REFUSED');
  const text=JSON.stringify(body);requirePayment(Buffer.byteLength(text)<=32768,'INVALID_INPUT');
  const p=program.scope,iat=Math.floor(Date.now()/1000),exp=Math.min(iat+60,Math.floor(p.expiresAtMs/1000));
  requirePayment(iat*1000>=p.notBeforeMs&&exp>iat,'PROGRAM_EXPIRED');
  const header={alg:'RS256',typ:'voidpay-owner-app-program-delegation+jwt',kid:keyId};
  const claims={iss:program.appOrigin,aud:ORIGIN+PREFIX.slice(0,-1),sub:p.ownerId,app_id:p.appId,connection_id:p.connectionId,scope_digest:p.connectionScopeDigest,
   program_id:program.programId,program_digest:program.programDigest,operation,iat,nbf:iat,exp,jti:randomUUID()};
  const unsigned=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
  const assertion=unsigned+'.'+sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url');
  current();requirePayment(!requestSignal.aborted,'AUTH_REQUIRED');
  return fetcher(ORIGIN+PREFIX+operation,{method:'POST',body:text,headers:{'content-type':'application/json','accept-encoding':'identity',
   'x-voidpay-builder-key':builderKey,authorization:'Bearer '+assertion},signal:requestSignal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
 }
 async function data(operation:'status'|'entry'|'readiness',extra:Record<string,unknown>={}){
  current();const controller=new AbortController();let cancel:(()=>void)|undefined,closed=false;
  let rejectWait!:(error:AutomaticPaymentRefusal)=>void;
  const deadline=new Promise<never>((_,reject)=>{rejectWait=reject;});
  const stop=()=>{controller.abort();cancel?.();rejectWait(new AutomaticPaymentRefusal('AUTHORITY_UNAVAILABLE'));};
  const timer=setTimeout(stop,15000),end=performance.now()+15000;signal.addEventListener('abort',stop,{once:true});
  const check=()=>{current();requirePayment(!closed&&!controller.signal.aborted&&performance.now()<end,'AUTHORITY_UNAVAILABLE');};
  try{return await Promise.race([(async()=>{const response=await dispatch(operation,{programId:program.programId,...extra},controller.signal);
   const raw=await readCheckoutResponseBody(response,check,fn=>{cancel=fn;},65536);check();
   const e=record(raw,response.status===200?['version','data']:['version','error']);requirePayment(e.version===OWNER_APP_PROGRAM_VERSION,'PROGRAM_RESPONSE_INVALID');
   if(response.status!==200){const error=record(e.error,['code','retryAuthorized']);requirePayment(typeof error.code==='string'&&STATUSES[error.code]===response.status&&error.retryAuthorized===false,'PROGRAM_RESPONSE_INVALID');throw new AutomaticPaymentRefusal(error.code as string);}
   return e.data;})(),deadline]);}finally{closed=true;clearTimeout(timer);signal.removeEventListener('abort',stop);controller.abort();cancel?.();}
 }
 async function entry(inputDigest:string){return parseProgramEntry(await data('entry',{inputDigest}),program,inputDigest);}
 return Object.freeze({session,current,entry,
  async status(){const value=parseOwnerAppProgram(await data('status'));requirePayment(value.programDigest===program.programDigest&&equal(value.scope,program.scope)
   &&value.appOrigin===program.appOrigin&&value.approvedAtMs===program.approvedAtMs,'PROGRAM_CHANGED');return value;},
  async readiness(){return parseHostedBuyerReadiness(await data('readiness'));},
  transport(inputDigest:string,guard:(operation:string,body:Record<string,unknown>)=>void):typeof fetch{
   return (url,init)=>{
    const u=new URL(String(url),ORIGIN),op=u.pathname.split('/').at(-1)!;
    requirePayment(u.origin===ORIGIN&&!u.search&&!u.hash&&!u.username&&!u.password&&u.pathname==='/v0/market/checkout/'+op
     &&['begin','read','claimForWallet','submit','recover'].includes(op)&&init?.method==='POST'&&typeof init.body==='string'&&init.signal instanceof AbortSignal,'OPERATION_REFUSED');
    const body=JSON.parse(init!.body as string);guard(op,body);
    return dispatch(op as typeof OPERATIONS[number],{programId:program.programId,inputDigest,...body},init!.signal as AbortSignal);
   };
  },
 });
}
