import { createHash } from 'node:crypto';
import { createAuthenticatedBuyerConsentAdapter, type BuyerConsentSnapshot } from './invitedBuyerConsent';
import { createInvitedCheckoutTransport, type CheckoutSession, type CheckoutView } from './invitedCheckoutTransport';
import { canSubmitOriginalPayment, planOriginalPaymentTiming } from './originalPaymentTiming';
import { canonical, equal, id, amount, integer, snapshot, parseMonetaryOriginal, type MonetaryOriginal } from './monetaryProtocol';
import { decodeMonetaryWalletClaim, decodeRetainedMonetaryWalletClaim } from './monetaryDecoders';
import { createOriginalPaymentWalletAdapter, type Eip1193Provider } from './original-payment-wallet';
import { AutomaticPaymentRefusal, openAutomaticBudget, requirePayment } from './sqlite-budget';

export type HostedAutomaticPolicy = Readonly<{
  version: 'voidpay.hosted-customer-automatic-payment.v1'; id: string;
  notBeforeMs: number; expiresAtMs: number; maxTotalAtoms: string; maxPerJobAtoms: string;
  approved: readonly BuyerConsentSnapshot[];
}>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const reviewRef = (s: BuyerConsentSnapshot) => ({ reviewId: s.review.reviewId, reviewDigest: s.reviewDigest });
const ORIGIN = 'https://voidly.ai';

export function createHostedCustomerAutomaticPayments(options: Readonly<{
  directory: string; policy: HostedAutomaticPolicy; session: CheckoutSession;
  provider: Eip1193Provider; fetch?: typeof fetch; signingTimeoutMs?: number;
}>) {
  const p = snapshot(options.policy, 524288) as HostedAutomaticPolicy;
  requirePayment(p.version === 'voidpay.hosted-customer-automatic-payment.v1' && Array.isArray(p.approved)
    && p.approved.length > 0 && p.approved.length <= 32, 'INVALID_POLICY');
  id(p.id); integer(p.notBeforeMs); integer(p.expiresAtMs); amount(p.maxTotalAtoms); amount(p.maxPerJobAtoms);
  requirePayment(p.notBeforeMs < p.expiresAtMs && BigInt(p.maxPerJobAtoms) <= BigInt(p.maxTotalAtoms), 'INVALID_POLICY');
  const approved = new Map<string, BuyerConsentSnapshot>();
  for (const s of p.approved) {
    const r = s.review, b = r.budget;
    requirePayment(s.approval && s.reviewDigest === hash(canonical(r)) && r.version === 'voidpay.invited-buyer-consent.v0', 'APPROVED_REVIEW_REQUIRED');
    requirePayment(!approved.has(id(r.requestId)) && p.notBeforeMs >= b.scope.notBeforeMs && p.expiresAtMs <= b.scope.expiresAtMs
      && BigInt(p.maxTotalAtoms) <= BigInt(b.maxTotal) && BigInt(p.maxPerJobAtoms) <= BigInt(b.scope.maxPerJob), 'POLICY_SCOPE_MISMATCH');
    requirePayment(equal(r.original.lineage, p.approved[0].review.original.lineage), 'POLICY_SCOPE_MISMATCH');
    approved.set(r.requestId, s);
  }
  const store = openAutomaticBudget(options.directory, { id: p.id, body: canonical(p), maxTotalAtoms: Number(p.maxTotalAtoms),
    notBeforeMs: p.notBeforeMs, expiresAtMs: p.expiresAtMs });
  try { return createHostedPaymentRunner(options, p, store, requestId => approved.get(requestId)); }
  catch (error) { store.close(); throw error; }
}

