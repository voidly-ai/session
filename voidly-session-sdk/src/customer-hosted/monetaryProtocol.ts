import { parseContext, parseServiceRef, type AuthContext, type ServiceRef } from './protocol';
export const MONETARY_RECEIVER_VERSION = 'voidpay.monetary-receiver.v0' as const;
export const MONETARY_WORK_VERSION = 'voidpay.market.v1' as const;
export const MONETARY_ROUTE_PREFIX = '/v0/market/monetary/' as const;
export const MONETARY_MAX_RESPONSE_BYTES = 524_288;
export const MONETARY_CHAIN = 'eip155:8453' as const;
export const MONETARY_TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const MONETARY_ASSET = `${MONETARY_CHAIN}/erc20:${MONETARY_TOKEN}` as const;
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type MonetaryOperation = 'getQuote' | 'prepareJob' | 'claimWallet' | 'submitAuthorization' | 'authorizationStatus' | 'recoverJob';
export type MonetaryErrorCode = 'INVALID_INPUT' | 'INVALID_CONFIGURATION' | 'RESPONSE_INVALID' | 'TIMEOUT' | 'TRANSPORT_UNAVAILABLE' | 'OUTCOME_UNKNOWN' | 'AUTH_REQUIRED' | 'FORBIDDEN' | 'UNAVAILABLE' | 'ORIGINAL_CONFLICT';
export class MonetaryClientError extends Error {
  readonly retryable = false;
  constructor(readonly code: MonetaryErrorCode, readonly outcomeUnknown = false) { super(code); this.name = 'MonetaryClientError'; }
}
export const invalid = (): never => { throw new MonetaryClientError('INVALID_INPUT'); };
export function text(v: unknown, max = MONETARY_MAX_RESPONSE_BYTES): string {
  if (typeof v !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v) || new TextEncoder().encode(v).length > max) return invalid();
  return v;
}
export function integer(v: unknown, min = 0, max = 8_640_000_000_000_000): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Object.is(v, -0) || v < min || v > max) return invalid(); return v;
}
export function id(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)) return invalid(); return v; }
export function digest(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) return invalid(); return v; }
export function tx(v: unknown): string { if (typeof v !== 'string' || !/^0x[a-f0-9]{64}$/.test(v)) return invalid(); return v; }
export function amount(v: unknown): string { if (typeof v !== 'string' || !/^[1-9][0-9]{0,15}$/.test(v) || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)) return invalid(); return v; }
function account(v: unknown): string { if (typeof v !== 'string' || !/^eip155:8453:0x[0-9a-f]{40}$/.test(v)) return invalid(); return v; }
function did(v: unknown): string { const s = text(v, 256); if (!/^did:voidly:[A-Za-z0-9]+$/.test(s)) return invalid(); return s; }
export function base64(v: unknown, bytes: number): string {
  const s = text(v, 256); try { const b = atob(s); if (b.length !== bytes || btoa(b) !== s) return invalid(); } catch { return invalid(); } return s;
}
export function record(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== 'string' || ![...keys, ...optional].includes(k)) return invalid();
    const d = Object.getOwnPropertyDescriptor(v, k); if (!d?.enumerable || !('value' in d)) return invalid(); out[k] = d.value;
  }
  if (keys.some(k => !Object.hasOwn(out, k))) return invalid(); return out;
}
export function snapshot(v: unknown, max = MONETARY_MAX_RESPONSE_BYTES): Json {
  let nodes = 0;
  function walk(x: unknown, depth: number): Json {
    if (++nodes > 32_768 || depth > 16) return invalid();
    if (x === null || typeof x === 'boolean') return x;
    if (typeof x === 'string') return text(x, max);
    if (typeof x === 'number') return integer(x, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    if (Array.isArray(x)) {
      if (Object.getPrototypeOf(x) !== Array.prototype || x.length > 128 || Reflect.ownKeys(x).length !== x.length + 1) return invalid();
      return Object.freeze(Array.from({ length: x.length }, (_, i) => { const d = Object.getOwnPropertyDescriptor(x, String(i)); if (!d?.enumerable || !('value' in d)) return invalid(); return walk(d.value, depth + 1); }));
    }
    if (!x || typeof x !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(x))) return invalid();
    const out: Record<string, Json> = Object.create(null);
    for (const k of Reflect.ownKeys(x)) { if (typeof k !== 'string') return invalid(); text(k, 256); const d = Object.getOwnPropertyDescriptor(x, k); if (!d?.enumerable || !('value' in d)) return invalid(); out[k] = walk(d.value, depth + 1); }
    return Object.freeze(out);
  }
  const result = walk(v, 0); text(JSON.stringify(result), max); return result;
}
export function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export async function sha256(s: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text(s)))), b => b.toString(16).padStart(2, '0')).join(''); }
export type MonetaryLineage = Readonly<{ context: AuthContext; membershipId: string; budgetId: string; budgetDigest: string; allowanceId: string; allowanceDigest: string; profileDigest: string; payerAccount: string }>;
export type MonetarySelection = Readonly<{ service: ServiceRef; inputHandle: string; inputDigest: string; inputByteLength: number; selectionDigest: string; disclosureDigest: string; expiresAtMs: number }>;
export type MonetaryTerms = Readonly<{ version: 'voidpay.monetary-terms.v0'; profileDigest: string; receivingDigest: string; payerAccount: string; payeeAccount: string; amountAtoms: string }>;
export type MonetaryQuote = Readonly<{ version: typeof MONETARY_WORK_VERSION; mode: 'monetary'; paymentRequired: true; quoteId: string; lineage: MonetaryLineage; grantId: string; grantDigest: string; service: ServiceRef; selection: MonetarySelection; terms: MonetaryTerms; termsDigest: string; issuedAtMs: number; expiresAtMs: number; workNotAfterMs: number; workPolicyId: string; workPolicyDigest: string; workPolicyVersion: number; authenticity: 'receiver-assertion' }>;
export type MonetaryQuoteResponse = Readonly<{ quote: MonetaryQuote; quoteDigest: string }>;
export type MonetaryApproval = Readonly<Omit<MonetaryQuote, 'version' | 'mode' | 'paymentRequired' | 'quoteId' | 'termsDigest' | 'issuedAtMs' | 'authenticity' | 'workNotAfterMs'> & {
  notBeforeMs: number; maxDurationMs: number; minimumOriginalMs: number; supplierManifestDigest: string; providerDid: string; hirerDid: string;
  providerSigningPublicKeyBase64: string; providerEncryptionPublicKeyBase64: string;
}>;
export type MonetaryPrepared = Readonly<{ kind: 'original-prepared-monetary-job'; jobId: string; receipt: Readonly<{ purchaseId: string; preparedDigest: string; supplierManifestDigest: string }> }>;
export type MonetaryOriginal = Readonly<{ approval: MonetaryApproval; quoted: MonetaryQuoteResponse; prepared: MonetaryPrepared }>;
export type MonetaryClaimReference = Readonly<{ claimId: string; grantHash: string; offerHash: string }>;
export type MonetaryTaskGrant = Readonly<{ schema: 'voidly-task-grant/v1'; hirer_did: string; provider_did: string;
  provider_signing_pubkey_base64: string; provider_enc_pubkey_base64: string; offer_hash: string; capsule_hash: string;
  brief_commitment: string; price_chain: string; price_asset: string; price_payer_account: string; price_payee_account: string;
  price_min_amount: string; price_max_amount: string; nonce: string; issued_at: string; expires_at: string }>;
