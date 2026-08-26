
import { SessionTransportError, SessionUsageError } from "./errors";
import type {
  HireWire,
  RedemptionAttestation,
  TaskAcceptanceEnvelope,
  TaskDeliveryReceipt,
  TaskRecoveryRequest,
  TaskResultCapsule,
} from "./protocol";

/**
 * THE DEFAULT WHOLE-CALL DEADLINE, IN MILLISECONDS.
 *
 * Applies to the whole call, not to a single socket read. A caller that wants
 * no deadline must say so explicitly.
 */
export const SESSION_DEFAULT_TIMEOUT_MS = 120_000;

export interface SessionEndpoint {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number | null;
}

export const SESSION_PATHS = Object.freeze({
  redeem: "/v1/pay/session/redeem",
  deliver: "/v1/pay/session/deliver",
  recover: "/v1/pay/session/recover",
  reattest: "/v1/pay/session/reattest",
} as const);

export interface SessionResponse<T = unknown> {
  status: number;
  body: T;
}

export interface RedeemResponseBody {
  schema: string;
  outcome:
    | {
        kind: "redeemed";
        grant_hash: string;
        offer_hash: string;
        provider_did: string;
        price: { chain: string; asset: string; min_amount: string; max_amount: string };
        settled_amount: string | null;
        expires_at_ms: number | null;
        recoverable_until_ms: number | null;
        brief_readable_here: false;
        attestation: RedemptionAttestation | null;
        attestation_signature_base64: string | null;
        attestation_unavailable: string | null;
      }
    | { kind: "replayed"; grant_hash: string; first_redeemed_at_ms: number; first_evidence_id: string }
    | { kind: "expired"; grant_hash: string; expires_at_ms: number; now_ms: number }
    | { kind: "rejected"; reason: string };
}

export interface RecoverResponseBody {
  schema: string;
  outcome:
    | {
        kind: "answered";
        grant_hash: string;
        state: { kind: string };
        answer: {
          receipt: unknown;
          receipt_signature_base64: string;
          result_capsule: unknown;
        } | null;
      }
    | { kind: "paid_no_session"; grant_hash: string; evidence_id: string }
    | { kind: "no_payment_recorded"; grant_hash: string }
    | { kind: "rejected"; reason: string };
}

const PAY_RUNTIME_WITHHELD = "PAY_RUNTIME_WITHHELD";

function errorCodeOf(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const err = (parsed as Record<string, unknown>).error;
  if (typeof err !== "object" || err === null) return null;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function resolveTimeoutMs(v: number | null | undefined): number | null {
  if (v === undefined) return SESSION_DEFAULT_TIMEOUT_MS;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new SessionUsageError(
      `session_endpoint_timeout_invalid: SessionEndpoint.timeoutMs must be a finite ` +
        `number of milliseconds greater than zero, or null to declare that the caller ` +
        `owns the deadline. Received ${typeof v === "number" ? v : typeof v}. Note that ` +
        `0 is NOT the spelling for "no timeout" here — null is.`,
    );
  }
  return v;
}

