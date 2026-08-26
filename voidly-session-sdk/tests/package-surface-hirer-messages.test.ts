
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import nacl from "tweetnacl";
import { ensureBuilt } from "./_ensureBuilt";

const PKG_DIR = resolve(__dirname, "..");
const PKG = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"));

const ENTRY = resolve(PKG_DIR, String(PKG.main));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SDK: any;

beforeAll(async () => {
  const built = ensureBuilt(PKG_DIR);
  expect(built, "package.json `main` and the build do not agree on the entry point").toBe(ENTRY);
  SDK = await import(pathToFileURL(ENTRY).href);
}, 300_000);

const NOW = 1_760_000_000_000;
const GRANT_HASH = "a".repeat(64);
const PROVIDER_DID = "did:voidly:zQ3shV4Tn8kEXAMPLEprovider1";

function hirer() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  return {
    publicKey: kp.publicKey,
    sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
  };
}

describe("the entry point is real and is the one package.json advertises", () => {
  it("`main` resolves to a module that loads", () => {
    expect(typeof PKG.main).toBe("string");
    expect(SDK, `package.json main (${PKG.main}) did not load`).toBeTruthy();
  });

  it("POSITIVE CONTROL: the surface is being read, not an empty object", () => {
    expect(Object.keys(SDK).length).toBeGreaterThan(50);
    expect(typeof SDK.buildHire).toBe("function");
  });
});

