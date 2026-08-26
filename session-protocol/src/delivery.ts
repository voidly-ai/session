
import { MAX_CLOCK_SKEW_MS } from "./envelope";
import { signCanonical } from "./sig";
import type { Signer } from "./sig";
import {
  DELIVERY_KEYS,
  DID_RE,
  HEX64_RE,
  MAX_GRANT_TTL_MS,
  MAX_RECOVERY_TTL_MS,
  TASK_DELIVERY_SCHEMA,
  hasOnlyKeys,
  isPlausibleNowMs,
  timestampMs,
} from "./schemas";
import type { SessionResultRejectReason, TaskDeliveryReceipt, Validated } from "./schemas";

export function validateDeliveryReceipt(
  raw: unknown,
  nowMs: number,
): Validated<TaskDeliveryReceipt, SessionResultRejectReason> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "delivery_invalid_timestamp" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "delivery_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_DELIVERY_SCHEMA) return { ok: false, reason: "delivery_schema_mismatch" };
  if (!hasOnlyKeys(r, DELIVERY_KEYS)) return { ok: false, reason: "delivery_unexpected_field" };

  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "delivery_invalid_grant_hash" };
  }
  if (typeof r.offer_hash !== "string" || !HEX64_RE.test(r.offer_hash)) {
    return { ok: false, reason: "delivery_invalid_offer_hash" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "delivery_invalid_provider_did" };
  }
  if (typeof r.result_capsule_hash !== "string" || !HEX64_RE.test(r.result_capsule_hash)) {
    return { ok: false, reason: "delivery_invalid_result_capsule_hash" };
  }
  if (typeof r.result_commitment !== "string" || !HEX64_RE.test(r.result_commitment)) {
    return { ok: false, reason: "delivery_invalid_result_commitment" };
  }

  const issuedAt = timestampMs(r.issued_at);
  const recoverableUntil = timestampMs(r.recoverable_until);
  if (issuedAt === null || recoverableUntil === null) {
    return { ok: false, reason: "delivery_invalid_timestamp" };
  }
  const window = recoverableUntil - issuedAt;
  if (window <= 0) return { ok: false, reason: "delivery_invalid_timestamp" };
  if (window > MAX_RECOVERY_TTL_MS + MAX_GRANT_TTL_MS) {
    return { ok: false, reason: "delivery_window_too_long" };
  }
  if (nowMs < issuedAt - MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "delivery_not_yet_valid" };
  }

  return {
    ok: true,
    env: {
      schema: TASK_DELIVERY_SCHEMA,
      grant_hash: r.grant_hash,
      offer_hash: r.offer_hash,
      provider_did: r.provider_did,
      result_capsule_hash: r.result_capsule_hash,
      result_commitment: r.result_commitment,
      issued_at: r.issued_at as string,
      recoverable_until: r.recoverable_until as string,
    },
  };
}

export async function buildDeliveryReceipt(input: {
  grantHash: string;
  offerHash: string;
  providerDid: string;
  resultCapsuleHash: string;
  resultCommitment: string;
  nowMs: number;
  recoverableUntilMs: number;
  sign: Signer;
}): Promise<
  | { ok: true; receipt: TaskDeliveryReceipt; signature_base64: string }
  | { ok: false; reason: SessionResultRejectReason }
> {
  if (!isPlausibleNowMs(input.recoverableUntilMs)) {
    return { ok: false, reason: "delivery_invalid_timestamp" };
  }
  const receipt: TaskDeliveryReceipt = {
    schema: TASK_DELIVERY_SCHEMA,
    grant_hash: input.grantHash,
    offer_hash: input.offerHash,
    provider_did: input.providerDid,
    result_capsule_hash: input.resultCapsuleHash,
    result_commitment: input.resultCommitment,
    issued_at: new Date(input.nowMs).toISOString(),
    recoverable_until: new Date(input.recoverableUntilMs).toISOString(),
  };

  const check = validateDeliveryReceipt(receipt, input.nowMs);
  if (!check.ok) return { ok: false, reason: check.reason };

  const signature = await signCanonical(check.env, input.sign);
  if (signature === null) return { ok: false, reason: "invalid_delivery_signature" };
  return { ok: true, receipt: check.env, signature_base64: signature };
}
