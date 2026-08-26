
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { canonicalBytes, envelopeHash, MAX_CLOCK_SKEW_MS } from "./envelope";
import { deriveDidFromSigningKey } from "./didDerivation";
import { validateRedemptionAttestation } from "./attestation";
import type { ProviderOpenRefusal } from "./attestation";
import { compareDecimalStrings } from "./caip";
import { FRAME_HEADER_LENGTH, frameBucketSize, frameSealedPayload, unframeSealedPayload } from "./frame";
import { MAX_FRAME_BUCKET_BYTES } from "./wireBudget";
import { validateGrant } from "./grant";
import { CAPSULE_NONCE_LENGTH, isAllZero, sha256Hex } from "./hash";
import { exportSessionKeyBytes, importSessionKey } from "./sessionKey";
import type { SessionKey } from "./sessionKey";
import { verifyDetached } from "./sig";
import {
  CAPSULE_ALG,
  CAPSULE_KEYS,
  HEX64_RE,
  MAX_CAPSULE_BODY_BASE64_LENGTH,
  TASK_BRIEF_SCHEMA,
  TASK_CAPSULE_SCHEMA,
  hasOnlyKeys,
  isBase64Key32,
  timestampMs,
} from "./schemas";
import type { TaskCapsule, TaskGrantEnvelope, Validated } from "./schemas";

const SALT_LENGTH = 32;
const WRAPPED_KEY_LENGTH = 48;

export type OpenResult =
  | { kind: "opened"; brief: string; sessionKey: SessionKey }
  | { kind: "unopenable" };

export function briefPayloadBytes(brief: string, briefSalt: Uint8Array): Uint8Array {
  return canonicalBytes({
    schema: TASK_BRIEF_SCHEMA,
    brief,
    salt_base64: encodeBase64(briefSalt),
  });
}

export function sealedPayloadFitsTransport(payload: Uint8Array): boolean {
  return frameBucketSize(FRAME_HEADER_LENGTH + payload.length) <= MAX_FRAME_BUCKET_BYTES;
}

export type ProviderOpenResult =
  | { kind: "opened"; brief: string; sessionKey: SessionKey }
  | { kind: "refused"; reason: ProviderOpenRefusal }
  | { kind: "unopenable" };

export type UnsealResult =
  | { kind: "opened"; bytes: Uint8Array; payload: Uint8Array }
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

export function validateCapsuleShape(raw: unknown): Validated<TaskCapsule> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "capsule_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== TASK_CAPSULE_SCHEMA) return { ok: false, reason: "capsule_schema_mismatch" };
  if (!hasOnlyKeys(r, CAPSULE_KEYS)) return { ok: false, reason: "capsule_unexpected_field" };
  if (r.alg !== CAPSULE_ALG) return { ok: false, reason: "capsule_invalid_alg" };
  if (typeof r.offer_hash !== "string" || !HEX64_RE.test(r.offer_hash)) {
    return { ok: false, reason: "capsule_invalid_offer_hash" };
  }
  if (!isBase64Key32(r.recipient_enc_pubkey_base64, decodeBase64)) {
    return { ok: false, reason: "capsule_invalid_recipient_pubkey" };
  }
  if (!isBase64Key32(r.ephemeral_pubkey_base64, decodeBase64)) {
    return { ok: false, reason: "capsule_invalid_ephemeral_pubkey" };
  }
  if (typeof r.wrapped_session_key_base64 !== "string") {
    return { ok: false, reason: "capsule_invalid_wrapped_key" };
  }
  try {
    if (decodeBase64(r.wrapped_session_key_base64).length !== WRAPPED_KEY_LENGTH) {
      return { ok: false, reason: "capsule_invalid_wrapped_key" };
    }
  } catch {
    return { ok: false, reason: "capsule_invalid_wrapped_key" };
  }
  if (!decodeNonce(r.wrap_nonce_base64)) return { ok: false, reason: "capsule_invalid_wrap_nonce" };
  if (!decodeNonce(r.body_nonce_base64)) return { ok: false, reason: "capsule_invalid_body_nonce" };
  if (typeof r.body_base64 !== "string" || r.body_base64.length === 0) {
    return { ok: false, reason: "capsule_invalid_body" };
  }
  if (r.body_base64.length > MAX_CAPSULE_BODY_BASE64_LENGTH) {
    return { ok: false, reason: "capsule_body_too_large" };
  }
  try {
    if (decodeBase64(r.body_base64).length < 16) return { ok: false, reason: "capsule_invalid_body" };
  } catch {
    return { ok: false, reason: "capsule_invalid_body" };
  }

  return {
    ok: true,
    env: {
      schema: TASK_CAPSULE_SCHEMA,
      alg: CAPSULE_ALG,
      offer_hash: r.offer_hash,
      recipient_enc_pubkey_base64: r.recipient_enc_pubkey_base64,
      ephemeral_pubkey_base64: r.ephemeral_pubkey_base64,
      wrapped_session_key_base64: r.wrapped_session_key_base64,
      wrap_nonce_base64: r.wrap_nonce_base64 as string,
      body_nonce_base64: r.body_nonce_base64 as string,
      body_base64: r.body_base64,
    },
  };
}

