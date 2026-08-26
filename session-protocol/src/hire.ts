
import { validateAcceptance } from "./acceptance";
import { caip2Of, compareDecimalStrings, isCaip10, isCaip19, isCaip2, isPositiveDecimalString } from "./caip";
import { envelopeHash } from "./envelope";
import { HEX64_RE, hasOnlyKeys, isPlausibleNowMs, timestampMs } from "./schemas";
import type { AccountSpellingRefuseDetail, HireWire, RedeemRejectReason, SessionOfferEnvelope, TaskAcceptanceEnvelope, TaskCapsule, TaskGrantEnvelope, Validated } from "./schemas";
import { x402SessionAccountSpellingIsUnpayable } from "./x402Session";
import { settlementBindingReference } from "./settlement";
import { signCanonical, verifyDetached } from "./sig";
import type { Signer } from "./sig";
import { decodeBase64 } from "tweetnacl-util";

export const SESSION_HIRE_SCHEMA = "voidly-session-hire/v1";
export const SESSION_HIRE_ACCEPTED_SCHEMA = "voidly-session-hire-accepted/v1";
export const SESSION_HIRE_REFUSED_SCHEMA = "voidly-session-hire-refused/v1";

export const SESSION_PAYMENT_AUTHORIZATION_SCHEMA = "voidly-session-payment-authorization/v1";

export const PAYMENT_AUTHORIZATION_SCHEME = "eip3009";

export type AuthorizationEntryPoint =
  | "transfer_with_authorization"
  | "receive_with_authorization";

export const AUTHORIZATION_ENTRY_POINTS: readonly AuthorizationEntryPoint[] = [
  "transfer_with_authorization",
  "receive_with_authorization",
] as const;

export function authorizationEntryPoint(authorization: {
  readonly entry_point?: AuthorizationEntryPoint;
}): AuthorizationEntryPoint | "unstated" {
  return authorization.entry_point ?? "unstated";
}

export type PaymentAuthorization = {
  scheme: typeof PAYMENT_AUTHORIZATION_SCHEME;
  entry_point?: AuthorizationEntryPoint;
  chain: string;
  asset: string;
  from: string;
  to: string;
  value: string;
  /** Unix SECONDS, decimal, `0` permitted. */
  valid_after: string;
  /**
   * Unix SECONDS, decimal. MUST equal `floor(grant.expires_at / 1000)`.
   * See `bindAuthorizationToGrant` for the whole argument — this is the field
   * that decides whether a late submission is a contract-level revert or a
   * silent, unrecoverable loss for the hirer.
   */
  valid_before: string;
  nonce: string;
  signature: string;
};

export type PaymentAuthorizationBinding = {
  schema: typeof SESSION_PAYMENT_AUTHORIZATION_SCHEMA;
  grant_hash: string;
  authorization_hash: string;
};

export type SessionHireMessage = {
  schema: typeof SESSION_HIRE_SCHEMA;
  offer: SessionOfferEnvelope;
  offer_signature_base64: string;
  grant: TaskGrantEnvelope;
  grant_signature_base64: string;
  capsule: TaskCapsule;
  authorization: PaymentAuthorization;
  authorization_signature_base64: string;
};

export type SessionHireAccepted = {
  schema: typeof SESSION_HIRE_ACCEPTED_SCHEMA;
  grant_hash: string;
  acceptance: TaskAcceptanceEnvelope;
  acceptance_signature_base64: string;
};

export type SessionHireRefused = {
  schema: typeof SESSION_HIRE_REFUSED_SCHEMA;
  reason: HireRefuseReason;
  detail: ReceivedHireRefuseDetail;
};

export const AUTHORIZATION_KEYS = [
  "scheme",
  "entry_point",
  "chain",
  "asset",
  "from",
  "to",
  "value",
  "valid_after",
  "valid_before",
  "nonce",
  "signature",
] as const;

export const HIRE_MESSAGE_KEYS = [
  "schema",
  "offer",
  "offer_signature_base64",
  "grant",
  "grant_signature_base64",
  "capsule",
  "authorization",
  "authorization_signature_base64",
] as const;

export const HIRE_ACCEPTED_KEYS = [
  "schema",
  "grant_hash",
  "acceptance",
  "acceptance_signature_base64",
] as const;

