import nacl from "tweetnacl";
import { sha256Hex } from "./protocol";
import { automaticCanonicalJson } from "./automaticCanonical";
import { parsePublicExercise, proofArtworkSvg, PublicExerciseError, runPublicExercise, runSessionsSelfTest,
  SESSIONS_PROOFS_PROVIDER, SESSIONS_PROOFS_TASK, type PublicExercise } from "./proofs";

export const AUTOMATIC_HANDOFF_SCHEMA = "voidpay.proof-collection.agent-handoff/v4" as const;
export const AUTOMATIC_TASK = Object.freeze({ id: "sessions-auto-save-01", version: 1,
  acceptance_rule_sha256: "b58e042e088740892856e96f4c8eee079bd94819c518e8e486ef250184ffb230" });
export const AUTOMATIC_BASE = "https://api.voidly.ai/v4/proofs/collections";
export const AUTOMATIC_ISSUER = "https://api.voidly.ai/v2/proofs/collections/issuer";
export const AUTOMATIC_RECEIPT_DOMAIN = "voidpay-proof-collection-receipt/v4\n";
export const AUTOMATIC_RUN_BINDING_DOMAIN = "voidpay-proof-collection-run-binding/v4\n";
export const AUTOMATIC_SCOPE = "public-provider-discovery-and-owner-preauthorized-private-save-only";
export const AUTOMATIC_HANDOFF_MAX_BYTES = 1024;
export const AUTOMATIC_BOUNDARY = Object.freeze({ decision: "STOP", wallet_required: false, payment_action_allowed: false,
  authorization_created: false, transaction_broadcast: false, settlement_observed: false, reward_offered: false,
  reward_amount: "0", reward_asset: null, customer_identity_verified: false, commercial_transaction: false,
  credited_to_traction_metrics: false, unique_person_verified: false, impact_verified: false });
const SERVER_CHECKS = ["owner_preauthorized", "challenge_unexpired", "provider_pair_listed", "manifest_verified", "wrong_pin_refused"] as const;
const CLAIMANT_CHECKS = ["manifest_digest_matches", "challenge_response_matches"] as const;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RETENTION_MS = 15_552_000_000;
const MAX_RESPONSE_BYTES = 32768;
const MAX_ATTEMPTS = 3;

export type AutomaticHandoff = { schema: typeof AUTOMATIC_HANDOFF_SCHEMA; run_id: string; completion_capability: string };
export type AutomaticProofErrorCode = "handoff_invalid" | "self_test_failed" | "response_invalid" | "issuer_invalid"
  | "receipt_invalid" | "completion_unavailable" | "completion_uncertain" | "permission_refused"
  | "run_expired_or_revoked" | "rate_limited" | "attempts_exhausted" | "provider_check_failed";
export class AutomaticProofError extends Error {
  constructor(readonly code: AutomaticProofErrorCode) { super(code); this.name = "AutomaticProofError"; }
}
class AutomaticHttpError extends AutomaticProofError {
  constructor(code: AutomaticProofErrorCode, readonly status: number) { super(code); }
}
function requireCondition(value: unknown, code: AutomaticProofErrorCode): asserts value {
  if (!value) throw new AutomaticProofError(code);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function same(value: unknown, expected: Record<string, unknown>): boolean {
  return exact(value, Object.keys(expected)) && JSON.stringify(value, Object.keys(expected).sort()) === JSON.stringify(expected, Object.keys(expected).sort());
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function unhex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16)); }

export function parseAutomaticHandoff(text: string): AutomaticHandoff {
  requireCondition(typeof text === "string" && new TextEncoder().encode(text).length <= AUTOMATIC_HANDOFF_MAX_BYTES, "handoff_invalid");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AutomaticProofError("handoff_invalid"); }
  requireCondition(exact(value, ["schema", "run_id", "completion_capability"]) && value.schema === AUTOMATIC_HANDOFF_SCHEMA
    && typeof value.run_id === "string" && HEX32.test(value.run_id)
    && typeof value.completion_capability === "string" && HEX64.test(value.completion_capability), "handoff_invalid");
  return { schema: AUTOMATIC_HANDOFF_SCHEMA, run_id: value.run_id, completion_capability: value.completion_capability };
}

