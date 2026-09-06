import { canonicalBytes, sha256Hex, verifyProvider } from "./index";
import { PROOFS_FIXTURE, PROOFS_FIXTURE_DIGEST } from "./proofsFixture";
export { proofArtworkSvg } from "./proofsArtwork";

export const PUBLIC_EXERCISE_SCHEMA = "voidpay.proof-collection.public-exercise/v3" as const;
export const PUBLIC_RESULT_SCHEMA = "voidpay.proof-collection.public-result/v3" as const;
export const PUBLIC_RESPONSE_SCHEMA = "voidpay.proof-collection.public-response/v3" as const;
export const SESSIONS_PROOFS_TASK = Object.freeze({
  id: "sessions-public-check-01", version: 1,
  acceptance_rule_sha256: "1be9d67c2f8caffa45fd985b7454371838c29e4fadbd8dadc2a4e6663b0f7bc5",
});
export const SESSIONS_PROOFS_PROVIDER = Object.freeze({
  provider_did: "did:voidly:6rGTFa5apSnKNF14bGXZfu",
  manifest_url: "https://intelligence.voidly.ai:8443/.well-known/voidly-session-provider.json",
  index_url: "https://api.voidly.ai/v1/session/providers",
});
export const PUBLIC_EXERCISE_MAX_BYTES = 8192;
export const PUBLIC_EXERCISE_TTL_MS = 600000;
const WRONG_PIN = "did:voidly:2222222222222222";
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface PublicExercise {
  readonly schema: typeof PUBLIC_EXERCISE_SCHEMA;
  readonly task: typeof SESSIONS_PROOFS_TASK;
  readonly challenge_id: string;
  readonly challenge: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly provider: typeof SESSIONS_PROOFS_PROVIDER;
}
export interface PublicExerciseResult {
  readonly schema: typeof PUBLIC_RESULT_SCHEMA;
  readonly task: typeof SESSIONS_PROOFS_TASK;
  readonly challenge_id: string;
  readonly challenge: string;
  readonly manifest_digest_sha256: string;
  readonly challenge_response_sha256: string;
  readonly checks: {
    readonly provider_pair_listed: true;
    readonly manifest_verified: true;
    readonly wrong_pin_refused: true;
  };
}
export type PublicExerciseRefusal =
  | "exercise_invalid" | "exercise_expired" | "provider_not_listed"
  | "manifest_invalid" | "wrong_pin_not_refused" | "upstream_unavailable"
  | "upstream_redirect" | "upstream_too_large" | "upstream_not_json";
export class PublicExerciseError extends Error {
  readonly code: PublicExerciseRefusal;
  constructor(code: PublicExerciseRefusal) { super(code); this.name = "PublicExerciseError"; this.code = code; }
}
function requireCondition(value: unknown, code: PublicExerciseRefusal): asserts value {
  if (!value) throw new PublicExerciseError(code);
}
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function same(value: unknown, expected: Record<string, unknown>): boolean {
  return exact(value, Object.keys(expected)) && Object.entries(expected).every(([key, field]) => value[key] === field);
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parsePublicExercise(text: string, nowMs = Date.now()): PublicExercise {
  requireCondition(typeof text === "string" && new TextEncoder().encode(text).length <= PUBLIC_EXERCISE_MAX_BYTES, "exercise_invalid");
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new PublicExerciseError("exercise_invalid"); }
  requireCondition(exact(input, ["schema", "task", "challenge_id", "challenge", "issued_at", "expires_at", "provider"]), "exercise_invalid");
  requireCondition(input.schema === PUBLIC_EXERCISE_SCHEMA && same(input.task, SESSIONS_PROOFS_TASK)
    && same(input.provider, SESSIONS_PROOFS_PROVIDER) && typeof input.challenge_id === "string" && HEX32.test(input.challenge_id)
    && typeof input.challenge === "string" && HEX64.test(input.challenge) && iso(input.issued_at) && iso(input.expires_at), "exercise_invalid");
  requireCondition(Number.isFinite(nowMs) && Date.parse(input.expires_at) - Date.parse(input.issued_at) === PUBLIC_EXERCISE_TTL_MS
    && Date.parse(input.issued_at) <= nowMs + 30000, "exercise_invalid");
  requireCondition(Date.parse(input.expires_at) > nowMs, "exercise_expired");
  return {
    schema: PUBLIC_EXERCISE_SCHEMA, task: SESSIONS_PROOFS_TASK,
    challenge_id: input.challenge_id, challenge: input.challenge,
    issued_at: input.issued_at, expires_at: input.expires_at, provider: SESSIONS_PROOFS_PROVIDER,
  };
}

