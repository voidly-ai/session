
import { validateHireAccepted, validateHireRefused, verifyHireAcceptance, HIRE_REFUSE_REASONS, SESSION_HIRE_REFUSED_SCHEMA } from "./hire";
import type { HireRefuseDetail, HireRefuseReason, SessionHireAccepted, SessionHireMessage, SessionHireRefused } from "./hire";
import type { TaskGrantEnvelope } from "./schemas";

export const HIRE_MEDIA_TYPE = "application/json";

export const MAX_HIRE_REQUEST_BYTES = 512 * 1024;

export const MAX_HIRE_RESPONSE_BYTES = 16 * 1024;

export const HIRE_REFUSAL_STATUS: Readonly<Record<HireRefuseReason, number>> = Object.freeze({
  hire_malformed: 400,
  invalid_hirer_signature: 400,
  artifact_binding_broken: 400,
  authorization_invalid: 400,
  hirer_key_mismatch: 400,
  window_too_short: 400,
  price_below_floor: 402,
  authorization_entry_point_refused: 402,
  not_the_named_provider: 403,
  grant_already_committed: 409,
  identity_unresolved: 422,
  brief_rejected: 422,
  service_unavailable: 503,
  ledger_unavailable: 503,
});

export function isRetryableRefusal(reason: HireRefuseReason): boolean {
  return HIRE_REFUSAL_STATUS[reason] >= 500;
}

export type PaymentSteeringMechanism =
  | "steer"
  | "harvest";

export interface PaymentSteeringDerivation {
  readonly instrumentIsDead: boolean;
  readonly mechanism: PaymentSteeringMechanism | null;
  readonly because: string;
}

export const PAYMENT_STEERING_DERIVATION: Readonly<
  Record<HireRefuseReason, PaymentSteeringDerivation>
> = Object.freeze({
  hire_malformed: {
    instrumentIsDead: true,
    mechanism: null,
    because:
      "clause 2: accuses bytes the hirer built and can re-validate locally, and names no direction — clause 1 is `true` on the DETAIL TIE-BREAK, since `clock_implausible` is alive and `offer_invalid_hirer_pubkey` is dead",
  },
  identity_unresolved: {
    instrumentIsDead: false,
    mechanism: null,
    because: "clause 1: register the DID, then send the IDENTICAL bytes — no wallet is asked",
  },
  hirer_key_mismatch: {
    instrumentIsDead: false,
    mechanism: null,
    because:
      "clause 1: reconcile the registered signing key, then send the IDENTICAL bytes — the grant hash, the binding nonce and the authorization never move",
  },
  invalid_hirer_signature: {
    instrumentIsDead: false,
    mechanism: null,
    because:
      "clause 1: envelopeHash has no signature in its preimage, so re-signing the same envelope leaves the grant hash and the authorization byte-identical",
  },
  artifact_binding_broken: {
    instrumentIsDead: true,
    mechanism: null,
    because:
      "clause 2: every detail names the hirer's own artifacts contradicting each other — locally falsifiable, and no direction to move",
  },
  not_the_named_provider: {
    instrumentIsDead: true,
    mechanism: null,
    because:
      "clause 2: contradicted by the SIGNED provider manifest the hirer already authenticated, so the replacement payee is the one it already chose",
  },
  authorization_invalid: {
    instrumentIsDead: true,
    mechanism: "steer",
    because:
      "clause 2 steer: the direction rides in an attacker-chosen detail — below_floor walks `value` up, expiry_mismatch walks `valid_before` out",
  },
  authorization_entry_point_refused: {
    instrumentIsDead: true,
    mechanism: "steer",
    because:
      "clause 2 steer: with two doors, 'not this one' is 'the bearer one' — more spendable; clause 1 is `true` on the DETAIL TIE-BREAK, since `..._unstated` is alive and `..._not_accepted` is dead",
  },
  grant_already_committed: {
    instrumentIsDead: true,
    mechanism: "harvest",
    because:
      "clause 2 harvest: no direction, but whether the grant hash is taken is a fact about the provider's store that no artifact the hirer holds can contradict",
  },
  price_below_floor: {
    instrumentIsDead: true,
    mechanism: "steer",
    because: "clause 2 steer: the word itself names the direction — more expensive",
  },
  window_too_short: {
    instrumentIsDead: true,
    mechanism: "steer",
    because:
      "clause 2 steer: `valid_before` is derived from the grant's expiry, so a longer window is a longer-lived instrument beside the live one",
  },
  brief_rejected: {
    instrumentIsDead: false,
    mechanism: null,
    because: "clause 1: the provider refused the WORK — no remedy satisfies it, so no wallet one",
  },
  service_unavailable: {
    instrumentIsDead: false,
    mechanism: null,
    because: "clause 1: the IDENTICAL bytes, later — the defining property of a retryable refusal",
  },
  ledger_unavailable: {
    instrumentIsDead: false,
    mechanism: null,
    because: "clause 1: the IDENTICAL bytes, later — the defining property of a retryable refusal",
  },
});

export const PAYMENT_STEERING_REFUSALS: readonly HireRefuseReason[] = Object.freeze(
  HIRE_REFUSE_REASONS.filter((reason) => {
    const derivation = PAYMENT_STEERING_DERIVATION[reason] as
      | PaymentSteeringDerivation
      | undefined;
    if (derivation === undefined) return false;
    return derivation.instrumentIsDead && derivation.mechanism !== null;
  }),
);

export function steersPayment(reason: HireRefuseReason): boolean {
  return PAYMENT_STEERING_REFUSALS.includes(reason);
}
export function refusal(reason: HireRefuseReason, detail: HireRefuseDetail): SessionHireRefused {
  return { schema: SESSION_HIRE_REFUSED_SCHEMA, reason, detail };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type PostHireOutcome =
  | { kind: "accepted"; accepted: SessionHireAccepted }
  | {
      kind: "refused";
      refused: SessionHireRefused;
      retryable: boolean;
      steersPayment: boolean;
    }
  | { kind: "undelivered"; detail: string }
  | { kind: "unverifiable"; detail: HireRefuseDetail | "response_malformed" };

export interface PostHireInput {
  url: string;
  message: SessionHireMessage;
  grant: TaskGrantEnvelope;
  grantHash: string;
  nowMs: number;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

export async function postHire(input: PostHireInput): Promise<PostHireOutcome> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { "content-type": HIRE_MEDIA_TYPE, accept: HIRE_MEDIA_TYPE },
      body: JSON.stringify(input.message),
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
  if (text.length > MAX_HIRE_RESPONSE_BYTES) {
    return { kind: "unverifiable", detail: "response_malformed" };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (response.status >= 500) return { kind: "undelivered", detail: "response_not_json" };
    return { kind: "unverifiable", detail: "response_malformed" };
  }

  if (response.status === 200) {
    const parsed = validateHireAccepted(body, input.nowMs);
    if (!parsed.ok) return { kind: "unverifiable", detail: parsed.reason };
    const fault = verifyHireAcceptance({
      accepted: parsed.env,
      grant: input.grant,
      grantHash: input.grantHash,
    });
    if (fault !== null) return { kind: "unverifiable", detail: fault };
    return { kind: "accepted", accepted: parsed.env };
  }

  const refused = validateHireRefused(body);
  if (!refused.ok) {
    if (response.status >= 500) return { kind: "undelivered", detail: "response_not_a_refusal" };
    return { kind: "unverifiable", detail: refused.reason };
  }
  return {
    kind: "refused",
    refused: refused.env,
    retryable: isRetryableRefusal(refused.env.reason),
    steersPayment: steersPayment(refused.env.reason),
  };
}