type AutomaticRequest = "exercise" | "submit" | "result" | "issuer";
async function requestJson(kind: AutomaticRequest, handoff: AutomaticHandoff, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const url = kind === "issuer" ? AUTOMATIC_ISSUER : `${AUTOMATIC_BASE}/${kind}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const deadlineAt = performance.now() + (kind === "submit" ? 20000 : 10000);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new AutomaticProofError("completion_unavailable")); }, kind === "submit" ? 20000 : 10000);
  });
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (kind !== "issuer") { headers["content-type"] = "application/json"; headers.authorization = `Bearer ${handoff.completion_capability}`; }
    const fetched = Promise.resolve(fetchImpl(url, { method: kind === "issuer" ? "GET" : "POST", headers,
      ...(kind === "issuer" ? {} : { body: JSON.stringify(body) }), redirect: "error", credentials: "omit",
      cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal })).then(value => {
        if (controller.signal.aborted) {
          if (value.body && !value.body.locked) void value.body.cancel().catch(() => {});
          throw new AutomaticProofError("completion_unavailable");
        }
        return value;
      });
    response = await Promise.race([fetched, deadline]);
    requireCondition(performance.now() < deadlineAt, "completion_unavailable");
    requireCondition(!response.redirected && response.type !== "opaqueredirect" && (response.url === "" || response.url === url)
      && response.status !== 0 && !(response.status >= 300 && response.status < 400), "response_invalid");
    if (response.status >= 500) throw new AutomaticHttpError("completion_unavailable", response.status);
    requireCondition(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") && response.body, "response_invalid");
    const length = response.headers.get("content-length");
    requireCondition(length === null || /^\d+$/.test(length) && Number(length) <= MAX_RESPONSE_BYTES, "response_invalid");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0; let reads = 0; let emptyReads = 0;
    for (;;) {
      requireCondition(performance.now() < deadlineAt, "completion_unavailable");
      requireCondition(++reads <= 2048, "response_invalid");
      const next = await Promise.race([reader.read(), deadline]);
      requireCondition(performance.now() < deadlineAt, "completion_unavailable");
      if (next.done) break;
      if (next.value.byteLength === 0) { requireCondition(++emptyReads <= 128, "response_invalid"); continue; }
      size += next.value.byteLength;
      requireCondition(size <= MAX_RESPONSE_BYTES, "response_invalid");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new AutomaticProofError("response_invalid"); }
    requireCondition(!JSON.stringify(value).includes(handoff.completion_capability), "response_invalid");
    if (!response.ok) {
      requireCondition(exact(value, ["schema", "ok", "error"]) && value.schema === "voidpay.proof-collection.error/v4"
        && value.ok === false && exact(value.error, ["code"]) && typeof value.error.code === "string", "response_invalid");
      const code = response.status === 401 || response.status === 403 ? "permission_refused"
        : response.status === 404 || response.status === 410 ? "run_expired_or_revoked"
        : response.status === 429 ? (value.error.code === "verifier_attempts_exhausted" ? "attempts_exhausted" : "rate_limited") : "completion_unavailable";
      throw new AutomaticHttpError(code, response.status);
    }
    return value;
  } catch (error) {
    if (error instanceof AutomaticProofError) throw error;
    throw new AutomaticProofError("completion_unavailable");
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}

async function issuerKeys(handoff: AutomaticHandoff, fetchImpl: typeof fetch): Promise<Map<string, string>> {
  const value = await requestJson("issuer", handoff, undefined, fetchImpl);
  requireCondition(exact(value, ["schema", "issuer", "keys", "unknown_key_policy"])
    && value.schema === "voidpay.proof-collection.issuer/v2" && value.issuer === AUTOMATIC_ISSUER
    && value.unknown_key_policy === "untrusted; never trust an embedded receipt key"
    && Array.isArray(value.keys) && value.keys.length > 0 && value.keys.length <= 8, "issuer_invalid");
  const keys = new Map<string, string>();
  for (const key of value.keys) {
    requireCondition(exact(key, ["issuer", "key_id", "algorithm", "public_key_hex", "status"])
      && key.issuer === AUTOMATIC_ISSUER && key.algorithm === "Ed25519" && key.status === "active"
      && typeof key.key_id === "string" && HEX64.test(key.key_id) && typeof key.public_key_hex === "string" && HEX64.test(key.public_key_hex)
      && !keys.has(key.key_id) && await sha256Hex(unhex(key.public_key_hex)) === key.key_id, "issuer_invalid");
    keys.set(key.key_id, key.public_key_hex);
  }
  return keys;
}

export type AutomaticReceipt = { statement: {
  schema: "voidpay.proof-collection.receipt/v4"; issuer: string; key_id: string; event_id: string;
  run_binding_sha256: string; exercise_binding_sha256: string; artwork: { recipe: "contours-v1"; seed: string };
  task: typeof AUTOMATIC_TASK; computation_task: typeof SESSIONS_PROOFS_TASK; checked_at: string; completed_at: string;
  outcome: "PASS"; checks: { server: Record<typeof SERVER_CHECKS[number], true>; claimant: Record<typeof CLAIMANT_CHECKS[number], true> };
  provider: { provider_did: string; manifest_url: string }; scope: typeof AUTOMATIC_SCOPE; boundary: typeof AUTOMATIC_BOUNDARY;
}; signature_hex: string };
export type VerifiedAutomaticProof = {
  schema: "voidly.session.automatic-proof/v1"; ok: true; saved_proof: true; event_id: string;
  visibility: "private" | "public"; already_completed: boolean; receipt: AutomaticReceipt;
  artwork: { recipe: "contours-v1"; seed: string; svg: string; sha256: string };
  return_url: "https://voidly.ai/pay/proofs"; payment_boundary: "STOP";
};

async function verifyComplete(value: unknown, handoff: AutomaticHandoff, fetchImpl: typeof fetch, now: number): Promise<VerifiedAutomaticProof> {
  requireCondition(exact(value, ["schema", "ok", "status", "run_id", "exercise", "record", "already_completed"])
    && value.schema === "voidpay.proof-collection.result/v4" && value.ok === true && value.status === "complete"
    && value.run_id === handoff.run_id && typeof value.already_completed === "boolean", "response_invalid");
  const record = value.record;
  requireCondition(exact(record, ["event_id", "visibility", "public_url", "expires_at", "receipt"])
    && typeof record.event_id === "string" && HEX32.test(record.event_id) && iso(record.expires_at)
    && (record.visibility === "private" || record.visibility === "public")
    && (value.already_completed || record.visibility === "private")
    && record.public_url === (record.visibility === "private" ? null : `https://api.voidly.ai/v2/proofs/collections/public/${record.event_id}`)
    && exact(record.receipt, ["statement", "signature_hex"]), "receipt_invalid");
  const receipt = record.receipt; const s = receipt.statement;
  requireCondition(exact(s, ["schema", "issuer", "key_id", "event_id", "run_binding_sha256", "exercise_binding_sha256", "artwork", "task", "computation_task",
    "checked_at", "completed_at", "outcome", "checks", "provider", "scope", "boundary"])
    && s.schema === "voidpay.proof-collection.receipt/v4" && s.issuer === AUTOMATIC_ISSUER && s.event_id === record.event_id
    && typeof s.key_id === "string" && HEX64.test(s.key_id) && typeof s.run_binding_sha256 === "string" && HEX64.test(s.run_binding_sha256)
    && typeof s.exercise_binding_sha256 === "string" && HEX64.test(s.exercise_binding_sha256)
    && typeof receipt.signature_hex === "string" && /^[0-9a-f]{128}$/.test(receipt.signature_hex)
    && same(s.task, AUTOMATIC_TASK) && same(s.computation_task, SESSIONS_PROOFS_TASK) && s.scope === AUTOMATIC_SCOPE
    && same(s.boundary, AUTOMATIC_BOUNDARY) && s.outcome === "PASS" && iso(s.checked_at) && iso(s.completed_at)
    && s.checked_at <= s.completed_at && Date.parse(s.completed_at) <= now + 30000
    && Date.parse(record.expires_at) === Date.parse(s.completed_at) + RETENTION_MS && Date.parse(record.expires_at) > now
    && same(s.provider, { provider_did: SESSIONS_PROOFS_PROVIDER.provider_did, manifest_url: SESSIONS_PROOFS_PROVIDER.manifest_url })
    && same(s.artwork, { recipe: "contours-v1", seed: record.event_id })
    && exact(s.checks, ["server", "claimant"]) && exact(s.checks.server, SERVER_CHECKS) && exact(s.checks.claimant, CLAIMANT_CHECKS)
    && [...Object.values(s.checks.server), ...Object.values(s.checks.claimant)].every(check => check === true), "receipt_invalid");
  let exercise: PublicExercise;
  try { exercise = parsePublicExercise(JSON.stringify(value.exercise), Date.parse(s.checked_at)); }
  catch { throw new AutomaticProofError("receipt_invalid"); }
  requireCondition(exercise.challenge_id === handoff.run_id && Date.parse(exercise.issued_at) <= Date.parse(s.checked_at)
    && Date.parse(exercise.expires_at) > Date.parse(s.completed_at)
    && await sha256Hex(new TextEncoder().encode(AUTOMATIC_RUN_BINDING_DOMAIN + handoff.run_id)) === s.run_binding_sha256
    && await sha256Hex(new TextEncoder().encode(automaticCanonicalJson(exercise))) === s.exercise_binding_sha256, "receipt_invalid");
  const keys = await issuerKeys(handoff, fetchImpl); const key = keys.get(s.key_id);
  requireCondition(key && nacl.sign.detached.verify(new TextEncoder().encode(AUTOMATIC_RECEIPT_DOMAIN + automaticCanonicalJson(s)), unhex(receipt.signature_hex), unhex(key)), "receipt_invalid");
  const svg = proofArtworkSvg(record.event_id);
  const result: VerifiedAutomaticProof = { schema: "voidly.session.automatic-proof/v1", ok: true, saved_proof: true,
    event_id: record.event_id, visibility: record.visibility, already_completed: value.already_completed,
    receipt: JSON.parse(JSON.stringify(receipt)) as AutomaticReceipt,
    artwork: { recipe: "contours-v1", seed: record.event_id, svg, sha256: await sha256Hex(new TextEncoder().encode(svg)) },
    return_url: "https://voidly.ai/pay/proofs", payment_boundary: "STOP" };
  requireCondition(!JSON.stringify(result).includes(handoff.completion_capability), "response_invalid");
  return result;
}
function pending(value: unknown, runId: string): boolean {
  return exact(value, ["schema", "ok", "status", "run_id", "record"]) && value.schema === "voidpay.proof-collection.result/v4"
    && value.ok === true && value.status === "pending" && value.run_id === runId && value.record === null;
}
function transient(error: unknown): boolean {
  return error instanceof AutomaticHttpError ? error.status === 409 || error.status >= 500
    : error instanceof AutomaticProofError && error.code === "completion_unavailable";
}

