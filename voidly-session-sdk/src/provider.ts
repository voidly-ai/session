
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import {
  buildAcceptance,
  buildDeliveryReceipt,
  deriveDidFromSigningKey,
  encodeSessionProviderProof,
  envelopeHash,
  openCapsuleAsProvider,
  sealResult,
  SESSION_PROVIDER_PROOF_HEADER,
  sessionProviderProofEnvelope,
  signCanonical,
  timestampMs,
  validateCapsuleShape,
  validateGrant,
  validateOffer,
  verifyDetached,
} from "./protocol";
import type {
  HireWire,
  ProviderOpenResult,
  SessionKey,
  SessionOfferEnvelope,
  SessionResultRejectReason,
  Signer,
  TaskAcceptanceEnvelope,
  TaskCapsule,
  TaskDeliveryReceipt,
  TaskGrantEnvelope,
  TaskResultCapsule,
} from "./protocol";
import { webCryptoEntropy } from "./entropy";
import type { SessionEntropy } from "./entropy";
import { SessionUsageError } from "./errors";

export type ReviewHireRefusal =
  | "offer_unreadable"
  | "grant_unreadable"
  | "capsule_unreadable"
  | "hirer_key_invalid"
  | "hirer_key_not_derivable"
  | "invalid_offer_signature"
  | "invalid_grant_signature"
  | "grant_offer_mismatch"
  | "grant_capsule_mismatch"
  | "capsule_offer_mismatch"
  | "recipient_binding_mismatch"
  | "grant_price_mismatch"
  | "grant_provider_mismatch"
  | "grant_hirer_mismatch"
  | "grant_outlives_offer"
  | "provider_did_mismatch";

export interface HireTerms {
  readonly serviceRef: string;
  readonly chain: string;
  readonly asset: string;
  readonly payerAccount: string;
  readonly payeeAccount: string;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly grantExpiresAtMs: number;
  readonly offerExpiresAtMs: number;
}

export type ReviewHireResult =
  | {
      ok: true;
      offer: SessionOfferEnvelope;
      grant: TaskGrantEnvelope;
      capsule: TaskCapsule;
      grantHash: string;
      capsuleHash: string;
      offerHash: string;
      terms: HireTerms;
    }
  | { ok: false; reason: ReviewHireRefusal };

export async function reviewHire(input: {
  wire: HireWire;
  expectedProviderDid: string;
  hirerSigningPublicKey: Uint8Array;
  nowMs: number;
}): Promise<ReviewHireResult> {
  const offerCheck = validateOffer(input.wire?.offer, input.nowMs);
  if (!offerCheck.ok) return { ok: false, reason: "offer_unreadable" };
  const offer = offerCheck.env;

  const grantCheck = validateGrant(input.wire?.grant, input.nowMs);
  if (!grantCheck.ok) return { ok: false, reason: "grant_unreadable" };
  const grant = grantCheck.env;

  const capCheck = validateCapsuleShape(input.wire?.capsule);
  if (!capCheck.ok) return { ok: false, reason: "capsule_unreadable" };
  const capsule = capCheck.env;

  if (!(input.hirerSigningPublicKey instanceof Uint8Array) || input.hirerSigningPublicKey.length !== 32) {
    return { ok: false, reason: "hirer_key_invalid" };
  }
  if (deriveDidFromSigningKey(input.hirerSigningPublicKey) !== grant.hirer_did) {
    return { ok: false, reason: "hirer_key_not_derivable" };
  }
  if (!verifyDetached(offer, input.wire.offer_signature_base64, input.hirerSigningPublicKey)) {
    return { ok: false, reason: "invalid_offer_signature" };
  }
  if (!verifyDetached(grant, input.wire.grant_signature_base64, input.hirerSigningPublicKey)) {
    return { ok: false, reason: "invalid_grant_signature" };
  }

  const offerHash = await envelopeHash(offer);
  const grantHash = await envelopeHash(grant);
  const capsuleHash = await envelopeHash(capsule);

  if (grant.offer_hash !== offerHash) return { ok: false, reason: "grant_offer_mismatch" };
  if (grant.capsule_hash !== capsuleHash) return { ok: false, reason: "grant_capsule_mismatch" };
  if (capsule.offer_hash !== grant.offer_hash) return { ok: false, reason: "capsule_offer_mismatch" };
  if (capsule.recipient_enc_pubkey_base64 !== grant.provider_enc_pubkey_base64) {
    return { ok: false, reason: "recipient_binding_mismatch" };
  }

  if (
    grant.price_chain !== offer.price_chain ||
    grant.price_asset !== offer.price_asset ||
    grant.price_payer_account !== offer.price_payer_account ||
    grant.price_payee_account !== offer.price_payee_account ||
    grant.price_min_amount !== offer.price_min_amount ||
    grant.price_max_amount !== offer.price_max_amount
  ) {
    return { ok: false, reason: "grant_price_mismatch" };
  }
  if (grant.provider_did !== offer.provider_did) return { ok: false, reason: "grant_provider_mismatch" };
  if (grant.hirer_did !== offer.hirer_did) return { ok: false, reason: "grant_hirer_mismatch" };

  const grantExpiresAtMs = timestampMs(grant.expires_at);
  const offerExpiresAtMs = timestampMs(offer.expires_at);
  if (grantExpiresAtMs === null || offerExpiresAtMs === null) {
    return { ok: false, reason: "grant_unreadable" };
  }
  if (grantExpiresAtMs > offerExpiresAtMs) return { ok: false, reason: "grant_outlives_offer" };

  if (grant.provider_did !== input.expectedProviderDid) {
    return { ok: false, reason: "provider_did_mismatch" };
  }

  return {
    ok: true,
    offer,
    grant,
    capsule,
    grantHash,
    capsuleHash,
    offerHash,
    terms: {
      serviceRef: offer.service_ref,
      chain: grant.price_chain,
      asset: grant.price_asset,
      payerAccount: grant.price_payer_account,
      payeeAccount: grant.price_payee_account,
      minAmount: grant.price_min_amount,
      maxAmount: grant.price_max_amount,
      grantExpiresAtMs,
      offerExpiresAtMs,
    },
  };
}

