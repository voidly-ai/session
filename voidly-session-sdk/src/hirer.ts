
import { decodeBase64 } from "tweetnacl-util";
import {
  authorizationValidBeforeFor,
  bindAuthorizationToGrant,
  buildHireMessage,
  buildRecoveryRequest,
  envelopeHash,
  hireAuthorizationBinding,
  openResult,
  PAYMENT_AUTHORIZATION_SCHEME,
  postHire,
  preflightFacilitator,
  privateHire,
  settlementBindingReference,
  signCanonical,
  validateAuthorizationShape,
  validateDeliveryReceipt,
  validateGrant,
  validateHireAccepted,
  verifyDetached,
  verifyHireAcceptance,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
} from "./protocol";
import type {
  AuthorizationEntryPoint,
  FacilitatorPreflightResult,
  FetchLike,
  HireKeep,
  HireRefuseDetail,
  AccountSpellingRefuseDetail,
  HireWire,
  PaymentAuthorization,
  PostHireOutcome,
  ProviderTermsRejectReason,
  RedeemRejectReason,
  SessionHireAccepted,
  SessionHireRefused,
  SessionKey,
  VerifiedProvider,
  SessionResultRejectReason,
  Signer,
  TaskDeliveryReceipt,
  TaskGrantEnvelope,
} from "./protocol";
import {
  createFacilitatorSubmitter,
  createSelfSubmitter,
  preflightAdmitsPayment,
  signReceiveAuthorization,
  signTransferAuthorization,
} from "./submission";
import type {
  BroadcastTx,
  PaymentSubmitter,
  SignedReceiveAuthorization,
  SignedTransferAuthorization,
  SignReceiveTypedData,
  SignRefusal,
  SignTypedData,
  SubmitRefusal,
} from "./submission";
import { buildSettlementHint } from "./settlementHint";
import type { SettlementHintEnvelope } from "./settlementHint";
import { postRecover } from "./transport";
import type { SessionEndpoint } from "./transport";
import { SessionTransportError } from "./errors";
import { webCryptoEntropy } from "./entropy";
import type { SessionEntropy } from "./entropy";

export type BuildHireResult =
  | { ok: true; wire: HireWire; keep: HireKeep }
  | {
      ok: false;
      reason:
        | RedeemRejectReason
        | AccountSpellingRefuseDetail
        | ProviderTermsRejectReason;
    };

export async function buildHire(input: {
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
  entropy?: SessionEntropy;
}): Promise<BuildHireResult> {
  const e = input.entropy ?? webCryptoEntropy();
  return privateHire({
    hirer: input.hirer,
    provider: input.provider,
    service: input.service,
    task: input.task,
    price: input.price,
    ttl: input.ttl,
    nowMs: input.nowMs,
    entropy: {
      offerNonce: e.nonce(),
      grantNonce: e.nonce(),
      sessionKey: e.random(32),
      ephemeralSecretKey: e.random(32),
      briefSalt: e.random(32),
      bodyNonce: e.random(24),
      wrapNonce: e.random(24),
    },
  });
}

export type VerifyDeliveryResult =
  | { ok: true; receipt: TaskDeliveryReceipt }
  | { ok: false; reason: SessionResultRejectReason | "delivery_grant_mismatch" };

export function verifyDeliveryReceipt(input: {
  receipt: unknown;
  signatureBase64: string;
  grant: TaskGrantEnvelope;
  grantHash: string;
  nowMs: number;
}): VerifyDeliveryResult {
  const grantCheck = validateGrant(input.grant, input.nowMs);
  if (!grantCheck.ok) return { ok: false, reason: "delivery_grant_mismatch" };
  const g = grantCheck.env;

  const check = validateDeliveryReceipt(input.receipt, input.nowMs);
  if (!check.ok) return { ok: false, reason: check.reason };
  const receipt = check.env;

  if (receipt.grant_hash !== input.grantHash) return { ok: false, reason: "delivery_grant_mismatch" };
  if (receipt.offer_hash !== g.offer_hash) return { ok: false, reason: "delivery_grant_mismatch" };
  if (receipt.provider_did !== g.provider_did) return { ok: false, reason: "delivery_grant_mismatch" };

  let providerKey: Uint8Array;
  try {
    providerKey = decodeBase64(g.provider_signing_pubkey_base64);
  } catch {
    return { ok: false, reason: "invalid_delivery_signature" };
  }
  if (providerKey.length !== 32) return { ok: false, reason: "invalid_delivery_signature" };
  if (!verifyDetached(receipt, input.signatureBase64, providerKey)) {
    return { ok: false, reason: "invalid_delivery_signature" };
  }
  return { ok: true, receipt };
}

