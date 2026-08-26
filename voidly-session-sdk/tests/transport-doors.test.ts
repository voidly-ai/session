
import { describe, expect, it } from "vitest";
import {
  acceptHire,
  buildRedemptionProofHeader,
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

const WALL_BODY = JSON.stringify({
  error: {
    code: "PAY_RUNTIME_WITHHELD",
    message: "Voidly Pay runtime access is unavailable during security review.",
  },
  activation: { real_value: false, runtime_integrations_published: false },
});

function answering(reply: { status: number; body: string }): SessionEndpoint {
  return {
    baseUrl: BASE,
    fetch: (async () => ({
      status: reply.status,
      text: async () => reply.body,
    })) as unknown as typeof fetch,
  };
}

function failing(err: unknown): SessionEndpoint {
  return {
    baseUrl: BASE,
    fetch: (async () => {
      throw err;
    }) as unknown as typeof fetch,
  };
}

async function fixture() {
  const { hire, provider } = await freshHire();
  const accepted = await acceptHire({
    grantHash: hire.keep.grant_hash,
    providerDid: provider.did,
    sign: provider.sign,
    nowMs: NOW + 2_000,
    entropy: seededEntropy(0x5150),
  });
  if (!accepted.ok) throw new Error("fixture acceptance failed");
  const proofHeader = await buildRedemptionProofHeader({
    providerDid: provider.did,
    grantHash: hire.keep.grant_hash,
    sign: provider.sign,
    nowMs: NOW + 3_000,
  });
  return { hire, accepted, proofHeader };
}

async function everyDoor(ep: SessionEndpoint): Promise<Array<() => Promise<unknown>>> {
  const f = await fixture();
  return [
    () =>
      postRedeem(ep, {
        wire: f.hire.wire,
        acceptance: f.accepted.acceptance,
        acceptanceSignatureBase64: f.accepted.signature_base64,
        evidence: x402SessionEvidence(TX),
        proofHeader: f.proofHeader,
      }),
    () =>
      postDeliver(ep, {
        wire: f.hire.wire,
        receipt: { schema: "x" } as never,
        receiptSignatureBase64: "sig",
        resultCapsule: { schema: "y" } as never,
      }),
    () =>
      postRecover(ep, {
        wire: f.hire.wire,
        request: { schema: "z" } as never,
        requestSignatureBase64: "sig",
      }),
    () => postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader }),
  ];
}

describe("the withheld-runtime answer is what the door returns today, and it is JSON", () => {
  it("a JSON 410 is RAISED, not handed back as a session answer", async () => {
    const ep = answering({ status: 410, body: WALL_BODY });
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
      expect(e.message).toContain("PAY_RUNTIME_WITHHELD");
      expect(e.message).toContain("nothing was journaled");
      expect(e.body).toContain("real_value");
    }
  });

  it("ALL FOUR doors raise on it — the wall claims the namespace, not one path", async () => {
    const doors = await everyDoor(answering({ status: 410, body: WALL_BODY }));
    expect(doors.length).toBe(4);
    for (const call of doors) {
      await expect(call()).rejects.toBeInstanceOf(SessionTransportError);
    }
  });

  it("the wall is recognised by its CODE, not by the status it happens to carry", async () => {
    const ep = answering({ status: 403, body: WALL_BODY });
    const f = await fixture();
    await expect(
      postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader }),
    ).rejects.toThrow(/PAY_RUNTIME_WITHHELD/);
  });

  it("the HTML spelling of the SAME wall behaves identically", async () => {
    const ep = answering({ status: 410, body: "<!doctype html><h1>Gone</h1>" });
    const f = await fixture();
    await expect(
      postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader }),
    ).rejects.toBeInstanceOf(SessionTransportError);
  });
});

