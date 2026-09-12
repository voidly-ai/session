export const SIGNATURE_VERSION = "voidpay.market.signatures.v0" as const;
export type SignatureParsingOptions = Readonly<{ allowLoopbackHttp?: boolean }>;
type StatementBase = Readonly<{
  version: typeof SIGNATURE_VERSION; registryOrigin: string; providerId: string;
  keyId: string; issuedAt: string; expiresAt: string;
}>;
export type EnrollmentStatement = StatementBase & Readonly<{ kind: "enrollment"; challengeId: string; nonce: string }>;
export type ServiceAgreementStatement = StatementBase & Readonly<{ kind: "service-agreement"; definitionDigest: string }>;
export type QuoteCommitmentStatement = StatementBase & Readonly<{ kind: "quote-commitment"; quoteDigest: string }>;
export type Statement = EnrollmentStatement | ServiceAgreementStatement | QuoteCommitmentStatement;
export type SignedStatement = Readonly<{ statement: Statement; signatureHex: string }>;
export type TrustedProviderKey = Readonly<{
  registryOrigin: string; providerId: string; keyId: string; publicKeyHex: string;
  revoked: boolean; notBefore: string; expiresAt: string;
}>;
export type StatementExpectation = Readonly<{ kind: "enrollment"; challengeId: string; nonce: string }> |
  Readonly<{ kind: "service-agreement"; definitionDigest: string }> |
  Readonly<{ kind: "quote-commitment"; quoteDigest: string }>;
export type VerificationPolicy = Readonly<{
  trustedKey: TrustedProviderKey; expected: StatementExpectation; nowMs: number; allowLoopbackHttp?: boolean;
}>;
export type VerifiedStatement = Readonly<{ verified: true; statement: Statement; keyId: string }>;
export type Ed25519Support = Readonly<{ available: boolean; reason: "available" | "unavailable" | "self-test-failed" }>;
export type SignatureErrorCode = "INVALID_STATEMENT" | "INVALID_KEY" | "INVALID_SIGNATURE" |
  "CONTEXT_MISMATCH" | "KEY_REVOKED" | "KEY_NOT_VALID" | "STATEMENT_NOT_VALID" | "CRYPTO_UNAVAILABLE";