export async function openTaskResult(input: {
  resultCapsule: unknown;
  sessionKey: SessionKey;
  grantHash: string;
  resultCommitment: string;
}): Promise<{ kind: "opened"; result: string } | { kind: "unopenable" }> {
  return openResult(input.resultCapsule, input.sessionKey, input.grantHash, input.resultCommitment);
}

export async function hashArtifact(artifact: object): Promise<string> {
  return envelopeHash(artifact);
}

export type HirePaymentRefusal = SignRefusal | HireRefuseDetail | "grant_hash_mismatch";

const GRANT_HASH_RE = /^[0-9a-f]{64}$/;

const UNSIGNED_PLACEHOLDER_SIGNATURE = `0x${"00".repeat(65)}`;

async function checkGrantHashAnchor(
  grant: TaskGrantEnvelope,
  grantHash: string,
): Promise<"grant_hash_mismatch" | null> {
  if (typeof grantHash !== "string" || !GRANT_HASH_RE.test(grantHash)) {
    return "grant_hash_mismatch";
  }
  let recomputed: string;
  try {
    recomputed = await envelopeHash(grant as unknown as object);
  } catch {
    return "grant_hash_mismatch";
  }
  return recomputed === grantHash ? null : "grant_hash_mismatch";
}

interface PreparedHirePayment {
  /** Unix SECONDS as a decimal string, floored from the grant's expiry. */
  readonly validBefore: string;
}

async function prepareHirePayment(input: {
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly entryPoint: AuthorizationEntryPoint;
}): Promise<
  { ok: true; prepared: PreparedHirePayment } | { ok: false; reason: HirePaymentRefusal; detail: string }
> {
  const { grant, grantHash, entryPoint } = input;

  const anchor = await checkGrantHashAnchor(grant, grantHash);
  if (anchor !== null) {
    return {
      ok: false,
      reason: anchor,
      detail:
        "the grant handed in does not hash to the grantHash the payment would be bound " +
        "to. `grant_hash` IS `envelopeHash(grant)`, so these two cannot legitimately " +
        "disagree — one of them is a stale, re-parsed or edited copy. Refusing here is " +
        "what stops a payment being signed for one set of terms and bound to another.",
    };
  }

  const validBefore = authorizationValidBeforeFor(grant);
  if (validBefore === null) {
    return {
      ok: false,
      reason: "authorization_expiry_mismatch",
      detail: "the grant's `expires_at` is not a timestamp this rail can read.",
    };
  }

  const candidate: PaymentAuthorization = {
    scheme: PAYMENT_AUTHORIZATION_SCHEME,
    entry_point: entryPoint,
    chain: grant.price_chain,
    asset: grant.price_asset,
    from: grant.price_payer_account,
    to: grant.price_payee_account,
    value: grant.price_min_amount,
    valid_after: "0",
    valid_before: validBefore,
    nonce: await settlementBindingReference(grantHash),
    signature: UNSIGNED_PLACEHOLDER_SIGNATURE,
  };

  const shape = validateAuthorizationShape(candidate);
  if (!shape.ok) {
    return {
      ok: false,
      reason: shape.reason,
      detail: `the payment this grant derives is not a well-formed authorization: ${shape.reason}. Nothing was signed.`,
    };
  }
  const bound = await bindAuthorizationToGrant(shape.env, grant, grantHash);
  if (bound !== null) {
    return {
      ok: false,
      reason: bound,
      detail:
        `the payment this grant derives does not bind to it: ${bound}. Nothing was signed, ` +
        "so the grant's binding nonce is still free and a corrected hire can still be paid.",
    };
  }

  return { ok: true, prepared: { validBefore } };
}

