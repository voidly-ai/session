
import { X402_SESSION_USDC_BY_CHAIN } from "./x402Session";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const EIP155_CHAIN_RE = /^eip155:[1-9][0-9]{0,31}$/;

export const PREFLIGHT_DEFAULT_CHAIN = "eip155:8453";

export const MAX_SUPPORTED_RESPONSE_BYTES = 256 * 1024;

export const KNOWN_ASSET_TRANSFER_METHODS = Object.freeze([
  "eip3009",
  "permit2",
  "erc7710",
] as const);

export const REQUIRED_ASSET_TRANSFER_METHOD = "eip3009" as const;

export const X402_V1_NETWORK_ALIASES: ReadonlyMap<string, string> = Object.freeze(
  new Map<string, string>([
    ["base", "eip155:8453"],
    ["base-sepolia", "eip155:84532"],
  ]),
);

const ASSET_ADVERTISEMENT_KEYS: readonly string[] = Object.freeze([
  "asset",
  "assetAddress",
  "asset_address",
  "token",
  "tokenAddress",
  "token_address",
  "usdc",
  "contract",
  "contractAddress",
]);

export const FACILITATOR_PREFLIGHT_SCHEMA = "voidly.pay.facilitator-preflight/v1";

export type PreflightVerdict = "usable" | "unusable" | "unknown";

export type PreflightReason =
  | "eip3009_exact_advertised"
  | "transfer_method_permit2"
  | "transfer_method_not_eip3009"
  | "no_exact_on_chain"
  | "chain_not_offered"
  | "asset_not_frozen_usdc"
  | "transfer_method_not_advertised"
  | "transfer_method_unrecognised"
  | "asset_advertisement_unreadable"
  | "unreachable"
  | "http_status"
  | "response_not_json"
  | "response_malformed"
  | "response_too_large"
  | "url_not_https"
  | "chain_not_supported_by_rail";

export type PreflightObservationCode =
  | "matched_via_v1_alias"
  | "v1_exact_is_eip3009_by_spec"
  | "batch_scheme_advertised"
  | "other_schemes_on_chain"
  | "supported_response_not_v2_conformant"
  | "redirected"
  | "minimum_payment_advertised";

export interface PreflightObservation {
  readonly code: PreflightObservationCode;
  readonly detail: string;
}

export type PreflightUndeterminedCode =
  | "batching_not_advertised"
  | "nonce_control_is_client_side"
  | "per_transaction_shape_is_on_chain"
  | "transfer_method_not_advertised";

export interface PreflightUndetermined {
  readonly code: PreflightUndeterminedCode;
  readonly detail: string;
}

export interface MatchedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly resolvedChain: string;
  readonly assetTransferMethod: string | null;
}

export interface FacilitatorPreflightResult {
  readonly schema: typeof FACILITATOR_PREFLIGHT_SCHEMA;
  readonly verdict: PreflightVerdict;
  readonly reason: PreflightReason;
  readonly detail: string;
  readonly chain: string;
  readonly frozenAsset: string | null;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly matched: MatchedKind | null;
  readonly observations: readonly PreflightObservation[];
  readonly undetermined: readonly PreflightUndetermined[];
}

const ALWAYS_UNDETERMINED: readonly PreflightUndetermined[] = Object.freeze([
  Object.freeze({
    code: "batching_not_advertised" as const,
    detail:
      "Whether this facilitator settles several authorizations in one transaction is not a field in the x402 v2 SupportedResponse schema and is not advertised by any facilitator surveyed. A batched settlement produces evidence the session adapter answers `indeterminate` on, because it requires exactly one EIP-3009 authorization per transaction. This preflight cannot rule that out.",
  }),
  Object.freeze({
    code: "nonce_control_is_client_side" as const,
    detail:
      "The binding nonce is chosen by the payer's client, not the facilitator. @x402/evm@2.23.0's createNonce() returns 32 random bytes with no override, so a stock client cannot produce the required nonce regardless of which facilitator is used. No verdict here addresses that.",
  }),
  Object.freeze({
    code: "per_transaction_shape_is_on_chain" as const,
    detail:
      "Whether the settling transaction reverts, carries an offsetting outbound transfer, or pays the wrong account is decided on chain and read by the adapter after the fact. Nothing in /supported speaks to it.",
  }),
]);

