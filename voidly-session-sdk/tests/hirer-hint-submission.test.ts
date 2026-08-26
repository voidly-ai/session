
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import {
  canonicalBytes,
  hashArtifact,
  sha256Hex,
  submitSettlementHint,
  verifyDetached,
  x402SessionEvidence,
} from "../src/index";
import type { Signer, TaskGrantEnvelope } from "../src/index";
import * as SDK from "../src/index";
import { freshHire, NOW, party } from "./_fixtures";

const TX = `0x${"7f".repeat(32)}`;
const URL_ = "https://provider.example/session/deliver-hint";

interface Capture {
  calls: number;
  url: string | null;
  init: RequestInit | null;
  body: Record<string, unknown> | null;
}

function recorder(answer: () => Response): { fetchImpl: SDK.FetchLike; seen: Capture } {
  const seen: Capture = { calls: 0, url: null, init: null, body: null };
  const fetchImpl: SDK.FetchLike = async (url, init) => {
    seen.calls += 1;
    seen.url = url;
    seen.init = init;
    seen.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return answer();
  };
  return { fetchImpl, seen };
}

const accepted = () =>
  new Response(JSON.stringify({ status: "accepted" }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });

const HIRER = party(1);

async function realGrant(): Promise<{ grant: TaskGrantEnvelope; grantHash: string }> {
  const { hire } = await freshHire();
  if (!hire.ok) throw new Error("fixture hire failed");
  return { grant: hire.wire.grant, grantHash: hire.keep.grant_hash };
}

describe("the hirer can SEND the pointer it can already build and sign", () => {

  it("posts the three-key body to the given url, and nothing else", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder(accepted);

    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    expect(out.kind, `refused: ${JSON.stringify(out)}`).toBe("acknowledged");
    expect(seen.calls).toBe(1);
    expect(seen.url).toBe(URL_);
    expect(seen.init?.method).toBe("POST");
    expect(Object.keys(seen.body ?? {}).sort()).toEqual([
      "evidence",
      "hint",
      "hint_signature_base64",
    ]);
  });

  it("THE HASH AND THE BLOB ARE THE SAME VALUE — evidence_hash covers what was posted", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder(accepted);
    const evidence = x402SessionEvidence(TX);

    await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence,
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    const hint = seen.body?.hint as Record<string, unknown>;
    expect(seen.body?.evidence).toEqual(evidence);
    expect(hint.evidence_hash).toBe(await sha256Hex(canonicalBytes(seen.body?.evidence ?? null)));
  });

  it("THE PROVIDER COMES OFF THE GRANT — it is not a parameter and cannot be steered", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder(accepted);

    await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    const hint = seen.body?.hint as Record<string, unknown>;
    expect(hint.provider_did).toBe(grant.provider_did);
    expect(hint.grant_hash).toBe(grantHash);
    expect(hint.schema).toBe("voidly.session.settlement-hint/v1");
    expect(Object.keys(hint).sort()).toEqual([
      "evidence_hash",
      "grant_hash",
      "issued_at",
      "provider_did",
      "schema",
    ]);
  });

  it("the hint on the wire verifies under the HIRER's own key", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder(accepted);

    await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    expect(
      verifyDetached(
        seen.body?.hint as object,
        String(seen.body?.hint_signature_base64),
        HIRER.signingPublicKey,
      ),
      "the signature on the wire does not cover the hint on the wire",
    ).toBe(true);
  });

  it("the acknowledged arm hands back the envelope that was actually sent", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder(accepted);

    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    expect(out.kind).toBe("acknowledged");
    if (out.kind !== "acknowledged") return;
    expect(out.status).toBe(202);
    expect(out.hint).toEqual(seen.body?.hint);
  });

  it("THE RETRY IS A FRESH ENVELOPE — two calls on a moving clock are strictly increasing", async () => {
    const { grant, grantHash } = await realGrant();
    const first = recorder(accepted);
    const second = recorder(accepted);

    const common = {
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign as Signer,
    };
    await submitSettlementHint({ ...common, nowMs: NOW, fetchImpl: first.fetchImpl });
    await submitSettlementHint({ ...common, nowMs: NOW + 1_000, fetchImpl: second.fetchImpl });

    const a = (first.seen.body?.hint as Record<string, unknown>).issued_at as string;
    const b = (second.seen.body?.hint as Record<string, unknown>).issued_at as string;
    expect(Date.parse(b)).toBeGreaterThan(Date.parse(a));
  });
});

