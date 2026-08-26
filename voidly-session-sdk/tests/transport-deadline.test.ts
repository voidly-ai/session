
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionTransportError, SessionUsageError } from "../src/errors";
import {
  SESSION_DEFAULT_TIMEOUT_MS,
  SESSION_PATHS,
  postDeliver,
  postReattest,
  postRecover,
  postRedeem,
  type SessionEndpoint,
} from "../src/transport";
import type { HireWire } from "../src/protocol";

const WIRE = {
  offer: { schema: "test-only" },
  offer_signature_base64: "AA==",
  grant: { schema: "test-only" },
  grant_signature_base64: "AA==",
  capsule: { schema: "test-only" },
} as unknown as HireWire;
const PROOF = { name: "x-voidly-session-provider-proof", value: "test-only-not-a-signature" };

const UNDIALLED = "http://127.0.0.1:9";

type Behaviour =
  | "hang_before_headers"
  | "dribble_body_forever"
  | "slow_but_honest"
  | "slow_chunked_honest";

const HONEST_BODY = JSON.stringify({
  schema: "voidly.session.reattest/v1",
  outcome: { kind: "redeemed", grant_hash: "a".repeat(64), note: "intact" },
});

let server: Server;
let base = "";
let socketClosedOn: Behaviour[] = [];
const dribblers = new Set<ReturnType<typeof setInterval>>();
const pending = new Set<ReturnType<typeof setTimeout>>();

