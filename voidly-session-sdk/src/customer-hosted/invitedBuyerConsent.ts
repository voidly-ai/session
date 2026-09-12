export const BUYER_CONSENT_VERSION = 'voidpay.invited-buyer-consent.v0' as const
export const BUYER_CONSENT_MAX_INPUT_BYTES = 16_384
const BASE_CHAIN = 'eip155:8453' as const
const USDC_ASSET = 'erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const
const MAX_AMOUNT = '9007199254740991'
const MAX_TIME = 8_640_000_000_000_000
const RESPONSE_BYTES = 65_536
const REQUEST_TIMEOUT_MS = 15_000

export type BuyerConsentContext = Readonly<{ tenantId: string; subjectId: string; appId: string }>
export type BuyerConsentServiceRef = Readonly<{ providerId: string; serviceId: string; version: string; definitionDigest: string }>
export type BuyerConsentPermission = Readonly<{ service: BuyerConsentServiceRef; receivingDigest: string; recipient: string }>
export type BuyerConsentScope = Readonly<{
  version: 'voidpay.buyer-scope.v1'; profileDigest: string; chain: typeof BASE_CHAIN; asset: typeof USDC_ASSET
  payerAccount: string; services: readonly BuyerConsentPermission[]; maxPerJob: string; notBeforeMs: number; expiresAtMs: number
}>
export type BuyerConsentBudget = Readonly<{
  version: 'voidpay.buyer-budget.v1'; budgetId: string; context: BuyerConsentContext; membershipId: string
  authorizationRef: string; acceptedBy: string; scope: BuyerConsentScope; maxTotal: string; maxActiveJobs: number
}>
export type BuyerConsentAllowance = Readonly<{
  version: 'voidpay.buyer-allowance.v1'; allowanceId: string; budgetId: string; context: BuyerConsentContext
  membershipId: string; acceptedBy: string; scope: BuyerConsentScope
}>
export type BuyerConsentLineage = Readonly<{
  context: BuyerConsentContext; membershipId: string; budgetId: string; budgetDigest: string
  allowanceId: string; allowanceDigest: string; profileDigest: string; payerAccount: string
}>
export type BuyerConsentOriginal = Readonly<{
  version: 'voidpay.monetary-original-approval.v0'; lineage: BuyerConsentLineage; service: BuyerConsentServiceRef
  receivingDigest: string; supplierManifestDigest: string; providerDid: string; sessionServiceRef: string
  inputHandle: string; grantId: string; policyId: string; authorizationRef: string; approvedBy: string
  inputDigest: string; inputByteLength: number; disclosure: 'selected-bytes-to-exact-provider-service'; amountAtoms: string
  notBeforeMs: number; expiresAtMs: number; maxDurationMs: number; requiredRemainingMs: number
}>
export type BuyerConsentReview = Readonly<{
  version: typeof BUYER_CONSENT_VERSION; reviewId: string; requestId: string; permissionId: string
  configurationDigest: string; reviewedAtMs: number; budget: BuyerConsentBudget; allowance: BuyerConsentAllowance
  original: BuyerConsentOriginal
}>
export type BuyerConsentSnapshot = Readonly<{
  review: BuyerConsentReview; reviewDigest: string
  approval: Readonly<{ requestId: string; approvedAtMs: number }> | null
}>
export interface BuyerConsentAdapter {
  reviewScope(input: Readonly<{ requestId: string; selectedText: string }>): Promise<BuyerConsentSnapshot>
  approveScope(input: Readonly<{ reviewId: string; reviewDigest: string; requestId: string }>): Promise<BuyerConsentSnapshot>
  readScope(input: Readonly<{ requestId: string }>): Promise<BuyerConsentSnapshot | null>
}
export class BuyerConsentError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code)
    this.name = 'BuyerConsentError'
  }
}
const fail = (code = 'INVALID_INPUT'): never => { throw new BuyerConsentError(code) }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length) return fail()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.includes(key)) return fail()
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d || !d.enumerable || !('value' in d) || d.value === undefined) return fail()
    result[key] = d.value
  }
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return fail()
  return value
}
function integer(value: unknown, min = 0, max = MAX_TIME): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) return fail()
  return value
}
function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || (value.length === MAX_AMOUNT.length && value > MAX_AMOUNT)) return fail()
  return value
}
function account(value: unknown): string {
  if (typeof value !== 'string' || !/^eip155:8453:0x[0-9a-f]{40}$/.test(value)) return fail()
  return value
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return fail()
  return value
}
const freeze = Object.freeze
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function context(value: unknown): BuyerConsentContext {
  const c = record(value, ['tenantId', 'subjectId', 'appId'])
  return freeze({ tenantId: id(c.tenantId), subjectId: id(c.subjectId), appId: id(c.appId) })
}
function service(value: unknown): BuyerConsentServiceRef {
  const s = record(value, ['providerId', 'serviceId', 'version', 'definitionDigest'])
  return freeze({ providerId: id(s.providerId), serviceId: id(s.serviceId), version: id(s.version), definitionDigest: digest(s.definitionDigest) })
}
function scope(value: unknown): BuyerConsentScope {
  const s = record(value, ['version', 'profileDigest', 'chain', 'asset', 'payerAccount', 'services', 'maxPerJob', 'notBeforeMs', 'expiresAtMs'])
  if (s.version !== 'voidpay.buyer-scope.v1' || s.chain !== BASE_CHAIN || s.asset !== USDC_ASSET) return fail()
  if (!Array.isArray(s.services) || Object.getPrototypeOf(s.services) !== Array.prototype || s.services.length !== 1 || Reflect.ownKeys(s.services).length !== 2) return fail()
  const d = Object.getOwnPropertyDescriptor(s.services, '0')
  if (!d || !d.enumerable || !('value' in d)) return fail()
  const p = record(d.value, ['service', 'receivingDigest', 'recipient'])
  const permission = freeze({ service: service(p.service), receivingDigest: digest(p.receivingDigest), recipient: account(p.recipient) })
  const notBeforeMs = integer(s.notBeforeMs), expiresAtMs = integer(s.expiresAtMs)
  if (expiresAtMs <= notBeforeMs) return fail()
  return freeze({ version: s.version, profileDigest: digest(s.profileDigest), chain: BASE_CHAIN, asset: USDC_ASSET,
    payerAccount: account(s.payerAccount), services: freeze([permission]), maxPerJob: amount(s.maxPerJob), notBeforeMs, expiresAtMs })
}
function budget(value: unknown): BuyerConsentBudget {
  const b = record(value, ['version', 'budgetId', 'context', 'membershipId', 'authorizationRef', 'acceptedBy', 'scope', 'maxTotal', 'maxActiveJobs'])
  if (b.version !== 'voidpay.buyer-budget.v1') return fail()
  const s = scope(b.scope), maxTotal = amount(b.maxTotal)
  if (Number(s.maxPerJob) > Number(maxTotal)) return fail()
  return freeze({ version: b.version, budgetId: id(b.budgetId), context: context(b.context), membershipId: id(b.membershipId),
    authorizationRef: id(b.authorizationRef), acceptedBy: id(b.acceptedBy), scope: s, maxTotal, maxActiveJobs: integer(b.maxActiveJobs, 1, 32) })
}
function allowance(value: unknown): BuyerConsentAllowance {
  const a = record(value, ['version', 'allowanceId', 'budgetId', 'context', 'membershipId', 'acceptedBy', 'scope'])
  if (a.version !== 'voidpay.buyer-allowance.v1') return fail()
  return freeze({ version: a.version, allowanceId: id(a.allowanceId), budgetId: id(a.budgetId), context: context(a.context),
    membershipId: id(a.membershipId), acceptedBy: id(a.acceptedBy), scope: scope(a.scope) })
}
function lineage(value: unknown): BuyerConsentLineage {
  const l = record(value, ['context', 'membershipId', 'budgetId', 'budgetDigest', 'allowanceId', 'allowanceDigest', 'profileDigest', 'payerAccount'])
  return freeze({ context: context(l.context), membershipId: id(l.membershipId), budgetId: id(l.budgetId), budgetDigest: digest(l.budgetDigest),
    allowanceId: id(l.allowanceId), allowanceDigest: digest(l.allowanceDigest), profileDigest: digest(l.profileDigest), payerAccount: account(l.payerAccount) })
}
function original(value: unknown): BuyerConsentOriginal {
  const o = record(value, ['version', 'lineage', 'service', 'receivingDigest', 'supplierManifestDigest', 'providerDid', 'sessionServiceRef',
    'inputHandle', 'grantId', 'policyId', 'authorizationRef', 'approvedBy', 'inputDigest', 'inputByteLength', 'disclosure', 'amountAtoms',
    'notBeforeMs', 'expiresAtMs', 'maxDurationMs', 'requiredRemainingMs'])
  if (o.version !== 'voidpay.monetary-original-approval.v0' || o.disclosure !== 'selected-bytes-to-exact-provider-service' ||
    typeof o.providerDid !== 'string' || !/^did:voidly:[A-Za-z0-9._-]{1,64}$/.test(o.providerDid)) return fail()
  const sessionServiceRef = text(o.sessionServiceRef, 128)
  if (!sessionServiceRef) return fail()
  const notBeforeMs = integer(o.notBeforeMs), expiresAtMs = integer(o.expiresAtMs)
  const maxDurationMs = integer(o.maxDurationMs, 54_000, 600_000), requiredRemainingMs = integer(o.requiredRemainingMs, 54_000, 600_000)
  if (expiresAtMs <= notBeforeMs || requiredRemainingMs > maxDurationMs) return fail()
  return freeze({ version: o.version, lineage: lineage(o.lineage), service: service(o.service), receivingDigest: digest(o.receivingDigest),
    supplierManifestDigest: digest(o.supplierManifestDigest), providerDid: o.providerDid, sessionServiceRef,
    inputHandle: id(o.inputHandle), grantId: id(o.grantId), policyId: id(o.policyId), authorizationRef: id(o.authorizationRef), approvedBy: id(o.approvedBy),
    inputDigest: digest(o.inputDigest), inputByteLength: integer(o.inputByteLength, 0, BUYER_CONSENT_MAX_INPUT_BYTES), disclosure: o.disclosure,
    amountAtoms: amount(o.amountAtoms), notBeforeMs, expiresAtMs, maxDurationMs, requiredRemainingMs })
}
function snapshot(value: unknown): BuyerConsentSnapshot {
  const s = record(value, ['review', 'reviewDigest', 'approval'])
  const r = record(s.review, ['version', 'reviewId', 'requestId', 'permissionId', 'configurationDigest', 'reviewedAtMs', 'budget', 'allowance', 'original'])
  if (r.version !== BUYER_CONSENT_VERSION) return fail()
  const b = budget(r.budget), a = allowance(r.allowance), o = original(r.original), l = o.lineage
  const reviewedAtMs = integer(r.reviewedAtMs), reviewId = id(r.reviewId)
  if (!same(b.context, a.context) || !same(b.context, l.context) || b.membershipId !== a.membershipId || b.membershipId !== l.membershipId ||
    b.budgetId !== a.budgetId || b.budgetId !== l.budgetId || a.allowanceId !== l.allowanceId ||
    b.acceptedBy !== a.acceptedBy || b.acceptedBy !== o.approvedBy || b.scope.profileDigest !== a.scope.profileDigest || b.scope.profileDigest !== l.profileDigest ||
    b.scope.payerAccount !== a.scope.payerAccount || b.scope.payerAccount !== l.payerAccount || !same(b.scope.services, a.scope.services) ||
    !same(o.service, a.scope.services[0].service) || o.receivingDigest !== a.scope.services[0].receivingDigest ||
    Number(a.scope.maxPerJob) > Number(b.scope.maxPerJob) || o.amountAtoms !== a.scope.maxPerJob ||
    a.scope.notBeforeMs < b.scope.notBeforeMs || a.scope.expiresAtMs > b.scope.expiresAtMs || o.notBeforeMs !== a.scope.notBeforeMs || o.expiresAtMs !== a.scope.expiresAtMs ||
    reviewedAtMs < o.notBeforeMs || reviewedAtMs >= o.expiresAtMs || o.inputHandle !== `${reviewId}:input` || o.grantId !== `${reviewId}:grant` ||
    o.policyId !== `${reviewId}:policy` || o.authorizationRef !== `${reviewId}:disclosure`) return fail()
  let approval: BuyerConsentSnapshot['approval'] = null
  if (s.approval !== null) {
    const p = record(s.approval, ['requestId', 'approvedAtMs'])
    approval = freeze({ requestId: id(p.requestId), approvedAtMs: integer(p.approvedAtMs, reviewedAtMs) })
    if (approval.approvedAtMs >= o.expiresAtMs) return fail()
  }
  return freeze({ review: freeze({ version: r.version, reviewId, requestId: id(r.requestId), permissionId: id(r.permissionId),
    configurationDigest: digest(r.configurationDigest), reviewedAtMs, budget: b, allowance: a, original: o }), reviewDigest: digest(s.reviewDigest), approval })
}

