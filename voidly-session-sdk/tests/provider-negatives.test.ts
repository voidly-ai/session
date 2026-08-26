
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  buildRedemptionProofHeader,
  envelopeHash,
  reviewHire,
  sealTaskResult,
  signCanonical,
  signDelivery,
  timestampMs,
  MIN_NONCE_LENGTH,
  type HireWire,
  type SessionEntropy,
  type SessionKey,
  type TaskCapsule,
} from "../src/index";
import { NOW, freshHire, party, rebind, sealWire, seededEntropy } from "./_fixtures";

const AT = NOW + 1_000;

describe("reviewHire: BASELINE", () => {
  it("an untampered hire reviews clean", async () => {
    const { hirer, provider, hire } = await freshHire();
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review.ok).toBe(true);
  });
});

describe("reviewHire: the hirer's two signatures are CHECKED, not assumed", () => {
  it("refuses a grant whose signature does not cover it", async () => {
    const { hirer, provider, hire } = await freshHire();
    const overADifferentGrant = await signCanonical(
      { ...hire.wire.grant, price_max_amount: "2" },
      hirer.sign,
    );
    const wire: HireWire = { ...hire.wire, grant_signature_base64: overADifferentGrant! };

    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "invalid_grant_signature" });
  });

  it("refuses an offer whose signature does not cover it", async () => {
    const { hirer, provider, hire } = await freshHire();
    const overADifferentOffer = await signCanonical(
      { ...hire.wire.offer, service_ref: "something.else" },
      hirer.sign,
    );
    const wire: HireWire = { ...hire.wire, offer_signature_base64: overADifferentOffer! };

    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "invalid_offer_signature" });
  });

  it("refuses a signature from a key that is not the grant's hirer", async () => {
    const { provider, hire } = await freshHire();
    const impostor = party(8);
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: impostor.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "hirer_key_not_derivable" });
  });

  it("refuses a hirer key that is not 32 raw Ed25519 bytes", async () => {
    const { hirer, provider, hire } = await freshHire();
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey.slice(0, 31),
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "hirer_key_invalid" });
  });
});

describe("reviewHire: the hash chain is RECOMPUTED, and every link is checked", () => {
  it("refuses a grant pointing at a DIFFERENT offer", async () => {
    const { hirer, provider, hire } = await freshHire();
    const other = await freshHire(0x123456);
    const otherOfferHash = await envelopeHash(other.hire.wire.offer);
    expect(otherOfferHash).not.toBe(hire.wire.grant.offer_hash);

    const wire = await sealWire(
      hirer,
      hire.wire.offer,
      { ...hire.wire.grant, offer_hash: otherOfferHash },
      hire.wire.capsule,
    );
    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "grant_offer_mismatch" });
  });

  it("refuses a capsule swapped for another hire's", async () => {
    const { hirer, provider, hire } = await freshHire();
    const other = await freshHire(0x123456);
    expect(other.hire.wire.capsule.body_base64).not.toBe(hire.wire.capsule.body_base64);
    const wire: HireWire = { ...hire.wire, capsule: other.hire.wire.capsule };

    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "grant_capsule_mismatch" });
  });

  it("refuses a capsule that names an offer the grant does not", async () => {
    const { hirer, provider, hire } = await freshHire();
    const other = await freshHire(0x123456);
    const otherOfferHash = await envelopeHash(other.hire.wire.offer);

    const capsule: TaskCapsule = { ...hire.wire.capsule, offer_hash: otherOfferHash };
    const wire = await sealWire(
      hirer,
      hire.wire.offer,
      { ...hire.wire.grant, capsule_hash: await envelopeHash(capsule) },
      capsule,
    );
    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "capsule_offer_mismatch" });
  });

  it("refuses a capsule sealed to an encryption key the grant never named", async () => {
    const { hirer, provider, hire } = await freshHire();
    const strangerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(77));
    const capsule: TaskCapsule = {
      ...hire.wire.capsule,
      recipient_enc_pubkey_base64: encodeBase64(strangerEnc.publicKey),
    };
    const wire = await sealWire(
      hirer,
      hire.wire.offer,
      { ...hire.wire.grant, capsule_hash: await envelopeHash(capsule) },
      capsule,
    );
    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "recipient_binding_mismatch" });
  });
});