export async function runSessionsSelfTest() {
  const found = verifyProvider(PROOFS_FIXTURE, PROOFS_FIXTURE.provider_did);
  const wrong = verifyProvider(PROOFS_FIXTURE, WRONG_PIN);
  const altered = verifyProvider({ ...PROOFS_FIXTURE, accept_url: "https://changed.example.test/accept" }, PROOFS_FIXTURE.provider_did);
  const digest = found.ok ? await sha256Hex(canonicalBytes(found.provider.manifest)) : null;
  const checks = {
    signed_manifest_verified: found.ok,
    wrong_pin_refused: !wrong.ok && wrong.reason === "manifest_did_not_pinned",
    changed_manifest_refused: !altered.ok && altered.reason === "manifest_signature_invalid",
    canonical_digest_matches: digest === PROOFS_FIXTURE_DIGEST,
  };
  return {
    schema: "voidly.session.self-test/v1" as const,
    ok: Object.values(checks).every(Boolean), mode: "offline" as const, checks,
    network_requests: 0 as const, saved_proof: false as const,
  };
}

export async function verifyPublicExercise(
  exercise: PublicExercise, index: unknown, manifest: unknown, nowMs = Date.now(),
): Promise<PublicExerciseResult> {
  const parsed = parsePublicExercise(JSON.stringify(exercise), nowMs);
  requireCondition(plain(index) && Array.isArray(index.providers) && index.providers.length <= 1000
    && index.providers.some(entry => plain(entry) && entry.provider_did === SESSIONS_PROOFS_PROVIDER.provider_did
      && entry.manifest_url === SESSIONS_PROOFS_PROVIDER.manifest_url), "provider_not_listed");
  const verified = verifyProvider(manifest, SESSIONS_PROOFS_PROVIDER.provider_did);
  requireCondition(verified.ok, "manifest_invalid");
  const wrong = verifyProvider(verified.provider.manifest, WRONG_PIN);
  requireCondition(!wrong.ok && wrong.reason === "manifest_did_not_pinned", "wrong_pin_not_refused");
  const manifest_digest_sha256 = await sha256Hex(canonicalBytes(verified.provider.manifest));
  const challenge_response_sha256 = await sha256Hex(canonicalBytes({
    schema: PUBLIC_RESPONSE_SCHEMA, task: parsed.task, challenge_id: parsed.challenge_id,
    challenge: parsed.challenge, manifest_digest_sha256,
  }));
  return {
    schema: PUBLIC_RESULT_SCHEMA, task: parsed.task, challenge_id: parsed.challenge_id, challenge: parsed.challenge,
    manifest_digest_sha256, challenge_response_sha256,
    checks: { provider_pair_listed: true, manifest_verified: true, wrong_pin_refused: true },
  };
}

async function readFixedJson(url: string, maxBytes: number, fetchImpl: typeof fetch): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new PublicExerciseError("upstream_unavailable")); }, 8000);
  });
  try {
    const response = await Promise.race([fetchImpl(url, {
      method: "GET", headers: { accept: "application/json" }, redirect: "error",
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
    }), deadline]);
    requireCondition(!response.redirected && (response.url === "" || response.url === url), "upstream_redirect");
    requireCondition(response.ok && response.body, "upstream_unavailable");
    requireCondition(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""), "upstream_not_json");
    const contentLength = response.headers.get("content-length");
    requireCondition(contentLength === null || /^\d+$/.test(contentLength) && Number(contentLength) <= maxBytes, "upstream_too_large");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      requireCondition(size <= maxBytes, "upstream_too_large");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new PublicExerciseError("upstream_not_json"); }
  } catch (error) {
    if (error instanceof PublicExerciseError) throw error;
    throw new PublicExerciseError("upstream_unavailable");
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export async function runPublicExercise(
  text: string, options: { readonly fetchImpl?: typeof fetch; readonly nowMs?: number } = {},
): Promise<PublicExerciseResult> {
  const nowMs = options.nowMs ?? Date.now();
  const exercise = parsePublicExercise(text, nowMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const index = await readFixedJson(SESSIONS_PROOFS_PROVIDER.index_url, 262144, fetchImpl);
  const manifest = await readFixedJson(SESSIONS_PROOFS_PROVIDER.manifest_url, 65536, fetchImpl);
  return verifyPublicExercise(exercise, index, manifest, options.nowMs ?? Date.now());
}
