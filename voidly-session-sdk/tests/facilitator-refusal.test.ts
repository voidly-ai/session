
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  buildHire,
  payForGrant,
  preflightAdmitsPayment,
  preflightFacilitator,
  settlementNonce,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
} from "../src/index";
import type { FacilitatorPreflightResult, TransferAuthorizationTypedData } from "../src/index";
import { party, seededEntropy, verifiedProviderFor } from "./_fixtures";

const PAYER = "0x5cad296e06a976886a5d5bef831520c3d5965af0";
const PAYEE = "0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912";
const NOW_MS = 1_800_000_000_000;

const HIRE = await (async () => {
  const hirer = party(11);
  const provider = party(12);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7));
  const built = await buildHire({
    hirer: {
      did: hirer.did,
      signingPublicKeyBase64: hirer.signingPublicKeyBase64,
      sign: hirer.sign,
    },
    provider: verifiedProviderFor(provider, providerEnc, {
      chain: "eip155:8453",
      asset: x402SessionAssetCaip19("eip155:8453")!,
      payeeAccount: x402SessionAccountCaip10("eip155:8453", PAYEE)!,
      minAmount: "1000000",
      maxAmount: "1000000",
    }),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: "A brief long enough to be a brief, for a facilitator-refusal fixture." },
    price: {
      chain: "eip155:8453",
      asset: x402SessionAssetCaip19("eip155:8453")!,
      payerAccount: x402SessionAccountCaip10("eip155:8453", PAYER)!,
      payeeAccount: x402SessionAccountCaip10("eip155:8453", PAYEE)!,
      minAmount: "1000000",
      maxAmount: "1000000",
    },
    ttl: { offerMs: 60 * 60_000, grantMs: 30 * 60_000 },
    nowMs: NOW_MS,
    entropy: seededEntropy(0x515151),
  });
  if (!built.ok) throw new Error(`fixture hire failed: ${built.reason}`);
  return { grant: built.wire.grant, grantHash: built.keep.grant_hash };
})();

const GRANT_HASH = HIRE.grantHash;