export async function sealCapsule(input: {
  brief: string;
  offerHash: string;
  recipientEncPublicKey: Uint8Array;
  sessionKeyBytes: Uint8Array;
  ephemeralSecretKey: Uint8Array;
  briefSalt: Uint8Array;
  bodyNonce: Uint8Array;
  wrapNonce: Uint8Array;
}): Promise<{ capsule: TaskCapsule; sessionKey: SessionKey; briefCommitment: string }> {
  if (input.sessionKeyBytes.length !== 32) {
    throw new Error("sealCapsule: session key must be 32 bytes");
  }
  if (isAllZero(input.sessionKeyBytes)) {
    throw new Error("sealCapsule: session key must not be all zero");
  }
  if (input.ephemeralSecretKey.length !== 32) {
    throw new Error("sealCapsule: ephemeral secret key must be 32 bytes");
  }
  if (isAllZero(input.ephemeralSecretKey)) {
    throw new Error("sealCapsule: ephemeral secret key must not be all zero");
  }
  if (input.briefSalt.length !== SALT_LENGTH) {
    throw new Error("sealCapsule: brief salt must be 32 bytes");
  }
  if (isAllZero(input.briefSalt)) {
    throw new Error("sealCapsule: brief salt must not be all zero");
  }
  if (input.recipientEncPublicKey.length !== 32) {
    throw new Error("sealCapsule: recipient encryption key must be 32 bytes");
  }
  if (input.bodyNonce.length !== CAPSULE_NONCE_LENGTH || isAllZero(input.bodyNonce)) {
    throw new Error("sealCapsule: body nonce must be 24 non-zero bytes");
  }
  if (input.wrapNonce.length !== CAPSULE_NONCE_LENGTH || isAllZero(input.wrapNonce)) {
    throw new Error("sealCapsule: wrap nonce must be 24 non-zero bytes");
  }
  if (!HEX64_RE.test(input.offerHash)) {
    throw new Error("sealCapsule: offer hash must be 64-char lowercase hex");
  }

  const payload = briefPayloadBytes(input.brief, input.briefSalt);
  const sealedBytes = frameSealedPayload(payload, input.offerHash, input.bodyNonce);
  if (!sealedBytes) throw new Error("sealCapsule: could not frame the payload");
  const briefCommitment = await sha256Hex(sealedBytes);

  const body = nacl.secretbox(sealedBytes, input.bodyNonce, input.sessionKeyBytes);

  const ephemeralPublicKey = nacl.box.keyPair.fromSecretKey(input.ephemeralSecretKey).publicKey;
  const wrapped = nacl.box(
    input.sessionKeyBytes,
    input.wrapNonce,
    input.recipientEncPublicKey,
    input.ephemeralSecretKey,
  );

  return {
    capsule: {
      schema: TASK_CAPSULE_SCHEMA,
      alg: CAPSULE_ALG,
      offer_hash: input.offerHash,
      recipient_enc_pubkey_base64: encodeBase64(input.recipientEncPublicKey),
      ephemeral_pubkey_base64: encodeBase64(ephemeralPublicKey),
      wrapped_session_key_base64: encodeBase64(wrapped),
      wrap_nonce_base64: encodeBase64(input.wrapNonce),
      body_nonce_base64: encodeBase64(input.bodyNonce),
      body_base64: encodeBase64(body),
    },
    sessionKey: importSessionKey(input.sessionKeyBytes),
    briefCommitment,
  };
}

