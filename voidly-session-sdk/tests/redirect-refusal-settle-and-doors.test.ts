// The x402 facilitator /settle POST and the session doors (redeem, deliver,
// recover, reattest) never follow a redirect, and the doors are only dialled
// over https (or http to a literal loopback address). Redirect cases use two
// local node:http servers and Node's fetch, so "B is never contacted" is a hit
// counter on B. All data is synthetic.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  acceptHire,
  buildRedemptionProofHeader,
  createFacilitatorSubmitter,
  postDeliver,
  postReattest,
  postRecover,
  postRedeem,
  recoverResult,
  SESSION_PATHS,
  SessionTransportError,
  SessionUsageError,
  settleUrlFor,
  x402SessionEvidence,
  type FetchLike,
  type SessionEndpoint,
  type SessionKey,
} from "../src/index";
import { isRedirectRefusal } from "../src/transport";
import { preflight, signedWithRealKey, TX } from "./_facilitatorFixtures";
import { freshHire, NOW, seededEntropy } from "./_fixtures";

const SYNTH = "synthetic-redirect-body-marker";
const FACILITATOR = "https://facilitator.example.test";

// ── two local servers: A redirects, B counts ────────────────────────────────

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((ok) => s.close(ok))));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const addr = s.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return `http://127.0.0.1:${addr.port}`;
}

async function redirectPair(status: number, bReply = "{}") {
  const b = { hits: 0, bodies: [] as string[], headers: [] as Record<string, unknown>[] };
  const bBase = await listen((req, res) => {
    b.hits += 1;
    b.headers.push({ ...req.headers });
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      b.bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(bReply);
    });
  });
  const a = { hits: 0 };
  const aBase = await listen((req, res) => {
    a.hits += 1;
    req.resume();
    res.writeHead(status, { location: `${bBase}${req.url}`, "content-type": "application/json" });
    res.end(JSON.stringify({ note: SYNTH }));
  });
  return { a, b, aBase };
}

// ── the facilitator /settle POST ────────────────────────────────────────────

// settleUrlFor only derives https URLs, so the local test server is reached by
// a fetchImpl that swaps the origin and passes the init through unchanged.
function toLocal(aBase: string, override?: RequestInit): FetchLike {
  return (u, i) => fetch(String(u).replace(FACILITATOR, aBase), { ...i, ...(override ?? {}) });
}

function settleWith(fetchImpl: FetchLike, over: Record<string, unknown> = {}) {
  return createFacilitatorSubmitter({ preflight: preflight(over), fetchImpl });
}