export const HIRE_REFUSED_KEYS = ["schema", "reason", "detail"] as const;

export type HireRefuseReason =
  | "hire_malformed"
  | "identity_unresolved"
  | "hirer_key_mismatch"
  | "invalid_hirer_signature"
  | "artifact_binding_broken"
  | "not_the_named_provider"
  | "authorization_invalid"
  | "authorization_entry_point_refused"
  | "grant_already_committed"
  | "price_below_floor"
  | "window_too_short"
  | "brief_rejected"
  | "service_unavailable"
  | "ledger_unavailable";

export type HireRefuseDetail =
  | RedeemRejectReason
  | "hire_not_object"
  | "hire_schema_mismatch"
  | "hire_unexpected_field"
  | "hire_invalid_offer_signature_encoding"
  | "hire_invalid_grant_signature_encoding"
  | "hire_invalid_authorization_signature_encoding"
  | "authorization_signature_forged"
  | "authorization_not_object"
  | "authorization_unexpected_field"
  | "authorization_scheme_unsupported"
  | "authorization_entry_point_unsupported"
  | "authorization_entry_point_unstated"
  | "authorization_entry_point_not_accepted"
  | "provider_entry_points_unconfigured"
  | "stored_hire_bundle_mismatch"
  | "stored_hire_unreadable"
  | "ledger_read_failed"
  | "authorization_invalid_chain"
  | "authorization_invalid_asset"
  | "authorization_invalid_from"
  | "authorization_invalid_to"
  | "authorization_invalid_value"
  | "authorization_invalid_valid_after"
  | "authorization_invalid_valid_before"
  | "authorization_invalid_nonce"
  | "authorization_invalid_signature"
  | "authorization_chain_mismatch"
  | "authorization_asset_mismatch"
  | "authorization_payer_mismatch"
  | "authorization_payee_mismatch"
  | AccountSpellingRefuseDetail
  | "authorization_below_floor"
  | "authorization_over_ceiling"
  | "authorization_binding_mismatch"
  | "authorization_expiry_mismatch"
  | "authorization_valid_after_too_late"
  | "hirer_key_unresolved"
  | "hirer_key_not_the_registered_one"
  | "offer_signature_forged"
  | "grant_signature_forged"
  | "provider_did_not_ours"
  | "provider_signing_key_not_ours"
  | "provider_enc_key_not_ours"
  | "payee_account_not_ours"
  | "grant_already_expired"
  | "grant_window_too_short"
  | "price_under_provider_floor"
  | "provider_policy_refused"
  | "provider_not_accepting"
  | "ledger_write_failed";

export type UnknownHireRefuseDetail = string & {};

export type ReceivedHireRefuseDetail = HireRefuseDetail | UnknownHireRefuseDetail;

const UNIX_SECONDS_RE = /^(0|[1-9][0-9]{0,19})$/;

const ECDSA_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

