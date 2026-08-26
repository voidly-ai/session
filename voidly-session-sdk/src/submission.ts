
import { X402_SESSION_USDC_BY_CHAIN } from "./protocol";
import type { FacilitatorPreflightResult, FetchLike } from "./protocol";
import {
  buildReceiveAuthorizationTypedData,
  buildTransferAuthorizationTypedData,
  EVM_USDC_EIP712_DOMAINS,
} from "./payment";
import type {
  ReceiveAuthorizationTypedData,
  TransferAuthorizationRefusal,
  TransferAuthorizationTypedData,
} from "./payment";

const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const ZERO_TX_HASH = `0x${"0".repeat(64)}`;
const HEX32_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const UINT256_MAX = (BigInt(1) << BigInt(256)) - BigInt(1);

export type SignTypedData = (
  typedData: TransferAuthorizationTypedData,
) => Promise<string> | string;

export interface SignedTransferAuthorization {
  readonly typedData: TransferAuthorizationTypedData;
  readonly signature: string;
  readonly v: number;
  readonly r: string;
  readonly s: string;
  readonly chain: string;
  readonly grantHash: string;
}

export type SignReceiveTypedData = (
  typedData: ReceiveAuthorizationTypedData,
) => Promise<string> | string;

export interface SignedReceiveAuthorization {
  readonly typedData: ReceiveAuthorizationTypedData;
  readonly signature: string;
  readonly v: number;
  readonly r: string;
  readonly s: string;
  readonly chain: string;
  readonly grantHash: string;
}

export type SignRefusal =
  | TransferAuthorizationRefusal
  | "authorization_expired"
  | "authorization_not_yet_valid"
  | "invalid_now_ms"
  | "signer_threw"
  | "signature_not_65_bytes"
  | "signature_recovery_id_invalid";

export type SignTransferAuthorizationResult =
  | { ok: true; signed: SignedTransferAuthorization }
  | { ok: false; reason: SignRefusal; detail: string };

export type SignReceiveAuthorizationResult =
  | { ok: true; signed: SignedReceiveAuthorization }
  | { ok: false; reason: SignRefusal; detail: string };

export interface SignTransferAuthorizationInput {
  chain: string;
  from: string;
  to: string;
  value: string;
  /** UNIX SECONDS. */
  validAfter: number;
  /** UNIX SECONDS. */
  validBefore: number;
  grantHash: string;
  /**
   * MILLISECONDS, and REQUIRED — there is no `Date.now()` default.
   *
   * A clock this function reaches for itself is a clock no test can move, and
   * the two checks it feeds — expired and not-yet-valid — are exactly the ones
   * a test has to be able to move it for.
   */
  nowMs: number;
}

export type SignReceiveAuthorizationInput = SignTransferAuthorizationInput;

function checkSigningWindow(input: {
  readonly nowMs: number;
  readonly validAfter: number;
  readonly validBefore: number;
}): { ok: false; reason: SignRefusal; detail: string } | null {
  if (typeof input.nowMs !== "number" || !Number.isFinite(input.nowMs) || input.nowMs < 0) {
    return {
      ok: false,
      reason: "invalid_now_ms",
      detail: "nowMs must be a finite, non-negative millisecond timestamp.",
    };
  }
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (input.validBefore <= nowSeconds) {
    return {
      ok: false,
      reason: "authorization_expired",
      detail:
        `validBefore is ${input.validBefore} and now is ${nowSeconds} (UNIX seconds). ` +
        "EIP-3009 requires block.timestamp < validBefore, so this authorization would " +
        "revert with 'FiatTokenV2: authorization is expired' — costing gas, emitting no " +
        "AuthorizationUsed log, and leaving the provider a transaction hash that can " +
        "never carry the settlement binding.",
    };
  }
  if (input.validAfter > nowSeconds) {
    return {
      ok: false,
      reason: "authorization_not_yet_valid",
      detail:
        `validAfter is ${input.validAfter} and now is ${nowSeconds} (UNIX seconds). ` +
        "EIP-3009 requires block.timestamp > validAfter. A future-dated authorization " +
        "has no use on this rail, because the submitter is handed the payload the " +
        "moment it is signed.",
    };
  }
  return null;
}

