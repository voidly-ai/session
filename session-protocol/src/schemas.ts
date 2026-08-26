
import { MAX_CLOCK_SKEW_MS, MAX_WINDOW_MS, canonicalBytes } from "./envelope";
import {
  CAPSULE_SALT_BYTES,
  MAX_CAPSULE_BODY_BASE64_LENGTH,
  MAX_CAPSULE_BODY_BYTES,
  MAX_SEALED_PAYLOAD_BYTES,
  base64Length,
} from "./wireBudget";
import type { RedemptionAttestation } from "./attestation";
import type { SessionDisputeReceipt } from "./disputeReceipt";
import type { SessionKey } from "./sessionKey";

export const SESSION_OFFER_SCHEMA = "voidly-session-offer/v1";
export const TASK_CAPSULE_SCHEMA = "voidly-task-capsule/v1";
export const TASK_GRANT_SCHEMA = "voidly-task-grant/v1";
export const TASK_ACCEPTANCE_SCHEMA = "voidly-task-acceptance/v1";
export const TASK_BRIEF_SCHEMA = "voidly-task-brief/v1";

export const TASK_RESULT_CAPSULE_SCHEMA = "voidly-task-result-capsule/v1";
export const TASK_RESULT_SCHEMA = "voidly-task-result/v1";
export const TASK_DELIVERY_SCHEMA = "voidly-task-delivery/v1";
export const TASK_RECOVERY_SCHEMA = "voidly-task-recovery/v1";

export const CAPSULE_ALG = "x25519-xsalsa20-poly1305+xsalsa20-poly1305";

export const RESULT_CAPSULE_ALG = "xsalsa20-poly1305";

export const MAX_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_ACCEPTANCE_TTL_MS = MAX_WINDOW_MS;

export const SESSION_RAIL_MIN_CONFIRMATIONS = 12;
export const SESSION_RAIL_BLOCK_TIME_MS = 2_000;
export const MIN_GRANT_TTL_MS =
  SESSION_RAIL_MIN_CONFIRMATIONS * SESSION_RAIL_BLOCK_TIME_MS + MAX_CLOCK_SKEW_MS;

export const MAX_SERVICE_REF_LENGTH = 128;
export const MAX_NONCE_LENGTH = 128;

const BRIEF_SALT_BASE64_LENGTH = base64Length(CAPSULE_SALT_BYTES);
const canonicalPayloadOverhead = (schema: string, field: string): number =>
  canonicalBytes({
    schema,
    [field]: "",
    salt_base64: "A".repeat(BRIEF_SALT_BASE64_LENGTH),
  }).length;

export const MAX_BRIEF_LENGTH =
  MAX_SEALED_PAYLOAD_BYTES -
  Math.max(
    canonicalPayloadOverhead(TASK_BRIEF_SCHEMA, "brief"),
    canonicalPayloadOverhead(TASK_RESULT_SCHEMA, "result"),
  );

export { MAX_CAPSULE_BODY_BYTES, MAX_CAPSULE_BODY_BASE64_LENGTH };

export const MAX_RESULT_LENGTH = MAX_BRIEF_LENGTH;
export const MAX_RESULT_BODY_BYTES = MAX_CAPSULE_BODY_BYTES;
export const MAX_RESULT_BODY_BASE64_LENGTH = MAX_CAPSULE_BODY_BASE64_LENGTH;

export const MAX_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MIN_PLAUSIBLE_NOW_MS = 1_600_000_000_000;
export const MAX_PLAUSIBLE_NOW_MS = 4_102_444_800_000;

export const DID_RE = /^did:voidly:[A-Za-z0-9._-]{1,64}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export type SessionOfferEnvelope = {
  schema: typeof SESSION_OFFER_SCHEMA;
  hirer_did: string;
  hirer_signing_pubkey_base64: string;
  provider_did: string;
  service_ref: string;
  price_chain: string;
  price_asset: string;
  price_payer_account: string;
  price_payee_account: string;
  price_min_amount: string;
  price_max_amount: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
};

export type TaskCapsule = {
  schema: typeof TASK_CAPSULE_SCHEMA;
  alg: typeof CAPSULE_ALG;
  offer_hash: string;
  recipient_enc_pubkey_base64: string;
  ephemeral_pubkey_base64: string;
  wrapped_session_key_base64: string;
  wrap_nonce_base64: string;
  body_nonce_base64: string;
  body_base64: string;
};