describe("the hirer can build and sign a settlement hint from the package alone", () => {
  it("`buildSettlementHint` is ON the surface", () => {
    expect(
      typeof SDK.buildSettlementHint,
      "buildSettlementHint is not exported from the package entry point. A hirer " +
        "cannot point a provider at the payment it just made, which is the whole " +
        "of the gap this file closes.",
    ).toBe("function");
  });

  it("builds the four signed fields, and nothing else", async () => {
    const evidence = SDK.x402SessionEvidence(`0x${"7f".repeat(32)}`);
    const hint = await SDK.buildSettlementHint({
      grantHash: GRANT_HASH,
      providerDid: PROVIDER_DID,
      evidence,
      nowMs: NOW,
    });
    expect(Object.keys(hint).sort()).toEqual([
      "evidence_hash",
      "grant_hash",
      "issued_at",
      "provider_did",
      "schema",
    ]);
    expect(hint.schema).toBe("voidly.session.settlement-hint/v1");
    expect(hint.grant_hash).toBe(GRANT_HASH);
    expect(hint.provider_did).toBe(PROVIDER_DID);
    expect(hint.issued_at).toBe("2025-10-09T08:53:20.000Z");
    expect(hint.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the hint the hirer signs verifies under the hirer's own key — the full client leg", async () => {
    const h = hirer();
    const evidence = SDK.x402SessionEvidence(`0x${"7f".repeat(32)}`);
    const hint = await SDK.buildSettlementHint({
      grantHash: GRANT_HASH,
      providerDid: PROVIDER_DID,
      evidence,
      nowMs: NOW,
    });
    const signature = await SDK.signCanonical(hint, h.sign);
    expect(typeof signature).toBe("string");
    expect(SDK.verifyDetached(hint, signature, h.publicKey)).toBe(true);
  });

  it("the evidence hash is bound to the evidence — a swapped pointer breaks the signature's meaning", async () => {
    const a = await SDK.buildSettlementHint({
      grantHash: GRANT_HASH, providerDid: PROVIDER_DID, nowMs: NOW,
      evidence: SDK.x402SessionEvidence(`0x${"7f".repeat(32)}`),
    });
    const b = await SDK.buildSettlementHint({
      grantHash: GRANT_HASH, providerDid: PROVIDER_DID, nowMs: NOW,
      evidence: SDK.x402SessionEvidence(`0x${"3c".repeat(32)}`),
    });
    expect(a.evidence_hash).not.toBe(b.evidence_hash);
  });

  it("the provider's ADMISSION POLICY is NOT on the surface, and must not be", () => {
    for (const name of [
      "authenticateSettlementHint",
      "validateSettlementHint",
      "hirerKeyFromStoredHire",
      "HINT_MAX_SKEW_MS",
      "HINT_MAX_AGE_MS",
    ]) {
      expect(SDK[name], `${name} leaked onto the client surface`).toBeUndefined();
    }
  });
});

describe("the hirer can SEND the hint, not only build and sign it", () => {

  it("`submitSettlementHint` is ON the surface", () => {
    expect(
      typeof SDK.submitSettlementHint,
      "submitSettlementHint is not exported from the package entry point. A hirer " +
        "can build and sign the pointer at its own payment and then has to " +
        "hand-roll the POST — the same shape as the other gaps this file closes.",
    ).toBe("function");
  });

  it("sends the hint the hirer signed, over the built bundle", async () => {
    const h = hirer();
    const grant = { schema: "voidly-session-grant/v1", provider_did: PROVIDER_DID };
    const grantHash = await SDK.hashArtifact(grant);
    const evidence = SDK.x402SessionEvidence(`0x${"7f".repeat(32)}`);

    let body: Record<string, unknown> | null = null;
    const out = await SDK.submitSettlementHint({
      url: "https://provider.invalid/session/deliver-hint",
      grant,
      grantHash,
      evidence,
      sign: h.sign,
      nowMs: NOW,
      fetchImpl: async (_url: string, init: { body: string }) => {
        body = JSON.parse(init.body);
        return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
      },
    });

    expect(out.kind, `refused: ${JSON.stringify(out)}`).toBe("acknowledged");
    const sent = body as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["evidence", "hint", "hint_signature_base64"]);
    const hint = sent.hint as Record<string, unknown>;
    expect(hint.provider_did).toBe(PROVIDER_DID);
    expect(hint.grant_hash).toBe(grantHash);
    expect(SDK.verifyDetached(hint, sent.hint_signature_base64, h.publicKey)).toBe(true);
  });

  it("sends NOTHING when the anchor does not hold", async () => {
    let calls = 0;
    const out = await SDK.submitSettlementHint({
      url: "https://provider.invalid/session/deliver-hint",
      grant: { schema: "voidly-session-grant/v1", provider_did: PROVIDER_DID },
      grantHash: "f".repeat(64),
      evidence: SDK.x402SessionEvidence(`0x${"7f".repeat(32)}`),
      sign: hirer().sign,
      nowMs: NOW,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not be reached");
      },
    });
    expect(out.kind).toBe("unbuildable");
    expect(out.reason).toBe("grant_hash_mismatch");
    expect(calls, "the hint door contacted the provider on a mismatched anchor").toBe(0);
  });

  it("the ADMISSION POLICY is still absent beside the new door", () => {
    for (const name of [
      "authenticateSettlementHint",
      "validateSettlementHint",
      "hirerKeyFromStoredHire",
      "HINT_MAX_SKEW_MS",
      "HINT_MAX_AGE_MS",
    ]) {
      expect(SDK[name], `${name} leaked onto the client surface`).toBeUndefined();
    }
  });
});