function splitSignature(
  raw: unknown,
):
  | { ok: true; signature: string; r: string; s: string; v: number }
  | { ok: false; reason: SignRefusal; detail: string } {
  if (typeof raw !== "string" || !SIGNATURE_RE.test(raw)) {
    return {
      ok: false,
      reason: "signature_not_65_bytes",
      detail:
        "an EIP-712 signature is exactly 65 bytes spelled `0x` + 130 hex (r ‖ s ‖ v). " +
        "A shorter value is usually a wallet that returned a digest; a longer one is " +
        "usually two concatenated signatures.",
    };
  }
  const signature = `0x${raw.slice(2).toLowerCase()}`;
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    return {
      ok: false,
      reason: "signature_recovery_id_invalid",
      detail:
        `the recovery id is ${v}; USDC passes it to ecrecover, which answers the zero ` +
        "address for anything but 27 or 28. A wallet returning 0/1 has not been " +
        "normalised here, because adding 27 would silently repair a wallet that may be " +
        "wrong about something this module cannot see.",
    };
  }
  return { ok: true, signature, r, s, v };
}

export async function signTransferAuthorization(
  input: SignTransferAuthorizationInput,
  signer: SignTypedData,
): Promise<SignTransferAuthorizationResult> {
  const built = await buildTransferAuthorizationTypedData(input);
  if (!built.ok) {
    return {
      ok: false,
      reason: built.reason,
      detail: `the authorization was refused before it was signed: ${built.reason}`,
    };
  }

  const window = checkSigningWindow(input);
  if (window !== null) return window;

  let raw: string;
  try {
    raw = await signer(built.typedData);
  } catch (err) {
    return {
      ok: false,
      reason: "signer_threw",
      detail: `the injected signer threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const split = splitSignature(raw);
  if (!split.ok) return split;
  const { signature, r, s, v } = split;

  return {
    ok: true,
    signed: {
      typedData: built.typedData,
      signature,
      v,
      r,
      s,
      chain: input.chain,
      grantHash: input.grantHash,
    },
  };
}

export async function signReceiveAuthorization(
  input: SignReceiveAuthorizationInput,
  signer: SignReceiveTypedData,
): Promise<SignReceiveAuthorizationResult> {
  const built = await buildReceiveAuthorizationTypedData(input);
  if (!built.ok) {
    return {
      ok: false,
      reason: built.reason,
      detail: `the authorization was refused before it was signed: ${built.reason}`,
    };
  }

  const window = checkSigningWindow(input);
  if (window !== null) return window;

  let raw: string;
  try {
    raw = await signer(built.typedData);
  } catch (err) {
    return {
      ok: false,
      reason: "signer_threw",
      detail: `the injected signer threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const split = splitSignature(raw);
  if (!split.ok) return split;
  const { signature, r, s, v } = split;

  return {
    ok: true,
    signed: {
      typedData: built.typedData,
      signature,
      v,
      r,
      s,
      chain: input.chain,
      grantHash: input.grantHash,
    },
  };
}

export type SubmitRefusal =
  | "facilitator_not_usable"
  | "chain_mismatch"
  | "facilitator_refused"
  | "facilitator_response_unreadable"
  | "unreachable"
  | "broadcast_failed";

export type SubmitResult =
  | { ok: true; transactionHash: string }
  | { ok: false; reason: SubmitRefusal; detail: string };

export interface PaymentSubmitter {
  readonly kind: "facilitator" | "self";
  submit(signed: SignedTransferAuthorization): Promise<SubmitResult>;
}

export interface X402PaymentPayload {
  readonly x402Version: number;
  readonly scheme: "exact";
  readonly network: string;
  readonly payload: {
    readonly signature: string;
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: string;
    };
  };
}

export function buildX402PaymentPayload(
  signed: SignedTransferAuthorization,
  matched: { readonly x402Version: number; readonly network: string },
): X402PaymentPayload {
  const m = signed.typedData.message;
  return Object.freeze({
    x402Version: matched.x402Version,
    scheme: "exact" as const,
    network: matched.network,
    payload: Object.freeze({
      signature: signed.signature,
      authorization: Object.freeze({
        from: m.from,
        to: m.to,
        value: m.value,
        validAfter: m.validAfter,
        validBefore: m.validBefore,
        nonce: m.nonce,
      }),
    }),
  });
}

export function buildX402PaymentRequirements(
  signed: SignedTransferAuthorization,
  matched: { readonly x402Version: number; readonly network: string },
): Record<string, unknown> {
  const m = signed.typedData.message;
  const domain = EVM_USDC_EIP712_DOMAINS.get(signed.chain);
  const asset = X402_SESSION_USDC_BY_CHAIN.get(signed.chain) ?? null;
  const amountKey = matched.x402Version >= 2 ? "amount" : "maxAmountRequired";
  return Object.freeze({
    scheme: "exact",
    network: matched.network,
    [amountKey]: m.value,
    payTo: m.to,
    asset,
    maxTimeoutSeconds: Math.max(1, Number(m.validBefore) - Number(m.validAfter)),
    extra: Object.freeze({
      name: domain?.name ?? null,
      version: domain?.version ?? null,
      assetTransferMethod: "eip3009",
    }),
  });
}

export interface FacilitatorSubmitterInput {
  readonly preflight: FacilitatorPreflightResult;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
  readonly allowUnadvertisedTransferMethod?: boolean;
}

export function settleUrlFor(baseUrl: string): string | null {
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/supported$/, "");
  parsed.pathname = `${path}/settle`;
  return parsed.toString();
}

