
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { Wallet, verifyTypedData } from "ethers";

import {
  assembleSignedReceiveAuthorization,
  assembleSignedTransferAuthorization,
  authorizationValidBeforeFor,
  bindAuthorizationToGrant,
  buildHire,
  buildReceivePaymentAuthorization,
  buildReceiveWithAuthorizationCalldata,
  buildTransferPaymentAuthorization,
  buildTransferWithAuthorizationCalldata,
  checkSingleAuthorizationRelay,
  hashArtifact,
  PAYMENT_AUTHORIZATION_SCHEME,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
  settlementBindingReference,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  validateAuthorizationShape,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
} from "../src/index";
import type {
  ReceiveAuthorizationTypedData,
  SignReceiveTypedData,
  SignTypedData,
  TaskGrantEnvelope,
  TransferAuthorizationTypedData,
} from "../src/index";

import {
  BRIEF,
  CHAIN,
  GRANT_TTL_MS,
  NOW,
  OFFER_TTL_MS,
  PAYEE_ADDR,
  PRICE,
  party,
  seededEntropy,
  verifiedProviderFor,
} from "./_fixtures";

interface Hire {
  grant: TaskGrantEnvelope;
  grantHash: string;
}

async function hireFor(payerAddress: string, seed = 0x424242): Promise<Hire> {
  const hirer = party(1);
  const provider = party(2);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
  const built = await buildHire({
    hirer: {
      did: hirer.did,
      signingPublicKeyBase64: hirer.signingPublicKeyBase64,
      sign: hirer.sign,
    },
    provider: verifiedProviderFor(provider, providerEnc, {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
      minAmount: PRICE,
      maxAmount: PRICE,
    }),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: BRIEF },
    price: {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payerAccount: x402SessionAccountCaip10(CHAIN, payerAddress)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
      minAmount: PRICE,
      maxAmount: PRICE,
    },
    ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS },
    nowMs: NOW,
    entropy: seededEntropy(seed),
  });
  if (!built.ok) throw new Error(`fixture hire failed: ${built.reason}`);
  return { grant: built.wire.grant, grantHash: built.keep.grant_hash };
}

function signerFor(wallet: ReturnType<typeof Wallet.createRandom>): SignReceiveTypedData {
  return (typedData: ReceiveAuthorizationTypedData) =>
    wallet.signTypedData(
      typedData.domain,
      { ReceiveWithAuthorization: [...typedData.types.ReceiveWithAuthorization] },
      typedData.message,
    );
}

