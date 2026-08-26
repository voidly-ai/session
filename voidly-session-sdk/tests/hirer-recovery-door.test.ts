
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import {
  envelopeHash,
  openDeliveredResult,
  recoverResult,
  sealTaskResult,
  signDelivery,
  SessionUsageError,
  type FetchLike,
  type HireWire,
  type SessionKey,
  type TaskDeliveryReceipt,
  type TaskResultCapsule,
} from "../src/index";
import { openTaskResult } from "../src/hirer";
import { freshHire, party, seededEntropy, NOW } from "./_fixtures";

const RESULT = "IR-2026-0142 · DNS tampering confirmed on 3 resolvers · permalink: …";

async function deliveredSession(seed = 0x51ce) {
  const { hirer, provider, hire } = await freshHire(seed);
  const grantHash = hire.keep.grant_hash;
  const offerHash = await envelopeHash(hire.wire.offer);

  const sealed = await sealTaskResult({
    result: RESULT,
    grantHash,
    sessionKey: hire.keep.sessionKey,
    briefCapsule: hire.wire.capsule,
    entropy: seededEntropy(seed ^ 0xfff),
  });

  const signed = await signDelivery({
    grantHash,
    offerHash,
    providerDid: provider.did,
    resultCapsuleHash: sealed.resultCapsuleHash,
    resultCommitment: sealed.resultCommitment,
    recoverableUntilMs: NOW + 90 * 60_000,
    nowMs: NOW + 6_000,
    sign: provider.sign,
  });
  if (!signed.ok) throw new Error(`fixture delivery failed: ${signed.reason}`);

  return {
    hirer,
    provider,
    wire: hire.wire as HireWire,
    grantHash,
    sessionKey: hire.keep.sessionKey as SessionKey,
    receipt: JSON.parse(JSON.stringify(signed.receipt)) as unknown,
    receiptSignature: signed.signature_base64,
    capsule: JSON.parse(JSON.stringify(sealed.capsule)) as unknown,
    resultCommitment: sealed.resultCommitment,
    nowMs: NOW + 7_000,
  };
}

function recoverEnvelope(
  grantHash: string,
  answer: unknown,
  stateKind = "delivered",
): Record<string, unknown> {
  return {
    schema: "voidly-pay-session-recover/v1",
    outcome: {
      kind: "answered",
      grant_hash: grantHash,
      state: { kind: stateKind, grant_hash: grantHash },
      answer,
    },
  };
}

interface Dial {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; body: Record<string, unknown> }>;
}

function dial(status: number, body: unknown): Dial {
  const calls: Dial["calls"] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function deadDial(err: unknown): Dial {
  const calls: Dial["calls"] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: unknown } | undefined)?.body ?? "{}")),
    });
    throw err;
  };
  return { fetchImpl, calls };
}

