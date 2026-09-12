/** The fixed, no-value market reference contract. No settlement authority. */
export const MARKET_VERSION = "voidpay.market.v0" as const;
export const MARKET_ROUTE_PREFIX = "/v0/market/" as const;
export const MAX_TEXT_BYTES = 65_536;
export const MAX_BODY_BYTES = 262_144;
export type MarketVersion = typeof MARKET_VERSION;
export type Digest = string;
export type AtomicAmount = string;
export type Fixture = Readonly<{ mode: "fixture"; paid: false }>;
export type AuthContext = Readonly<{ tenantId: string; subjectId: string; appId: string }>;
export type StringSchema = Readonly<{ kind: "utf8-string"; maxBytes: number }>;
export type ServiceRef = Readonly<{
  providerId: string; serviceId: string; version: string; definitionDigest: Digest;
}>;
export type ServiceDefinition = Readonly<{
  version: MarketVersion;
  providerId: string;
  serviceId: string;
  serviceVersion: string;
  title: string;
  description: string;
  inputSchema: StringSchema;
  outputSchema: StringSchema;
  chain: string;
  asset: string;
  recipient: string;
  amount: AtomicAmount;
  paymentTerms: "fixture-no-payment";
  retentionSeconds: number;
}>;
export type Availability = "active" | "paused" | "retired";
export type ServiceListing = Fixture & Readonly<{
  service: ServiceRef; definition: ServiceDefinition; availability: Availability;
}>;
export type DataSelection = Readonly<{
  inputHandle: string; inputDigest: Digest; inputByteLength: number;
}>;
export type GrantSpec = Readonly<{
  serviceVersions: readonly ServiceRef[];
  dataSelections: readonly DataSelection[];
  chain: string;
  asset: string;
  recipients: readonly string[];
  maxPerJob: AtomicAmount;
  maxTotal: AtomicAmount;
  expiresAt: string;
}>;
export type Grant = Fixture & GrantSpec & Readonly<{
  id: string;
  context: AuthContext;
  status: "active" | "revoked";
  createdAt: string;
  heldAmount: AtomicAmount;
  spentAmount: AtomicAmount;
}>;
export type QuoteBody = Fixture & Readonly<{
  version: MarketVersion;
  quoteId: string;
  context: AuthContext;
  grantId: string;
  service: ServiceRef;
  inputHandle: string;
  inputDigest: Digest;
  inputByteLength: number;
  chain: string;
  asset: string;
  recipient: string;
  amount: AtomicAmount;
  paymentTermsDigest: Digest;
  issuedAt: string;
  expiresAt: string;
  deliveryDeadline: string;
  authenticity: "fixture-assertion";
}>;
export type Quote = QuoteBody & Readonly<{ quoteDigest: Digest }>;
export type SubmitJob = Readonly<{
  quoteId: string;
  quoteDigest: Digest;
  grantId: string;
  inputHandle: string;
  idempotencyKey: string;
}>;
export type PaymentState = "not_started" | "authorization_pending" | "authorized" |
  "confirmation_pending" | "confirmed" | "unknown" | "failed";