export type TaskGrantEnvelope = {
  schema: typeof TASK_GRANT_SCHEMA;
  hirer_did: string;
  provider_did: string;
  provider_signing_pubkey_base64: string;
  provider_enc_pubkey_base64: string;
  offer_hash: string;
  capsule_hash: string;
  brief_commitment: string;
  price_chain: string;
  price_asset: string;
  price_payer_account: string;
  price_payee_account: string;
  price_min_amount: string;
  price_max_amount: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
};

export type TaskAcceptanceEnvelope = {
  schema: typeof TASK_ACCEPTANCE_SCHEMA;
  grant_hash: string;
  redeemer_did: string;
  action_nonce: string;
  issued_at: string;
  expires_at: string;
};

export type TaskResultCapsule = {
  schema: typeof TASK_RESULT_CAPSULE_SCHEMA;
  alg: typeof RESULT_CAPSULE_ALG;
  grant_hash: string;
  body_nonce_base64: string;
  body_base64: string;
};

export type TaskDeliveryReceipt = {
  schema: typeof TASK_DELIVERY_SCHEMA;
  grant_hash: string;
  offer_hash: string;
  provider_did: string;
  result_capsule_hash: string;
  result_commitment: string;
  issued_at: string;
  recoverable_until: string;
};

export type TaskRecoveryRequest = {
  schema: typeof TASK_RECOVERY_SCHEMA;
  grant_hash: string;
  requester_did: string;
  action_nonce: string;
  issued_at: string;
  expires_at: string;
};

export type HireWire = {
  offer: SessionOfferEnvelope;
  offer_signature_base64: string;
  grant: TaskGrantEnvelope;
  grant_signature_base64: string;
  capsule: TaskCapsule;
};

export interface HireKeep {
  sessionKey: SessionKey;
  grant_hash: string;
  offer_hash: string;
  brief_commitment: string;
}

export const OFFER_KEYS = [
  "schema",
  "hirer_did",
  "hirer_signing_pubkey_base64",
  "provider_did",
  "service_ref",
  "price_chain",
  "price_asset",
  "price_payer_account",
  "price_payee_account",
  "price_min_amount",
  "price_max_amount",
  "nonce",
  "issued_at",
  "expires_at",
] as const;

export const CAPSULE_KEYS = [
  "schema",
  "alg",
  "offer_hash",
  "recipient_enc_pubkey_base64",
  "ephemeral_pubkey_base64",
  "wrapped_session_key_base64",
  "wrap_nonce_base64",
  "body_nonce_base64",
  "body_base64",
] as const;

export const GRANT_KEYS = [
  "schema",
  "hirer_did",
  "provider_did",
  "provider_signing_pubkey_base64",
  "provider_enc_pubkey_base64",
  "offer_hash",
  "capsule_hash",
  "brief_commitment",
  "price_chain",
  "price_asset",
  "price_payer_account",
  "price_payee_account",
  "price_min_amount",
  "price_max_amount",
  "nonce",
  "issued_at",
  "expires_at",
] as const;

export const ACCEPTANCE_KEYS = [
  "schema",
  "grant_hash",
  "redeemer_did",
  "action_nonce",
  "issued_at",
  "expires_at",
] as const;

export const RESULT_CAPSULE_KEYS = [
  "schema",
  "alg",
  "grant_hash",
  "body_nonce_base64",
  "body_base64",
] as const;

export const DELIVERY_KEYS = [
  "schema",
  "grant_hash",
  "offer_hash",
  "provider_did",
  "result_capsule_hash",
  "result_commitment",
  "issued_at",
  "recoverable_until",
] as const;

export const RECOVERY_KEYS = [
  "schema",
  "grant_hash",
  "requester_did",
  "action_nonce",
  "issued_at",
  "expires_at",
] as const;

export type AccountSpellingRefuseDetail =
  | "grant_payer_account_not_canonical"
  | "grant_payee_account_not_canonical";

