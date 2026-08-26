
import { isCaip19, isCaip2, isPositiveDecimalString } from "./caip";
import { DID_RE, HEX64_RE, isPlausibleNowMs, timestampMs } from "./schemas";
import type { Validated } from "./schemas";
import { MAX_EVIDENCE_ID_LENGTH } from "./settlement";

export const REDEMPTION_ATTESTATION_SCHEMA = "voidly-session-redemption-attestation/v1";

export const REDEMPTION_ATTESTATION_KEYS = [
  "schema",
  "grant_hash",
  "capsule_hash",
  "offer_hash",
  "hirer_did",
  "provider_did",
  "evidence_id",
  "settled_chain",
  "settled_asset",
  "settled_amount",
  "redeemed_at",
  "expires_at",
] as const;

export type RedemptionAttestation = {
  schema: typeof REDEMPTION_ATTESTATION_SCHEMA;
  grant_hash: string;
  capsule_hash: string;
  offer_hash: string;
  hirer_did: string;
  provider_did: string;
  evidence_id: string;
  settled_chain: string;
  settled_asset: string;
  settled_amount: string;
  redeemed_at: string;
  expires_at: string;
};

export type ProviderOpenRefusal =
  | "open_clock_implausible"
  | "attestation_not_object"
  | "attestation_schema_mismatch"
  | "attestation_unexpected_field"
  | "attestation_invalid_grant_hash"
  | "attestation_invalid_capsule_hash"
  | "attestation_invalid_offer_hash"
  | "attestation_invalid_hirer_did"
  | "attestation_invalid_provider_did"
  | "attestation_invalid_evidence_id"
  | "attestation_invalid_settled_chain"
  | "attestation_invalid_settled_asset"
  | "attestation_invalid_settled_amount"
  | "attestation_invalid_timestamp"
  | "attestation_not_yet_valid"
  | "attestation_expired"
  | "attestation_outlives_grant"
  | "attestor_key_invalid"
  | "attestation_invalid_signature"
  | "grant_unreadable"
  | "hirer_key_invalid"
  | "hirer_key_not_derivable"
  | "invalid_grant_signature"
  | "attestation_grant_mismatch"
  | "attestation_capsule_mismatch"
  | "attestation_offer_mismatch"
  | "attestation_hirer_mismatch"
  | "attestation_provider_mismatch"
  | "attestation_settlement_mismatch"
  | "attestation_below_agreed_price"
  | "provider_did_mismatch"
  | "capsule_unreadable"
  | "capsule_binding_mismatch"
  | "recipient_binding_mismatch";

export function validateRedemptionAttestation(
  raw: unknown,
  nowMs: number,
): Validated<RedemptionAttestation, ProviderOpenRefusal> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "open_clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "attestation_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== REDEMPTION_ATTESTATION_SCHEMA) {
    return { ok: false, reason: "attestation_schema_mismatch" };
  }
  for (const key of Object.keys(r)) {
    if (!(REDEMPTION_ATTESTATION_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: "attestation_unexpected_field" };
    }
  }
  if (Object.keys(r).length !== REDEMPTION_ATTESTATION_KEYS.length) {
    return { ok: false, reason: "attestation_unexpected_field" };
  }

  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "attestation_invalid_grant_hash" };
  }
  if (typeof r.capsule_hash !== "string" || !HEX64_RE.test(r.capsule_hash)) {
    return { ok: false, reason: "attestation_invalid_capsule_hash" };
  }
  if (typeof r.offer_hash !== "string" || !HEX64_RE.test(r.offer_hash)) {
    return { ok: false, reason: "attestation_invalid_offer_hash" };
  }
  if (typeof r.hirer_did !== "string" || !DID_RE.test(r.hirer_did)) {
    return { ok: false, reason: "attestation_invalid_hirer_did" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "attestation_invalid_provider_did" };
  }
  if (
    typeof r.evidence_id !== "string" ||
    r.evidence_id.length === 0 ||
    r.evidence_id.length > MAX_EVIDENCE_ID_LENGTH
  ) {
    return { ok: false, reason: "attestation_invalid_evidence_id" };
  }
  if (typeof r.settled_chain !== "string" || !isCaip2(r.settled_chain)) {
    return { ok: false, reason: "attestation_invalid_settled_chain" };
  }
  if (typeof r.settled_asset !== "string" || !isCaip19(r.settled_asset)) {
    return { ok: false, reason: "attestation_invalid_settled_asset" };
  }
  if (typeof r.settled_amount !== "string" || !isPositiveDecimalString(r.settled_amount)) {
    return { ok: false, reason: "attestation_invalid_settled_amount" };
  }

  const redeemedAt = timestampMs(r.redeemed_at);
  const expiresAt = timestampMs(r.expires_at);
  if (redeemedAt === null || expiresAt === null) {
    return { ok: false, reason: "attestation_invalid_timestamp" };
  }
  if (expiresAt < redeemedAt) return { ok: false, reason: "attestation_invalid_timestamp" };

  return {
    ok: true,
    env: {
      schema: REDEMPTION_ATTESTATION_SCHEMA,
      grant_hash: r.grant_hash,
      capsule_hash: r.capsule_hash,
      offer_hash: r.offer_hash,
      hirer_did: r.hirer_did,
      provider_did: r.provider_did,
      evidence_id: r.evidence_id,
      settled_chain: r.settled_chain,
      settled_asset: r.settled_asset,
      settled_amount: r.settled_amount,
      redeemed_at: r.redeemed_at as string,
      expires_at: r.expires_at as string,
    },
  };
}