describe("the builder emits a bindable, stamped, self-consistent wire authorization", () => {
  it("passes its own grant's shape validator AND six-axis binding", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;

    const shape = validateAuthorizationShape(out.authorization);
    expect(shape.ok, JSON.stringify(shape)).toBe(true);
    if (!shape.ok) return;
    const bound = await bindAuthorizationToGrant(shape.env, hire.grant, hire.grantHash);
    expect(bound).toBeNull();
    expect(out.grantHash).toBe(hire.grantHash);
  });

  it("REFUSES a grant its own binding would refuse — the self-check is live, not decorative", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);

    const doctored = { ...hire.grant, price_max_amount: "1" };
    const out = await buildReceivePaymentAuthorization({
      grant: doctored,
      grantHash: await hashArtifact(doctored),
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("authorization_over_ceiling");
  });

  it("REFUSES a grant that is not the grant the hash names, before the wallet is asked", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    let signerCalls = 0;

    const out = await buildReceivePaymentAuthorization({
      grant: { ...hire.grant, price_payee_account: `${CHAIN}:0x${"cd".repeat(20)}` },
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: () => {
        signerCalls += 1;
        return `0x${"11".repeat(64)}1b`;
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("grant_hash_mismatch");
    expect(signerCalls).toBe(0);
  });

  it("stamps `receive_with_authorization`, and equals the grant on every derived field", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const a = out.authorization;

    expect(a.scheme).toBe(PAYMENT_AUTHORIZATION_SCHEME);
    expect(a.entry_point).toBe("receive_with_authorization");

    const bareRef = await settlementBindingReference(hire.grantHash);
    expect(a.nonce).toBe(bareRef);
    expect(a.nonce.startsWith("0x")).toBe(false);
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/);

    expect(a.valid_before).toBe(authorizationValidBeforeFor(hire.grant));

    expect(a.from).toBe(hire.grant.price_payer_account);
    expect(a.to).toBe(hire.grant.price_payee_account);
    expect(a.asset).toBe(hire.grant.price_asset);
    expect(a.chain).toBe(hire.grant.price_chain);
    expect(a.value).toBe(hire.grant.price_min_amount);
    expect(a.valid_after).toBe("0");
  });

  it("the signature recovers the payer from the RECEIVE struct", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const recovered = verifyTypedData(
      out.signed.typedData.domain,
      { ReceiveWithAuthorization: [...out.signed.typedData.types.ReceiveWithAuthorization] },
      out.signed.typedData.message,
      out.signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(out.signed.typedData.primaryType).toBe("ReceiveWithAuthorization");
  });

  it("full loop: builder → receive door → receive calldata (0xef55bec6, 584 hex) → single-auth relay by the payee", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const assembled = await assembleSignedReceiveAuthorization({
      authorization: out.authorization,
      grant: hire.grant,
      nowMs: NOW,
      expectedGrantHash: hire.grantHash,
    });
    expect(assembled.ok, JSON.stringify(assembled)).toBe(true);
    if (!assembled.ok) return;

    const calldata = buildReceiveWithAuthorizationCalldata(assembled.signed);
    expect(calldata.ok, JSON.stringify(calldata)).toBe(true);
    if (!calldata.ok) return;
    expect(calldata.request.data.startsWith(RECEIVE_WITH_AUTHORIZATION_SELECTOR)).toBe(true);
    expect(calldata.request.data).toBe("0xef55bec6" + calldata.request.data.slice(10));
    expect(calldata.request.data).toMatch(/^0x[0-9a-f]{584}$/);

    expect(
      checkSingleAuthorizationRelay(calldata.request, { relayerAddress: PAYEE_ADDR }).ok,
    ).toBe(true);
  });
});

