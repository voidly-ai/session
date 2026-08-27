
import { describe, expect, it } from "vitest";
import {
  classifySessionStatus,
  driveSettlementHint,
  readSessionStatus,
  SESSION_STATUS_PATH_PREFIX,
  SETTLEMENT_EXPIRY_MARGIN_MS,
  SETTLEMENT_POLL_INTERVAL_MS,
} from "../src/settlementRetry";
import { x402SessionEvidence } from "../src/index";
import type { FetchLike, TaskGrantEnvelope } from "../src/index";
import { freshHire, GRANT_TTL_MS, NOW, party } from "./_fixtures";

const TX = `0x${"7f".repeat(32)}`;
const HINT_URL = "https://provider.example:8443/session/deliver-hint";
const BASE = "https://provider.example:8443";

const HIRER = party(1);

async function realGrant(): Promise<{ grant: TaskGrantEnvelope; grantHash: string }> {
  const { hire } = await freshHire();
  if (!hire.ok) throw new Error("fixture hire failed");
  return { grant: hire.wire.grant, grantHash: hire.keep.grant_hash };
}

interface HintPost {
  readonly hint: Record<string, unknown>;
  readonly signature: string;
  readonly evidence: unknown;
}

interface Fake {
  readonly fetchImpl: FetchLike;
  readonly hintPosts: HintPost[];
  readonly statusReads: string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACCEPTED = () => jsonResponse(202, { status: "accepted" });

function fakeDaemon(script: {
  hint?: (n: number) => Response;
  status: (n: number) => Response;
}): Fake {
  const hintPosts: HintPost[] = [];
  const statusReads: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url === HINT_URL) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      hintPosts.push({
        hint: body.hint as Record<string, unknown>,
        signature: String(body.hint_signature_base64),
        evidence: body.evidence,
      });
      return (script.hint ?? ACCEPTED)(hintPosts.length - 1);
    }
    if (url.startsWith(`${BASE}${SESSION_STATUS_PATH_PREFIX}`)) {
      const n = statusReads.length;
      statusReads.push(url.slice(`${BASE}${SESSION_STATUS_PATH_PREFIX}`.length));
      return script.status(n);
    }
    throw new Error(`the fake daemon has no door at ${url}`);
  };
  return { fetchImpl, hintPosts, statusReads };
}

function words(...seq: string[]) {
  return (n: number) => jsonResponse(200, { status: seq[Math.min(n, seq.length - 1)] });
}

