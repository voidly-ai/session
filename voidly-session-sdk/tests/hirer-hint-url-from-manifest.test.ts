
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { submitSettlementHint, x402SessionEvidence } from "../src/index";
import { providerHintUrl } from "../src/hirer";
import type { VerifiedProvider } from "../src/index";
import * as SDK from "../src/index";
import { CHAIN, freshHire, NOW, PAYEE_ADDR, PAYER_ADDR, PRICE, party, verifiedProviderFor } from "./_fixtures";
import { x402SessionAccountCaip10, x402SessionAssetCaip19 } from "../src/index";

const TX = `0x${"5c".repeat(32)}`;
const SIGNED_DOOR = "https://provider.example.test/session/deliver-hint";
const PASTED_DOOR = "https://operator-told-me.example/session/deliver-hint";

const PRICE_SPEC = {
  chain: CHAIN,
  asset: x402SessionAssetCaip19(CHAIN)!,
  payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
  minAmount: PRICE,
  maxAmount: PRICE,
};

function providerPublishing(doors: {
  hintUrl?: string;
  relays?: VerifiedProvider["manifest"]["relays"];
}): VerifiedProvider {
  return verifiedProviderFor(
    party(2),
    nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)),
    PRICE_SPEC,
    "voidly.research.censorship-summary",
    doors,
  );
}

interface Capture {
  calls: number;
  url: string | null;
}