export async function acceptHire(input: {
  grantHash: string;
  providerDid: string;
  sign: Signer;
  nowMs: number;
  ttlMs?: number;
  entropy?: SessionEntropy;
}): Promise<
  | { ok: true; acceptance: TaskAcceptanceEnvelope; signature_base64: string }
  | { ok: false; reason: string }
> {
  const e = input.entropy ?? webCryptoEntropy();
  return buildAcceptance({
    grantHash: input.grantHash,
    redeemerDid: input.providerDid,
    actionNonce: e.nonce(),
    nowMs: input.nowMs,
    ttlMs: input.ttlMs ?? 10 * 60_000,
    sign: input.sign,
  });
}

export async function buildRedemptionProofHeader(input: {
  providerDid: string;
  grantHash: string;
  sign: Signer;
  nowMs: number;
  entropy?: SessionEntropy;
}): Promise<{ name: string; value: string }> {
  const e = input.entropy ?? webCryptoEntropy();
  const envelope = sessionProviderProofEnvelope({
    providerDid: input.providerDid,
    grantHash: input.grantHash,
    actionNonce: e.nonce(),
    nowMs: input.nowMs,
  });
  const signature = await signCanonical(envelope, input.sign);
  if (signature === null) {
    throw new SessionUsageError("buildRedemptionProofHeader: the injected signer failed");
  }
  return {
    name: SESSION_PROVIDER_PROOF_HEADER,
    value: encodeSessionProviderProof(envelope, signature),
  };
}

export async function openBrief(input: {
  wire: HireWire;
  attestation: unknown;
  attestationSignatureBase64: string;
  attestorSigningPublicKey: Uint8Array;
  hirerSigningPublicKey: Uint8Array;
  providerDid: string;
  recipientEncSecretKey: Uint8Array;
  nowMs: number;
}): Promise<ProviderOpenResult> {
  return openCapsuleAsProvider({
    capsule: input.wire?.capsule,
    grant: input.wire?.grant,
    grantSignatureBase64: input.wire?.grant_signature_base64,
    hirerSigningPublicKey: input.hirerSigningPublicKey,
    attestation: input.attestation,
    attestationSignatureBase64: input.attestationSignatureBase64,
    attestorSigningPublicKey: input.attestorSigningPublicKey,
    providerDid: input.providerDid,
    recipientEncSecretKey: input.recipientEncSecretKey,
    nowMs: input.nowMs,
  });
}

export async function sealTaskResult(input: {
  result: string;
  grantHash: string;
  sessionKey: SessionKey;
  briefCapsule: TaskCapsule;
  entropy?: SessionEntropy;
}): Promise<{ capsule: TaskResultCapsule; resultCommitment: string; resultCapsuleHash: string }> {
  const e = input.entropy ?? webCryptoEntropy();

  let briefBodyNonce: Uint8Array;
  try {
    briefBodyNonce = decodeBase64(input.briefCapsule.body_nonce_base64);
  } catch {
    throw new SessionUsageError("sealTaskResult: the brief capsule's body nonce is unreadable");
  }
  if (briefBodyNonce.length !== 24) {
    throw new SessionUsageError("sealTaskResult: the brief capsule's body nonce is not 24 bytes");
  }

  let bodyNonce = e.random(24);
  for (let i = 0; i < 4 && encodeBase64(bodyNonce) === input.briefCapsule.body_nonce_base64; i++) {
    bodyNonce = e.random(24);
  }

  const sealed = await sealResult({
    result: input.result,
    grantHash: input.grantHash,
    sessionKey: input.sessionKey,
    resultSalt: e.random(32),
    bodyNonce,
    briefBodyNonce,
  });
  return {
    capsule: sealed.capsule,
    resultCommitment: sealed.resultCommitment,
    resultCapsuleHash: await envelopeHash(sealed.capsule),
  };
}

export async function signDelivery(input: {
  grantHash: string;
  offerHash: string;
  providerDid: string;
  resultCapsuleHash: string;
  resultCommitment: string;
  recoverableUntilMs: number;
  nowMs: number;
  sign: Signer;
}): Promise<
  | { ok: true; receipt: TaskDeliveryReceipt; signature_base64: string }
  | { ok: false; reason: SessionResultRejectReason }
> {
  return buildDeliveryReceipt({
    grantHash: input.grantHash,
    offerHash: input.offerHash,
    providerDid: input.providerDid,
    resultCapsuleHash: input.resultCapsuleHash,
    resultCommitment: input.resultCommitment,
    nowMs: input.nowMs,
    recoverableUntilMs: input.recoverableUntilMs,
    sign: input.sign,
  });
}
