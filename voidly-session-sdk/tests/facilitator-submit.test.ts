
import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";

import {
  createFacilitatorSubmitter,
  settleUrlFor,
  settlementBindingReference,
  signTransferAuthorization,
  x402SessionEvidence,
  type SignedTransferAuthorization,
  type FacilitatorPreflightResult,
  type SubmitRefusal,
} from "../src/index";

import { canonicalEvidenceId } from "../../session-protocol/src/settlement";
import {
  CHAIN,
  facilitator,
  GRANT_HASH,
  OTHER_CHAIN,
  OTHER_TX,
  PAYEE,
  preflight,
  signedWithRealKey,
  TX,
  USDC,
  ZERO_TX,
} from "./_facilitatorFixtures";

describe("a facilitator's own refusal is believed, even when it echoes a hash", () => {
  it("`success: false` beside a transaction hash is REFUSED, not read as a payment", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 200,
      body: JSON.stringify({
        success: false,
        errorReason: "insufficient_funds",
        transaction: TX,
        network: "base",
      }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_refused");
    expect(out.detail).toContain("insufficient_funds");
    expect(out.detail).toContain("success:false");
  });

  it("a NON-2XX status beside a transaction hash is REFUSED", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 500,
      body: JSON.stringify({ transaction: TX, error: "upstream node timeout" }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_refused");
    expect(out.detail).toContain("500");
    expect(out.detail).toContain("upstream node timeout");
  });

  it("the ZERO HASH is the absence of a hash, spelled in hex", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 200,
      body: JSON.stringify({ success: true, transaction: ZERO_TX }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_response_unreadable");
  });

  it("`success: false` WITHOUT a hash is refused as a refusal, not as an unreadable body", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 200,
      body: JSON.stringify({ success: false, errorReason: "invalid_scheme" }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_refused");
    expect(out.detail).toContain("invalid_scheme");
  });

  it("POSITIVE CONTROL: a facilitator that OMITS `success` is still believed", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 200,
      body: JSON.stringify({ transaction: TX, network: "base" }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok, "omitting `success` must not be read as disclaiming").toBe(true);
    if (!out.ok) return;
    expect(out.transactionHash).toBe(TX);
  });

  it("POSITIVE CONTROL: `success: \"false\"` as a STRING is not a disclaimer", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      status: 200,
      body: JSON.stringify({ success: "false", transaction: TX }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(true);
  });
});