export type RedeemRejectReason =
  | "clock_implausible"
  | "offer_not_object"
  | "offer_schema_mismatch"
  | "offer_unexpected_field"
  | "offer_invalid_hirer_did"
  | "offer_invalid_hirer_pubkey"
  | "offer_invalid_provider_did"
  | "offer_self_hire_not_allowed"
  | "offer_invalid_service_ref"
  | "offer_invalid_price_chain"
  | "offer_invalid_price_asset"
  | "offer_invalid_price_payer_account"
  | "offer_invalid_price_payee_account"
  | "offer_price_chain_mismatch"
  | "offer_invalid_price_amount"
  | "offer_invalid_price_min_amount"
  | "offer_price_band_inverted"
  | "offer_invalid_nonce"
  | "offer_invalid_timestamp"
  | "offer_ttl_too_long"
  | "offer_not_yet_valid"
  | "offer_expired"
  | "grant_not_object"
  | "grant_schema_mismatch"
  | "grant_unexpected_field"
  | "grant_invalid_hirer_did"
  | "grant_invalid_provider_did"
  | "grant_self_hire_not_allowed"
  | "grant_invalid_provider_signing_pubkey"
  | "grant_invalid_provider_enc_pubkey"
  | "grant_invalid_offer_hash"
  | "grant_invalid_capsule_hash"
  | "grant_invalid_brief_commitment"
  | "grant_invalid_price_chain"
  | "grant_invalid_price_asset"
  | "grant_invalid_price_payer_account"
  | "grant_invalid_price_payee_account"
  | "grant_price_chain_mismatch"
  | "grant_invalid_price_amount"
  | "grant_invalid_price_min_amount"
  | "grant_price_band_inverted"
  | "grant_invalid_nonce"
  | "grant_invalid_timestamp"
  | "grant_ttl_too_long"
  | "grant_not_yet_valid"
  | "capsule_not_object"
  | "capsule_schema_mismatch"
  | "capsule_unexpected_field"
  | "capsule_invalid_alg"
  | "capsule_invalid_offer_hash"
  | "capsule_invalid_recipient_pubkey"
  | "capsule_invalid_ephemeral_pubkey"
  | "capsule_invalid_wrapped_key"
  | "capsule_invalid_wrap_nonce"
  | "capsule_invalid_body_nonce"
  | "capsule_invalid_body"
  | "capsule_body_too_large"
  | "acceptance_not_object"
  | "acceptance_schema_mismatch"
  | "acceptance_unexpected_field"
  | "acceptance_invalid_grant_hash"
  | "acceptance_invalid_redeemer_did"
  | "acceptance_invalid_nonce"
  | "acceptance_invalid_timestamp"
  | "acceptance_window_too_long"
  | "acceptance_not_yet_valid"
  | "acceptance_expired"
  | "store_not_serialized"
  | "hirer_did_mismatch"
  | "provider_did_mismatch"
  | "provider_key_mismatch"
  | "hirer_key_mismatch"
  | "invalid_offer_signature"
  | "invalid_grant_signature"
  | "invalid_acceptance_signature"
  | "grant_offer_mismatch"
  | "grant_capsule_mismatch"
  | "capsule_offer_mismatch"
  | "recipient_binding_mismatch"
  | "grant_price_mismatch"
  | "grant_provider_mismatch"
  | "grant_hirer_mismatch"
  | "grant_outlives_offer"
  | "acceptance_grant_mismatch"
  | "acceptance_redeemer_mismatch"
  | "invalid_session_key_length"
  | "invalid_session_key_all_zero"
  | "invalid_ephemeral_secret_length"
  | "invalid_brief_salt_length"
  | "invalid_brief_salt_all_zero"
  | "invalid_ephemeral_secret_all_zero"
  | "invalid_body_nonce_length"
  | "invalid_body_nonce_all_zero"
  | "invalid_wrap_nonce_length"
  | "invalid_wrap_nonce_all_zero"
  | "capsule_frame_failed"
  | "invalid_recipient_enc_pubkey"
  | "brief_too_long"
  | "invalid_ttl"
  | "grant_ttl_below_settlement_depth"
  | "signer_failed"
  | "journal_record_malformed"
  | "settlement_adapter_unknown"
  | "settlement_adapter_misregistered"
  | "settlement_indeterminate"
  | "settlement_unattributable"
  | "settlement_rejected"
  | "settlement_superseded"
  | "settlement_cancelled"
  | "settlement_chain_mismatch"
  | "settlement_asset_mismatch"
  | "settlement_invalid_amount"
  | "settlement_over_ceiling"
  | "settlement_below_floor"
  | "settlement_invalid_evidence_id"
  | "settlement_invalid_payer_account"
  | "settlement_invalid_payee_account"
  | "settlement_payer_mismatch"
  | "settlement_payee_mismatch"
  | "settlement_binding_mismatch"
  | "settlement_evidence_reused";