describe("the builder passes wallet refusals straight back", () => {
  it("a signer that throws is `signer_threw`", async () => {
    const hire = await hireFor(Wallet.createRandom().address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: () => {
        throw new Error("wallet popup dismissed");
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("signer_threw");
  });

  it("a closed window is `authorization_expired` — the relay-time clock, not the chain", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const past = authorizationValidBeforeFor(hire.grant)!;
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: (Number(past) + 1) * 1000,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("authorization_expired");
  });

  it("an off-by-27 recovery id is `signature_recovery_id_invalid`", async () => {
    const hire = await hireFor(Wallet.createRandom().address);
    const badSig = "0x" + "11".repeat(64) + "00";
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: () => badSig,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("signature_recovery_id_invalid");
  });
});

describe("the stamp is live — and this is the tamper-resistant proof", () => {
  it("the builder's output is REFUSED at the transfer door by name, and assembles at the receive door", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address);
    const out = await buildReceivePaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: signerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const atTransfer = await assembleSignedTransferAuthorization({
      authorization: out.authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(atTransfer.ok).toBe(false);
    if (atTransfer.ok) return;
    expect(atTransfer.reason).toBe("authorization_entry_point_mismatch");

    const atReceive = await assembleSignedReceiveAuthorization({
      authorization: out.authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(atReceive.ok, JSON.stringify(atReceive)).toBe(true);
  });
});

function transferSignerFor(wallet: ReturnType<typeof Wallet.createRandom>): SignTypedData {
  return (typedData: TransferAuthorizationTypedData) =>
    wallet.signTypedData(
      typedData.domain,
      { TransferWithAuthorization: [...typedData.types.TransferWithAuthorization] },
      typedData.message,
    );
}

describe("buildTransferPaymentAuthorization stamps the transfer entry point explicitly", () => {
  it("emits a bindable authorization whose every field is the grant's", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x515151);
    const out = await buildTransferPaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: transferSignerFor(wallet),
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    const a = out.authorization;

    expect(a.entry_point).toBe("transfer_with_authorization");
    expect(a.scheme).toBe(PAYMENT_AUTHORIZATION_SCHEME);
    expect(a.from).toBe(hire.grant.price_payer_account);
    expect(a.to).toBe(hire.grant.price_payee_account);
    expect(a.asset).toBe(hire.grant.price_asset);
    expect(a.chain).toBe(hire.grant.price_chain);
    expect(a.value).toBe(hire.grant.price_min_amount);
    expect(a.valid_after).toBe("0");
    expect(a.valid_before).toBe(authorizationValidBeforeFor(hire.grant));
    expect(a.nonce).toBe(await settlementBindingReference(hire.grantHash));

    const shape = validateAuthorizationShape(a);
    expect(shape.ok, JSON.stringify(shape)).toBe(true);
    if (!shape.ok) return;
    expect(await bindAuthorizationToGrant(shape.env, hire.grant, hire.grantHash)).toBeNull();
  });

  it("the signature recovers the payer from the TRANSFER struct", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x525252);
    const out = await buildTransferPaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: transferSignerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.signed.typedData.primaryType).toBe("TransferWithAuthorization");
    const recovered = verifyTypedData(
      out.signed.typedData.domain,
      { TransferWithAuthorization: [...out.signed.typedData.types.TransferWithAuthorization] },
      out.signed.typedData.message,
      out.signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("full loop: builder → transfer calldata (0xe3ee160e, 584 hex)", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x535353);
    const out = await buildTransferPaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: transferSignerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const calldata = buildTransferWithAuthorizationCalldata(out.signed);
    expect(calldata.ok, JSON.stringify(calldata)).toBe(true);
    if (!calldata.ok) return;
    expect(calldata.request.data.startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)).toBe(true);
    expect(calldata.request.data).toMatch(/^0x[0-9a-f]{584}$/);
  });

  it("the stamped transfer authorization is REFUSED at the receive door by name", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x545454);
    const out = await buildTransferPaymentAuthorization({
      grant: hire.grant,
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: transferSignerFor(wallet),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const atReceive = await assembleSignedReceiveAuthorization({
      authorization: out.authorization,
      grant: hire.grant,
      nowMs: NOW,
      expectedGrantHash: hire.grantHash,
    });
    expect(atReceive.ok).toBe(false);
    if (atReceive.ok) return;
    expect(atReceive.reason).toBe("authorization_entry_point_mismatch");

    const atTransfer = await assembleSignedTransferAuthorization({
      authorization: out.authorization,
      grant: hire.grant,
      nowMs: NOW,
      expectedGrantHash: hire.grantHash,
    });
    expect(atTransfer.ok, JSON.stringify(atTransfer)).toBe(true);
  });
});

describe("the transfer builder refuses BEFORE the wallet is asked", () => {
  it("a doctored grant carrying the real hash is `grant_hash_mismatch`, signer never called", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x565656);
    let calls = 0;
    const out = await buildTransferPaymentAuthorization({
      grant: { ...hire.grant, price_min_amount: "1", price_max_amount: "1" },
      grantHash: hire.grantHash,
      nowMs: NOW,
      sign: () => {
        calls += 1;
        return `0x${"11".repeat(64)}1b`;
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("grant_hash_mismatch");
    expect(calls).toBe(0);
  });

  it("an inconsistent band is `authorization_over_ceiling`, signer never called", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireFor(wallet.address, 0x575757);
    const doctored = { ...hire.grant, price_max_amount: "1" };
    let calls = 0;
    const out = await buildTransferPaymentAuthorization({
      grant: doctored,
      grantHash: await hashArtifact(doctored),
      nowMs: NOW,
      sign: () => {
        calls += 1;
        return `0x${"11".repeat(64)}1b`;
      },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("authorization_over_ceiling");
    expect(calls).toBe(0);
  });
});
