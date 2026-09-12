import { decodeMonetaryWalletClaim, parseMonetaryOriginal } from './monetaryDecoders'
import { hashText } from './protocol'
import { planOriginalPaymentTiming } from './originalPaymentTiming'
import type { InvitedCheckoutSigningInput } from './checkoutTypes'

export const CHECKOUT_VERSION = 'voidpay.invited-checkout.v0' as const
export type CheckoutSession = Readonly<{ accessToken: string; isCurrent: () => boolean; signal: AbortSignal }>
export type CheckoutReview = Readonly<{ reviewId: string; reviewDigest: string }>
export type CheckoutView = Readonly<{
  kind: 'invited-checkout'; checkoutId: string; reviewId: string; reviewDigest: string
  phase: 'original-pending' | 'wallet-ready' | 'wallet-requested' | 'authorization-submitted' | 'outcome-unknown'
  jobId: string | null; amountAtoms: string; expiresAtMs: number | null; recovery: 'original-only'
}>
export type CheckoutSubmission = Readonly<{ kind: 'provider-accepted' | 'unresolved'; jobId: string; exposureId: string; grantHash: string; payment: 'unconfirmed'; reason?: string }>
  | Readonly<{ kind: 'original-request-already-exposed'; jobId: string; exposureId: string; phase: 'exposure_claimed'; possibleExposure: true; exposedAtMs: number; payment: 'unconfirmed' }>
export type CheckoutAuthorizationStatus = Readonly<{ kind: 'original-authorization-accepted'; jobId: string; claimId: string; authorizationDigest: string; preparedDigest: string; acceptedAtMs: number }> | null
export type CheckoutCancelReceipt = Readonly<{ kind: 'original-unclaimed-cancelled'; jobId: string; cancellationId: string; amountAtoms: string; recordedAtMs: number }>
export type CheckoutCancel = CheckoutCancelReceipt | Readonly<{ kind: 'original-unclaimed-cancellation-pending'; jobId: string; reason: 'ORIGINAL_NOT_ELIGIBLE' }>
export type CheckoutRecovery = Readonly<{
  kind: 'original-monetary-recovery'; jobId: string; source: 'server-reported'
  settlement: Readonly<{ kind: 'accounted'; tx: string; amountAtoms: string; recordedAtMs: number }> | Readonly<{ kind: 'not-checked' | 'unconfirmed' | 'unknown' | 'refused' }>
  deliveryRecorded: boolean
  result: Readonly<{ kind: 'opened'; text: string; outputDigest: string; outputByteLength: number }> | Readonly<{ kind: 'locked' | 'no-result' | 'unknown' | 'refused' | 'not-started'; reason?: string }>
  budgetRecovery: Readonly<{ kind: 'released'; amountAtoms: string; recordedAtMs: number }> | Readonly<{ kind: 'pending'; reason: string }> | null
}>
export interface CheckoutAdapter {
  begin(input: CheckoutReview & Readonly<{ requestId: string; selectedText: string }>): Promise<CheckoutView>
  read(input: CheckoutReview): Promise<CheckoutView | null>
  claimForWallet(input: CheckoutReview): Promise<InvitedCheckoutSigningInput>
  submit(input: CheckoutReview & Readonly<{ jobId: string; signature: string }>): Promise<CheckoutSubmission>
  authorizationStatus(input: CheckoutReview): Promise<CheckoutAuthorizationStatus>
  recover(input: CheckoutReview): Promise<CheckoutRecovery | CheckoutCancelReceipt>
  cancelUnclaimed(input: CheckoutReview): Promise<CheckoutCancel>
}
export class CheckoutTransportError extends Error {
  readonly recovery?: 'original-only'
  constructor(readonly code: string, readonly status?: number, readonly outcomeUnknown = false) {
    super(code); this.name = 'CheckoutTransportError'
    if (outcomeUnknown) this.recovery = 'original-only'
  }
}
const fail = (): never => { throw new CheckoutTransportError('INVALID_INPUT') }
const freeze = Object.freeze
const MAX_RESPONSE = 524_288
type Operation = keyof CheckoutAdapter
type Pin = { view: CheckoutView; claim?: InvitedCheckoutSigningInput; inputDigest?: string; inputBytes?: number }
const ERROR_STATUSES: Readonly<Record<string, number>> = freeze({ INVALID_INPUT: 400, AUTH_REQUIRED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, TIMEOUT: 408, AUTHORITY_CONFLICT: 409, INVALID_CONFIGURATION: 503,
  AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNKNOWN: 503 })

