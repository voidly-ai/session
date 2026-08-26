
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import { envelopeHash } from "./envelope";
import { compareDecimalStrings } from "./caip";
import { briefPayloadBytes, sealCapsule, sealedPayloadFitsTransport } from "./capsule";
import { providerIdentityBindingFailure, validateGrant } from "./grant";
import { CAPSULE_NONCE_LENGTH, isAllZero } from "./hash";
import { validateOffer } from "./offer";
import { signCanonical } from "./sig";
import type { Signer } from "./sig";
import { isVerifiedProvider } from "./verifiedProvider";
import type { VerifiedProvider } from "./verifiedProvider";
import type { ProviderTermsRejectReason } from "./providerManifest";
import { x402SessionAccountSpellingIsUnpayable } from "./x402Session";
import {
  MAX_BRIEF_LENGTH,
  MAX_GRANT_TTL_MS,
  MAX_OFFER_TTL_MS,
  MIN_GRANT_TTL_MS,
  SESSION_OFFER_SCHEMA,
  TASK_GRANT_SCHEMA,
  isPlausibleNowMs,
} from "./schemas";
import type {
  AccountSpellingRefuseDetail,
  HireKeep,
  HireWire,
  RedeemRejectReason,
  SessionOfferEnvelope,
  TaskGrantEnvelope,
} from "./schemas";

export type { HireKeep, HireWire } from "./schemas";

export interface PrivateHireInput {
  hirer: { did: string; signingPublicKeyBase64: string; sign: Signer };
  provider: VerifiedProvider;
  service: { ref: string };
  task: { brief: string };
  price: {
    chain: string;
    asset: string;
    payerAccount: string;
    payeeAccount: string;
    minAmount: string;
    maxAmount: string;
  };
  ttl: { offerMs: number; grantMs: number };
  nowMs: number;
  entropy: {
    offerNonce: string;
    grantNonce: string;
    sessionKey: Uint8Array;
    ephemeralSecretKey: Uint8Array;
    briefSalt: Uint8Array;
    bodyNonce: Uint8Array;
    wrapNonce: Uint8Array;
  };
}

export type PrivateHireResult =
  | { ok: true; wire: HireWire; keep: HireKeep }
  | {
      ok: false;
      reason: RedeemRejectReason | ProviderTermsRejectReason | AccountSpellingRefuseDetail;
    };

function copyFixedBytes(value: unknown, expectedLength: number): Uint8Array | null {
  if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) return null;
  const copy = new Uint8Array(value);
  return copy.length === expectedLength ? copy : null;
}

