
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  buildHire,
  exportSessionKeyBytes,
  MAX_CLOCK_SKEW_MS,
  MAX_GRANT_TTL_MS,
  MIN_GRANT_TTL_MS,
  SESSION_RAIL_BLOCK_TIME_MS,
  SESSION_RAIL_MIN_CONFIRMATIONS,
  signDelivery,
  verifyDeliveryReceipt,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
  type TaskGrantEnvelope,
} from "../src/index";
import {
  CHAIN,
  GRANT_TTL_MS,
  NOW,
  OFFER_TTL_MS,
  PAYEE_ADDR,
  PAYER_ADDR,
  PRICE,
  BRIEF,
  freshHire,
  party,
  verifiedProviderFor,
} from "./_fixtures";

const RECOVERABLE_UNTIL = NOW + 90 * 60_000;

async function providerSigned(
  provider: ReturnType<typeof party>,
  facts: { grantHash: string; offerHash: string; providerDid: string },
) {
  const signed = await signDelivery({
    grantHash: facts.grantHash,
    offerHash: facts.offerHash,
    providerDid: facts.providerDid,
    resultCapsuleHash: "d".repeat(64),
    resultCommitment: "e".repeat(64),
    recoverableUntilMs: RECOVERABLE_UNTIL,
    nowMs: NOW + 6_000,
    sign: provider.sign,
  });
  if (!signed.ok) throw new Error(`fixture receipt failed: ${signed.reason}`);
  return signed;
}

describe("verifyDeliveryReceipt: the receipt must be about THIS hire", () => {
  it("BASELINE: an honest receipt verifies", async () => {
    const { hire, provider } = await freshHire();
    const signed = await providerSigned(provider, {
      grantHash: hire.keep.grant_hash,
      offerHash: hire.keep.offer_hash,
      providerDid: provider.did,
    });
    const verified = verifyDeliveryReceipt({
      receipt: signed.receipt,
      signatureBase64: signed.signature_base64,
      grant: hire.wire.grant,
      grantHash: hire.keep.grant_hash,
      nowMs: NOW + 7_000,
    });
    expect(verified.ok).toBe(true);
  });

  it("refuses a receipt whose grant_hash is ANOTHER hire's", async () => {
    const { hire, provider } = await freshHire();
    const other = await freshHire(0x123456);
    expect(other.hire.keep.grant_hash).not.toBe(hire.keep.grant_hash);

    const signed = await providerSigned(provider, {
      grantHash: other.hire.keep.grant_hash,
      offerHash: hire.keep.offer_hash,
      providerDid: provider.did,
    });
    const verified = verifyDeliveryReceipt({
      receipt: signed.receipt,
      signatureBase64: signed.signature_base64,
      grant: hire.wire.grant,
      grantHash: hire.keep.grant_hash,
      nowMs: NOW + 7_000,
    });
    expect(verified).toEqual({ ok: false, reason: "delivery_grant_mismatch" });
  });

  it("refuses a receipt whose offer_hash is ANOTHER hire's", async () => {
    const { hire, provider } = await freshHire();
    const other = await freshHire(0x123456);
    expect(other.hire.keep.offer_hash).not.toBe(hire.keep.offer_hash);

    const signed = await providerSigned(provider, {
      grantHash: hire.keep.grant_hash,
      offerHash: other.hire.keep.offer_hash,
      providerDid: provider.did,
    });
    const verified = verifyDeliveryReceipt({
      receipt: signed.receipt,
      signatureBase64: signed.signature_base64,
      grant: hire.wire.grant,
      grantHash: hire.keep.grant_hash,
      nowMs: NOW + 7_000,
    });
    expect(verified).toEqual({ ok: false, reason: "delivery_grant_mismatch" });
  });

  it("refuses a receipt naming a provider the grant did not hire", async () => {
    const { hire, provider } = await freshHire();
    const somebodyElse = party(21);
    expect(somebodyElse.did).not.toBe(provider.did);

    const signed = await providerSigned(provider, {
      grantHash: hire.keep.grant_hash,
      offerHash: hire.keep.offer_hash,
      providerDid: somebodyElse.did,
    });
    const verified = verifyDeliveryReceipt({
      receipt: signed.receipt,
      signatureBase64: signed.signature_base64,
      grant: hire.wire.grant,
      grantHash: hire.keep.grant_hash,
      nowMs: NOW + 7_000,
    });
    expect(verified).toEqual({ ok: false, reason: "delivery_grant_mismatch" });
  });

  it("REVALIDATES the grant rather than trusting it as typed", async () => {
    const { hire, provider } = await freshHire();
    const notReallyAGrant = {
      ...hire.wire.grant,
      settled_amount: "999999999",
    } as unknown as TaskGrantEnvelope;

    const signed = await providerSigned(provider, {
      grantHash: hire.keep.grant_hash,
      offerHash: hire.keep.offer_hash,
      providerDid: provider.did,
    });
    const verified = verifyDeliveryReceipt({
      receipt: signed.receipt,
      signatureBase64: signed.signature_base64,
      grant: notReallyAGrant,
      grantHash: hire.keep.grant_hash,
      nowMs: NOW + 7_000,
    });
    expect(verified).toEqual({ ok: false, reason: "delivery_grant_mismatch" });
  });
});