function record(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail()
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key) && !optional.includes(key)) return fail()
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d?.enumerable || !('value' in d) || d.value === undefined) return fail()
    out[key] = d.value
  }
  if (fields.some(key => !Object.hasOwn(out, key))) return fail()
  return out
}
function str(value: unknown, max = 128): string {
  if (typeof value !== 'string' || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return fail()
  return value
}
function id(value: unknown): string { const s = str(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) return fail(); return s }
function digest(value: unknown): string { const s = str(value, 64); if (!/^[0-9a-f]{64}$/.test(s)) return fail(); return s }
function tx(value: unknown): string { const s = str(value, 66); if (!/^0x[0-9a-f]{64}$/.test(s)) return fail(); return s }
function integer(value: unknown, min = 0, max = 8_640_000_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) return fail(); return value
}
function amount(value: unknown): string {
  const s = str(value, 16)
  if (!/^[1-9][0-9]{0,15}$/.test(s) || s.length === 16 && s > '9007199254740991') return fail(); return s
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) return fail(); return value as T }
function iso(value: unknown): number { const s = str(value, 32); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)) return fail(); return integer(Date.parse(s)) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
function kind(value: unknown): unknown { if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(); return (value as Record<string, unknown>).kind }
function job(value: unknown, pin: Pin): string { const j = id(value); if (j !== pin.view.jobId) return fail(); return j }
function claimId(value: unknown, pin: Pin) { const v = id(value); if (pin.claim && v !== pin.claim.claim.claimId) return fail(); return v }
function preparedDigest(value: unknown, pin: Pin) { const v = digest(value); if (pin.claim && v !== pin.claim.original.prepared.receipt.preparedDigest) return fail(); return v }
function grantHash(value: unknown, pin: Pin) { const v = digest(value); if (pin.claim && pin.claim.claim.kind === 'original-wallet-request' && v !== pin.claim.claim.grantHash) return fail(); return v }
function exactAmount(value: unknown, pin: Pin) { const v = amount(value); if (v !== pin.view.amountAtoms) return fail(); return v }

function view(value: unknown, review: CheckoutReview, prior?: Pin): CheckoutView {
  const r = record(value, ['kind', 'checkoutId', 'reviewId', 'reviewDigest', 'phase', 'jobId', 'amountAtoms', 'expiresAtMs', 'recovery'])
  if (r.kind !== 'invited-checkout' || r.reviewId !== review.reviewId || r.reviewDigest !== review.reviewDigest || r.recovery !== 'original-only') return fail()
  const out: CheckoutView = freeze({ kind: r.kind, checkoutId: id(r.checkoutId), ...review,
    phase: choice(r.phase, ['original-pending', 'wallet-ready', 'wallet-requested', 'authorization-submitted', 'outcome-unknown']),
    jobId: r.jobId === null ? null : id(r.jobId), amountAtoms: amount(r.amountAtoms), expiresAtMs: r.expiresAtMs === null ? null : integer(r.expiresAtMs), recovery: r.recovery })
  if (out.phase === 'original-pending' && (out.jobId !== null || out.expiresAtMs !== null) ||
    ['wallet-ready', 'wallet-requested', 'authorization-submitted'].includes(out.phase) && (out.jobId === null || out.expiresAtMs === null)) return fail()
  if (prior && (out.checkoutId !== prior.view.checkoutId || out.amountAtoms !== prior.view.amountAtoms ||
    prior.view.jobId !== null && out.jobId !== prior.view.jobId || prior.view.expiresAtMs !== null && out.expiresAtMs !== prior.view.expiresAtMs)) return fail()
  return out
}
function submission(value: unknown, pin: Pin): CheckoutSubmission {
  const exposed = kind(value) === 'original-request-already-exposed'
  const r = record(value, exposed ? ['kind', 'jobId', 'exposureId', 'phase', 'possibleExposure', 'exposedAtMs', 'payment'] : ['kind', 'jobId', 'exposureId', 'grantHash', 'payment'], kind(value) === 'unresolved' ? ['reason'] : [])
  if (r.payment !== 'unconfirmed') return fail()
  const jobId = job(r.jobId, pin), exposureId = id(r.exposureId)
  if (exposed) {
    if (r.phase !== 'exposure_claimed' || r.possibleExposure !== true) return fail()
    return freeze({ kind: 'original-request-already-exposed', jobId, exposureId, phase: r.phase, possibleExposure: true, exposedAtMs: integer(r.exposedAtMs), payment: r.payment })
  }
  const k = choice(r.kind, ['provider-accepted', 'unresolved'])
  if (r.reason !== undefined && !/^[A-Z_]{1,128}$/.test(str(r.reason))) return fail()
  return freeze({ kind: k, jobId, exposureId, grantHash: grantHash(r.grantHash, pin), payment: r.payment, ...(r.reason === undefined ? {} : { reason: r.reason as string }) })
}
function authorization(value: unknown, pin: Pin): CheckoutAuthorizationStatus {
  if (value === null) return null
  const r = record(value, ['kind', 'jobId', 'claimId', 'authorizationDigest', 'preparedDigest', 'acceptedAtMs'])
  if (r.kind !== 'original-authorization-accepted') return fail()
  return freeze({ kind: r.kind, jobId: job(r.jobId, pin), claimId: claimId(r.claimId, pin), authorizationDigest: digest(r.authorizationDigest),
    preparedDigest: preparedDigest(r.preparedDigest, pin), acceptedAtMs: integer(r.acceptedAtMs) })
}
function cancellation(value: unknown, pin: Pin, allowPending: boolean): CheckoutCancel {
  if (kind(value) === 'original-unclaimed-cancellation-pending' && allowPending) {
    const r = record(value, ['kind', 'jobId', 'reason'])
    if (r.reason !== 'ORIGINAL_NOT_ELIGIBLE') return fail()
    return freeze({ kind: 'original-unclaimed-cancellation-pending', jobId: job(r.jobId, pin), reason: r.reason })
  }
  const r = record(value, ['kind', 'jobId', 'cancellationId', 'amountAtoms', 'recordedAtMs'])
  if (r.kind !== 'original-unclaimed-cancelled') return fail()
  return freeze({ kind: r.kind, jobId: job(r.jobId, pin), cancellationId: digest(r.cancellationId), amountAtoms: exactAmount(r.amountAtoms, pin), recordedAtMs: integer(r.recordedAtMs) })
}