function behaviourOf(req: IncomingMessage): Behaviour {
  const path = String(req.url ?? "");
  if (path.includes("dribble")) return "dribble_body_forever";
  if (path.includes("chunked")) return "slow_chunked_honest";
  if (path.includes("honest")) return "slow_but_honest";
  return "hang_before_headers";
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const behaviour = behaviourOf(req);

  req.socket.on("close", () => void socketClosedOn.push(behaviour));

  req.socket.on("error", () => {});
  res.on("error", () => {});

  req.resume();
  req.on("end", () => {
    if (behaviour === "hang_before_headers") return;

    if (behaviour === "dribble_body_forever") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"schema":"voidly.session.reattest/v1"');
      const t = setInterval(() => {
        if (!res.writableEnded && res.writable) res.write(" ");
      }, 20);
      dribblers.add(t);
      res.on("close", () => {
        clearInterval(t);
        dribblers.delete(t);
      });
      return;
    }

    if (behaviour === "slow_chunked_honest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(HONEST_BODY.slice(0, 20));
      const t = setTimeout(() => {
        res.end(HONEST_BODY.slice(20));
        pending.delete(t);
      }, 120);
      pending.add(t);
      return;
    }

    const t = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(HONEST_BODY);
      pending.delete(t);
    }, 200);
    pending.add(t);
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const t of dribblers) clearInterval(t);
  for (const t of pending) clearTimeout(t);
  dribblers.clear();
  pending.clear();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function door(behaviour: Behaviour, timeoutMs?: number | null): SessionEndpoint {
  const tag =
    behaviour === "dribble_body_forever"
      ? "dribble"
      : behaviour === "slow_chunked_honest"
        ? "chunked"
        : behaviour === "slow_but_honest"
          ? "honest"
          : "hang";
  return { baseUrl: `${base}/${tag}`, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function ignoresTheSignal(opts: {
  where: "fetch" | "body";
  afterMs: number;
  status: number;
  body: string;
  timeoutMs: number;
}): SessionEndpoint {
  return {
    baseUrl: UNDIALLED,
    timeoutMs: opts.timeoutMs,
    fetch: (async () => {
      if (opts.where === "fetch") await sleep(opts.afterMs);
      return {
        status: opts.status,
        text: async () => {
          if (opts.where === "body") await sleep(opts.afterMs);
          return opts.body;
        },
      };
    }) as unknown as typeof fetch,
  };
}

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

const DOOR_CLAIM: Readonly<Record<string, string>> = Object.freeze({
  [SESSION_PATHS.redeem]: "SPENDS THE GRANT'S ONE REDEMPTION USE",
  [SESSION_PATHS.deliver]: "COMMITS THE RESULT WRITE-ONCE",
  [SESSION_PATHS.recover]: "READS ONLY",
  [SESSION_PATHS.reattest]: "BURNS THE SINGLE-USE PROVIDER PROOF HEADER and nothing else",
});

function expectAbandoned(err: unknown, deadlineMs: number, path: string): SessionTransportError {
  expect(err).toBeInstanceOf(SessionTransportError);
  const e = err as SessionTransportError;
  expect(e.status, "an unfinished call must not borrow the door's status").toBe(0);
  expect(e.message).toContain("session_call_deadline_exceeded");
  expect(e.message).toContain(`${deadlineMs}ms deadline`);
  expect(e.message).toContain("THIS IS NOT A REFUSAL");
  expect(e.message).toContain("NOT PROOF NOTHING HAPPENED");
  expect(e.message).not.toContain("could not be read");
  expect(e.message).not.toContain("session_request_not_sent");
  expectDoorClaim(e.message, path);
  return e;
}

function expectDoorClaim(message: string, path: string): void {
  const mine = DOOR_CLAIM[path];
  expect(mine, `no claim registered for ${path}`).toBeTypeOf("string");
  expect(message, `${path} did not name what it spends`).toContain(mine);
  for (const [other, claim] of Object.entries(DOOR_CLAIM)) {
    if (other === path) continue;
    expect(message, `${path} borrowed ${other}'s consequence`).not.toContain(claim);
  }
}

function everyDoor(ep: SessionEndpoint): Array<{ path: string; call: () => Promise<unknown> }> {
  return [
    {
      path: SESSION_PATHS.redeem,
      call: () =>
        postRedeem(ep, {
          wire: WIRE,
          acceptance: { schema: "test-only" } as never,
          acceptanceSignatureBase64: "AA==",
          evidence: { schema: "test-only" },
          proofHeader: PROOF,
        }),
    },
    {
      path: SESSION_PATHS.deliver,
      call: () =>
        postDeliver(ep, {
          wire: WIRE,
          receipt: { schema: "test-only" } as never,
          receiptSignatureBase64: "AA==",
          resultCapsule: { schema: "test-only" } as never,
        }),
    },
    {
      path: SESSION_PATHS.recover,
      call: () =>
        postRecover(ep, {
          wire: WIRE,
          request: { schema: "test-only" } as never,
          requestSignatureBase64: "AA==",
        }),
    },
    { path: SESSION_PATHS.reattest, call: () => postReattest(ep, { wire: WIRE, proofHeader: PROOF }) },
  ];
}

function instantly(status: number, body: string): typeof fetch {
  return (async () => ({ status, text: async () => body })) as unknown as typeof fetch;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw, and the call resolved");
}

describe("a door that accepts and never answers is abandoned at the deadline", () => {
  it("EXIT 1/4 — silence before the headers surfaces as the status-0 unfinished call", async () => {
    socketClosedOn = [];
    const started = Date.now();
    const err = await caught(() =>
      postRedeem(door("hang_before_headers", 250), {
        wire: WIRE,
        acceptance: { schema: "test-only" } as never,
        acceptanceSignatureBase64: "AA==",
        evidence: { schema: "test-only" },
        proofHeader: PROOF,
      }),
    );
    expectAbandoned(err, 250, SESSION_PATHS.redeem);

    const elapsed = Date.now() - started;
    expect(elapsed, "gave up before the deadline it promised").toBeGreaterThanOrEqual(150);
    expect(elapsed, "did not give up").toBeLessThan(5_000);

    expect(await waitFor(() => socketClosedOn.includes("hang_before_headers"))).toBe(true);
  });

  it("EXIT 3/4, THE SHARP ONE: prompt headers then a body that dribbles forever", async () => {
    socketClosedOn = [];
    const started = Date.now();
    const err = await caught(() =>
      postReattest(door("dribble_body_forever", 250), { wire: WIRE, proofHeader: PROOF }),
    );
    expectAbandoned(err, 250, SESSION_PATHS.reattest);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5_000);
    expect(await waitFor(() => socketClosedOn.includes("dribble_body_forever"))).toBe(true);
  });

  it("the deadline is the transport's, not one door's — /deliver hangs the same way", async () => {
    socketClosedOn = [];
    const err = await caught(() =>
      postDeliver(door("hang_before_headers", 200), {
        wire: WIRE,
        receipt: { schema: "test-only" } as never,
        receiptSignatureBase64: "AA==",
        resultCapsule: { schema: "test-only" } as never,
      }),
    );
    expectAbandoned(err, 200, SESSION_PATHS.deliver);
    expect(await waitFor(() => socketClosedOn.includes("hang_before_headers"))).toBe(true);
  });
});

describe("once the deadline fires, EVERY exit is unfinished", () => {
  it("EXIT 2/4 — the deadline fires during the headers and the fetch answers anyway", async () => {
    const started = Date.now();
    const err = await caught(() =>
      postRedeem(
        ignoresTheSignal({ where: "fetch", afterMs: 150, status: 200, body: HONEST_BODY, timeoutMs: 60 }),
        {
          wire: WIRE,
          acceptance: { schema: "test-only" } as never,
          acceptanceSignatureBase64: "AA==",
          evidence: { schema: "test-only" },
          proofHeader: PROOF,
        },
      ),
    );
    const e = expectAbandoned(err, 60, SESSION_PATHS.redeem);
    expect(e.status, "the door's 200 must not survive as the error's status").toBe(0);
    expect(e.message).toContain("before the response was in hand");
    expect(Date.now() - started, "resolved before the door answered").toBeGreaterThanOrEqual(50);
  });

  it("EXIT 4/4a — the deadline fires during the body and JSON.parse would have failed", async () => {
    const err = await caught(() =>
      postDeliver(
        ignoresTheSignal({
          where: "body",
          afterMs: 150,
          status: 200,
          body: '{"schema":"voidly.session.deliver/v1"',
          timeoutMs: 60,
        }),
        {
          wire: WIRE,
          receipt: { schema: "test-only" } as never,
          receiptSignatureBase64: "AA==",
          resultCapsule: { schema: "test-only" } as never,
        },
      ),
    );
    const e = expectAbandoned(err, 60, SESSION_PATHS.deliver);
    expect(e.message, "a truncated body was reported as the door's answer").not.toContain("non-JSON");
    expect(e.message).toContain("before the body was fully read");
  });

  it("EXIT 4/4b, THE RACE — a call that COMPLETES just as the deadline fires", async () => {
    const err = await caught(() =>
      postRecover(
        ignoresTheSignal({ where: "body", afterMs: 150, status: 200, body: HONEST_BODY, timeoutMs: 60 }),
        { wire: WIRE, request: { schema: "test-only" } as never, requestSignatureBase64: "AA==" },
      ),
    );
    const e = expectAbandoned(err, 60, SESSION_PATHS.recover);
    expect(e.status, "a complete-but-late answer must not surface as 200").toBe(0);
  });

  it("the withheld-runtime answer cannot ride out on an abandoned call either", async () => {
    const wall = JSON.stringify({
      error: { code: "PAY_RUNTIME_WITHHELD", message: "withheld" },
      activation: { real_value: false },
    });
    const err = await caught(() =>
      postReattest(
        ignoresTheSignal({ where: "body", afterMs: 150, status: 410, body: wall, timeoutMs: 60 }),
        { wire: WIRE, proofHeader: PROOF },
      ),
    );
    const e = expectAbandoned(err, 60, SESSION_PATHS.reattest);
    expect(e.message, "a wall body was believed after the deadline").not.toContain(
      "PAY_RUNTIME_WITHHELD",
    );
    expect(e.status).toBe(0);
  });

  it("NEGATIVE CONTROL: the same late-answering double INSIDE the deadline succeeds, intact", async () => {
    for (const where of ["fetch", "body"] as const) {
      const res = await postReattest(
        ignoresTheSignal({ where, afterMs: 40, status: 200, body: HONEST_BODY, timeoutMs: 2_000 }),
        { wire: WIRE, proofHeader: PROOF },
      );
      expect(res.status, `${where} arm was truncated`).toBe(200);
      expect(res.body).toEqual(JSON.parse(HONEST_BODY));
    }
  });
});

describe("a slow but honest door still succeeds, intact", () => {
  it("an answer inside the deadline is returned whole", async () => {
    const started = Date.now();
    const res = await postReattest(door("slow_but_honest", 2_000), {
      wire: WIRE,
      proofHeader: PROOF,
    });
    expect(Date.now() - started, "the door was supposed to be slow").toBeGreaterThanOrEqual(150);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(HONEST_BODY));
  });

  it("a body delivered in two chunks with a gap is NOT mistaken for a dribble", async () => {
    const res = await postReattest(door("slow_chunked_honest", 2_000), {
      wire: WIRE,
      proofHeader: PROOF,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(HONEST_BODY));
  });
});

describe("the default deadline", () => {
  it("is finite, and is the 120s picked against Cloudflare's own 100s give-up", () => {
    expect(SESSION_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(Number.isFinite(SESSION_DEFAULT_TIMEOUT_MS)).toBe(true);
  });

  it("OMITTING `timeoutMs` arms a signal — the safe-looking 'no timeout' default is gone", async () => {
    let seen: unknown;
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      fetch: (async (_url: string, init: { signal?: unknown }) => {
        seen = init.signal;
        return { status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch,
    };
    await postReattest(ep, { wire: WIRE, proofHeader: PROOF });
    expect(seen, "no deadline was armed by default").toBeInstanceOf(AbortSignal);
    expect((seen as AbortSignal).aborted).toBe(false);
  });

  it("`null` hands the deadline to the caller, and arms nothing", async () => {
    let called = false;
    let seen: unknown = "unset";
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      timeoutMs: null,
      fetch: (async (_url: string, init: { signal?: unknown }) => {
        called = true;
        seen = init.signal;
        return { status: 200, text: async () => "{}" };
      }) as unknown as typeof fetch,
    };
    await postReattest(ep, { wire: WIRE, proofHeader: PROOF });
    expect(called).toBe(true);
    expect(seen, "a caller that owns the deadline must not be given ours").toBe(undefined);
  });
});

describe("timeoutMs is refused rather than reinterpreted", () => {
  it("0, negatives, NaN, Infinity and non-numbers are all refused before a byte is sent", async () => {
    for (const bad of [0, -1, -0, Number.NaN, Number.POSITIVE_INFINITY, "5000", {}]) {
      let called = false;
      const ep: SessionEndpoint = {
        baseUrl: UNDIALLED,
        timeoutMs: bad as number,
        fetch: (async () => {
          called = true;
          return { status: 200, text: async () => "{}" };
        }) as unknown as typeof fetch,
      };
      const err = await caught(() => postReattest(ep, { wire: WIRE, proofHeader: PROOF }));
      expect(err, `timeoutMs ${String(bad)} was accepted`).toBeInstanceOf(SessionUsageError);
      expect((err as SessionUsageError).message).toContain("session_endpoint_timeout_invalid");
      expect(called, `timeoutMs ${String(bad)} still dialled the door`).toBe(false);
    }
  });

  it("it is a USAGE error, NOT a status-0 transport error", async () => {
    const ep: SessionEndpoint = { baseUrl: UNDIALLED, timeoutMs: 0 };
    await expect(postReattest(ep, { wire: WIRE, proofHeader: PROOF })).rejects.not.toBeInstanceOf(
      SessionTransportError,
    );
  });

  it("POSITIVE CONTROL: an ordinary positive timeout is accepted", async () => {
    const res = await postReattest(door("slow_but_honest", 2_000), {
      wire: WIRE,
      proofHeader: PROOF,
    });
    expect(res.status).toBe(200);
  });
});

describe("an unfinished call names what THAT door spends", () => {
  it("the four consequences are mutually exclusive strings", () => {
    const claims = Object.values(DOOR_CLAIM);
    expect(new Set(claims).size).toBe(4);
    for (const a of claims) {
      for (const b of claims) {
        if (a === b) continue;
        expect(a.includes(b), `"${a}" contains "${b}"`).toBe(false);
      }
    }
  });

  it("each door's warning names its own consequence and none of the other three", async () => {
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };
    for (const { path, call } of everyDoor(ep)) {
      const err = await caught(call);
      expect(err).toBeInstanceOf(SessionTransportError);
      expect((err as SessionTransportError).status).toBe(0);
      expectDoorClaim((err as SessionTransportError).message, path);
    }
  });

  it("and it names the move that recovers THAT door", async () => {
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };
    const moves: Readonly<Record<string, string[]>> = {
      [SESSION_PATHS.redeem]: ["postReattest", "Re-present the SAME evidence", "DO NOT PAY AGAIN"],
      [SESSION_PATHS.deliver]: ["Re-present the SAME receipt", "contested"],
      [SESSION_PATHS.recover]: ["Nothing needs recovering", "call it again"],
      [SESSION_PATHS.reattest]: ["FRESHLY MINTED proof header", "provider_proof_replayed"],
    };
    for (const { path, call } of everyDoor(ep)) {
      const err = await caught(call);
      for (const needle of moves[path]) {
        expect((err as SessionTransportError).message, `${path} omitted "${needle}"`).toContain(
          needle,
        );
      }
    }
    const err = await caught(everyDoor(ep)[2].call);
    expect((err as SessionTransportError).message).not.toContain("PAY AGAIN");
    expect((err as SessionTransportError).message).not.toContain("journal row");
  });
});

describe("a request that was provably never sent says so", () => {
  let dialled = 0;
  const counting = (async () => {
    dialled += 1;
    return { status: 200, text: async () => "{}" };
  }) as unknown as typeof fetch;

  it("an unserializable body, a non-string baseUrl and an uncallable fetch are USAGE errors", async () => {
    dialled = 0;
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const cases: Array<[string, SessionEndpoint, unknown]> = [
      ["circular evidence", { baseUrl: UNDIALLED, fetch: counting }, circular],
      ["a BigInt in the evidence", { baseUrl: UNDIALLED, fetch: counting }, { amount: BigInt(1) }],
      [
        "a non-string baseUrl",
        { baseUrl: 7 as unknown as string, fetch: counting },
        { schema: "test-only" },
      ],
      [
        "an uncallable fetch",
        { baseUrl: UNDIALLED, fetch: 42 as unknown as typeof fetch },
        { schema: "test-only" },
      ],
    ];

    for (const [name, ep, evidence] of cases) {
      const err = await caught(() =>
        postRedeem(ep, {
          wire: WIRE,
          acceptance: { schema: "test-only" } as never,
          acceptanceSignatureBase64: "AA==",
          evidence,
          proofHeader: PROOF,
        }),
      );
      expect(err, `${name} was not refused`).toBeInstanceOf(SessionUsageError);
      const e = err as SessionUsageError;
      expect(e.message).toContain("session_request_not_sent");
      expect(e.message).toContain("NOTHING REACHED THE NETWORK");
      expect(e.message).toContain(SESSION_PATHS.redeem);
      expect(e.message, `${name} was dressed as possibly-spent`).not.toContain(
        "THIS IS NOT A REFUSAL",
      );
      expect(e.message).not.toContain(DOOR_CLAIM[SESSION_PATHS.redeem]);
      expect(e.message).not.toContain("session_call_deadline_exceeded");
      expect(err).not.toBeInstanceOf(SessionTransportError);
    }
    expect(dialled, "a request that was refused as unsent still dialled").toBe(0);
  });

  it("POSITIVE CONTROL: a GENUINELY ambiguous failure is still described as possibly-spent", async () => {
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    };
    const err = await caught(() =>
      postRedeem(ep, {
        wire: WIRE,
        acceptance: { schema: "test-only" } as never,
        acceptanceSignatureBase64: "AA==",
        evidence: { schema: "test-only" },
        proofHeader: PROOF,
      }),
    );
    expect(err).toBeInstanceOf(SessionTransportError);
    const e = err as SessionTransportError;
    expect(e.status).toBe(0);
    expect(e.message).toContain("THIS IS NOT A REFUSAL");
    expect(e.message).toContain(DOOR_CLAIM[SESSION_PATHS.redeem]);
    expect(e.message).not.toContain("session_request_not_sent");
  });

  it("a SYNCHRONOUS throw out of the injected fetch stays AMBIGUOUS, deliberately", async () => {
    const ep: SessionEndpoint = {
      baseUrl: UNDIALLED,
      fetch: (() => {
        throw new TypeError("threw before returning a promise");
      }) as unknown as typeof fetch,
    };
    const err = await caught(() => postReattest(ep, { wire: WIRE, proofHeader: PROOF }));
    expect(err).toBeInstanceOf(SessionTransportError);
    expect((err as SessionTransportError).status).toBe(0);
    expect((err as SessionTransportError).message).toContain("THIS IS NOT A REFUSAL");
  });

  it("POSITIVE CONTROL: an ordinary serializable body still goes out", async () => {
    dialled = 0;
    const res = await postRedeem(
      { baseUrl: UNDIALLED, fetch: counting },
      {
        wire: WIRE,
        acceptance: { schema: "test-only" } as never,
        acceptanceSignatureBase64: "AA==",
        evidence: { schema: "test-only", tx: `0x${"7".repeat(64)}` },
        proofHeader: PROOF,
      },
    );
    expect(res.status).toBe(200);
    expect(dialled, "an ordinary body was refused as unsendable").toBe(1);
  });
});