describe("the hirer can build its own recovery request from the package alone", () => {
  it("`buildRecoveryRequest` is ON the surface", () => {
    expect(
      typeof SDK.buildRecoveryRequest,
      "buildRecoveryRequest is not exported from the package entry point. " +
        "`postRecover` IS exported and takes a `request` nothing on this surface " +
        "can produce — the hirer can pay and then cannot read what it paid for. " +
        "That is the gap.",
    ).toBe("function");
  });

  it("builds a request that the package's OWN validator accepts", async () => {
    const h = hirer();
    const did = SDK.deriveDidFromSigningKey(h.publicKey);
    const out = await SDK.buildRecoveryRequest({
      grantHash: GRANT_HASH,
      requesterDid: did,
      actionNonce: "b".repeat(32),
      nowMs: NOW,
      ttlMs: 10 * 60_000,
      sign: h.sign,
    });
    expect(out.ok, `refused: ${out.reason}`).toBe(true);
    if (!out.ok) return;

    expect(out.request.grant_hash).toBe(GRANT_HASH);
    expect(out.request.requester_did).toBe(did);
    const checked = SDK.validateRecoveryRequest(out.request, NOW);
    expect(checked.ok, `the package's own validator refused it: ${checked.reason}`).toBe(true);
    expect(SDK.verifyDetached(out.request, out.signature_base64, h.publicKey)).toBe(true);
  });

  it("the SERVER's read path stays absent — the builder is not a door to it", () => {
    expect(SDK.recoverTask, "recoverTask leaked onto the client surface").toBeUndefined();
    expect(SDK.deliverResult).toBeUndefined();
    expect(SDK.redeemGrant).toBeUndefined();
    expect(typeof SDK.postRecover).toBe("function");
  });

  it("`recoverResult` is ON the surface — the ASK and the READ, in one call", () => {
    expect(
      typeof SDK.recoverResult,
      "recoverResult is not exported from the package entry point. A hirer can " +
        "build a recovery request and post it, and then has to hand-roll the " +
        "authentication and the open — which is what both fork walks in this " +
        "repo did. That is B1.",
    ).toBe("function");
    expect(
      typeof SDK.openDeliveredResult,
      "openDeliveredResult is not exported. A hirer whose delivery arrived over " +
        "some other carrier has no packaged way to authenticate and open it.",
    ).toBe("function");
  });

  it("`openTaskResult` is OFF the surface — the commitment is not a parameter", () => {
    expect(
      SDK.openTaskResult,
      "openTaskResult is back on the client surface. It takes `resultCommitment` " +
        "as a bare string, so `answer.receipt.result_commitment` (off the wire, " +
        "unverified) and `verified.receipt.result_commitment` are one property " +
        "access apart and both compile. Publish the composed door.",
    ).toBeUndefined();
    expect(
      SDK.validateDeliveryReceipt,
      "validateDeliveryReceipt is back on the client surface. It answers ok:true " +
        "over a receipt nobody signed, one prefix-word from verifyDeliveryReceipt " +
        "in the same namespace. See THE VALIDATOR RULE in src/index.ts.",
    ).toBeUndefined();
  });

  it("the THREE ANSWER KEYS are now published on the generated .d.ts", () => {
    const dts = readFileSync(resolve(PKG_DIR, "dist/index.d.ts"), "utf-8");
    for (const key of ["receipt_signature_base64", "result_capsule", "result_commitment"]) {
      expect(
        dts.includes(key),
        `${key} appears nowhere in dist/index.d.ts — the hirer has to dig it out ` +
          `of an \`unknown\`, from a field name this package publishes nowhere.`,
      ).toBe(true);
    }
  });
});