function decodeKey32(base64: unknown): Uint8Array | null {
  if (typeof base64 !== "string") return null;
  try {
    const k = decodeBase64(base64);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

export async function privateHire(input: PrivateHireInput): Promise<PrivateHireResult> {
  const hirer = { ...input.hirer };
  const provider = input.provider;
  const service = { ...input.service };
  const task = { ...input.task };
  const price = { ...input.price };
  const ttl = { ...input.ttl };
  const entropy = { ...input.entropy };
  const nowMs = input.nowMs;

  if (!isPlausibleNowMs(nowMs)) return { ok: false, reason: "clock_implausible" };

  if (typeof task.brief !== "string" || task.brief.length > MAX_BRIEF_LENGTH) {
    return { ok: false, reason: "brief_too_long" };
  }
  if (
    !Number.isInteger(ttl.offerMs) ||
    !Number.isInteger(ttl.grantMs) ||
    ttl.offerMs <= 0 ||
    ttl.grantMs <= 0 ||
    ttl.offerMs > MAX_OFFER_TTL_MS ||
    ttl.grantMs > MAX_GRANT_TTL_MS ||
    ttl.grantMs > ttl.offerMs
  ) {
    return { ok: false, reason: "invalid_ttl" };
  }
  if (ttl.grantMs < MIN_GRANT_TTL_MS) {
    return { ok: false, reason: "grant_ttl_below_settlement_depth" };
  }
  const sessionKey = copyFixedBytes(entropy.sessionKey, 32);
  if (sessionKey === null) {
    return { ok: false, reason: "invalid_session_key_length" };
  }
  if (isAllZero(sessionKey)) {
    return { ok: false, reason: "invalid_session_key_all_zero" };
  }
  const ephemeralSecretKey = copyFixedBytes(entropy.ephemeralSecretKey, 32);
  if (ephemeralSecretKey === null) {
    return { ok: false, reason: "invalid_ephemeral_secret_length" };
  }
  if (isAllZero(ephemeralSecretKey)) {
    return { ok: false, reason: "invalid_ephemeral_secret_all_zero" };
  }
  const briefSalt = copyFixedBytes(entropy.briefSalt, 32);
  if (briefSalt === null) {
    return { ok: false, reason: "invalid_brief_salt_length" };
  }
  if (isAllZero(briefSalt)) {
    return { ok: false, reason: "invalid_brief_salt_all_zero" };
  }
  const bodyNonce = copyFixedBytes(entropy.bodyNonce, CAPSULE_NONCE_LENGTH);
  if (bodyNonce === null) {
    return { ok: false, reason: "invalid_body_nonce_length" };
  }
  if (isAllZero(bodyNonce)) {
    return { ok: false, reason: "invalid_body_nonce_all_zero" };
  }
  const wrapNonce = copyFixedBytes(entropy.wrapNonce, CAPSULE_NONCE_LENGTH);
  if (wrapNonce === null) {
    return { ok: false, reason: "invalid_wrap_nonce_length" };
  }
  if (isAllZero(wrapNonce)) {
    return { ok: false, reason: "invalid_wrap_nonce_all_zero" };
  }
  if (!isVerifiedProvider(provider)) {
    return { ok: false, reason: "provider_not_verified" };
  }
  const manifest = provider.manifest;

  const providerDid = manifest.provider_did;
  const providerSigningKeyBase64 = manifest.signing_public_key_base64;

  const providerBinding = providerIdentityBindingFailure(providerDid, providerSigningKeyBase64);
  if (providerBinding !== null) return { ok: false, reason: providerBinding };

  const providerEncKey = decodeKey32(manifest.encryption_public_key_base64);
  if (!providerEncKey) return { ok: false, reason: "invalid_recipient_enc_pubkey" };

  const offering = manifest.services.find((s) => s.ref === service.ref);
  if (offering === undefined) return { ok: false, reason: "provider_service_not_offered" };

  if (price.chain !== offering.price.chain) {
    return { ok: false, reason: "provider_price_chain_not_offered" };
  }
  if (price.asset !== offering.price.asset) {
    return { ok: false, reason: "provider_price_asset_not_offered" };
  }
  if (price.payeeAccount !== offering.price.payee_account) {
    return { ok: false, reason: "provider_payee_not_manifested" };
  }
  const floorCmp = compareDecimalStrings(price.minAmount, offering.price.min_amount);
  if (floorCmp === null) return { ok: false, reason: "offer_invalid_price_min_amount" };
  if (floorCmp < 0) return { ok: false, reason: "provider_price_below_manifest_floor" };
  const ceilingCmp = compareDecimalStrings(price.maxAmount, offering.price.max_amount);
  if (ceilingCmp === null) return { ok: false, reason: "offer_invalid_price_amount" };
  if (ceilingCmp > 0) return { ok: false, reason: "provider_price_above_manifest_ceiling" };

  if (ttl.grantMs < manifest.grant_ttl_ms.min) {
    return { ok: false, reason: "provider_grant_ttl_below_manifest_floor" };
  }
  if (ttl.grantMs > manifest.grant_ttl_ms.max) {
    return { ok: false, reason: "provider_grant_ttl_above_manifest_ceiling" };
  }

  if (x402SessionAccountSpellingIsUnpayable(price.payerAccount)) {
    return { ok: false, reason: "grant_payer_account_not_canonical" };
  }
  if (x402SessionAccountSpellingIsUnpayable(price.payeeAccount)) {
    return { ok: false, reason: "grant_payee_account_not_canonical" };
  }

  const offer: SessionOfferEnvelope = {
    schema: SESSION_OFFER_SCHEMA,
    hirer_did: hirer.did,
    hirer_signing_pubkey_base64: hirer.signingPublicKeyBase64,
    provider_did: providerDid,
    service_ref: service.ref,
    price_chain: price.chain,
    price_asset: price.asset,
    price_payer_account: price.payerAccount,
    price_payee_account: price.payeeAccount,
    price_min_amount: price.minAmount,
    price_max_amount: price.maxAmount,
    nonce: entropy.offerNonce,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttl.offerMs).toISOString(),
  };
  const offerCheck = validateOffer(offer, nowMs);
  if (!offerCheck.ok) return { ok: false, reason: offerCheck.reason };

  const offerSignature = await signCanonical(offerCheck.env, hirer.sign);
  if (offerSignature === null) return { ok: false, reason: "signer_failed" };
  const offerHash = await envelopeHash(offerCheck.env);

  if (!sealedPayloadFitsTransport(briefPayloadBytes(task.brief, briefSalt))) {
    return { ok: false, reason: "brief_too_long" };
  }

  let sealed: Awaited<ReturnType<typeof sealCapsule>>;
  try {
    sealed = await sealCapsule({
      brief: task.brief,
      offerHash,
      recipientEncPublicKey: providerEncKey,
      sessionKeyBytes: sessionKey,
      ephemeralSecretKey,
      briefSalt,
      bodyNonce,
      wrapNonce,
    });
  } catch {
    return { ok: false, reason: "capsule_frame_failed" };
  }
  const capsuleHash = await envelopeHash(sealed.capsule);

  const grant: TaskGrantEnvelope = {
    schema: TASK_GRANT_SCHEMA,
    hirer_did: hirer.did,
    provider_did: providerDid,
    provider_signing_pubkey_base64: providerSigningKeyBase64,
    provider_enc_pubkey_base64: encodeBase64(providerEncKey),
    offer_hash: offerHash,
    capsule_hash: capsuleHash,
    brief_commitment: sealed.briefCommitment,
    price_chain: price.chain,
    price_asset: price.asset,
    price_payer_account: price.payerAccount,
    price_payee_account: price.payeeAccount,
    price_min_amount: price.minAmount,
    price_max_amount: price.maxAmount,
    nonce: entropy.grantNonce,
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttl.grantMs).toISOString(),
  };
  const grantCheck = validateGrant(grant, nowMs);
  if (!grantCheck.ok) return { ok: false, reason: grantCheck.reason };

  const grantSignature = await signCanonical(grantCheck.env, hirer.sign);
  if (grantSignature === null) return { ok: false, reason: "signer_failed" };
  const grantHash = await envelopeHash(grantCheck.env);

  return {
    ok: true,
    wire: {
      offer: offerCheck.env,
      offer_signature_base64: offerSignature,
      grant: grantCheck.env,
      grant_signature_base64: grantSignature,
      capsule: sealed.capsule,
    },
    keep: {
      sessionKey: sealed.sessionKey,
      grant_hash: grantHash,
      offer_hash: offerHash,
      brief_commitment: sealed.briefCommitment,
    },
  };
}
