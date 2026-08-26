
import { decodeBase64 } from "tweetnacl-util";
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
  MAX_OFFER_TTL_MS,
  MAX_SERVICE_REF_LENGTH,
  OFFER_KEYS,
  SESSION_OFFER_SCHEMA,
  hasOnlyKeys,
  isBase64Key32,
  isNonce,
  isPlausibleNowMs,
  timestampMs,
} from "./schemas";
import type { SessionOfferEnvelope, Validated } from "./schemas";

export function validateOffer(raw: unknown, nowMs: number): Validated<SessionOfferEnvelope> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "offer_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== SESSION_OFFER_SCHEMA) return { ok: false, reason: "offer_schema_mismatch" };
  if (!hasOnlyKeys(r, OFFER_KEYS)) return { ok: false, reason: "offer_unexpected_field" };

  if (typeof r.hirer_did !== "string" || !DID_RE.test(r.hirer_did)) {
    return { ok: false, reason: "offer_invalid_hirer_did" };
  }
  if (!isBase64Key32(r.hirer_signing_pubkey_base64, decodeBase64)) {
    return { ok: false, reason: "offer_invalid_hirer_pubkey" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "offer_invalid_provider_did" };
  }
  if (r.hirer_did === r.provider_did) {
    return { ok: false, reason: "offer_self_hire_not_allowed" };
  }
  if (
    typeof r.service_ref !== "string" ||
    r.service_ref.length < 1 ||
    r.service_ref.length > MAX_SERVICE_REF_LENGTH
  ) {
    return { ok: false, reason: "offer_invalid_service_ref" };
  }

  if (typeof r.price_chain !== "string" || !isCaip2(r.price_chain)) {
    return { ok: false, reason: "offer_invalid_price_chain" };
  }
  if (typeof r.price_asset !== "string" || !isCaip19(r.price_asset)) {
    return { ok: false, reason: "offer_invalid_price_asset" };
  }
  if (typeof r.price_payer_account !== "string" || !isCaip10(r.price_payer_account)) {
    return { ok: false, reason: "offer_invalid_price_payer_account" };
  }
  if (typeof r.price_payee_account !== "string" || !isCaip10(r.price_payee_account)) {
    return { ok: false, reason: "offer_invalid_price_payee_account" };
  }
  if (
    caip2Of(r.price_asset) !== r.price_chain ||
    caip2Of(r.price_payer_account) !== r.price_chain ||
    caip2Of(r.price_payee_account) !== r.price_chain
  ) {
    return { ok: false, reason: "offer_price_chain_mismatch" };
  }
  if (typeof r.price_max_amount !== "string" || !isPositiveDecimalString(r.price_max_amount)) {
    return { ok: false, reason: "offer_invalid_price_amount" };
  }
  if (typeof r.price_min_amount !== "string" || !isPositiveDecimalString(r.price_min_amount)) {
    return { ok: false, reason: "offer_invalid_price_min_amount" };
  }
  const band = compareDecimalStrings(r.price_min_amount, r.price_max_amount);
  if (band === null || band > 0) return { ok: false, reason: "offer_price_band_inverted" };

  if (!isNonce(r.nonce, MIN_NONCE_LENGTH)) return { ok: false, reason: "offer_invalid_nonce" };

  const issuedAt = timestampMs(r.issued_at);
  const expiresAt = timestampMs(r.expires_at);
  if (issuedAt === null || expiresAt === null) {
    return { ok: false, reason: "offer_invalid_timestamp" };
  }
  const window = expiresAt - issuedAt;
  if (window <= 0) return { ok: false, reason: "offer_invalid_timestamp" };
  if (window > MAX_OFFER_TTL_MS) return { ok: false, reason: "offer_ttl_too_long" };
  if (nowMs < issuedAt - MAX_CLOCK_SKEW_MS) return { ok: false, reason: "offer_not_yet_valid" };

  return {
    ok: true,
    env: {
      schema: SESSION_OFFER_SCHEMA,
      hirer_did: r.hirer_did,
      hirer_signing_pubkey_base64: r.hirer_signing_pubkey_base64,
      provider_did: r.provider_did,
      service_ref: r.service_ref,
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
