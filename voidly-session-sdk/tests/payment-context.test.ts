import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import { Wallet } from "ethers";
import {
  buildHire, buildReceivePaymentAuthorization, buildTransferPaymentAuthorization,
  buildReceiveWithAuthorizationCalldata, buildTransferWithAuthorizationCalldata,
  createSelfSubmitter, signReceiveAuthorization, signTransferAuthorization,
  createPaymentContext, checkPaymentSignRequest, verifyPaymentSignature, checkPaymentSubmitRequest,
  x402SessionAccountCaip10, x402SessionAssetCaip19,
} from "../src/index";
import type { PaymentContext, PaymentEntryPoint, PaymentTypedData, TaskGrantEnvelope } from "../src/index";
import { BRIEF, CHAIN, GRANT_TTL_MS, NOW, OFFER_TTL_MS, PAYEE_ADDR, party, seededEntropy, verifiedProviderFor } from "./_fixtures";

const payer = new Wallet(`0x${"11".repeat(32)}`);
const stranger = new Wallet(`0x${"22".repeat(32)}`);
const entryPoints = ["receive_with_authorization", "transfer_with_authorization"] as const;
const MIN = "50000", MAX = "5000000";
let grant: TaskGrantEnvelope;
async function makeContext(entryPoint: PaymentEntryPoint = entryPoints[0], amount?: string, inputGrant = grant) {
  const result = await createPaymentContext({ grant: inputGrant, entryPoint, amount });
  if (!result.ok) throw new Error(result.reason);
  return result.context;
}
function sign(td: PaymentTypedData, wallet = payer) {
  const fields = td.primaryType === "ReceiveWithAuthorization" ? td.types.ReceiveWithAuthorization : td.types.TransferWithAuthorization;
  return wallet.signTypedData(td.domain, { [td.primaryType]: [...fields] }, td.message);
}
async function signedFor(context: PaymentContext) {
  const input = { chain: context.grant.price_chain, from: context.typedData.message.from, to: context.typedData.message.to,
    value: context.amount, validAfter: 0, validBefore: Number(context.typedData.message.validBefore), grantHash: context.grantHash, nowMs: Date.now() };
  const callback = async (typedData: PaymentTypedData) => {
    const checked = checkPaymentSignRequest({ context, typedData });
    if (!checked.ok) throw new Error(checked.reason);
    return sign(checked.typedData);
  };
  const result = context.entryPoint === entryPoints[0]
    ? await signReceiveAuthorization(input, callback) : await signTransferAuthorization(input, callback);
  if (!result.ok) throw new Error(result.reason);
  return result.signed;
}
function requestFor(signed: Awaited<ReturnType<typeof signedFor>>) {
  const out = signed.typedData.primaryType === "ReceiveWithAuthorization"
    ? buildReceiveWithAuthorizationCalldata(signed as Parameters<typeof buildReceiveWithAuthorizationCalldata>[0])
    : buildTransferWithAuthorizationCalldata(signed as Parameters<typeof buildTransferWithAuthorizationCalldata>[0]);
  if (!out.ok) throw new Error(out.reason);
  return out.request;
}
beforeAll(async () => {
  const hirer = party(1), provider = party(2);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
  const price = { chain: CHAIN, asset: x402SessionAssetCaip19(CHAIN)!, payerAccount: x402SessionAccountCaip10(CHAIN, payer.address)!,
    payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!, minAmount: MIN, maxAmount: MAX };
  const built = await buildHire({ hirer: { did: hirer.did, signingPublicKeyBase64: hirer.signingPublicKeyBase64, sign: hirer.sign },
    provider: verifiedProviderFor(provider, providerEnc, price), service: { ref: "voidly.research.censorship-summary" },
    task: { brief: BRIEF }, price, ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS }, nowMs: NOW, entropy: seededEntropy(424242) });
  if (!built.ok) throw new Error(built.reason);
  grant = built.wire.grant;
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("complete immutable grant admission", () => {
  it("snapshots every grant field, freezes nested data, and rejects copied contexts", async () => {
    const caller = { ...grant };
    const context = await makeContext(entryPoints[0], undefined, caller);
    expect(context.grant).toEqual(grant);
    expect(Object.keys(context.grant).sort()).toEqual(Object.keys(grant).sort());
    expect(context.amount).toBe(MIN);
    for (const object of [context, context.grant, context.typedData, context.typedData.domain, context.typedData.message, context.typedData.types]) expect(Object.isFrozen(object)).toBe(true);
    caller.price_max_amount = "1";
    caller.expires_at = new Date(NOW - 1).toISOString();
    expect(checkPaymentSignRequest({ context, typedData: context.typedData }).ok).toBe(true);
    for (const copy of [{ ...context }, structuredClone(context), { ...context, amount: MAX }, context.grant]) {
      expect(checkPaymentSignRequest({ context: copy as PaymentContext, typedData: context.typedData })).toEqual({ ok: false, reason: "payment_context_required" });
      expect(verifyPaymentSignature({ context: copy as PaymentContext, signature: "bad" }).ok).toBe(false);
      expect(checkPaymentSubmitRequest({ context: copy as PaymentContext, signature: "bad", request: {} }).ok).toBe(false);
    }
  });
  it.each([
    { price_max_amount: "1" }, { issued_at: new Date(NOW + 120000).toISOString(), expires_at: new Date(NOW + 300000).toISOString() },
    { expires_at: new Date(NOW + 48 * 3600000).toISOString() }, { expires_at: new Date(NOW + 30000).toISOString() },
    { provider_signing_pubkey_base64: "bad" }, { offer_hash: "bad" }, { unknown: null }, { issued_at: "bad" },
    { price_asset: `${CHAIN}/erc20:0x${"12".repeat(20)}` }, { price_asset: `eip155:84532/erc20:0x${"12".repeat(20)}` },
    { price_payer_account: `${CHAIN}:${payer.address}` },
  ])("refuses complete-grant defect %j", async mutation => {
    expect((await createPaymentContext({ grant: { ...grant, ...mutation }, entryPoint: entryPoints[0] })).ok).toBe(false);
  });
  it.each(["0", "49999", "5000001", "01", "1e5", "-1", "", "1.5"])("refuses unapproved amount %s", async amount => {
    expect((await createPaymentContext({ grant, entryPoint: entryPoints[0], amount })).ok).toBe(false);
  });
  it("checks the exact uint256 boundary before any callback", async () => {
    const max = ((1n << 256n) - 1n).toString(), overflow = (1n << 256n).toString();
    const wide = { ...grant, price_max_amount: overflow };
    expect((await createPaymentContext({ grant: wide, entryPoint: entryPoints[0], amount: max })).ok).toBe(true);
    expect(await createPaymentContext({ grant: wide, entryPoint: entryPoints[0], amount: overflow })).toEqual({ ok: false, reason: "payment_amount_invalid" });
  });
  it("refuses asynchronous creation that crosses expiry", async () => {
    const pending = createPaymentContext({ grant, entryPoint: entryPoints[0] });
    vi.setSystemTime(new Date(grant.expires_at));
    expect(await pending).toEqual({ ok: false, reason: "grant_expired" });
  });
  it("never invokes grant or option accessors", async () => {
    const getter = vi.fn(() => grant.expires_at);
    const evil = { ...grant };
    Object.defineProperty(evil, "expires_at", { enumerable: true, get: getter });
    expect((await createPaymentContext({ grant: evil, entryPoint: entryPoints[0] })).ok).toBe(false);
    const options = { entryPoint: entryPoints[0], get grant() { getter(); return grant; } };
    expect((await createPaymentContext(options)).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    for (const value of [Object.assign({ ...grant }, { [Symbol()]: "x" }), Object.defineProperty({ ...grant }, "extra", { value: "x" }), new Proxy({}, { ownKeys() { throw new Error("trap"); } })]) {
      expect((await createPaymentContext({ grant: value, entryPoint: entryPoints[0] })).ok).toBe(false);
    }
  });
});

describe.each(entryPoints)("%s exact signing and submission", entryPoint => {
  it.each([MIN, MAX])("uses real low-level signer and calldata callbacks at amount %s", async amount => {
    const context = await makeContext(entryPoint, amount);
    const signed = await signedFor(context);
    const original = `0x${signed.signature.slice(2).toUpperCase()}`;
    expect(verifyPaymentSignature({ context, signature: original })).toEqual({ ok: true, signature: original });
    const request = requestFor(signed);
    const forward = vi.fn((_request: unknown) => `0x${"33".repeat(32)}`);
    const broadcast = (candidate: unknown) => {
      const checked = checkPaymentSubmitRequest({ context, signature: original, request: candidate });
      if (!checked.ok) throw new Error(checked.reason);
      expect(Object.isFrozen(checked.request)).toBe(true);
      return forward(checked.request);
    };
    if (signed.typedData.primaryType === "TransferWithAuthorization") {
      const submitted = await createSelfSubmitter({ broadcast }).submit(signed as Parameters<typeof buildTransferWithAuthorizationCalldata>[0]);
      expect(submitted.ok).toBe(true);
    } else broadcast(request);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toEqual(request);
    forward.mockClear();
    expect(() => broadcast({ ...request, data: "0x" })).toThrow();
    expect(forward).not.toHaveBeenCalled();
  });
  it("runs the actual high-level minimum builder callback and rejects a maximum context", async () => {
    const context = await makeContext(entryPoint);
    const maxContext = await makeContext(entryPoint, MAX);
    const callback = vi.fn(async (typedData: PaymentTypedData) => {
      expect(checkPaymentSignRequest({ context: maxContext, typedData }).ok).toBe(false);
      const checked = checkPaymentSignRequest({ context, typedData });
      if (!checked.ok) throw new Error(checked.reason);
      return sign(checked.typedData);
    });
    const args = { grant, grantHash: context.grantHash, nowMs: NOW, sign: callback };
    const out = entryPoint === entryPoints[0] ? await buildReceivePaymentAuthorization(args) : await buildTransferPaymentAuthorization(args);
    expect(out.ok).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].message.value).toBe(MIN);
  });
  it("accepts only exact typed data with optional standard domain types", async () => {
    const context = await makeContext(entryPoint);
    const copy = structuredClone(context.typedData) as any;
    delete copy.types.EIP712Domain;
    const admitted = checkPaymentSignRequest({ context, typedData: copy });
    expect(admitted).toEqual({ ok: true, typedData: context.typedData });
    copy.message.value = MAX;
    expect(admitted.ok && admitted.typedData.message.value).toBe(MIN);
    const mutations = [
      (x: any) => x.domain.name = "Wrong", (x: any) => x.domain.chainId++, (x: any) => x.domain.version = "1",
      (x: any) => x.domain.verifyingContract = stranger.address, (x: any) => x.message.from = stranger.address,
      (x: any) => x.message.to = stranger.address, (x: any) => x.message.value = MAX, (x: any) => x.message.nonce = `0x${"ff".repeat(32)}`,
      (x: any) => x.message.validAfter = "1", (x: any) => x.message.validBefore = "9999999999", (x: any) => x.extra = true,
      (x: any) => x.types.EIP712Domain = [], (x: any) => x.types[x.primaryType].reverse(),
      (x: any) => x.types[x.primaryType][0].type = "bytes32", (x: any) => x.primaryType = "Wrong",
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(context.typedData); mutate(changed);
      expect(checkPaymentSignRequest({ context, typedData: changed }).ok).toBe(false);
    }
  });
  it("recovers the payer and rejects wrong signer/domain/lane/nonce and malformed signatures", async () => {
    const context = await makeContext(entryPoint);
    const good = await sign(context.typedData);
    expect(verifyPaymentSignature({ context, signature: await sign(context.typedData, stranger) }).ok).toBe(false);
    const other = await makeContext(entryPoint === entryPoints[0] ? entryPoints[1] : entryPoints[0]);
    expect(verifyPaymentSignature({ context, signature: await sign(other.typedData) }).ok).toBe(false);
    for (const mutate of [(x: any) => x.domain.chainId++, (x: any) => x.domain.name = "Wrong", (x: any) => x.message.nonce = `0x${"ff".repeat(32)}`]) {
      const altered = structuredClone(context.typedData); mutate(altered);
      expect(verifyPaymentSignature({ context, signature: await sign(altered) }).ok).toBe(false);
    }
    const order = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
    const highS = `${good.slice(0, 66)}${(order - BigInt(`0x${good.slice(66, 130)}`)).toString(16).padStart(64, "0")}${good.endsWith("1b") ? "1c" : "1b"}`;
    for (const bad of [good.replace("0x", "0X"), good.slice(0, -2), `${good.slice(0, -2)}00`, `${good.slice(0, -2)}01`, `${good.slice(0, -2)}1d`, `0x${"0".repeat(64)}${good.slice(66)}`, `${good.slice(0, 66)}${"0".repeat(64)}1b`, `0x${"f".repeat(128)}1b`, highS]) {
      expect(verifyPaymentSignature({ context, signature: bad }).ok).toBe(false);
    }
  });
  it("preserves Bankr request spellings, drops extras, and refuses every calldata word change", async () => {
    const context = await makeContext(entryPoint);
    const signed = await signedFor(context), request = requestFor(signed);
    const data = `0x${request.data.slice(2).toUpperCase()}`;
    const ignored = vi.fn();
    for (const chainId of [request.chainId, String(request.chainId), `0x${request.chainId.toString(16)}`]) for (const value of [undefined, 0, "0", "0x", "0x0"]) {
      const raw = { ...request, to: request.to.toUpperCase(), chainId, value, data, get gas() { ignored(); return "bad"; } };
      expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: raw })).toEqual({ ok: true, request: { ...request, data } });
    }
    expect(ignored).not.toHaveBeenCalled();
    for (const changed of [{ ...request, to: stranger.address }, { ...request, chainId: 1 }, { ...request, value: "0x1" }, { ...request, data: `${request.data}00` }]) {
      expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: changed }).ok).toBe(false);
    }
    for (const position of [2, ...Array.from({ length: 9 }, (_, i) => 10 + i * 64 + 63)]) {
      const corrupted = request.data.slice(0, position) + (request.data[position] === "0" ? "1" : "0") + request.data.slice(position + 1);
      expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: { ...request, data: corrupted } }).ok).toBe(false);
    }
    const otherContext = await makeContext(entryPoint, MAX), otherSigned = await signedFor(otherContext);
    expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: requestFor(otherSigned) }).ok).toBe(false);
    const substituted = { ...signed, r: otherSigned.r, s: otherSigned.s, v: otherSigned.v };
    expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: requestFor(substituted) }).ok).toBe(false);
  });
  it("refuses each live gate at the floored fractional deadline and after a delayed signer", async () => {
    const fractional = { ...grant, expires_at: new Date(NOW + GRANT_TTL_MS + 999).toISOString() };
    const context = await makeContext(entryPoint, undefined, fractional);
    const signed = await signedFor(context), request = requestFor(signed);
    const deadline = Number(context.typedData.message.validBefore) * 1000;
    vi.setSystemTime(deadline - 1);
    expect(checkPaymentSignRequest({ context, typedData: context.typedData }).ok).toBe(true);
    expect(verifyPaymentSignature({ context, signature: signed.signature }).ok).toBe(true);
    expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request }).ok).toBe(true);
    for (const now of [deadline, deadline + 500, deadline + 1000]) {
      vi.setSystemTime(now);
      expect(checkPaymentSignRequest({ context, typedData: context.typedData })).toEqual({ ok: false, reason: "grant_expired" });
      expect(verifyPaymentSignature({ context, signature: signed.signature })).toEqual({ ok: false, reason: "grant_expired" });
      expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request })).toEqual({ ok: false, reason: "grant_expired" });
    }
    vi.setSystemTime(deadline - 1);
    const delayed = async (typedData: PaymentTypedData) => {
      expect(checkPaymentSignRequest({ context, typedData }).ok).toBe(true);
      const signature = await sign(typedData);
      vi.setSystemTime(deadline);
      expect(verifyPaymentSignature({ context, signature })).toEqual({ ok: false, reason: "grant_expired" });
      throw new Error("expired wallet response");
    };
    const args = { grant: fractional, grantHash: context.grantHash, nowMs: deadline - 1, sign: delayed };
    const result = entryPoint === entryPoints[0] ? await buildReceivePaymentAuthorization(args) : await buildTransferPaymentAuthorization(args);
    expect(result.ok).toBe(false);
  });
});