describe("openDeliveredResult — the authenticated open", () => {

  it("opens the honest delivery and hands back the VERIFIED receipt", async () => {
    const s = await deliveredSession();
    const out = await openDeliveredResult({
      receipt: s.receipt,
      signatureBase64: s.receiptSignature,
      resultCapsule: s.capsule,
      grant: s.wire.grant,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    });
    expect(out.kind).toBe("opened");
    if (out.kind !== "opened") return;
    expect(out.result).toBe(RESULT);
    expect(out.receipt.result_commitment).toBe(s.resultCommitment);
    expect(out.receipt.grant_hash).toBe(s.grantHash);
  });

  it("REFUSES a receipt an impostor signed, where the hand-rolled open succeeds", async () => {
    const s = await deliveredSession(0x51cf);
    const impostor = party(77);
    const impostorSig = encodeBase64(
      nacl.sign.detached(
        new TextEncoder().encode(JSON.stringify(s.receipt)),
        nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(77)).secretKey,
      ),
    );
    expect(impostor.did).not.toBe("");

    const naive = await openTaskResult({
      resultCapsule: s.capsule,
      sessionKey: s.sessionKey,
      grantHash: s.grantHash,
      resultCommitment: (s.receipt as { result_commitment: string }).result_commitment,
    });
    expect(naive.kind).toBe("opened");

    const out = await openDeliveredResult({
      receipt: s.receipt,
      signatureBase64: impostorSig,
      resultCapsule: s.capsule,
      grant: s.wire.grant,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    });
    expect(out.kind).toBe("unverifiable");
    if (out.kind !== "unverifiable") return;
    expect(out.reason).toBe("invalid_delivery_signature");
  });

  it("checks the ANCHOR before it looks at the receipt", async () => {
    const s = await deliveredSession(0x5200);
    const other = await deliveredSession(0x5201);
    const out = await openDeliveredResult({
      receipt: s.receipt,
      signatureBase64: s.receiptSignature,
      resultCapsule: s.capsule,
      grant: s.wire.grant,
      grantHash: other.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    });
    expect(out).toEqual({ kind: "unverifiable", reason: "grant_hash_mismatch" });
  });

  it("refuses a receipt about ANOTHER hire", async () => {
    const s = await deliveredSession(0x5300);
    const other = await deliveredSession(0x5301);
    const out = await openDeliveredResult({
      receipt: other.receipt,
      signatureBase64: other.receiptSignature,
      resultCapsule: s.capsule,
      grant: s.wire.grant,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    });
    expect(out.kind).toBe("unverifiable");
  });

  it("separates `unopenable` from `unverifiable`, and carries the receipt out", async () => {
    const s = await deliveredSession(0x5400);
    const foreign = await deliveredSession(0x5401);
    const out = await openDeliveredResult({
      receipt: s.receipt,
      signatureBase64: s.receiptSignature,
      resultCapsule: foreign.capsule,
      grant: s.wire.grant,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    });
    expect(out.kind).toBe("unopenable");
    if (out.kind !== "unopenable") return;
    expect(out.receipt.grant_hash).toBe(s.grantHash);
  });

  it("takes no commitment argument at all — the trap is not expressible", async () => {
    const s = await deliveredSession(0x5500);
    const input = {
      receipt: s.receipt,
      signatureBase64: s.receiptSignature,
      resultCapsule: s.capsule,
      grant: s.wire.grant,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      nowMs: s.nowMs,
    };
    expect(Object.keys(input)).not.toContain("resultCommitment");
    const out = await openDeliveredResult(input);
    expect(out.kind).toBe("opened");
  });
});