const NOT_ADVERTISED_UNDETERMINED: PreflightUndetermined = Object.freeze({
  code: "transfer_method_not_advertised" as const,
  detail:
    "This facilitator does not state an assetTransferMethod for the exact scheme on this chain. The x402 v2 exact-EVM scheme defaults an ABSENT payload field to eip3009 when the token supports it, and Base USDC does — but that rule is about the payment payload, not about /supported, and the v2 schema marks `extra` optional without saying what its absence means. Not established either way.",
});

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FacilitatorPreflightInput {
  readonly baseUrl: string;
  readonly chain?: string;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}

export function supportedUrlFor(baseUrl: string): string | null {
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
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/supported") ? path : `${path}/supported`;
  return parsed.toString();
}

export interface ParsedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly extra: Record<string, unknown> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSupportedKinds(body: unknown): ParsedKind[] | null {
  if (!isPlainObject(body)) return null;
  const raw = body.kinds;
  if (!Array.isArray(raw)) return null;
  const kinds: ParsedKind[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const { x402Version, scheme, network, extra } = entry;
    if (typeof scheme !== "string" || scheme.length === 0) continue;
    if (typeof network !== "string" || network.length === 0) continue;
    if (typeof x402Version !== "number" || !Number.isFinite(x402Version)) continue;
    kinds.push({
      x402Version,
      scheme,
      network,
      extra: isPlainObject(extra) ? extra : null,
    });
  }
  return kinds;
}

export function resolveKindChain(kind: ParsedKind): string | null {
  if (EIP155_CHAIN_RE.test(kind.network)) return kind.network;
  if (kind.x402Version === 1) return X402_V1_NETWORK_ALIASES.get(kind.network) ?? null;
  return null;
}

