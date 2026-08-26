
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Interface, TypedDataEncoder, Wallet, verifyTypedData } from "ethers";

import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";

import {
  buildHire,
  buildTransferAuthorizationTypedData,
  buildTransferWithAuthorizationCalldata,
  buildX402PaymentPayload,
  buildX402PaymentRequirements,
  createFacilitatorSubmitter,
  createSelfSubmitter,
  EVM_USDC_EIP712_DOMAINS,
  payForGrant,
  settlementNonce,
  SETTLEMENT_BINDING_DOMAIN,
  settlementBindingReference,
  settleUrlFor,
  signTransferAuthorization,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  X402_SESSION_USDC_BY_CHAIN,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
  x402SessionEvidence,
} from "../src/index";
import type {
  FacilitatorPreflightResult,
  SignedTransferAuthorization,
  TransferAuthorizationTypedData,
} from "../src/index";

import { canonicalEvidenceId } from "../../session-protocol/src/settlement";
import { party, seededEntropy, verifiedProviderFor } from "./_fixtures";
import {
  baseInput,
  CHAIN,
  GRANT_HASH,
  NOW_MS,
  NOW_S,
  PAYEE,
  PAYER,
  signedWithRealKey,
  TX_HASH,
  USDC,
} from "./_transferAuthFixtures";

const ON_CHAIN_DOMAIN_SEPARATOR =
  "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";

function countingSigner(reply?: (t: TransferAuthorizationTypedData) => string) {
  const calls: TransferAuthorizationTypedData[] = [];
  return {
    calls,
    sign: (typedData: TransferAuthorizationTypedData) => {
      calls.push(typedData);
      return reply ? reply(typedData) : `0x${"11".repeat(32)}${"22".repeat(32)}1b`;
    },
  };
}

describe("the EIP-3009 nonce IS the settlement binding, on three independent paths", () => {
  it("equals settlementBindingReference for a known grant, with `0x` in front", async () => {
    const fromCore = await settlementBindingReference(GRANT_HASH);
    expect(await settlementNonce(GRANT_HASH)).toBe(`0x${fromCore}`);
  });

  it("equals SHA-256 of the domain tag and the grant hash, recomputed by hand", () => {
    const byHand = createHash("sha256")
      .update(`${SETTLEMENT_BINDING_DOMAIN}${GRANT_HASH}`, "utf8")
      .digest("hex");
    return expect(settlementNonce(GRANT_HASH)).resolves.toBe(`0x${byHand}`);
  });

  it("survives into the SIGNED payload, not just the built one", async () => {
    const { signed } = await signedWithRealKey();
    expect(signed.typedData.message.nonce).toBe(await settlementNonce(GRANT_HASH));
    expect(signed.grantHash).toBe(GRANT_HASH);
  });

  it("folds to exactly what redeem.ts compares against", async () => {
    const { signed } = await signedWithRealKey();
    expect(canonicalEvidenceId(signed.typedData.message.nonce)).toBe(
      await settlementBindingReference(GRANT_HASH),
    );
  });

  it("a random nonce — what the stock x402 client mints — does NOT fold to it", async () => {
    const random = `0x${createHash("sha256").update("not-the-grant").digest("hex")}`;
    expect(canonicalEvidenceId(random)).not.toBe(await settlementBindingReference(GRANT_HASH));
  });
});