describe("the facilitator /settle POST never follows a redirect", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} from A to B: B is never contacted, outcome is facilitator_redirect_refused`, async () => {
      const { a, b, aBase } = await redirectPair(status, JSON.stringify({ success: true, transaction: TX }));
      const out = await settleWith(toLocal(aBase)).submit(await signedWithRealKey());
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe("facilitator_redirect_refused");
      expect(out.detail).toContain(`(${status})`);
      expect(out.detail).not.toContain(SYNTH);
      expect(a.hits).toBe(1);
      expect(b.hits).toBe(0);
      expect(b.bodies).toEqual([]);
    });
  }

  it("asks fetch for redirect: manual", async () => {
    const inits: RequestInit[] = [];
    const out = await settleWith(async (_u, init) => {
      inits.push(init);
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid/settle" } });
    }).submit(await signedWithRealKey());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("facilitator_redirect_refused");
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
  });

  it("a browser's opaqueredirect is refused before the body is read", async () => {
    let bodyRead = false;
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      redirected: false,
      headers: new Headers(),
      text: async () => { bodyRead = true; return JSON.stringify({ success: true, transaction: TX }); },
    } as unknown as Response;
    const out = await settleWith(async () => opaque).submit(await signedWithRealKey());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("facilitator_redirect_refused");
    expect(bodyRead).toBe(false);
  });

  it("every 3xx is refused, and a hash in the redirect body is never read", async () => {
    const signed = await signedWithRealKey();
    for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
      let bodyRead = false;
      const res = {
        type: "basic",
        status,
        redirected: false,
        headers: new Headers({ location: "https://elsewhere.invalid/settle" }),
        text: async () => { bodyRead = true; return JSON.stringify({ success: true, transaction: TX }); },
      } as unknown as Response;
      const out = await settleWith(async () => res).submit(signed);
      expect(out.ok, `status ${status}`).toBe(false);
      if (!out.ok) expect(out.reason, `status ${status}`).toBe("facilitator_redirect_refused");
      expect(bodyRead, `status ${status}`).toBe(false);
    }
  });

  it("a fetchImpl that ignored manual and followed anyway is caught by `redirected`", async () => {
    const { b, aBase } = await redirectPair(307, JSON.stringify({ success: true, transaction: TX }));
    const out = await settleWith(toLocal(aBase, { redirect: "follow" })).submit(await signedWithRealKey());
    // The fetchImpl, not the SDK, re-sent the body to B. The answer B gave is
    // still not read as a settlement.
    expect(b.hits).toBe(1);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("facilitator_redirect_refused");
    expect(out.detail).toContain("followed it anyway");
  });

  it("a plain 200 from /settle itself still settles", async () => {
    let hits = 0;
    const base = await listen((req, res) => {
      hits += 1;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, transaction: TX }));
      });
    });
    const out = await settleWith(toLocal(base)).submit(await signedWithRealKey());
    expect(hits).toBe(1);
    expect(out).toEqual({ ok: true, transactionHash: TX });
  });
});

describe("the facilitator /settle POST is only sent over https", () => {
  for (const url of [
    "http://facilitator.example.test/supported",
    "http://localhost/supported",
    "http://127.0.0.1:8123/supported",
    "http://[::1]/supported",
    "ftp://facilitator.example.test/supported",
    "not a url",
  ]) {
    it(`refuses a preflight for ${JSON.stringify(url)} with no fetch`, async () => {
      let fetches = 0;
      expect(settleUrlFor(url)).toBe(null);
      const out = await settleWith(async () => {
        fetches += 1;
        throw new Error("must not be reached");
      }, { url }).submit(await signedWithRealKey());
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("facilitator_not_usable");
      expect(fetches).toBe(0);
    });
  }
});

// ── the session doors ───────────────────────────────────────────────────────

async function doorFixture() {
  const { hirer, provider, hire } = await freshHire(0x7e57);
  const accepted = await acceptHire({
    grantHash: hire.keep.grant_hash,
    providerDid: provider.did,
    sign: provider.sign,
    nowMs: NOW + 2_000,
    entropy: seededEntropy(0x7e58),
  });
  if (!accepted.ok) throw new Error("fixture acceptance failed");
  const proofHeader = await buildRedemptionProofHeader({
    providerDid: provider.did,
    grantHash: hire.keep.grant_hash,
    sign: provider.sign,
    nowMs: NOW + 3_000,
  });
  return { hirer, hire, accepted, proofHeader };
}

type Door = [string, (ep: SessionEndpoint) => Promise<unknown>];

async function everyDoor(): Promise<Door[]> {
  const f = await doorFixture();
  return [
    [SESSION_PATHS.redeem, (ep) =>
      postRedeem(ep, {
        wire: f.hire.wire,
        acceptance: f.accepted.acceptance,
        acceptanceSignatureBase64: f.accepted.signature_base64,
        evidence: x402SessionEvidence(TX),
        proofHeader: f.proofHeader,
      })],
    [SESSION_PATHS.deliver, (ep) =>
      postDeliver(ep, {
        wire: f.hire.wire,
        receipt: { schema: "x" } as never,
        receiptSignatureBase64: "sig",
        resultCapsule: { schema: "y" } as never,
      })],
    [SESSION_PATHS.recover, (ep) =>
      postRecover(ep, {
        wire: f.hire.wire,
        request: { schema: "z" } as never,
        requestSignatureBase64: "sig",
      })],
    [SESSION_PATHS.reattest, (ep) => postReattest(ep, { wire: f.hire.wire, proofHeader: f.proofHeader })],
  ];
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

describe("the session doors never follow a redirect", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} from A to B on every door: B is never contacted`, async () => {
      for (const [path, call] of await everyDoor()) {
        const { a, b, aBase } = await redirectPair(status);
        const err = await caught(call({ baseUrl: aBase, fetch: fetch }));
        expect(err, path).toBeInstanceOf(SessionTransportError);
        const e = err as SessionTransportError;
        expect(e.message.startsWith("session_redirect_refused:"), path).toBe(true);
        expect(e.message).toContain(path);
        expect(e.message).not.toContain(SYNTH);
        expect(e.status, path).toBe(status);
        expect(e.body, path).toBe("");
        expect(isRedirectRefusal(e), path).toBe(true);
        expect(a.hits, path).toBe(1);
        expect(b.hits, path).toBe(0);
        expect(b.headers, path).toEqual([]);
      }
    });
  }

  it("asks fetch for redirect: manual on every door", async () => {
    for (const [path, call] of await everyDoor()) {
      const inits: RequestInit[] = [];
      const ep: SessionEndpoint = {
        baseUrl: "https://rail.example.test",
        fetch: (async (_u: string, init: RequestInit) => {
          inits.push(init);
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      };
      await call(ep);
      expect(inits, path).toHaveLength(1);
      expect(inits[0].redirect, path).toBe("manual");
    }
  });

  it("an opaqueredirect, any 3xx, and a followed redirect are refused before the body is read", async () => {
    const shapes: Array<Record<string, unknown>> = [
      { type: "opaqueredirect", status: 0, redirected: false },
      ...[300, 302, 304, 307, 308, 399].map((status) => ({ type: "basic", status, redirected: false })),
      { type: "basic", status: 200, redirected: true },
    ];
    for (const [path, call] of await everyDoor()) {
      for (const shape of shapes) {
        let bodyRead = false;
        const res = {
          ...shape,
          headers: new Headers(),
          text: async () => { bodyRead = true; return "{}"; },
        } as unknown as Response;
        const err = await caught(call({
          baseUrl: "https://rail.example.test",
          fetch: (async () => res) as unknown as typeof fetch,
        }));
        const label = `${path} ${JSON.stringify(shape)}`;
        expect(err, label).toBeInstanceOf(SessionTransportError);
        expect(isRedirectRefusal(err), label).toBe(true);
        expect(bodyRead, label).toBe(false);
      }
    }
  });

  it("ordinary transport errors are not redirect refusals", async () => {
    const [[, call]] = await everyDoor();
    const err = await caught(call({
      baseUrl: "https://rail.example.test",
      fetch: (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch,
    }));
    expect(err).toBeInstanceOf(SessionTransportError);
    expect(isRedirectRefusal(err)).toBe(false);
    expect(isRedirectRefusal(new Error("session_redirect_refused: forged"))).toBe(false);
  });
});

describe("the session doors are only dialled over https, or http to a literal loopback address", () => {
  const refused = [
    "http://rail.example.test",
    "http://localhost",
    "http://localhost:8080",
    "http://127.0.0.1.example.test",
    "http://10.0.0.1",
    "http://[::ffff:127.0.0.1]",
    "ws://127.0.0.1",
    "ftp://rail.example.test",
    "not a url",
    "",
  ];
  for (const baseUrl of refused) {
    it(`refuses ${JSON.stringify(baseUrl)} on every door with no fetch`, async () => {
      for (const [path, call] of await everyDoor()) {
        let fetches = 0;
        const err = await caught(call({
          baseUrl,
          fetch: (async () => { fetches += 1; throw new Error("must not be reached"); }) as unknown as typeof fetch,
        }));
        expect(err, path).toBeInstanceOf(SessionUsageError);
        expect((err as Error).message.startsWith("session_url_not_https:"), path).toBe(true);
        expect(fetches, path).toBe(0);
      }
    });
  }

  const allowed = [
    "https://rail.example.test",
    "http://127.0.0.1:8123",
    "http://127.9.8.7",
    "http://[::1]",
    "http://[::1]:8123/",
  ];
  for (const baseUrl of allowed) {
    it(`allows ${baseUrl}`, async () => {
      for (const [path, call] of await everyDoor()) {
        const seen: string[] = [];
        await call({
          baseUrl,
          fetch: (async (u: string) => {
            seen.push(u);
            return new Response("{}", { status: 200 });
          }) as unknown as typeof fetch,
        });
        expect(seen, path).toEqual([`${baseUrl.replace(/\/+$/, "")}${path}`]);
      }
    });
  }
});

// ── recoverResult names both refusals ───────────────────────────────────────

async function recoverWith(endpoint: SessionEndpoint, sign?: (b: Uint8Array) => Promise<Uint8Array> | Uint8Array) {
  const { hirer, hire } = await freshHire(0x7e59);
  return recoverResult({
    endpoint,
    wire: hire.wire,
    grantHash: hire.keep.grant_hash,
    sessionKey: hire.keep.sessionKey as SessionKey,
    sign: sign ?? hirer.sign,
    nowMs: NOW + 7_000,
    entropy: seededEntropy(0x7e5a),
  });
}

describe("recoverResult", () => {
  for (const baseUrl of ["http://rail.example.test", "http://localhost:8080", "not a url"]) {
    it(`refuses ${JSON.stringify(baseUrl)} as unbuildable, with no signature and no fetch`, async () => {
      let fetches = 0;
      let signs = 0;
      const { hirer } = await freshHire(0x7e59);
      const out = await recoverWith(
        {
          baseUrl,
          fetch: (async () => { fetches += 1; throw new Error("must not be reached"); }) as unknown as typeof fetch,
        },
        (bytes) => { signs += 1; return hirer.sign(bytes); },
      );
      expect(out).toEqual({ kind: "unbuildable", reason: "recover_url_not_https" });
      expect(fetches).toBe(0);
      expect(signs).toBe(0);
    });
  }

  for (const status of [302, 307, 308]) {
    it(`a ${status} is unrecognized / recover_redirect_refused, and B is never contacted`, async () => {
      const { a, b, aBase } = await redirectPair(status);
      const out = await recoverWith({ baseUrl: aBase, fetch: fetch });
      expect(out).toEqual({ kind: "unrecognized", status, detail: "recover_redirect_refused" });
      expect(a.hits).toBe(1);
      expect(b.hits).toBe(0);
    });
  }

  it("an opaqueredirect is unrecognized with status 0, not undelivered", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      redirected: false,
      headers: new Headers(),
      text: async () => "{}",
    } as unknown as Response;
    const out = await recoverWith({
      baseUrl: "https://rail.example.test",
      fetch: (async () => opaque) as unknown as typeof fetch,
    });
    expect(out).toEqual({ kind: "unrecognized", status: 0, detail: "recover_redirect_refused" });
  });
});