export function formatBuyerConsentUsdc(amountAtoms: string, monetaryScope: Pick<BuyerConsentScope, 'chain' | 'asset'>): string {
  if (monetaryScope.chain !== BASE_CHAIN || monetaryScope.asset !== USDC_ASSET) return fail()
  const digits = amount(amountAtoms).padStart(7, '0')
  return `${digits.slice(0, -6)}.${digits.slice(-6)} USDC`
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
async function hash(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

function parseJson(raw: string): unknown {
  let cursor = 0
  const whitespace = () => { while (/[\t\n\r ]/.test(raw[cursor] ?? '\0')) cursor++ }
  const string = (): string => {
    const start = cursor
    if (raw[cursor++] !== '"') return fail()
    while (cursor < raw.length) {
      const char = raw[cursor++]
      if (char === '\\') cursor++
      else if (char === '"') return JSON.parse(raw.slice(start, cursor)) as string
    }
    return fail()
  }
  const value = (depth: number): void => {
    whitespace()
    if (depth > 16) return fail()
    const char = raw[cursor]
    if (char === '{' || char === '[') {
      const object = char === '{', close = object ? '}' : ']', keys = new Set<string>()
      cursor++; whitespace()
      if (raw[cursor] === close) { cursor++; return }
      for (;;) {
        if (object) { whitespace(); const key = string(); if (keys.has(key)) return fail(); keys.add(key); whitespace(); if (raw[cursor++] !== ':') return fail() }
        value(depth + 1); whitespace()
        if (raw[cursor] === close) { cursor++; return }
        if (raw[cursor++] !== ',') return fail()
      }
    }
    if (char === '"') { string(); return }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(cursor))
    if (!token) return fail()
    cursor += token[0].length
  }
  value(0); whitespace()
  if (cursor !== raw.length) return fail()
  return JSON.parse(raw)
}
async function readBody(response: Response): Promise<unknown> {
  if (response.redirected || !/^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i.test(response.headers.get('content-type') ?? '')) return fail()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]{1,20}$/.test(declared) || Number(declared) > RESPONSE_BYTES)) return fail()
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (!response.body) return fail()
  const reader = response.body.getReader(), bytes = new Uint8Array(RESPONSE_BYTES)
  let size = 0, done = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!chunk.value.byteLength || chunk.value.byteLength > RESPONSE_BYTES - size) return fail()
      bytes.set(chunk.value, size); size += chunk.value.byteLength
    }
    if ((!encoding || encoding === 'identity') && declared !== null && size !== Number(declared)) return fail()
    const result = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)))
    done = true
    return result
  } finally {
    if (!done) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
const ERROR_STATUSES: Readonly<Record<string, number>> = freeze({ INVALID_INPUT: 400, AUTH_REQUIRED: 401, FORBIDDEN: 403,
  NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, TIMEOUT: 408, AUTHORITY_CONFLICT: 409, KEYS_UNAVAILABLE: 503,
  INVALID_CONFIGURATION: 503, AUTHORITY_UNAVAILABLE: 503, OUTCOME_UNKNOWN: 503 })

export type BuyerConsentSession = Readonly<{ accessToken: string; isCurrent: () => boolean; signal: AbortSignal }>

function createConsentAdapter(session?: BuyerConsentSession, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): BuyerConsentAdapter {
  const current = () => !session || !session.signal.aborted && session.isCurrent()
  async function call(operation: 'reviewScope' | 'approveScope' | 'readScope', input: Record<string, string>, expectedInput?: { digest: string; size: number }): Promise<BuyerConsentSnapshot | null> {
    if (!current()) return fail('AUTH_REQUIRED')
    const body = JSON.stringify(input)
    if (new TextEncoder().encode(body).byteLength > 32_768) return fail()
    const failure = operation === 'readScope' ? 'AUTHORITY_UNAVAILABLE' : 'OUTCOME_UNKNOWN'
    const controller = new AbortController()
    let sent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BuyerConsentError(failure)) }, REQUEST_TIMEOUT_MS) })
    let rejectChanged!: (error: BuyerConsentError) => void
    const changed = new Promise<never>((_, reject) => { rejectChanged = reject })
    const identityChanged = () => { controller.abort(); rejectChanged(new BuyerConsentError(sent ? failure : 'AUTH_REQUIRED')) }
    session?.signal.addEventListener('abort', identityChanged, { once: true })
    const request = async () => {
      let response: Response, raw: unknown
      try {
        if (!current()) return fail('AUTH_REQUIRED')
        sent = true
        response = await fetcher('/v0/market/buyer-consent/' + operation, { method: 'POST', mode: 'same-origin', credentials: session ? 'omit' : 'same-origin', cache: 'no-store',
          redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Voidpay-Buyer-Consent': '1', ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}) }, body, signal: controller.signal })
        raw = await readBody(response)
        if (!current()) return fail(failure)
      } catch { return fail(failure) }
      if (response.status !== 200) {
        let code: string
        try {
          const envelope = record(raw, ['version', 'error'])
          if (envelope.version !== BUYER_CONSENT_VERSION) return fail()
          const error = envelope.error as Record<string, unknown>
          const e = record(error, error?.code === 'OUTCOME_UNKNOWN' ? ['code', 'recovery'] : ['code'])
          if (typeof e.code !== 'string' || !Object.hasOwn(ERROR_STATUSES, e.code) || ERROR_STATUSES[e.code] !== response.status ||
            (e.code === 'OUTCOME_UNKNOWN' && e.recovery !== 'read-original-review')) return fail()
          code = e.code
        } catch { return fail(failure) }
        throw new BuyerConsentError(code, response.status)
      }
      try {
        const envelope = record(raw, ['version', 'data'])
        if (envelope.version !== BUYER_CONSENT_VERSION) return fail()
        if (envelope.data === null && operation === 'readScope') return null
        const result = snapshot(envelope.data)
        if (result.reviewDigest !== await hash(canonical(result.review))) return fail()
        if (operation === 'approveScope') {
          if (result.review.reviewId !== input.reviewId || result.reviewDigest !== input.reviewDigest || result.approval?.requestId !== input.requestId) return fail()
        } else if (result.review.requestId !== input.requestId) return fail()
        if (expectedInput && (result.review.original.inputDigest !== expectedInput.digest || result.review.original.inputByteLength !== expectedInput.size)) return fail()
        if (!current()) return fail(failure)
        return result
      } catch { return fail(failure) }
    }
    try { return await Promise.race([request(), deadline, changed]) } finally { clearTimeout(timer); controller.abort(); session?.signal.removeEventListener('abort', identityChanged) }
  }
  return freeze({
    async reviewScope(input: Parameters<BuyerConsentAdapter['reviewScope']>[0]) {
      const r = record(input, ['requestId', 'selectedText']), requestId = id(r.requestId), selectedText = text(r.selectedText, BUYER_CONSENT_MAX_INPUT_BYTES)
      const size = new TextEncoder().encode(selectedText).byteLength
      if (size > BUYER_CONSENT_MAX_INPUT_BYTES) return fail()
      let inputDigest: string
      try { inputDigest = await hash(selectedText) } catch { return fail('AUTHORITY_UNAVAILABLE') }
      return await call('reviewScope', { requestId, selectedText }, { digest: inputDigest, size }) as BuyerConsentSnapshot
    },
    async approveScope(input: Parameters<BuyerConsentAdapter['approveScope']>[0]) {
      const r = record(input, ['reviewId', 'reviewDigest', 'requestId'])
      return await call('approveScope', { reviewId: id(r.reviewId), reviewDigest: digest(r.reviewDigest), requestId: id(r.requestId) }) as BuyerConsentSnapshot
    },
    async readScope(input: Parameters<BuyerConsentAdapter['readScope']>[0]) {
      const r = record(input, ['requestId'])
      return call('readScope', { requestId: id(r.requestId) })
    },
  })
}

export function createSameOriginBuyerConsentAdapter(): BuyerConsentAdapter {
  if (arguments.length !== 0) return fail('INVALID_CONFIGURATION')
  return createConsentAdapter()
}

export function createAuthenticatedBuyerConsentAdapter(value: BuyerConsentSession, transport: typeof fetch = globalThis.fetch.bind(globalThis)): BuyerConsentAdapter {
  if (arguments.length > 2 || typeof transport !== 'function') return fail('INVALID_CONFIGURATION')
  const s = record(value, ['accessToken', 'isCurrent', 'signal'])
  if (typeof s.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(s.accessToken) ||
      typeof s.isCurrent !== 'function' || !(s.signal instanceof AbortSignal)) return fail('INVALID_CONFIGURATION')
  return createConsentAdapter(freeze({ accessToken: s.accessToken, isCurrent: s.isCurrent as () => boolean, signal: s.signal }), transport)
}