describe("an authoritative refusal is returned, never raised", () => {
  it("`expired` at 200 is data — a decision the server computed", async () => {
    const ep = answering({
      status: 200,
      body: JSON.stringify({
        schema: "voidly.session.redeem/v1",
        outcome: {
          kind: "expired",
          grant_hash: "b".repeat(64),
          expires_at_ms: NOW,
          now_ms: NOW + 1,
        },
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
    expect((res.body.outcome as { kind: string }).kind).toBe("expired");
  });

  it("the doors' real non-2xx refusals stay DATA and are not confused with the wall", async () => {
    for (const [status, code] of [
      [403, "session_identity_unregistered"],
      [409, "provider_proof_replayed"],
      [422, "settlement_indeterminate"],
      [501, "session_settlement_adapters_unconfigured"],
    ] as Array<[number, string]>) {
      const ep = answering({
        status,
        body: JSON.stringify({ schema: "s", outcome: { kind: "rejected", reason: code } }),
      });
      const f = await fixture();
      const res = await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
      expect(res.status).toBe(status);
      expect((res.body as { outcome: { reason: string } }).outcome.reason).toBe(code);
    }
  });
});

describe("a door that never answers is its own outcome", () => {
  it("a timeout arrives as SessionTransportError at status 0, not as a host TypeError", async () => {
    const ep = failing(new DOMException("The operation was aborted.", "AbortError"));
    const f = await fixture();
    try {
      await postRedeem(ep, {
        wire: f.hire.wire,
        acceptance: f.accepted.acceptance,
        acceptanceSignatureBase64: f.accepted.signature_base64,
        evidence: x402SessionEvidence(TX),
        proofHeader: f.proofHeader,
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionTransportError);
      const e = err as SessionTransportError;
      expect(e.status).toBe(0);
      expect(e.message).toContain("THIS IS NOT A REFUSAL");
      expect(e.message).toContain("NOT PROOF NOTHING HAPPENED");
      expect(e.message).toContain("Re-present the SAME evidence");
    }
  });

  it("a refused connection is the same outcome, and is NOT the 410", async () => {
    const wall = answering({ status: 410, body: WALL_BODY });
    const down = failing(new TypeError("fetch failed"));
    const f = await fixture();
    const statuses: number[] = [];
    for (const ep of [wall, down]) {
      try {
        await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SessionTransportError);
        statuses.push((err as SessionTransportError).status);
      }
    }
    expect(statuses).toEqual([410, 0]);
  });

  it("all four doors report an unfinished call the same way", async () => {
    const doors = await everyDoor(failing(new TypeError("fetch failed")));
    for (const call of doors) {
      await expect(call()).rejects.toBeInstanceOf(SessionTransportError);
    }
  });

  it("a body that starts and then dies is carried, not leaked as a stream error", async () => {
    const ep: SessionEndpoint = {
      baseUrl: BASE,
      fetch: (async () => ({
        status: 200,
        text: async () => {
          throw new TypeError("terminated");
        },
      })) as unknown as typeof fetch,
    };
    const f = await fixture();
    try {
      await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionTransportError);
      const e = err as SessionTransportError;
      expect(e.status).toBe(200);
      expect(e.message).toContain("could not be read");
    }
  });
});

describe("a response is not trusted for being parseable", () => {
  it("`null`, a number, a string and an array are all refused", async () => {
    for (const body of ["null", "7", '"gone"', "[]", "[{\"outcome\":1}]"]) {
      const ep = answering({ status: 200, body });
      const f = await fixture();
      try {
        await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
        throw new Error(`expected a throw for ${body}`);
      } catch (err) {
        expect(err, `body ${body} was accepted`).toBeInstanceOf(SessionTransportError);
        expect((err as SessionTransportError).message).toContain("not an object");
      }
    }
  });

  it("POSITIVE CONTROL: an ordinary object is still accepted", async () => {
    const ep = answering({ status: 200, body: JSON.stringify({ schema: "s", outcome: {} }) });
    const f = await fixture();
    const res = await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schema: "s", outcome: {} });
  });

  it("an EMPTY body is a non-JSON answer, not an empty answer", async () => {
    const ep = answering({ status: 502, body: "" });
    const f = await fixture();
    try {
      await postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionTransportError);
      expect((err as SessionTransportError).status).toBe(502);
      expect((err as SessionTransportError).message).toContain("non-JSON");
    }
  });

  it("the paths are still the four the rail routes", () => {
    expect(Object.values(SESSION_PATHS).sort()).toEqual([
      "/v1/pay/session/deliver",
      "/v1/pay/session/reattest",
      "/v1/pay/session/recover",
      "/v1/pay/session/redeem",
    ]);
  });
});