describe("buildHire mints FRESH entropy for every hire", () => {
  it("two hires with identical inputs and the DEFAULT generator share nothing", async () => {
    const hirer = party(1);
    const provider = party(2);
    const args = {
      hirer: {
        did: hirer.did,
        signingPublicKeyBase64: hirer.signingPublicKeyBase64,
        sign: hirer.sign,
      },
      provider: verifiedProviderFor(
        provider,
        nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)),
        {
          chain: CHAIN,
          asset: x402SessionAssetCaip19(CHAIN)!,
          payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
          minAmount: PRICE,
          maxAmount: PRICE,
        },
      ),
      service: { ref: "voidly.research.censorship-summary" },
      task: { brief: BRIEF },
      price: {
        chain: CHAIN,
        asset: x402SessionAssetCaip19(CHAIN)!,
        payerAccount: x402SessionAccountCaip10(CHAIN, PAYER_ADDR)!,
        payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
        minAmount: PRICE,
        maxAmount: PRICE,
      },
      ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS },
      nowMs: NOW,
    };

    const a = await buildHire(args);
    const b = await buildHire(args);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.keep.grant_hash, "two hires are the same hire").not.toBe(b.keep.grant_hash);
    expect(a.wire.offer.nonce).not.toBe(b.wire.offer.nonce);
    expect(a.wire.grant.nonce).not.toBe(b.wire.grant.nonce);
    expect(a.wire.capsule.body_nonce_base64).not.toBe(b.wire.capsule.body_nonce_base64);
    expect(a.wire.grant.brief_commitment, "the brief salt was reused").not.toBe(
      b.wire.grant.brief_commitment,
    );

    const ka = exportSessionKeyBytes(a.keep.sessionKey);
    const kb = exportSessionKeyBytes(b.keep.sessionKey);
    expect(ka).not.toBeNull();
    expect(kb).not.toBeNull();
    expect(Array.from(ka!), "two hires share a session key").not.toEqual(Array.from(kb!));
  });
});

describe("buildHire: a grant that cannot outlast the settlement depth is refused", () => {
  async function hireWithGrantTtl(grantMs: number) {
    const hirer = party(1);
    const provider = party(2);
    return buildHire({
      hirer: {
        did: hirer.did,
        signingPublicKeyBase64: hirer.signingPublicKeyBase64,
        sign: hirer.sign,
      },
      provider: verifiedProviderFor(
        provider,
        nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)),
        {
          chain: CHAIN,
          asset: x402SessionAssetCaip19(CHAIN)!,
          payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
          minAmount: PRICE,
          maxAmount: PRICE,
        },
      ),
      service: { ref: "voidly.research.censorship-summary" },
      task: { brief: BRIEF },
      price: {
        chain: CHAIN,
        asset: x402SessionAssetCaip19(CHAIN)!,
        payerAccount: x402SessionAccountCaip10(CHAIN, PAYER_ADDR)!,
        payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
        minAmount: PRICE,
        maxAmount: PRICE,
      },
      ttl: { offerMs: MAX_GRANT_TTL_MS, grantMs },
      nowMs: NOW,
    });
  }

  it("the floor is DERIVED, not typed: depth x block time + the clock-skew margin", () => {
    expect(MIN_GRANT_TTL_MS).toBe(
      SESSION_RAIL_MIN_CONFIRMATIONS * SESSION_RAIL_BLOCK_TIME_MS + MAX_CLOCK_SKEW_MS,
    );
    expect(SESSION_RAIL_MIN_CONFIRMATIONS).toBe(12);
    expect(MIN_GRANT_TTL_MS).toBeLessThan(MAX_GRANT_TTL_MS);
  });

  it("a one-millisecond grant is refused by name", async () => {
    const built = await hireWithGrantTtl(1);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("grant_ttl_below_settlement_depth");
  });

  it("the ten-second grant that settled into a dead session is refused too", async () => {
    const built = await hireWithGrantTtl(10_000);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("grant_ttl_below_settlement_depth");
  });

  it("THE BOUNDARY IS EXACT, and the floor itself is buildable", async () => {
    const below = await hireWithGrantTtl(MIN_GRANT_TTL_MS - 1);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.reason).toBe("grant_ttl_below_settlement_depth");

    const at = await hireWithGrantTtl(MIN_GRANT_TTL_MS);
    expect(at.ok, JSON.stringify(at)).toBe(true);
    if (!at.ok) return;
    expect(Date.parse(at.wire.grant.expires_at) - Date.parse(at.wire.grant.issued_at)).toBe(
      MIN_GRANT_TTL_MS,
    );
  });

  it("BACK-COMPAT: the shortest grant this builder produces is untouched", async () => {
    const built = await hireWithGrantTtl(2 * 60_000);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    const ordinary = await hireWithGrantTtl(GRANT_TTL_MS);
    expect(ordinary.ok).toBe(true);
  });

  it("`invalid_ttl` still owns the not-a-window cases, and stays distinguishable", async () => {
    for (const bad of [0, -1, MAX_GRANT_TTL_MS + 1]) {
      const built = await hireWithGrantTtl(bad);
      expect(built.ok, `grantMs=${bad}`).toBe(false);
      if (built.ok) continue;
      expect(built.reason, `grantMs=${bad}`).toBe("invalid_ttl");
    }
  });
});
