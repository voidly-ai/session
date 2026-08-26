
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { Wallet, verifyTypedData } from "ethers";

import {
  assembleSignedReceiveAuthorization,
  assembleSignedTransferAuthorization,
  authorizationValidBeforeFor,
  buildHire,
  buildReceiveAuthorizationTypedData,
  buildReceiveWithAuthorizationCalldata,
  buildTransferAuthorizationTypedData,
  buildTransferWithAuthorizationCalldata,
  checkSingleAuthorizationRelay,
  createSelfSubmitter,
  envelopeHash,
  PAYMENT_AUTHORIZATION_SCHEME,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
  settlementBindingReference,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
} from "../src/index";
import type { TaskGrantEnvelope } from "../src/index";

import {
  BRIEF,
  CHAIN,
  GRANT_TTL_MS,
  NOW,
  OFFER_TTL_MS,
  PAYEE_ADDR,
  PAYER_ADDR,
  PRICE,
  party,
  seededEntropy,
  verifiedProviderFor,
} from "./_fixtures";

const NON_USDC_ASSET = `${CHAIN}/erc20:0x4200000000000000000000000000000000000042`;

const RELAY_TX_HASH = `0x${"7d".repeat(32)}`;

interface Hire {
  grant: TaskGrantEnvelope;
  grantHash: string;
}

async function hireWith(
  over: {
    seed?: number;
    payerAddress?: string;
    payeeAddress?: string;
    asset?: string;
    minAmount?: string;
    maxAmount?: string;
  } = {},
): Promise<Hire> {
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
      asset: over.asset ?? x402SessionAssetCaip19(CHAIN)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, over.payeeAddress ?? PAYEE_ADDR)!,
      minAmount: over.minAmount ?? PRICE,
      maxAmount: over.maxAmount ?? PRICE,
    }),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: BRIEF },
    price: {
      chain: CHAIN,
      asset: over.asset ?? x402SessionAssetCaip19(CHAIN)!,
      payerAccount: x402SessionAccountCaip10(CHAIN, over.payerAddress ?? PAYER_ADDR)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, over.payeeAddress ?? PAYEE_ADDR)!,
      minAmount: over.minAmount ?? PRICE,
      maxAmount: over.maxAmount ?? PRICE,
    },
    ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS },
    nowMs: NOW,
    entropy: seededEntropy(over.seed ?? 0x515151),
  });
  if (!built.ok) throw new Error(`fixture hire failed: ${built.reason}`);
  return { grant: built.wire.grant, grantHash: built.keep.grant_hash };
}

async function wireAuthorization(
  hire: Hire,
  opts: {
    wallet?: ReturnType<typeof Wallet.createRandom>;
    value?: string;
    over?: Record<string, unknown>;
    drop?: string[];
  } = {},
): Promise<Record<string, unknown>> {
  const validBefore = authorizationValidBeforeFor(hire.grant);
  if (validBefore === null) throw new Error("fixture grant has an unparseable expires_at");
  const value = opts.value ?? hire.grant.price_min_amount;

  const typed = await buildTransferAuthorizationTypedData({
    chain: hire.grant.price_chain,
    from: hire.grant.price_payer_account,
    to: hire.grant.price_payee_account,
    value,
    validAfter: 0,
    validBefore: Number(validBefore),
    grantHash: hire.grantHash,
  });
  if (!typed.ok) throw new Error(`fixture typed data failed: ${typed.reason}`);

  const wallet = opts.wallet ?? Wallet.createRandom();
  const signature = await wallet.signTypedData(
    typed.typedData.domain,
    { TransferWithAuthorization: [...typed.typedData.types.TransferWithAuthorization] },
    typed.typedData.message,
  );

  const authorization: Record<string, unknown> = {
    scheme: PAYMENT_AUTHORIZATION_SCHEME,
    chain: hire.grant.price_chain,
    asset: hire.grant.price_asset,
    from: hire.grant.price_payer_account,
    to: hire.grant.price_payee_account,
    value,
    valid_after: "0",
    valid_before: validBefore,
    nonce: await settlementBindingReference(hire.grantHash),
    signature,
    ...(opts.over ?? {}),
  };
  for (const key of opts.drop ?? []) delete authorization[key];
  return authorization;
}