export type MonetaryReceiveTypedData = Readonly<{
  domain: Readonly<{name: 'USD Coin'; version: '2'; chainId: 8453; verifyingContract: typeof MONETARY_TOKEN}>;
  types: Readonly<{EIP712Domain: readonly Readonly<{name: string; type: string}>[]; ReceiveWithAuthorization: readonly Readonly<{name: string; type: string}>[]}>;
  primaryType: 'ReceiveWithAuthorization';
  message: Readonly<{from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string}>;
}>;
export type MonetaryWalletClaim = Readonly<{ kind: 'original-wallet-request'; claimId: string; jobId: string; context: AuthContext; originalId: string;
  grant: MonetaryTaskGrant; amount: string; grantHash: string; typedData: MonetaryReceiveTypedData;
  request: Readonly<{ method: 'eth_signTypedData_v4'; params: readonly [string, string] }>; typedDataFingerprint: string; requestFingerprint: string; claimedAtMs: number; disclosureNotAfterMs: number }>;
export type MonetaryExistingClaim = Readonly<{ kind: 'original-wallet-already-claimed'; claimId: string; jobId: string; phase: 'wallet_request_claimed'; possibleDisclosure: true; claimedAtMs: number }>;
export type MonetaryAuthorizationStatus = Readonly<{ kind: 'original-authorization-accepted'; jobId: string; claimId: string; authorizationDigest: string; preparedDigest: string; acceptedAtMs: number }> | null;
export type MonetarySubmission = Readonly<{ kind: 'provider-accepted' | 'unresolved'; jobId: string; exposureId: string; grantHash: string; payment: 'unconfirmed'; reason?: string }>
  | Readonly<{ kind: 'original-request-already-exposed'; jobId: string; exposureId: string; phase: 'exposure_claimed'; possibleExposure: true; exposedAtMs: number; payment: 'unconfirmed' }>;