describe("reviewHire: the terms in the grant are the terms in the offer", () => {
  it.each([
    ["price_max_amount", { price_max_amount: "9000000" }],
    ["price_min_amount", { price_min_amount: "1" }],
    [
      "price_payee_account",
      { price_payee_account: "eip155:8453:0x3333333333333333333333333333333333333333" },
    ],
    [
      "price_payer_account",
      { price_payer_account: "eip155:8453:0x4444444444444444444444444444444444444444" },
    ],
  ])("refuses a grant whose %s differs from the offer's", async (_field, override) => {
    const { hirer, provider, hire } = await freshHire();
    const wire = await sealWire(
      hirer,
      hire.wire.offer,
      { ...hire.wire.grant, ...override },
      hire.wire.capsule,
    );
    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "grant_price_mismatch" });
  });

  it("refuses a grant that OUTLIVES its offer", async () => {
    const { hirer, provider, hire } = await freshHire();
    const offerExpiry = timestampMs(hire.wire.offer.expires_at)!;
    const wire = await sealWire(
      hirer,
      hire.wire.offer,
      { ...hire.wire.grant, expires_at: new Date(offerExpiry + 60_000).toISOString() },
      hire.wire.capsule,
    );
    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "grant_outlives_offer" });
  });

  it("refuses a grant whose hirer is not the offer's hirer", async () => {
    const { hirer, provider, hire } = await freshHire();
    const stranger = party(21);
    const bound = await rebind(
      { ...hire.wire.offer, hirer_did: stranger.did },
      hire.wire.grant,
      hire.wire.capsule,
    );
    const wire = await sealWire(hirer, bound.offer, bound.grant, bound.capsule);

    const review = await reviewHire({
      wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "grant_hirer_mismatch" });
  });

  it("refuses a hire addressed to a DIFFERENT provider", async () => {
    const { hirer, hire } = await freshHire();
    const someoneElse = party(7);
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: someoneElse.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review).toEqual({ ok: false, reason: "provider_did_mismatch" });
  });
});

describe("sealTaskResult: the two-time-pad guard is armed with the BRIEF's nonce", () => {
  it("REFUSES to seal when the drawn nonce repeats the brief's", async () => {
    const { hirer, provider, hire } = await freshHire();
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const briefNonce = Uint8Array.from(atob(review.capsule.body_nonce_base64), (c) =>
      c.charCodeAt(0),
    );
    const stuck: SessionEntropy = {
      random: (n: number) => (n === 24 ? Uint8Array.from(briefNonce) : seededEntropy(5).random(n)),
      nonce: () => seededEntropy(5).nonce(),
    };

    await expect(
      sealTaskResult({
        result: "the work",
        grantHash: review.grantHash,
        sessionKey: hire.keep.sessionKey,
        briefCapsule: review.capsule,
        entropy: stuck,
      }),
      "sealTaskResult sealed a result under the BRIEF's body nonce — a two-time pad",
    ).rejects.toThrow(/two-time pad/);
  });

  it("BASELINE: an ordinary draw seals, and does not repeat the brief's nonce", async () => {
    const { hirer, provider, hire } = await freshHire();
    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: AT,
    });
    if (!review.ok) throw new Error("fixture review failed");
    const sealed = await sealTaskResult({
      result: "the work",
      grantHash: review.grantHash,
      sessionKey: hire.keep.sessionKey as SessionKey,
      briefCapsule: review.capsule,
      entropy: seededEntropy(0x9999),
    });
    expect(sealed.capsule.body_nonce_base64).not.toBe(review.capsule.body_nonce_base64);
  });
});

describe("buildRedemptionProofHeader: SINGLE USE means a FRESH nonce every attempt", () => {
  function decode(headerValue: string): { envelope: Record<string, unknown> } {
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(headerValue), (c) => c.charCodeAt(0))),
    );
  }

  it("two headers built from identical inputs are DIFFERENT", async () => {
    const { provider, hire } = await freshHire();
    const args = {
      providerDid: provider.did,
      grantHash: hire.keep.grant_hash,
      sign: provider.sign,
      nowMs: NOW + 3_000,
    };
    const a = await buildRedemptionProofHeader(args);
    const b = await buildRedemptionProofHeader(args);

    expect(a.name).toBe("x-voidly-session-provider-proof");
    expect(a.value, "the same header value twice is a replayed credential").not.toBe(b.value);

    const na = decode(a.value).envelope.action_nonce as string;
    const nb = decode(b.value).envelope.action_nonce as string;
    expect(na).not.toBe(nb);
    expect(na.length).toBeGreaterThanOrEqual(MIN_NONCE_LENGTH);
  });

  it("sixteen headers are sixteen distinct values", async () => {
    const { provider, hire } = await freshHire();
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const h = await buildRedemptionProofHeader({
        providerDid: provider.did,
        grantHash: hire.keep.grant_hash,
        sign: provider.sign,
        nowMs: NOW + 3_000,
      });
      seen.add(h.value);
    }
    expect(seen.size).toBe(16);
  });
});

describe("signDelivery does not invent the recovery deadline", () => {
  it("the receipt carries EXACTLY the recoverable_until it was given", async () => {
    const { hire, provider } = await freshHire();
    const fromRedeemResponse = NOW + 90 * 60_000;
    const signed = await signDelivery({
      grantHash: hire.keep.grant_hash,
      offerHash: hire.keep.offer_hash,
      providerDid: provider.did,
      resultCapsuleHash: "d".repeat(64),
      resultCommitment: "e".repeat(64),
      recoverableUntilMs: fromRedeemResponse,
      nowMs: NOW + 6_000,
      sign: provider.sign,
    });
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(timestampMs(signed.receipt.recoverable_until)).toBe(fromRedeemResponse);
  });
});