function anchor(value: unknown, pin: Pin, paid = false): Record<string, unknown> {
  const r = record(value, ['purchaseId', 'preparedDigest', 'supplierManifestDigest', 'owner', 'intentId', 'quoteDigest', 'grantHash', 'termsDigest', ...(paid ? ['grantId', 'grantDigest'] : [])])
  job(r.purchaseId, pin); preparedDigest(r.preparedDigest, pin); id(r.intentId); grantHash(r.grantHash, pin)
  for (const k of ['supplierManifestDigest', 'quoteDigest', 'termsDigest', ...(paid ? ['grantDigest'] : [])]) digest(r[k])
  const c = record(r.owner, ['tenantId', 'subjectId', 'appId']); Object.values(c).forEach(id)
  if (paid) id(r.grantId)
  if (pin.claim) {
    const o = pin.claim.original
    if (canonical(c) !== canonical(o.approval.lineage.context) || r.supplierManifestDigest !== o.prepared.receipt.supplierManifestDigest ||
      r.quoteDigest !== o.quoted.quoteDigest || r.termsDigest !== o.quoted.quote.termsDigest || paid && (r.grantId !== o.approval.grantId || r.grantDigest !== o.approval.grantDigest)) return fail()
  }
  return r
}
function signedDelivery(value: unknown, pin: Pin) {
  const r = record(value, ['receipt', 'signatureBase64'])
  const d = record(r.receipt, ['schema', 'grant_hash', 'offer_hash', 'provider_did', 'result_capsule_hash', 'result_commitment', 'issued_at', 'recoverable_until'])
  if (d.schema !== 'voidly-task-delivery/v1' || !/^did:voidly:[A-Za-z0-9]{1,128}$/.test(str(d.provider_did, 160))) return fail()
  grantHash(d.grant_hash, pin); digest(d.offer_hash); digest(d.result_capsule_hash); digest(d.result_commitment)
  if (iso(d.recoverable_until) <= iso(d.issued_at)) return fail()
  const signature = str(r.signatureBase64, 88)
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || atob(signature).length !== 64 || btoa(atob(signature)) !== signature) return fail()
  if (pin.claim && pin.claim.claim.kind === 'original-wallet-request' && (d.offer_hash !== pin.claim.claim.grant.offer_hash || d.provider_did !== pin.claim.original.approval.providerDid)) return fail()
  return { receipt: d, signatureBase64: signature }
}
const RESULT_REASONS = ['INPUT_INVALID', 'ORIGINAL_MISMATCH', 'ORIGINAL_INVALID', 'IDENTITY_INVALID', 'RECOVERY_UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESPONSE_INVALID', 'RESULT_UNAUTHENTICATED', 'OUTPUT_TOO_LARGE'] as const
const SETTLEMENT_REASONS = ['INPUT_INVALID', 'ORIGINAL_MISMATCH', 'ORIGINAL_INVALID', 'VERIFICATION_UNAVAILABLE', 'TRANSACTION_UNCONFIRMED', 'CONFIRMATIONS_PENDING', 'RPC_EVIDENCE_UNKNOWN', 'TRANSACTION_REVERTED', 'SETTLEMENT_TERMS_MISMATCH'] as const
const RELEASE_REASONS = ['ORIGINAL_NOT_ELIGIBLE', 'ORIGINAL_UNAVAILABLE', 'FINALITY_PENDING', 'AUTHORIZATION_NOT_UNUSED', 'RPC_EVIDENCE_UNKNOWN', 'RPC_TIMEOUT', 'INPUT_INVALID'] as const