export type MonetaryResultAnchor = Readonly<{ purchaseId: string; preparedDigest: string; supplierManifestDigest: string;
  owner: AuthContext; intentId: string; quoteDigest: string; grantHash: string; termsDigest: string }>;
export type MonetaryDeliveryReceipt = Readonly<{ schema: 'voidly-task-delivery/v1'; grant_hash: string; offer_hash: string;
  provider_did: string; result_capsule_hash: string; result_commitment: string; issued_at: string; recoverable_until: string }>;
export type MonetarySignedDelivery = Readonly<{ receipt: MonetaryDeliveryReceipt; signatureBase64: string }>;
export type MonetaryDeliveryHistory = Readonly<{ kind: 'original-delivery-recorded'; jobId: string; claimId: string; exposureId: string;
  preparedDigest: string; receiptDigest: string; delivery: MonetarySignedDelivery; recordedAtMs: number;
  output: Readonly<{digest: string; byteLength: number; recordedAtMs: number}> | null }>;
export type MonetaryResultObservation = Readonly<{ version: 'voidpay.monetary-result-recovery.v0';
  settlementCandidate?: Readonly<{tx: string; source: 'rail-recovery'}> }> & (
  Readonly<{ kind: 'opened'; original: MonetaryResultAnchor; delivery: MonetarySignedDelivery; result: string; outputDigest: string; outputByteLength: number }>
  | Readonly<{ kind: 'locked'; original: MonetaryResultAnchor; delivery: MonetarySignedDelivery }>
  | Readonly<{ kind: 'no-result'; original: MonetaryResultAnchor }>
  | Readonly<{ kind: 'unknown' | 'refused'; original: MonetaryResultAnchor | null; reason: string }>);
export type MonetarySettlementEvidence = Readonly<{ ok: true; tx: string; grantHash: string; nonce: string; authorizer: string;
  payer: string; payee: string; value: string; authLogIndex: number; transferLogIndex: number; blockNumber: number; confirmations: number;
  assurance: Readonly<{ level: 'rpc-quorum-inclusion'; confirmationBasis: 'lowest-latest-head'; safe: 'not-checked'; finalized: 'not-checked'; requiredConfirmations: number }>;
  chain: '0x2105'; terms: Readonly<{source: 'grant'; expiresAt: string; band: Readonly<{min: string; max: string}>}>;
  rpcHosts: readonly string[]; unpinnedHosts: readonly string[]; unpinned: false; headOperators: number; headFrom: string }>;