export function isSignature64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return decodeBase64(value).length === 64;
  } catch {
    return false;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validateAuthorizationShape(
  raw: unknown,
): Validated<PaymentAuthorization, HireRefuseDetail> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "authorization_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (!hasOnlyKeys(r, AUTHORIZATION_KEYS)) {
    return { ok: false, reason: "authorization_unexpected_field" };
  }
  if (r.scheme !== PAYMENT_AUTHORIZATION_SCHEME) {
    return { ok: false, reason: "authorization_scheme_unsupported" };
  }
  if (
    r.entry_point !== undefined &&
    !AUTHORIZATION_ENTRY_POINTS.includes(r.entry_point as AuthorizationEntryPoint)
  ) {
    return { ok: false, reason: "authorization_entry_point_unsupported" };
  }
  if (typeof r.chain !== "string" || !isCaip2(r.chain)) {
    return { ok: false, reason: "authorization_invalid_chain" };
  }
  if (typeof r.asset !== "string" || !isCaip19(r.asset) || caip2Of(r.asset) !== r.chain) {
    return { ok: false, reason: "authorization_invalid_asset" };
  }
  if (typeof r.from !== "string" || !isCaip10(r.from) || caip2Of(r.from) !== r.chain) {
    return { ok: false, reason: "authorization_invalid_from" };
  }
  if (typeof r.to !== "string" || !isCaip10(r.to) || caip2Of(r.to) !== r.chain) {
    return { ok: false, reason: "authorization_invalid_to" };
  }
  if (typeof r.value !== "string" || !isPositiveDecimalString(r.value)) {
    return { ok: false, reason: "authorization_invalid_value" };
  }
  if (typeof r.valid_after !== "string" || !UNIX_SECONDS_RE.test(r.valid_after)) {
    return { ok: false, reason: "authorization_invalid_valid_after" };
  }
  if (
    typeof r.valid_before !== "string" ||
    !UNIX_SECONDS_RE.test(r.valid_before) ||
    r.valid_before === "0"
  ) {
    return { ok: false, reason: "authorization_invalid_valid_before" };
  }
  if (typeof r.nonce !== "string" || !HEX64_RE.test(r.nonce)) {
    return { ok: false, reason: "authorization_invalid_nonce" };
  }
  if (typeof r.signature !== "string" || !ECDSA_SIGNATURE_RE.test(r.signature)) {
    return { ok: false, reason: "authorization_invalid_signature" };
  }

  return {
    ok: true,
    env: {
      scheme: PAYMENT_AUTHORIZATION_SCHEME,
      ...(r.entry_point !== undefined
        ? { entry_point: r.entry_point as AuthorizationEntryPoint }
        : {}),
      chain: r.chain,
      asset: r.asset,
      from: r.from,
      to: r.to,
      value: r.value,
      valid_after: r.valid_after,
      valid_before: r.valid_before,
      nonce: r.nonce,
      signature: r.signature,
    },
  };
}

export async function hireAuthorizationBinding(
  grantHash: string,
  authorization: unknown,
): Promise<Validated<PaymentAuthorizationBinding, HireRefuseDetail>> {
  const shape = validateAuthorizationShape(authorization);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  return {
    ok: true,
    env: {
      schema: SESSION_PAYMENT_AUTHORIZATION_SCHEMA,
      grant_hash: grantHash,
      authorization_hash: await envelopeHash(shape.env),
    },
  };
}

export function authorizationValidBeforeFor(grant: TaskGrantEnvelope): string | null {
  const expiresMs = timestampMs(grant.expires_at);
  if (expiresMs === null) return null;
  return String(Math.floor(expiresMs / 1000));
}

export async function bindAuthorizationToGrant(
  authorization: PaymentAuthorization,
  grant: TaskGrantEnvelope,
  grantHash: string,
): Promise<HireRefuseDetail | null> {
  if (authorization.chain !== grant.price_chain) return "authorization_chain_mismatch";
  if (authorization.asset !== grant.price_asset) return "authorization_asset_mismatch";
  if (authorization.from !== grant.price_payer_account) return "authorization_payer_mismatch";
  if (authorization.to !== grant.price_payee_account) return "authorization_payee_mismatch";

  if (x402SessionAccountSpellingIsUnpayable(grant.price_payer_account)) {
    return "grant_payer_account_not_canonical";
  }
  if (x402SessionAccountSpellingIsUnpayable(grant.price_payee_account)) {
    return "grant_payee_account_not_canonical";
  }

  const vsFloor = compareDecimalStrings(authorization.value, grant.price_min_amount);
  if (vsFloor === null || vsFloor < 0) return "authorization_below_floor";
  const vsCeiling = compareDecimalStrings(authorization.value, grant.price_max_amount);
  if (vsCeiling === null || vsCeiling > 0) return "authorization_over_ceiling";

  const expectedValidBefore = authorizationValidBeforeFor(grant);
  if (expectedValidBefore === null || authorization.valid_before !== expectedValidBefore) {
    return "authorization_expiry_mismatch";
  }

  const issuedMs = timestampMs(grant.issued_at);
  if (issuedMs === null) return "grant_invalid_timestamp";
  if (BigInt(authorization.valid_after) > BigInt(String(Math.floor(issuedMs / 1000)))) {
    return "authorization_valid_after_too_late";
  }

  const expectedNonce = await settlementBindingReference(grantHash);
  if (authorization.nonce !== expectedNonce) return "authorization_binding_mismatch";

  return null;
}