function readTransferMethod(extra: Record<string, unknown> | null): string | null {
  if (!extra) return null;
  if (!("assetTransferMethod" in extra)) return null;
  const value = extra.assetTransferMethod;
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function readAdvertisedAsset(extra: Record<string, unknown> | null): string | null {
  if (!extra) return null;
  for (const key of ASSET_ADVERTISEMENT_KEYS) {
    if (!(key in extra)) continue;
    const value = extra[key];
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (ADDRESS_RE.test(trimmed)) return trimmed.toLowerCase();
    const tail = trimmed.split(":").pop() ?? "";
    if (ADDRESS_RE.test(tail)) return tail.toLowerCase();
    return "";
  }
  return null;
}

interface ResultContext {
  readonly chain: string;
  readonly frozenAsset: string | null;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly observations?: readonly PreflightObservation[];
}

function result(
  ctx: ResultContext,
  verdict: PreflightVerdict,
  reason: PreflightReason,
  detail: string,
  matched: MatchedKind | null,
  extraUndetermined: readonly PreflightUndetermined[] = [],
): FacilitatorPreflightResult {
  return Object.freeze({
    schema: FACILITATOR_PREFLIGHT_SCHEMA,
    verdict,
    reason,
    detail,
    chain: ctx.chain,
    frozenAsset: ctx.frozenAsset,
    url: ctx.url,
    httpStatus: ctx.httpStatus,
    matched,
    observations: Object.freeze([...(ctx.observations ?? [])]),
    undetermined: Object.freeze([...extraUndetermined, ...ALWAYS_UNDETERMINED]),
  });
}

export function decideFromSupported(args: {
  readonly body: unknown;
  readonly chain: string;
  readonly url: string;
  readonly httpStatus: number | null;
}): FacilitatorPreflightResult {
  const { body, chain, url, httpStatus } = args;

  const frozenAsset = X402_SESSION_USDC_BY_CHAIN.get(chain) ?? null;
  const base = { chain, url, httpStatus, frozenAsset };

  if (frozenAsset === null) {
    return result(
      base,
      "unknown",
      "chain_not_supported_by_rail",
      `The session adapter has no frozen USDC address for ${chain}, so there is nothing to check a facilitator against. Nothing about this facilitator was established.`,
      null,
    );
  }

  const kinds = parseSupportedKinds(body);
  if (kinds === null) {
    return result(
      base,
      "unknown",
      "response_malformed",
      "The response parsed as JSON but carries no readable `kinds` array, so it is not an x402 SupportedResponse. Nothing about this facilitator was established.",
      null,
    );
  }

  const observations: PreflightObservation[] = [];

  if (isPlainObject(body) && (!Array.isArray(body.extensions) || !isPlainObject(body.signers))) {
    observations.push({
      code: "supported_response_not_v2_conformant",
      detail:
        "`extensions` and `signers` are both REQUIRED by the x402 v2 SupportedResponse schema and at least one is missing or the wrong type. Not a disqualifier — a v1-only facilitator has no reason to publish them — but it means this document is not a conformant v2 response.",
    });
  }

  const onChain = kinds
    .map((k) => ({ kind: k, resolved: resolveKindChain(k) }))
    .filter((k) => k.resolved === chain);

  if (onChain.length === 0) {
    return result(
      { ...base, observations },
      "unusable",
      "chain_not_offered",
      `This facilitator lists no kind on ${chain} under any scheme or protocol version, so it cannot settle a payment there.`,
      null,
    );
  }

  const otherSchemes = [...new Set(onChain.map((k) => k.kind.scheme))].filter((s) => s !== "exact");
  if (otherSchemes.length > 0) {
    observations.push({
      code: "other_schemes_on_chain",
      detail: `Also advertises on ${chain}: ${otherSchemes.join(", ")}. This rail uses \`exact\` only.`,
    });
  }
  const batchSchemes = otherSchemes.filter((s) => /batch/i.test(s));
  if (batchSchemes.length > 0) {
    observations.push({
      code: "batch_scheme_advertised",
      detail: `Advertises ${batchSchemes.join(", ")} on ${chain}, so this facilitator CAN batch settlements. That is not proof it batches the \`exact\` scheme — and the absence of such a scheme would not have been proof that it does not. Batching remains undetermined either way.`,
    });
  }

  const exacts = onChain.filter((k) => k.kind.scheme === "exact");
  if (exacts.length === 0) {
    return result(
      { ...base, observations },
      "unusable",
      "no_exact_on_chain",
      `This facilitator is present on ${chain} but offers no \`exact\` scheme there${otherSchemes.length ? ` (only: ${otherSchemes.join(", ")})` : ""}. The session rail settles \`exact\` and nothing else.`,
      null,
    );
  }

  const disqualifying = (k: (typeof exacts)[number]) => {
    const m = readTransferMethod(k.kind.extra);
    if (!m) return 1;
    if (m === REQUIRED_ASSET_TRANSFER_METHOD) return 1;
    return (KNOWN_ASSET_TRANSFER_METHODS as readonly string[]).includes(m) ? 0 : 1;
  };
  const ranked = [...exacts].sort((a, b) => {
    const stated = (k: typeof a) => (readTransferMethod(k.kind.extra) ? 0 : 1);
    const caip = (k: typeof a) => (EIP155_CHAIN_RE.test(k.kind.network) ? 0 : 1);
    return (
      disqualifying(a) - disqualifying(b) ||
      caip(a) - caip(b) ||
      stated(a) - stated(b) ||
      b.kind.x402Version - a.kind.x402Version
    );
  });
  const chosen = ranked[0];
  const kind = chosen.kind;
  const method = readTransferMethod(kind.extra);

  const matched: MatchedKind = Object.freeze({
    x402Version: kind.x402Version,
    scheme: kind.scheme,
    network: kind.network,
    resolvedChain: chain,
    assetTransferMethod: method === null || method === "" ? null : method,
  });

  if (!EIP155_CHAIN_RE.test(kind.network)) {
    observations.push({
      code: "matched_via_v1_alias",
      detail: `Matched the x402 v1 network alias \`${kind.network}\` to ${chain}. The facilitator publishes no CAIP-2 entry for this chain.`,
    });
  }
  if (kind.x402Version === 1) {
    observations.push({
      code: "v1_exact_is_eip3009_by_spec",
      detail:
        "The matched entry is x402Version 1, whose specification states plainly that the `exact` scheme uses EIP-3009 transferWithAuthorization — v1 has no permit2 option. That is stronger evidence than a v2 entry with no `extra`, but it is evidence about the protocol version rather than about this facilitator's implementation, and the v1 payload shape is one this rail has not exercised end to end. It does not by itself earn a `usable` verdict.",
    });
  }
  const minimum = kind.extra?.minPaymentAmountAtomic;
  if (typeof minimum === "string" && /^[0-9]+$/.test(minimum) && minimum !== "0") {
    observations.push({
      code: "minimum_payment_advertised",
      detail: `Refuses payments below ${minimum} atomic units on ${chain}. A grant priced under that cannot be paid through this facilitator.`,
    });
  }

  if (method === "permit2") {
    return result(
      { ...base, observations },
      "unusable",
      "transfer_method_permit2",
      `This facilitator settles \`exact\` on ${chain} via Permit2. A Permit2 settlement emits no AuthorizationUsed log and carries no bytes32 EIP-3009 nonce, so the grant binding has nowhere to live and the session adapter will answer \`indeterminate\` on a payment that really happened. Do not pay through this facilitator.`,
      matched,
    );
  }
  if (
    method !== null &&
    method !== "" &&
    method !== REQUIRED_ASSET_TRANSFER_METHOD &&
    (KNOWN_ASSET_TRANSFER_METHODS as readonly string[]).includes(method)
  ) {
    return result(
      { ...base, observations },
      "unusable",
      "transfer_method_not_eip3009",
      `This facilitator settles \`exact\` on ${chain} via \`${method}\`, which is not an EIP-3009 authorization path. It emits no AuthorizationUsed log for the session adapter to read, so a payment settled here can never verify.`,
      matched,
    );
  }

  const advertisedAsset = readAdvertisedAsset(kind.extra);
  if (advertisedAsset === "") {
    return result(
      { ...base, observations },
      "unknown",
      "asset_advertisement_unreadable",
      "This facilitator pins a token on the matched entry but the value is not a readable address, so it could not be compared against the frozen USDC contract. Refusing requires establishing a mismatch, and no mismatch was established.",
      matched,
      method === null ? [NOT_ADVERTISED_UNDETERMINED] : [],
    );
  }
  if (advertisedAsset !== null && advertisedAsset !== frozenAsset) {
    return result(
      { ...base, observations },
      "unusable",
      "asset_not_frozen_usdc",
      `This facilitator pins ${advertisedAsset} as the token on ${chain}. The session adapter derives ${frozenAsset} from the chain and will not read a transfer of anything else, so a payment settled here can never verify.`,
      matched,
    );
  }

  if (method === null) {
    return result(
      { ...base, observations },
      "unknown",
      "transfer_method_not_advertised",
      `This facilitator offers \`exact\` on ${chain} and nothing in its /supported document disqualifies it — but it does not state an assetTransferMethod, so whether it settles via EIP-3009 (which this rail can verify) or Permit2 (which it cannot) is not established. Confirm with the facilitator before paying.`,
      matched,
      [NOT_ADVERTISED_UNDETERMINED],
    );
  }
  if (method === "") {
    return result(
      { ...base, observations },
      "unknown",
      "transfer_method_unrecognised",
      "The matched entry carries an assetTransferMethod that is not a string. Nothing was established about how this facilitator settles.",
      matched,
      [NOT_ADVERTISED_UNDETERMINED],
    );
  }
  if (method === REQUIRED_ASSET_TRANSFER_METHOD) {
    return result(
      { ...base, observations },
      "usable",
      "eip3009_exact_advertised",
      `This facilitator advertises \`exact\` on ${chain} settled via EIP-3009, which is the authorization path the session adapter reads. Nothing in its /supported document disqualifies it. That is the whole of what was checked — see \`undetermined\`, which is never empty: batching, client-side nonce control and the shape of the settling transaction are all outside this document.`,
      matched,
    );
  }
  return result(
    { ...base, observations },
    "unknown",
    "transfer_method_unrecognised",
    `This facilitator advertises assetTransferMethod \`${method}\`, which this module does not recognise. It is neither known-good nor known-bad, so nothing was established. Treat as unverified until someone reads the method's specification.`,
    matched,
    [NOT_ADVERTISED_UNDETERMINED],
  );
}

export async function preflightFacilitator(
  input: FacilitatorPreflightInput,
): Promise<FacilitatorPreflightResult> {
  const chain = input.chain ?? PREFLIGHT_DEFAULT_CHAIN;
  const frozenAsset = X402_SESSION_USDC_BY_CHAIN.get(chain) ?? null;

  const url = supportedUrlFor(input.baseUrl);
  if (url === null) {
    return result(
      { chain, url: String(input.baseUrl ?? ""), httpStatus: null, frozenAsset },
      "unknown",
      "url_not_https",
      "Refused to fetch: the facilitator URL is not a well-formed https URL. A discovery document read over cleartext can be rewritten in flight, so nothing was requested and nothing about this facilitator was established.",
      null,
    );
  }

  const base = { chain, url, httpStatus: null as number | null, frozenAsset };

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return result(
      base,
      "unknown",
      "unreachable",
      "The request to /supported did not complete — a refused connection, a TLS failure, a timeout or a reset. The facilitator may be perfectly fine; we did not reach it.",
      null,
    );
  }

  const httpStatus = typeof response?.status === "number" ? response.status : null;
  const withStatus = { ...base, httpStatus };

  const observations: PreflightObservation[] = [];
  const finalUrl = typeof response?.url === "string" ? response.url : "";
  if (finalUrl && finalUrl !== url) {
    observations.push({
      code: "redirected",
      detail: `The request was aimed at ${url} and ended at ${finalUrl}. Redirects across hosts are normal for facilitators (facilitator.dexter.cash 308s to x402.dexter.cash), but the document that was read is the one served by the final host.`,
    });
  }

  if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) {
    return result(
      { ...withStatus, observations },
      "unknown",
      "http_status",
      `/supported answered ${httpStatus ?? "no readable status"}. That says nothing about which schemes the facilitator supports; it says the document was not served.`,
      null,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return result(
      { ...withStatus, observations },
      "unknown",
      "unreachable",
      "The status arrived and the body did not. Nothing was established.",
      null,
    );
  }

  if (text.length > MAX_SUPPORTED_RESPONSE_BYTES) {
    return result(
      { ...withStatus, observations },
      "unknown",
      "response_too_large",
      `/supported returned ${text.length} bytes, over the ${MAX_SUPPORTED_RESPONSE_BYTES}-byte cap. It was not parsed. A discovery document this size is not one.`,
      null,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return result(
      { ...withStatus, observations },
      "unknown",
      "response_not_json",
      "/supported answered 2xx with something that is not JSON. An HTML error or landing page is the ordinary case: a facilitator whose base URL is not its API root serves the marketing site here, and https://x402.org/supported returns a 50KB HTML 404 while the real endpoint is https://x402.org/facilitator/supported. Nothing was established.",
      null,
    );
  }

  const decided = decideFromSupported({ body, chain, url, httpStatus });
  if (observations.length === 0) return decided;
  return Object.freeze({
    ...decided,
    observations: Object.freeze([...observations, ...decided.observations]),
  });
}