function clock(startMs = NOW) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe("driveSettlementHint — the stall clears, and the cost is counted", () => {

  it("converges after two indeterminate polls, in EXACTLY three attempts", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment", "awaiting_payment", "redeemed") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome, out.detail).toBe("settled");
    expect(out.ok).toBe(true);
    expect(out.lastStatus).toBe("redeemed");
    expect(out.attempts.length).toBe(3);
    expect(fake.hintPosts.length).toBe(3);
    expect(fake.statusReads.length).toBe(3);
    expect(new Set(fake.statusReads)).toEqual(new Set([grantHash]));
  });

  it("every attempt is FRESH BYTES — strictly newer issued_at, a different signature", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment", "awaiting_payment", "redeemed") });

    await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(fake.hintPosts.length).toBe(3);
    const issued = fake.hintPosts.map((p) => Date.parse(String(p.hint.issued_at)));
    expect(issued[1]).toBeGreaterThan(issued[0]);
    expect(issued[2]).toBeGreaterThan(issued[1]);
    expect(issued[1] - issued[0]).toBe(SETTLEMENT_POLL_INTERVAL_MS);
    expect(new Set(fake.hintPosts.map((p) => p.signature)).size).toBe(3);
    expect(new Set(fake.hintPosts.map((p) => JSON.stringify(p.evidence))).size).toBe(1);
  });

  it("a TERMINAL refusal stops on the attempt that produced it — one request, not a budget", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({
      hint: () => jsonResponse(401, { error: "hint_invalid_signature" }),
      status: words("awaiting_payment"),
    });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 8,
    });

    expect(out.outcome).toBe("hint_refused");
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("hint_invalid_signature");
    expect(out.attempts.length).toBe(1);
    expect(fake.hintPosts.length).toBe(1);
    expect(c.at()).toBe(NOW);
  });

  it("a 503 IS retried — the classifier discriminates rather than refusing everything", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({
      hint: (n) => (n === 0 ? jsonResponse(503, { error: "provider_fault" }) : ACCEPTED()),
      status: words("awaiting_payment", "redeemed"),
    });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome, out.detail).toBe("settled");
    expect(out.attempts.length).toBe(2);
    expect(fake.hintPosts.length).toBe(2);
  });

  it("409 hint_too_late is resolved FROM THE STATUS DOOR — a success wearing a 4xx", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({
      hint: () => jsonResponse(409, { error: "hint_too_late" }),
      status: words("working"),
    });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome, out.detail).toBe("settled");
    expect(out.ok).toBe(true);
    expect(out.lastStatus).toBe("working");
    expect(out.attempts.length).toBe(1);
  });

  it("a terminal SESSION status stops the loop, and is not reported as success", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("failed") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 8,
    });

    expect(out.outcome).toBe("session_terminal");
    expect(out.ok).toBe(false);
    expect(out.attempts.length).toBe(1);
  });

  it("a status word this package does not know STOPS, rather than being guessed at", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("quiescent") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 8,
    });

    expect(out.outcome).toBe("status_unrecognized");
    expect(out.lastStatus).toBe("quiescent");
    expect(out.attempts.length).toBe(1);
  });

  it("a status read that FAILS does not stop the loop — it is not a verdict", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({
      status: (n) =>
        n === 0 ? new Response("<html>502</html>", { status: 502 }) : jsonResponse(200, { status: "delivered" }),
    });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome, out.detail).toBe("settled");
    expect(out.attempts.length).toBe(2);
  });
});

describe("the bounds — and they are two different bounds", () => {

  it("THE ATTEMPT BUDGET fires: three attempts, three hints, then it stops", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 3,
    });

    expect(out.outcome).toBe("budget_exhausted");
    expect(out.ok).toBe(false);
    expect(out.lastStatus).toBe("awaiting_payment");
    expect(out.attempts.length).toBe(3);
    expect(fake.hintPosts.length).toBe(3);
  });

  it("THE WALL CLOCK fires independently of the attempt budget", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 50,
      deadlineMs: NOW + 60_000,
    });

    expect(out.outcome).toBe("budget_exhausted");
    expect(out.detail).toContain("deadline");
    expect(out.attempts.length).toBe(3);
    expect(fake.hintPosts.length).toBe(3);
    expect(c.at()).toBeLessThan(NOW + 60_000);
  });

  it("THE GRANT'S EXPIRY IS UNCONDITIONAL — an explicit deadline cannot push past it", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 200,
      deadlineMs: NOW + 10 * 60 * 60_000,
    });

    const hardDeadline = NOW + GRANT_TTL_MS - SETTLEMENT_EXPIRY_MARGIN_MS;
    expect(out.outcome).toBe("budget_exhausted");
    expect(c.at()).toBeLessThan(hardDeadline);
    expect(out.attempts.length).toBe(74);
    for (const a of out.attempts) expect(a.atMs).toBeLessThan(hardDeadline);
  });

  it("an UNREADABLE grant expiry sends NOTHING — an unbounded loop is the same defect", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });
    const bent = { ...grant, expires_at: "not a timestamp" } as unknown as TaskGrantEnvelope;

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant: bent,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome).toBe("unbuildable");
    expect(out.attempts.length).toBe(0);
    expect(fake.hintPosts.length).toBe(0);
    expect(fake.statusReads.length).toBe(0);
  });

  it("an `unbuildable` first attempt stops with nothing on the wire", async () => {
    const { grant } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash: "0".repeat(64),
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
    });

    expect(out.outcome).toBe("unbuildable");
    expect(out.detail).toBe("grant_hash_mismatch");
    expect(out.attempts.length).toBe(1);
    expect(fake.hintPosts.length).toBe(0);
    expect(fake.statusReads.length).toBe(0);
  });

  it("a nonsense attempt budget is refused before anything is sent", async () => {
    const { grant, grantHash } = await realGrant();
    const c = clock();
    const fake = fakeDaemon({ status: words("awaiting_payment") });

    const out = await driveSettlementHint({
      hintUrl: HINT_URL,
      statusBaseUrl: BASE,
      grant,
      grantHash,
      evidence: x402SessionEvidence(TX),
      sign: HIRER.sign,
      now: c.now,
      sleep: c.sleep,
      fetchImpl: fake.fetchImpl,
      maxAttempts: 0,
    });

    expect(out.outcome).toBe("unbuildable");
    expect(fake.hintPosts.length).toBe(0);
  });
});

