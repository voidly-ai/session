
import {
  authorizationEntryPoint,
  authorizationValidBeforeFor,
  bindAuthorizationToGrant,
  envelopeHash,
  PAYMENT_AUTHORIZATION_SCHEME,
  validateAuthorizationShape,
  x402SessionAssetCaip19,
} from "./protocol";
import type { AuthorizationEntryPoint, HireRefuseDetail, TaskGrantEnvelope } from "./protocol";
import { signReceiveAuthorization, signTransferAuthorization } from "./submission";
import type {
  SignedReceiveAuthorization,
  SignedTransferAuthorization,
  SignRefusal,
  SignTransferAuthorizationInput,
} from "./submission";

export type AssembleAuthorizationRefusal =
  | HireRefuseDetail
  | SignRefusal
  | "grant_hash_mismatch"
  | "authorization_asset_not_frozen_usdc"
  | "valid_after_not_safe_integer"
  | "authorization_entry_point_mismatch";

export type AssembleSignedTransferAuthorizationResult =
  | { ok: true; signed: SignedTransferAuthorization; grantHash: string }
  | { ok: false; reason: AssembleAuthorizationRefusal; detail: string };

export type AssembleSignedReceiveAuthorizationResult =
  | { ok: true; signed: SignedReceiveAuthorization; grantHash: string }
  | { ok: false; reason: AssembleAuthorizationRefusal; detail: string };

export interface AssembleSignedTransferAuthorizationInput {
  readonly authorization: unknown;
  readonly grant: TaskGrantEnvelope;
  /**
   * MILLISECONDS, and REQUIRED — no `Date.now()` default.
   *
   * This is the RELAY-time clock, and it is a different instant from the one
   * the payer signed at.
   */
  readonly nowMs: number;
  readonly expectedGrantHash?: string;
}

const HEX64_RE = /^[0-9a-f]{64}$/;

async function prepareRelayAuthorization(
  input: AssembleSignedTransferAuthorizationInput,
): Promise<
  | {
      ok: true;
      grantHash: string;
      signInput: SignTransferAuthorizationInput;
      signature: string;
      entryPoint: AuthorizationEntryPoint | "unstated";
    }
  | { ok: false; reason: AssembleAuthorizationRefusal; detail: string }