export type SessionResultRejectReason =
  | "result_capsule_not_object"
  | "result_capsule_schema_mismatch"
  | "result_capsule_unexpected_field"
  | "result_capsule_invalid_alg"
  | "result_capsule_invalid_grant_hash"
  | "result_capsule_invalid_body_nonce"
  | "result_capsule_invalid_body"
  | "result_body_too_large"
  | "result_capsule_grant_mismatch"
  | "result_capsule_not_sealed_frame"
  | "delivery_not_object"
  | "delivery_schema_mismatch"
  | "delivery_unexpected_field"
  | "delivery_invalid_grant_hash"
  | "delivery_invalid_offer_hash"
  | "delivery_invalid_provider_did"
  | "delivery_invalid_result_capsule_hash"
  | "delivery_invalid_result_commitment"
  | "delivery_invalid_timestamp"
  | "delivery_window_too_long"
  | "delivery_not_yet_valid"
  | "invalid_delivery_signature"
  | "delivery_grant_mismatch"
  | "delivery_offer_mismatch"
  | "delivery_provider_mismatch"
  | "delivery_capsule_hash_mismatch"
  | "recovery_not_object"
  | "recovery_schema_mismatch"
  | "recovery_unexpected_field"
  | "recovery_invalid_grant_hash"
  | "recovery_invalid_requester_did"
  | "recovery_invalid_nonce"
  | "recovery_invalid_timestamp"
  | "recovery_window_too_long"
  | "recovery_not_yet_valid"
  | "recovery_expired"
  | "invalid_recovery_signature"
  | "recovery_grant_mismatch"
  | "recovery_requester_not_a_party"
  | "record_malformed";

export type DeliverRejectReason = RedeemRejectReason | SessionResultRejectReason;
export type RecoverRejectReason = RedeemRejectReason | SessionResultRejectReason;

export type Validated<T, R = RedeemRejectReason> =
  | { ok: true; env: T }
  | { ok: false; reason: R };

export function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const k of Object.keys(raw)) {
    if (!allowed.includes(k)) return false;
  }
  return true;
}

export function isBase64Key32(
  value: unknown,
  decode: (s: string) => Uint8Array,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return decode(value).length === 32;
  } catch {
    return false;
  }
}

export function isNonce(value: unknown, minLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= MAX_NONCE_LENGTH;
}

const ISO_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

export function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_UTC_RE.exec(value);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const milli = m[7] === undefined ? 0 : Number(m[7]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const ms = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  if (!Number.isFinite(ms)) return null;

  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

export function isPlausibleNowMs(nowMs: unknown): nowMs is number {
  return (
    typeof nowMs === "number" &&
    Number.isInteger(nowMs) &&
    nowMs >= MIN_PLAUSIBLE_NOW_MS &&
    nowMs <= MAX_PLAUSIBLE_NOW_MS
  );
}

type JsonSafe = string | number | boolean | { [k: string]: JsonSafe } | JsonSafe[];
type AssertWireSafe<T extends JsonSafe> = T;

export type _OfferIsWireSafe = AssertWireSafe<SessionOfferEnvelope>;
export type _GrantIsWireSafe = AssertWireSafe<TaskGrantEnvelope>;
export type _CapsuleIsWireSafe = AssertWireSafe<TaskCapsule>;
export type _AcceptanceIsWireSafe = AssertWireSafe<TaskAcceptanceEnvelope>;
export type _WireIsWireSafe = AssertWireSafe<HireWire>;
export type _ResultCapsuleIsWireSafe = AssertWireSafe<TaskResultCapsule>;
export type _DeliveryIsWireSafe = AssertWireSafe<TaskDeliveryReceipt>;
export type _RecoveryIsWireSafe = AssertWireSafe<TaskRecoveryRequest>;
export type _RedemptionAttestationIsWireSafe = AssertWireSafe<RedemptionAttestation>;
export type _DisputeReceiptIsWireSafe = AssertWireSafe<SessionDisputeReceipt>;
