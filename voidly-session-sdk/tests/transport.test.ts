
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "tweetnacl-util";
import {
  acceptHire,
  buildRedemptionProofHeader,
  exportSessionKeyBytes,
  postDeliver,
  postReattest,
  postRecover,
  postRedeem,
  SESSION_PATHS,
  SessionTransportError,
  x402SessionEvidence,
  type SessionEndpoint,
} from "../src/index";
import { NOW, freshHire, seededEntropy } from "./_fixtures";

const BASE = "http://127.0.0.1:9";
const TX = `0x${"7".repeat(64)}`;

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  rawBody: string;
}

function recorder(reply: { status: number; body: string } = { status: 200, body: "{}" }) {
  const calls: Recorded[] = [];
  const ep: SessionEndpoint = {
    baseUrl: BASE,
    fetch: (async (url: string, init: Record<string, unknown>) => {
      const raw = String(init?.body ?? "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
      }
      calls.push({
        url: String(url),
        method: init?.method as string | undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: parsed,
        rawBody: raw,
      });
      return {
        status: reply.status,
        text: async () => reply.body,
      };
    }) as unknown as typeof fetch,
  };
  return { ep, calls };
}

async function fixture() {
  const { hire, provider } = await freshHire();
  const accepted = await acceptHire({
    grantHash: hire.keep.grant_hash,
    providerDid: provider.did,
    sign: provider.sign,
    nowMs: NOW + 2_000,
    entropy: seededEntropy(0x1234),
  });
  if (!accepted.ok) throw new Error("fixture acceptance failed");
  const proofHeader = await buildRedemptionProofHeader({
    providerDid: provider.did,
    grantHash: hire.keep.grant_hash,
    sign: provider.sign,
    nowMs: NOW + 3_000,
  });
  return { hire, provider, accepted, proofHeader };
}