> {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("assembleSignedTransferAuthorization: input must be an object");
  }
  const grant = input.grant;
  if (typeof grant !== "object" || grant === null) {
    throw new TypeError("assembleSignedTransferAuthorization: grant must be a TaskGrantEnvelope");
  }

  const shape = validateAuthorizationShape(input.authorization);
  if (!shape.ok) {
    return {
      ok: false,
      reason: shape.reason,
      detail:
        `the authorization is not a well-formed ${PAYMENT_AUTHORIZATION_SCHEME} payment ` +
        `authorization: ${shape.reason}. Nothing was hashed, compared or signed.`,
    };
  }
  const authorization = shape.env;

  const validAfter = Number(authorization.valid_after);
  if (!Number.isSafeInteger(validAfter)) {
    return {
      ok: false,
      reason: "valid_after_not_safe_integer",
      detail:
        `valid_after is "${authorization.valid_after}", which does not survive conversion to a ` +
        "JS number without loss. The EIP-712 builder takes seconds as numbers, and a rounded " +
        "one would be signed into a window nobody agreed to.",
    };
  }

  const grantHash = await envelopeHash(grant);
  if (input.expectedGrantHash !== undefined) {
    if (
      typeof input.expectedGrantHash !== "string" ||
      !HEX64_RE.test(input.expectedGrantHash) ||
      input.expectedGrantHash !== grantHash
    ) {
      return {
        ok: false,
        reason: "grant_hash_mismatch",
        detail:
          `the caller expected grant hash ${String(input.expectedGrantHash)} and this grant ` +
          `hashes to ${grantHash}. The hash is the reference the payment's binding nonce is ` +
          "checked against, so continuing would compare the money to the wrong grant.",
      };
    }
  }

  const bound = await bindAuthorizationToGrant(authorization, grant, grantHash);
  if (bound !== null) {
    return {
      ok: false,
      reason: bound,
      detail:
        `the authorization does not bind to grant ${grantHash}: ${bound}. This is the same ` +
        "comparison the redemption path makes, from the same function — a relay that " +
        "disagreed with it would be spending gas on a payment no provider can redeem.",
    };
  }

  const frozenAsset = x402SessionAssetCaip19(grant.price_chain);
  if (frozenAsset === null || frozenAsset !== grant.price_asset) {
    return {
      ok: false,
      reason: "authorization_asset_not_frozen_usdc",
      detail:
        `the grant prices this hire in ${grant.price_asset} on ${grant.price_chain}, and the ` +
        `only asset this rail settles there is ${String(frozenAsset)}. A transfer of anything ` +
        "else emits no AuthorizationUsed log the settlement adapter recognises, so the payment " +
        "would move and the redemption would never resolve.",
    };
  }

  const validBeforeString = authorizationValidBeforeFor(grant);
  if (validBeforeString === null) {
    return {
      ok: false,
      reason: "authorization_expiry_mismatch",
      detail:
        "the grant's expires_at does not parse to a millisecond instant, so there is no " +
        "validBefore to sign against. Unreachable while step 3 runs first; fail-closed anyway.",
    };
  }

  return {
    ok: true,
    grantHash,
    entryPoint: authorizationEntryPoint(authorization),
    signInput: {
      chain: grant.price_chain,
      from: grant.price_payer_account,
      to: grant.price_payee_account,
      value: authorization.value,
      validAfter,
      validBefore: Number(validBeforeString),
      grantHash,
      nowMs: input.nowMs,
    },
    signature: authorization.signature,
  };
}

function entryPointMismatch(
  door: AuthorizationEntryPoint,
  declared: AuthorizationEntryPoint | "unstated",
): { ok: false; reason: AssembleAuthorizationRefusal; detail: string } | null {
  if (declared === "unstated" || declared === door) return null;
  return {
    ok: false,
    reason: "authorization_entry_point_mismatch",
    detail:
      `the wire declares entry_point "${declared}" and this is the ${door} door. The two ` +
      "EIP-712 struct hashes differ, so the signatures are not interchangeable: assembling " +
      "here would produce a well-formed call that recovers some other address and reverts, " +
      "costing the relayer gas and emitting no AuthorizationUsed log for the settlement " +
      "binding to live in. Nothing was signed and nothing was sent. This same authorization " +
      `assembles at the ${declared} door.`,
  };
}

export async function assembleSignedTransferAuthorization(
  input: AssembleSignedTransferAuthorizationInput,
): Promise<AssembleSignedTransferAuthorizationResult> {
  const prepared = await prepareRelayAuthorization(input);
  if (!prepared.ok) return prepared;

  const wrongDoor = entryPointMismatch("transfer_with_authorization", prepared.entryPoint);
  if (wrongDoor !== null) return wrongDoor;

  const signed = await signTransferAuthorization(
    prepared.signInput,
    () => prepared.signature,
  );
  if (!signed.ok) return { ok: false, reason: signed.reason, detail: signed.detail };

  return { ok: true, signed: signed.signed, grantHash: prepared.grantHash };
}

export async function assembleSignedReceiveAuthorization(
  input: AssembleSignedTransferAuthorizationInput,
): Promise<AssembleSignedReceiveAuthorizationResult> {
  const prepared = await prepareRelayAuthorization(input);
  if (!prepared.ok) return prepared;

  const wrongDoor = entryPointMismatch("receive_with_authorization", prepared.entryPoint);
  if (wrongDoor !== null) return wrongDoor;

  const signed = await signReceiveAuthorization(prepared.signInput, () => prepared.signature);
  if (!signed.ok) return { ok: false, reason: signed.reason, detail: signed.detail };

  return { ok: true, signed: signed.signed, grantHash: prepared.grantHash };
}
