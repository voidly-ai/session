
import { MAX_CLOCK_SKEW_MS, MIN_NONCE_LENGTH } from "./envelope";
import { signCanonical } from "./sig";
import type { Signer } from "./sig";
import {
  ACCEPTANCE_KEYS,
  DID_RE,
  HEX64_RE,
  MAX_ACCEPTANCE_TTL_MS,
  TASK_ACCEPTANCE_SCHEMA,
  hasOnlyKeys,
  isNonce,
  isPlausibleNowMs,
  timestampMs,
} from "./schemas";
import type { RedeemRejectReason, TaskAcceptanceEnvelope, Validated } from "./schemas";

export function validateAcceptance(
  raw: unknown,
  nowMs: number,
): Validated<TaskAcceptanceEnvelope> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "clock_implausible" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "acceptance_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_ACCEPTANCE_SCHEMA) {
    return { ok: false, reason: "acceptance_schema_mismatch" };
  }
  if (!hasOnlyKeys(r, ACCEPTANCE_KEYS)) {
    return { ok: false, reason: "acceptance_unexpected_field" };
  }
  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "acceptance_invalid_grant_hash" };
  }
  if (typeof r.redeemer_did !== "string" || !DID_RE.test(r.redeemer_did)) {
    return { ok: false, reason: "acceptance_invalid_redeemer_did" };
  }
  if (!isNonce(r.action_nonce, MIN_NONCE_LENGTH)) {
    return { ok: false, reason: "acceptance_invalid_nonce" };
  }

  const issuedAt = timestampMs(r.issued_at);
  const expiresAt = timestampMs(r.expires_at);
  if (issuedAt === null || expiresAt === null) {
    return { ok: false, reason: "acceptance_invalid_timestamp" };
  }
  const window = expiresAt - issuedAt;
  if (window <= 0) return { ok: false, reason: "acceptance_invalid_timestamp" };
  if (window > MAX_ACCEPTANCE_TTL_MS) return { ok: false, reason: "acceptance_window_too_long" };
  if (nowMs < issuedAt - MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "acceptance_not_yet_valid" };
  }
  if (nowMs > expiresAt) return { ok: false, reason: "acceptance_expired" };

  return {
    ok: true,
    env: {
      schema: TASK_ACCEPTANCE_SCHEMA,
      grant_hash: r.grant_hash,
      redeemer_did: r.redeemer_did,
      action_nonce: r.action_nonce,
      issued_at: r.issued_at as string,
      expires_at: r.expires_at as string,
    },
  };
}

export async function buildAcceptance(input: {
  grantHash: string;
  redeemerDid: string;
  actionNonce: string;
  nowMs: number;
  ttlMs: number;
  sign: Signer;
}): Promise<
  | { ok: true; acceptance: TaskAcceptanceEnvelope; signature_base64: string }
  | { ok: false; reason: RedeemRejectReason }
> {
  const acceptance: TaskAcceptanceEnvelope = {
    schema: TASK_ACCEPTANCE_SCHEMA,
    grant_hash: input.grantHash,
    redeemer_did: input.redeemerDid,
    action_nonce: input.actionNonce,
    issued_at: new Date(input.nowMs).toISOString(),
    expires_at: new Date(input.nowMs + input.ttlMs).toISOString(),
  };

  const check = validateAcceptance(acceptance, input.nowMs);
  if (!check.ok) return { ok: false, reason: check.reason };

  const signature = await signCanonical(check.env, input.sign);
  if (signature === null) return { ok: false, reason: "signer_failed" };
  return { ok: true, acceptance: check.env, signature_base64: signature };
}
