import {createHostedBuyerAdapter as wireOnboarding, type HostedBuyerAdapter} from './customer-hosted/hosted-onboarding-interface';
import {createAuthenticatedBuyerConsentAdapter as wireConsent, type BuyerConsentAdapter, type BuyerConsentSession} from './customer-hosted/invitedBuyerConsent';

function accountTransport(paths:readonly string[], supplied:typeof fetch):typeof fetch {
  const origin='https://voidly.ai',allowed=new Set(paths);
  if(typeof supplied!=='function')throw new TypeError('CUSTOMER_TRANSPORT_REQUIRED');
  return (input,init)=>{
    const url=new URL(String(input),origin);
    if(url.origin!==origin||url.search||url.hash||url.username||url.password||!allowed.has(url.pathname)
      ||init?.method!=='POST'||typeof init.body!=='string')throw new TypeError('CUSTOMER_OPERATION_REFUSED');
    const headers=new Headers(init.headers);headers.set('origin',origin);headers.set('accept-encoding','identity');
    return supplied(url.href,{...init,headers,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer'});
  };
}
export function createHostedBuyerAdapter(session:BuyerConsentSession, transport:typeof fetch=globalThis.fetch.bind(globalThis)):HostedBuyerAdapter {
  return wireOnboarding(session,accountTransport(['begin','read','readiness'].map(name=>'/v0/market/buyer-onboarding/'+name),transport));
}
export function createAuthenticatedBuyerConsentAdapter(session:BuyerConsentSession, transport:typeof fetch=globalThis.fetch.bind(globalThis)):BuyerConsentAdapter {
  return wireConsent(session,accountTransport(['reviewScope','approveScope','readScope','reviewRenewal','approveRenewal','readRenewal'].map(name=>'/v0/market/buyer-consent/'+name),transport));
}
export { createCustomerHostedJobs, type AutomaticHostedJobPolicy, type CustomerHostedJobs, type CustomerHostedJobOutcome, type CustomerHostedJobRecovery } from './customer-hosted/hosted-automatic-jobs';
export { HostedBuyerError, type HostedBuyerAdapter, type HostedBuyerReadiness, type HostedBuyerSetup, type HostedBuyerBegin } from './customer-hosted/hosted-onboarding-interface';
export type { BuyerConsentAdapter, BuyerConsentReview, BuyerConsentSnapshot, BuyerConsentSession } from './customer-hosted/invitedBuyerConsent';
export { AutomaticPaymentRefusal } from './customer-hosted/sqlite-budget';
export type { CheckoutSession } from './customer-hosted/invitedCheckoutTransport';
export type { Eip1193Provider } from './customer-hosted/original-payment-wallet';