export function validateHireAccepted(
  raw: unknown,
  nowMs: number,
): Validated<SessionHireAccepted, HireRefuseDetail> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "hire_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (r.schema !== SESSION_HIRE_ACCEPTED_SCHEMA) {
    return { ok: false, reason: "hire_schema_mismatch" };
  }
  if (!hasOnlyKeys(r, HIRE_ACCEPTED_KEYS)) {
    return { ok: false, reason: "hire_unexpected_field" };
  }
  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "acceptance_invalid_grant_hash" };
  }
  const acceptance = validateAcceptance(r.acceptance, nowMs);
  if (!acceptance.ok) return { ok: false, reason: acceptance.reason };
  if (!isSignature64(r.acceptance_signature_base64)) {
    return { ok: false, reason: "invalid_acceptance_signature" };
  }
  return {
    ok: true,
    env: {
      schema: SESSION_HIRE_ACCEPTED_SCHEMA,
      grant_hash: r.grant_hash,
      acceptance: acceptance.env,
      acceptance_signature_base64: r.acceptance_signature_base64,
    },
  };
}

export function verifyHireAcceptance(input: {
  accepted: SessionHireAccepted;
  grant: TaskGrantEnvelope;
  grantHash: string;
}): HireRefuseDetail | null {
  if (input.accepted.grant_hash !== input.grantHash) return "acceptance_grant_mismatch";
  if (input.accepted.acceptance.grant_hash !== input.grantHash) return "acceptance_grant_mismatch";
  if (input.accepted.acceptance.redeemer_did !== input.grant.provider_did) {
    return "acceptance_redeemer_mismatch";
  }
  let providerKey: Uint8Array;
  try {
    providerKey = decodeBase64(input.grant.provider_signing_pubkey_base64);
  } catch {
    return "grant_invalid_provider_signing_pubkey";
  }
  if (providerKey.length !== 32) return "grant_invalid_provider_signing_pubkey";
  if (
    !verifyDetached(
      input.accepted.acceptance,
      input.accepted.acceptance_signature_base64,
      providerKey,
    )
  ) {
    return "invalid_acceptance_signature";
  }
  return null;
}

export function validateHireRefused(raw: unknown): Validated<SessionHireRefused, HireRefuseDetail> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "hire_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (r.schema !== SESSION_HIRE_REFUSED_SCHEMA) {
    return { ok: false, reason: "hire_schema_mismatch" };
  }
  if (!hasOnlyKeys(r, HIRE_REFUSED_KEYS)) return { ok: false, reason: "hire_unexpected_field" };
  if (typeof r.reason !== "string" || !HIRE_REFUSE_REASONS.includes(r.reason as HireRefuseReason)) {
    return { ok: false, reason: "hire_unexpected_field" };
  }
  const detail: unknown = r.detail;
  if (typeof detail !== "string" || !/^[a-z0-9_]{1,64}$/.test(detail)) {
    return { ok: false, reason: "hire_unexpected_field" };
  }
  return {
    ok: true,
    env: {
      schema: SESSION_HIRE_REFUSED_SCHEMA,
      reason: r.reason as HireRefuseReason,
      detail,
    },
  };
}

export const HIRE_REFUSE_REASONS: readonly HireRefuseReason[] = [
  "hire_malformed",
  "identity_unresolved",
  "hirer_key_mismatch",
  "invalid_hirer_signature",
  "artifact_binding_broken",
  "not_the_named_provider",
  "authorization_invalid",
  "authorization_entry_point_refused",
  "grant_already_committed",
  "price_below_floor",
  "window_too_short",
  "brief_rejected",
  "service_unavailable",
  "ledger_unavailable",
] as const;

export async function buildHireMessage(
  wire: HireWire,
  authorization: PaymentAuthorization,
  sign: Signer,
): Promise<Validated<SessionHireMessage, HireRefuseDetail>> {
  const grantHash = await envelopeHash(wire.grant);
  const binding = await hireAuthorizationBinding(grantHash, authorization);
  if (!binding.ok) return { ok: false, reason: binding.reason };
  const signature = await signCanonical(binding.env, sign);
  if (signature === null) return { ok: false, reason: "signer_failed" };
  return {
    ok: true,
    env: {
      schema: SESSION_HIRE_SCHEMA,
      offer: wire.offer,
      offer_signature_base64: wire.offer_signature_base64,
      grant: wire.grant,
      grant_signature_base64: wire.grant_signature_base64,
      capsule: wire.capsule,
      authorization,
      authorization_signature_base64: signature,
    },
  };
}