describe("recoverResult — the composed door", () => {

  it("mints, signs, posts, authenticates and opens — in one call", async () => {
    const s = await deliveredSession(0x6000);
    const d = dial(
      200,
      recoverEnvelope(s.grantHash, {
        receipt: s.receipt,
        receipt_signature_base64: s.receiptSignature,
        result_capsule: s.capsule as TaskResultCapsule,
      }),
    );

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(0x6000),
    });

    expect(out.kind).toBe("opened");
    if (out.kind !== "opened") return;
    expect(out.result).toBe(RESULT);
    expect(out.receipt.result_commitment).toBe(s.resultCommitment);

    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].url).toBe("https://api.voidly.ai/v1/pay/session/recover");
  });

  it("reads `requester_did` off the GRANT and posts the six-key body", async () => {
    const s = await deliveredSession(0x6100);
    const d = dial(200, recoverEnvelope(s.grantHash, null, "recoverable"));

    await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(0x6100),
    });

    const body = d.calls[0].body;
    expect(Object.keys(body).sort()).toEqual([
      "grant",
      "grant_signature_base64",
      "offer",
      "offer_signature_base64",
      "request",
      "request_signature_base64",
    ]);
    const req = body.request as Record<string, unknown>;
    expect(req.requester_did).toBe(
      (s.wire.grant as unknown as Record<string, unknown>).hirer_did,
    );
    expect(req.grant_hash).toBe(s.grantHash);
    const sig = decodeBase64(String(body.request_signature_base64));
    expect(sig).toHaveLength(64);
  });

  it("mints a FRESH request on every call", async () => {
    const s = await deliveredSession(0x6200);
    const d = dial(200, recoverEnvelope(s.grantHash, null, "recoverable"));
    const common = {
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
    };
    await recoverResult({ ...common, nowMs: s.nowMs, entropy: seededEntropy(1) });
    await recoverResult({ ...common, nowMs: s.nowMs + 60_000, entropy: seededEntropy(2) });

    const a = d.calls[0].body.request as Record<string, unknown>;
    const b = d.calls[1].body.request as Record<string, unknown>;
    expect(a.issued_at).not.toBe(b.issued_at);
    expect(a.action_nonce).not.toBe(b.action_nonce);
  });

  it("defaults the request window to five minutes, and honours `ttlMs`", async () => {
    const s = await deliveredSession(0x6300);
    const d = dial(200, recoverEnvelope(s.grantHash, null, "recoverable"));
    const common = {
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
    };
    await recoverResult({ ...common, entropy: seededEntropy(3) });
    await recoverResult({ ...common, ttlMs: 45_000, entropy: seededEntropy(4) });

    const windowOf = (i: number) => {
      const r = d.calls[i].body.request as Record<string, string>;
      return Date.parse(r.expires_at) - Date.parse(r.issued_at);
    };
    expect(windowOf(0)).toBe(5 * 60_000);
    expect(windowOf(1)).toBe(45_000);
  });

  it("refuses a mismatched anchor WITHOUT dialling", async () => {
    const s = await deliveredSession(0x6400);
    const other = await deliveredSession(0x6401);
    const d = dial(200, recoverEnvelope(s.grantHash, null));

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: other.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
    });
    expect(out).toEqual({ kind: "unbuildable", reason: "grant_hash_mismatch" });
    expect(d.calls).toHaveLength(0);
  });

  it("refuses a signer that throws WITHOUT dialling", async () => {
    const s = await deliveredSession(0x6500);
    const d = dial(200, recoverEnvelope(s.grantHash, null));

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: () => {
        throw new Error("the key is on a device that is not plugged in");
      },
      nowMs: s.nowMs,
      entropy: seededEntropy(5),
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("invalid_recovery_signature");
    expect(d.calls).toHaveLength(0);
  });

  it("reports `no_result` with THE DOOR'S OWN WORDS when there is nothing to open", async () => {
    const s = await deliveredSession(0x6600);
    const d = dial(200, recoverEnvelope(s.grantHash, null, "refundable"));

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(6),
    });
    expect(out).toEqual({
      kind: "no_result",
      status: 200,
      outcome: "answered",
      state: "refundable",
    });
  });

  it("reports `no_result` for a lookup miss, where the rail holds no payment", async () => {
    const s = await deliveredSession(0x6700);
    const d = dial(200, {
      schema: "voidly-pay-session-recover/v1",
      outcome: { kind: "no_payment_recorded", grant_hash: s.grantHash },
    });

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(7),
    });
    expect(out).toEqual({ kind: "no_result", status: 200, outcome: "no_payment_recorded", state: "" });
    expect("evidence_id" in out).toBe(false);
  });

  it("CARRIES THE EVIDENCE ID OUT when the grant was paid and has no session", async () => {
    const s = await deliveredSession(0x6701);
    const d = dial(200, {
      schema: "voidly-pay-session-recover/v1",
      outcome: {
        kind: "paid_no_session",
        grant_hash: s.grantHash,
        evidence_id: "c6908fa7deadbeef",
      },
    });

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(7),
    });
    expect(out).toEqual({
      kind: "no_result",
      status: 200,
      outcome: "paid_no_session",
      state: "",
      evidence_id: "c6908fa7deadbeef",
    });
  });

  it("REFUSES TO INVENT an evidence id the rail did not send", async () => {
    const s = await deliveredSession(0x6702);
    for (const bad of [undefined, null, "", 42, {}]) {
      const d = dial(200, {
        schema: "voidly-pay-session-recover/v1",
        outcome: { kind: "paid_no_session", grant_hash: s.grantHash, evidence_id: bad },
      });
      const out = await recoverResult({
        endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
        wire: s.wire,
        grantHash: s.grantHash,
        sessionKey: s.sessionKey,
        sign: s.hirer.sign,
        nowMs: s.nowMs,
        entropy: seededEntropy(7),
      });
      expect("evidence_id" in out).toBe(false);
    }
  });

  it("BOUNDS the words it copies out of the answer", async () => {
    const s = await deliveredSession(0x6800);
    const d = dial(200, recoverEnvelope(s.grantHash, null, "x".repeat(4096)));

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(8),
    });
    expect(out.kind).toBe("no_result");
    if (out.kind !== "no_result") return;
    expect(out.state).toHaveLength(128);
  });

  it("calls an answer with no `outcome` UNRECOGNIZED, not a wait", async () => {
    const s = await deliveredSession(0x6900);
    const d = dial(200, { schema: "voidly-pay-session-recover/v1", result: "here you go" });

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(9),
    });
    expect(out).toEqual({
      kind: "unrecognized",
      status: 200,
      detail: "response_has_no_outcome",
    });
  });

  it("calls a malformed `answer` UNVERIFIABLE, not `no_result`", async () => {
    const s = await deliveredSession(0x6a00);
    const d = dial(
      200,
      recoverEnvelope(s.grantHash, { receipt: s.receipt, result_capsule: s.capsule }),
    );

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(10),
    });
    expect(out).toEqual({ kind: "unverifiable", reason: "answer_malformed" });
  });

  it("does not open a recovered answer whose receipt an impostor signed", async () => {
    const s = await deliveredSession(0x6b00);
    const impostorSig = encodeBase64(
      nacl.sign.detached(
        new TextEncoder().encode(JSON.stringify(s.receipt)),
        nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(88)).secretKey,
      ),
    );
    const d = dial(
      200,
      recoverEnvelope(s.grantHash, {
        receipt: s.receipt,
        receipt_signature_base64: impostorSig,
        result_capsule: s.capsule,
      }),
    );

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(11),
    });
    expect(out).toEqual({ kind: "unverifiable", reason: "invalid_delivery_signature" });
  });

  it("calls a dropped leg UNDELIVERED — status 0, the honest 'no answer'", async () => {
    const s = await deliveredSession(0x6c00);
    const d = deadDial(new TypeError("fetch failed"));

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(12),
    });
    expect(out.kind).toBe("undelivered");
    expect(d.calls).toHaveLength(1);
  });

  it("calls a withheld-runtime 410 UNRECOGNIZED, never `undelivered`", async () => {
    const s = await deliveredSession(0x6d00);
    const d = dial(410, { error: { code: "PAY_RUNTIME_WITHHELD" } });

    const out = await recoverResult({
      endpoint: { baseUrl: "https://api.voidly.ai", fetch: d.fetchImpl as typeof fetch },
      wire: s.wire,
      grantHash: s.grantHash,
      sessionKey: s.sessionKey,
      sign: s.hirer.sign,
      nowMs: s.nowMs,
      entropy: seededEntropy(13),
    });
    expect(out.kind).toBe("unrecognized");
    if (out.kind !== "unrecognized") return;
    expect(out.status).toBe(410);
    expect(out.detail).toContain("PAY_RUNTIME_WITHHELD");
  });

  it("lets SessionUsageError PROPAGATE rather than flattening it", async () => {
    const s = await deliveredSession(0x6e00);
    const d = dial(200, recoverEnvelope(s.grantHash, null));

    await expect(
      recoverResult({
        endpoint: {
          baseUrl: "https://api.voidly.ai",
          fetch: d.fetchImpl as typeof fetch,
          timeoutMs: 0,
        },
        wire: s.wire,
        grantHash: s.grantHash,
        sessionKey: s.sessionKey,
        sign: s.hirer.sign,
        nowMs: s.nowMs,
        entropy: seededEntropy(14),
      }),
    ).rejects.toBeInstanceOf(SessionUsageError);
    expect(d.calls).toHaveLength(0);
  });
});