export function createHostedPaymentRunner(options: Readonly<{session:CheckoutSession;provider:Eip1193Provider;fetch?:typeof fetch;signingTimeoutMs?:number}>,
  p: Pick<HostedAutomaticPolicy,'expiresAtMs'|'maxPerJobAtoms'>, store: ReturnType<typeof openAutomaticBudget>,
  select: (requestId:string)=>BuyerConsentSnapshot|undefined) {
  const provider = options.provider, signRequest = provider?.request, fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeout = options.signingTimeoutMs ?? 10000;
  requirePayment(typeof signRequest === 'function' && typeof fetcher === 'function', 'INVALID_CONFIGURATION');
  requirePayment(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000, 'INVALID_SIGNING_TIMEOUT');
  const effectJobs = new Map<string, string>();
  const current = () => requirePayment(!options.session.signal.aborted && options.session.isCurrent(), 'AUTH_REQUIRED');
  const key = (r: {reviewId: string; reviewDigest: string}) => canonical(r);
  const transport: typeof fetch = (input, init) => {
    current();
    requirePayment(typeof input === 'string' && /^\/v0\/market\/(buyer-consent\/readScope|checkout\/(read|claimForWallet|submit|recover))$/.test(input)
      && init?.method === 'POST' && typeof init.body === 'string' && !init.signal?.aborted, 'HOSTED_OPERATION_REFUSED');
    const body = JSON.parse(String(init!.body)), op = String(input).split('/').at(-1);
    if (op === 'claimForWallet' || op === 'submit') {
      const job = effectJobs.get(key({reviewId: body.reviewId, reviewDigest: body.reviewDigest}));
      requirePayment(job && (op !== 'submit' || body.jobId === job), 'ORIGINAL_REQUIRED');
      store.assertStage(job!, op === 'submit' ? 'submit_intent' : 'claim_intent', Date.now());
    }
    const headers = new Headers(init!.headers); headers.set('origin', ORIGIN); headers.set('accept-encoding', 'identity');
    return fetcher(ORIGIN + input, { ...init, headers, redirect: 'error', credentials: 'omit' });
  };
  const consent = createAuthenticatedBuyerConsentAdapter(options.session, transport);
  const checkout = createInvitedCheckoutTransport(options.session, transport);
  const unknown = (jobId: string) => Object.freeze({ kind: 'recover-original' as const, jobId,
    stage: store.attempt(jobId)?.stage ?? 'unknown', reason: 'ORIGINAL_UNCONFIRMED' });
  function bind(original: MonetaryOriginal, s: BuyerConsentSnapshot, view: CheckoutView) {
    const a = original.approval, o = s.review.original, permission = s.review.allowance.scope.services[0];
    requirePayment(equal(a.lineage, o.lineage) && equal(a.service, o.service) && equal(a.selection.service, o.service)
      && a.grantId === o.grantId && a.workPolicyId === o.policyId && a.supplierManifestDigest === o.supplierManifestDigest && a.providerDid === o.providerDid
      && a.selection.inputHandle === o.inputHandle && a.selection.inputDigest === o.inputDigest && a.selection.inputByteLength === o.inputByteLength
      && a.selection.expiresAtMs === o.expiresAtMs && a.expiresAtMs === o.expiresAtMs && a.notBeforeMs === o.notBeforeMs && a.maxDurationMs === o.maxDurationMs
      && a.minimumOriginalMs >= o.requiredRemainingMs && a.minimumOriginalMs <= o.maxDurationMs && a.terms.profileDigest === o.lineage.profileDigest
      && a.terms.receivingDigest === o.receivingDigest && a.terms.payerAccount === o.lineage.payerAccount && a.terms.payeeAccount === permission.recipient
      && a.terms.amountAtoms === o.amountAtoms && original.prepared.jobId === view.jobId && original.quoted.quote.expiresAtMs === view.expiresAtMs
      && original.quoted.quote.workNotAfterMs <= p.expiresAtMs, 'ORIGINAL_MISMATCH');
    requirePayment(a.selection.disclosureDigest === hash(JSON.stringify(['voidpay.monetary-selected-disclosure.v0', o.disclosure, o.providerDid, o.sessionServiceRef,
      [o.service.providerId, o.service.serviceId, o.service.version, o.service.definitionDigest], o.inputDigest, o.inputByteLength, o.authorizationRef])), 'DISCLOSURE_MISMATCH');
  }
  return Object.freeze({
    async payApproved(reviewRequestId: string) {
      let jobId: string | undefined, reserved = false;
      try {
        const selected = select(id(reviewRequestId)); requirePayment(selected, 'OWNER_REVIEW_REQUIRED'); current();
        const s = await consent.readScope({ requestId: selected!.review.requestId }); current();
        requirePayment(s && equal(s, selected), 'REVIEW_CHANGED');
        const ref = reviewRef(selected!), view = await checkout.read(ref); current();
        requirePayment(view?.jobId && view.expiresAtMs !== null && view.amountAtoms === selected!.review.original.amountAtoms
          && BigInt(view.amountAtoms) <= BigInt(p.maxPerJobAtoms), 'PREPARED_ORIGINAL_REQUIRED');
        jobId = view!.jobId!;
        const prior = store.attempt(jobId);
        if (prior) {
          const old = JSON.parse(prior.original);
          requirePayment(equal(old.snapshot, selected) && old.view.checkoutId === view!.checkoutId
            && old.view.expiresAtMs === view!.expiresAtMs && old.view.amountAtoms === view!.amountAtoms, 'ORIGINAL_CHANGED');
          return unknown(jobId);
        }
        requirePayment(view!.phase === 'wallet-ready', 'PREPARED_ORIGINAL_REQUIRED');
        const retained = canonical({ snapshot: selected, view }), fresh = store.reserve({ jobId, original: retained, originalDigest: hash(retained),
          amountAtoms: Number(view!.amountAtoms), stage: 'claim_intent', claim: null, effectNotAfterMs: view!.expiresAtMs! }, Date.now());
        reserved = true; if (!fresh) return unknown(jobId);
        effectJobs.set(key(ref), jobId);
        const raw = await checkout.claimForWallet(ref); current();
        const original = parseMonetaryOriginal(raw.original); bind(original, selected!, view!);
        const claim = await decodeMonetaryWalletClaim(raw.claim, original); current();
        requirePayment(claim.kind === 'original-wallet-request', 'ORIGINAL_REQUIRED');
        if (claim.kind !== 'original-wallet-request') return unknown(jobId);
        store.claim(jobId, canonical({ original, claim }), claim.disclosureNotAfterMs, Date.now());
        const selectedJob = jobId;
        const guarded: Eip1193Provider = { request(r) {
          current(); requirePayment(provider.request === signRequest, 'CUSTOMER_SIGNER_CHANGED');
          if (r.method === 'eth_signTypedData_v4') {
            requirePayment(equal(r, claim.request), 'EXACT_SIGN_REQUEST_REQUIRED');
            const timing = planOriginalPaymentTiming({ nowMs: Date.now(), workNotAfterMs: original.quoted.quote.workNotAfterMs,
              requiredRemainingMs: original.approval.minimumOriginalMs, disclosureNotAfterMs: claim.disclosureNotAfterMs });
            requirePayment(timing.kind === 'ready' && timing.promptNotAfterMs === raw.timing.promptNotAfterMs
              && timing.signatureNotAfterMs === raw.timing.signatureNotAfterMs && timing.submitNotAfterMs === raw.timing.submitNotAfterMs, 'SIGNATURE_EXPIRED');
            store.signing(selectedJob, canonical([claim.typedData.domain, claim.typedData.message.from, claim.typedData.message.nonce]), Date.now());
          } else requirePayment(r.method === 'eth_accounts' || r.method === 'eth_chainId', 'SIGNER_METHOD_REFUSED');
          return signRequest.call(provider, r);
        } };
        const signed = await createOriginalPaymentWalletAdapter({ provider: guarded, timeoutMs: timeout }).signOriginal({
          context: claim.context, originalId: jobId, grant: claim.grant, amount: claim.amount }); current();
        if (signed.status !== 'signed') return unknown(jobId);
        await decodeRetainedMonetaryWalletClaim(claim, original); current();
        const a = signed.authorization;
        requirePayment(a.requestFingerprint === claim.requestFingerprint && a.typedDataFingerprint === claim.typedDataFingerprint
          && equal(a.request, claim.request) && canSubmitOriginalPayment({ nowMs: Date.now(), workNotAfterMs: original.quoted.quote.workNotAfterMs,
            requiredRemainingMs: original.approval.minimumOriginalMs }), 'SIGNED_ORIGINAL_MISMATCH');
        store.submitting(jobId, Date.now());
        const submission = await checkout.submit({ ...ref, jobId, signature: a.signature }); current(); store.submitted(jobId);
        return Object.freeze({ kind: 'submitted' as const, jobId, payment: 'unconfirmed' as const, submission });
      } catch (e) { return reserved && jobId ? unknown(jobId) : Object.freeze({ kind: 'refused' as const,
        reason: e instanceof AutomaticPaymentRefusal ? e.code : 'ORIGINAL_UNCONFIRMED' }); }
    },
    async recover(reviewRequestId: string) {
      const s = select(id(reviewRequestId)); requirePayment(s, 'OWNER_REVIEW_REQUIRED');
      const ref = reviewRef(s!), view = await checkout.read(ref); current();
      requirePayment(view?.jobId, 'ORIGINAL_REQUIRED');
      const row = store.attempt(view!.jobId!); requirePayment(row && equal(JSON.parse(row.original).snapshot, s), 'ORIGINAL_REQUIRED');
      const old = JSON.parse(row!.original).view as CheckoutView;
      requirePayment(old.checkoutId === view!.checkoutId && old.expiresAtMs === view!.expiresAtMs && old.amountAtoms === view!.amountAtoms, 'ORIGINAL_CHANGED');
      return checkout.recover(ref);
    },
    status: store.status, revoke: store.revoke, close: store.close,
  });
}
