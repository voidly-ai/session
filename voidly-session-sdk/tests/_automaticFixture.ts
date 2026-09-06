import nacl from "tweetnacl";
import { canonicalBytes, sha256Hex } from "../src/index";
import { AUTOMATIC_BOUNDARY, AUTOMATIC_HANDOFF_SCHEMA, AUTOMATIC_ISSUER, AUTOMATIC_RECEIPT_DOMAIN,
  AUTOMATIC_RUN_BINDING_DOMAIN, AUTOMATIC_SCOPE, AUTOMATIC_TASK } from "../src/proofsAuto";
import { PUBLIC_EXERCISE_SCHEMA, SESSIONS_PROOFS_PROVIDER, SESSIONS_PROOFS_TASK } from "../src/proofs";

export const AUTO_NOW = Date.parse("2026-09-06T12:00:00.000Z");
export const PUBLIC_MANIFEST = {
  schema: "voidly.session.provider.manifest/v1", provider_did: "did:voidly:6rGTFa5apSnKNF14bGXZfu",
  signing_public_key_base64: "L16pOb+7U0Qjgs43s61D8KiLi6KRAJ1CpqszP6FzCyE=",
  encryption_public_key_base64: "BC4/bHqUQHnwt593WsVhgz1loPpUyESJV/Oy6SU5h1k=",
  attestor_public_key_base64: "Tnte/kj2Hod56mJtvT37BPNkWlyYGfdzDWA4x6/5p1Y=",
  accept_url: "https://intelligence.voidly.ai:8443/session/accept", hire_message_schema: "voidly-session-hire/v1",
  worker_base_url: "https://api.voidly.ai", grant_ttl_ms: { min: 300000, max: 21600000 }, acceptance_ttl_ms: 300000,
  services: [{ ref: "voidly.observatory.query/v1", description: "One observatory query, answered without the relay ever seeing the question or the answer.",
    price: { chain: "eip155:8453", asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      payee_account: "eip155:8453:0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912", min_amount: "50000", max_amount: "5000000" } }],
  payment_buys: "an attempt, not an outcome",
  notes: [
    "Payment buys an attempt. Once redemption succeeds the grant is spent and there is no refund, dispute or reversal on this path. A failed attempt is delivered as a SEALED failure result, signed and auditable.",
    "The relay operator sees both DIDs, the grant/offer/capsule hashes, the price band, the settlement pointer and the timings. It does NOT see the brief or the result. The chain publishes payer, payee, amount and time, permanently.",
    "Discovery is out of band for this milestone: there is no session-provider directory. You found this manifest because someone gave you its URL.",
    "This document is SIGNED. `signature_base64` is Ed25519 over the canonical JSON of every other field, under `signing_public_key_base64` — and `provider_did` is derived from that same key. Verify both before you seal a brief to `encryption_public_key_base64` or pay `services[].price.payee_account`: unverified, those two fields are whatever the host that served you this file wanted them to be.",
  ], signature_base64: "IsCAew3Gc7HozZip2BsLBEyay4XEhNJZCAgpWyLQklC0CVC1EmMZDLSi1pbImF97TdVoaaSVOWc27UGY9l7uAQ==",
};
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
export async function automaticFixture(now = AUTO_NOW) {
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  const handoff = { schema: AUTOMATIC_HANDOFF_SCHEMA, run_id: "a".repeat(32), completion_capability: "b".repeat(64) };
  const event = "0123456789abcdef0123456789abcdef";
  const exercise = { schema: PUBLIC_EXERCISE_SCHEMA, task: SESSIONS_PROOFS_TASK, challenge_id: handoff.run_id,
    challenge: "c".repeat(64), issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 599000).toISOString(), provider: SESSIONS_PROOFS_PROVIDER };
  const key = { issuer: AUTOMATIC_ISSUER, key_id: await sha256Hex(pair.publicKey), algorithm: "Ed25519", public_key_hex: hex(pair.publicKey), status: "active" };
  const statement = { schema: "voidpay.proof-collection.receipt/v4", issuer: AUTOMATIC_ISSUER, key_id: key.key_id, event_id: event,
    run_binding_sha256: await sha256Hex(new TextEncoder().encode(AUTOMATIC_RUN_BINDING_DOMAIN + handoff.run_id)),
    exercise_binding_sha256: await sha256Hex(canonicalBytes(exercise)), artwork: { recipe: "contours-v1", seed: event },
    task: AUTOMATIC_TASK, computation_task: SESSIONS_PROOFS_TASK, checked_at: new Date(now).toISOString(), completed_at: new Date(now + 1).toISOString(), outcome: "PASS",
    checks: { server: { owner_preauthorized: true, challenge_unexpired: true, provider_pair_listed: true, manifest_verified: true, wrong_pin_refused: true },
      claimant: { manifest_digest_matches: true, challenge_response_matches: true } },
    provider: { provider_did: SESSIONS_PROOFS_PROVIDER.provider_did, manifest_url: SESSIONS_PROOFS_PROVIDER.manifest_url }, scope: AUTOMATIC_SCOPE, boundary: AUTOMATIC_BOUNDARY };
  const sign = (value: unknown) => hex(nacl.sign.detached(new TextEncoder().encode(AUTOMATIC_RECEIPT_DOMAIN + new TextDecoder().decode(canonicalBytes(value))), pair.secretKey));
  const receipt = { statement, signature_hex: sign(statement) };
  const record = { event_id: event, visibility: "private", public_url: null as string | null,
    expires_at: new Date(now + 1 + 15552000000).toISOString(), receipt };
  const complete = { schema: "voidpay.proof-collection.result/v4", ok: true, status: "complete", run_id: handoff.run_id, exercise, record, already_completed: false };
  const pending = { schema: "voidpay.proof-collection.result/v4", ok: true, status: "pending", run_id: handoff.run_id, record: null };
  const issuer = { schema: "voidpay.proof-collection.issuer/v2", issuer: AUTOMATIC_ISSUER, keys: [key], unknown_key_policy: "untrusted; never trust an embedded receipt key" };
  return { handoff, exercise, receipt, record, complete, pending, issuer, sign };
}
