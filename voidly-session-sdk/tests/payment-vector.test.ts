
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { TypedDataEncoder, id as keccakUtf8 } from "ethers";
import {
  buildTransferAuthorizationTypedData,
  EVM_USDC_EIP712_DOMAINS,
  settlementNonce,
  SETTLEMENT_BINDING_DOMAIN,
  buildReceiveAuthorizationTypedData,
  RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
  TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
  X402_SESSION_USDC_BY_CHAIN,
  x402SessionAccountCaip10,
  x402SessionEvidence,
} from "../src/index";

const ON_CHAIN_DOMAIN_SEPARATORS: Record<string, string> = {
  "eip155:8453": "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f",
  "eip155:84532": "0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818",
};

const GRANT_HASH = "a".repeat(64);
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";

function structTypes(td: { types: Record<string, unknown> }) {
  const { EIP712Domain: _drop, ...rest } = td.types as Record<string, unknown>;
  return rest as Record<string, Array<{ name: string; type: string }>>;
}

describe("the pinned domain table agrees with the chain", () => {
  it.each([...EVM_USDC_EIP712_DOMAINS.keys()])(
    "%s: ethers reconstructs the deployment's own DOMAIN_SEPARATOR()",
    (chain) => {
      const d = EVM_USDC_EIP712_DOMAINS.get(chain)!;
      const reconstructed = TypedDataEncoder.hashDomain({
        name: d.name,
        version: d.version,
        chainId: d.chainId,
        verifyingContract: d.verifyingContract,
      });
      expect(reconstructed).toBe(ON_CHAIN_DOMAIN_SEPARATORS[chain]);
      expect(d.domainSeparator).toBe(ON_CHAIN_DOMAIN_SEPARATORS[chain]);
    },
  );

  it("the two networks do NOT share a token name — the whole reason this table exists", () => {
    expect(EVM_USDC_EIP712_DOMAINS.get("eip155:8453")!.name).toBe("USD Coin");
    expect(EVM_USDC_EIP712_DOMAINS.get("eip155:84532")!.name).toBe("USDC");
  });

  it("POSITIVE CONTROL: mainnet's name on Sepolia produces a DIFFERENT separator", () => {
    const wrong = TypedDataEncoder.hashDomain({
      name: "USD Coin",
      version: "2",
      chainId: 84532,
      verifyingContract: EVM_USDC_EIP712_DOMAINS.get("eip155:84532")!.verifyingContract,
    });
    expect(wrong).not.toBe(ON_CHAIN_DOMAIN_SEPARATORS["eip155:84532"]);
  });

  it("the token address agrees with the settlement adapter's FROZEN table", () => {
    for (const [chain, d] of EVM_USDC_EIP712_DOMAINS) {
      expect(X402_SESSION_USDC_BY_CHAIN.get(chain)).toBe(d.verifyingContract);
    }
  });

  it("the struct typehash matches the deployment's TRANSFER_WITH_AUTHORIZATION_TYPEHASH()", () => {
    expect(TRANSFER_WITH_AUTHORIZATION_TYPEHASH).toBe(
      keccakUtf8(
        "TransferWithAuthorization(address from,address to,uint256 value," +
          "uint256 validAfter,uint256 validBefore,bytes32 nonce)",
      ),
    );
  });

  it("the receive typehash matches the deployment's RECEIVE_WITH_AUTHORIZATION_TYPEHASH()", () => {
    expect(RECEIVE_WITH_AUTHORIZATION_TYPEHASH).toBe(
      keccakUtf8(
        "ReceiveWithAuthorization(address from,address to,uint256 value," +
          "uint256 validAfter,uint256 validBefore,bytes32 nonce)",
      ),
    );
  });

  it("the two typehashes are DIFFERENT — that is the whole security property", () => {
    expect(RECEIVE_WITH_AUTHORIZATION_TYPEHASH).not.toBe(TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
  });
});

describe("buildReceiveAuthorizationTypedData — the payee-only variant", () => {
  const BASE = {
    chain: "eip155:8453",
    from: PAYER,
    to: PAYEE,
    value: "1000000",
    validAfter: 0,
    validBefore: 1_800_000_000,
    grantHash: GRANT_HASH,
  };

  it("differs from the transfer variant in the STRUCT NAME and nothing else", async () => {
    const [t, r] = await Promise.all([
      buildTransferAuthorizationTypedData(BASE),
      buildReceiveAuthorizationTypedData(BASE),
    ]);
    expect(t.ok && r.ok).toBe(true);
    if (!t.ok || !r.ok) return;

    expect(r.typedData.domain).toEqual(t.typedData.domain);
    expect(r.typedData.message).toEqual(t.typedData.message);
    expect(r.typedData.primaryType).toBe("ReceiveWithAuthorization");
    expect(r.typedData.types.ReceiveWithAuthorization).toEqual(
      t.typedData.types.TransferWithAuthorization,
    );
    expect(r.typedData.message.nonce).toBe(await settlementNonce(GRANT_HASH));
  });

  it("hashes to a DIFFERENT digest, so the signatures are not interchangeable", async () => {
    const [t, r] = await Promise.all([
      buildTransferAuthorizationTypedData(BASE),
      buildReceiveAuthorizationTypedData(BASE),
    ]);
    expect(t.ok && r.ok).toBe(true);
    if (!t.ok || !r.ok) return;
    const td = t.typedData;
    const rd = r.typedData;
    expect(TypedDataEncoder.hashDomain(rd.domain)).toBe(
      ON_CHAIN_DOMAIN_SEPARATORS["eip155:8453"],
    );
    const transferDigest = TypedDataEncoder.hash(td.domain, structTypes(td), td.message);
    const receiveDigest = TypedDataEncoder.hash(
      rd.domain,
      { ReceiveWithAuthorization: [...rd.types.ReceiveWithAuthorization] },
      rd.message,
    );
    expect(receiveDigest).not.toBe(transferDigest);
    expect(receiveDigest).toBe(
      "0xb2ab63501157f11f2c4fee1de28c4fdbdd4ecdd886ebd0503850f6a53d32d605",
    );
  });

  it("applies EVERY refusal the transfer builder applies, from the same function", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unsupported_chain", { chain: "eip155:1" }],
      ["invalid_from", { from: "not-an-address" }],
      ["invalid_to", { to: "0x123" }],
      ["invalid_value", { value: "-1" }],
      ["invalid_validity_window", { validAfter: 100, validBefore: 100 }],
      ["validity_looks_like_milliseconds", { validBefore: 1_800_000_000_000 }],
      ["invalid_grant_hash", { grantHash: "nope" }],
    ];
    for (const [reason, over] of cases) {
      const [t, r] = await Promise.all([
        buildTransferAuthorizationTypedData({ ...BASE, ...over } as typeof BASE),
        buildReceiveAuthorizationTypedData({ ...BASE, ...over } as typeof BASE),
      ]);
      expect(t.ok, reason).toBe(false);
      expect(r.ok, reason).toBe(false);
      if (t.ok || r.ok) continue;
      expect(r.reason, reason).toBe(reason);
      expect(r.reason, reason).toBe(t.reason);
    }
  });
});