describe("NOTHING IS SENT until every argument holds", () => {

  const mustNotBeReached: SDK.FetchLike = async () => {
    throw new Error("fetchImpl must not be reached");
  };

  it("a mismatched (grant, grantHash) pair sends nothing", async () => {
    const { grant } = await realGrant();
    let calls = 0;
    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash: "e".repeat(64),
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl: async (u, i) => {
        calls += 1;
        return mustNotBeReached(u, i);
      },
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("grant_hash_mismatch");
    expect(calls, "the door contacted the provider on a mismatched anchor").toBe(0);
  });

  it("a grant that names no provider sends nothing", async () => {
    const { grant } = await realGrant();
    const stripped = { ...(grant as unknown as Record<string, unknown>) };
    delete stripped.provider_did;
    const strippedHash = await hashArtifact(stripped);

    let calls = 0;
    const out = await submitSettlementHint({
      url: URL_,
      grant: stripped as unknown as TaskGrantEnvelope,
      grantHash: strippedHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl: async (u, i) => {
        calls += 1;
        return mustNotBeReached(u, i);
      },
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("provider_did_unusable");
    expect(calls).toBe(0);
  });

  it("evidence outside the canonical JSON subset sends nothing", async () => {
    const { grant, grantHash } = await realGrant();
    let calls = 0;
    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: { amount: 1.5 },
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl: async (u, i) => {
        calls += 1;
        return mustNotBeReached(u, i);
      },
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("evidence_unusable");
    expect(calls).toBe(0);
  });

  it("a signer that throws sends nothing", async () => {
    const { grant, grantHash } = await realGrant();
    let calls = 0;
    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: (() => {
        throw new Error("hsm offline");
      }) as Signer,
      nowMs: NOW,
      fetchImpl: async (u, i) => {
        calls += 1;
        return mustNotBeReached(u, i);
      },
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("signature_failed");
    expect(calls).toBe(0);
  });

  it("a signer that returns the wrong number of bytes sends nothing", async () => {
    const { grant, grantHash } = await realGrant();
    let calls = 0;
    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: (() => new Uint8Array(32)) as Signer,
      nowMs: NOW,
      fetchImpl: async (u, i) => {
        calls += 1;
        return mustNotBeReached(u, i);
      },
    });
    expect(out.kind).toBe("unbuildable");
    if (out.kind !== "unbuildable") return;
    expect(out.reason).toBe("signature_failed");
    expect(calls).toBe(0);
  });
});

describe("the answer is READ, and never over-read", () => {

  async function answerWith(res: Response) {
    const { grant, grantHash } = await realGrant();
    return submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl: async () => res,
    });
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("BOTH HALVES: a 202 carrying something else is not an acknowledgement", async () => {
    const out = await answerWith(json(202, { status: "queued" }));
    expect(out.kind).toBe("unrecognized");
    if (out.kind !== "unrecognized") return;
    expect(out.detail).toBe("response_not_an_acknowledgement");
  });

  it("BOTH HALVES: `{status:\"accepted\"}` under a 500 is not an acknowledgement either", async () => {
    const out = await answerWith(json(500, { status: "accepted" }));
    expect(out.kind).not.toBe("acknowledged");
    expect(out.kind).toBe("undelivered");
  });

  it("a named refusal is carried verbatim, with the door's own status", async () => {
    const out = await answerWith(json(409, { error: "hint_too_late" }));
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.status).toBe(409);
    expect(out.reason).toBe("hint_too_late");
  });

  it("a NAMED 5xx is a refusal, not a dropped leg", async () => {
    const out = await answerWith(json(503, { error: "provider_fault" }));
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.status).toBe(503);
    expect(out.reason).toBe("provider_fault");
  });

  it("a transport throw is `undelivered` — never a refusal", async () => {
    const { grant, grantHash } = await realGrant();
    const out = await submitSettlementHint({
      url: URL_,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl: async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    });
    expect(out.kind).toBe("undelivered");
    if (out.kind !== "undelivered") return;
    expect(out.detail).toBe("transport_failed");
  });

  it("an oversized answer is refused rather than parsed", async () => {
    const out = await answerWith(new Response("x".repeat(17_000), { status: 400 }));
    expect(out.kind).toBe("unrecognized");
    if (out.kind !== "unrecognized") return;
    expect(out.detail).toBe("response_too_large");
  });

  it("a refusal 'word' longer than a word is not carried into a caller's log", async () => {
    const out = await answerWith(json(400, { error: "z".repeat(200) }));
    expect(out.kind).toBe("unrecognized");
    if (out.kind !== "unrecognized") return;
    expect(out.detail).toBe("response_not_a_refusal");
  });

  it("a non-JSON 4xx is unrecognized; a non-JSON 5xx is a dropped leg", async () => {
    const four = await answerWith(new Response("<html>nope</html>", { status: 400 }));
    expect(four.kind).toBe("unrecognized");
    if (four.kind === "unrecognized") expect(four.detail).toBe("response_not_json");

    const five = await answerWith(new Response("<html>502</html>", { status: 502 }));
    expect(five.kind).toBe("undelivered");
    if (five.kind === "undelivered") expect(five.detail).toBe("response_not_json");
  });

  it("JSON that is not an object is unrecognized", async () => {
    const out = await answerWith(json(202, ["accepted"]));
    expect(out.kind).toBe("unrecognized");
    if (out.kind !== "unrecognized") return;
    expect(out.detail).toBe("response_not_object");
  });
});

describe("the door publishes the CLIENT's half and no admission policy", () => {

  it("the five withheld symbols are still absent", () => {
    const surface = SDK as unknown as Record<string, unknown>;
    for (const name of [
      "authenticateSettlementHint",
      "validateSettlementHint",
      "hirerKeyFromStoredHire",
      "HINT_MAX_SKEW_MS",
      "HINT_MAX_AGE_MS",
    ]) {
      expect(surface[name], `${name} leaked onto the client surface`).toBeUndefined();
    }
  });

  it("POSITIVE CONTROL: the surface is being read, and the door is on it", () => {
    const surface = SDK as unknown as Record<string, unknown>;
    expect(typeof surface.submitSettlementHint).toBe("function");
    expect(typeof surface.buildSettlementHint).toBe("function");
  });

  it("the daemon's own key-derivation helper is not reachable through the new import", () => {
    expect(nacl).toBeTruthy();
    const surface = SDK as unknown as Record<string, unknown>;
    expect(surface.hashSettlementEvidence).toBeUndefined();
  });
});
