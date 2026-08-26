
import { EVM_USDC_EIP712_DOMAINS } from "./payment";
import {
  MAX_CLOCK_SKEW_MS,
  MIN_GRANT_TTL_MS,
  SESSION_RAIL_BLOCK_TIME_MS,
  SESSION_RAIL_MIN_CONFIRMATIONS,
} from "./protocol";
import type { FetchLike } from "./protocol";
import {
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
} from "./submission";
import type { TransactionRequest } from "./submission";

export const READ_ONLY_RPC_METHODS: readonly string[] = Object.freeze([
  "eth_chainId",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_getBlockByNumber",
]);

export const FORBIDDEN_RPC_METHODS: readonly string[] = Object.freeze([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "eth_accounts",
  "personal_sign",
  "personal_unlockAccount",
]);

export type { FetchLike } from "./protocol";

const LOOPBACK_V4 = /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/;

function isLiteralLoopbackHost(hostname: string): boolean {
  if (hostname === "[::1]") return true;
  if (!LOOPBACK_V4.test(hostname)) return false;
  return hostname.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255);
}

export type RpcRefusal =
  | "rpc_method_not_read_only"
  | "rpc_url_not_https"
  | "rpc_unreachable"
  | "rpc_response_unreadable"
  | "rpc_error"
  | "rpc_result_malformed";

export type RpcResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reason: RpcRefusal; readonly detail: string };

export interface ReadOnlyEvmRpc {
  readonly url: string;
  request(method: string, params: readonly unknown[]): Promise<RpcResult>;
}

export interface ReadOnlyEvmRpcInput {
  readonly url: string;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}

export function createReadOnlyEvmRpc(input: ReadOnlyEvmRpcInput): ReadOnlyEvmRpc {
  if (typeof input !== "object" || input === null) {
    throw new Error("createReadOnlyEvmRpc: input must be an object");
  }
  if (typeof input.fetchImpl !== "function") {
    throw new Error("createReadOnlyEvmRpc: fetchImpl must be a function");
  }
  const url = input.url;
  let idCursor = 0;

  return Object.freeze({
    url,
    async request(method: string, params: readonly unknown[]): Promise<RpcResult> {
      if (typeof method !== "string" || !READ_ONLY_RPC_METHODS.includes(method)) {
        return {
          ok: false,
          reason: "rpc_method_not_read_only",
          detail:
            `${String(method)} is not one of ${READ_ONLY_RPC_METHODS.join(", ")}. ` +
            "This client reads chains; it does not write to them. A relayer that " +
            "needs to broadcast supplies its own `SendRelayTransaction`, which is " +
            "where the key lives.",
        };
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return { ok: false, reason: "rpc_url_not_https", detail: `not a URL: ${String(url)}` };
      }
      const admissible =
        parsedUrl.protocol === "https:" ||
        (parsedUrl.protocol === "http:" && isLiteralLoopbackHost(parsedUrl.hostname));
      if (!admissible) {
        return {
          ok: false,
          reason: "rpc_url_not_https",
          detail:
            "a chain observation read over cleartext can be rewritten in flight by " +
            "whoever is between, and this one decides whether to spend money. " +
            "http is admitted ONLY to a literal loopback address (127.0.0.0/8 or " +
            "[::1]), where there is nobody between; `localhost` is a name this " +
            "check cannot resolve, so spell the literal.",
        };
      }

      let res: Response;
      try {
        res = await input.fetchImpl(parsedUrl.toString(), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++idCursor, method, params }),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          reason: "rpc_unreachable",
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      let body: unknown;
      try {
        body = JSON.parse(await res.text());
      } catch {
        return {
          ok: false,
          reason: "rpc_response_unreadable",
          detail: `${method} answered ${res.status} with a body that is not JSON.`,
        };
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return { ok: false, reason: "rpc_result_malformed", detail: `${method}: not an object` };
      }
      const o = { ...(body as Record<string, unknown>) };
      if (o.error !== undefined && o.error !== null) {
        return { ok: false, reason: "rpc_error", detail: JSON.stringify(o.error) };
      }
      if (!("result" in o)) {
        return {
          ok: false,
          reason: "rpc_result_malformed",
          detail: `${method}: 2xx JSON carrying neither result nor error`,
        };
      }
      return { ok: true, result: o.result };
    },
  });
}