describe("what the two doors make unreachable", () => {

  it("the surface offers the doors and neither loose half", async () => {
    const surface = (await import("../src/index")) as unknown as Record<string, unknown>;
    expect(typeof surface.recoverResult).toBe("function");
    expect(typeof surface.openDeliveredResult).toBe("function");
    expect(typeof surface.verifyDeliveryReceipt).toBe("function");
    expect(surface.openTaskResult).toBeUndefined();
    expect(surface.validateDeliveryReceipt).toBeUndefined();
  });

  it("keeps the nine validators the rule keeps", async () => {
    const surface = (await import("../src/index")) as unknown as Record<string, unknown>;
    for (const name of [
      "validateAcceptance",
      "validateAuthorizationShape",
      "validateCapsuleShape",
      "validateGrant",
      "validateOffer",
      "validateRecoveryRequest",
      "validateRedemptionAttestation",
      "validateResultCapsuleShape",
      "validateX402SessionEvidence",
    ]) {
      expect(typeof surface[name], `${name} fell off the surface`).toBe("function");
    }
  });

  it("POSITIVE CONTROL: the undefined-check would catch a name that IS there", async () => {
    const surface = (await import("../src/index")) as unknown as Record<string, unknown>;
    expect(surface.verifyDeliveryReceipt).not.toBeUndefined();
  });
});

const _receiptType: (r: TaskDeliveryReceipt) => string = (r) => r.result_commitment;
const _capsuleType: (c: TaskResultCapsule) => string = (c) => c.grant_hash;
describe("the published types are the ones these doors return", () => {
  it("compiles", () => {
    expect(typeof _receiptType).toBe("function");
    expect(typeof _capsuleType).toBe("function");
  });
});
