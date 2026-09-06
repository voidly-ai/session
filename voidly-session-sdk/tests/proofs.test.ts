import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalBytes, sha256Hex } from "../src/index";
import {
  parsePublicExercise, proofArtworkSvg, PUBLIC_EXERCISE_SCHEMA, PUBLIC_RESPONSE_SCHEMA,
  PublicExerciseError, runPublicExercise, runSessionsSelfTest, SESSIONS_PROOFS_PROVIDER,
  SESSIONS_PROOFS_TASK, verifyPublicExercise,
} from "../src/proofs";

const NOW = Date.parse("2026-09-06T01:00:00.000Z");
function exercise() {
  return { schema: PUBLIC_EXERCISE_SCHEMA, task: SESSIONS_PROOFS_TASK, challenge_id: "a".repeat(32),
    challenge: "b".repeat(64), issued_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 600000).toISOString(),
    provider: SESSIONS_PROOFS_PROVIDER };
}
const MANIFEST = {
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
  ],
  signature_base64: "IsCAew3Gc7HozZip2BsLBEyay4XEhNJZCAgpWyLQklC0CVC1EmMZDLSi1pbImF97TdVoaaSVOWc27UGY9l7uAQ==",
};
const INDEX = { providers: [SESSIONS_PROOFS_PROVIDER] };
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Sessions-first public exercise", () => {
  it("runs real offline signature, wrong-pin, tampering and canonical digest checks without fetch", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    expect(await runSessionsSelfTest()).toEqual({ schema: "voidly.session.self-test/v1", ok: true, mode: "offline",
      checks: { signed_manifest_verified: true, wrong_pin_refused: true, changed_manifest_refused: true, canonical_digest_matches: true },
      network_requests: 0, saved_proof: false });
    expect(network).not.toHaveBeenCalled();
  });
  it("pins every public input field and recomputes the response from actual SDK verification", async () => {
    const input = parsePublicExercise(JSON.stringify(exercise()), NOW);
    const result = await verifyPublicExercise(input, INDEX, MANIFEST, NOW);
    expect(result).toEqual({ schema: "voidpay.proof-collection.public-result/v3", task: SESSIONS_PROOFS_TASK,
      challenge_id: input.challenge_id, challenge: input.challenge,
      manifest_digest_sha256: "7155546c67df54bc2ebb0b7aab7f8f4b5ff7d3d487fddad77d5e4076ed5f3b1c",
      challenge_response_sha256: await sha256Hex(canonicalBytes({ schema: PUBLIC_RESPONSE_SCHEMA, task: input.task,
        challenge_id: input.challenge_id, challenge: input.challenge,
        manifest_digest_sha256: "7155546c67df54bc2ebb0b7aab7f8f4b5ff7d3d487fddad77d5e4076ed5f3b1c" })),
      checks: { provider_pair_listed: true, manifest_verified: true, wrong_pin_refused: true } });
    expect(JSON.stringify(result)).not.toMatch(/token|owner|private_key|authorization|saved|sdk_installed/);
  });
  it.each([
    ["credential", { token: "unexpected" }], ["wrong schema", { schema: "other" }],
    ["unknown task", { task: { ...SESSIONS_PROOFS_TASK, id: "other" } }],
    ["changed rule", { task: { ...SESSIONS_PROOFS_TASK, acceptance_rule_sha256: "0".repeat(64) } }],
    ["arbitrary URL", { provider: { ...SESSIONS_PROOFS_PROVIDER, manifest_url: "https://attacker.invalid" } }],
    ["URL query", { provider: { ...SESSIONS_PROOFS_PROVIDER, index_url: SESSIONS_PROOFS_PROVIDER.index_url + "?token=no" } }],
    ["extra nested field", { provider: { ...SESSIONS_PROOFS_PROVIDER, owner: "no" } }],
    ["bad id", { challenge_id: "f".repeat(33) }], ["bad challenge", { challenge: "F".repeat(64) }],
    ["future", { issued_at: new Date(NOW + 40000).toISOString(), expires_at: new Date(NOW + 640000).toISOString() }],
    ["long ttl", { expires_at: new Date(NOW + 600001).toISOString() }],
    ["bad ISO", { issued_at: "2026-09-06" }],
  ])("refuses %s before any network", async (_label, over) => {
    const fetchImpl = vi.fn();
    await expect(runPublicExercise(JSON.stringify({ ...exercise(), ...over }), { fetchImpl, nowMs: NOW })).rejects.toThrow("exercise_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["[]", "null", "{", " ".repeat(8193), '{"__proto__":{},"schema":"unexpected"}'])("refuses malformed or oversized input", text => {
    expect(() => parsePublicExercise(text, NOW)).toThrow("exercise_invalid");
  });
  it("refuses at expiry, and changed challenges produce different public results", async () => {
    expect(() => parsePublicExercise(JSON.stringify(exercise()), NOW + 600000)).toThrow("exercise_expired");
    const a = await verifyPublicExercise(exercise(), INDEX, MANIFEST, NOW);
    const b = await verifyPublicExercise({ ...exercise(), challenge: "c".repeat(64) }, INDEX, MANIFEST, NOW);
    expect(a.challenge_response_sha256).not.toBe(b.challenge_response_sha256);
  });
  it("refuses an unlisted pair and modified signed document", async () => {
    await expect(verifyPublicExercise(exercise(), { providers: [] }, MANIFEST, NOW)).rejects.toThrow("provider_not_listed");
    await expect(verifyPublicExercise(exercise(), INDEX, { ...MANIFEST, accept_url: "https://changed.invalid" }, NOW)).rejects.toThrow("manifest_invalid");
  });
  it("makes exactly two fixed GETs without auth, cookies, body or redirects", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "GET", headers: { accept: "application/json" }, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      expect(init?.body).toBeUndefined();
      return response(url === SESSIONS_PROOFS_PROVIDER.index_url ? INDEX : MANIFEST);
    });
    expect((await runPublicExercise(JSON.stringify(exercise()), { fetchImpl, nowMs: NOW })).checks.manifest_verified).toBe(true);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([SESSIONS_PROOFS_PROVIDER.index_url, SESSIONS_PROOFS_PROVIDER.manifest_url]);
  });
  it.each([
    ["upstream_unavailable", () => new Response("SECRET", { status: 503 })],
    ["upstream_not_json", () => new Response("SECRET", { headers: { "content-type": "text/html" } })],
    ["upstream_not_json", () => new Response("SECRET", { headers: { "content-type": "application/json" } })],
    ["upstream_too_large", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "9999999" } })],
    ["upstream_too_large", () => new Response("x".repeat(262145), { headers: { "content-type": "application/json" } })],
    ["upstream_redirect", () => { const r = response(INDEX); Object.defineProperty(r, "redirected", { value: true }); return r; }],
    ["upstream_redirect", () => { const r = response(INDEX); Object.defineProperty(r, "url", { value: "https://attacker.invalid" }); return r; }],
  ])("bounds and sanitizes %s", async (code, build) => {
    const fetchImpl = vi.fn(async () => build());
    await expect(runPublicExercise(JSON.stringify(exercise()), { fetchImpl, nowMs: NOW })).rejects.toMatchObject({ code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("bounds a fetch implementation that ignores abort", async () => {
    vi.useFakeTimers();
    const check = runPublicExercise(JSON.stringify(exercise()), { fetchImpl: () => new Promise(() => {}), nowMs: NOW });
    const failure = expect(check).rejects.toThrow("upstream_unavailable");
    await vi.advanceTimersByTimeAsync(8001); await failure;
  });
  it("bounds a body that stalls after headers", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const check = runPublicExercise(JSON.stringify(exercise()), { fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json" } }), nowMs: NOW });
    const failure = expect(check).rejects.toThrow("upstream_unavailable");
    await vi.advanceTimersByTimeAsync(8001); await failure;
  });
  it("does not disclose error text from a network exception", async () => {
    try { await runPublicExercise(JSON.stringify(exercise()), { fetchImpl: async () => { throw new Error("SECRET_URL"); }, nowMs: NOW }); }
    catch (error) { expect(error).toBeInstanceOf(PublicExerciseError); expect(String(error)).not.toContain("SECRET_URL"); return; }
    throw new Error("did not refuse");
  });
});

describe("saved-proof artwork parity", () => {
  it.each([
    ["00000000000000000000000000000000", "a3529e82ed58b25a65c9e4691d4aa280c8ca7a2fd7a39a5bcaea00a9d7bd3cef"],
    ["0123456789abcdef0123456789abcdef", "9940dde798869139a1e63796a376b75a3b0c9402277ae28cf38489f46dd76713"],
    ["ffffffffffffffffffffffffffffffff", "be7305873b1c09453aa8eaadd66084bc28daee5f5fc449c0e09d58bf5970df58"],
  ])("matches the immutable public recipe for %s", (id, digest) => {
    const svg = proofArtworkSvg(id);
    expect(createHash("sha256").update(svg).digest("hex")).toBe(digest);
    expect(svg).not.toContain(id); expect(svg).not.toMatch(/<script|foreignObject|href=|onload=/);
    expect(svg.length).toBeLessThan(100000);
  });
  it.each(["", "<script>", "F".repeat(32), "a".repeat(33)])("refuses invalid artwork identifiers", value => {
    expect(() => proofArtworkSvg(value)).toThrow();
  });
});
