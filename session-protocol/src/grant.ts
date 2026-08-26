
import { decodeBase64 } from "tweetnacl-util";
import { deriveDidFromSigningKey } from "./didDerivation";
import { MAX_CLOCK_SKEW_MS, MIN_NONCE_LENGTH } from "./envelope";
import {
  caip2Of,
  compareDecimalStrings,
  isCaip10,
  isCaip19,
  isCaip2,
  isPositiveDecimalString,
} from "./caip";
import {
  DID_RE,
  GRANT_KEYS,
  HEX64_RE,
  MAX_GRANT_TTL_MS,
  MIN_GRANT_TTL_MS,
  TASK_GRANT_SCHEMA,
  hasOnlyKeys,
  isBase64Key32,
  isNonce,
  isPlausibleNowMs,
  timestampMs,
} from "./schemas";
import type { RedeemRejectReason, TaskGrantEnvelope, Validated } from "./schemas";

export type ProviderIdentityBindingFailure = Extract<
  RedeemRejectReason,
  "grant_invalid_provider_did" | "grant_invalid_provider_signing_pubkey" | "provider_key_mismatch"
>;

export function providerIdentityBindingFailure(
  providerDid: unknown,
  providerSigningPubkeyBase64: unknown,
): ProviderIdentityBindingFailure | null {
  if (typeof providerDid !== "string" || !DID_RE.test(providerDid)) {
    return "grant_invalid_provider_did";
  }
  if (!isBase64Key32(providerSigningPubkeyBase64, decodeBase64)) {
    return "grant_invalid_provider_signing_pubkey";
  }
  let derived: string | null = null;
  try {
    derived = deriveDidFromSigningKey(decodeBase64(providerSigningPubkeyBase64));
  } catch {
    derived = null;
  }
  if (derived === null || derived !== providerDid) return "provider_key_mismatch";
  return null;
}

export function validateGrant(raw: unknown, nowMs: number): Validated<TaskGrantEnvelope> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "grant_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_GRANT_SCHEMA) return { ok: false, reason: "grant_schema_mismatch" };
  if (!hasOnlyKeys(r, GRANT_KEYS)) return { ok: false, reason: "grant_unexpected_field" };

  if (typeof r.hirer_did !== "string" || !DID_RE.test(r.hirer_did)) {
    return { ok: false, reason: "grant_invalid_hirer_did" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "grant_invalid_provider_did" };
  }
  if (r.hirer_did === r.provider_did) {
    return { ok: false, reason: "grant_self_hire_not_allowed" };
  }
  if (!isBase64Key32(r.provider_signing_pubkey_base64, decodeBase64)) {
    return { ok: false, reason: "grant_invalid_provider_signing_pubkey" };
  }
  if (!isBase64Key32(r.provider_enc_pubkey_base64, decodeBase64)) {
    return { ok: false, reason: "grant_invalid_provider_enc_pubkey" };
  }
  const providerBinding = providerIdentityBindingFailure(
    r.provider_did,
    r.provider_signing_pubkey_base64,
  );
  if (providerBinding !== null) return { ok: false, reason: providerBinding };

  if (typeof r.offer_hash !== "string" || !HEX64_RE.test(r.offer_hash)) {
    return { ok: false, reason: "grant_invalid_offer_hash" };
  }
  if (typeof r.capsule_hash !== "string" || !HEX64_RE.test(r.capsule_hash)) {
    return { ok: false, reason: "grant_invalid_capsule_hash" };
  }
  if (typeof r.brief_commitment !== "string" || !HEX64_RE.test(r.brief_commitment)) {
    return { ok: false, reason: "grant_invalid_brief_commitment" };
  }

  if (typeof r.price_chain !== "string" || !isCaip2(r.price_chain)) {
    return { ok: false, reason: "grant_invalid_price_chain" };
  }
  if (typeof r.price_asset !== "string" || !isCaip19(r.price_asset)) {
    return { ok: false, reason: "grant_invalid_price_asset" };
  }
  if (typeof r.price_payer_account !== "string" || !isCaip10(r.price_payer_account)) {
    return { ok: false, reason: "grant_invalid_price_payer_account" };
  }
  if (typeof r.price_payee_account !== "string" || !isCaip10(r.price_payee_account)) {
    return { ok: false, reason: "grant_invalid_price_payee_account" };
  }
  if (
    caip2Of(r.price_asset) !== r.price_chain ||
    caip2Of(r.price_payer_account) !== r.price_chain ||
    caip2Of(r.price_payee_account) !== r.price_chain
  ) {
    return { ok: false, reason: "grant_price_chain_mismatch" };
  }
  if (typeof r.price_max_amount !== "string" || !isPositiveDecimalString(r.price_max_amount)) {
    return { ok: false, reason: "grant_invalid_price_amount" };
  }
  if (typeof r.price_min_amount !== "string" || !isPositiveDecimalString(r.price_min_amount)) {
    return { ok: false, reason: "grant_invalid_price_min_amount" };
  }
  const band = compareDecimalStrings(r.price_min_amount, r.price_max_amount);
  if (band === null || band > 0) return { ok: false, reason: "grant_price_band_inverted" };

  if (!isNonce(r.nonce, MIN_NONCE_LENGTH)) return { ok: false, reason: "grant_invalid_nonce" };

  const issuedAt = timestampMs(r.issued_at);
  const expiresAt = timestampMs(r.expires_at);
  if (issuedAt === null || expiresAt === null) {
    return { ok: false, reason: "grant_invalid_timestamp" };
  }
  const window = expiresAt - issuedAt;
  if (window <= 0) return { ok: false, reason: "grant_invalid_timestamp" };
  if (window > MAX_GRANT_TTL_MS) return { ok: false, reason: "grant_ttl_too_long" };
  if (window < MIN_GRANT_TTL_MS) return { ok: false, reason: "grant_ttl_below_settlement_depth" };
  if (nowMs < issuedAt - MAX_CLOCK_SKEW_MS) return { ok: false, reason: "grant_not_yet_valid" };

  return {
    ok: true,
    env: {
      schema: TASK_GRANT_SCHEMA,
      hirer_did: r.hirer_did,
      provider_did: r.provider_did,
      provider_signing_pubkey_base64: r.provider_signing_pubkey_base64,
      provider_enc_pubkey_base64: r.provider_enc_pubkey_base64,
      offer_hash: r.offer_hash,
      capsule_hash: r.capsule_hash,
      brief_commitment: r.brief_commitment,
      price_chain: r.price_chain,
      price_asset: r.price_asset,
      price_payer_account: r.price_payer_account,
      price_payee_account: r.price_payee_account,
      price_min_amount: r.price_min_amount,
      price_max_amount: r.price_max_amount,
      nonce: r.nonce,
      issued_at: r.issued_at as string,
      expires_at: r.expires_at as string,
    },
  };
}