function countingSigner() {
  const calls: TransferAuthorizationTypedData[] = [];
  return {
    calls,
    sign: (typedData: TransferAuthorizationTypedData) => {
      calls.push(typedData);
      return `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
    },
  };
}

function supportedDoc(extra: Record<string, unknown> | null): unknown {
  return {
    kinds: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:8453",
        ...(extra === null ? {} : { extra }),
      },
    ],
  };
}

function fetchServing(body: unknown, status = 200) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

function payOptions(
  over: Partial<Parameters<typeof payForGrant>[0]> = {},
): Parameters<typeof payForGrant>[0] {
  return {
    grant: HIRE.grant,
    grantHash: HIRE.grantHash,
    nowMs: NOW_MS,
    signer: () => `0x${"00".repeat(64)}1b`,
    ...over,
  } as Parameters<typeof payForGrant>[0];
}

describe("a permit2-settling facilitator is refused, and refused UNSIGNED", () => {
  it("payForGrant returns facilitator_permit2 without calling the signer", async () => {
    const signer = countingSigner();
    const f = fetchServing(supportedDoc({ assetTransferMethod: "permit2" }));

    const outcome = await payForGrant(
      payOptions({
        signer: signer.sign,
        facilitator: { baseUrl: "https://facilitator.example.test", fetchImpl: f.impl },
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_permit2");
    expect(signer.calls.length).toBe(0);
    expect(outcome.unsigned).toBe(true);
    expect(f.calls).toEqual(["https://facilitator.example.test/supported"]);
    expect(outcome.preflight?.verdict).toBe("unusable");
    expect(outcome.preflight?.reason).toBe("transfer_method_permit2");
  });

  it("allowUnadvertisedTransferMethod does NOT widen it", async () => {
    const signer = countingSigner();
    const f = fetchServing(supportedDoc({ assetTransferMethod: "permit2" }));

    const outcome = await payForGrant(
      payOptions({
        signer: signer.sign,
        facilitator: { baseUrl: "https://facilitator.example.test", fetchImpl: f.impl },
        allowUnadvertisedTransferMethod: true,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_permit2");
    expect(signer.calls.length).toBe(0);
  });

  it("a known-but-wrong method (erc7710) is refused the same way", async () => {
    const signer = countingSigner();
    const f = fetchServing(supportedDoc({ assetTransferMethod: "erc7710" }));

    const outcome = await payForGrant(
      payOptions({
        signer: signer.sign,
        facilitator: { baseUrl: "https://facilitator.example.test", fetchImpl: f.impl },
        allowUnadvertisedTransferMethod: true,
      }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_unusable");
    expect(signer.calls.length).toBe(0);
  });
});

describe("preflightAdmitsPayment has no branch that reaches an `unusable` verdict", () => {
  const base = {
    schema: "voidly.pay.facilitator-preflight/v1",
    detail: "",
    chain: "eip155:8453",
    frozenAsset: null,
    url: "https://x/supported",
    httpStatus: 200,
    matched: null,
    observations: [],
    undetermined: [],
  } as unknown as FacilitatorPreflightResult;

  const verdictOf = (
    verdict: string,
    reason: string,
  ): FacilitatorPreflightResult => ({ ...base, verdict, reason }) as FacilitatorPreflightResult;

  it("`usable` is admitted with the flag either way", () => {
    const r = verdictOf("usable", "eip3009_exact_advertised");
    expect(preflightAdmitsPayment(r, false)).toBe(true);
    expect(preflightAdmitsPayment(r, true)).toBe(true);
  });

  it("EVERY `unusable` reason is refused, with the flag ON", () => {
    for (const reason of [
      "transfer_method_permit2",
      "transfer_method_not_eip3009",
      "no_exact_on_chain",
      "chain_not_offered",
      "asset_not_frozen_usdc",
    ]) {
      expect(preflightAdmitsPayment(verdictOf("unusable", reason), true), reason).toBe(false);
    }
  });

  it("EVERY `unknown` reason is refused with the flag off", () => {
    for (const reason of [
      "transfer_method_not_advertised",
      "transfer_method_unrecognised",
      "unreachable",
      "http_status",
      "response_not_json",
      "response_malformed",
      "url_not_https",
    ]) {
      expect(preflightAdmitsPayment(verdictOf("unknown", reason), false), reason).toBe(false);
    }
  });

  it("the flag widens EXACTLY ONE unknown reason and no other", () => {
    expect(
      preflightAdmitsPayment(verdictOf("unknown", "transfer_method_not_advertised"), true),
    ).toBe(true);
    for (const reason of [
      "transfer_method_unrecognised",
      "unreachable",
      "http_status",
      "response_not_json",
      "response_malformed",
      "url_not_https",
      "asset_advertisement_unreadable",
      "chain_not_supported_by_rail",
    ]) {
      expect(preflightAdmitsPayment(verdictOf("unknown", reason), true), reason).toBe(false);
    }
  });
});

describe("the preflight itself reads the document rather than the URL", () => {
  it("a permit2 advertisement produces `unusable`/`transfer_method_permit2`", async () => {
    const f = fetchServing(supportedDoc({ assetTransferMethod: "permit2" }));
    const r = await preflightFacilitator({
      baseUrl: "https://facilitator.example.test",
      chain: "eip155:8453",
      fetchImpl: f.impl as never,
    });
    expect(r.verdict).toBe("unusable");
    expect(r.reason).toBe("transfer_method_permit2");
    expect(r.undetermined.length).toBeGreaterThan(0);
  });

  it("an eip3009 advertisement produces `usable`, so the refusal is not blanket", async () => {
    const f = fetchServing(supportedDoc({ assetTransferMethod: "eip3009" }));
    const r = await preflightFacilitator({
      baseUrl: "https://facilitator.example.test",
      chain: "eip155:8453",
      fetchImpl: f.impl as never,
    });
    expect(r.verdict).toBe("usable");
    expect(r.reason).toBe("eip3009_exact_advertised");
  });

  it("an unreachable facilitator is `unknown`, and payForGrant still refuses unsigned", async () => {
    const signer = countingSigner();
    const outcome = await payForGrant(
      payOptions({
        signer: signer.sign,
        facilitator: {
          baseUrl: "https://facilitator.example.test",
          fetchImpl: (async () => {
            throw new Error("connect ECONNREFUSED");
          }) as never,
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_unknown");
    expect(outcome.unsigned).toBe(true);
    expect(signer.calls.length).toBe(0);
  });
});

describe("the whole point of refusing: the nonce a permit2 settlement would never write", () => {
  it("the binding the refusal protects is a function of the grant", async () => {
    const nonce = await settlementNonce(GRANT_HASH);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await settlementNonce(GRANT_HASH)).toBe(nonce);
  });
});