function armDeadline(ms: number): { signal: AbortSignal; fired: boolean; cancel(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = {
    signal: controller.signal,
    fired: false,
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
  timer = setTimeout(() => {
    state.fired = true;
    controller.abort();
  }, ms);
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
  return state;
}

function doorConsequence(path: string): string {
  switch (path) {
    case SESSION_PATHS.redeem:
      return (
        "This door SPENDS THE GRANT'S ONE REDEMPTION USE and burns the single-use " +
        "provider proof header, so the server may already have written the journal row " +
        "and issued an attestation you never saw. DO NOT PAY AGAIN and do not mint " +
        "fresh evidence. Re-present the SAME evidence — or better, call `postReattest` " +
        "with the same grant and a FRESHLY MINTED proof header, which is the only door " +
        "that reissues the attestation (a second redeem answers `replayed` and carries " +
        "none)."
      );
    case SESSION_PATHS.deliver:
      return (
        "This door COMMITS THE RESULT WRITE-ONCE and spends no credential and no " +
        "payment, so the delivery may already be stored. Re-present the SAME receipt " +
        "and the SAME capsule — a repeat of identical bytes is safe, while a different " +
        "result is reported `contested` and never replaces the first."
      );
    case SESSION_PATHS.recover:
      return (
        "This door READS ONLY: it spends no credential, no payment and no redemption, " +
        "and it cannot have written anything. Nothing needs recovering — call it again."
      );
    case SESSION_PATHS.reattest:
      return (
        "This door BURNS THE SINGLE-USE PROVIDER PROOF HEADER and nothing else — no " +
        "payment, no redemption, no row. Call it again with a FRESHLY MINTED proof " +
        "header; the one you just sent may be spent, and reusing it is `409 " +
        "provider_proof_replayed`."
      );
    default:
      return (
        "This client does not know what that path spends, so assume the widest case: " +
        "the server may have written whatever that door writes. Re-present the SAME " +
        "artifacts rather than minting new ones."
      );
  }
}

function unfinishedCall(path: string, cause: unknown, deadlineMs: number | null): SessionTransportError {
  const how =
    deadlineMs === null
      ? `${path} did not complete.`
      : `${path} was ABANDONED at this client's own ${deadlineMs}ms deadline ` +
        `(session_call_deadline_exceeded) — the door accepted the call and did not ` +
        `finish answering.`;
  return new SessionTransportError(
    `${how} THIS IS NOT A REFUSAL AND IT IS NOT PROOF NOTHING ` +
      "HAPPENED: a timeout after the request reached the server looks identical from " +
      `here. ${doorConsequence(path)} ` +
      `(${cause instanceof Error ? cause.message : String(cause)})`,
    0,
    "",
  );
}

function requestNeverSent(path: string, what: string, cause: unknown): SessionUsageError {
  return new SessionUsageError(
    `session_request_not_sent: ${path} was never dialled — ${what}. NOTHING REACHED ` +
      "THE NETWORK, so nothing was journaled, nothing was spent and there is nothing " +
      "to recover: this is a defect in the arguments, not an unfinished call. Fix the " +
      `input and call again. (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}

async function post<T>(
  ep: SessionEndpoint,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<SessionResponse<T>> {
  const f = ep.fetch ?? fetch;

  const deadlineMs = resolveTimeoutMs(ep.timeoutMs);

  let url: string;
  let payload: string;
  try {
    if (typeof f !== "function") {
      throw new TypeError(`typeof SessionEndpoint.fetch is ${typeof f}`);
    }
    url = `${ep.baseUrl.replace(/\/+$/, "")}${path}`;
    payload = JSON.stringify(body);
  } catch (err) {
    throw requestNeverSent(
      path,
      "the request could not be built (a non-string baseUrl, a body that does not " +
        "survive JSON.stringify, or a SessionEndpoint.fetch that is not callable)",
      err,
    );
  }

  const clock = deadlineMs === null ? null : armDeadline(deadlineMs);

  const refuseIfAbandoned = (at: string): void => {
    if (clock !== null && clock.fired) throw unfinishedCall(path, at, deadlineMs);
  };

  try {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: payload,
        ...(clock === null ? {} : { signal: clock.signal }),
      });
    } catch (err) {
      throw unfinishedCall(path, err, clock !== null && clock.fired ? deadlineMs : null);
    }
    refuseIfAbandoned("the deadline fired before the response was in hand");

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (clock !== null && clock.fired) throw unfinishedCall(path, err, deadlineMs);
      throw new SessionTransportError(
        `${path} answered ${res.status} and the body could not be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        res.status,
        "",
      );
    }
    refuseIfAbandoned("the deadline fired before the body was fully read");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SessionTransportError(
        `${path} answered ${res.status} with a non-JSON body`,
        res.status,
        text.slice(0, 512),
      );
    }

    const code = errorCodeOf(parsed);
    if (code === PAY_RUNTIME_WITHHELD) {
      throw new SessionTransportError(
        `${path} answered ${res.status} ${PAY_RUNTIME_WITHHELD} — this endpoint is ` +
          "switched off at the edge, not at the rail. It is answered before routing " +
          "and before any handler, so no request reached the rail and nothing was " +
          "journaled. Retrying cannot change it.",
        res.status,
        text.slice(0, 512),
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SessionTransportError(
        `${path} answered ${res.status} with JSON that is not an object`,
        res.status,
        text.slice(0, 512),
      );
    }

    return { status: res.status, body: parsed as T };
  } finally {
    if (clock !== null) clock.cancel();
  }
}

export async function postRedeem(
  ep: SessionEndpoint,
  input: {
    wire: HireWire;
    acceptance: TaskAcceptanceEnvelope;
    acceptanceSignatureBase64: string;
    evidence: unknown;
    proofHeader: { name: string; value: string };
  },
): Promise<SessionResponse<RedeemResponseBody>> {
  return post<RedeemResponseBody>(
    ep,
    SESSION_PATHS.redeem,
    {
      offer: input.wire.offer,
      offer_signature_base64: input.wire.offer_signature_base64,
      grant: input.wire.grant,
      grant_signature_base64: input.wire.grant_signature_base64,
      capsule: input.wire.capsule,
      acceptance: input.acceptance,
      acceptance_signature_base64: input.acceptanceSignatureBase64,
      evidence: input.evidence,
    },
    { [input.proofHeader.name]: input.proofHeader.value },
  );
}

export async function postDeliver(
  ep: SessionEndpoint,
  input: {
    wire: HireWire;
    receipt: TaskDeliveryReceipt;
    receiptSignatureBase64: string;
    resultCapsule: TaskResultCapsule;
  },
): Promise<SessionResponse> {
  return post(ep, SESSION_PATHS.deliver, {
    offer: input.wire.offer,
    offer_signature_base64: input.wire.offer_signature_base64,
    grant: input.wire.grant,
    grant_signature_base64: input.wire.grant_signature_base64,
    receipt: input.receipt,
    receipt_signature_base64: input.receiptSignatureBase64,
    result_capsule: input.resultCapsule,
  });
}

export async function postRecover(
  ep: SessionEndpoint,
  input: {
    wire: HireWire;
    request: TaskRecoveryRequest;
    requestSignatureBase64: string;
  },
): Promise<SessionResponse<RecoverResponseBody>> {
  return post<RecoverResponseBody>(ep, SESSION_PATHS.recover, {
    offer: input.wire.offer,
    offer_signature_base64: input.wire.offer_signature_base64,
    grant: input.wire.grant,
    grant_signature_base64: input.wire.grant_signature_base64,
    request: input.request,
    request_signature_base64: input.requestSignatureBase64,
  });
}

export async function postReattest(
  ep: SessionEndpoint,
  input: {
    wire: HireWire;
    proofHeader: { name: string; value: string };
  },
): Promise<SessionResponse> {
  return post(
    ep,
    SESSION_PATHS.reattest,
    { grant: input.wire.grant },
    { [input.proofHeader.name]: input.proofHeader.value },
  );
}