export async function completeAutomaticProof(text: string, options: { readonly fetchImpl?: typeof fetch; readonly nowMs?: number } = {}): Promise<VerifiedAutomaticProof> {
  const handoff = parseAutomaticHandoff(text);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = () => options.nowMs ?? Date.now();
  requireCondition((await runSessionsSelfTest()).ok, "self_test_failed");
  let mayHaveSaved = false;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const existing = await requestJson("result", handoff, { run_id: handoff.run_id }, fetchImpl);
        if (!pending(existing, handoff.run_id)) return await verifyComplete(existing, handoff, fetchImpl, now());
        const fresh = await requestJson("exercise", handoff, { run_id: handoff.run_id }, fetchImpl);
        if (exact(fresh, ["schema", "ok", "status", "run_id", "exercise", "record", "already_completed"])) return await verifyComplete(fresh, handoff, fetchImpl, now());
        requireCondition(exact(fresh, ["schema", "ok", "action", "run_id", "exercise"])
          && fresh.schema === "voidpay.proof-collection.response/v4" && fresh.ok === true && fresh.action === "exercise"
          && fresh.run_id === handoff.run_id, "response_invalid");
        const exercise = parsePublicExercise(JSON.stringify(fresh.exercise), now());
        requireCondition(exercise.challenge_id === handoff.run_id, "response_invalid");
        const result = await runPublicExercise(JSON.stringify(exercise), { fetchImpl, nowMs: options.nowMs });
        mayHaveSaved = true;
        const completed = await requestJson("submit", handoff, { run_id: handoff.run_id, result }, fetchImpl);
        return await verifyComplete(completed, handoff, fetchImpl, now());
      } catch (error) {
        if (error instanceof PublicExerciseError) {
          if (error.code !== "upstream_unavailable") throw new AutomaticProofError("provider_check_failed");
          error = new AutomaticProofError("completion_unavailable");
        }
        if (!transient(error)) throw error;
        if (attempt < MAX_ATTEMPTS - 1) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (mayHaveSaved) {
      try {
        const existing = await requestJson("result", handoff, { run_id: handoff.run_id }, fetchImpl);
        if (!pending(existing, handoff.run_id)) return await verifyComplete(existing, handoff, fetchImpl, now());
      } catch (error) { if (!transient(error)) throw error; }
    }
    throw new AutomaticProofError(mayHaveSaved ? "completion_uncertain" : "completion_unavailable");
  } finally {
    handoff.completion_capability = "";
  }
}
