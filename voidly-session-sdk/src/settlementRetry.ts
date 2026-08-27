
import { submitSettlementHint } from "./hirer";
import type { SubmitSettlementHintResult } from "./hirer";
import { timestampMs, SESSION_RAIL_BLOCK_TIME_MS, SESSION_RAIL_MIN_CONFIRMATIONS } from "./protocol";
import type { FetchLike, Signer, TaskGrantEnvelope } from "./protocol";

export const SESSION_STATUS_PATH_PREFIX = "/session/status/";

const GRANT_HASH_RE = /^[0-9a-f]{64}$/;

export const SETTLEMENT_POLL_INTERVAL_MS =
  SESSION_RAIL_MIN_CONFIRMATIONS * SESSION_RAIL_BLOCK_TIME_MS;

export const SETTLEMENT_EXPIRY_MARGIN_MS =
  SESSION_RAIL_MIN_CONFIRMATIONS * SESSION_RAIL_BLOCK_TIME_MS;

export const SETTLEMENT_MAX_HINT_ATTEMPTS = 8;

export type SleepLike = (ms: number) => Promise<void>;

export type ReadSessionStatusRefusal =
  | "status_unknown"
  | "status_unreadable"
  | "status_grant_hash_malformed";

export type ReadSessionStatusResult =
  | {
      readonly ok: true;
      readonly status: string;
    }
  | {
      readonly ok: false;
      readonly reason: ReadSessionStatusRefusal;
      readonly detail: string;
    };

export interface ReadSessionStatusInput {
  readonly statusBaseUrl: string;
  readonly grantHash: string;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}

const MAX_STATUS_WORD_LENGTH = 64;