function wireAuthorizationFrom(input: {
  readonly chain: string;
  readonly entryPoint: AuthorizationEntryPoint;
  readonly message: {
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly validAfter: string;
    readonly validBefore: string;
    readonly nonce: string;
  };
  readonly signature: string;
}): PaymentAuthorization | null {
  const { chain, message: m } = input;
  const from = x402SessionAccountCaip10(chain, m.from);
  const to = x402SessionAccountCaip10(chain, m.to);
  const asset = x402SessionAssetCaip19(chain);
  if (from === null || to === null || asset === null) return null;
  return {
    scheme: PAYMENT_AUTHORIZATION_SCHEME,
    entry_point: input.entryPoint,
    chain,
    asset,
    from,
    to,
    value: m.value,
    valid_after: m.validAfter,
    valid_before: m.validBefore,
    nonce: m.nonce.replace(/^0x/, ""),
    signature: input.signature,
  };
}

async function selfCheckEmitted(
  authorization: PaymentAuthorization,
  grant: TaskGrantEnvelope,
  grantHash: string,
): Promise<{ reason: HirePaymentRefusal; detail: string } | null> {
  const shape = validateAuthorizationShape(authorization);
  if (!shape.ok) {
    return {
      reason: shape.reason,
      detail: `the builder's own output failed the shape validator: ${shape.reason}`,
    };
  }
  const bound = await bindAuthorizationToGrant(shape.env, grant, grantHash);
  if (bound !== null) {
    return {
      reason: bound,
      detail: `the builder's own output failed the six-axis binding: ${bound}`,
    };
  }
  return null;
}

export type BuildReceivePaymentResult =
  | {
      ok: true;
      authorization: PaymentAuthorization;
      signed: SignedReceiveAuthorization;
      grantHash: string;
    }
  | { ok: false; reason: HirePaymentRefusal; detail: string };

export type BuildTransferPaymentResult =
  | {
      ok: true;
      authorization: PaymentAuthorization;
      signed: SignedTransferAuthorization;
      grantHash: string;
    }
  | { ok: false; reason: HirePaymentRefusal; detail: string };

export async function buildReceivePaymentAuthorization(input: {
  grant: TaskGrantEnvelope;
  grantHash: string;
  /** MILLISECONDS, and REQUIRED. The signing-time clock. */
  nowMs: number;
  sign: SignReceiveTypedData;
}): Promise<BuildReceivePaymentResult> {
  const { grant, grantHash, nowMs } = input;

  const pre = await prepareHirePayment({
    grant,
    grantHash,
    entryPoint: "receive_with_authorization",
  });
  if (!pre.ok) return { ok: false, reason: pre.reason, detail: pre.detail };

  const signed = await signReceiveAuthorization(
    {
      chain: grant.price_chain,
      from: grant.price_payer_account,
      to: grant.price_payee_account,
      value: grant.price_min_amount,
      validAfter: 0,
      validBefore: Number(pre.prepared.validBefore),
      grantHash,
      nowMs,
    },
    input.sign,
  );
  if (!signed.ok) return { ok: false, reason: signed.reason, detail: signed.detail };

  const authorization = wireAuthorizationFrom({
    chain: signed.signed.chain,
    entryPoint: "receive_with_authorization",
    message: signed.signed.typedData.message,
    signature: signed.signed.signature,
  });
  if (authorization === null) {
    return {
      ok: false,
      reason: "authorization_asset_mismatch",
      detail: `no CAIP spelling exists for ${signed.signed.chain}`,
    };
  }

  const failed = await selfCheckEmitted(authorization, grant, grantHash);
  if (failed !== null) return { ok: false, reason: failed.reason, detail: failed.detail };

  return { ok: true, authorization, signed: signed.signed, grantHash };
}

export async function buildTransferPaymentAuthorization(input: {
  grant: TaskGrantEnvelope;
  grantHash: string;
  /** MILLISECONDS, and REQUIRED. The signing-time clock. */
  nowMs: number;
  sign: SignTypedData;
}): Promise<BuildTransferPaymentResult> {
  const { grant, grantHash, nowMs } = input;

  const pre = await prepareHirePayment({
    grant,
    grantHash,
    entryPoint: "transfer_with_authorization",
  });
  if (!pre.ok) return { ok: false, reason: pre.reason, detail: pre.detail };

  const signed = await signTransferAuthorization(
    {
      chain: grant.price_chain,
      from: grant.price_payer_account,
      to: grant.price_payee_account,
      value: grant.price_min_amount,
      validAfter: 0,
      validBefore: Number(pre.prepared.validBefore),
      grantHash,
      nowMs,
    },
    input.sign,
  );
  if (!signed.ok) return { ok: false, reason: signed.reason, detail: signed.detail };

  const authorization = wireAuthorizationFrom({
    chain: signed.signed.chain,
    entryPoint: "transfer_with_authorization",
    message: signed.signed.typedData.message,
    signature: signed.signed.signature,
  });
  if (authorization === null) {
    return {
      ok: false,
      reason: "authorization_asset_mismatch",
      detail: `no CAIP spelling exists for ${signed.signed.chain}`,
    };
  }

  const failed = await selfCheckEmitted(authorization, grant, grantHash);
  if (failed !== null) return { ok: false, reason: failed.reason, detail: failed.detail };

  return { ok: true, authorization, signed: signed.signed, grantHash };
}