describe("readSessionStatus — the observable the stall is visible on", () => {

  it("GETs the daemon's own path and returns the word", async () => {
    const fake = fakeDaemon({ status: words("awaiting_payment") });
    const hash = "a".repeat(64);
    const r = await readSessionStatus({
      statusBaseUrl: BASE,
      grantHash: hash,
      fetchImpl: fake.fetchImpl,
    });
    expect(r.ok, r.ok ? "" : r.detail).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("awaiting_payment");
    expect(fake.statusReads).toEqual([hash]);
  });

  it("a malformed grant hash builds NO URL — validated, not encoded", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(200, { status: "delivered" });
    };
    const r = await readSessionStatus({
      statusBaseUrl: BASE,
      grantHash: "../../etc/passwd",
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("status_grant_hash_malformed");
    expect(calls).toBe(0);
  });

  it("404 is a NAMED answer, not a transport fault", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(404, { error: "unknown" });
    const r = await readSessionStatus({
      statusBaseUrl: BASE,
      grantHash: "b".repeat(64),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("status_unknown");
  });

  it("BOTH HALVES, NEVER ONE — a status word under the wrong HTTP status is not an answer", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(503, { status: "delivered" });
    const r = await readSessionStatus({
      statusBaseUrl: BASE,
      grantHash: "c".repeat(64),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("status_unreadable");
  });

  it("a hostile body is refused without being echoed into the detail", async () => {
    const secret = "SENTINEL-" + "z".repeat(200);
    const fetchImpl: FetchLike = async () => jsonResponse(200, { status: secret });
    const r = await readSessionStatus({
      statusBaseUrl: BASE,
      grantHash: "d".repeat(64),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("status_unreadable");
    expect(r.detail).not.toContain("SENTINEL");
  });
});

describe("classifySessionStatus — every word the daemon can say, and one it cannot", () => {

  it("maps the daemon's nine public words, and never guesses at a tenth", () => {
    expect(classifySessionStatus("accepted")).toBe("unpaid");
    expect(classifySessionStatus("awaiting_payment")).toBe("awaiting_settlement");
    expect(classifySessionStatus("redeemed")).toBe("opened");
    expect(classifySessionStatus("working")).toBe("opened");
    expect(classifySessionStatus("delivered")).toBe("opened");
    expect(classifySessionStatus("relaying")).toBe("provider_relaying");
    expect(classifySessionStatus("relayed")).toBe("provider_relaying");
    expect(classifySessionStatus("failed")).toBe("terminal");
    expect(classifySessionStatus("undelivered")).toBe("terminal");
    expect(classifySessionStatus("")).toBe("unrecognized");
    expect(classifySessionStatus("Redeemed")).toBe("unrecognized");
    expect(classifySessionStatus("settlement_indeterminate")).toBe("unrecognized");
  });
});