export function preflightAdmitsPayment(
  preflight: FacilitatorPreflightResult,
  allowUnadvertisedTransferMethod: boolean,
): boolean {
  if (preflight.verdict === "usable") return true;
  if (preflight.verdict === "unusable") return false;
  return allowUnadvertisedTransferMethod && preflight.reason === "transfer_method_not_advertised";
}

export function createFacilitatorSubmitter(input: FacilitatorSubmitterInput): PaymentSubmitter {
  const preflight = input.preflight;
  const allow = input.allowUnadvertisedTransferMethod === true;
  return Object.freeze({
    kind: "facilitator" as const,
    async submit(signed: SignedTransferAuthorization): Promise<SubmitResult> {
      if (!preflightAdmitsPayment(preflight, allow)) {
        return {
          ok: false,
          reason: "facilitator_not_usable",
          detail:
            `preflight answered ${preflight.verdict}/${preflight.reason} — ${preflight.detail}`,
        };
      }
      if (signed.chain !== preflight.chain) {
        return {
          ok: false,
          reason: "chain_mismatch",
          detail:
            `the authorization is for ${signed.chain} and this facilitator was ` +
            `preflighted for ${preflight.chain}. A preflight of one chain says nothing ` +
            "about another.",
        };
      }
      const matched = preflight.matched;
      if (matched === null) {
        return {
          ok: false,
          reason: "facilitator_not_usable",
          detail:
            "the preflight matched no kind, so there is no advertised network spelling " +
            "to address a /settle body with.",
        };
      }
      const url = settleUrlFor(preflight.url);
      if (url === null) {
        return {
          ok: false,
          reason: "facilitator_not_usable",
          detail: `could not derive a /settle URL from ${preflight.url}`,
        };
      }

      const body = {
        x402Version: matched.x402Version,
        paymentPayload: buildX402PaymentPayload(signed, matched),
        paymentRequirements: buildX402PaymentRequirements(signed, matched),
      };

      let res: Response;
      try {
        res = await input.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "unreachable",
          detail:
            "the /settle call did not complete. THIS IS NOT A REFUSAL: the request may " +
            "have arrived and settled. Do not re-sign a fresh authorization — the same " +
            "one is idempotent on chain, because USDC marks (authorizer, nonce) consumed " +
            `forever. (${err instanceof Error ? err.message : String(err)})`,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        return {
          ok: false,
          reason: "facilitator_response_unreadable",
          detail: `/settle answered ${res.status} with a body that is not JSON.`,
        };
      }

      const declared = readDeclaredFailure(parsed);
      const hash = readTransactionHash(parsed);
      const httpOk = res.status >= 200 && res.status < 300;

      if (!httpOk) {
        return {
          ok: false,
          reason: "facilitator_refused",
          detail:
            `/settle answered ${res.status}` +
            (declared.reason === null ? "" : ` (${declared.reason})`) +
            (hash === null
              ? "."
              : ` and named ${hash} anyway. A hash beside a non-2xx answer is echoed ` +
                "input or a failed attempt, not a settlement."),
        };
      }
      if (declared.failed) {
        return {
          ok: false,
          reason: "facilitator_refused",
          detail:
            `/settle answered ${res.status} with success:false` +
            (declared.reason === null ? "" : ` (${declared.reason})`) +
            (hash === null
              ? "."
              : ` and named ${hash} anyway. The facilitator's own answer says it did ` +
                "not settle; presenting that hash would buy a redemption that can never resolve."),
        };
      }
      if (hash === null) {
        return {
          ok: false,
          reason: "facilitator_response_unreadable",
          detail:
            `/settle answered ${res.status} and no readable transaction hash was in it. ` +
            "A facilitator that reports success without a hash has told us nothing the " +
            "adapter can verify, which is the same as telling us nothing.",
        };
      }
      return { ok: true, transactionHash: hash };
    },
  });
}

