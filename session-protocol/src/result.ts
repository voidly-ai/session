
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { canonicalBytes } from "./envelope";
import { sealedPayloadFitsTransport } from "./capsule";
import { frameSealedPayload, unframeSealedPayload } from "./frame";
import { CAPSULE_NONCE_LENGTH, isAllZero, sha256Hex } from "./hash";
import { exportSessionKeyBytes } from "./sessionKey";
import type { SessionKey } from "./sessionKey";
import {
  HEX64_RE,
  MAX_RESULT_BODY_BASE64_LENGTH,
  MAX_RESULT_LENGTH,
  RESULT_CAPSULE_ALG,
  RESULT_CAPSULE_KEYS,
  TASK_RESULT_CAPSULE_SCHEMA,
  TASK_RESULT_SCHEMA,
  hasOnlyKeys,
} from "./schemas";
import type { SessionResultRejectReason, TaskResultCapsule, Validated } from "./schemas";

const SALT_LENGTH = 32;

export function resultPayloadBytes(result: string, resultSalt: Uint8Array): Uint8Array {
  return canonicalBytes({
    schema: TASK_RESULT_SCHEMA,
    result,
    salt_base64: encodeBase64(resultSalt),
  });
}

const MEASUREMENT_SALT = new Uint8Array(SALT_LENGTH);

export function resultFitsTransport(result: string): boolean {
  return sealedPayloadFitsTransport(resultPayloadBytes(result, MEASUREMENT_SALT));
}

export type OpenResultOutcome =
  | { kind: "opened"; result: string }
  | { kind: "unopenable" };

function decodeNonce(base64: unknown): Uint8Array | null {
  if (typeof base64 !== "string" || base64.length === 0) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return null;
  }
  if (bytes.length !== CAPSULE_NONCE_LENGTH) return null;
  if (isAllZero(bytes)) return null;
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function validateResultCapsuleShape(
  raw: unknown,
): Validated<TaskResultCapsule, SessionResultRejectReason> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "result_capsule_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_RESULT_CAPSULE_SCHEMA) {
    return { ok: false, reason: "result_capsule_schema_mismatch" };
  }
  if (!hasOnlyKeys(r, RESULT_CAPSULE_KEYS)) {
    return { ok: false, reason: "result_capsule_unexpected_field" };
  }
  if (r.alg !== RESULT_CAPSULE_ALG) return { ok: false, reason: "result_capsule_invalid_alg" };
  if (typeof r.grant_hash !== "string" || !HEX64_RE.test(r.grant_hash)) {
    return { ok: false, reason: "result_capsule_invalid_grant_hash" };
  }
  if (!decodeNonce(r.body_nonce_base64)) {
    return { ok: false, reason: "result_capsule_invalid_body_nonce" };
  }
  if (typeof r.body_base64 !== "string" || r.body_base64.length === 0) {
    return { ok: false, reason: "result_capsule_invalid_body" };
  }
  if (r.body_base64.length > MAX_RESULT_BODY_BASE64_LENGTH) {
    return { ok: false, reason: "result_body_too_large" };
  }
  try {
    if (decodeBase64(r.body_base64).length < 16) {
      return { ok: false, reason: "result_capsule_invalid_body" };
    }
  } catch {
    return { ok: false, reason: "result_capsule_invalid_body" };
  }

  return {
    ok: true,
    env: {
      schema: TASK_RESULT_CAPSULE_SCHEMA,
      alg: RESULT_CAPSULE_ALG,
      grant_hash: r.grant_hash,
      body_nonce_base64: r.body_nonce_base64 as string,
      body_base64: r.body_base64,
    },
  };
}

