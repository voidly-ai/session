
import { describe, expect, it } from "vitest";

import {
  acceptHire,
  envelopeHash,
  openBrief,
  openDeliveredResult,
  reviewHire,
  sealTaskResult,
  signCanonical,
  signDelivery,
  type HireWire,
} from "../src/index";

import { BRIEF, freshHire, NOW, seededEntropy } from "./_fixtures";

const RESULT =
  "Between 2026-01 and 2026-06 the confirmed incidents are enumerated below, each with a permalink.";

function attestationFor(input: {
  grantHash: string;
  capsuleHash: string;
  offerHash: string;
  hirerDid: string;
  providerDid: string;
  evidenceId: string;
  chain: string;
  asset: string;
  amount: string;
  redeemedAtMs: number;
  expiresAtMs: number;
}) {
  return {
    schema: "voidly-session-redemption-attestation/v1",
    grant_hash: input.grantHash,
    capsule_hash: input.capsuleHash,
    offer_hash: input.offerHash,
    hirer_did: input.hirerDid,
    provider_did: input.providerDid,
    evidence_id: input.evidenceId,
    settled_chain: input.chain,
    settled_asset: input.asset,
    settled_amount: input.amount,
    redeemed_at: new Date(input.redeemedAtMs).toISOString(),
    expires_at: new Date(input.expiresAtMs).toISOString(),
  };
}

describe("a private hire, end to end, through the published surface alone", () => {
  it("commission -> review -> countersign -> open the brief -> seal the result -> read it", async () => {
    const { hirer, provider, attestor, providerEnc, hire } = await freshHire(0x5eeded);

    expect(JSON.stringify(hire.keep.sessionKey)).toBe('"[redacted:session-key]"');

    const overTheWire = JSON.parse(JSON.stringify(hire.wire)) as HireWire;
    expect(JSON.stringify(overTheWire)).toBe(JSON.stringify(hire.wire));

    const review = await reviewHire({
      wire: overTheWire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: NOW + 1_000,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.terms.serviceRef).toBe("voidly.research.censorship-summary");
    expect(JSON.stringify(review.capsule)).not.toContain("DNS-tampering");

    const accepted = await acceptHire({
      grantHash: review.grantHash,
      providerDid: provider.did,
      sign: provider.sign,
      nowMs: NOW + 2_000,
      entropy: seededEntropy(0x1234),
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.acceptance.grant_hash).toBe(review.grantHash);

    const grant = hire.wire.grant;
    const attestation = attestationFor({
      grantHash: hire.keep.grant_hash,
      capsuleHash: review.capsuleHash,
      offerHash: review.offerHash,
      hirerDid: grant.hirer_did,
      providerDid: grant.provider_did,
      evidenceId: `0x${"7".repeat(64)}`,
      chain: grant.price_chain,
      asset: grant.price_asset,
      amount: grant.price_min_amount,
      redeemedAtMs: NOW + 4_000,
      expiresAtMs: Date.parse(grant.expires_at),
    });
    const attestationSignature = await signCanonical(attestation, attestor.sign);
    expect(attestationSignature).not.toBeNull();

    const opened = await openBrief({
      wire: overTheWire,
      attestation: JSON.parse(JSON.stringify(attestation)),
      attestationSignatureBase64: attestationSignature!,
      attestorSigningPublicKey: attestor.signingPublicKey,
      hirerSigningPublicKey: hirer.signingPublicKey,
      providerDid: provider.did,
      recipientEncSecretKey: providerEnc.secretKey,
      nowMs: NOW + 5_000,
    });
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;
    expect(opened.brief).toBe(BRIEF);

    const sealed = await sealTaskResult({
      result: RESULT,
      grantHash: review.grantHash,
      sessionKey: opened.sessionKey,
      briefCapsule: review.capsule,
      entropy: seededEntropy(0x9999),
    });
    expect(sealed.capsule.body_nonce_base64).not.toBe(review.capsule.body_nonce_base64);

    const receipt = await signDelivery({
      grantHash: review.grantHash,
      offerHash: review.offerHash,
      providerDid: provider.did,
      resultCapsuleHash: sealed.resultCapsuleHash,
      resultCommitment: sealed.resultCommitment,
      recoverableUntilMs: Date.parse(grant.expires_at),
      nowMs: NOW + 6_000,
      sign: provider.sign,
    });
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    const read = await openDeliveredResult({
      receipt: JSON.parse(JSON.stringify(receipt.receipt)),
      signatureBase64: receipt.signature_base64,
      resultCapsule: JSON.parse(JSON.stringify(sealed.capsule)),
      grant: hire.wire.grant,
      grantHash: hire.keep.grant_hash,
      sessionKey: hire.keep.sessionKey,
      nowMs: NOW + 7_000,
    });
    expect(read.kind).toBe("opened");
    if (read.kind !== "opened") return;
    expect(read.result).toBe(RESULT);
    expect(read.receipt.result_commitment).toBe(sealed.resultCommitment);
  });

  it("REFUSES to open the brief on an attestation about another hire", async () => {
    const { hirer, provider, attestor, providerEnc, hire } = await freshHire(0x5eeded);
    const other = await freshHire(0xfeed11);

    const review = await reviewHire({
      wire: hire.wire,
      expectedProviderDid: provider.did,
      hirerSigningPublicKey: hirer.signingPublicKey,
      nowMs: NOW + 1_000,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;

    const grant = hire.wire.grant;
    const attestation = attestationFor({
      grantHash: other.hire.keep.grant_hash,
      capsuleHash: review.capsuleHash,
      offerHash: review.offerHash,
      hirerDid: grant.hirer_did,
      providerDid: grant.provider_did,
      evidenceId: `0x${"7".repeat(64)}`,
      chain: grant.price_chain,
      asset: grant.price_asset,
      amount: grant.price_min_amount,
      redeemedAtMs: NOW + 4_000,
      expiresAtMs: Date.parse(grant.expires_at),
    });
    const signature = await signCanonical(attestation, attestor.sign);

    const opened = await openBrief({
      wire: hire.wire,
      attestation: JSON.parse(JSON.stringify(attestation)),
      attestationSignatureBase64: signature!,
      attestorSigningPublicKey: attestor.signingPublicKey,
      hirerSigningPublicKey: hirer.signingPublicKey,
      providerDid: provider.did,
      recipientEncSecretKey: providerEnc.secretKey,
      nowMs: NOW + 5_000,
    });
    expect(opened.kind).toBe("refused");
    if (opened.kind !== "refused") return;
    expect(opened.reason).toBe("attestation_grant_mismatch");
    expect(other.hire.keep.grant_hash).not.toBe(hire.keep.grant_hash);
  });

  it("REFUSES to open the brief with no attestation at all", async () => {
    const { hirer, provider, providerEnc, attestor, hire } = await freshHire(0x5eeded);
    const opened = await openBrief({
      wire: hire.wire,
      attestation: { schema: "voidly-session-redemption-attestation/v1" },
      attestationSignatureBase64: "",
      attestorSigningPublicKey: attestor.signingPublicKey,
      hirerSigningPublicKey: hirer.signingPublicKey,
      providerDid: provider.did,
      recipientEncSecretKey: providerEnc.secretKey,
      nowMs: NOW + 5_000,
    });
    expect(opened.kind).toBe("refused");
  });

  it("the capsule the provider reviewed hashes to the capsule the grant names", async () => {
    const { hire } = await freshHire(0x5eeded);
    expect(await envelopeHash(hire.wire.capsule)).toBe(hire.wire.grant.capsule_hash);
  });
});