async function recovery(value: unknown, pin: Pin): Promise<CheckoutRecovery> {
  const r = record(value, ['kind', 'jobId', 'settlement', 'delivery', 'result'], ['budgetRecovery'])
  if (r.kind !== 'original-monetary-recovery') return fail()
  const jobId = job(r.jobId, pin)
  let seenAnchor: string | undefined, seenGrant: string | undefined
  function bindGrant(value: unknown) {
    const hash = grantHash(value, pin)
    if (seenGrant !== undefined && seenGrant !== hash) return fail()
    seenGrant = hash; return hash
  }
  function bindAnchor(value: unknown, paid = false) {
    const a = anchor(value, pin, paid); bindGrant(a.grantHash)
    const shared = { ...a }; delete shared.grantId; delete shared.grantDigest
    const encoded = canonical(shared)
    if (seenAnchor !== undefined && seenAnchor !== encoded) return fail()
    seenAnchor = encoded
  }
  let budgetRecovery: CheckoutRecovery['budgetRecovery'] = null
  if (r.budgetRecovery !== undefined) {
    if (kind(r.budgetRecovery) === 'original-expired-unused-released') {
      const b = record(r.budgetRecovery, ['kind', 'jobId', 'claimId', 'releaseId', 'preparedDigest', 'amountAtoms', 'recordedAtMs', 'evidenceDigest', 'finalizedBlock'])
      job(b.jobId, pin); claimId(b.claimId, pin); id(b.releaseId); preparedDigest(b.preparedDigest, pin); digest(b.evidenceDigest)
      const f = record(b.finalizedBlock, ['number', 'hash', 'timestamp']); tx(f.hash); integer(f.timestamp)
      if (!/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(str(f.number, 18)) || pin.claim && Number(f.timestamp) < Math.floor(pin.claim.original.quoted.quote.workNotAfterMs / 1000)) return fail()
      budgetRecovery = freeze({ kind: 'released', amountAtoms: exactAmount(b.amountAtoms, pin), recordedAtMs: integer(b.recordedAtMs) })
    } else {
      const b = record(r.budgetRecovery, ['kind', 'jobId', 'reason']); job(b.jobId, pin)
      if (b.kind !== 'original-expired-unused-pending') return fail()
      budgetRecovery = freeze({ kind: 'pending', reason: choice(b.reason, RELEASE_REASONS) })
    }
  }
  let settlement: CheckoutRecovery['settlement'], exposure: string | undefined, settlementGrant: string | undefined
  if (kind(r.settlement) === 'not-checked') { record(r.settlement, ['kind']); settlement = freeze({ kind: 'not-checked' }) }
  else if (kind(r.settlement) === 'original-settlement-accounted') {
    const s = record(r.settlement, ['kind', 'jobId', 'settlementId', 'claimId', 'exposureId', 'tx', 'authLogIndex', 'transferLogIndex', 'amountAtoms', 'recordedAtMs', 'evidenceDigest', 'evidence'])
    job(s.jobId, pin); digest(s.settlementId); claimId(s.claimId, pin); digest(s.evidenceDigest); exposure = id(s.exposureId)
    const e = record(s.evidence, ['ok', 'tx', 'grantHash', 'nonce', 'authorizer', 'payer', 'payee', 'value', 'authLogIndex', 'transferLogIndex', 'blockNumber', 'confirmations', 'assurance', 'chain', 'terms', 'rpcHosts', 'unpinnedHosts', 'unpinned', 'headOperators', 'headFrom'])
    const hash = tx(s.tx), amountAtoms = exactAmount(s.amountAtoms, pin)
    settlementGrant = bindGrant(e.grantHash); tx(e.nonce)
    for (const k of ['payer', 'payee', 'authorizer']) if (!/^0x[0-9a-f]{40}$/.test(str(e[k], 42))) return fail()
    if (e.ok !== true || e.chain !== '0x2105' || e.tx !== hash || e.value !== amountAtoms || e.authorizer !== e.payer || e.authLogIndex !== s.authLogIndex || e.transferLogIndex !== s.transferLogIndex || e.unpinned !== false) return fail()
    integer(s.authLogIndex); integer(s.transferLogIndex); integer(e.blockNumber); integer(e.confirmations, 12); integer(e.headOperators, 2, 8); str(e.headFrom, 2048)
    const a = record(e.assurance, ['level', 'confirmationBasis', 'safe', 'finalized', 'requiredConfirmations'])
    if (a.level !== 'rpc-quorum-inclusion' || a.confirmationBasis !== 'lowest-latest-head' || a.safe !== 'not-checked' || a.finalized !== 'not-checked' || integer(a.requiredConfirmations, 12) > Number(e.confirmations)) return fail()
    for (const k of ['rpcHosts', 'unpinnedHosts']) {
      const list = e[k]
      if (!Array.isArray(list) || list.length > 8 || list.some(v => typeof v !== 'string' || !/^[a-z0-9.:-]{1,253}$/.test(v))) return fail()
    }
    if ((e.rpcHosts as unknown[]).length < 2 || (e.unpinnedHosts as unknown[]).length !== 0) return fail()
    const t = record(e.terms, ['source', 'expiresAt', 'band']), band = record(t.band, ['min', 'max'])
    if (t.source !== 'grant' || band.min !== amountAtoms || band.max !== amountAtoms) return fail()
    iso(t.expiresAt)
    if (pin.claim && (e.payer !== pin.claim.original.approval.terms.payerAccount.slice(12) || e.payee !== pin.claim.original.approval.terms.payeeAccount.slice(12) || iso(t.expiresAt) !== pin.claim.original.quoted.quote.workNotAfterMs)) return fail()
    settlement = freeze({ kind: 'accounted', tx: hash, amountAtoms, recordedAtMs: integer(s.recordedAtMs) })
  } else {
    const s = record(r.settlement, ['version', 'kind', 'original', 'candidateTx', 'reason'])
    if (s.version !== 'voidpay.monetary-settlement.v0') return fail()
    choice(s.reason, SETTLEMENT_REASONS); if (s.candidateTx !== null) tx(s.candidateTx)
    if (s.original !== null) bindAnchor(s.original, true)
    settlement = freeze({ kind: choice(s.kind, ['unconfirmed', 'unknown', 'refused']) })
  }
  let retainedDelivery: ReturnType<typeof signedDelivery> | null = null, outputDigest: string | undefined, outputBytes: number | undefined
  if (r.delivery !== null) {
    const d = record(r.delivery, ['kind', 'jobId', 'claimId', 'exposureId', 'preparedDigest', 'receiptDigest', 'delivery', 'recordedAtMs', 'output'])
    if (d.kind !== 'original-delivery-recorded') return fail()
    job(d.jobId, pin); claimId(d.claimId, pin); preparedDigest(d.preparedDigest, pin); digest(d.receiptDigest); integer(d.recordedAtMs)
    if (exposure !== undefined && id(d.exposureId) !== exposure) return fail(); id(d.exposureId)
    retainedDelivery = signedDelivery(d.delivery, pin)
    bindGrant(retainedDelivery.receipt.grant_hash)
    if (settlementGrant !== undefined && retainedDelivery.receipt.grant_hash !== settlementGrant || await hashText(canonical(retainedDelivery.receipt)) !== d.receiptDigest) return fail()
    if (d.output !== null) { const out = record(d.output, ['digest', 'byteLength', 'recordedAtMs']); outputDigest = digest(out.digest); outputBytes = integer(out.byteLength, 0, 65536); integer(out.recordedAtMs) }
  }
  let result: CheckoutRecovery['result']
  if (canonical(r.result) === '{"kind":"unknown","reason":"ORIGINAL_UNAVAILABLE"}') result = freeze({ kind: 'unknown', reason: 'ORIGINAL_UNAVAILABLE' })
  else if (canonical(r.result) === '{"kind":"not-started","reason":"AUTHORIZATION_EXPIRED_UNUSED"}') {
    if (budgetRecovery?.kind !== 'released') return fail()
    result = freeze({ kind: 'not-started', reason: 'AUTHORIZATION_EXPIRED_UNUSED' })
  } else {
    const k = choice(kind(r.result), ['opened', 'locked', 'no-result', 'unknown', 'refused'])
    const out = record(r.result, ['version', 'kind', 'original', ...(['opened', 'locked'].includes(k) ? ['delivery'] : []),
      ...(k === 'opened' ? ['result', 'outputDigest', 'outputByteLength'] : []), ...(['unknown', 'refused'].includes(k) ? ['reason'] : [])], ['settlementCandidate'])
    if (out.version !== 'voidpay.monetary-result-recovery.v0' || out.original === null && k !== 'unknown' && k !== 'refused') return fail()
    if (out.original !== null) bindAnchor(out.original)
    if (out.reason !== undefined) choice(out.reason, RESULT_REASONS)
    if (out.settlementCandidate !== undefined) { const hint = record(out.settlementCandidate, ['tx', 'source']); tx(hint.tx); if (hint.source !== 'rail-recovery') return fail() }
    if (k === 'opened' || k === 'locked') {
      const delivered = signedDelivery(out.delivery, pin)
      bindGrant(delivered.receipt.grant_hash)
      if (retainedDelivery && canonical(delivered) !== canonical(retainedDelivery) || settlementGrant !== undefined && delivered.receipt.grant_hash !== settlementGrant) return fail()
    }
    if (k === 'opened') {
      const text = str(out.result, 65536), bytes = new TextEncoder().encode(text).length, hash = digest(out.outputDigest)
      if (integer(out.outputByteLength, 0, 65536) !== bytes || await hashText(text) !== hash || outputDigest !== undefined && (hash !== outputDigest || bytes !== outputBytes)) return fail()
      result = freeze({ kind: k, text, outputDigest: hash, outputByteLength: bytes })
    } else result = freeze({ kind: k, ...(out.reason === undefined ? {} : { reason: out.reason as string }) })
  }
  if (budgetRecovery?.kind === 'released' && (settlement.kind !== 'not-checked' || r.delivery !== null || result.kind !== 'not-started')) return fail()
  return freeze({ kind: 'original-monetary-recovery', jobId, source: 'server-reported', settlement, deliveryRecorded: r.delivery !== null, result, budgetRecovery })
}