export type MonetarySettlementHistory = Readonly<{ kind: 'original-settlement-accounted'; jobId: string; settlementId: string;
  claimId: string; exposureId: string; tx: string; authLogIndex: number; transferLogIndex: number; amountAtoms: string;
  recordedAtMs: number; evidenceDigest: string; evidence: MonetarySettlementEvidence }>;
export type MonetaryUnverifiedSettlement = Readonly<{ version: 'voidpay.monetary-settlement.v0'; kind: 'unconfirmed' | 'unknown' | 'refused';
  original: (MonetaryResultAnchor & Readonly<{grantId: string; grantDigest: string}>) | null; candidateTx: string | null; reason: string }>;
export type MonetaryBudgetRelease = Readonly<{ kind: 'original-expired-unused-released'; jobId: string; claimId: string; releaseId: string;
  preparedDigest: string; amountAtoms: string; recordedAtMs: number; evidenceDigest: string;
  finalizedBlock: Readonly<{number: string; hash: string; timestamp: number}> }>;
export type MonetaryRecovery = Readonly<{ kind: 'original-monetary-recovery'; jobId: string;
  settlement: MonetarySettlementHistory | MonetaryUnverifiedSettlement | Readonly<{kind: 'not-checked'}>;
  delivery: MonetaryDeliveryHistory | null;
  result: MonetaryResultObservation | Readonly<{kind: 'unknown'; reason: 'ORIGINAL_UNAVAILABLE'}> | Readonly<{kind: 'not-started'; reason: 'AUTHORIZATION_EXPIRED_UNUSED'}>;
  budgetRecovery?: MonetaryBudgetRelease | Readonly<{kind: 'original-expired-unused-pending'; jobId: string; reason: string}> }>;