export type ExecutionState = "not_started" | "accepted" | "running" | "delivered" | "failed" | "unknown";
export type VerificationState = "not_available" | "pending" | "verified" | "failed";
export type JobResult = Fixture & Readonly<{
  jobId: string;
  quoteDigest: Digest;
  definitionDigest: Digest;
  inputDigest: Digest;
  output: string;
  outputDigest: Digest;
  outputByteLength: number;
}>;
export type JobSnapshot = Fixture & Readonly<{
  version: MarketVersion;
  id: string;
  context: AuthContext;
  grantId: string;
  quoteId: string;
  quoteDigest: Digest;
  submissionDigest: Digest;
  inputHandle: string;
  inputDigest: Digest;
  service: ServiceRef;
  amount: AtomicAmount;
  paymentState: PaymentState;
  executionState: ExecutionState;
  verificationState: VerificationState;
  createdAt: string;
  updatedAt: string;
  result?: JobResult;
}>;
export interface MarketRequests {
  findServices: Readonly<{ query?: string }>;
  getQuote: Readonly<{ grantId: string; service: ServiceRef; inputHandle: string }>;
  submitJob: SubmitJob;
  getJob: Readonly<{ jobId: string }>;
  recoverJob: Readonly<{ jobId: string }>;
  createGrant: GrantSpec;
  getGrant: Readonly<{ grantId: string }>;
  revokeGrant: Readonly<{ grantId: string }>;
  publishServiceVersion: Readonly<{ definition: ServiceDefinition }>;
  setServiceAvailability: Readonly<{ service: ServiceRef; availability: Availability }>;
}
export interface MarketResponses {
  findServices: Readonly<{ services: readonly ServiceListing[] }>;
  getQuote: Quote;
  submitJob: JobSnapshot;
  getJob: JobSnapshot;
  recoverJob: JobSnapshot;
  createGrant: Grant;
  getGrant: Grant;
  revokeGrant: Grant;
  publishServiceVersion: ServiceListing;
  setServiceAvailability: ServiceListing;
}
export const ROUTINE_OPERATIONS = ["findServices", "getQuote", "submitJob", "getJob", "recoverJob"] as const;
export const ADMIN_OPERATIONS = ["createGrant", "getGrant", "revokeGrant", "publishServiceVersion", "setServiceAvailability"] as const;
export const MARKET_OPERATIONS = [...ROUTINE_OPERATIONS, ...ADMIN_OPERATIONS] as const;
export type MarketOperation = keyof MarketRequests;
export type RoutineOperation = typeof ROUTINE_OPERATIONS[number];
export type AdminOperation = typeof ADMIN_OPERATIONS[number];
export const ERROR_CODES = [
  "AUTH_REQUIRED", "FORBIDDEN", "INVALID_INPUT", "UNSUPPORTED_VERSION",
  "SERVICE_UNAVAILABLE", "QUOTE_EXPIRED", "QUOTE_INVALID", "QUOTE_USED",
  "GRANT_EXPIRED", "GRANT_REVOKED", "AUTHORIZATION_REQUIRED", "BUDGET_EXHAUSTED",
  "IDEMPOTENCY_CONFLICT", "JOB_NOT_FOUND", "GRANT_NOT_FOUND", "INPUT_NOT_FOUND",
  "SERVICE_NOT_FOUND", "SERVICE_VERSION_CONFLICT", "RESULT_NOT_READY", "RESULT_INVALID",
  "TEMPORARILY_UNAVAILABLE", "TRANSPORT_UNKNOWN", "HTTP_ERROR", "INVALID_RESPONSE",
  "RESPONSE_TOO_LARGE", "TIMEOUT", "REDIRECT_REFUSED",
] as const;
export type MarketErrorCode = typeof ERROR_CODES[number];
export type MarketErrorBody = Readonly<{ code: MarketErrorCode; message: string; retryable: boolean }>;
export type SuccessEnvelope<T> = Fixture & Readonly<{ version: MarketVersion; data: T }>;
export type ErrorEnvelope = Fixture & Readonly<{ version: MarketVersion; error: MarketErrorBody }>;
export class MarketError extends Error {
  readonly code: MarketErrorCode;
  readonly retryable: boolean;
  constructor(code: MarketErrorCode, message: string = code, retryable = false) {
    super(message);
    this.name = "MarketError";
    this.code = code;
    this.retryable = retryable;
  }
}