async function refusalOf(
  hire: Hire,
  authorization: unknown,
  nowMs = NOW,
  expectedGrantHash?: string,
): Promise<string> {
  const outcome = await assembleSignedTransferAuthorization({
    authorization,
    grant: hire.grant,
    nowMs,
    ...(expectedGrantHash === undefined ? {} : { expectedGrantHash }),
  });
  if (outcome.ok) throw new Error("expected a refusal and the authorization assembled");
  expect(outcome.detail.length).toBeGreaterThan(40);
  return outcome.reason;
}

describe("the happy path assembles something a relayer can actually broadcast", () => {
  it("assembles, and the assembled struct is the one the payer signed", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const authorization = await wireAuthorization(hire, { wallet });

    const outcome = await assembleSignedTransferAuthorization({
      authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.grantHash).toBe(hire.grantHash);
    expect(outcome.signed.chain).toBe(CHAIN);
    expect(outcome.signed.grantHash).toBe(hire.grantHash);
    expect(outcome.signed.v === 27 || outcome.signed.v === 28).toBe(true);

    const recovered = verifyTypedData(
      outcome.signed.typedData.domain,
      {
        TransferWithAuthorization: [...outcome.signed.typedData.types.TransferWithAuthorization],
      },
      outcome.signed.typedData.message,
      outcome.signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(outcome.signed.typedData.message.from).toBe(wallet.address.toLowerCase());
  });

  it("the calldata is nine words, is a single authorization, and reaches a broadcaster", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const outcome = await assembleSignedTransferAuthorization({
      authorization: await wireAuthorization(hire, { wallet }),
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const built = buildTransferWithAuthorizationCalldata(outcome.signed);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    expect(built.request.data).toMatch(/^0x[0-9a-f]{584}$/);

    expect(checkSingleAuthorizationRelay(built.request).ok).toBe(true);

    const seen: unknown[] = [];
    const submitter = createSelfSubmitter({
      broadcast: (request) => {
        seen.push(request);
        return RELAY_TX_HASH;
      },
    });
    const submitted = await submitter.submit(outcome.signed);
    expect(submitted).toEqual({ ok: true, transactionHash: RELAY_TX_HASH });
    expect(seen).toHaveLength(1);
  });

  it("the signed nonce is the grant's binding reference, derived here", async () => {
    const hire = await hireWith();
    const outcome = await assembleSignedTransferAuthorization({
      authorization: await wireAuthorization(hire),
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const expected = `0x${await settlementBindingReference(await envelopeHash(hire.grant))}`;
    expect(outcome.signed.typedData.message.nonce).toBe(expected);

    const other = await hireWith({ seed: 0x626262 });
    expect(other.grantHash).not.toBe(hire.grantHash);
    expect(outcome.signed.typedData.message.nonce).not.toBe(
      `0x${await settlementBindingReference(other.grantHash)}`,
    );
  });

  it("an expectedGrantHash that agrees is accepted (positive control for the mismatch case)", async () => {
    const hire = await hireWith();
    const outcome = await assembleSignedTransferAuthorization({
      authorization: await wireAuthorization(hire),
      grant: hire.grant,
      nowMs: NOW,
      expectedGrantHash: hire.grantHash,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });
});

describe("the binding is the load-bearing axis", () => {
  it("another grant's binding nonce is refused, and nothing is assembled", async () => {
    const hire = await hireWith();
    const other = await hireWith({ seed: 0x939393 });
    expect(other.grantHash).not.toBe(hire.grantHash);

    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, {
        over: { nonce: await settlementBindingReference(other.grantHash) },
      }),
    );
    expect(reason).toBe("authorization_binding_mismatch");
  });

  it("a caller-supplied grant hash is COMPARED, never substituted", async () => {
    const hire = await hireWith();
    const authorization = await wireAuthorization(hire);
    expect(await refusalOf(hire, authorization, NOW, "ab".repeat(32))).toBe("grant_hash_mismatch");
    expect(await refusalOf(hire, authorization, NOW, "not-a-hash")).toBe("grant_hash_mismatch");
  });
});

describe("shape, band, window and party are each refused by their own name", () => {
  it("an undeclared field cannot ride along", async () => {
    const hire = await hireWith();
    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, { over: { memo: "pay me twice" } }),
    );
    expect(reason).toBe("authorization_unexpected_field");
  });

  it("one smallest unit below the floor is below the floor", async () => {
    const hire = await hireWith({ minAmount: "1000000", maxAmount: "2000000" });
    expect(await refusalOf(hire, await wireAuthorization(hire, { value: "999999" }))).toBe(
      "authorization_below_floor",
    );
  });

  it("one smallest unit above the ceiling is over the ceiling", async () => {
    const hire = await hireWith({ minAmount: "1000000", maxAmount: "2000000" });
    expect(await refusalOf(hire, await wireAuthorization(hire, { value: "2000001" }))).toBe(
      "authorization_over_ceiling",
    );
  });

  it("a valid_before that is not the grant's expiry is refused", async () => {
    const hire = await hireWith();
    const validBefore = authorizationValidBeforeFor(hire.grant)!;
    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, { over: { valid_before: String(Number(validBefore) - 1) } }),
    );
    expect(reason).toBe("authorization_expiry_mismatch");
  });

  it("the payer must be the grant's payer", async () => {
    const hire = await hireWith();
    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, { over: { from: hire.grant.price_payee_account } }),
    );
    expect(reason).toBe("authorization_payer_mismatch");
  });

  it("the payee must be the grant's payee — a stranger's account is refused", async () => {
    const hire = await hireWith();
    const elsewhere = x402SessionAccountCaip10(
      CHAIN,
      "0x3333333333333333333333333333333333333333",
    )!;
    const reason = await refusalOf(hire, await wireAuthorization(hire, { over: { to: elsewhere } }));
    expect(reason).toBe("authorization_payee_mismatch");
  });

  it("a valid_after past 2^53 is refused before anything converts it", async () => {
    const hire = await hireWith();
    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, { over: { valid_after: "99999999999999999999" } }),
    );
    expect(reason).toBe("valid_after_not_safe_integer");
  });
});

