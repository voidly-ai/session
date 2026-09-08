import { verifyTypedData } from "ethers/hash";
import { compareDecimalStrings, envelopeHash, isPositiveDecimalString, timestampMs, validateGrant, x402SessionAssetCaip19 } from "./protocol";
import type { TaskGrantEnvelope } from "./protocol";
import { buildReceiveAuthorizationTypedData, buildTransferAuthorizationTypedData } from "./payment";
import type { ReceiveAuthorizationTypedData, TransferAuthorizationTypedData } from "./payment";
import { buildReceiveWithAuthorizationCalldata, buildTransferWithAuthorizationCalldata } from "./submission";
import type { TransactionRequest } from "./submission";

export type PaymentEntryPoint = "receive_with_authorization" | "transfer_with_authorization";
export type PaymentTypedData = ReceiveAuthorizationTypedData | TransferAuthorizationTypedData;
declare const paymentContextBrand: unique symbol;
export interface PaymentContext {
  readonly [paymentContextBrand]: true;
  readonly grant: Readonly<TaskGrantEnvelope>;
  readonly grantHash: string;
  readonly entryPoint: PaymentEntryPoint;
  readonly amount: string;
  readonly typedData: PaymentTypedData;
}
export type PaymentContextRefusal = { readonly ok: false; readonly reason: string };
const admitted = new WeakSet<object>();
const refuse = (reason: string): PaymentContextRefusal => ({ ok: false, reason });
const UINT256_MAX = (1n << 256n) - 1n;

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error();
  const out: Record<string, unknown> = Object.create(null);
  const names = Reflect.ownKeys(value);
  if (names.length > 32) throw new Error();
  for (const key of names) {
    if (typeof key !== "string" || (keys && !keys.includes(key))) throw new Error();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) throw new Error();
    out[key] = d.value;
  }
  return out;
}