function invalid(): never { throw new MarketError("INVALID_INPUT", "Value does not match the market v0 profile."); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== "string")) return invalid();
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if ((!required.includes(key) && !optional.includes(key)) || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    out[key] = descriptor.value as unknown;
  }
  if (required.some(k => !Object.hasOwn(out, k))) return invalid();
  return out;
}
export function utf8ByteLength(value: string, max = MAX_TEXT_BYTES): number {
  if (typeof value !== "string" || value.length > max || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return invalid();
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > max) return invalid();
  return bytes;
}
function textValue(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.length === 0)) return invalid();
  utf8ByteLength(value, max);
  return value;
}
function id(value: unknown): string {
  const parsed = textValue(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parsed)) return invalid();
  return parsed;
}
function digest(value: unknown): Digest {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
export function parseAmount(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return invalid();
  return parsed;
}
function amount(value: unknown): AtomicAmount { parseAmount(value); return value as string; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return invalid();
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return invalid();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}
function array<T>(value: unknown, parse: (item: unknown) => T, max: number, min = 1): readonly T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: T[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = descriptors[String(i)];
    if (!d || !("value" in d)) return invalid();
    result.push(parse(d.value));
  }
  return Object.freeze(result);
}
function unique<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  if (new Set(items.map(key)).size !== items.length) return invalid();
  return items;
}
function fixture(r: Record<string, unknown>): Fixture {
  if (r.mode !== "fixture" || r.paid !== false) return invalid();
  return { mode: "fixture", paid: false };
}
function version(value: unknown): MarketVersion {
  if (value !== MARKET_VERSION) return invalid();
  return MARKET_VERSION;
}
export function parseContext(value: unknown): AuthContext {
  const r = record(value, ["tenantId", "subjectId", "appId"]);
  return Object.freeze({ tenantId: id(r.tenantId), subjectId: id(r.subjectId), appId: id(r.appId) });
}
export function sameContext(a: AuthContext, b: AuthContext): boolean {
  return a.tenantId === b.tenantId && a.subjectId === b.subjectId && a.appId === b.appId;
}
export function parseServiceRef(value: unknown): ServiceRef {
  const r = record(value, ["providerId", "serviceId", "version", "definitionDigest"]);
  return Object.freeze({ providerId: id(r.providerId), serviceId: id(r.serviceId), version: id(r.version), definitionDigest: digest(r.definitionDigest) });
}
export function sameService(a: ServiceRef, b: ServiceRef): boolean {
  return a.providerId === b.providerId && a.serviceId === b.serviceId && a.version === b.version && a.definitionDigest === b.definitionDigest;
}
function stringSchema(value: unknown): StringSchema {
  const r = record(value, ["kind", "maxBytes"]);
  return Object.freeze({ kind: choice(r.kind, ["utf8-string"]), maxBytes: integer(r.maxBytes, 1, MAX_TEXT_BYTES) });
}
const DEFINITION_KEYS = ["version", "providerId", "serviceId", "serviceVersion", "title", "description", "inputSchema", "outputSchema", "chain", "asset", "recipient", "amount", "paymentTerms", "retentionSeconds"] as const;
export function parseServiceDefinition(value: unknown): ServiceDefinition {
  const r = record(value, DEFINITION_KEYS);
  return Object.freeze({ version: version(r.version), providerId: id(r.providerId), serviceId: id(r.serviceId), serviceVersion: id(r.serviceVersion), title: textValue(r.title, 120), description: textValue(r.description, 2_000), inputSchema: stringSchema(r.inputSchema), outputSchema: stringSchema(r.outputSchema), chain: id(r.chain), asset: id(r.asset), recipient: id(r.recipient), amount: amount(r.amount), paymentTerms: choice(r.paymentTerms, ["fixture-no-payment"]), retentionSeconds: integer(r.retentionSeconds, 0, 604_800) });
}
export function parseServiceListing(value: unknown): ServiceListing {
  const r = record(value, ["mode", "paid", "service", "definition", "availability"]);
  const service = parseServiceRef(r.service);
  const definition = parseServiceDefinition(r.definition);
  if (service.providerId !== definition.providerId || service.serviceId !== definition.serviceId || service.version !== definition.serviceVersion) return invalid();
  return Object.freeze({ ...fixture(r), service, definition, availability: choice(r.availability, ["active", "paused", "retired"]) });
}
export function parseDataSelection(value: unknown): DataSelection {
  const r = record(value, ["inputHandle", "inputDigest", "inputByteLength"]);
  return Object.freeze({ inputHandle: id(r.inputHandle), inputDigest: digest(r.inputDigest), inputByteLength: integer(r.inputByteLength, 0, MAX_TEXT_BYTES) });
}
const GRANT_SPEC_KEYS = ["serviceVersions", "dataSelections", "chain", "asset", "recipients", "maxPerJob", "maxTotal", "expiresAt"] as const;
function grantSpec(r: Record<string, unknown>): GrantSpec {
  const maxPerJob = amount(r.maxPerJob), maxTotal = amount(r.maxTotal);
  if (parseAmount(maxPerJob) < 1 || parseAmount(maxTotal) < 1 || parseAmount(maxPerJob) > parseAmount(maxTotal)) return invalid();
  return {
    serviceVersions: unique(array(r.serviceVersions, parseServiceRef, 16), s => JSON.stringify(serviceTuple(s))),
    dataSelections: unique(array(r.dataSelections, parseDataSelection, 16), s => s.inputHandle),
    chain: id(r.chain), asset: id(r.asset), recipients: unique(array(r.recipients, id, 16), s => s),
    maxPerJob, maxTotal, expiresAt: timestamp(r.expiresAt),
  };
}
export function parseGrantSpec(value: unknown): GrantSpec { return Object.freeze(grantSpec(record(value, GRANT_SPEC_KEYS))); }
export function parseGrant(value: unknown): Grant {
  const r = record(value, [...GRANT_SPEC_KEYS, "mode", "paid", "id", "context", "status", "createdAt", "heldAmount", "spentAmount"]);
  const spec = grantSpec(r), heldAmount = amount(r.heldAmount), spentAmount = amount(r.spentAmount);
  if (parseAmount(heldAmount) > parseAmount(spec.maxTotal) - parseAmount(spentAmount)) return invalid();
  return Object.freeze({ ...fixture(r), ...spec, id: id(r.id), context: parseContext(r.context), status: choice(r.status, ["active", "revoked"]), createdAt: timestamp(r.createdAt), heldAmount, spentAmount });
}
const QUOTE_KEYS = ["version", "mode", "paid", "quoteId", "context", "grantId", "service", "inputHandle", "inputDigest", "inputByteLength", "chain", "asset", "recipient", "amount", "paymentTermsDigest", "issuedAt", "expiresAt", "deliveryDeadline", "authenticity"] as const;
function quoteBody(r: Record<string, unknown>): QuoteBody {
  const issuedAt = timestamp(r.issuedAt), expiresAt = timestamp(r.expiresAt), deliveryDeadline = timestamp(r.deliveryDeadline);
  if (expiresAt <= issuedAt || deliveryDeadline < expiresAt) return invalid();
  return Object.freeze({ ...fixture(r), version: version(r.version), quoteId: id(r.quoteId), context: parseContext(r.context), grantId: id(r.grantId), service: parseServiceRef(r.service), inputHandle: id(r.inputHandle), inputDigest: digest(r.inputDigest), inputByteLength: integer(r.inputByteLength, 0, MAX_TEXT_BYTES), chain: id(r.chain), asset: id(r.asset), recipient: id(r.recipient), amount: amount(r.amount), paymentTermsDigest: digest(r.paymentTermsDigest), issuedAt, expiresAt, deliveryDeadline, authenticity: choice(r.authenticity, ["fixture-assertion"]) });
}
export function parseQuoteBody(value: unknown): QuoteBody { return quoteBody(record(value, QUOTE_KEYS)); }
export function parseQuote(value: unknown): Quote {
  const r = record(value, [...QUOTE_KEYS, "quoteDigest"]);
  return Object.freeze({ ...quoteBody(r), quoteDigest: digest(r.quoteDigest) });
}
export function parseSubmitJob(value: unknown): SubmitJob {
  const r = record(value, ["quoteId", "quoteDigest", "grantId", "inputHandle", "idempotencyKey"]);
  const idempotencyKey = id(r.idempotencyKey);
  if (idempotencyKey.length < 16) return invalid();
  return Object.freeze({ quoteId: id(r.quoteId), quoteDigest: digest(r.quoteDigest), grantId: id(r.grantId), inputHandle: id(r.inputHandle), idempotencyKey });
}
export function parseJobResult(value: unknown): JobResult {
  const r = record(value, ["mode", "paid", "jobId", "quoteDigest", "definitionDigest", "inputDigest", "output", "outputDigest", "outputByteLength"]);
  const output = textValue(r.output, MAX_TEXT_BYTES, false), outputByteLength = integer(r.outputByteLength, 0, MAX_TEXT_BYTES);
  if (utf8ByteLength(output) !== outputByteLength) return invalid();
  return Object.freeze({ ...fixture(r), jobId: id(r.jobId), quoteDigest: digest(r.quoteDigest), definitionDigest: digest(r.definitionDigest), inputDigest: digest(r.inputDigest), output, outputDigest: digest(r.outputDigest), outputByteLength });
}
export function parseJob(value: unknown): JobSnapshot {
  const r = record(value, ["version", "mode", "paid", "id", "context", "grantId", "quoteId", "quoteDigest", "submissionDigest", "inputHandle", "inputDigest", "service", "amount", "paymentState", "executionState", "verificationState", "createdAt", "updatedAt"], ["result"]);
  const out: JobSnapshot = {
    ...fixture(r), version: version(r.version), id: id(r.id), context: parseContext(r.context), grantId: id(r.grantId), quoteId: id(r.quoteId), quoteDigest: digest(r.quoteDigest), submissionDigest: digest(r.submissionDigest), inputHandle: id(r.inputHandle), inputDigest: digest(r.inputDigest), service: parseServiceRef(r.service), amount: amount(r.amount),
    paymentState: choice(r.paymentState, ["not_started", "authorization_pending", "authorized", "confirmation_pending", "confirmed", "unknown", "failed"]),
    executionState: choice(r.executionState, ["not_started", "accepted", "running", "delivered", "failed", "unknown"]),
    verificationState: choice(r.verificationState, ["not_available", "pending", "verified", "failed"]),
    createdAt: timestamp(r.createdAt), updatedAt: timestamp(r.updatedAt),
    ...(Object.hasOwn(r, "result") ? { result: parseJobResult(r.result) } : {}),
  };
  if (out.updatedAt < out.createdAt || (out.result !== undefined) !== (out.verificationState === "verified")) return invalid();
  if (out.result && (out.executionState !== "delivered" || out.result.jobId !== out.id || out.result.quoteDigest !== out.quoteDigest || out.result.definitionDigest !== out.service.definitionDigest || out.result.inputDigest !== out.inputDigest)) return invalid();
  return Object.freeze(out);
}
export function parseRequest<K extends MarketOperation>(operation: K, value: unknown): MarketRequests[K] {
  let out: unknown;
  switch (operation) {
    case "findServices": { const r = record(value, [], ["query"]); out = Object.hasOwn(r, "query") ? { query: textValue(r.query, 200, false) } : {}; break; }
    case "getQuote": { const r = record(value, ["grantId", "service", "inputHandle"]); out = { grantId: id(r.grantId), service: parseServiceRef(r.service), inputHandle: id(r.inputHandle) }; break; }
    case "submitJob": out = parseSubmitJob(value); break;
    case "getJob": case "recoverJob": { const r = record(value, ["jobId"]); out = { jobId: id(r.jobId) }; break; }
    case "createGrant": out = parseGrantSpec(value); break;
    case "getGrant": case "revokeGrant": { const r = record(value, ["grantId"]); out = { grantId: id(r.grantId) }; break; }
    case "publishServiceVersion": { const r = record(value, ["definition"]); out = { definition: parseServiceDefinition(r.definition) }; break; }
    case "setServiceAvailability": { const r = record(value, ["service", "availability"]); out = { service: parseServiceRef(r.service), availability: choice(r.availability, ["active", "paused", "retired"]) }; break; }
    default: return invalid();
  }
  return Object.freeze(out) as MarketRequests[K];
}
export function parseResponse<K extends MarketOperation>(operation: K, value: unknown): MarketResponses[K] {
  let out: unknown;
  switch (operation) {
    case "findServices": { const r = record(value, ["services"]); out = Object.freeze({ services: array(r.services, parseServiceListing, 32, 0) }); break; }
    case "getQuote": out = parseQuote(value); break;
    case "submitJob": case "getJob": case "recoverJob": out = parseJob(value); break;
    case "createGrant": case "getGrant": case "revokeGrant": out = parseGrant(value); break;
    case "publishServiceVersion": case "setServiceAvailability": out = parseServiceListing(value); break;
    default: return invalid();
  }
  return out as MarketResponses[K];
}
export function parseEnvelope<K extends MarketOperation>(operation: K, value: unknown): SuccessEnvelope<MarketResponses[K]> | ErrorEnvelope {
  const r = record(value, ["version", "mode", "paid"], ["data", "error"]);
  if (Object.hasOwn(r, "data") === Object.hasOwn(r, "error")) return invalid();
  const header = { version: version(r.version), ...fixture(r) };
  if (Object.hasOwn(r, "data")) return Object.freeze({ ...header, data: parseResponse(operation, r.data) });
  const e = record(r.error, ["code", "message", "retryable"]);
  if (typeof e.retryable !== "boolean") return invalid();
  return Object.freeze({ ...header, error: Object.freeze({ code: choice(e.code, ERROR_CODES), message: textValue(e.message, 500), retryable: e.retryable }) });
}