export async function readSessionStatus(
  input: ReadSessionStatusInput,
): Promise<ReadSessionStatusResult> {
  if (!GRANT_HASH_RE.test(input.grantHash)) {
    return {
      ok: false,
      reason: "status_grant_hash_malformed",
      detail: "not 64 lowercase hex — refusing to build a status URL from it",
    };
  }

  let response: Response;
  try {
    response = await input.fetchImpl(
      `${input.statusBaseUrl}${SESSION_STATUS_PATH_PREFIX}${input.grantHash}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (e) {
    return { ok: false, reason: "status_unreadable", detail: `fetch failed: ${(e as Error).name}` };
  }

  if (response.status === 404) {
    return { ok: false, reason: "status_unknown", detail: "the daemon holds no row for this grant" };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      reason: "status_unreadable",
      detail: `http ${response.status}, body is not JSON`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "status_unreadable",
      detail: `http ${response.status}, body is not an object`,
    };
  }

  const word = (parsed as Record<string, unknown>).status;
  if (response.status !== 200 || typeof word !== "string" || word.length === 0) {
    return {
      ok: false,
      reason: "status_unreadable",
      detail: `http ${response.status}, no status word`,
    };
  }
  if (word.length > MAX_STATUS_WORD_LENGTH) {
    return { ok: false, reason: "status_unreadable", detail: "status word too long" };
  }
  return { ok: true, status: word };
}

export type SessionProgress =
  | "unpaid"
  | "awaiting_settlement"
  | "opened"
  | "provider_relaying"
  | "terminal"
  | "unrecognized";

export function classifySessionStatus(word: string): SessionProgress {
  switch (word) {
    case "accepted":
      return "unpaid";
    case "awaiting_payment":
      return "awaiting_settlement";
    case "redeemed":
    case "working":
    case "delivered":
      return "opened";
    case "relaying":
    case "relayed":
      return "provider_relaying";
    case "failed":
    case "undelivered":
      return "terminal";
    default:
      return "unrecognized";
  }
}

function hintRefusalIsTransient(status: number): boolean {
  return status === 503;
}

export type DriveSettlementOutcome =
  | "settled"
  | "provider_relaying"
  | "session_terminal"
  | "hint_refused"
  | "unbuildable"
  | "status_unrecognized"
  | "budget_exhausted";

export interface SettlementHintAttempt {
  readonly attempt: number;
  readonly atMs: number;
  readonly result: SubmitSettlementHintResult;
  readonly statusWord: string | null;
}

export interface DriveSettlementHintResult {
  readonly ok: boolean;
  readonly outcome: DriveSettlementOutcome;
  readonly attempts: readonly SettlementHintAttempt[];
  readonly lastStatus: string | null;
  readonly detail: string;
}

export interface DriveSettlementHintInput {
  readonly hintUrl: string;
  readonly statusBaseUrl: string;
  readonly grant: TaskGrantEnvelope;
  readonly grantHash: string;
  readonly evidence: unknown;
  readonly sign: Signer;
  readonly now: () => number;
  readonly sleep: SleepLike;
  readonly fetchImpl: FetchLike;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

function verdict(
  outcome: DriveSettlementOutcome,
  ok: boolean,
  attempts: readonly SettlementHintAttempt[],
  lastStatus: string | null,
  detail: string,
): DriveSettlementHintResult {
  return { ok, outcome, attempts, lastStatus, detail };
}

export async function driveSettlementHint(
  input: DriveSettlementHintInput,
): Promise<DriveSettlementHintResult> {
  const maxAttempts = input.maxAttempts ?? SETTLEMENT_MAX_HINT_ATTEMPTS;
  const pollIntervalMs = input.pollIntervalMs ?? SETTLEMENT_POLL_INTERVAL_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return verdict("unbuildable", false, [], null, "maxAttempts must be an integer of at least 1");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    return verdict("unbuildable", false, [], null, "pollIntervalMs must be a non-negative number");
  }

  const expiresAtMs = timestampMs(
    (input.grant as unknown as Record<string, unknown>).expires_at,
  );
  if (expiresAtMs === null) {
    return verdict(
      "unbuildable",
      false,
      [],
      null,
      "the grant's expires_at is unreadable, so this loop has no bound",
    );
  }
  const hardDeadlineMs = expiresAtMs - SETTLEMENT_EXPIRY_MARGIN_MS;
  const deadlineMs =
    input.deadlineMs === undefined ? hardDeadlineMs : Math.min(input.deadlineMs, hardDeadlineMs);

  const attempts: SettlementHintAttempt[] = [];
  let lastStatus: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const atMs = input.now();
    if (atMs >= deadlineMs) {
      return verdict(
        "budget_exhausted",
        false,
        attempts,
        lastStatus,
        `the deadline passed before attempt ${attempt} (grant expiry less one confirmation window)`,
      );
    }

    const result = await submitSettlementHint({
      url: input.hintUrl,
      grant: input.grant,
      grantHash: input.grantHash,
      evidence: input.evidence,
      sign: input.sign,
      nowMs: atMs,
      fetchImpl: input.fetchImpl,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const record: SettlementHintAttempt = { attempt, atMs, result, statusWord: null };
    attempts.push(record);

    if (result.kind === "unbuildable") {
      return verdict("unbuildable", false, attempts, lastStatus, result.reason);
    }
    if (result.kind === "unrecognized") {
      return verdict("hint_refused", false, attempts, lastStatus, result.detail);
    }
    if (result.kind === "refused" && !hintRefusalIsTransient(result.status)) {
      const after = await readSessionStatus({
        statusBaseUrl: input.statusBaseUrl,
        grantHash: input.grantHash,
        fetchImpl: input.fetchImpl,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (after.ok) {
        lastStatus = after.status;
        attempts[attempts.length - 1] = { ...record, statusWord: after.status };
        const progress = classifySessionStatus(after.status);
        if (progress === "opened") {
          return verdict("settled", true, attempts, lastStatus, `refused ${result.reason}, but the session is ${after.status}`);
        }
        if (progress === "terminal") {
          return verdict("session_terminal", false, attempts, lastStatus, after.status);
        }
        if (progress === "provider_relaying") {
          return verdict("provider_relaying", false, attempts, lastStatus, after.status);
        }
      }
      return verdict(
        "hint_refused",
        false,
        attempts,
        lastStatus,
        `http ${result.status} ${result.reason}`,
      );
    }

    if (input.now() + pollIntervalMs >= deadlineMs) {
      return verdict(
        "budget_exhausted",
        false,
        attempts,
        lastStatus,
        "the next poll would land past the deadline",
      );
    }
    await input.sleep(pollIntervalMs);

    const read = await readSessionStatus({
      statusBaseUrl: input.statusBaseUrl,
      grantHash: input.grantHash,
      fetchImpl: input.fetchImpl,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!read.ok) {
      continue;
    }
    lastStatus = read.status;
    attempts[attempts.length - 1] = { ...record, statusWord: read.status };

    switch (classifySessionStatus(read.status)) {
      case "opened":
        return verdict("settled", true, attempts, lastStatus, read.status);
      case "terminal":
        return verdict("session_terminal", false, attempts, lastStatus, read.status);
      case "provider_relaying":
        return verdict("provider_relaying", false, attempts, lastStatus, read.status);
      case "unrecognized":
        return verdict("status_unrecognized", false, attempts, lastStatus, read.status);
      case "unpaid":
      case "awaiting_settlement":
        break;
    }
  }

  return verdict(
    "budget_exhausted",
    false,
    attempts,
    lastStatus,
    `${attempts.length} attempt(s) and the session is still ${lastStatus ?? "unread"}`,
  );
}