describe("the domain the payer signs is the deployment's own", () => {
  it("ethers reconstructs the separator Base reports, from the four pinned fields", async () => {
    const { signed } = await signedWithRealKey();
    const d = signed.typedData.domain;
    expect(d).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: USDC,
    });
    expect(TypedDataEncoder.hashDomain(d)).toBe(ON_CHAIN_DOMAIN_SEPARATOR);
  });

  it("the recovered signer of a real signature is the payer named in the message", async () => {
    const { signed, wallet } = await signedWithRealKey();
    const recovered = verifyTypedData(
      signed.typedData.domain,
      { TransferWithAuthorization: [...signed.typedData.types.TransferWithAuthorization] },
      signed.typedData.message,
      signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(signed.typedData.message.from);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("a chain with no frozen USDC deployment is refused before signing", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ chain: "eip155:1" }),
      signer.sign,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("unsupported_chain");
    expect(signer.calls.length).toBe(0);
  });

  it("a Base Sepolia payload carries Sepolia's DIFFERENT token name, not mainnet's", async () => {
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:84532",
      from: PAYER,
      to: PAYEE,
      value: "1",
      validAfter: 0,
      validBefore: NOW_S + 60,
      grantHash: GRANT_HASH,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.typedData.domain.name).toBe("USDC");
    expect(built.typedData.domain.chainId).toBe(84532);
    expect(TypedDataEncoder.hashDomain(built.typedData.domain)).toBe(
      "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
    );
    expect(TypedDataEncoder.hashDomain(built.typedData.domain)).not.toBe(
      ON_CHAIN_DOMAIN_SEPARATOR,
    );
  });

  it("the calldata's `to` is the frozen token and cannot be steered by the caller", () => {
    const forged = {
      typedData: {
        domain: { name: "x", version: "2", chainId: 1, verifyingContract: USDC },
        types: { EIP712Domain: [], TransferWithAuthorization: [] },
        primaryType: "TransferWithAuthorization",
        message: {
          from: PAYER,
          to: PAYEE,
          value: "1",
          validAfter: "0",
          validBefore: "99999999",
          nonce: `0x${"aa".repeat(32)}`,
        },
      },
      signature: `0x${"11".repeat(65)}`,
      v: 27,
      r: `0x${"11".repeat(32)}`,
      s: `0x${"22".repeat(32)}`,
      chain: "eip155:1",
      grantHash: GRANT_HASH,
    } as unknown as SignedTransferAuthorization;
    const built = buildTransferWithAuthorizationCalldata(forged);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("unsupported_chain");
  });

  it("the two token tables agree on the contract the payload names", async () => {
    const { signed } = await signedWithRealKey();
    expect(X402_SESSION_USDC_BY_CHAIN.get(CHAIN)).toBe(USDC);
    expect(EVM_USDC_EIP712_DOMAINS.get(CHAIN)?.verifyingContract).toBe(USDC);
    expect(signed.typedData.domain.verifyingContract).toBe(USDC);
  });
});