function readTransactionHash(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const o = body as Record<string, unknown>;
  for (const key of ["transaction", "transactionHash", "transaction_hash", "txHash", "tx_hash", "hash"]) {
    const v = o[key];
    if (typeof v !== "string") continue;
    const lower = v.toLowerCase();
    if (lower === ZERO_TX_HASH) continue;
    if (TX_HASH_RE.test(lower)) return lower;
  }
  return null;
}

const FAILURE_REASON_KEYS = ["errorReason", "error_reason", "error", "reason", "message"];

function readDeclaredFailure(body: unknown): { failed: boolean; reason: string | null } {
  if (typeof body !== "object" || body === null) return { failed: false, reason: null };
  const o = body as Record<string, unknown>;
  let reason: string | null = null;
  for (const key of FAILURE_REASON_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) {
      reason = v.slice(0, 256);
      break;
    }
  }
  return { failed: o.success === false, reason };
}

export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";

export const RECEIVE_WITH_AUTHORIZATION_SELECTOR = "0xef55bec6";

export interface TransactionRequest {
  readonly to: string;
  readonly data: string;
  readonly value: "0x0";
  readonly chainId: number;
}

export type BroadcastTx = (request: TransactionRequest) => Promise<string> | string;

function word(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0");
}

function uintWord(decimal: string): string | null {
  if (!/^(?:0|[1-9][0-9]{0,77})$/.test(decimal)) return null;
  let n: bigint;
  try {
    n = BigInt(decimal);
  } catch {
    return null;
  }
  if (n < BigInt(0) || n > UINT256_MAX) return null;
  return word(n.toString(16));
}

export type CalldataRefusal =
  | "unsupported_chain"
  | "malformed_authorization"
  | "malformed_signature";

export type BuildCalldataResult =
  | { ok: true; request: TransactionRequest }
  | { ok: false; reason: CalldataRefusal; detail: string };

