import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalBytes, sha256Hex } from "../src/index";
import { automaticCanonicalJson } from "../src/automaticCanonical";
import { AUTOMATIC_BASE, AUTOMATIC_HANDOFF_SCHEMA, AUTOMATIC_ISSUER, AUTOMATIC_TASK, completeAutomaticProof, parseAutomaticHandoff } from "../src/proofsAuto";
import { proofArtworkSvg, SESSIONS_PROOFS_PROVIDER } from "../src/proofs";
import { automaticFixture, AUTO_NOW, PUBLIC_MANIFEST, collectionFixtureJson } from "./_automaticFixture";

type Fixture = Awaited<ReturnType<typeof automaticFixture>>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const failure = (status = 503) => json({ schema: "voidpay.proof-collection.error/v4", ok: false, error: { code: "unavailable" } }, status);
function server(f: Fixture, override?: (url: string, init: RequestInit, count: number) => Response | undefined | Promise<Response | undefined>) {
  let completed = false;
  const counts = new Map<string, number>();
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input); const count = (counts.get(url) ?? 0) + 1; counts.set(url, count);
    const replaced = await override?.(url, init, count);
    if (replaced) return replaced;
    if (url === AUTOMATIC_ISSUER) return json(f.issuer);
    if (url === AUTOMATIC_BASE + "/result") return json(completed ? { ...f.complete, already_completed: true } : f.pending);
    if (url === AUTOMATIC_BASE + "/exercise") return json({ schema: "voidpay.proof-collection.response/v4", ok: true, action: "exercise", run_id: f.handoff.run_id, exercise: f.exercise });
    if (url === AUTOMATIC_BASE + "/submit") { completed = true; return json(f.complete); }
    if (url === SESSIONS_PROOFS_PROVIDER.index_url) return json({ providers: [SESSIONS_PROOFS_PROVIDER] });
    if (url === SESSIONS_PROOFS_PROVIDER.manifest_url) return json(PUBLIC_MANIFEST);
    throw new Error("unexpected_url");
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("automatic Sessions public contract", () => {
  it("uses null-preserving collection canonical JSON without changing session envelopes", () => {
    const value = { z: null, a: [{ z: null, a: [null, 1, false, "quoted\"value"] }, null] };
    const expected = '{"a":[{"a":[null,1,false,"quoted\\\"value"],"z":null},null],"z":null}';
    expect(automaticCanonicalJson(value)).toBe(expected);
    expect(collectionFixtureJson(value)).toBe(expected);
    expect(new TextDecoder().decode(canonicalBytes(value))).not.toBe(expected);
    expect(new TextDecoder().decode(canonicalBytes({ reward_asset: null, decision: "STOP" }))).toBe('{"decision":"STOP"}');
  });
  it.each([undefined, NaN, Infinity, 1.5, 1n, new Date(0)])("refuses non-collection JSON values: %s", value => {
    expect(() => automaticCanonicalJson(value)).toThrow("Unsupported automatic collection JSON value");
  });
  it("accepts only the fixed small handoff and copies its accepted fields", async () => {
    const f = await automaticFixture();
    expect(parseAutomaticHandoff(JSON.stringify(f.handoff))).toEqual(f.handoff);
    expect(AUTOMATIC_TASK.acceptance_rule_sha256).toBe("b58e042e088740892856e96f4c8eee079bd94819c518e8e486ef250184ffb230");
  });
  it.each(["null", "[]", "{}", "x".repeat(1025), "{", JSON.stringify({ schema: AUTOMATIC_HANDOFF_SCHEMA, run_id: "a".repeat(32), completion_capability: "B".repeat(64) })])("refuses invalid input before network: %s", async text => {
    const fetchImpl = vi.fn();
    await expect(completeAutomaticProof(text, { fetchImpl })).rejects.toMatchObject({ code: "handoff_invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["url", "owner", "token", "private_key"])("refuses extra %s without reflection", async field => {
    const f = await automaticFixture(); const fetchImpl = vi.fn();
    await expect(completeAutomaticProof(JSON.stringify({ ...f.handoff, [field]: "DO_NOT_ECHO" }), { fetchImpl })).rejects.toThrow("handoff_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("computes through the real SDK, saves and verifies all bindings before rendering", async () => {
    const f = await automaticFixture(); const fetchImpl = server(f);
    const result = await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    expect(result.saved_proof).toBe(true); expect(result.visibility).toBe("private"); expect(result.already_completed).toBe(false);
    expect(result.artwork.svg).toBe(proofArtworkSvg(f.record.event_id));
    expect(result.artwork.sha256).toBe(await sha256Hex(new TextEncoder().encode(result.artwork.svg)));
    expect(result.receipt.statement.exercise_binding_sha256).toBe(await sha256Hex(new TextEncoder().encode(collectionFixtureJson(f.exercise))));
    expect(automaticCanonicalJson(f.exercise)).toBe(collectionFixtureJson(f.exercise));
    expect(automaticCanonicalJson(f.exercise)).toBe(new TextDecoder().decode(canonicalBytes(f.exercise)));
    expect(JSON.stringify(result)).not.toContain(f.handoff.completion_capability);
    const posted = fetchImpl.mock.calls.find(([url]) => url === AUTOMATIC_BASE + "/submit")!;
    const body = JSON.parse(String(posted[1]?.body));
    expect(Object.keys(body)).toEqual(["run_id", "result"]);
    expect(body.result.manifest_digest_sha256).toBe("7155546c67df54bc2ebb0b7aab7f8f4b5ff7d3d487fddad77d5e4076ed5f3b1c");
  });
  it("accepts the collection signature that includes reward_asset:null", async () => {
    const f = await automaticFixture();
    expect(f.receipt.statement.boundary.reward_asset).toBeNull();
    const result = await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl: server(f), nowMs: AUTO_NOW });
    expect(result.receipt.statement.boundary.reward_asset).toBeNull();
  });
  it("rejects a signature made after silently dropping the null reward_asset", async () => {
    const f = await automaticFixture();
    const incorrectlyCanonicalized = JSON.parse(new TextDecoder().decode(canonicalBytes(f.receipt.statement)));
    f.receipt.signature_hex = f.sign(incorrectlyCanonicalized);
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl: server(f), nowMs: AUTO_NOW })).rejects.toMatchObject({ code: "receipt_invalid" });
  });
  it("sends the capability only to three fixed v4 endpoints, never to issuer/provider/body/URL", async () => {
    const f = await automaticFixture(); const fetchImpl = server(f);
    await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    for (const [url, supplied] of fetchImpl.mock.calls) {
      const init = supplied!;
      expect(String(url)).not.toContain(f.handoff.completion_capability);
      expect(String(init.body)).not.toContain(f.handoff.completion_capability);
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      const headers = new Headers(init.headers);
      if (String(url).startsWith(AUTOMATIC_BASE)) {
        expect(["/result", "/exercise", "/submit"].some(path => url === AUTOMATIC_BASE + path)).toBe(true);
        expect(init.method).toBe("POST"); expect(headers.get("authorization")).toBe("Bearer " + f.handoff.completion_capability);
      } else { expect(init.method).toBe("GET"); expect(headers.has("authorization")).toBe(false); expect(init.body).toBeUndefined(); }
    }
  });
  it("recovers a completed run after challenge expiry without exercising or submitting again", async () => {
    const f = await automaticFixture();
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/result" ? json({ ...f.complete, already_completed: true }) : undefined);
    const result = await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW + 700000 });
    expect(result.already_completed).toBe(true); expect(result.event_id).toBe(f.record.event_id);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([AUTOMATIC_BASE + "/result", AUTOMATIC_ISSUER]);
  });
  it("accepts the winning exercise when a concurrent caller finishes before activation", async () => {
    const f = await automaticFixture();
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/exercise" ? json({ ...f.complete, already_completed: true }) : undefined);
    expect((await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).already_completed).toBe(true);
    expect(fetchImpl.mock.calls.some(call => call[0] === AUTOMATIC_BASE + "/submit")).toBe(false);
  });
  it("recovers one saved event after a lost submit response", async () => {
    const f = await automaticFixture(); let submitted = false;
    const fetchImpl = server(f, url => {
      if (url === AUTOMATIC_BASE + "/submit") { submitted = true; throw new Error("private_network_diagnostic"); }
      if (url === AUTOMATIC_BASE + "/result" && submitted) return json({ ...f.complete, already_completed: true });
    });
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const result = await work;
    expect(result.saved_proof).toBe(true); expect(result.already_completed).toBe(true);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/submit")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private_network_diagnostic");
  });
  it("recovers the same saved event after an HTML 502 submit response without submitting twice", async () => {
    const f = await automaticFixture(); let submitted = false;
    const fetchImpl = server(f, url => {
      if (url === AUTOMATIC_BASE + "/submit") {
        submitted = true;
        return new Response("<html>Temporary gateway failure</html>", { status: 502, headers: { "content-type": "text/html" } });
      }
      if (url === AUTOMATIC_BASE + "/result" && submitted) return json({ ...f.complete, already_completed: true });
    });
    const result = await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    expect(result.saved_proof).toBe(true); expect(result.already_completed).toBe(true);
    expect(result.event_id).toBe(f.record.event_id); expect(result.receipt).toEqual(f.receipt);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/submit")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/result")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("Temporary gateway failure");
  });
  it("never submits a fourth attempt and reports uncertain saving honestly", async () => {
    const f = await automaticFixture();
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/submit" ? failure() : undefined);
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const refusal = expect(work).rejects.toMatchObject({ code: "completion_uncertain" });
    await refusal;
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/submit")).toHaveLength(3);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/result")).toHaveLength(4);
  });
  it.each([401, 403, 404, 410, 429])("does not retry terminal status %s", async status => {
    const f = await automaticFixture(); const fetchImpl = server(f, () => failure(status));
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["signature", (f: Fixture) => { f.receipt.signature_hex = "0".repeat(128); }],
    ["event", (f: Fixture) => { f.record.event_id = "f".repeat(32); }],
    ["run", (f: Fixture) => { f.receipt.statement.run_binding_sha256 = "f".repeat(64); }],
    ["exercise", (f: Fixture) => { f.exercise.challenge = "d".repeat(64); }],
    ["art seed", (f: Fixture) => { f.receipt.statement.artwork.seed = "f".repeat(32); }],
    ["art recipe", (f: Fixture) => { f.receipt.statement.artwork.recipe = "unknown"; }],
    ["missing check", (f: Fixture) => { f.receipt.statement.checks.server.manifest_verified = false; }],
    ["task", (f: Fixture) => { Object.assign(f.receipt.statement, { task: { ...AUTOMATIC_TASK, version: 2 } }); }],
    ["boundary", (f: Fixture) => { Object.assign(f.receipt.statement, { boundary: { ...f.receipt.statement.boundary, transaction_broadcast: true } }); }],
    ["expired record", (f: Fixture) => { f.record.expires_at = new Date(AUTO_NOW).toISOString(); }],
    ["future", (f: Fixture) => { f.receipt.statement.completed_at = new Date(AUTO_NOW + 31000).toISOString(); }],
  ] as const)("refuses wrong %s even when the altered statement is signed", async (name, alter) => {
    const f = await automaticFixture(); alter(f);
    if (name !== "signature") f.receipt.signature_hex = f.sign(f.receipt.statement);
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/result" ? json(f.complete) : undefined);
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toMatchObject({ code: "receipt_invalid" });
    expect(fetchImpl.mock.calls.some(call => call[0] === AUTOMATIC_BASE + "/submit")).toBe(false);
  });
  it("allows already published recovery without pretending this command published", async () => {
    const f = await automaticFixture(); f.complete.already_completed = true; f.record.visibility = "public";
    f.record.public_url = "https://api.voidly.ai/v2/proofs/collections/public/" + f.record.event_id;
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/result" ? json(f.complete) : undefined);
    expect((await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).visibility).toBe("public");
  });
  it.each(["duplicate", "key mismatch", "unknown signer", "embedded key"])("rejects issuer problem: %s", async name => {
    const f = await automaticFixture();
    if (name === "duplicate") f.issuer.keys.push(f.issuer.keys[0]);
    if (name === "key mismatch") f.issuer.keys[0].key_id = "f".repeat(64);
    if (name === "unknown signer") { f.receipt.statement.key_id = "f".repeat(64); f.receipt.signature_hex = f.sign(f.receipt.statement); }
    if (name === "embedded key") Object.assign(f.receipt, { public_key_hex: f.issuer.keys[0].public_key_hex });
    const fetchImpl = server(f, url => url === AUTOMATIC_BASE + "/result" ? json(f.complete) : undefined);
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toThrow();
  });
  it.each([
    ["redirect", () => { const r = json({}); Object.defineProperty(r, "redirected", { value: true }); return r; }],
    ["different URL", () => { const r = json({}); Object.defineProperty(r, "url", { value: "https://other.invalid" }); return r; }],
    ["redirect status", () => new Response("", { status: 302 })],
    ["HTML", () => new Response("DO_NOT_ECHO", { headers: { "content-type": "text/html" } })],
    ["oversized declared", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "32769" } })],
    ["oversized stream", () => new Response("x".repeat(32769), { headers: { "content-type": "application/json" } })],
    ["invalid UTF8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ] as const)("refuses %s without forwarding credential", async (_name, reply) => {
    const f = await automaticFixture(); const fetchImpl = server(f, () => reply());
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toMatchObject({ code: "response_invalid" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("refuses credential reflection even if escaped in JSON", async () => {
    const f = await automaticFixture();
    const fetchImpl = server(f, () => new Response(JSON.stringify({ ...f.pending, text: f.handoff.completion_capability }).replaceAll("b", "\\u0062"), { headers: { "content-type": "application/json" } }));
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toThrow("response_invalid");
  });
  it("has a deadline even when fetch ignores abort", async () => {
    vi.useFakeTimers(); const f = await automaticFixture(); const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const refusal = expect(work).rejects.toThrow("completion_unavailable");
    await vi.waitUntil(() => fetchImpl.mock.calls.length > 0);
    await vi.runAllTimersAsync(); await refusal; expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("has a deadline when response body never finishes", async () => {
    vi.useFakeTimers(); const f = await automaticFixture();
    const fetchImpl = server(f, () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }));
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const refusal = expect(work).rejects.toThrow("completion_unavailable");
    await vi.waitUntil(() => fetchImpl.mock.calls.length > 0);
    await vi.runAllTimersAsync(); await refusal; expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it.each([0, 1])("bounds endless immediate chunks of %s bytes and cancels the stream", async size => {
    const f = await automaticFixture(); let reads = 0; const cancel = vi.fn();
    const fetchImpl = server(f, () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(size).fill(32)); }, cancel,
    }), { headers: { "content-type": "application/json" } }));
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toThrow("response_invalid");
    expect(reads).toBeLessThanOrEqual(size === 0 ? 131 : 2050); expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("enforces elapsed monotonic time at immediately resolving read boundaries", async () => {
    vi.useFakeTimers(); const f = await automaticFixture(); let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const fetchImpl = server(f, () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { time += 10001; controller.enqueue(new Uint8Array(1)); },
    }), { headers: { "content-type": "application/json" } }));
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const refusal = expect(work).rejects.toThrow("completion_unavailable");
    await vi.waitUntil(() => fetchImpl.mock.calls.length > 0); await vi.runAllTimersAsync(); await refusal;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("cancels response bodies that arrive after the fetch deadline", async () => {
    vi.useFakeTimers(); const f = await automaticFixture(); const resolves: ((value: Response) => void)[] = [];
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => resolves.push(resolve)));
    const work = completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    const refusal = expect(work).rejects.toThrow("completion_unavailable");
    await vi.waitUntil(() => fetchImpl.mock.calls.length > 0); await vi.runAllTimersAsync(); await refusal;
    const cancellations = resolves.map(resolve => { const cancel = vi.fn(); resolve(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } })); return cancel; });
    await Promise.resolve(); await Promise.resolve();
    expect(cancellations).toHaveLength(3); for (const cancel of cancellations) expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("retries a transient public provider read within the same grant and never forwards its capability", async () => {
    const f = await automaticFixture();
    const fetchImpl = server(f, (url, _init, count) => { if (url === SESSIONS_PROOFS_PROVIDER.index_url && count === 1) throw new Error("temporary_outage"); return undefined; });
    const result = await completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW });
    expect(result.saved_proof).toBe(true); expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/submit")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/exercise")).toHaveLength(2);
    for (const [url, init] of fetchImpl.mock.calls) if (url === SESSIONS_PROOFS_PROVIDER.index_url) expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });
  it("does not retry a malformed signed provider", async () => {
    const f = await automaticFixture(); const fetchImpl = server(f, url => url === SESSIONS_PROOFS_PROVIDER.manifest_url ? json({ ...PUBLIC_MANIFEST, accept_url: "https://other.invalid" }) : undefined);
    await expect(completeAutomaticProof(JSON.stringify(f.handoff), { fetchImpl, nowMs: AUTO_NOW })).rejects.toThrow("provider_check_failed");
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/exercise")).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(call => call[0] === AUTOMATIC_BASE + "/submit")).toHaveLength(0);
  });
});