const quoteKeys = ['version','mode','paymentRequired','quoteId','lineage','grantId','grantDigest','service','selection','terms','termsDigest','issuedAtMs','expiresAtMs','workNotAfterMs','workPolicyId','workPolicyDigest','workPolicyVersion','authenticity'];
function lineage(v: unknown): MonetaryLineage {
  const r = record(v, ['context','membershipId','budgetId','budgetDigest','allowanceId','allowanceDigest','profileDigest','payerAccount']);
  return Object.freeze({ context: parseContext(r.context), membershipId: id(r.membershipId), budgetId: id(r.budgetId), budgetDigest: digest(r.budgetDigest), allowanceId: id(r.allowanceId), allowanceDigest: digest(r.allowanceDigest), profileDigest: digest(r.profileDigest), payerAccount: account(r.payerAccount) });
}
function selection(v: unknown): MonetarySelection {
  const r = record(v, ['service','inputHandle','inputDigest','inputByteLength','selectionDigest','disclosureDigest','expiresAtMs']);
  return Object.freeze({ service: parseServiceRef(r.service), inputHandle: id(r.inputHandle), inputDigest: digest(r.inputDigest), inputByteLength: integer(r.inputByteLength, 0, 65536), selectionDigest: digest(r.selectionDigest), disclosureDigest: digest(r.disclosureDigest), expiresAtMs: integer(r.expiresAtMs) });
}
export function parseMonetaryTerms(v: unknown): MonetaryTerms {
  const r = record(v, ['version','profileDigest','receivingDigest','payerAccount','payeeAccount','amountAtoms']); if (r.version !== 'voidpay.monetary-terms.v0') return invalid();
  return Object.freeze({ version: r.version, profileDigest: digest(r.profileDigest), receivingDigest: digest(r.receivingDigest), payerAccount: account(r.payerAccount), payeeAccount: account(r.payeeAccount), amountAtoms: amount(r.amountAtoms) });
}
export function parseMonetaryQuote(v: unknown): MonetaryQuote {
  const r = record(snapshot(v, 32768), quoteKeys);
  if (r.version !== MONETARY_WORK_VERSION || r.mode !== 'monetary' || r.paymentRequired !== true || r.authenticity !== 'receiver-assertion') return invalid();
  const q: MonetaryQuote = Object.freeze({ version: r.version, mode: r.mode, paymentRequired: true, authenticity: r.authenticity,
    quoteId: id(r.quoteId), lineage: lineage(r.lineage), grantId: id(r.grantId), grantDigest: digest(r.grantDigest), service: parseServiceRef(r.service), selection: selection(r.selection), terms: parseMonetaryTerms(r.terms), termsDigest: digest(r.termsDigest), issuedAtMs: integer(r.issuedAtMs), expiresAtMs: integer(r.expiresAtMs), workNotAfterMs: integer(r.workNotAfterMs), workPolicyId: id(r.workPolicyId), workPolicyDigest: digest(r.workPolicyDigest), workPolicyVersion: integer(r.workPolicyVersion, 1, Number.MAX_SAFE_INTEGER) });
  if (q.issuedAtMs >= q.expiresAtMs || q.expiresAtMs - q.issuedAtMs > 60000 || q.workNotAfterMs < q.expiresAtMs || q.workNotAfterMs > q.selection.expiresAtMs || !equal(q.service, q.selection.service) || q.lineage.profileDigest !== q.terms.profileDigest || q.lineage.payerAccount !== q.terms.payerAccount) return invalid();
  return q;
}
export function encodeMonetaryTerms(v: unknown): string { const t = parseMonetaryTerms(v); return JSON.stringify([t.version,t.profileDigest,t.receivingDigest,t.payerAccount,t.payeeAccount,t.amountAtoms]); }
export function encodeMonetaryQuote(v: unknown): string {
  const q = parseMonetaryQuote(v), l = q.lineage, c = l.context, s = q.selection;
  const ref = (r: ServiceRef) => [r.providerId,r.serviceId,r.version,r.definitionDigest];
  return text(JSON.stringify(['voidpay.market.quote',q.version,q.mode,q.paymentRequired,q.quoteId,[[c.tenantId,c.subjectId,c.appId],l.membershipId,l.budgetId,l.budgetDigest,l.allowanceId,l.allowanceDigest,l.profileDigest,l.payerAccount],q.grantId,q.grantDigest,ref(q.service),[ref(s.service),s.inputHandle,s.inputDigest,s.inputByteLength,s.selectionDigest,s.disclosureDigest,s.expiresAtMs],JSON.parse(encodeMonetaryTerms(q.terms)),q.termsDigest,q.issuedAtMs,q.expiresAtMs,q.workNotAfterMs,q.workPolicyId,q.workPolicyDigest,q.workPolicyVersion,q.authenticity]),32768);
}
export async function hashMonetaryQuote(v: unknown): Promise<string> { return sha256(encodeMonetaryQuote(v)); }
export function parseMonetaryApproval(v: unknown): MonetaryApproval {
  const keys = quoteKeys.filter(k => !['version','mode','paymentRequired','quoteId','termsDigest','issuedAtMs','authenticity','workNotAfterMs'].includes(k));
  const r = record(snapshot(v, 32768), [...keys,'notBeforeMs','maxDurationMs','minimumOriginalMs','supplierManifestDigest','providerDid','hirerDid','providerSigningPublicKeyBase64','providerEncryptionPublicKeyBase64']);
  const notBeforeMs = integer(r.notBeforeMs), expiresAtMs = integer(r.expiresAtMs);
  const maxDurationMs = integer(r.maxDurationMs, 54000, 600000), minimumOriginalMs = integer(r.minimumOriginalMs, 54000, maxDurationMs);
  const l = lineage(r.lineage), selected = selection(r.selection), service = parseServiceRef(r.service), terms = parseMonetaryTerms(r.terms);
  if (notBeforeMs >= Math.min(expiresAtMs, selected.expiresAtMs) || !equal(service, selected.service) ||
    l.profileDigest !== terms.profileDigest || l.payerAccount !== terms.payerAccount) return invalid();
  return Object.freeze({ lineage:l, grantId:id(r.grantId), grantDigest:digest(r.grantDigest), service, selection:selected, terms,
    expiresAtMs, notBeforeMs, maxDurationMs, minimumOriginalMs, workPolicyId:id(r.workPolicyId), workPolicyDigest:digest(r.workPolicyDigest),
    workPolicyVersion:integer(r.workPolicyVersion,1,Number.MAX_SAFE_INTEGER), supplierManifestDigest:digest(r.supplierManifestDigest),
    providerDid:did(r.providerDid), hirerDid:did(r.hirerDid), providerSigningPublicKeyBase64:base64(r.providerSigningPublicKeyBase64,32),
    providerEncryptionPublicKeyBase64:base64(r.providerEncryptionPublicKeyBase64,32) });
}
export function parseMonetaryPrepared(v: unknown): MonetaryPrepared {
  const r = record(v,['kind','jobId','receipt']), p = record(r.receipt,['purchaseId','preparedDigest','supplierManifestDigest']);
  if (r.kind !== 'original-prepared-monetary-job' || id(r.jobId) !== id(p.purchaseId)) return invalid();
  return Object.freeze({kind:r.kind,jobId:id(r.jobId),receipt:Object.freeze({purchaseId:id(p.purchaseId),preparedDigest:digest(p.preparedDigest),supplierManifestDigest:digest(p.supplierManifestDigest)})});
}
export function parseMonetaryOriginal(v: unknown): MonetaryOriginal {
  const r = record(v,['approval','quoted','prepared']), q = record(r.quoted,['quote','quoteDigest']);
  const a = parseMonetaryApproval(r.approval), quoted = Object.freeze({quote:parseMonetaryQuote(q.quote),quoteDigest:digest(q.quoteDigest)}), prepared = parseMonetaryPrepared(r.prepared);
  if (prepared.receipt.supplierManifestDigest !== a.supplierManifestDigest) return invalid();
  assertQuoteExpectation(quoted.quote,a); return Object.freeze({approval:a,quoted,prepared});
}
export function parseClaimReference(v: unknown): MonetaryClaimReference { const r = record(v,['claimId','grantHash','offerHash']); return Object.freeze({claimId:id(r.claimId),grantHash:digest(r.grantHash),offerHash:digest(r.offerHash)}); }
export function assertQuoteExpectation(q: MonetaryQuote, a: MonetaryApproval): void {
  const sameFields = ['lineage','grantId','grantDigest','service','selection','terms','workPolicyId','workPolicyDigest','workPolicyVersion'] as const;
  if (sameFields.some(k => !equal(q[k],a[k])) || q.issuedAtMs < a.notBeforeMs || q.expiresAtMs > a.expiresAtMs ||
    q.workNotAfterMs > Math.min(q.issuedAtMs + a.maxDurationMs, a.expiresAtMs, a.selection.expiresAtMs) ||
    q.workNotAfterMs - q.issuedAtMs < a.minimumOriginalMs) return invalid();
}
export async function verifyMonetaryQuote(v: unknown): Promise<MonetaryQuoteResponse> {
  const r = record(v,['quote','quoteDigest']), q = parseMonetaryQuote(r.quote), d = digest(r.quoteDigest);
  if (await sha256(encodeMonetaryTerms(q.terms)) !== q.termsDigest || await hashMonetaryQuote(q) !== d) return invalid();
  return Object.freeze({quote:q,quoteDigest:d});
}