export async function openBrandedCapsule(
  capsule: unknown,
  grant: unknown,
  grantHash: string,
  recipientEncSecretKey: Uint8Array,
  nowMs: number,
): Promise<OpenResult> {
  try {
    const shape = validateCapsuleShape(capsule);
    if (!shape.ok) return { kind: "unopenable" };
    const c = shape.env;

    const grantCheck = validateGrant(grant, nowMs);
    if (!grantCheck.ok) return { kind: "unopenable" };
    const g = grantCheck.env;

    if ((await envelopeHash(g)) !== grantHash) return { kind: "unopenable" };

    const expiresMs = timestampMs(g.expires_at);
    if (expiresMs === null) return { kind: "unopenable" };
    if (nowMs > expiresMs) return { kind: "unopenable" };

    if ((await envelopeHash(c)) !== g.capsule_hash) return { kind: "unopenable" };
    if (c.offer_hash !== g.offer_hash) return { kind: "unopenable" };
    if (c.recipient_enc_pubkey_base64 !== g.provider_enc_pubkey_base64) {
      return { kind: "unopenable" };
    }

    return await decryptCapsule(c, g, recipientEncSecretKey);
  } catch {
    return { kind: "unopenable" };
  }
}

async function decryptCapsule(
  c: TaskCapsule,
  g: TaskGrantEnvelope,
  recipientEncSecretKey: Uint8Array,
): Promise<OpenResult> {
  try {
    if (recipientEncSecretKey.length !== 32) return { kind: "unopenable" };

    const ephemeralPublicKey = decodeBase64(c.ephemeral_pubkey_base64);
    const wrapNonce = decodeNonce(c.wrap_nonce_base64);
    if (!wrapNonce) return { kind: "unopenable" };
    const sessionKeyBytes = nacl.box.open(
      decodeBase64(c.wrapped_session_key_base64),
      wrapNonce,
      ephemeralPublicKey,
      recipientEncSecretKey,
    );
    if (!sessionKeyBytes || sessionKeyBytes.length !== 32) return { kind: "unopenable" };

    const sessionKey = importSessionKey(sessionKeyBytes);
    const opened = await unsealBody(c, sessionKey);
    if (opened.kind !== "opened") return { kind: "unopenable" };

    if ((await sha256Hex(opened.bytes)) !== g.brief_commitment) {
      return { kind: "unopenable" };
    }

    const parsed = JSON.parse(new TextDecoder().decode(opened.payload)) as Record<string, unknown>;
    if (parsed.schema !== TASK_BRIEF_SCHEMA || typeof parsed.brief !== "string") {
      return { kind: "unopenable" };
    }
    return { kind: "opened", brief: parsed.brief, sessionKey };
  } catch {
    return { kind: "unopenable" };
  }
}