const ERROR_STRING_SELECTOR = "0x08c379a0";

export function decodeRevertReason(data: unknown): string | null {
  if (typeof data !== "string" || !data.startsWith(ERROR_STRING_SELECTOR)) return null;
  const body = data.slice(ERROR_STRING_SELECTOR.length);
  if (body.length < 128) return null;
  const offset = Number.parseInt(body.slice(0, 64), 16);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  const lenStart = offset * 2;
  if (lenStart + 64 > body.length) return null;
  const length = Number.parseInt(body.slice(lenStart, lenStart + 64), 16);
  if (!Number.isSafeInteger(length) || length < 0 || length > 4096) return null;
  const start = lenStart + 64;
  const hex = body.slice(start, start + length * 2);
  if (hex.length !== length * 2 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

export function revertDataFromRpcError(detail: string): string | null {
  const match = detail.match(/0x08c379a0[0-9a-fA-F]*/);
  return match ? match[0] : null;
}

export type SimulationOutcome =
  | { readonly kind: "would_succeed"; readonly returned: string }
  | { readonly kind: "would_revert"; readonly reason: string | null; readonly raw: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export async function simulateTransaction(input: {
  readonly rpc: ReadOnlyEvmRpc;
  readonly request: TransactionRequest;
  readonly from: string;
}): Promise<SimulationOutcome> {
  const res = await input.rpc.request("eth_call", [
    { from: input.from, to: input.request.to, data: input.request.data, value: "0x0" },
    "latest",
  ]);
  if (res.ok) {
    return { kind: "would_succeed", returned: typeof res.result === "string" ? res.result : "" };
  }
  if (res.reason === "rpc_error") {
    const raw = revertDataFromRpcError(res.detail);
    if (raw !== null) return { kind: "would_revert", reason: decodeRevertReason(raw), raw };
    if (/revert|execution reverted/i.test(res.detail)) {
      return { kind: "would_revert", reason: null, raw: res.detail };
    }
  }
  return { kind: "unavailable", detail: `${res.ok ? "" : res.reason}: ${res.ok ? "" : res.detail}` };
}

export interface RelayCost {
  readonly gas: bigint;
  readonly gasLimit: bigint;
  readonly gasPriceWei: bigint;
  readonly maxCostWei: bigint;
  readonly relayerBalanceWei: bigint;
}

export type CostRefusal =
  | "estimate_unavailable"
  | "gas_price_unavailable"
  | "balance_unavailable"
  | "relayer_cannot_pay_gas";

export type RelayCostResult =
  | { readonly ok: true; readonly cost: RelayCost }
  | { readonly ok: false; readonly reason: CostRefusal; readonly detail: string };

function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export async function estimateRelayCost(input: {
  readonly rpc: ReadOnlyEvmRpc;
  readonly request: TransactionRequest;
  readonly from: string;
  readonly gasLimitMarginPercent: number;
}): Promise<RelayCostResult> {
  if (
    typeof input.gasLimitMarginPercent !== "number" ||
    !Number.isInteger(input.gasLimitMarginPercent) ||
    input.gasLimitMarginPercent < 0 ||
    input.gasLimitMarginPercent > 500
  ) {
    return {
      ok: false,
      reason: "estimate_unavailable",
      detail: "gasLimitMarginPercent must be an integer between 0 and 500.",
    };
  }

  const est = await input.rpc.request("eth_estimateGas", [
    { from: input.from, to: input.request.to, data: input.request.data, value: "0x0" },
  ]);
  const gas = est.ok ? hexToBigInt(est.result) : null;
  if (gas === null) {
    return {
      ok: false,
      reason: "estimate_unavailable",
      detail: est.ok ? `unreadable estimate ${String(est.result)}` : `${est.reason}: ${est.detail}`,
    };
  }

  const priceRes = await input.rpc.request("eth_gasPrice", []);
  const gasPriceWei = priceRes.ok ? hexToBigInt(priceRes.result) : null;
  if (gasPriceWei === null) {
    return {
      ok: false,
      reason: "gas_price_unavailable",
      detail: priceRes.ok
        ? `unreadable gas price ${String(priceRes.result)}`
        : `${priceRes.reason}: ${priceRes.detail}`,
    };
  }

  const balRes = await input.rpc.request("eth_getBalance", [input.from, "latest"]);
  const relayerBalanceWei = balRes.ok ? hexToBigInt(balRes.result) : null;
  if (relayerBalanceWei === null) {
    return {
      ok: false,
      reason: "balance_unavailable",
      detail: balRes.ok
        ? `unreadable balance ${String(balRes.result)}`
        : `${balRes.reason}: ${balRes.detail}`,
    };
  }

  const gasLimit = (gas * BigInt(100 + input.gasLimitMarginPercent)) / BigInt(100);
  const maxCostWei = gasLimit * gasPriceWei;
  const cost: RelayCost = Object.freeze({
    gas,
    gasLimit,
    gasPriceWei,
    maxCostWei,
    relayerBalanceWei,
  });

  if (relayerBalanceWei < maxCostWei) {
    return {
      ok: false,
      reason: "relayer_cannot_pay_gas",
      detail:
        `the relayer holds ${relayerBalanceWei} wei and the worst case is ${maxCostWei} wei ` +
        `(${gasLimit} gas at ${gasPriceWei} wei). Sending anyway produces a transaction the ` +
        "node drops, which is indistinguishable from a network fault to everything downstream.",
    };
  }
  return { ok: true, cost };
}

const RELAY_CHAINS = new Map<string, Promise<unknown>>();

async function serialisePerRelayer<T>(address: string, fn: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  const previous = RELAY_CHAINS.get(key) ?? Promise.resolve();
  const mine = previous.then(fn, fn);
  RELAY_CHAINS.set(
    key,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await mine;
  } finally {
    if (RELAY_CHAINS.get(key) === undefined) RELAY_CHAINS.delete(key);
  }
}

export type SendRelayTransaction = (transaction: {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly value: "0x0";
  readonly chainId: number;
  readonly gasLimit: bigint;
  readonly gasPriceWei: bigint;
}) => Promise<string> | string;

const SINGLE_AUTHORIZATION_CALLDATA_RE = /^0x[0-9a-f]{584}$/;

export type SingleAuthorizationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

const VERIFIED_AUTHORIZATION_SELECTORS: readonly string[] = Object.freeze([
  TRANSFER_WITH_AUTHORIZATION_SELECTOR,
  RECEIVE_WITH_AUTHORIZATION_SELECTOR,
]);

function beneficiaryFromCalldata(data: string): string | null {
  const w = data.slice(2 + 8 + 64, 2 + 8 + 128);
  if (w.length !== 64 || !/^0{24}[0-9a-f]{40}$/.test(w)) return null;
  return `0x${w.slice(24)}`;
}

/**
 * Word 5 of the nine — `validBefore`, in UNIX SECONDS.
 *
 * READ FROM THE CALLDATA, NOT FROM A PARAMETER. The transaction request IS
 * the authorization, so the deadline the token will enforce is already in the
 * bytes this function is handed; taking it as a parameter would create a
 * second copy that can disagree with the signature.
 *
 * A `uint256`, so a `bigint` — `validBefore` is frequently the far-future
 * sentinel and nothing here may silently round it through `Number`.
 */
function validBeforeFromCalldata(data: string): bigint | null {
  const w = data.slice(2 + 8 + 64 * 4, 2 + 8 + 64 * 5);
  if (w.length !== 64 || !/^[0-9a-f]{64}$/.test(w)) return null;
  try {
    return BigInt(`0x${w}`);
  } catch {
    return null;
  }
}

export type RelayWindowCheck =
  | { readonly ok: true; readonly remainingMs: bigint }
  | { readonly ok: false; readonly remainingMs: bigint; readonly detail: string };

export function checkRelayRemainingWindow(input: {
  readonly data: string;
  readonly chainHeadSeconds: bigint;
}): RelayWindowCheck {
  const validBefore = validBeforeFromCalldata(input.data);
  if (validBefore === null) {
    return {
      ok: false,
      remainingMs: BigInt(0),
      detail:
        "the calldata's fifth word is not a readable uint256, so this module cannot tell how " +
        "much of the payment window is left. Refused rather than assumed.",
    };
  }
  const remainingMs = (validBefore - input.chainHeadSeconds) * BigInt(1000);
  if (remainingMs < BigInt(MIN_GRANT_TTL_MS)) {
    return {
      ok: false,
      remainingMs,
      detail:
        `this authorization is valid until UNIX second ${validBefore} and the chain head reads ` +
        `${input.chainHeadSeconds}, so ${remainingMs} ms of window remain. The rail will not call a ` +
        `payment settled below ${SESSION_RAIL_MIN_CONFIRMATIONS} confirmations, which is about ` +
        `${SESSION_RAIL_MIN_CONFIRMATIONS * SESSION_RAIL_BLOCK_TIME_MS} ms of block time, and the ` +
        `protocol allows the three clocks involved to disagree by ${MAX_CLOCK_SKEW_MS} ms — ` +
        `${MIN_GRANT_TTL_MS} ms in total. Relayed now, this payment would INCLUDE (the token only ` +
        "requires block.timestamp < validBefore), credit the payee in full, and reach depth after " +
        "the grant it pays for has expired: redeemGrant answers `expired`, no journal row is " +
        "written, and recoverTask answers `no_session`. The binding nonce is a function of the " +
        "grant hash and USDC marks (authorizer, nonce) spent forever, so no correcting payment " +
        "can ever satisfy that grant. Not sent — and the nonce is still free, so a hirer that " +
        "reissues the hire can still be paid.",
    };
  }
  return { ok: true, remainingMs };
}

export interface SingleAuthorizationRelayContext {
  readonly relayerAddress?: string;
}

export function checkSingleAuthorizationRelay(
  request: TransactionRequest,
  context: SingleAuthorizationRelayContext = {},
): SingleAuthorizationCheck {
  if (typeof request !== "object" || request === null) {
    return { ok: false, detail: "the transaction request is not an object." };
  }
  if (typeof request.chainId !== "number" || !Number.isInteger(request.chainId)) {
    return { ok: false, detail: `chainId ${String(request.chainId)} is not an integer.` };
  }
  let token: string | null = null;
  for (const domain of EVM_USDC_EIP712_DOMAINS.values()) {
    if (domain.chainId === request.chainId) token = domain.verifyingContract.toLowerCase();
  }
  if (token === null) {
    return {
      ok: false,
      detail:
        `no frozen USDC deployment is recorded for chain ${request.chainId}, so this module ` +
        "cannot tell a single authorization from a batch on it. Refused rather than assumed.",
    };
  }
  if (typeof request.to !== "string" || request.to.toLowerCase() !== token) {
    return {
      ok: false,
      detail:
        `this transaction calls ${String(request.to)}, and the only destination a single ` +
        `EIP-3009 authorization has on chain ${request.chainId} is the USDC deployment at ` +
        `${token}. A different destination is an intermediary — a multicall, an aggregator, ` +
        "a batcher — and an intermediary is how several authorizations end up in one " +
        "transaction.",
    };
  }
  const data = typeof request.data === "string" ? request.data.toLowerCase() : "";
  const selector = VERIFIED_AUTHORIZATION_SELECTORS.find((s) => data.startsWith(s)) ?? null;
  if (selector === null) {
    return {
      ok: false,
      detail:
        `the calldata selector is ${data.slice(0, 10) || "absent"} and the only calls this ` +
        `module relays are transferWithAuthorization (${TRANSFER_WITH_AUTHORIZATION_SELECTOR}) ` +
        `and receiveWithAuthorization (${RECEIVE_WITH_AUTHORIZATION_SELECTOR}). Their ` +
        "AuthorizationUsed log shape is the one the settlement verifier reads, and both have " +
        "been measured against it end to end; no other entry point has been.",
    };
  }
  if (!SINGLE_AUTHORIZATION_CALLDATA_RE.test(data)) {
    return {
      ok: false,
      detail:
        `the calldata is ${data.length - 2} hex characters and exactly 584 encode one ` +
        "EIP-3009 authorization (a 4-byte selector and nine static words — the same nine for " +
        "both entry points). Surplus bytes are ignored by an ABI decoder and are how a second " +
        "authorization rides along inside a call that looks well-formed.",
    };
  }
  if (selector === RECEIVE_WITH_AUTHORIZATION_SELECTOR && context.relayerAddress !== undefined) {
    const relayer =
      typeof context.relayerAddress === "string" ? context.relayerAddress.toLowerCase() : "";
    const beneficiary = beneficiaryFromCalldata(data);
    if (!ADDRESS_RE.test(relayer)) {
      return {
        ok: false,
        detail:
          `relayerAddress ${String(context.relayerAddress)} is not a 20-byte address, so this ` +
          "module cannot tell whether the receive call would be made by its own payee. " +
          "Refused rather than assumed.",
      };
    }
    if (beneficiary === null || beneficiary !== relayer) {
      return {
        ok: false,
        detail:
          `this is a receiveWithAuthorization paying ${String(beneficiary)} and it would be ` +
          `sent by ${relayer}. FiatTokenV2 requires msg.sender == to, so this call cannot ` +
          "execute — it would burn gas, emit no AuthorizationUsed log, and leave the " +
          "provider holding a hash the adapter can never resolve. The receive variant is " +
          "relayable only by the payee it names.",
      };
    }
  }
  if (request.value !== "0x0") {
    return {
      ok: false,
      detail:
        `this transaction carries native value ${String(request.value)}. USDC moves inside ` +
        "the call and never as value, so a non-zero value means the transaction is doing a " +
        "second thing — which is the class this check exists to refuse.",
    };
  }
  return { ok: true };
}

export type RelayRefusalReason =
  | "batched_relay_refused"
  | "chain_id_mismatch"
  | "chain_id_unavailable"
  | "chain_time_unavailable"
  | "relay_window_too_short"
  | "relayer_address_malformed"
  | "simulation_reverted"
  | "simulation_unavailable"
  | CostRefusal
  | "send_threw"
  | "send_returned_no_hash";

export class RelayRefusal extends Error {
  readonly reason: RelayRefusalReason;
  constructor(reason: RelayRefusalReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "RelayRefusal";
    this.reason = reason;
  }
}

export interface PayeeRelayBroadcasterInput {
  readonly rpc: ReadOnlyEvmRpc;
  readonly relayerAddress: string;
  readonly send: SendRelayTransaction;
  readonly gasLimitMarginPercent: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

export function createPayeeRelayBroadcaster(
  input: PayeeRelayBroadcasterInput,
): (request: TransactionRequest) => Promise<string> {
  if (typeof input !== "object" || input === null) {
    throw new Error("createPayeeRelayBroadcaster: input must be an object");
  }
  if (typeof input.send !== "function") {
    throw new Error("createPayeeRelayBroadcaster: send must be a function");
  }
  if (typeof input.relayerAddress !== "string" || !ADDRESS_RE.test(input.relayerAddress)) {
    throw new Error("createPayeeRelayBroadcaster: relayerAddress must be a 20-byte address");
  }
  const relayer = input.relayerAddress.toLowerCase();

  return async function broadcast(request: TransactionRequest): Promise<string> {
    const single = checkSingleAuthorizationRelay(request, { relayerAddress: relayer });
    if (!single.ok) {
      throw new RelayRefusal(
        "batched_relay_refused",
        `${single.detail} A transaction that consumes more than one EIP-3009 authorization ` +
          "is ambiguous about which grant each payment was for, and that ambiguity is fixed " +
          "in the block forever — the settlement adapter answers `unattributable`, the payers " +
          "stay debited, and no provider in the batch can redeem. Relay one authorization per " +
          "transaction. Not sent.",
      );
    }

    const idRes = await input.rpc.request("eth_chainId", []);
    const observed = idRes.ok ? hexToBigInt(idRes.result) : null;
    if (observed === null) {
      throw new RelayRefusal(
        "chain_id_unavailable",
        idRes.ok ? `unreadable chainId ${String(idRes.result)}` : `${idRes.reason}: ${idRes.detail}`,
      );
    }
    if (observed !== BigInt(request.chainId)) {
      throw new RelayRefusal(
        "chain_id_mismatch",
        `the authorization is for chain ${request.chainId} and this RPC answers ${observed}. ` +
          "The chain id is inside the EIP-712 domain separator, so this signature is not " +
          "valid on the network this node serves.",
      );
    }

    const headRes = await input.rpc.request("eth_getBlockByNumber", ["latest", false]);
    const headTs =
      headRes.ok && typeof headRes.result === "object" && headRes.result !== null
        ? hexToBigInt((headRes.result as { timestamp?: unknown }).timestamp)
        : null;
    if (headTs === null) {
      throw new RelayRefusal(
        "chain_time_unavailable",
        headRes.ok
          ? `the node's latest block carries no readable timestamp (${JSON.stringify(headRes.result).slice(0, 120)})`
          : `${headRes.reason}: ${headRes.detail}`,
      );
    }
    const window = checkRelayRemainingWindow({
      data: String(request.data).toLowerCase(),
      chainHeadSeconds: headTs,
    });
    if (!window.ok) throw new RelayRefusal("relay_window_too_short", window.detail);

    const sim = await simulateTransaction({ rpc: input.rpc, request, from: relayer });
    if (sim.kind === "would_revert") {
      throw new RelayRefusal(
        "simulation_reverted",
        `eth_call reverted with ${sim.reason ?? "no reason string"} (${sim.raw.slice(0, 200)}). ` +
          "A reverted transferWithAuthorization emits no AuthorizationUsed log, so the " +
          "settlement binding would have nowhere to live and the redemption could never " +
          "resolve. Not sent.",
      );
    }
    if (sim.kind === "unavailable") {
      throw new RelayRefusal(
        "simulation_unavailable",
        `${sim.detail}. The node did not answer, so nothing was ruled out. Not sent.`,
      );
    }

    const cost = await estimateRelayCost({
      rpc: input.rpc,
      request,
      from: relayer,
      gasLimitMarginPercent: input.gasLimitMarginPercent,
    });
    if (!cost.ok) throw new RelayRefusal(cost.reason, cost.detail);

    let hash: string;
    try {
      hash = await serialisePerRelayer(relayer, () =>
        Promise.resolve(
          input.send({
            from: relayer,
            to: request.to,
            data: request.data,
            value: request.value,
            chainId: request.chainId,
            gasLimit: cost.cost.gasLimit,
            gasPriceWei: cost.cost.gasPriceWei,
          }),
        ),
      );
    } catch (err) {
      throw new RelayRefusal(
        "send_threw",
        "the injected sender threw. THIS IS NOT PROOF NOTHING HAPPENED — a timeout after " +
          "the transaction reached a mempool looks identical from here. " +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (typeof hash !== "string" || !TX_HASH_RE.test(hash.toLowerCase())) {
      throw new RelayRefusal(
        "send_returned_no_hash",
        "the sender returned something that is not a `0x` + 64 hex transaction hash, so " +
          "there is nothing to present to the provider as evidence.",
      );
    }
    return hash.toLowerCase();
  };
}

export const AUTHORIZATION_USED_TOPIC0 =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

export type SettlementLookupResult =
  | { readonly kind: "found"; readonly transactionHash: string; readonly blockNumber: bigint }
  | { readonly kind: "not_consumed" }
  | { readonly kind: "impossible"; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface ResolveSettlementTransactionInput {
  readonly rpc: ReadOnlyEvmRpc;
  readonly chainId: number;
  readonly authorizer: string;
  readonly bindingReference: string;
  readonly fromBlock: bigint;
}

const HEX32_NO_PREFIX_RE = /^[0-9a-f]{64}$/;

export async function resolveSettlementTransaction(
  input: ResolveSettlementTransactionInput,
): Promise<SettlementLookupResult> {
  if (typeof input !== "object" || input === null) {
    return { kind: "unavailable", detail: "resolveSettlementTransaction: input must be an object" };
  }
  if (typeof input.chainId !== "number" || !Number.isInteger(input.chainId)) {
    return { kind: "unavailable", detail: `chainId ${String(input.chainId)} is not an integer.` };
  }
  let token: string | null = null;
  for (const domain of EVM_USDC_EIP712_DOMAINS.values()) {
    if (domain.chainId === input.chainId) token = domain.verifyingContract.toLowerCase();
  }
  if (token === null) {
    return {
      kind: "unavailable",
      detail:
        `no frozen USDC deployment is recorded for chain ${input.chainId}, so there is no ` +
        "emitter to pin this query to. Refused rather than asking every contract on the chain.",
    };
  }
  const authorizer =
    typeof input.authorizer === "string" ? input.authorizer.toLowerCase() : "";
  if (!ADDRESS_RE.test(authorizer)) {
    return {
      kind: "unavailable",
      detail: `authorizer ${String(input.authorizer)} is not a 20-byte address.`,
    };
  }
  const ref =
    typeof input.bindingReference === "string"
      ? input.bindingReference.toLowerCase().replace(/^0x/, "")
      : "";
  if (!HEX32_NO_PREFIX_RE.test(ref)) {
    return {
      kind: "unavailable",
      detail:
        `bindingReference ${String(input.bindingReference)} is not 32 bytes of lowercase hex. ` +
        "It is settlementBindingReference(grantHash) and nothing else.",
    };
  }
  if (typeof input.fromBlock !== "bigint" || input.fromBlock < BigInt(0)) {
    return {
      kind: "unavailable",
      detail:
        "fromBlock is required and must be a non-negative bigint. There is no default: a " +
        "guessed window either misses a payment that exists or asks for an unbounded scan.",
    };
  }

  const res = await input.rpc.request("eth_getLogs", [
    {
      address: token,
      topics: [
        AUTHORIZATION_USED_TOPIC0,
        `0x${"0".repeat(24)}${authorizer.slice(2)}`,
        `0x${ref}`,
      ],
      fromBlock: `0x${input.fromBlock.toString(16)}`,
      toBlock: "latest",
    },
  ]);
  if (!res.ok) {
    return {
      kind: "unavailable",
      detail:
        `${res.reason}: ${res.detail}. Some providers cap eth_getLogs ranges or refuse a wide ` +
        "fromBlock with toBlock:latest; a narrower window from the same anchor may answer. " +
        "Nothing was learned, so nothing should be concluded.",
    };
  }
  if (!Array.isArray(res.result)) {
    return {
      kind: "unavailable",
      detail: `eth_getLogs answered ${typeof res.result}, not an array of logs.`,
    };
  }
  if (res.result.length === 0) return { kind: "not_consumed" };
  if (res.result.length > 1) {
    return {
      kind: "impossible",
      detail:
        `${res.result.length} AuthorizationUsed logs carry authorizer ${authorizer} and nonce ` +
        `0x${ref} on ${token}. FiatTokenV2 marks that pair consumed before it transfers, so at ` +
        "most one transaction can ever emit it. This node is wrong about something; refusing " +
        "rather than choosing one of them.",
    };
  }

  const log = res.result[0] as Record<string, unknown>;
  const hash = typeof log.transactionHash === "string" ? log.transactionHash.toLowerCase() : "";
  if (!TX_HASH_RE.test(hash)) {
    return {
      kind: "unavailable",
      detail: `the log carries transactionHash ${String(log.transactionHash)}, which is not a hash.`,
    };
  }
  const blockNumber = hexToBigInt(log.blockNumber);
  if (blockNumber === null) {
    return {
      kind: "unavailable",
      detail:
        `the log carries blockNumber ${String(log.blockNumber)}. A pending log has no block, ` +
        "and a payment that is not in a block is not a payment yet.",
    };
  }
  return { kind: "found", transactionHash: hash, blockNumber };
}
