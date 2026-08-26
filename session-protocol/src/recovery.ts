
import { MAX_CLOCK_SKEW_MS, MIN_NONCE_LENGTH } from "./envelope";
import { signCanonical } from "./sig";
import type { Signer } from "./sig";
import {
  DID_RE,
  HEX64_RE,
  MAX_ACCEPTANCE_TTL_MS,
  RECOVERY_KEYS,
  TASK_RECOVERY_SCHEMA,
  hasOnlyKeys,
  isNonce,
  isPlausibleNowMs,
  timestampMs,
} from "./schemas";
import type { SessionResultRejectReason, TaskRecoveryRequest, Validated } from "./schemas";

export function validateRecoveryRequest(
  raw: unknown,
  nowMs: number,
): Validated<TaskRecoveryRequest, SessionResultRejectReason> {
  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "recovery_invalid_timestamp" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "recovery_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_RECOVERY_SCHEMA) return { ok: false, reason: "recovery_schema_mismatch" };
  if (!hasOnlyKeys(r, RECOVERY_KEYS)) return { ok: false, reason: "recovery_unexpected_field" };

  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "recovery_invalid_grant_hash" };
  }
  if (typeof r.requester_did !== "string" || !DID_RE.test(r.requester_did)) {
    return { ok: false, reason: "recovery_invalid_requester_did" };
  }
  if (!isNonce(r.action_nonce, MIN_NONCE_LENGTH)) {
    return { ok: false, reason: "recovery_invalid_nonce" };
  }

  const issuedAt = timestampMs(r.issued_at);
  const expiresAt = timestampMs(r.expires_at);
  if (issuedAt === null || expiresAt === null) {
    return { ok: false, reason: "recovery_invalid_timestamp" };
  }
  const window = expiresAt - issuedAt;
  if (window <= 0) return { ok: false, reason: "recovery_invalid_timestamp" };
  if (window > MAX_ACCEPTANCE_TTL_MS) return { ok: false, reason: "recovery_window_too_long" };
  if (nowMs < issuedAt - MAX_CLOCK_SKEW_MS) return { ok: false, reason: "recovery_not_yet_valid" };
  if (nowMs > expiresAt) return { ok: false, reason: "recovery_expired" };

  return {
    ok: true,
    env: {
      schema: TASK_RECOVERY_SCHEMA,
      grant_hash: r.grant_hash,
      requester_did: r.requester_did,
      action_nonce: r.action_nonce,
      issued_at: r.issued_at as string,
      expires_at: r.expires_at as string,
    },
  };
}

export async function buildRecoveryRequest(input: {
  grantHash: string;
  requesterDid: string;
  actionNonce: string;
  nowMs: number;
  ttlMs: number;
  sign: Signer;
}): Promise<
  | { ok: true; request: TaskRecoveryRequest; signature_base64: string }
  | { ok: false; reason: SessionResultRejectReason }
> {
  const request: TaskRecoveryRequest = {
    schema: TASK_RECOVERY_SCHEMA,
    grant_hash: input.grantHash,
    requester_did: input.requesterDid,
    action_nonce: input.actionNonce,
    issued_at: new Date(input.nowMs).toISOString(),
    expires_at: new Date(input.nowMs + input.ttlMs).toISOString(),
  };

  const check = validateRecoveryRequest(request, input.nowMs);
  if (!check.ok) return { ok: false, reason: check.reason };

  const signature = await signCanonical(check.env, input.sign);
  if (signature === null) return { ok: false, reason: "invalid_recovery_signature" };
  return { ok: true, request: check.env, signature_base64: signature };
}