function snapshot(value: unknown, depth = 0, budget = { left: 128 }): unknown {
  if (++depth > 8 || --budget.left < 0) throw new Error();
  if (typeof value === "string") {
    if (value.length > 4096) throw new Error();
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
    const length = descriptors.length?.value;
    if (!Number.isInteger(length) || length > 32 || Reflect.ownKeys(value).length !== length + 1) throw new Error();
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const d = descriptors[String(i)];
      if (!d || !d.enumerable || !("value" in d)) throw new Error();
      out.push(snapshot(d.value, depth, budget));
    }
    return Object.freeze(out);
  }
  const out = record(value);
  for (const key of Object.keys(out)) out[key] = snapshot(out[key], depth, budget);
  return Object.freeze(out);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.prototype.hasOwnProperty.call(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function live(raw: unknown): PaymentContext | PaymentContextRefusal {
  if (!raw || typeof raw !== "object" || !admitted.has(raw)) return refuse("payment_context_required");
  const context = raw as PaymentContext;
  const now = Date.now();
  const checked = validateGrant(context.grant, now);
  if (!checked.ok) return refuse(checked.reason);
  if (Math.floor(now / 1000) >= Number(context.typedData.message.validBefore)) return refuse("grant_expired");
  return context;
}

export async function createPaymentContext(input: {
  readonly grant: unknown; readonly entryPoint: PaymentEntryPoint; readonly amount?: string;
}): Promise<{ readonly ok: true; readonly context: PaymentContext } | PaymentContextRefusal> {
  try {
    const options = record(input, ["grant", "entryPoint", "amount"]);
    const grant = record(options.grant);
    if (!Object.values(grant).every(v => typeof v === "string" && v.length <= 4096)) return refuse("grant_not_plain_data");
    const checked = validateGrant(grant, Date.now());
    if (!checked.ok) return refuse(checked.reason);
    const g = Object.freeze(grant) as unknown as TaskGrantEnvelope;
    const entryPoint = options.entryPoint;
    if (entryPoint !== "receive_with_authorization" && entryPoint !== "transfer_with_authorization") return refuse("payment_entry_point_invalid");
    if (g.price_asset !== x402SessionAssetCaip19(g.price_chain)) return refuse("grant_asset_not_supported");
    const account = new RegExp(`^${g.price_chain}:0x[0-9a-f]{40}$`);
    if (!account.test(g.price_payer_account) || !account.test(g.price_payee_account)) return refuse("grant_account_not_canonical");
    const amount = options.amount === undefined ? g.price_min_amount : options.amount;
    if (typeof amount !== "string" || !isPositiveDecimalString(amount) || BigInt(amount) > UINT256_MAX) return refuse("payment_amount_invalid");
    if (compareDecimalStrings(amount, g.price_min_amount)! < 0 || compareDecimalStrings(amount, g.price_max_amount)! > 0) return refuse("payment_amount_outside_band");
    const validBefore = Math.floor(timestampMs(g.expires_at)! / 1000);
    if (Math.floor(Date.now() / 1000) >= validBefore) return refuse("grant_expired");
    const grantHash = await envelopeHash(g);
    const build = entryPoint === "receive_with_authorization" ? buildReceiveAuthorizationTypedData : buildTransferAuthorizationTypedData;
    const result = await build({ chain: g.price_chain, from: g.price_payer_account, to: g.price_payee_account, value: amount, validAfter: 0, validBefore, grantHash });
    if (!result.ok) return refuse(result.reason);
    const typedData = snapshot(result.typedData) as unknown as PaymentTypedData;
    const context = Object.freeze({ grant: g, grantHash, entryPoint, amount, typedData }) as PaymentContext;
    admitted.add(context);
    const current = live(context);
    return "ok" in current ? current : { ok: true, context };
  } catch { return refuse("payment_context_invalid_input"); }
}

export function checkPaymentSignRequest(input: { readonly context: PaymentContext; readonly typedData: unknown }):
  { readonly ok: true; readonly typedData: PaymentTypedData } | PaymentContextRefusal {
  try {
    const options = record(input, ["context", "typedData"]);
    const context = live(options.context);
    if ("ok" in context) return context;
    const candidate = snapshot(options.typedData);
    const expected = context.typedData;
    const fields = expected.primaryType === "ReceiveWithAuthorization" ? expected.types.ReceiveWithAuthorization : expected.types.TransferWithAuthorization;
    const applicationOnly = { ...expected, types: { [expected.primaryType]: fields } };
    if (!same(candidate, expected) && !same(candidate, applicationOnly)) return refuse("payment_sign_request_mismatch");
    const current = live(context);
    return "ok" in current ? current : { ok: true, typedData: expected };
  } catch { return refuse("payment_sign_request_invalid_input"); }
}

export function verifyPaymentSignature(input: { readonly context: PaymentContext; readonly signature: unknown }):
  { readonly ok: true; readonly signature: string } | PaymentContextRefusal {
  try {
    const options = record(input, ["context", "signature"]);
    const context = live(options.context);
    if ("ok" in context) return context;
    const signature = options.signature;
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return refuse("payment_signature_invalid");
    const v = Number.parseInt(signature.slice(130), 16);
    if ((v !== 27 && v !== 28) || /^0{64}$/.test(signature.slice(2, 66)) || /^0{64}$/.test(signature.slice(66, 130))) return refuse("payment_signature_invalid");
    const td = context.typedData;
    const fields = td.primaryType === "ReceiveWithAuthorization" ? td.types.ReceiveWithAuthorization : td.types.TransferWithAuthorization;
    const payer = verifyTypedData(td.domain, { [td.primaryType]: fields.map(field => ({ ...field })) }, td.message, signature);
    if (payer.toLowerCase() !== td.message.from) return refuse("payment_signature_payer_mismatch");
    const current = live(context);
    return "ok" in current ? current : { ok: true, signature };
  } catch { return refuse("payment_signature_invalid"); }
}

export function checkPaymentSubmitRequest(input: { readonly context: PaymentContext; readonly signature: unknown; readonly request: unknown }):
  { readonly ok: true; readonly request: TransactionRequest } | PaymentContextRefusal {
  try {
    const options = record(input, ["context", "signature", "request"]);
    const context = live(options.context);
    if ("ok" in context) return context;
    const verified = verifyPaymentSignature({ context, signature: options.signature });
    if (!verified.ok) return verified;
    const raw = options.request;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("payment_submit_request_invalid_input");
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return refuse("payment_submit_request_invalid_input");
    const request: Record<string, unknown> = Object.create(null);
    for (const key of ["to", "chainId", "value", "data"]) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (d && (!d.enumerable || !("value" in d))) return refuse("payment_submit_request_invalid_input");
      request[key] = d?.value;
    }
    const signature = verified.signature;
    const fields = { signature, r: signature.slice(0, 66).toLowerCase(), s: `0x${signature.slice(66, 130).toLowerCase()}`, v: Number.parseInt(signature.slice(130), 16), chain: context.grant.price_chain, grantHash: context.grantHash };
    const td = context.typedData;
    const built = td.primaryType === "ReceiveWithAuthorization"
      ? buildReceiveWithAuthorizationCalldata({ ...fields, typedData: td })
      : buildTransferWithAuthorizationCalldata({ ...fields, typedData: td });
    if (!built.ok) return refuse("payment_submit_request_invalid_input");
    const expected = built.request;
    const chain = request.chainId;
    const chainMatches = chain === expected.chainId || chain === String(expected.chainId) || (typeof chain === "string" && /^0x[0-9a-f]+$/i.test(chain) && chain.toLowerCase() === `0x${expected.chainId.toString(16)}`);
    if (!chainMatches || typeof request.to !== "string" || request.to.toLowerCase() !== expected.to || ![undefined, 0, "0", "0x0", "0x"].includes(request.value as never)) return refuse("payment_submit_request_mismatch");
    if (typeof request.data !== "string" || !/^0x[0-9a-fA-F]{584}$/.test(request.data) || request.data.toLowerCase() !== expected.data) return refuse("payment_submit_request_mismatch");
    const current = live(context);
    return "ok" in current ? current : { ok: true, request: Object.freeze({ to: expected.to, chainId: expected.chainId, value: "0x0", data: request.data }) };
  } catch { return refuse("payment_submit_request_invalid_input"); }
}