describe("the EIP-3009 nonce is the session rail's binding reference", () => {
  it("equals SHA-256 of the domain tag + grant hash, computed by node:crypto", () => {
    const independent = createHash("sha256")
      .update(SETTLEMENT_BINDING_DOMAIN + GRANT_HASH, "utf8")
      .digest("hex");
    return expect(settlementNonce(GRANT_HASH)).resolves.toBe(`0x${independent}`);
  });

  it("a DIFFERENT grant yields a different nonce — this is the binding", () => {
    return Promise.all([settlementNonce(GRANT_HASH), settlementNonce("b".repeat(64))]).then(
      ([a, b]) => expect(a).not.toBe(b),
    );
  });

  it("refuses anything that is not 64-char lowercase hex", async () => {
    await expect(settlementNonce("A".repeat(64))).rejects.toThrow(RangeError);
    await expect(settlementNonce("abc")).rejects.toThrow(RangeError);
  });
});

describe("buildTransferAuthorizationTypedData", () => {
  it("produces a payload ethers hashes to a stable, independently derived digest", async () => {
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453",
      from: PAYER,
      to: PAYEE,
      value: "1000000",
      validAfter: 0,
      validBefore: 1_800_000_000,
      grantHash: GRANT_HASH,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const td = built.typedData;

    expect(TypedDataEncoder.hashDomain(td.domain)).toBe(
      ON_CHAIN_DOMAIN_SEPARATORS["eip155:8453"],
    );

    const encoder = TypedDataEncoder.from(structTypes(td));
    expect(encoder.primaryType).toBe("TransferWithAuthorization");

    const digest = TypedDataEncoder.hash(td.domain, structTypes(td), td.message);
    expect(digest).toBe(
      "0x922df4e35cce9091b379970f0c35b6e5a3516b4e23661462658deae9d3b5abc0",
    );

    expect(td.message.nonce).toBe(await settlementNonce(GRANT_HASH));
  });

  it("POSITIVE CONTROL: reordering the struct members changes the digest", async () => {
    // EIP-712 encodes members POSITIONALLY. A reorder still reads correctly
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453", from: PAYER, to: PAYEE, value: "1000000",
      validAfter: 0, validBefore: 1_800_000_000, grantHash: GRANT_HASH,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const td = built.typedData;
    const swapped = {
      TransferWithAuthorization: [
        { name: "to", type: "address" },
        { name: "from", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    expect(TypedDataEncoder.hash(td.domain, swapped, td.message)).not.toBe(
      "0x922df4e35cce9091b379970f0c35b6e5a3516b4e23661462658deae9d3b5abc0",
    );
  });

  it("accepts the grant's CAIP-10 accounts as readily as bare addresses", async () => {
    const caipPayer = x402SessionAccountCaip10("eip155:8453", PAYER)!;
    const caipPayee = x402SessionAccountCaip10("eip155:8453", PAYEE)!;
    expect(caipPayer).toBe(`eip155:8453:${PAYER}`);

    const [bare, caip] = await Promise.all([
      buildTransferAuthorizationTypedData({
        chain: "eip155:8453", from: PAYER, to: PAYEE, value: "5",
        validAfter: 0, validBefore: 1_800_000_000, grantHash: GRANT_HASH,
      }),
      buildTransferAuthorizationTypedData({
        chain: "eip155:8453", from: caipPayer, to: caipPayee, value: "5",
        validAfter: 0, validBefore: 1_800_000_000, grantHash: GRANT_HASH,
      }),
    ]);
    expect(bare.ok && caip.ok).toBe(true);
    if (!bare.ok || !caip.ok) return;
    expect(caip.typedData.message).toEqual(bare.typedData.message);
  });

  it("REFUSES a millisecond validity window rather than signing it", async () => {
    // EIP-3009 compares against block.timestamp, which is SECONDS. Milliseconds
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453", from: PAYER, to: PAYEE, value: "1",
      validAfter: 0, validBefore: Date.now(), grantHash: GRANT_HASH,
    });
    expect(built).toEqual({ ok: false, reason: "validity_looks_like_milliseconds" });
  });

  it.each([
    ["unsupported_chain", { chain: "eip155:1" }],
    ["invalid_from", { from: "not-an-address" }],
    ["invalid_to", { to: "0xdeadbeef" }],
    ["invalid_value", { value: "0" }],
    ["invalid_value", { value: "010" }],
    ["invalid_validity_window", { validAfter: 100, validBefore: 100 }],
    ["invalid_grant_hash", { grantHash: "zz" }],
  ])("refuses with %s", async (reason, override) => {
    const base = {
      chain: "eip155:8453", from: PAYER, to: PAYEE, value: "1000000",
      validAfter: 0, validBefore: 1_800_000_000, grantHash: GRANT_HASH,
    };
    const built = await buildTransferAuthorizationTypedData({ ...base, ...override });
    expect(built).toEqual({ ok: false, reason });
  });

  it("a CAIP-10 account from the WRONG chain is refused, not silently reprefixed", async () => {
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453",
      from: `eip155:84532:${PAYER}`,
      to: PAYEE, value: "1", validAfter: 0, validBefore: 1_800_000_000,
      grantHash: GRANT_HASH,
    });
    expect(built).toEqual({ ok: false, reason: "invalid_from" });
  });
});

describe("settlement evidence carries a transaction hash and nothing else", () => {
  it("is exactly two fields", () => {
    const tx = `0x${"c".repeat(64)}`;
    expect(x402SessionEvidence(tx)).toEqual({
      schema: "voidly.session.settlement.x402/v1",
      transaction_hash: tx,
    });
  });

  it("refuses an UPPERCASE hash — one payment must not wear two evidence ids", () => {
    expect(() => x402SessionEvidence(`0x${"C".repeat(64)}`)).toThrow(RangeError);
  });
});