export async function openCapsuleAsProvider(input: {
  capsule: unknown;
  grant: unknown;
  grantSignatureBase64: string;
  hirerSigningPublicKey: Uint8Array;
  attestation: unknown;
  attestationSignatureBase64: string;
  attestorSigningPublicKey: Uint8Array;
  providerDid: string;
  recipientEncSecretKey: Uint8Array;
  nowMs: number;
}): Promise<ProviderOpenResult> {
  try {
    const attCheck = validateRedemptionAttestation(input.attestation, input.nowMs);
    if (!attCheck.ok) return { kind: "refused", reason: attCheck.reason };
    const att = attCheck.env;

    if (input.attestorSigningPublicKey.length !== 32) {
      return { kind: "refused", reason: "attestor_key_invalid" };
    }
    if (!verifyDetached(att, input.attestationSignatureBase64, input.attestorSigningPublicKey)) {
      return { kind: "refused", reason: "attestation_invalid_signature" };
    }

    const grantCheck = validateGrant(input.grant, input.nowMs);
    if (!grantCheck.ok) return { kind: "refused", reason: "grant_unreadable" };
    const g = grantCheck.env;

    if (input.hirerSigningPublicKey.length !== 32) {
      return { kind: "refused", reason: "hirer_key_invalid" };
    }
    if (deriveDidFromSigningKey(input.hirerSigningPublicKey) !== g.hirer_did) {
      return { kind: "refused", reason: "hirer_key_not_derivable" };
    }
    if (!verifyDetached(g, input.grantSignatureBase64, input.hirerSigningPublicKey)) {
      return { kind: "refused", reason: "invalid_grant_signature" };
    }

    const capCheck = validateCapsuleShape(input.capsule);
    if (!capCheck.ok) return { kind: "refused", reason: "capsule_unreadable" };
    const c = capCheck.env;

    const grantHash = await envelopeHash(g);
    const capsuleHash = await envelopeHash(c);
    if (att.grant_hash !== grantHash) return { kind: "refused", reason: "attestation_grant_mismatch" };
    if (att.capsule_hash !== capsuleHash) {
      return { kind: "refused", reason: "attestation_capsule_mismatch" };
    }
    if (g.capsule_hash !== capsuleHash) return { kind: "refused", reason: "capsule_binding_mismatch" };
    if (att.offer_hash !== g.offer_hash) return { kind: "refused", reason: "attestation_offer_mismatch" };
    if (c.offer_hash !== g.offer_hash) return { kind: "refused", reason: "capsule_binding_mismatch" };
    if (att.hirer_did !== g.hirer_did) return { kind: "refused", reason: "attestation_hirer_mismatch" };

    if (att.provider_did !== g.provider_did) {
      return { kind: "refused", reason: "attestation_provider_mismatch" };
    }
    if (g.provider_did !== input.providerDid) {
      return { kind: "refused", reason: "provider_did_mismatch" };
    }
    if (c.recipient_enc_pubkey_base64 !== g.provider_enc_pubkey_base64) {
      return { kind: "refused", reason: "recipient_binding_mismatch" };
    }

    if (att.settled_chain !== g.price_chain || att.settled_asset !== g.price_asset) {
      return { kind: "refused", reason: "attestation_settlement_mismatch" };
    }
    const belowFloor = compareDecimalStrings(att.settled_amount, g.price_min_amount);
    if (belowFloor === null || belowFloor < 0) {
      return { kind: "refused", reason: "attestation_below_agreed_price" };
    }

    const grantExpiresMs = timestampMs(g.expires_at);
    const attExpiresMs = timestampMs(att.expires_at);
    const attIssuedMs = timestampMs(att.redeemed_at);
    if (grantExpiresMs === null || attExpiresMs === null || attIssuedMs === null) {
      return { kind: "refused", reason: "attestation_invalid_timestamp" };
    }
    if (attExpiresMs > grantExpiresMs) {
      return { kind: "refused", reason: "attestation_outlives_grant" };
    }
    if (input.nowMs < attIssuedMs - MAX_CLOCK_SKEW_MS) {
      return { kind: "refused", reason: "attestation_not_yet_valid" };
    }
    if (input.nowMs > attExpiresMs) return { kind: "refused", reason: "attestation_expired" };

    return await decryptCapsule(c, g, input.recipientEncSecretKey);
  } catch {
    return { kind: "unopenable" };
  }
}

export async function unsealBody(capsule: TaskCapsule, sessionKey: SessionKey): Promise<UnsealResult> {
  try {
    const keyBytes = exportSessionKeyBytes(sessionKey);
    if (!keyBytes || keyBytes.length !== 32) return { kind: "unopenable" };
    const bodyNonce = decodeNonce(capsule.body_nonce_base64);
    if (!bodyNonce) return { kind: "unopenable" };
    const opened = nacl.secretbox.open(decodeBase64(capsule.body_base64), bodyNonce, keyBytes);
    if (!opened) return { kind: "unopenable" };
    const payload = unframeSealedPayload(opened, capsule.offer_hash, bodyNonce);
    if (!payload) return { kind: "unopenable" };
    return { kind: "opened", bytes: opened, payload };
  } catch {
    return { kind: "unopenable" };
  }
}