function recorder(): { fetchImpl: SDK.FetchLike; seen: Capture } {
  const seen: Capture = { calls: 0, url: null };
  const fetchImpl: SDK.FetchLike = async (url) => {
    seen.calls += 1;
    seen.url = url;
    return new Response(JSON.stringify({ status: "accepted" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, seen };
}

const HIRER = party(1);

async function realGrant() {
  const { hire } = await freshHire();
  if (!hire.ok) throw new Error("fixture hire failed");
  return { grant: hire.wire.grant, grantHash: hire.keep.grant_hash };
}

describe("§1 the pointer goes to the door the PROVIDER SIGNED", () => {

  it("§1.1 the URL reaching fetchImpl is byte-identical to the manifest's hint_url", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const { fetchImpl, seen } = recorder();

    const out = await submitSettlementHint({
      provider,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });

    console.log("[OBSERVED] §1.1 manifest hint_url :", provider.manifest.hint_url);
    console.log("[OBSERVED] §1.1 url reaching fetch:", seen.url);
    expect(out.kind, JSON.stringify(out)).toBe("acknowledged");
    expect(seen.calls).toBe(1);
    expect(seen.url).toBe(provider.manifest.hint_url);
    expect(seen.url).toBe(SIGNED_DOOR);
  });

  it("§1.2 the signed door WINS over a matching pasted one, and reports its source", () => {
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const verdict = providerHintUrl(provider);
    console.log("[OBSERVED] §1.2 providerHintUrl ->", JSON.stringify(verdict));
    expect(verdict).toEqual({ ok: true, url: SIGNED_DOOR, source: "manifest" });
  });

  it("§1.3 `relays` travels with it — who submits, and which typehash", () => {
    const provider = providerPublishing({
      hintUrl: SIGNED_DOOR,
      relays: { provider_submits: false, accepted_entry_points: ["transfer_with_authorization"] },
    });
    console.log("[OBSERVED] §1.3 relays:", JSON.stringify(provider.manifest.relays));
    expect(provider.manifest.relays).toEqual({
      provider_submits: false,
      accepted_entry_points: ["transfer_with_authorization"],
    });
  });
});

describe("§2 a manifest that publishes no door still works — every one in the wild", () => {

  it("§2.1 provider + pasted url falls back to the pasted one, and says so", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({});
    const { fetchImpl, seen } = recorder();

    console.log("[OBSERVED] §2.1 manifest keys:", Object.keys(provider.manifest).length);
    console.log("[OBSERVED] §2.1 providerHintUrl ->", JSON.stringify(providerHintUrl(provider)));
    expect(provider.manifest.hint_url).toBeUndefined();

    const out = await submitSettlementHint({
      provider,
      url: PASTED_DOOR,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §2.1 url reaching fetch:", seen.url);
    expect(out.kind, JSON.stringify(out)).toBe("acknowledged");
    expect(seen.url).toBe(PASTED_DOOR);
  });

  it("§2.2 the url-only call is unchanged — today's every caller, including the pay button", async () => {
    const { grant, grantHash } = await realGrant();
    const { fetchImpl, seen } = recorder();
    const out = await submitSettlementHint({
      url: PASTED_DOOR,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §2.2 url-only ->", out.kind, seen.url);
    expect(out.kind).toBe("acknowledged");
    expect(seen.url).toBe(PASTED_DOOR);
  });

  it("§2.3 provider with no door AND no pasted url is refused, and NOTHING IS SENT", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({});
    const { fetchImpl, seen } = recorder();

    const out = await submitSettlementHint({
      provider,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §2.3 ->", JSON.stringify(out), "calls:", seen.calls);
    expect(out).toEqual({ kind: "unbuildable", reason: "hint_url_unpublished" });
    expect(seen.calls).toBe(0);
  });

  it("§2.4 providerHintUrl names the PROVIDER's remedy, not the hirer's", () => {
    const verdict = providerHintUrl(providerPublishing({}));
    console.log("[OBSERVED] §2.4 ->", JSON.stringify(verdict));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("hint_url_unpublished");
    expect(verdict.detail).toContain("names no hint door");
  });
});

describe("§3 a disagreement is REFUSED, never resolved", () => {

  it("§3.1 signed door + different pasted door: nothing is sent", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const { fetchImpl, seen } = recorder();

    const out = await submitSettlementHint({
      provider,
      url: PASTED_DOOR,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §3.1 ->", JSON.stringify(out), "calls:", seen.calls);
    expect(out).toEqual({ kind: "unbuildable", reason: "hint_url_conflict" });
    expect(seen.calls).toBe(0);
  });

  it("§3.2 byte equality, not origin equality — a trailing slash is a different door", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const { fetchImpl, seen } = recorder();
    const out = await submitSettlementHint({
      provider,
      url: `${SIGNED_DOOR}/`,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §3.2 trailing slash ->", JSON.stringify(out));
    expect(out).toEqual({ kind: "unbuildable", reason: "hint_url_conflict" });
    expect(seen.calls).toBe(0);
  });

  it("§3.3 an IDENTICAL pasted door is not a conflict", async () => {
    const { grant, grantHash } = await realGrant();
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const { fetchImpl, seen } = recorder();
    const out = await submitSettlementHint({
      provider,
      url: SIGNED_DOOR,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §3.3 ->", out.kind, seen.url);
    expect(out.kind).toBe("acknowledged");
    expect(seen.url).toBe(SIGNED_DOOR);
  });

  it("§3.4 the door is decided BEFORE the grant is hashed — cheapest break first", async () => {
    const { grant } = await realGrant();
    const provider = providerPublishing({ hintUrl: SIGNED_DOOR });
    const { fetchImpl, seen } = recorder();
    const out = await submitSettlementHint({
      provider,
      url: PASTED_DOOR,
      grant,
      grantHash: `0x${"00".repeat(32)}`,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      nowMs: NOW,
      fetchImpl,
    });
    console.log("[OBSERVED] §3.4 both broken ->", JSON.stringify(out));
    expect(out).toEqual({ kind: "unbuildable", reason: "hint_url_conflict" });
    expect(seen.calls).toBe(0);
  });
});

describe("§4 the brand is what makes `hint_url` mean anything", () => {

  it("§4.1 a hand-built object cannot be passed as a provider — it is not a VerifiedProvider", () => {
    const real = providerPublishing({ hintUrl: SIGNED_DOOR });
    const cloned = JSON.parse(JSON.stringify(real)) as unknown;
    console.log("[OBSERVED] §4.1 isVerifiedProvider(real) :", SDK.isVerifiedProvider(real));
    console.log("[OBSERVED] §4.1 isVerifiedProvider(clone):", SDK.isVerifiedProvider(cloned));
    expect(SDK.isVerifiedProvider(real)).toBe(true);
    expect(SDK.isVerifiedProvider(cloned)).toBe(false);
    expect(SDK.isVerifiedProvider({ manifest: { hint_url: PASTED_DOOR } })).toBe(false);
  });

  it("§4.2 a tampered hint_url never becomes a VerifiedProvider at all", () => {
    expect(() =>
      verifiedProviderFor(
        party(2),
        nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)),
        PRICE_SPEC,
        "voidly.research.censorship-summary",
        { hintUrl: SIGNED_DOOR },
      ),
    ).not.toThrow();

    const honest = providerPublishing({ hintUrl: SIGNED_DOOR });
    const wire = JSON.parse(JSON.stringify(honest.manifest)) as Record<string, unknown>;
    wire.hint_url = PASTED_DOOR;
    const verdict = SDK.verifyProvider(wire, honest.manifest.provider_did);
    console.log("[OBSERVED] §4.2 substituted door ->", verdict.ok ? "ok" : verdict.reason);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("manifest_signature_invalid");
  });
});