function parseJson(raw: string): unknown {
  let cursor = 0
  const whitespace = () => { while (/[\t\n\r ]/.test(raw[cursor] ?? '\0')) cursor++ }
  const string = (): string => {
    const start = cursor
    if (raw[cursor++] !== '"') return fail()
    while (cursor < raw.length) { const c = raw[cursor++]; if (c === '\\') cursor++; else if (c === '"') return str(JSON.parse(raw.slice(start, cursor)), MAX_RESPONSE) }
    return fail()
  }
  function value(depth: number): void {
    whitespace(); if (depth > 16) return fail()
    const c = raw[cursor]
    if (c === '{' || c === '[') {
      const object = c === '{', close = object ? '}' : ']', keys = new Set<string>(); cursor++; whitespace()
      if (raw[cursor] === close) { cursor++; return }
      for (;;) {
        if (object) { whitespace(); const key = string(); if (keys.has(key)) return fail(); keys.add(key); whitespace(); if (raw[cursor++] !== ':') return fail() }
        value(depth + 1); whitespace(); if (raw[cursor] === close) { cursor++; return }; if (raw[cursor++] !== ',') return fail()
      }
    }
    if (c === '"') { string(); return }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(cursor))
    if (!token) return fail(); cursor += token[0].length
  }
  value(0); whitespace(); if (cursor !== raw.length) return fail(); return JSON.parse(raw)
}
async function readBody(response: Response, check: () => void, cancelWith: (cancel: () => void) => void): Promise<unknown> {
  if (response.redirected || response.type === 'opaqueredirect' || !/^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.test(response.headers.get('content-type') ?? '')) return fail()
  const declared = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (declared !== null && (!/^[0-9]{1,20}$/.test(declared) || Number(declared) > MAX_RESPONSE) || !response.body) return fail()
  const reader = response.body.getReader(), bytes = new Uint8Array(MAX_RESPONSE); let size = 0, done = false
  cancelWith(() => { void reader.cancel().catch(() => {}) })
  try {
    for (;;) {
      check(); const chunk = await reader.read(); check(); if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array) || !chunk.value.byteLength || chunk.value.byteLength > MAX_RESPONSE - size) return fail()
      bytes.set(chunk.value, size); size += chunk.value.byteLength
    }
    if ((!encoding || encoding === 'identity') && declared !== null && Number(declared) !== size) return fail()
    const result = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)))
    check(); done = true; return result
  } finally { if (!done) void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch { } }
}