export class SignatureError extends Error {
  readonly code: SignatureErrorCode;
  constructor(code: SignatureErrorCode) { super(code); this.name = "SignatureError"; this.code = code; }
}
function fail(code: SignatureErrorCode = "INVALID_STATEMENT"): never { throw new SignatureError(code); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) fail();
    const d = descriptors[key]!;
    if (!d.enumerable || !("value" in d) || d.value === undefined || d.value === null) fail();
    output[key] = d.value;
  }
  if (required.some(key => !(key in output))) fail();
  return output;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) fail();
  return value;
}
function hex(value: unknown, bytes: number, code: SignatureErrorCode = "INVALID_STATEMENT"): string {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) fail(code);
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") fail(); return value; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail();
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) fail();
  return value;
}
function loopback(options: unknown): boolean {
  if (options === undefined) return false;
  const o = record(options, [], ["allowLoopbackHttp"]);
  return "allowLoopbackHttp" in o ? bool(o.allowLoopbackHttp) : false;
}
function origin(value: unknown, allowLoopbackHttp: boolean): string {
  if (typeof value !== "string" || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) fail();
  let url: URL;
  try { url = new URL(value); } catch { fail(); }
  if (url.origin !== value || url.username || url.password) fail();
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) fail();
  return value;
}
function expectation(value: unknown): StatementExpectation {
  if (typeof value !== "object" || value === null) fail();
  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  if (kind === "enrollment") {
    const o = record(value, ["kind", "challengeId", "nonce"]);
    return Object.freeze({ kind, challengeId: id(o.challengeId), nonce: hex(o.nonce, 32) });
  }
  if (kind === "service-agreement") {
    const o = record(value, ["kind", "definitionDigest"]);
    return Object.freeze({ kind, definitionDigest: hex(o.definitionDigest, 32) });
  }
  if (kind === "quote-commitment") {
    const o = record(value, ["kind", "quoteDigest"]);
    return Object.freeze({ kind, quoteDigest: hex(o.quoteDigest, 32) });
  }
  return fail();
}
export function parseStatement(value: unknown, options?: SignatureParsingOptions): Statement {
  const allow = loopback(options);
  if (typeof value !== "object" || value === null) fail();
  const kind = Object.getOwnPropertyDescriptor(value, "kind")?.value;
  const tail = kind === "enrollment" ? ["challengeId", "nonce"] : kind === "service-agreement" ? ["definitionDigest"] : kind === "quote-commitment" ? ["quoteDigest"] : fail();
  const o = record(value, ["version", "kind", "registryOrigin", "providerId", "keyId", "issuedAt", "expiresAt", ...tail]);
  if (o.version !== SIGNATURE_VERSION) fail();
  const fields = Object.fromEntries(["kind", ...tail].map(key => [key, o[key]]));
  const statement = Object.freeze({ version: SIGNATURE_VERSION, registryOrigin: origin(o.registryOrigin, allow),
    providerId: id(o.providerId), keyId: hex(o.keyId, 32), issuedAt: timestamp(o.issuedAt), expiresAt: timestamp(o.expiresAt), ...expectation(fields) });
  if (statement.issuedAt >= statement.expiresAt) fail();
  return statement;
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16));
}
function toHex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, "0")).join(""); }
const FIELD_P = bytes("ed" + "ff".repeat(30) + "7f");
const SCALAR_L = bytes("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
const SMALL_ORDER_Y = new Set([
  "00".repeat(32), "01" + "00".repeat(31), "ec" + "ff".repeat(30) + "7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
]);
function lessLE(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = a.length - 1; i >= 0; i--) { if (a[i] !== b[i]) return a[i]! < b[i]!; }
  return false;
}
function point(value: string, code: SignatureErrorCode): Uint8Array<ArrayBuffer> {
  const raw = bytes(hex(value, 32, code));
  const y = raw.slice(); y[31] = y[31]! & 0x7f;
  if (!lessLE(y, FIELD_P) || SMALL_ORDER_Y.has(toHex(y.buffer))) fail(code);
  return raw;
}
function signature(value: unknown): string {
  const s = hex(value, 64, "INVALID_SIGNATURE");
  point(s.slice(0, 64), "INVALID_SIGNATURE");
  if (!lessLE(bytes(s.slice(64)), SCALAR_L)) fail("INVALID_SIGNATURE");
  return s;
}
export function parseSignedStatement(value: unknown, options?: SignatureParsingOptions): SignedStatement {
  const o = record(value, ["statement", "signatureHex"]);
  return Object.freeze({ statement: parseStatement(o.statement, options), signatureHex: signature(o.signatureHex) });
}
function tuple(s: Statement): readonly string[] {
  return [s.version, s.kind, s.registryOrigin, s.providerId, s.keyId, s.issuedAt, s.expiresAt,
    ...(s.kind === "enrollment" ? [s.challengeId, s.nonce] : s.kind === "service-agreement" ? [s.definitionDigest] : [s.quoteDigest])];
}
export function encodeStatement(value: unknown, options?: SignatureParsingOptions): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(tuple(parseStatement(value, options))));
}
type Runtime = { subtle: SubtleCrypto; importKey: SubtleCrypto["importKey"]; verify: SubtleCrypto["verify"]; digest: SubtleCrypto["digest"] };
function runtime(): Runtime | undefined {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.importKey !== "function" || typeof subtle.verify !== "function" || typeof subtle.digest !== "function") return undefined;
    return { subtle, importKey: subtle.importKey, verify: subtle.verify, digest: subtle.digest };
  } catch { return undefined; }
}
const supportCache = new WeakMap<SubtleCrypto, Runtime & { result: Promise<Ed25519Support> }>();
const RFC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_SIGNATURE = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
function support(available: boolean, reason: Ed25519Support["reason"]): Ed25519Support { return Object.freeze({ available, reason }); }
async function profileVerify(r: Runtime, publicHex: string, signatureHex: string, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = point(publicHex, "INVALID_KEY"); signature(signatureHex); }
  catch (error) { if (error instanceof SignatureError) return false; throw error; }
  const key = await r.importKey.call(r.subtle, "raw", raw, "Ed25519", false, ["verify"]);
  return await r.verify.call(r.subtle, "Ed25519", key, bytes(signatureHex), message);
}
async function probe(r: Runtime): Promise<Ed25519Support> {
  try {
    if (!await profileVerify(r, RFC_KEY, RFC_SIGNATURE, new Uint8Array())) return support(false, "self-test-failed");
    if (await profileVerify(r, RFC_KEY, RFC_SIGNATURE, new Uint8Array([1]))) return support(false, "self-test-failed");
    const mutation = "e4" + RFC_SIGNATURE.slice(2);
    if (await profileVerify(r, RFC_KEY, mutation, new Uint8Array())) return support(false, "self-test-failed");
    const identity = "01" + "00".repeat(31);
    const negatives: [string, string][] = [[RFC_KEY, RFC_SIGNATURE.slice(0, 64) + toHex(SCALAR_L.buffer)]];
    for (const y of [...SMALL_ORDER_Y, toHex(FIELD_P.buffer), "ee" + "ff".repeat(30) + "7f"]) {
      negatives.push([y, RFC_SIGNATURE], [RFC_KEY, y + "00".repeat(32)]);
      const signBit = bytes(y); signBit[31] = signBit[31]! | 0x80;
      negatives.push([toHex(signBit.buffer), RFC_SIGNATURE], [RFC_KEY, toHex(signBit.buffer) + "00".repeat(32)]);
    }
    negatives.push([identity, identity + "00".repeat(32)]);
    for (const [publicHex, signatureHex] of negatives) {
      if (await profileVerify(r, publicHex, signatureHex, new Uint8Array())) return support(false, "self-test-failed");
    }
    const digest = await r.digest.call(r.subtle, "SHA-256", new Uint8Array());
    if (toHex(digest) !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") return support(false, "self-test-failed");
    return support(true, "available");
  } catch { return support(false, "unavailable"); }
}
function supportFor(r: Runtime): Promise<Ed25519Support> {
  const cached = supportCache.get(r.subtle);
  if (cached && cached.importKey === r.importKey && cached.verify === r.verify && cached.digest === r.digest) return cached.result;
  const result = probe(r); supportCache.set(r.subtle, { ...r, result }); return result;
}
export function getEd25519Support(): Promise<Ed25519Support> {
  const r = runtime(); return r ? supportFor(r) : Promise.resolve(support(false, "unavailable"));
}
export async function verifyEd25519Bytes(publicKeyHex: string, signatureHex: string, message: Uint8Array): Promise<boolean> {
  let captured: Uint8Array<ArrayBuffer>;
  try {
    const size = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!.call(message);
    if (size > 65536 || Object.getPrototypeOf(message) !== Uint8Array.prototype) fail("INVALID_SIGNATURE");
    captured = new Uint8Array(message);
    point(publicKeyHex, "INVALID_KEY"); signature(signatureHex);
  } catch (error) { if (error instanceof SignatureError) throw error; return fail("INVALID_SIGNATURE"); }
  const r = runtime(); if (!r || !(await supportFor(r)).available) fail("CRYPTO_UNAVAILABLE");
  try { return await profileVerify(r, publicKeyHex, signatureHex, captured); }
  catch (error) { if (error instanceof SignatureError) throw error; return fail("CRYPTO_UNAVAILABLE"); }
}
export async function deriveProviderKeyId(publicKeyHex: string): Promise<string> {
  const raw = point(publicKeyHex, "INVALID_KEY"); const r = runtime();
  if (!r) fail("CRYPTO_UNAVAILABLE");
  try { return toHex(await r.digest.call(r.subtle, "SHA-256", raw)); } catch { return fail("CRYPTO_UNAVAILABLE"); }
}
export async function verifyStatement(value: unknown, policy: VerificationPolicy): Promise<VerifiedStatement> {
  const p = record(policy, ["trustedKey", "expected", "nowMs"], ["allowLoopbackHttp"]);
  const allow = "allowLoopbackHttp" in p ? bool(p.allowLoopbackHttp) : false;
  const envelope = parseSignedStatement(value, { allowLoopbackHttp: allow });
  const expected = expectation(p.expected);
  const k = record(p.trustedKey, ["registryOrigin", "providerId", "keyId", "publicKeyHex", "revoked", "notBefore", "expiresAt"]);
  const key = Object.freeze({ registryOrigin: origin(k.registryOrigin, allow), providerId: id(k.providerId), keyId: hex(k.keyId, 32),
    publicKeyHex: hex(k.publicKeyHex, 32, "INVALID_KEY"), revoked: bool(k.revoked), notBefore: timestamp(k.notBefore), expiresAt: timestamp(k.expiresAt) });
  const raw = point(key.publicKeyHex, "INVALID_KEY");
  if (typeof p.nowMs !== "number" || !Number.isSafeInteger(p.nowMs) || p.nowMs < 0) fail();
  const now = p.nowMs; const s = envelope.statement;
  if (key.revoked) fail("KEY_REVOKED");
  if (key.notBefore >= key.expiresAt || now < Date.parse(key.notBefore) || now >= Date.parse(key.expiresAt)) fail("KEY_NOT_VALID");
  if (s.issuedAt < key.notBefore || s.expiresAt > key.expiresAt || now < Date.parse(s.issuedAt) || now >= Date.parse(s.expiresAt)) fail("STATEMENT_NOT_VALID");
  if (s.registryOrigin !== key.registryOrigin || s.providerId !== key.providerId || s.keyId !== key.keyId || s.kind !== expected.kind) fail("CONTEXT_MISMATCH");
  const actual = s.kind === "enrollment" ? { kind: s.kind, challengeId: s.challengeId, nonce: s.nonce } :
    s.kind === "service-agreement" ? { kind: s.kind, definitionDigest: s.definitionDigest } : { kind: s.kind, quoteDigest: s.quoteDigest };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("CONTEXT_MISMATCH");
  const message = new TextEncoder().encode(JSON.stringify(tuple(s)));
  const r = runtime(); if (!r || !(await supportFor(r)).available) fail("CRYPTO_UNAVAILABLE");
  try {
    if (toHex(await r.digest.call(r.subtle, "SHA-256", raw)) !== key.keyId) fail("INVALID_KEY");
    if (!await profileVerify(r, key.publicKeyHex, envelope.signatureHex, message)) fail("INVALID_SIGNATURE");
  } catch (error) { if (error instanceof SignatureError) throw error; fail("CRYPTO_UNAVAILABLE"); }
  return Object.freeze({ verified: true, statement: s, keyId: key.keyId });
}