describe("the relay-time clock and the recovery id are checked, not assumed", () => {
  it("an authorization whose window has closed by relay time is refused", async () => {
    const hire = await hireWith();
    const authorization = await wireAuthorization(hire);
    const past = NOW + GRANT_TTL_MS + 5_000;
    expect(await refusalOf(hire, authorization, past)).toBe("authorization_expired");
    const inWindow = await assembleSignedTransferAuthorization({
      authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(inWindow.ok).toBe(true);
  });

  it("a recovery id that is not 27 or 28 is refused by name", async () => {
    const hire = await hireWith();
    const authorization = await wireAuthorization(hire);
    const raw = String(authorization.signature);
    expect(raw).toHaveLength(132);
    const signature = `${raw.slice(0, 130)}00`;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await refusalOf(hire, { ...authorization, signature })).toBe(
      "signature_recovery_id_invalid",
    );
  });

  it("a signature of the wrong LENGTH is a different accusation", async () => {
    const hire = await hireWith();
    const authorization = await wireAuthorization(hire);
    const short = `${String(authorization.signature).slice(0, 130)}`;
    expect(await refusalOf(hire, { ...authorization, signature: short })).toBe(
      "authorization_invalid_signature",
    );
  });
});

describe("the asset must be the deployment this rail settles, not merely the one the grant names", () => {
  it("a grant priced in a non-USDC token is refused even though every axis agrees", async () => {
    const hire = await hireWith({ asset: NON_USDC_ASSET });
    expect(hire.grant.price_asset).toBe(NON_USDC_ASSET);

    const authorization = await wireAuthorization(hire);
    expect(authorization.asset).toBe(hire.grant.price_asset);

    expect(await refusalOf(hire, authorization)).toBe("authorization_asset_not_frozen_usdc");
  });

  it("positive control: the same hire priced in the frozen USDC assembles", async () => {
    const hire = await hireWith({ asset: x402SessionAssetCaip19(CHAIN)! });
    const outcome = await assembleSignedTransferAuthorization({
      authorization: await wireAuthorization(hire),
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });
});

async function wireReceiveAuthorization(
  hire: Hire,
  opts: { wallet?: ReturnType<typeof Wallet.createRandom>; over?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const validBefore = authorizationValidBeforeFor(hire.grant);
  if (validBefore === null) throw new Error("fixture grant has an unparseable expires_at");

  const typed = await buildReceiveAuthorizationTypedData({
    chain: hire.grant.price_chain,
    from: hire.grant.price_payer_account,
    to: hire.grant.price_payee_account,
    value: hire.grant.price_min_amount,
    validAfter: 0,
    validBefore: Number(validBefore),
    grantHash: hire.grantHash,
  });
  if (!typed.ok) throw new Error(`fixture receive typed data failed: ${typed.reason}`);

  const wallet = opts.wallet ?? Wallet.createRandom();
  const signature = await wallet.signTypedData(
    typed.typedData.domain,
    { ReceiveWithAuthorization: [...typed.typedData.types.ReceiveWithAuthorization] },
    typed.typedData.message,
  );

  return {
    scheme: PAYMENT_AUTHORIZATION_SCHEME,
    entry_point: "receive_with_authorization",
    chain: hire.grant.price_chain,
    asset: hire.grant.price_asset,
    from: hire.grant.price_payer_account,
    to: hire.grant.price_payee_account,
    value: hire.grant.price_min_amount,
    valid_after: "0",
    valid_before: validBefore,
    nonce: await settlementBindingReference(hire.grantHash),
    signature,
    ...(opts.over ?? {}),
  };
}

async function receiveRefusalOf(hire: Hire, authorization: unknown): Promise<string> {
  const outcome = await assembleSignedReceiveAuthorization({
    authorization,
    grant: hire.grant,
    nowMs: NOW,
  });
  if (outcome.ok) throw new Error("expected a refusal and the authorization assembled");
  expect(outcome.detail.length).toBeGreaterThan(40);
  return outcome.reason;
}

describe("the entry point steers which door, and only which door", () => {
  it("UNSTATED assembles at BOTH doors — absent is not a default", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const authorization = await wireAuthorization(hire, { wallet });
    expect("entry_point" in authorization).toBe(false);

    const asTransfer = await assembleSignedTransferAuthorization({
      authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(asTransfer.ok, JSON.stringify(asTransfer)).toBe(true);

    const asReceive = await assembleSignedReceiveAuthorization({
      authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(asReceive.ok, JSON.stringify(asReceive)).toBe(true);
  });

  it("a declared RECEIVE authorization assembles at the receive door, and the payer is recovered from the receive struct", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const outcome = await assembleSignedReceiveAuthorization({
      authorization: await wireReceiveAuthorization(hire, { wallet }),
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.grantHash).toBe(hire.grantHash);
    expect(outcome.signed.typedData.primaryType).toBe("ReceiveWithAuthorization");

    const recovered = verifyTypedData(
      outcome.signed.typedData.domain,
      { ReceiveWithAuthorization: [...outcome.signed.typedData.types.ReceiveWithAuthorization] },
      outcome.signed.typedData.message,
      outcome.signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

    const built = buildReceiveWithAuthorizationCalldata(outcome.signed);
    expect(built.ok, JSON.stringify(built)).toBe(true);
    if (!built.ok) return;
    expect(built.request.data.startsWith(RECEIVE_WITH_AUTHORIZATION_SELECTOR)).toBe(true);
    expect(built.request.data).toMatch(/^0x[0-9a-f]{584}$/);
    expect(
      checkSingleAuthorizationRelay(built.request, { relayerAddress: PAYEE_ADDR }).ok,
    ).toBe(true);
  });

  it("a declared RECEIVE authorization is refused at the TRANSFER door, by name", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const authorization = await wireReceiveAuthorization(hire, { wallet });
    expect(await refusalOf(hire, authorization)).toBe("authorization_entry_point_mismatch");
  });

  it("a declared TRANSFER authorization is refused at the RECEIVE door, by name", async () => {
    const wallet = Wallet.createRandom();
    const hire = await hireWith({ payerAddress: wallet.address });
    const authorization = await wireAuthorization(hire, {
      wallet,
      over: { entry_point: "transfer_with_authorization" },
    });
    expect(await receiveRefusalOf(hire, authorization)).toBe(
      "authorization_entry_point_mismatch",
    );

    const asTransfer = await assembleSignedTransferAuthorization({
      authorization,
      grant: hire.grant,
      nowMs: NOW,
    });
    expect(asTransfer.ok, JSON.stringify(asTransfer)).toBe(true);
  });

  it("a value outside the vocabulary is the REDEMPTION PATH's refusal at both doors, not the door's", async () => {
    const hire = await hireWith();
    const junk = await wireAuthorization(hire, { over: { entry_point: "receive" } });
    expect(await refusalOf(hire, junk)).toBe("authorization_entry_point_unsupported");
    expect(await receiveRefusalOf(hire, junk)).toBe("authorization_entry_point_unsupported");
  });

  it("an undeclared key is still refused — the key set was extended, not relaxed", async () => {
    const hire = await hireWith();
    const reason = await refusalOf(
      hire,
      await wireAuthorization(hire, { over: { entry_point_hint: "receive" } }),
    );
    expect(reason).toBe("authorization_unexpected_field");
  });
});