describe("the hirer can SUBMIT a hire and AUTHENTICATE the answer from the package alone", () => {

  function grantNaming(providerDid: string, providerPubkey: Uint8Array) {
    return {
      schema: "voidly-session-grant/v1",
      provider_did: providerDid,
      provider_signing_pubkey_base64: Buffer.from(providerPubkey).toString("base64"),
    };
  }
  function party(seed: number) {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
    return {
      publicKey: kp.publicKey,
      sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
    };
  }
  function accepted(grantHash: string, env: unknown, signature: string) {
    return {
      schema: "voidly-session-hire-accepted/v1",
      grant_hash: grantHash,
      acceptance: env,
      acceptance_signature_base64: signature,
    };
  }

  it("`submitHire`, `authenticateHireAcceptance` and `buildHireMessage` are ON the surface", () => {
    for (const name of ["submitHire", "authenticateHireAcceptance", "buildHireMessage"]) {
      expect(
        typeof SDK[name],
        `${name} is not exported from the package entry point. A stranger must ` +
          `hand-assemble the eight-key hire envelope, hand-roll the POST, and ` +
          `hand-roll the provider's countersignature check.`,
      ).toBe("function");
    }
  });

  it("the two halves of the authentication are NOT, and neither is the triple-taking door", () => {
    for (const name of ["validateHireAccepted", "verifyHireAcceptance", "postHire"]) {
      expect(SDK[name], `${name} leaked onto the client surface`).toBeUndefined();
    }
  });

  it("an acceptance from the HIRED provider authenticates", async () => {
    const p = party(11);
    const did = SDK.deriveDidFromSigningKey(p.publicKey);
    const grant = grantNaming(did, p.publicKey);
    const grantHash = await SDK.hashArtifact(grant);

    const built = await SDK.acceptHire({ grantHash, providerDid: did, sign: p.sign, nowMs: NOW });
    expect(built.ok, `acceptHire refused: ${built.reason}`).toBe(true);
    if (!built.ok) return;

    const out = await SDK.authenticateHireAcceptance({
      raw: accepted(grantHash, built.acceptance, built.signature_base64),
      grant,
      grantHash,
      nowMs: NOW,
    });
    expect(out.ok, `refused: ${out.reason}`).toBe(true);
  });

  it("THE MONEY-LOSING DEFAULT: an acceptance from a DIFFERENT provider is refused", async () => {
    const p = party(11);
    const q = party(22);
    const pDid = SDK.deriveDidFromSigningKey(p.publicKey);
    const qDid = SDK.deriveDidFromSigningKey(q.publicKey);
    expect(pDid).not.toBe(qDid);

    const grant = grantNaming(pDid, p.publicKey);
    const grantHash = await SDK.hashArtifact(grant);

    const built = await SDK.acceptHire({ grantHash, providerDid: qDid, sign: q.sign, nowMs: NOW });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const out = await SDK.authenticateHireAcceptance({
      raw: accepted(grantHash, built.acceptance, built.signature_base64),
      grant,
      grantHash,
      nowMs: NOW,
    });
    expect(out.ok, "an acceptance naming a DIFFERENT redeemer was accepted").toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("acceptance_redeemer_mismatch");
  });

  it("an acceptance naming the right provider but signed by another is refused", async () => {
    const p = party(11);
    const q = party(22);
    const pDid = SDK.deriveDidFromSigningKey(p.publicKey);
    const grant = grantNaming(pDid, p.publicKey);
    const grantHash = await SDK.hashArtifact(grant);

    const forged = await SDK.acceptHire({ grantHash, providerDid: pDid, sign: q.sign, nowMs: NOW });
    expect(forged.ok).toBe(true);
    if (!forged.ok) return;

    const out = await SDK.authenticateHireAcceptance({
      raw: accepted(grantHash, forged.acceptance, forged.signature_base64),
      grant,
      grantHash,
      nowMs: NOW,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("invalid_acceptance_signature");
  });

  it("an acceptance about a DIFFERENT grant is refused", async () => {
    const p = party(11);
    const did = SDK.deriveDidFromSigningKey(p.publicKey);
    const grant = grantNaming(did, p.publicKey);
    const grantHash = await SDK.hashArtifact(grant);
    const otherHash = "c".repeat(64);

    const built = await SDK.acceptHire({ grantHash: otherHash, providerDid: did, sign: p.sign, nowMs: NOW });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const out = await SDK.authenticateHireAcceptance({
      raw: accepted(grantHash, built.acceptance, built.signature_base64),
      grant,
      grantHash,
      nowMs: NOW,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("acceptance_grant_mismatch");
  });

  it("a mismatched (grant, grantHash) pair is refused before anything is read", async () => {
    const p = party(11);
    const did = SDK.deriveDidFromSigningKey(p.publicKey);
    const out = await SDK.authenticateHireAcceptance({
      raw: { anything: true },
      grant: grantNaming(did, p.publicKey),
      grantHash: "d".repeat(64),
      nowMs: NOW,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("grant_hash_mismatch");
  });

  it("`submitHire` sends NOTHING when the anchor does not hold", async () => {
    const p = party(11);
    let calls = 0;
    const out = await SDK.submitHire({
      url: "https://provider.invalid/hire",
      wire: { grant: grantNaming(SDK.deriveDidFromSigningKey(p.publicKey), p.publicKey) },
      grantHash: "e".repeat(64),
      authorization: { scheme: "eip3009" },
      sign: p.sign,
      nowMs: NOW,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not be reached");
      },
    });
    expect(out.kind).toBe("unbuildable");
    expect(out.reason).toBe("grant_hash_mismatch");
    expect(calls, "submitHire contacted the provider on a mismatched anchor").toBe(0);
  });
});