export type SignHireAuthorizationResult =
  | { ok: true; authorizationSignatureBase64: string }
  | { ok: false; reason: HirePaymentRefusal | "signer_failed"; detail: string };

export async function signHireAuthorization(input: {
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly authorization: PaymentAuthorization;
  readonly sign: Signer;
}): Promise<SignHireAuthorizationResult> {
  const { grant, grantHash, authorization } = input;

  const anchor = await checkGrantHashAnchor(grant, grantHash);
  if (anchor !== null) {
    return {
      ok: false,
      reason: anchor,
      detail:
        "the grant handed in does not hash to the grantHash this signature would " +
        "bind the payment to. Signing anyway would produce an attestation naming a " +
        "hire these bytes do not belong to, which the provider refuses as " +
        "`authorization_signature_forged` — loudly, but only after the payer's " +
        "wallet was already asked.",
    };
  }

  const binding = await hireAuthorizationBinding(grantHash, authorization);
  if (!binding.ok) {
    return {
      ok: false,
      reason: binding.reason,
      detail: `the payment is not a well-formed authorization: ${binding.reason}. Nothing was signed.`,
    };
  }

  const bound = await bindAuthorizationToGrant(authorization, grant, grantHash);
  if (bound !== null) {
    return {
      ok: false,
      reason: bound,
      detail:
        `this payment does not bind to this grant: ${bound}. Nothing was signed, so the ` +
        "grant's binding nonce is still free and a corrected hire can still be paid.",
    };
  }

  const signature = await signCanonical(binding.env, input.sign);
  if (signature === null) {
    return {
      ok: false,
      reason: "signer_failed",
      detail:
        "the hirer's Ed25519 signer threw, or answered with something that is not " +
        "64 bytes. Nothing is in flight; re-attempting is safe.",
    };
  }
  return { ok: true, authorizationSignatureBase64: signature };
}

export type PayForGrantRefusal =
  | HirePaymentRefusal
  | SubmitRefusal
  | "facilitator_permit2"
  | "facilitator_unusable"
  | "facilitator_unknown";

export type PayForGrantResult =
  | {
      ok: true;
      transactionHash: string;
      authorization: PaymentAuthorization;
      signed: SignedTransferAuthorization;
      preflight: FacilitatorPreflightResult | null;
    }
  | {
      ok: false;
      reason: PayForGrantRefusal;
      detail: string;
      unsigned: boolean;
      preflight: FacilitatorPreflightResult | null;
    };

export interface PayForGrantOptions {
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  /** MILLISECONDS, required. See `SignTransferAuthorizationInput.nowMs`. */
  readonly nowMs: number;
  readonly signer: SignTypedData;
  readonly facilitator?: { readonly baseUrl: string; readonly fetchImpl: FetchLike };
  readonly broadcast?: BroadcastTx;
  readonly allowUnadvertisedTransferMethod?: boolean;
  readonly signal?: AbortSignal;
}

