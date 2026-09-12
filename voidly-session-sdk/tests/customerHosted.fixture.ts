// Synthetic public test-only wallet; no network or chain action.
import { Wallet } from 'ethers';
import { hashText } from '../src/customer-hosted/protocol';
import { decodeMonetaryWalletClaim } from '../src/customer-hosted/monetaryDecoders';
import { canonical, type MonetaryOriginal } from '../src/customer-hosted/monetaryProtocol';
import { createPaymentContext } from '../src/paymentContext';
import { planOriginalPaymentTiming } from '../src/customer-hosted/originalPaymentTiming';
import type { BuyerConsentSnapshot, BuyerConsentScope } from '../src/customer-hosted/invitedBuyerConsent';
import type { CheckoutView } from '../src/customer-hosted/invitedCheckoutTransport';
export const testPayer = new Wallet('0x' + '11'.repeat(32));
const ADDRESS = testPayer.address.toLowerCase(), NOW = Date.now(), TEXT = 'sku,title\n1,Widget';
export async function hostedMaterial(reviewId = 'review-a', requestId = 'review-request-a', jobId = 'job-a', maxActiveJobs = 1) {
  const context = { tenantId: 'tenant-a', subjectId: 'builder-a', appId: 'app-a' }
  const service = { providerId: 'provider-a', serviceId: 'catalog', version: '1', definitionDigest: '1'.repeat(64) }
  const lineage = { context, membershipId: 'member-a', budgetId: 'budget-a', budgetDigest: '2'.repeat(64), allowanceId: 'allowance-a',
    allowanceDigest: '3'.repeat(64), profileDigest: '4'.repeat(64), payerAccount: `eip155:8453:${ADDRESS}` }
  const scope: BuyerConsentScope = { version: 'voidpay.buyer-scope.v1', profileDigest: lineage.profileDigest, chain: 'eip155:8453',
    asset: 'erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payerAccount: lineage.payerAccount,
    services: [{ service, receivingDigest: '5'.repeat(64), recipient: 'eip155:8453:0x2222222222222222222222222222222222222222' }],
    maxPerJob: '50000', notBeforeMs: NOW - 10000, expiresAtMs: NOW + 86400000 }
  const originalConsent: BuyerConsentSnapshot['review']['original'] = { version: 'voidpay.monetary-original-approval.v0', lineage, service,
    receivingDigest: scope.services[0].receivingDigest, supplierManifestDigest: 'b'.repeat(64), providerDid: 'did:voidly:6rGTFa5apSnKNF14bGXZfu',
    sessionServiceRef: 'catalog-ref', inputHandle: `${reviewId}:input`, grantId: `${reviewId}:grant`, policyId: `${reviewId}:policy`,
    authorizationRef: `${reviewId}:disclosure`, approvedBy: 'human-a', inputDigest: await hashText(TEXT), inputByteLength: new TextEncoder().encode(TEXT).length,
    disclosure: 'selected-bytes-to-exact-provider-service', amountAtoms: scope.maxPerJob, notBeforeMs: scope.notBeforeMs, expiresAtMs: scope.expiresAtMs,
    maxDurationMs: 600000, requiredRemainingMs: 54000 }
  const review: BuyerConsentSnapshot['review'] = { version: 'voidpay.invited-buyer-consent.v0', reviewId, requestId, permissionId: 'invitation-a',
    configurationDigest: 'c'.repeat(64), reviewedAtMs: NOW, budget: { version: 'voidpay.buyer-budget.v1', budgetId: lineage.budgetId, context,
      membershipId: lineage.membershipId, authorizationRef: 'budget-auth', acceptedBy: 'human-a', scope, maxTotal: '500000', maxActiveJobs },
    allowance: { version: 'voidpay.buyer-allowance.v1', allowanceId: lineage.allowanceId, budgetId: lineage.budgetId, context,
      membershipId: lineage.membershipId, acceptedBy: 'human-a', scope }, original: originalConsent }
  const snapshot: BuyerConsentSnapshot = { review, reviewDigest: await hashText(canonical(review)), approval: { requestId: 'approve-a', approvedAtMs: NOW + 1 } }
  const o = originalConsent, ref = (s: typeof service) => [s.providerId, s.serviceId, s.version, s.definitionDigest]
  const terms = { version: 'voidpay.monetary-terms.v0' as const, profileDigest: lineage.profileDigest, receivingDigest: o.receivingDigest,
    payerAccount: lineage.payerAccount, payeeAccount: scope.services[0].recipient, amountAtoms: o.amountAtoms }
  const disclosureDigest = await hashText(JSON.stringify(['voidpay.monetary-selected-disclosure.v0', o.disclosure, o.providerDid, o.sessionServiceRef,
    ref(service), o.inputDigest, o.inputByteLength, o.authorizationRef]))
  const selection = { service, inputHandle: o.inputHandle, inputDigest: o.inputDigest, inputByteLength: o.inputByteLength, selectionDigest: '7'.repeat(64), disclosureDigest, expiresAtMs: o.expiresAtMs }
  const approval = { lineage, grantId: o.grantId, grantDigest: '9'.repeat(64), service, selection, terms, expiresAtMs: o.expiresAtMs, notBeforeMs: o.notBeforeMs,
    maxDurationMs: o.maxDurationMs, minimumOriginalMs: 300000, workPolicyId: o.policyId, workPolicyDigest: 'a'.repeat(64), workPolicyVersion: 1,
    supplierManifestDigest: o.supplierManifestDigest, providerDid: o.providerDid, hirerDid: 'did:voidly:mPJNnvvYiKrFuY96NeESb',
    providerSigningPublicKeyBase64: 'L16pOb+7U0Qjgs43s61D8KiLi6KRAJ1CpqszP6FzCyE=', providerEncryptionPublicKeyBase64: 'BC4/bHqUQHnwt593WsVhgz1loPpUyESJV/Oy6SU5h1k=' }
  const quote = { version: 'voidpay.market.v1' as const, mode: 'monetary' as const, paymentRequired: true as const, quoteId: 'quote-a', lineage,
    grantId: approval.grantId, grantDigest: approval.grantDigest, service, selection, terms, termsDigest: await hashText(JSON.stringify(Object.values(terms))),
    issuedAtMs: NOW - 1000, expiresAtMs: NOW + 50000, workNotAfterMs: NOW + 599000, workPolicyId: approval.workPolicyId,
    workPolicyDigest: approval.workPolicyDigest, workPolicyVersion: 1, authenticity: 'receiver-assertion' as const }
  const quoteDigest = await hashText(JSON.stringify(['voidpay.market.quote', quote.version, quote.mode, true, quote.quoteId,
    [[context.tenantId, context.subjectId, context.appId], lineage.membershipId, lineage.budgetId, lineage.budgetDigest, lineage.allowanceId,
      lineage.allowanceDigest, lineage.profileDigest, lineage.payerAccount], quote.grantId, quote.grantDigest, ref(service),
    [ref(service), selection.inputHandle, selection.inputDigest, selection.inputByteLength, selection.selectionDigest, selection.disclosureDigest, selection.expiresAtMs],
    Object.values(terms), quote.termsDigest, quote.issuedAtMs, quote.expiresAtMs, quote.workNotAfterMs, quote.workPolicyId, quote.workPolicyDigest, quote.workPolicyVersion, quote.authenticity]))
  const original: MonetaryOriginal = { approval, quoted: { quote, quoteDigest }, prepared: { kind: 'original-prepared-monetary-job', jobId,
    receipt: { purchaseId: jobId, preparedDigest: 'c'.repeat(64), supplierManifestDigest: o.supplierManifestDigest } } }
  const grant = { schema: 'voidly-task-grant/v1', hirer_did: approval.hirerDid, provider_did: approval.providerDid,
    provider_signing_pubkey_base64: approval.providerSigningPublicKeyBase64, provider_enc_pubkey_base64: approval.providerEncryptionPublicKeyBase64,
    offer_hash: 'aa'.repeat(32), capsule_hash: 'bb'.repeat(32), brief_commitment: 'cc'.repeat(32), price_chain: 'eip155:8453',
    price_asset: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price_payer_account: terms.payerAccount, price_payee_account: terms.payeeAccount,
    price_min_amount: terms.amountAtoms, price_max_amount: terms.amountAtoms, nonce: ('nonce-' + jobId).padEnd(24, '0'), issued_at: new Date(NOW).toISOString(), expires_at: new Date(quote.workNotAfterMs).toISOString() }
  const created = await createPaymentContext({ grant, amount: terms.amountAtoms, entryPoint: 'receive_with_authorization' })
  if (!created.ok) throw new Error(created.reason)
  // The SDK canonical encoder orders this known JSON fixture exactly like the server wire form.
  const grantHash = created.context.grantHash, typedData = JSON.parse(canonical(created.context.typedData)) as typeof created.context.typedData, request = { method: 'eth_signTypedData_v4', params: [ADDRESS, JSON.stringify(typedData)] }
  const claim = await decodeMonetaryWalletClaim({ kind: 'original-wallet-request', claimId: 'claim-a', jobId, context, originalId: jobId, grant,
    amount: terms.amountAtoms, grantHash, typedData, request, typedDataFingerprint: await hashText(request.params[1]),
    requestFingerprint: await hashText(JSON.stringify({ version: 'voidpay.original-wallet-sign.v0', context, originalId: jobId, grantHash, amount: terms.amountAtoms, request })),
    claimedAtMs: NOW, disclosureNotAfterMs: NOW + 49000 }, original)
  const timing = planOriginalPaymentTiming({ nowMs: NOW, workNotAfterMs: quote.workNotAfterMs, requiredRemainingMs: approval.minimumOriginalMs, disclosureNotAfterMs: NOW + 49000 })
  if (timing.kind !== 'ready' || claim.kind !== 'original-wallet-request') throw new Error('Fixture invalid')
  const signing = { original, claim, timing }
  const view: CheckoutView = { kind: 'invited-checkout', checkoutId: `checkout-${jobId}`, reviewId, reviewDigest: snapshot.reviewDigest, phase: 'wallet-ready',
    jobId, amountAtoms: '50000', expiresAtMs: quote.expiresAtMs, recovery: 'original-only' }
  return { snapshot, signing, view, selection: { reviewId, reviewDigest: snapshot.reviewDigest, selectedText: TEXT } }
}