export async function sealResult(input: {
  result: string;
  grantHash: string;
  sessionKey: SessionKey;
  resultSalt: Uint8Array;
  bodyNonce: Uint8Array;
  briefBodyNonce: Uint8Array;
}): Promise<{ capsule: TaskResultCapsule; resultCommitment: string }> {
  if (typeof input.result !== "string" || input.result.length > MAX_RESULT_LENGTH) {
    throw new Error("sealResult: result is too long");
  }
  if (!HEX64_RE.test(input.grantHash)) {
    throw new Error("sealResult: grant hash must be 64-char lowercase hex");
  }
  if (!(input.resultSalt instanceof Uint8Array) || input.resultSalt.length !== SALT_LENGTH) {
    throw new Error("sealResult: result salt must be 32 bytes");
  }
  if (isAllZero(input.resultSalt)) {
    throw new Error("sealResult: result salt must not be all zero");
  }
  if (
    !(input.bodyNonce instanceof Uint8Array) ||
    input.bodyNonce.length !== CAPSULE_NONCE_LENGTH ||
    isAllZero(input.bodyNonce)
  ) {
    throw new Error("sealResult: body nonce must be 24 non-zero bytes");
  }
  if (
    !(input.briefBodyNonce instanceof Uint8Array) ||
    input.briefBodyNonce.length !== CAPSULE_NONCE_LENGTH
  ) {
    throw new Error("sealResult: the brief body nonce must be 24 bytes");
  }
  if (sameBytes(input.bodyNonce, input.briefBodyNonce)) {
    throw new Error("sealResult: body nonce repeats the brief capsule's — a two-time pad");
  }

  const keyBytes = exportSessionKeyBytes(input.sessionKey);
  if (!keyBytes || keyBytes.length !== 32) {
    throw new Error("sealResult: session key is unavailable");
  }

  const payload = resultPayloadBytes(input.result, input.resultSalt);
  if (!sealedPayloadFitsTransport(payload)) {
    throw new Error("sealResult: the sealed result exceeds the session transport ceiling");
  }
  const sealedBytes = frameSealedPayload(payload, input.grantHash, input.bodyNonce);
  if (!sealedBytes) throw new Error("sealResult: could not frame the payload");
  const resultCommitment = await sha256Hex(sealedBytes);

  const body = nacl.secretbox(sealedBytes, input.bodyNonce, keyBytes);

  return {
    capsule: {
      schema: TASK_RESULT_CAPSULE_SCHEMA,
      alg: RESULT_CAPSULE_ALG,
      grant_hash: input.grantHash,
      body_nonce_base64: encodeBase64(input.bodyNonce),
      body_base64: encodeBase64(body),
    },
    resultCommitment,
  };
}

export async function openResult(
  capsule: unknown,
  sessionKey: SessionKey,
  grantHash: string,
  expectedCommitment: string,
): Promise<OpenResultOutcome> {
  try {
    const shape = validateResultCapsuleShape(capsule);
    if (!shape.ok) return { kind: "unopenable" };
    const c = shape.env;

    if (!HEX64_RE.test(grantHash) || c.grant_hash !== grantHash) return { kind: "unopenable" };
    if (!HEX64_RE.test(expectedCommitment)) return { kind: "unopenable" };

    const keyBytes = exportSessionKeyBytes(sessionKey);
    if (!keyBytes || keyBytes.length !== 32) return { kind: "unopenable" };

    const bodyNonce = decodeNonce(c.body_nonce_base64);
    if (!bodyNonce) return { kind: "unopenable" };

    const opened = nacl.secretbox.open(decodeBase64(c.body_base64), bodyNonce, keyBytes);
    if (!opened) return { kind: "unopenable" };

    const payload = unframeSealedPayload(opened, grantHash, bodyNonce);
    if (!payload) return { kind: "unopenable" };

    if ((await sha256Hex(opened)) !== expectedCommitment) return { kind: "unopenable" };

    const parsed = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (parsed.schema !== TASK_RESULT_SCHEMA || typeof parsed.result !== "string") {
      return { kind: "unopenable" };
    }
    return { kind: "opened", result: parsed.result };
  } catch {
    return { kind: "unopenable" };
  }
}