export async function payForGrant(options: PayForGrantOptions): Promise<PayForGrantResult> {
  const usingFacilitator = options.facilitator !== undefined;
  const usingSelf = options.broadcast !== undefined;
  if (usingFacilitator === usingSelf) {
    return {
      ok: false,
      reason: "facilitator_unusable",
      detail:
        "supply exactly one of `facilitator` (a third party settles) or `broadcast` " +
        "(the payer settles). Supplying neither has nowhere to send the payment; " +
        "supplying both hides which one moved the money.",
      unsigned: true,
      preflight: null,
    };
  }

  let preflight: FacilitatorPreflightResult | null = null;
  let submitter: PaymentSubmitter;

  if (options.facilitator) {
    preflight = await preflightFacilitator({
      baseUrl: options.facilitator.baseUrl,
      chain: options.grant.price_chain,
      fetchImpl: options.facilitator.fetchImpl,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const allow = options.allowUnadvertisedTransferMethod === true;
    if (!preflightAdmitsPayment(preflight, allow)) {
      const reason: PayForGrantRefusal =
        preflight.reason === "transfer_method_permit2"
          ? "facilitator_permit2"
          : preflight.verdict === "unusable"
            ? "facilitator_unusable"
            : "facilitator_unknown";
      return {
        ok: false,
        reason,
        detail: preflight.detail,
        unsigned: true,
        preflight,
      };
    }
    submitter = createFacilitatorSubmitter({
      preflight,
      fetchImpl: options.facilitator.fetchImpl,
      allowUnadvertisedTransferMethod: allow,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } else {
    submitter = createSelfSubmitter({ broadcast: options.broadcast as BroadcastTx });
  }

  const built = await buildTransferPaymentAuthorization({
    grant: options.grant,
    grantHash: options.grantHash,
    nowMs: options.nowMs,
    sign: options.signer,
  });
  if (!built.ok) {
    return { ok: false, reason: built.reason, detail: built.detail, unsigned: true, preflight };
  }

  const submitted = await submitter.submit(built.signed);
  if (!submitted.ok) {
    return {
      ok: false,
      reason: submitted.reason,
      detail: submitted.detail,
      unsigned: false,
      preflight,
    };
  }

  return {
    ok: true,
    transactionHash: submitted.transactionHash,
    authorization: built.authorization,
    signed: built.signed,
    preflight,
  };
}

export type AuthenticateHireAcceptanceResult =
  | { ok: true; accepted: SessionHireAccepted }
  | { ok: false; reason: HireRefuseDetail | "grant_hash_mismatch" };

export async function authenticateHireAcceptance(input: {
  readonly raw: unknown;
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly nowMs: number;
}): Promise<AuthenticateHireAcceptanceResult> {
  const anchor = await checkGrantHashAnchor(input.grant, input.grantHash);
  if (anchor !== null) return { ok: false, reason: anchor };

  const parsed = validateHireAccepted(input.raw, input.nowMs);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const fault = verifyHireAcceptance({
    accepted: parsed.env,
    grant: input.grant,
    grantHash: input.grantHash,
  });
  if (fault !== null) return { ok: false, reason: fault };

  return { ok: true, accepted: parsed.env };
}

export type SubmitHireResult =
  | { kind: "accepted"; accepted: SessionHireAccepted }
  | { kind: "refused"; refused: SessionHireRefused; retryable: boolean; steersPayment: boolean }
  | { kind: "undelivered"; detail: string }
  | { kind: "unverifiable"; detail: HireRefuseDetail | "response_malformed" }
  | { kind: "unbuildable"; reason: HireRefuseDetail | "grant_hash_mismatch" };

type AssertTrue<T extends true> = T;
type _SubmitHireCoversTransport = AssertTrue<
  PostHireOutcome extends SubmitHireResult ? true : false
>;

export async function submitHire(input: {
  readonly url: string;
  readonly wire: HireWire;
  readonly grantHash: string;
  readonly authorization: PaymentAuthorization;
  readonly sign: Signer;
  readonly nowMs: number;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}): Promise<SubmitHireResult> {
  const anchor = await checkGrantHashAnchor(input.wire.grant, input.grantHash);
  if (anchor !== null) return { kind: "unbuildable", reason: anchor };

  const message = await buildHireMessage(input.wire, input.authorization, input.sign);
  if (!message.ok) return { kind: "unbuildable", reason: message.reason };

  return postHire({
    url: input.url,
    message: message.env,
    grant: input.wire.grant,
    grantHash: input.grantHash,
    nowMs: input.nowMs,
    fetchImpl: input.fetchImpl,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export type SubmitSettlementHintRefusal =
  | "grant_hash_mismatch"
  | "provider_did_unusable"
  | "evidence_unusable"
  | "signature_failed";

export type SubmitSettlementHintResult =
  | { kind: "acknowledged"; status: number; hint: SettlementHintEnvelope }
  | { kind: "refused"; status: number; reason: string }
  | { kind: "undelivered"; detail: string }
  | { kind: "unrecognized"; status: number; detail: string }
  | { kind: "unbuildable"; reason: SubmitSettlementHintRefusal };

const MAX_HINT_RESPONSE_BYTES = 16 * 1024;

const MAX_HINT_REFUSAL_WORD_LENGTH = 128;

const HINT_MEDIA_TYPE = "application/json";

export async function submitSettlementHint(input: {
  readonly url: string;
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly evidence: unknown;
  readonly sign: Signer;
  readonly nowMs: number;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}): Promise<SubmitSettlementHintResult> {
  const anchor = await checkGrantHashAnchor(input.grant, input.grantHash);
  if (anchor !== null) return { kind: "unbuildable", reason: anchor };

  const providerDid: unknown = (input.grant as unknown as Record<string, unknown>).provider_did;
  if (typeof providerDid !== "string" || providerDid.length === 0) {
    return { kind: "unbuildable", reason: "provider_did_unusable" };
  }

  let hint: SettlementHintEnvelope;
  try {
    hint = await buildSettlementHint({
      grantHash: input.grantHash,
      providerDid,
      evidence: input.evidence,
      nowMs: input.nowMs,
    });
  } catch {
    return { kind: "unbuildable", reason: "evidence_unusable" };
  }

  const signature = await signCanonical(hint, input.sign);
  if (signature === null) return { kind: "unbuildable", reason: "signature_failed" };

  let payload: string;
  try {
    payload = JSON.stringify({
      hint,
      hint_signature_base64: signature,
      evidence: input.evidence,
    });
  } catch {
    return { kind: "unbuildable", reason: "evidence_unusable" };
  }

  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { "content-type": HINT_MEDIA_TYPE, accept: HINT_MEDIA_TYPE },
      body: payload,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return { kind: "undelivered", detail: "transport_failed" };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "undelivered", detail: "response_body_unreadable" };
  }
  if (text.length > MAX_HINT_RESPONSE_BYTES) {
    return { kind: "unrecognized", status: response.status, detail: "response_too_large" };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (response.status >= 500) return { kind: "undelivered", detail: "response_not_json" };
    return { kind: "unrecognized", status: response.status, detail: "response_not_json" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "unrecognized", status: response.status, detail: "response_not_object" };
  }
  const answer = body as Record<string, unknown>;

  if (response.status === 202) {
    if (answer.status === "accepted") {
      return { kind: "acknowledged", status: response.status, hint };
    }
    return {
      kind: "unrecognized",
      status: response.status,
      detail: "response_not_an_acknowledgement",
    };
  }

  const reason = answer.error;
  if (
    typeof reason === "string" &&
    reason.length > 0 &&
    reason.length <= MAX_HINT_REFUSAL_WORD_LENGTH
  ) {
    return { kind: "refused", status: response.status, reason };
  }
  if (response.status >= 500) return { kind: "undelivered", detail: "response_not_a_refusal" };
  return { kind: "unrecognized", status: response.status, detail: "response_not_a_refusal" };
}

export type OpenDeliveredResultRefusal =
  | "grant_hash_mismatch"
  | SessionResultRejectReason
  | "delivery_grant_mismatch";

export type OpenDeliveredResultOutcome =
  | { kind: "opened"; result: string; receipt: TaskDeliveryReceipt }
  | { kind: "unopenable"; receipt: TaskDeliveryReceipt }
  | { kind: "unverifiable"; reason: OpenDeliveredResultRefusal };

export async function openDeliveredResult(input: {
  readonly receipt: unknown;
  readonly signatureBase64: string;
  readonly resultCapsule: unknown;
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly sessionKey: SessionKey;
  readonly nowMs: number;
}): Promise<OpenDeliveredResultOutcome> {
  const anchor = await checkGrantHashAnchor(input.grant, input.grantHash);
  if (anchor !== null) return { kind: "unverifiable", reason: anchor };

  const verified = verifyDeliveryReceipt({
    receipt: input.receipt,
    signatureBase64: input.signatureBase64,
    grant: input.grant,
    grantHash: input.grantHash,
    nowMs: input.nowMs,
  });
  if (!verified.ok) return { kind: "unverifiable", reason: verified.reason };

  const opened = await openResult(
    input.resultCapsule,
    input.sessionKey,
    input.grantHash,
    verified.receipt.result_commitment,
  );
  if (opened.kind !== "opened") return { kind: "unopenable", receipt: verified.receipt };
  return { kind: "opened", result: opened.result, receipt: verified.receipt };
}

const RECOVERY_REQUEST_TTL_MS = 5 * 60_000;

export type RecoverResultRefusal =
  | "grant_hash_mismatch"
  | "hirer_did_unusable"
  | SessionResultRejectReason;

export type RecoverResultOutcome =
  | { kind: "opened"; result: string; receipt: TaskDeliveryReceipt }
  | { kind: "unopenable"; receipt: TaskDeliveryReceipt }
  | { kind: "unverifiable"; reason: OpenDeliveredResultRefusal | "answer_malformed" }
  | { kind: "no_result"; status: number; outcome: string; state: string; evidence_id?: string }
  | { kind: "undelivered"; detail: string }
  | { kind: "unrecognized"; status: number; detail: string }
  | { kind: "unbuildable"; reason: RecoverResultRefusal };

const MAX_RECOVERY_WORD_LENGTH = 128;

function wordOf(v: unknown): string {
  if (typeof v !== "string" || v.length === 0) return "";
  return v.length <= MAX_RECOVERY_WORD_LENGTH ? v : v.slice(0, MAX_RECOVERY_WORD_LENGTH);
}

export async function recoverResult(input: {
  readonly endpoint: SessionEndpoint;
  readonly wire: HireWire;
  readonly grantHash: string;
  readonly sessionKey: SessionKey;
  readonly sign: Signer;
  readonly nowMs: number;
  readonly ttlMs?: number;
  readonly entropy?: SessionEntropy;
}): Promise<RecoverResultOutcome> {
  const anchor = await checkGrantHashAnchor(input.wire.grant, input.grantHash);
  if (anchor !== null) return { kind: "unbuildable", reason: anchor };

  const hirerDid: unknown = (input.wire.grant as unknown as Record<string, unknown>).hirer_did;
  if (typeof hirerDid !== "string" || hirerDid.length === 0) {
    return { kind: "unbuildable", reason: "hirer_did_unusable" };
  }

  const e = input.entropy ?? webCryptoEntropy();
  const built = await buildRecoveryRequest({
    grantHash: input.grantHash,
    requesterDid: hirerDid,
    actionNonce: e.nonce(),
    nowMs: input.nowMs,
    ttlMs: input.ttlMs ?? RECOVERY_REQUEST_TTL_MS,
    sign: input.sign,
  });
  if (!built.ok) return { kind: "unbuildable", reason: built.reason };

  let answered: { status: number; body: unknown };
  try {
    answered = await postRecover(input.endpoint, {
      wire: input.wire,
      request: built.request,
      requestSignatureBase64: built.signature_base64,
    });
  } catch (err) {
    if (!(err instanceof SessionTransportError)) throw err;
    if (err.status === 0) return { kind: "undelivered", detail: err.message };
    return { kind: "unrecognized", status: err.status, detail: err.message };
  }

  const envelope = answered.body as Record<string, unknown>;
  const outcome = envelope.outcome;
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    return { kind: "unrecognized", status: answered.status, detail: "response_has_no_outcome" };
  }
  const o = outcome as Record<string, unknown>;
  const state = o.state;
  const stateWord =
    typeof state === "object" && state !== null && !Array.isArray(state)
      ? wordOf((state as Record<string, unknown>).kind)
      : "";

  const answer = o.answer;
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    const ev = o.evidence_id;
    return {
      kind: "no_result",
      status: answered.status,
      outcome: wordOf(o.kind),
      state: stateWord,
      ...(typeof ev === "string" && ev.length > 0 ? { evidence_id: ev } : {}),
    };
  }
  const a = answer as Record<string, unknown>;
  if (typeof a.receipt_signature_base64 !== "string") {
    return { kind: "unverifiable", reason: "answer_malformed" };
  }

  return openDeliveredResult({
    receipt: a.receipt,
    signatureBase64: a.receipt_signature_base64,
    resultCapsule: a.result_capsule,
    grant: input.wire.grant,
    grantHash: input.grantHash,
    sessionKey: input.sessionKey,
    nowMs: input.nowMs,
  });
}