/** A structurally checked server report for local recovery tests, not actual
 * settlement or an independently authenticated provider receipt. */
export async function completedHostedHistory(m:Awaited<ReturnType<typeof hostedMaterial>>){
  const o=m.signing.original,c=m.signing.claim;if(c.kind!=='original-wallet-request')throw Error('fixture claim');
  const now=Date.now(),jobId=o.prepared.jobId,tx='0x'+await hashText(jobId),text='Cleaned fixture catalog',outHash=await hashText(text);
  const anchor={purchaseId:jobId,preparedDigest:o.prepared.receipt.preparedDigest,supplierManifestDigest:o.approval.supplierManifestDigest,
    owner:o.approval.lineage.context,intentId:'intent-'+jobId,quoteDigest:o.quoted.quoteDigest,grantHash:c.grantHash,termsDigest:o.quoted.quote.termsDigest};
  const receipt={schema:'voidly-task-delivery/v1',grant_hash:c.grantHash,offer_hash:c.grant.offer_hash,provider_did:o.approval.providerDid,
    result_capsule_hash:'b'.repeat(64),result_commitment:'c'.repeat(64),issued_at:new Date(now).toISOString(),recoverable_until:new Date(now+86400000).toISOString()};
  const delivery={receipt,signatureBase64:Buffer.alloc(64).toString('base64')},amountAtoms=o.approval.terms.amountAtoms,payer=c.typedData.message.from,payee=c.typedData.message.to;
  return{kind:'original-monetary-recovery',jobId,
    settlement:{kind:'original-settlement-accounted',jobId,settlementId:'c'.repeat(64),claimId:c.claimId,exposureId:'exposure-'+jobId,
      tx,authLogIndex:1,transferLogIndex:2,amountAtoms,recordedAtMs:now,evidenceDigest:'d'.repeat(64),evidence:{ok:true,tx,grantHash:c.grantHash,
        nonce:c.typedData.message.nonce,authorizer:payer,payer,payee,value:amountAtoms,authLogIndex:1,transferLogIndex:2,blockNumber:123,confirmations:12,
        assurance:{level:'rpc-quorum-inclusion',confirmationBasis:'lowest-latest-head',safe:'not-checked',finalized:'not-checked',requiredConfirmations:12},
        chain:'0x2105',terms:{source:'grant',expiresAt:c.grant.expires_at,band:{min:amountAtoms,max:amountAtoms}},rpcHosts:['one.example','two.example'],unpinnedHosts:[],unpinned:false,headOperators:2,headFrom:'one.example'}},
    delivery:{kind:'original-delivery-recorded',jobId,claimId:c.claimId,exposureId:'exposure-'+jobId,preparedDigest:anchor.preparedDigest,
      receiptDigest:await hashText(canonical(receipt)),delivery,recordedAtMs:now,output:{digest:outHash,byteLength:new TextEncoder().encode(text).length,recordedAtMs:now}},
    result:{version:'voidpay.monetary-result-recovery.v0',kind:'opened',original:anchor,delivery,result:text,outputDigest:outHash,
      outputByteLength:new TextEncoder().encode(text).length,settlementCandidate:{tx,source:'rail-recovery'}}};
}