it("refuses hostile descriptor trees without invoking getters", async () => {
  const context = await makeContext(), signed = await signedFor(context), request = requestFor(signed);
  const getter = vi.fn();
  const td = structuredClone(context.typedData);
  Object.defineProperty(td.message, "to", { enumerable: true, get: getter });
  expect(checkPaymentSignRequest({ context, typedData: td }).ok).toBe(false);
  expect(checkPaymentSignRequest({ context, get typedData() { getter(); return context.typedData; } }).ok).toBe(false);
  expect(verifyPaymentSignature({ context, get signature() { getter(); return signed.signature; } }).ok).toBe(false);
  expect(checkPaymentSubmitRequest({ context, signature: signed.signature, request: { ...request, get data() { getter(); return request.data; } } }).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  for (const mutate of [
    (x: any) => delete x.types.EIP712Domain[0], (x: any) => x.types.EIP712Domain.extra = "bad",
    (x: any) => x.message.to = "x".repeat(4097), (x: any) => x.message.to = x,
    (x: any) => x.types.EIP712Domain = Array(33).fill({ name: "x", type: "string" }),
    (x: any) => x[Symbol()] = "bad", (x: any) => Object.defineProperty(x, "hidden", { value: "bad" }),
  ]) {
    const value = structuredClone(context.typedData); mutate(value);
    expect(checkPaymentSignRequest({ context, typedData: value }).ok).toBe(false);
  }
  expect(checkPaymentSignRequest({ context, typedData: new Proxy({}, { getPrototypeOf() { throw new Error(); } }) }).ok).toBe(false);
});