export function createInvitedCheckoutTransport(session: CheckoutSession, transport: typeof fetch = globalThis.fetch.bind(globalThis)): CheckoutAdapter {
  if (arguments.length > 2 || typeof transport !== 'function') throw new CheckoutTransportError('INVALID_CONFIGURATION')
  let s: Record<string, unknown>
  try { s = record(session, ['accessToken', 'isCurrent', 'signal']) } catch { throw new CheckoutTransportError('INVALID_CONFIGURATION') }
  if (typeof s.accessToken !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(s.accessToken) || typeof s.isCurrent !== 'function' || !(s.signal instanceof AbortSignal)) throw new CheckoutTransportError('INVALID_CONFIGURATION')
  const token = s.accessToken, isCurrent = (s.isCurrent as () => boolean).bind(session), signal = s.signal, fetcher = transport
  const pins = new Map<string, Pin>(); let lost = false
  const keyOf = (r: CheckoutReview) => JSON.stringify([r.reviewId, r.reviewDigest])
  function current() { if (lost || signal.aborted) { lost = true; return false }; try { if (isCurrent()) return true } catch { }; lost = true; return false }
  function reviewInput(input: unknown, extra: readonly string[] = []) {
    const r = record(input, ['reviewId', 'reviewDigest', ...extra]), review = freeze({ reviewId: id(r.reviewId), reviewDigest: digest(r.reviewDigest) })
    return { r, review }
  }
  async function call(operation: Operation, review: CheckoutReview, input: Record<string, string>, selected?: string): Promise<unknown> {
    if (!current()) throw new CheckoutTransportError('AUTH_REQUIRED')
    const key = keyOf(review), prior = pins.get(key), needsJob = !['begin', 'read'].includes(operation)
    if (needsJob && !prior?.view.jobId || operation === 'submit' && input.jobId !== prior?.view.jobId) throw new CheckoutTransportError('INVALID_INPUT')
    const body = JSON.stringify(input)
    if (new TextEncoder().encode(body).length > 32768) throw new CheckoutTransportError('INVALID_INPUT')
    const write = !['read', 'authorizationStatus'].includes(operation), controller = new AbortController()
    let dispatched = false, closed = false, interrupted: CheckoutTransportError | null = null, cancelBody: (() => void) | undefined
    let rejectWait!: (error: CheckoutTransportError) => void
    const deadline = new Promise<never>((_resolve, reject) => { rejectWait = reject })
    const unavailable = () => new CheckoutTransportError(write && dispatched ? 'OUTCOME_UNKNOWN' : 'AUTHORITY_UNAVAILABLE', undefined, write && dispatched)
    const stop = (error: CheckoutTransportError) => { if (closed || interrupted) return; interrupted = error; controller.abort(); cancelBody?.(); rejectWait(error) }
    const abort = () => { lost = true; stop(new CheckoutTransportError('AUTH_REQUIRED', undefined, write && dispatched)) }
    signal.addEventListener('abort', abort, { once: true })
    const timeoutMs = 65000
    const end = performance.now() + timeoutMs, timer = setTimeout(() => stop(unavailable()), timeoutMs)
    function check() {
      if (interrupted) throw interrupted
      if (!current()) { abort(); throw interrupted! }
      if (closed || performance.now() >= end) { stop(unavailable()); throw interrupted ?? unavailable() }
    }
    let response: Response | undefined
    async function work() {
      const inputDigest = selected === undefined ? undefined : await hashText(selected); check()
      dispatched = true
      response = await fetcher('/v0/market/checkout/' + operation, { method: 'POST', mode: 'same-origin', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Voidpay-Market-Checkout': '1' }, body, signal: controller.signal })
      try { check() } catch (error) { void response.body?.cancel().catch(() => {}); throw error }
      const raw = await readBody(response, check, cancel => { cancelBody = cancel }); check()
      if (response.status !== 200) {
        const e = record(raw, ['version', 'error'])
        if (e.version !== CHECKOUT_VERSION) return fail()
        const v = record(e.error, ['code'], ['recovery']), code = str(v.code)
        if (!Object.hasOwn(ERROR_STATUSES, code) || ERROR_STATUSES[code] !== response.status ||
          (code === 'OUTCOME_UNKNOWN' ? v.recovery !== 'original-only' : v.recovery !== undefined)) return fail()
        throw new CheckoutTransportError(code, response.status, code === 'OUTCOME_UNKNOWN')
      }
      const envelope = record(raw, ['version', 'data']); if (envelope.version !== CHECKOUT_VERSION) return fail()
      const value = envelope.data
      if (operation === 'begin' || operation === 'read') {
        if (value === null && operation === 'read') { if (prior) return fail(); return null }
        const result = view(value, review, pins.get(key)); check()
        pins.set(key, { ...pins.get(key), view: result, ...(inputDigest === undefined ? {} : { inputDigest, inputBytes: new TextEncoder().encode(selected!).length }) })
        return result
      }
      const pin = pins.get(key)!; if (!pin?.view.jobId) return fail()
      if (operation === 'claimForWallet') {
        const r = record(value, ['original', 'claim', 'timing']), original = parseMonetaryOriginal(r.original)
        const claim = await decodeMonetaryWalletClaim(r.claim, original); check()
        if (claim.kind !== 'original-wallet-request' || original.prepared.jobId !== pin.view.jobId || original.approval.terms.amountAtoms !== pin.view.amountAtoms ||
          original.quoted.quote.expiresAtMs !== pin.view.expiresAtMs || pin.inputDigest !== undefined && (original.approval.selection.inputDigest !== pin.inputDigest || original.approval.selection.inputByteLength !== pin.inputBytes)) return fail()
        const t = record(r.timing, ['kind', 'promptNotAfterMs', 'signatureNotAfterMs', 'submitNotAfterMs', 'walletTimeoutMs'])
        const planned = planOriginalPaymentTiming({ nowMs: Date.now(), workNotAfterMs: original.quoted.quote.workNotAfterMs, requiredRemainingMs: original.approval.minimumOriginalMs, disclosureNotAfterMs: claim.disclosureNotAfterMs })
        if (planned.kind !== 'ready' || t.kind !== 'ready' || t.promptNotAfterMs !== planned.promptNotAfterMs || t.signatureNotAfterMs !== planned.signatureNotAfterMs || t.submitNotAfterMs !== planned.submitNotAfterMs) return fail()
        const walletTimeoutMs = integer(t.walletTimeoutMs, 30000, 120000)
        const result: InvitedCheckoutSigningInput = freeze({ original, claim, timing: freeze({ kind: 'ready', promptNotAfterMs: planned.promptNotAfterMs, signatureNotAfterMs: planned.signatureNotAfterMs, submitNotAfterMs: planned.submitNotAfterMs, walletTimeoutMs }) })
        check(); pins.set(key, { ...pin, claim: result }); return result
      }
      if (operation === 'submit') return submission(value, pin)
      if (operation === 'authorizationStatus') return authorization(value, pin)
      if (operation === 'cancelUnclaimed') return cancellation(value, pin, true)
      if (kind(value) === 'original-unclaimed-cancelled') return cancellation(value, pin, false)
      return await recovery(value, pin)
    }
    try { const result = await Promise.race([work(), deadline]); check(); return result }
    catch (error) {
      if (!current()) abort()
      if (interrupted) throw interrupted
      if (error instanceof CheckoutTransportError && error.status !== undefined) throw error
      throw unavailable()
    } finally {
      closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort()
      try { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}) } catch { }
    }
  }
  return freeze<CheckoutAdapter>({
    async begin(input) {
      const { r, review } = reviewInput(input, ['requestId', 'selectedText']), selectedText = str(r.selectedText, 16384)
      if (new TextEncoder().encode(selectedText).length > 16384) return fail()
      return await call('begin', review, { ...review, requestId: id(r.requestId), selectedText }, selectedText) as CheckoutView
    },
    async read(input) { const { review } = reviewInput(input); return await call('read', review, review) as CheckoutView | null },
    async claimForWallet(input) { const { review } = reviewInput(input); return await call('claimForWallet', review, review) as InvitedCheckoutSigningInput },
    async submit(input) {
      const { r, review } = reviewInput(input, ['jobId', 'signature']), signature = str(r.signature, 132)
      if (!/^0x[0-9a-fA-F]{128}1[bBcC]$/.test(signature)) return fail()
      return await call('submit', review, { ...review, jobId: id(r.jobId), signature }) as CheckoutSubmission
    },
    async authorizationStatus(input) { const { review } = reviewInput(input); return await call('authorizationStatus', review, review) as CheckoutAuthorizationStatus },
    async recover(input) { const { review } = reviewInput(input); return await call('recover', review, review) as CheckoutRecovery | CheckoutCancelReceipt },
    async cancelUnclaimed(input) { const { review } = reviewInput(input); return await call('cancelUnclaimed', review, review) as CheckoutCancel },
  })
}