describe("every door posts to its OWN path", () => {
  it("the four paths are the four the rail routes", () => {
    expect(SESSION_PATHS).toEqual({
      redeem: "/v1/pay/session/redeem",
      deliver: "/v1/pay/session/deliver",
      recover: "/v1/pay/session/recover",
      reattest: "/v1/pay/session/reattest",
    });
  });

  it("postRedeem -> /redeem", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postRedeem(ep, {
      wire: f.hire.wire,
      acceptance: f.accepted.acceptance,
      acceptanceSignatureBase64: f.accepted.signature_base64,
      evidence: x402SessionEvidence(TX),
      proofHeader: f.proofHeader,
    });
    expect(calls.length, "the injected fetch was not used").toBe(1);
    expect(calls[0].url).toBe(`${BASE}/v1/pay/session/redeem`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["content-type"]).toBe("application/json");
  });

  it("postReattest -> /reattest", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`${BASE}/v1/pay/session/reattest`);
  });

  it("postDeliver -> /deliver and postRecover -> /recover", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postDeliver(ep, {
      wire: f.hire.wire,
      receipt: { schema: "x" } as never,
      receiptSignatureBase64: "sig",
      resultCapsule: { schema: "y" } as never,
    });
    await postRecover(ep, {
      wire: f.hire.wire,
      request: { schema: "z" } as never,
      requestSignatureBase64: "sig",
    });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/pay/session/deliver`,
      `${BASE}/v1/pay/session/recover`,
    ]);
  });

  it("a trailing slash on the base URL does not produce a double slash", async () => {
    const { calls } = recorder();
    const rec = recorder();
    const f = await fixture();
    await postReattest({ ...rec.ep, baseUrl: `${BASE}/` }, {
      wire: f.hire.wire,
      proofHeader: f.proofHeader,
    });
    expect(rec.calls[0].url).toBe(`${BASE}/v1/pay/session/reattest`);
    expect(calls.length).toBe(0);
  });
});

describe("the provider proof header is what authenticates the CALLER", () => {
  it("postRedeem sends it", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postRedeem(ep, {
      wire: f.hire.wire,
      acceptance: f.accepted.acceptance,
      acceptanceSignatureBase64: f.accepted.signature_base64,
      evidence: x402SessionEvidence(TX),
      proofHeader: f.proofHeader,
    });
    expect(calls[0].headers[f.proofHeader.name]).toBe(f.proofHeader.value);
    expect(f.proofHeader.name).toBe("x-voidly-session-provider-proof");
  });

  it("postReattest sends it", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
    expect(calls[0].headers[f.proofHeader.name]).toBe(f.proofHeader.value);
  });
});

describe("the bodies carry exactly what each door reads, and nothing more", () => {
  it("postRedeem carries the hire, the countersignature and the evidence", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postRedeem(ep, {
      wire: f.hire.wire,
      acceptance: f.accepted.acceptance,
      acceptanceSignatureBase64: f.accepted.signature_base64,
      evidence: x402SessionEvidence(TX),
      proofHeader: f.proofHeader,
    });
    expect(Object.keys(calls[0].body).sort()).toEqual([
      "acceptance",
      "acceptance_signature_base64",
      "capsule",
      "evidence",
      "grant",
      "grant_signature_base64",
      "offer",
      "offer_signature_base64",
    ]);
    expect(calls[0].body.evidence).toEqual({
      schema: "voidly.session.settlement.x402/v1",
      transaction_hash: TX,
    });
  });

  it("postReattest carries ONLY the grant", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
    expect(Object.keys(calls[0].body)).toEqual(["grant"]);
    expect(calls[0].rawBody).not.toContain("evidence");
    expect(calls[0].rawBody).not.toContain("transaction_hash");
  });

  it("the SESSION KEY ITSELF never goes on the wire — only the wrapped copy", async () => {
    const { ep, calls } = recorder();
    const f = await fixture();
    await postRedeem(ep, {
      wire: f.hire.wire,
      acceptance: f.accepted.acceptance,
      acceptanceSignatureBase64: f.accepted.signature_base64,
      evidence: x402SessionEvidence(TX),
      proofHeader: f.proofHeader,
    });

    const secret = exportSessionKeyBytes(f.hire.keep.sessionKey);
    expect(secret, "the fixture has no session key — this test would prove nothing").not.toBeNull();
    const secretB64 = encodeBase64(secret!);
    const secretHex = Array.from(secret!)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    for (const c of calls) {
      expect(c.rawBody, "the raw session key is in the request body").not.toContain(secretB64);
      expect(c.rawBody).not.toContain(secretHex);
      expect(c.rawBody).not.toContain("redacted:session-key");
      expect(c.rawBody).not.toContain("secretKey");
    }

    expect(calls[0].rawBody).toContain("wrapped_session_key_base64");
  });
});

describe("a non-JSON answer is RAISED, never returned as a body", () => {
  it("a non-JSON 410's shape surfaces as SessionTransportError", async () => {
    const { ep } = recorder({ status: 410, body: "<!doctype html><h1>Gone</h1>" });
    const f = await fixture();
    await expect(
      postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader }),
    ).rejects.toBeInstanceOf(SessionTransportError);

    try {
      await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionTransportError);
      const e = err as SessionTransportError;
      expect(e.status, "the status is what tells a caller the wall is permanent").toBe(410);
      expect(e.body).toContain("Gone");
      expect(e.message).toContain(SESSION_PATHS.reattest);
    }
  });

  it("an authoritative JSON answer is returned as DATA, refusals included", async () => {
    const { ep } = recorder({
      status: 200,
      body: JSON.stringify({
        schema: "s",
        outcome: { kind: "replayed", grant_hash: "a".repeat(64) },
      }),
    });
    const f = await fixture();
    const res = await postRedeem(ep, {
      wire: f.hire.wire,
      acceptance: f.accepted.acceptance,
      acceptanceSignatureBase64: f.accepted.signature_base64,
      evidence: x402SessionEvidence(TX),
      proofHeader: f.proofHeader,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ kind: "replayed", grant_hash: "a".repeat(64) });
  });
});