describe("an authorization outside its validity window is refused UNSIGNED", () => {
  it("an expired validBefore never reaches the signer", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ validBefore: NOW_S - 1 }),
      signer.sign,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("authorization_expired");
    expect(signer.calls.length).toBe(0);
    expect(outcome.detail).toContain("authorization is expired");
  });

  it("validBefore EQUAL to now is refused — EIP-3009 wants strictly greater", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ validBefore: NOW_S }),
      signer.sign,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("authorization_expired");
    expect(signer.calls.length).toBe(0);
  });

  it("one second later is accepted — the boundary is exactly where it is claimed", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ validBefore: NOW_S + 1 }),
      signer.sign,
    );
    expect(outcome.ok).toBe(true);
    expect(signer.calls.length).toBe(1);
  });

  it("the clock is FLOORED, not rounded — half a second past is still this second", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ nowMs: NOW_MS + 500, validBefore: NOW_S + 1 }),
      signer.sign,
    );
    expect(outcome.ok).toBe(true);
    expect(signer.calls.length).toBe(1);
  });

  it("a future-dated validAfter is refused unsigned", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ validAfter: NOW_S + 60, validBefore: NOW_S + 120 }),
      signer.sign,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("authorization_not_yet_valid");
    expect(signer.calls.length).toBe(0);
  });

  it("milliseconds in a seconds field are refused by their own name", async () => {
    const signer = countingSigner();
    const outcome = await signTransferAuthorization(
      baseInput({ validBefore: NOW_MS }),
      signer.sign,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("validity_looks_like_milliseconds");
    expect(signer.calls.length).toBe(0);
  });

  it("a signer that throws becomes `signer_threw`, never an exception", async () => {
    const outcome = await signTransferAuthorization(baseInput(), () => {
      throw new Error("user dismissed the wallet popup");
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("signer_threw");
    expect(outcome.detail).toContain("user dismissed");
  });

  it("a 0/1 recovery id is refused and NOT silently normalised", async () => {
    const outcome = await signTransferAuthorization(
      baseInput(),
      () => `0x${"11".repeat(32)}${"22".repeat(32)}00`,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("signature_recovery_id_invalid");
  });

  it("a signature that is not 65 bytes is refused", async () => {
    const outcome = await signTransferAuthorization(baseInput(), () => `0x${"11".repeat(32)}`);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("signature_not_65_bytes");
  });
});

const IFACE = new Interface([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
]);

describe("the encoded call decodes back to exactly what was signed", () => {
  it("nine arguments, argument by argument, under ethers' ABI coder", async () => {
    const { signed } = await signedWithRealKey();
    const built = buildTransferWithAuthorizationCalldata(signed);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.request.to).toBe(USDC);
    expect(built.request.value).toBe("0x0");
    expect(built.request.chainId).toBe(8453);
    expect(built.request.data.length).toBe(2 + 8 + 9 * 64);

    const decoded = IFACE.decodeFunctionData("transferWithAuthorization", built.request.data);
    const m = signed.typedData.message;
    expect(decoded[0].toLowerCase()).toBe(m.from);
    expect(decoded[1].toLowerCase()).toBe(m.to);
    expect(decoded[2].toString()).toBe(m.value);
    expect(decoded[3].toString()).toBe(m.validAfter);
    expect(decoded[4].toString()).toBe(m.validBefore);
    expect(decoded[5]).toBe(m.nonce);
    expect(Number(decoded[6])).toBe(signed.v);
    expect(decoded[7]).toBe(signed.r);
    expect(decoded[8]).toBe(signed.s);
  });

  it("ethers agrees with the pinned selector, and it is the v/r/s overload", () => {
    expect(IFACE.getFunction("transferWithAuthorization")!.selector).toBe(
      TRANSFER_WITH_AUTHORIZATION_SELECTOR,
    );
    const bytesOverload = new Interface([
      "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
    ]);
    expect(bytesOverload.getFunction("transferWithAuthorization")!.selector).not.toBe(
      TRANSFER_WITH_AUTHORIZATION_SELECTOR,
    );
  });

  it("a malformed r/s is refused rather than encoded", async () => {
    const { signed } = await signedWithRealKey();
    const broken = { ...signed, r: "0xdead" } as SignedTransferAuthorization;
    const built = buildTransferWithAuthorizationCalldata(broken);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("malformed_signature");
  });

  it("an amount above uint256 is refused rather than truncated", async () => {
    const { signed } = await signedWithRealKey();
    const huge = {
      ...signed,
      typedData: {
        ...signed.typedData,
        message: { ...signed.typedData.message, value: "9".repeat(78) },
      },
    } as SignedTransferAuthorization;
    const built = buildTransferWithAuthorizationCalldata(huge);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe("malformed_authorization");

    const atMax = {
      ...signed,
      typedData: {
        ...signed.typedData,
        message: {
          ...signed.typedData.message,
          value: ((BigInt(1) << BigInt(256)) - BigInt(1)).toString(),
        },
      },
    } as SignedTransferAuthorization;
    expect(buildTransferWithAuthorizationCalldata(atMax).ok).toBe(true);
  });
});

async function hireFor(payerAddress: string, seed = 0x717171) {
  const hirer = party(21);
  const provider = party(22);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(5));
  const built = await buildHire({
    hirer: {
      did: hirer.did,
      signingPublicKeyBase64: hirer.signingPublicKeyBase64,
      sign: hirer.sign,
    },
    provider: verifiedProviderFor(provider, providerEnc, {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE)!,
      minAmount: "1000000",
      maxAmount: "1000000",
    }),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: "A brief long enough to be a brief, for the payForGrant fixtures." },
    price: {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payerAccount: x402SessionAccountCaip10(CHAIN, payerAddress)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE)!,
      minAmount: "1000000",
      maxAmount: "1000000",
    },
    ttl: { offerMs: 60 * 60_000, grantMs: 30 * 60_000 },
    nowMs: NOW_MS,
    entropy: seededEntropy(seed),
  });
  if (!built.ok) throw new Error(`fixture hire failed: ${built.reason}`);
  return { grant: built.wire.grant, grantHash: built.keep.grant_hash };
}