describe("the 120s default is a gate, not a comment", () => {
  type Armed = { delay: number; handle: unknown; unrefCalled: boolean };

  async function withTimerSpy<T>(
    fn: () => Promise<T>,
  ): Promise<{ value: T; armed: Armed[]; cleared: unknown[] }> {
    const armed: Armed[] = [];
    const cleared: unknown[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...a: unknown[]) => void,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const handle = (realSetTimeout as unknown as (...a: unknown[]) => unknown)(cb, delay, ...rest);
      const record: Armed = { delay: delay ?? 0, handle, unrefCalled: false };
      armed.push(record);
      const h = handle as { unref?: () => unknown };
      if (typeof h.unref === "function") {
        const realUnref = h.unref.bind(h);
        h.unref = () => {
          record.unrefCalled = true;
          return realUnref();
        };
      }
      return handle;
    }) as never);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      cleared.push(handle);
      return (realClearTimeout as unknown as (...a: unknown[]) => unknown)(handle);
    }) as never);
    try {
      const value = await fn();
      return { value, armed, cleared };
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  }

  const longOnes = (armed: Armed[]): Armed[] => armed.filter((a) => a.delay >= 1_000);

  it("a call with NO `timeoutMs` arms exactly SESSION_DEFAULT_TIMEOUT_MS", async () => {
    const { value, armed } = await withTimerSpy(() =>
      postReattest({ baseUrl: UNDIALLED, fetch: instantly(200, "{}") }, { wire: WIRE, proofHeader: PROOF }),
    );
    expect(value.status).toBe(200);
    expect(longOnes(armed).map((a) => a.delay)).toEqual([SESSION_DEFAULT_TIMEOUT_MS]);
  });

  it("and a SUCCESSFUL call leaves no live timer behind — cleared AND unref'd", async () => {
    const { armed, cleared } = await withTimerSpy(() =>
      postReattest({ baseUrl: UNDIALLED, fetch: instantly(200, "{}") }, { wire: WIRE, proofHeader: PROOF }),
    );
    const ours = longOnes(armed);
    expect(ours.length).toBe(1);
    expect(ours[0].unrefCalled, "the deadline timer can hold a Node process open").toBe(true);
    expect(cleared, "the deadline timer was not cancelled on the success exit").toContain(
      ours[0].handle,
    );
  });

  it("a caller-supplied `timeoutMs` arms THAT number, and `null` arms nothing", async () => {
    const chosen = await withTimerSpy(() =>
      postReattest(
        { baseUrl: UNDIALLED, timeoutMs: 4_321, fetch: instantly(200, "{}") },
        { wire: WIRE, proofHeader: PROOF },
      ),
    );
    expect(longOnes(chosen.armed).map((a) => a.delay)).toEqual([4_321]);

    const owned = await withTimerSpy(() =>
      postReattest(
        { baseUrl: UNDIALLED, timeoutMs: null, fetch: instantly(200, "{}") },
        { wire: WIRE, proofHeader: PROOF },
      ),
    );
    expect(longOnes(owned.armed), "a caller that owns the deadline was given one").toEqual([]);
  });
});