type TupleValue = string | number | boolean | readonly TupleValue[];
function contextTuple(c: AuthContext): readonly TupleValue[] { return [c.tenantId, c.subjectId, c.appId]; }
function serviceTuple(s: ServiceRef): readonly TupleValue[] { return [s.providerId, s.serviceId, s.version, s.definitionDigest]; }
async function hashBytes(bytes: Uint8Array): Promise<Digest> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
async function hashTuple(domain: string, fields: readonly TupleValue[]): Promise<Digest> {
  return hashBytes(new TextEncoder().encode(JSON.stringify([domain, MARKET_VERSION, ...fields])));
}
/** Hashes exact valid UTF-8 text. Private contents need not be sent to the relay. */
export async function hashText(value: string): Promise<Digest> {
  utf8ByteLength(value);
  return hashBytes(new TextEncoder().encode(value));
}
export async function hashServiceDefinition(value: ServiceDefinition): Promise<Digest> {
  const d = parseServiceDefinition(value);
  return hashTuple("voidpay.market.service", [d.providerId, d.serviceId, d.serviceVersion, d.title, d.description, [d.inputSchema.kind, d.inputSchema.maxBytes], [d.outputSchema.kind, d.outputSchema.maxBytes], d.chain, d.asset, d.recipient, d.amount, d.paymentTerms, d.retentionSeconds]);
}
export async function hashPaymentTerms(value: "fixture-no-payment"): Promise<Digest> {
  choice(value, ["fixture-no-payment"]);
  return hashTuple("voidpay.market.payment-terms", [value]);
}
export async function hashQuote(value: QuoteBody): Promise<Digest> {
  // Rebuild an explicit field tuple. This is an integrity digest, not a signature.
  const q = parseQuoteBody(value);
  return hashTuple("voidpay.market.quote", [q.quoteId, contextTuple(q.context), q.grantId, serviceTuple(q.service), q.inputHandle, q.inputDigest, q.inputByteLength, q.chain, q.asset, q.recipient, q.amount, q.paymentTermsDigest, q.issuedAt, q.expiresAt, q.deliveryDeadline, q.authenticity, q.mode, q.paid]);
}
export async function hashSubmission(context: AuthContext, value: SubmitJob): Promise<Digest> {
  const c = parseContext(context), s = parseSubmitJob(value);
  return hashTuple("voidpay.market.submission", [contextTuple(c), s.quoteId, s.quoteDigest, s.grantId, s.inputHandle, s.idempotencyKey]);
}
export async function verifyServiceListing(value: ServiceListing): Promise<ServiceListing> {
  const listing = parseServiceListing(value);
  if (await hashServiceDefinition(listing.definition) !== listing.service.definitionDigest) throw new MarketError("INVALID_RESPONSE", "Service definition digest does not match.");
  return listing;
}
export async function verifyQuote(value: Quote): Promise<Quote> {
  const q = parseQuote(value);
  const { quoteDigest, ...body } = q;
  if (await hashQuote(body) !== quoteDigest) throw new MarketError("QUOTE_INVALID", "Quote integrity digest does not match.");
  return q;
}
export async function verifyJobResult(value: JobSnapshot): Promise<JobSnapshot> {
  const job = parseJob(value);
  if (job.result && await hashText(job.result.output) !== job.result.outputDigest) throw new MarketError("RESULT_INVALID", "Result integrity digest does not match.");
  return job;
}