describe("payForGrant takes exactly one submitter, and the self path signs then broadcasts", () => {
  it("neither facilitator nor broadcast is refused unsigned", async () => {
    const signer = countingSigner();
    const hire = await hireFor(PAYER);
    const outcome = await payForGrant({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW_MS,
      signer: signer.sign,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_unusable");
    expect(outcome.unsigned).toBe(true);
    expect(signer.calls.length).toBe(0);
  });

  it("BOTH is refused too — supplying both hides which one moved the money", async () => {
    const signer = countingSigner();
    const hire = await hireFor(PAYER);
    const outcome = await payForGrant({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW_MS,
      signer: signer.sign,
      facilitator: { baseUrl: "https://f.example.test", fetchImpl: (async () => new Response("{}")) as never },
      broadcast: () => `0x${"ab".repeat(32)}`,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("facilitator_unusable");
    expect(signer.calls.length).toBe(0);
  });

  it("the self path hands the broadcaster the calldata it built, and returns its hash", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const seen: Array<{ to: string; data: string; chainId: number }> = [];
    const outcome = await payForGrant({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW_MS,
      signer: (t) =>
        wallet.signTypedData(
          t.domain,
          { TransferWithAuthorization: [...t.types.TransferWithAuthorization] },
          t.message,
        ),
      broadcast: (req) => {
        seen.push({ to: req.to, data: req.data, chainId: req.chainId });
        return TX_HASH;
      },
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.transactionHash).toBe(TX_HASH);
    expect(seen.length).toBe(1);
    expect(seen[0].to).toBe(USDC);
    expect(seen[0].chainId).toBe(8453);
    const decoded = IFACE.decodeFunctionData("transferWithAuthorization", seen[0].data);
    expect(decoded[5]).toBe(await settlementNonce(hire.grantHash));
    expect(outcome.preflight).toBe(null);
  });

  it("EVERY money-steering field comes off the grant, and the stamp is explicit", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x818181);
    const outcome = await payForGrant({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW_MS,
      signer: (t) =>
        wallet.signTypedData(
          t.domain,
          { TransferWithAuthorization: [...t.types.TransferWithAuthorization] },
          t.message,
        ),
      broadcast: () => TX_HASH,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    const a = outcome.authorization;
    expect(a.entry_point).toBe("transfer_with_authorization");
    expect(a.chain).toBe(hire.grant.price_chain);
    expect(a.asset).toBe(hire.grant.price_asset);
    expect(a.from).toBe(hire.grant.price_payer_account);
    expect(a.to).toBe(hire.grant.price_payee_account);
    expect(a.value).toBe(hire.grant.price_min_amount);
    expect(a.valid_after).toBe("0");
    expect(a.nonce).toBe(await settlementBindingReference(hire.grantHash));
  });

  it("a grant that is not the grant the hash names is refused BEFORE the signer", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x919191);
    const signer = countingSigner();
    const outcome = await payForGrant({
      grant: { ...hire.grant, price_min_amount: "999999", price_max_amount: "999999" },
      grantHash: hire.grantHash,
      nowMs: NOW_MS,
      signer: signer.sign,
      broadcast: () => TX_HASH,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("grant_hash_mismatch");
    expect(outcome.unsigned).toBe(true);
    expect(signer.calls.length).toBe(0);
  });

  it("a broadcaster that throws is `broadcast_failed`, and unsigned is FALSE", async () => {
    const submitter = createSelfSubmitter({
      broadcast: () => {
        throw new Error("connection reset");
      },
    });
    const { signed } = await signedWithRealKey();
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("broadcast_failed");
    expect(out.detail).toContain("NOT PROOF NOTHING HAPPENED");
  });

  it("a broadcaster returning something that is not a hash is refused", async () => {
    const submitter = createSelfSubmitter({ broadcast: () => "ok" });
    const { signed } = await signedWithRealKey();
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("broadcast_failed");
  });
});

describe("the /settle bodies are derived from the signed authorization and nothing else", () => {
  it("the payload restates the signed fields verbatim", async () => {
    const { signed } = await signedWithRealKey();
    const payload = buildX402PaymentPayload(signed, { x402Version: 2, network: CHAIN });
    expect(payload.scheme).toBe("exact");
    expect(payload.network).toBe(CHAIN);
    expect(payload.payload.signature).toBe(signed.signature);
    expect(payload.payload.authorization).toEqual({
      from: signed.typedData.message.from,
      to: signed.typedData.message.to,
      value: signed.typedData.message.value,
      validAfter: signed.typedData.message.validAfter,
      validBefore: signed.typedData.message.validBefore,
      nonce: signed.typedData.message.nonce,
    });
  });

  it("v1 says maxAmountRequired and v2 says amount — never both", async () => {
    const { signed } = await signedWithRealKey();
    const v1 = buildX402PaymentRequirements(signed, { x402Version: 1, network: "base" });
    const v2 = buildX402PaymentRequirements(signed, { x402Version: 2, network: CHAIN });
    expect(v1.maxAmountRequired).toBe("1000000");
    expect("amount" in v1).toBe(false);
    expect(v2.amount).toBe("1000000");
    expect("maxAmountRequired" in v2).toBe(false);
  });

  it("the requirements restate eip3009 rather than only preflighting it", async () => {
    const { signed } = await signedWithRealKey();
    const req = buildX402PaymentRequirements(signed, { x402Version: 2, network: CHAIN });
    expect((req.extra as Record<string, unknown>).assetTransferMethod).toBe("eip3009");
    expect(req.asset).toBe(USDC);
    expect(req.payTo).toBe(PAYEE);
    expect(req.maxTimeoutSeconds).toBe(
      Number(signed.typedData.message.validBefore) -
        Number(signed.typedData.message.validAfter),
    );
  });

  it("a /settle answer is read for a transaction hash and for nothing else", async () => {
    const { signed } = await signedWithRealKey();
    const bodies: string[] = [];
    const submitter = createFacilitatorSubmitter({
      preflight: {
        schema: "voidly.pay.facilitator-preflight/v1",
        verdict: "usable",
        reason: "eip3009_exact_advertised",
        detail: "advertises eip3009",
        chain: CHAIN,
        frozenAsset: USDC,
        url: "https://facilitator.example.test/supported",
        httpStatus: 200,
        matched: { x402Version: 2, scheme: "exact", network: CHAIN, resolvedChain: CHAIN, assetTransferMethod: "eip3009" },
        observations: [],
        undetermined: [],
      } as unknown as FacilitatorPreflightResult,
      fetchImpl: (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://facilitator.example.test/settle");
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ success: true, transaction: TX_HASH }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.transactionHash).toBe(TX_HASH);

    const sent = JSON.parse(bodies[0]);
    expect(sent.paymentPayload.payload.authorization.nonce).toBe(
      await settlementNonce(GRANT_HASH),
    );
    expect(sent.paymentRequirements.extra.assetTransferMethod).toBe("eip3009");
  });

  it("`success: true` with NO hash is refused — a claim the adapter cannot check", async () => {
    const { signed } = await signedWithRealKey();
    const submitter = createFacilitatorSubmitter({
      preflight: {
        schema: "voidly.pay.facilitator-preflight/v1",
        verdict: "usable",
        reason: "eip3009_exact_advertised",
        detail: "",
        chain: CHAIN,
        frozenAsset: USDC,
        url: "https://facilitator.example.test/supported",
        httpStatus: 200,
        matched: { x402Version: 2, scheme: "exact", network: CHAIN, resolvedChain: CHAIN, assetTransferMethod: "eip3009" },
        observations: [],
        undetermined: [],
      } as unknown as FacilitatorPreflightResult,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ success: true, settled: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as never,
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_response_unreadable");
  });

  it("an unreachable /settle says plainly that the payment may have landed", async () => {
    const { signed } = await signedWithRealKey();
    const submitter = createFacilitatorSubmitter({
      preflight: {
        schema: "voidly.pay.facilitator-preflight/v1",
        verdict: "usable",
        reason: "eip3009_exact_advertised",
        detail: "",
        chain: CHAIN,
        frozenAsset: USDC,
        url: "https://facilitator.example.test/supported",
        httpStatus: 200,
        matched: { x402Version: 2, scheme: "exact", network: CHAIN, resolvedChain: CHAIN, assetTransferMethod: "eip3009" },
        observations: [],
        undetermined: [],
      } as unknown as FacilitatorPreflightResult,
      fetchImpl: (async () => {
        throw new Error("ETIMEDOUT");
      }) as never,
    });
    const out = await submitter.submit(signed);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("unreachable");
    expect(out.detail).toContain("THIS IS NOT A REFUSAL");
    expect(out.detail).toContain("idempotent");
  });

  it("a cleartext facilitator has no /settle URL", () => {
    expect(settleUrlFor("http://facilitator.example.test")).toBe(null);
    expect(settleUrlFor("https://facilitator.example.test")).toBe(
      "https://facilitator.example.test/settle",
    );
    expect(settleUrlFor("https://facilitator.example.test/supported")).toBe(
      "https://facilitator.example.test/settle",
    );
  });
});