describe("an unfinished call and a refusal are never the same outcome", () => {
  it("an aborted /settle is `unreachable` and says the payment may have landed", async () => {
    const signed = await signedWithRealKey();
    const { submitter } = facilitator({
      throws: new DOMException("The operation was aborted.", "AbortError"),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
    expect(out.detail).toContain("THIS IS NOT A REFUSAL");
    expect(out.detail).toContain("idempotent");
    expect(out.detail).toContain("Do not re-sign a fresh authorization");
    expect(out.detail).toContain("may have arrived and settled");
  });

  it("a 402 refusal is `facilitator_refused`, and the two reasons differ", async () => {
    const signed = await signedWithRealKey();
    const refused = await facilitator({
      status: 402,
      body: JSON.stringify({ success: false, errorReason: "payment_required" }),
    }).submitter.submit(signed);
    const timedOut = await facilitator({ throws: new Error("ETIMEDOUT") }).submitter.submit(signed);
    expect(refused.ok).toBe(false);
    expect(timedOut.ok).toBe(false);
    if (refused.ok || timedOut.ok) return;
    expect(refused.reason).toBe("facilitator_refused");
    expect(timedOut.reason).toBe("unreachable");
    expect(refused.reason).not.toBe(timedOut.reason);
  });
});

describe("a /settle body this module cannot read is named as such", () => {
  it("HTML, an empty body, `null`, an array and a bare number are all unreadable", async () => {
    const signed = await signedWithRealKey();
    for (const body of ["<!doctype html><h1>502</h1>", "", "null", "[]", "7", '"0x' + "7f".repeat(32) + '"']) {
      const out = await facilitator({ status: 200, body }).submitter.submit(signed);
      expect(out.ok, `body ${JSON.stringify(body)} was accepted`).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("facilitator_response_unreadable");
    }
  });

  it("a body carrying a hash under a spelling this module does not know is unreadable", async () => {
    const signed = await signedWithRealKey();
    const out = await facilitator({
      status: 200,
      body: JSON.stringify({ success: true, settlementIdentifier: TX }),
    }).submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_response_unreadable");
  });

  it("the six known spellings ARE read, so the refusal above is not a blanket one", async () => {
    const signed = await signedWithRealKey();
    for (const key of ["transaction", "transactionHash", "transaction_hash", "txHash", "tx_hash", "hash"]) {
      const out = await facilitator({
        status: 200,
        body: JSON.stringify({ success: true, [key]: TX.toUpperCase() }),
      }).submitter.submit(signed);
      expect(out.ok, `spelling ${key} was not read`).toBe(true);
      if (!out.ok) return;
      expect(out.transactionHash).toBe(TX);
    }
  });
});

describe("a submitter that refuses does not first hand over the signed bytes", () => {
  it("a chain the preflight never saw is refused, and NOTHING is sent", async () => {
    const signed = await signedWithRealKey(CHAIN);
    const { submitter, calls } = facilitator(
      { status: 200, body: JSON.stringify({ success: true, transaction: TX }) },
      { chain: OTHER_CHAIN },
    );
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("chain_mismatch");
    expect(calls.length, "the signed authorization was sent to a facilitator that was refused").toBe(0);
  });

  it("a preflight that matched no kind is refused, and NOTHING is sent", async () => {
    const signed = await signedWithRealKey();
    const { submitter, calls } = facilitator(
      { status: 200, body: JSON.stringify({ success: true, transaction: TX }) },
      { matched: null },
    );
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_not_usable");
    expect(out.detail).toContain("no advertised network spelling");
    expect(calls.length).toBe(0);
  });

  it("a CLEARTEXT facilitator is refused, and NOTHING is sent", async () => {
    const signed = await signedWithRealKey();
    const { submitter, calls } = facilitator(
      { status: 200, body: JSON.stringify({ success: true, transaction: TX }) },
      { url: "http://facilitator.example.test/supported" },
    );
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_not_usable");
    expect(out.detail).toContain("could not derive a /settle URL");
    expect(calls.length).toBe(0);
  });

  it("an `unusable` preflight is refused, and NOTHING is sent", async () => {
    const signed = await signedWithRealKey();
    const { submitter, calls } = facilitator(
      { status: 200, body: JSON.stringify({ success: true, transaction: TX }) },
      { verdict: "unusable", reason: "transfer_method_permit2", matched: null },
    );
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_not_usable");
    expect(out.detail).toContain("permit2");
    expect(calls.length).toBe(0);
  });

  it("the dead refusal name `chain_has_no_x402_network_name` is GONE, not merely unused", async () => {
    // @ts-expect-error — the member is not in the union.
    const readded: SubmitRefusal = "chain_has_no_x402_network_name";
    expect(readded).toBe("chain_has_no_x402_network_name");

    const signed = await signedWithRealKey();
    const reply = { status: 200, body: JSON.stringify({ success: true, transaction: TX }) };
    for (const [over, needle] of [
      [{ matched: null }, "no advertised network spelling"],
      [{ url: "http://facilitator.example.test/supported" }, "could not derive a /settle URL"],
    ] as Array<[Record<string, unknown>, string]>) {
      const { submitter, calls } = facilitator(reply, over);
      const out = await submitter.submit(signed);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("facilitator_not_usable");
      expect(out.reason as string).not.toBe("chain_has_no_x402_network_name");
      expect(out.detail).toContain(needle);
      expect(calls.length).toBe(0);
    }
  });

  it("POSITIVE CONTROL: an admitted preflight DOES send, to the derived /settle URL", async () => {
    const signed = await signedWithRealKey();
    const { submitter, calls } = facilitator({
      status: 200,
      body: JSON.stringify({ success: true, transaction: TX }),
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://facilitator.example.test/settle");
    const sent = JSON.parse(calls[0].body);
    expect(sent.paymentPayload.payload.signature).toBe(signed.signature);
    expect(sent.paymentPayload.payload.authorization.nonce).toBe(
      `0x${await settlementBindingReference(GRANT_HASH)}`,
    );
  });
});

describe("settleUrlFor refuses everything it cannot address", () => {
  it("a query string and a fragment are stripped rather than carried into /settle", () => {
    expect(settleUrlFor("https://f.example.test/base?key=secret#frag")).toBe(
      "https://f.example.test/base/settle",
    );
    expect(settleUrlFor("https://f.example.test/base?key=secret")).not.toContain("secret");
  });

  it("trailing slashes and a `/supported` suffix both fold to the same door", () => {
    for (const base of [
      "https://f.example.test/v2/supported",
      "https://f.example.test/v2/",
      "https://f.example.test/v2///",
    ]) {
      expect(settleUrlFor(base)).toBe("https://f.example.test/v2/settle");
    }
  });

  it("cleartext, a non-URL, an empty string and an absurd length are all null", () => {
    expect(settleUrlFor("http://f.example.test")).toBe(null);
    expect(settleUrlFor("ws://f.example.test")).toBe(null);
    expect(settleUrlFor("not a url")).toBe(null);
    expect(settleUrlFor("")).toBe(null);
    expect(settleUrlFor(`https://f.example.test/${"a".repeat(2100)}`)).toBe(null);
    expect(settleUrlFor(undefined as unknown as string)).toBe(null);
  });
});
