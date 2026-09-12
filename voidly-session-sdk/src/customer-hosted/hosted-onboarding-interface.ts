import type {BuyerConsentSession, BuyerConsentServiceRef} from './invitedBuyerConsent'

export const HOSTED_BUYER_VERSION = 'voidpay.hosted-buyer-onboarding.v1' as const
export const HOSTED_BUYER_READINESS_VERSION = 'voidpay.hosted-buyer-readiness.v1' as const
const BASE = 'eip155:8453' as const
const USDC = 'erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const
const MAX_BYTES = 65536, TIMEOUT_MS = 15000
export class HostedBuyerError extends Error {
  constructor(readonly code:string, readonly status?:number) { super(code); this.name='HostedBuyerError' }
}
export type HostedBuyerSetup = Readonly<{
  version:typeof HOSTED_BUYER_VERSION;permissionId:string;configurationDigest:string;requestDigest:string;
  payerAccount:string;service:BuyerConsentServiceRef;maxPerJobAtoms:string;maxTotalAtoms:string;
  maxActiveJobs:number;notBeforeMs:number;expiresAtMs:number;
  walletControlVerified:false;paymentAuthorityGranted:false;checkoutReady:false;
}>
type ReadinessTerms = Readonly<{
  service:BuyerConsentServiceRef;chain:typeof BASE;asset:typeof USDC;maxPerJobAtoms:string;maxTotalAtoms:string;
  maxActiveJobs:number;notBeforeMs:number;expiresAtMs:number;walletControlVerified:false;
  unattendedPayments:false;authorization:'wallet-per-job';
}>
export type HostedBuyerReadiness = ReadinessTerms & (
  Readonly<{kind:'setup-required';checkoutReady:false}> |
  Readonly<{kind:'checkout-ready';checkoutReady:true;permissionId:string;configurationDigest:string;payerAccount:string}>
)
export type HostedBuyerBegin = Readonly<{requestId:string;payerAccount:string;definitionDigest:string}>
export interface HostedBuyerAdapter {
  readiness():Promise<HostedBuyerReadiness>
  read():Promise<HostedBuyerSetup|null>
  begin(input:HostedBuyerBegin):Promise<HostedBuyerSetup>
}
const fail=(code='INVALID_RESPONSE'):never=>{throw new HostedBuyerError(code)}
function record(value:unknown, fields:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail()
  const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds)
  if(keys.length!==fields.length||keys.some(k=>typeof k!=='string'||!fields.includes(k)||!ds[k].enumerable||!('value'in ds[k])))return fail()
  return Object.fromEntries(fields.map(k=>[k,ds[k].value]))
}
const id=(v:unknown):string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)?v:fail()
const digest=(v:unknown):string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)?v:fail()
const integer=(v:unknown,min=0,max=8640000000000000):number=>typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0)&&v>=min&&v<=max?v:fail()
const atoms=(v:unknown):string=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v)&&BigInt(v)<=BigInt("9007199254740991")?v:fail()
export const hostedPayer=(v:unknown):string=>typeof v==='string'&&/^eip155:8453:0x[0-9a-f]{40}$/.test(v)&&!/^eip155:8453:0x0{40}$/.test(v)?v:fail()
export function parseBuyerService(value:unknown):BuyerConsentServiceRef {
  const r=record(value,['providerId','serviceId','version','definitionDigest'])
  return Object.freeze({providerId:id(r.providerId),serviceId:id(r.serviceId),version:id(r.version),definitionDigest:digest(r.definitionDigest)})
}
export function sameBuyerService(a:BuyerConsentServiceRef,b:BuyerConsentServiceRef):boolean {
  return a.providerId===b.providerId&&a.serviceId===b.serviceId&&a.version===b.version&&a.definitionDigest===b.definitionDigest
}
function limits(r:Record<string,unknown>) {
  const maxPerJobAtoms=atoms(r.maxPerJobAtoms),maxTotalAtoms=atoms(r.maxTotalAtoms),notBeforeMs=integer(r.notBeforeMs),expiresAtMs=integer(r.expiresAtMs)
  if(BigInt(maxPerJobAtoms)>BigInt(maxTotalAtoms)||expiresAtMs<=notBeforeMs)return fail()
  return {service:parseBuyerService(r.service),maxPerJobAtoms,maxTotalAtoms,maxActiveJobs:integer(r.maxActiveJobs,1,32),notBeforeMs,expiresAtMs}
}
export function parseHostedBuyerSetup(value:unknown):HostedBuyerSetup {
  const r=record(value,['version','permissionId','configurationDigest','requestDigest','payerAccount','service','maxPerJobAtoms','maxTotalAtoms','maxActiveJobs','notBeforeMs','expiresAtMs','walletControlVerified','paymentAuthorityGranted','checkoutReady'])
  if(r.version!==HOSTED_BUYER_VERSION||r.walletControlVerified!==false||r.paymentAuthorityGranted!==false||r.checkoutReady!==false)return fail()
  return Object.freeze({version:HOSTED_BUYER_VERSION,permissionId:id(r.permissionId),configurationDigest:digest(r.configurationDigest),requestDigest:digest(r.requestDigest),payerAccount:hostedPayer(r.payerAccount),...limits(r),walletControlVerified:false,paymentAuthorityGranted:false,checkoutReady:false})
}
export function parseHostedBuyerReadiness(value:unknown):HostedBuyerReadiness {
  const kind=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'kind'):undefined
  if(!kind||!('value'in kind)||!['setup-required','checkout-ready'].includes(kind.value))return fail()
  const ready=kind.value==='checkout-ready'
  const r=record(value,['kind','service','chain','asset','maxPerJobAtoms','maxTotalAtoms','maxActiveJobs','notBeforeMs','expiresAtMs','checkoutReady','walletControlVerified','unattendedPayments','authorization',...(ready?['permissionId','configurationDigest','payerAccount']:[])])
  if(r.chain!==BASE||r.asset!==USDC||r.checkoutReady!==ready||r.walletControlVerified!==false||r.unattendedPayments!==false||r.authorization!=='wallet-per-job')return fail()
  const shared={...limits(r),chain:BASE,asset:USDC,walletControlVerified:false as const,unattendedPayments:false as const,authorization:'wallet-per-job' as const}
  return ready?Object.freeze({...shared,kind:'checkout-ready',checkoutReady:true,permissionId:id(r.permissionId),configurationDigest:digest(r.configurationDigest),payerAccount:hostedPayer(r.payerAccount)}):Object.freeze({...shared,kind:'setup-required',checkoutReady:false})
}
export function parseHostedBuyerBegin(value:unknown):HostedBuyerBegin {
  const r=record(value,['requestId','payerAccount','definitionDigest'])
  return Object.freeze({requestId:id(r.requestId),payerAccount:hostedPayer(r.payerAccount),definitionDigest:digest(r.definitionDigest)})
}
export function createHostedBuyerAdapter(value:BuyerConsentSession, transport:typeof fetch=globalThis.fetch.bind(globalThis)):HostedBuyerAdapter {
  if(typeof transport!=='function')return fail('INVALID_CONFIGURATION')
  const r=record(value,['accessToken','isCurrent','signal'])
  if(typeof r.accessToken!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(r.accessToken)||typeof r.isCurrent!=='function'||!(r.signal instanceof AbortSignal))return fail('INVALID_CONFIGURATION')
  const token=r.accessToken,signal=r.signal,isCurrent=r.isCurrent as ()=>boolean,fetcher=transport
  async function call(operation:'begin'|'read'|'readiness',body:HostedBuyerBegin|Record<string,never>) {
    const active=()=>!signal.aborted&&isCurrent(),controller=new AbortController(),end=performance.now()+TIMEOUT_MS
    const failure=()=>new HostedBuyerError(operation==='begin'?'OUTCOME_UNKNOWN':'UNAVAILABLE')
    let closed=false,sent=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined,timer:ReturnType<typeof setTimeout>|undefined
    let reject!:(e:Error)=>void
    const deadline=new Promise<never>((_,r)=>{reject=r;timer=setTimeout(()=>{controller.abort();r(failure())},TIMEOUT_MS)})
    const changed=()=>{controller.abort();reject(sent?failure():new HostedBuyerError('AUTH_REQUIRED'))}
    signal.addEventListener('abort',changed,{once:true})
    const check=()=>{if(closed||controller.signal.aborted||performance.now()>=end)throw failure();if(!active())throw new HostedBuyerError('AUTH_REQUIRED')}
    try{return await Promise.race([deadline,(async()=>{
      check();sent=true
      response=await fetcher('/v0/market/buyer-onboarding/'+operation,{method:'POST',mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','X-Voidpay-Buyer-Consent':'1',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:controller.signal})
      try{check()}catch(e){void response.body?.cancel().catch(()=>{});throw e}
      if(response.redirected||response.type==='opaqueredirect'||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||!response.body)throw failure()
      const length=response.headers.get('content-length');if(length!==null&&(!/^\d{1,20}$/.test(length)||Number(length)>MAX_BYTES))throw failure()
      reader=response.body.getReader();const bytes=new Uint8Array(MAX_BYTES);let size=0
      for(;;){const part=await reader.read();check();if(part.done)break;if(!part.value.byteLength||part.value.byteLength>MAX_BYTES-size)throw failure();bytes.set(part.value,size);size+=part.value.byteLength}
      if(length!==null&&!response.headers.has('content-encoding')&&Number(length)!==size)throw failure()
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,size));bytes.fill(0)
      if(text.includes(token))throw failure();const raw=JSON.parse(text);if(JSON.stringify(raw)!==text)throw failure()
      const version=operation==='readiness'?HOSTED_BUYER_READINESS_VERSION:HOSTED_BUYER_VERSION
      if(response.status!==200){const envelope=record(raw,['version','error']);if(envelope.version!==version)throw failure();const e=record(envelope.error,Object.hasOwn(envelope.error as object,'recovery')?['code','recovery']:['code'])
        const codes:Record<string,number>={INVALID_INPUT:400,INVALID_CONFIGURATION:400,AUTH_REQUIRED:401,FORBIDDEN:403,NOT_FOUND:404,METHOD_NOT_ALLOWED:405,TIMEOUT:408,AUTHORITY_CONFLICT:409,AUTHORITY_UNAVAILABLE:503,OUTCOME_UNKNOWN:503}
        if(typeof e.code!=='string'||codes[e.code]!==response.status||e.recovery!==undefined&&e.recovery!=='read-original-onboarding')throw failure()
        throw new HostedBuyerError(e.code,response.status)
      }
      const envelope=record(raw,['version','data']);if(envelope.version!==version)throw failure()
      const result=operation==='readiness'?parseHostedBuyerReadiness(envelope.data):envelope.data===null&&operation==='read'?null:parseHostedBuyerSetup(envelope.data)
      if(operation==='begin'&&(!result||!('payerAccount'in result)||result.payerAccount!==(body as HostedBuyerBegin).payerAccount||result.service.definitionDigest!==(body as HostedBuyerBegin).definitionDigest))throw failure()
      check();return result
    })()])}catch(error){if(error instanceof HostedBuyerError)throw error;throw failure()}
    finally{closed=true;clearTimeout(timer);controller.abort();signal.removeEventListener('abort',changed);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}else void response?.body?.cancel().catch(()=>{})}
  }
  return Object.freeze({readiness:async()=>await call('readiness',{}) as HostedBuyerReadiness,read:async()=>await call('read',{}) as HostedBuyerSetup|null,begin:async(input:HostedBuyerBegin)=>await call('begin',parseHostedBuyerBegin(input)) as HostedBuyerSetup})
}