function encodeEip3009Call(
  selector: string,
  signed: {
    readonly typedData: { readonly message: TransferAuthorizationTypedData["message"] };
    readonly v: number;
    readonly r: string;
    readonly s: string;
    readonly chain: string;
  },
): BuildCalldataResult {
  const domain = EVM_USDC_EIP712_DOMAINS.get(signed.chain);
  const token = X402_SESSION_USDC_BY_CHAIN.get(signed.chain);
  if (!domain || !token || token !== domain.verifyingContract) {
    return {
      ok: false,
      reason: "unsupported_chain",
      detail: `no frozen USDC deployment for ${signed.chain}`,
    };
  }

  const m = signed.typedData.message;
  if (!ADDRESS_RE.test(m.from) || !ADDRESS_RE.test(m.to)) {
    return { ok: false, reason: "malformed_authorization", detail: "from/to are not addresses" };
  }
  if (!HEX32_RE.test(m.nonce)) {
    return { ok: false, reason: "malformed_authorization", detail: "nonce is not 32 bytes" };
  }
  const value = uintWord(m.value);
  const validAfter = uintWord(m.validAfter);
  const validBefore = uintWord(m.validBefore);
  if (value === null || validAfter === null || validBefore === null) {
    return {
      ok: false,
      reason: "malformed_authorization",
      detail: "value/validAfter/validBefore are not uint256 decimal strings",
    };
  }
  if (!HEX32_RE.test(signed.r) || !HEX32_RE.test(signed.s)) {
    return { ok: false, reason: "malformed_signature", detail: "r/s are not 32 bytes" };
  }
  if (signed.v !== 27 && signed.v !== 28) {
    return { ok: false, reason: "malformed_signature", detail: `recovery id ${signed.v}` };
  }

  const data =
    selector +
    word(m.from.slice(2)) +
    word(m.to.slice(2)) +
    value +
    validAfter +
    validBefore +
    word(m.nonce.slice(2)) +
    word(signed.v.toString(16)) +
    word(signed.r.slice(2)) +
    word(signed.s.slice(2));

  return {
    ok: true,
    request: Object.freeze({
      to: token,
      data,
      value: "0x0" as const,
      chainId: domain.chainId,
    }),
  };
}

export function buildTransferWithAuthorizationCalldata(
  signed: SignedTransferAuthorization,
): BuildCalldataResult {
  return encodeEip3009Call(TRANSFER_WITH_AUTHORIZATION_SELECTOR, signed);
}

export function buildReceiveWithAuthorizationCalldata(
  signed: SignedReceiveAuthorization,
): BuildCalldataResult {
  return encodeEip3009Call(RECEIVE_WITH_AUTHORIZATION_SELECTOR, signed);
}

export interface SelfSubmitterInput {
  readonly broadcast: BroadcastTx;
}

export function createSelfSubmitter(input: SelfSubmitterInput): PaymentSubmitter {
  return Object.freeze({
    kind: "self" as const,
    async submit(signed: SignedTransferAuthorization): Promise<SubmitResult> {
      const built = buildTransferWithAuthorizationCalldata(signed);
      if (!built.ok) {
        return { ok: false, reason: "broadcast_failed", detail: `${built.reason}: ${built.detail}` };
      }
      let hash: string;
      try {
        hash = await input.broadcast(built.request);
      } catch (err) {
        return {
          ok: false,
          reason: "broadcast_failed",
          detail:
            "the injected broadcaster threw. THIS IS NOT PROOF NOTHING HAPPENED — a " +
            "timeout after the transaction reached a mempool looks identical from here. " +
            `(${err instanceof Error ? err.message : String(err)})`,
        };
      }
      if (typeof hash !== "string" || !TX_HASH_RE.test(hash.toLowerCase())) {
        return {
          ok: false,
          reason: "broadcast_failed",
          detail:
            "the broadcaster returned something that is not a `0x` + 64 hex transaction " +
            "hash, so there is nothing to present as evidence.",
        };
      }
      return { ok: true, transactionHash: hash.toLowerCase() };
    },
  });
}

