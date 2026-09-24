// The hire and settlement-hint POSTs go only to the URL they were given, over
// https (or http to a literal loopback address), and never follow a redirect.
// Redirect cases use two local node:http servers and Node's fetch, so "B is
// never contacted" is a hit counter on B. All data is synthetic.

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import nacl from "tweetnacl";
import { Wallet } from "ethers";

import {
  authorizationValidBeforeFor,
  buildHire,
  buildTransferAuthorizationTypedData,
  PAYMENT_AUTHORIZATION_SCHEME,
  settlementBindingReference,
  submitHire,
  submitSettlementHint,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
  x402SessionEvidence,
} from "../src/index";
import type { FetchLike, HireWire, PaymentAuthorization, Signer } from "../src/index";
import {
  BRIEF,
  CHAIN,
  GRANT_TTL_MS,
  NOW,
  OFFER_TTL_MS,
  PAYEE_ADDR,
  PAYER_ADDR,
  PRICE,
  party,
  seededEntropy,
  verifiedProviderFor,
} from "./_fixtures";

const SYNTH = "synthetic-redirect-body-marker";

interface Built {
  wire: HireWire;
  grantHash: string;
  authorization: PaymentAuthorization;
  sign: Signer;
}

// A hire that builds cleanly, so each refusal below is the one under test.
async function builtHire(): Promise<Built> {
  const hirer = party(1);
  const provider = party(2);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
  const price = {
    chain: CHAIN,
    asset: x402SessionAssetCaip19(CHAIN)!,
    payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
    minAmount: PRICE,
    maxAmount: PRICE,
  };
  const built = await buildHire({
    hirer: { did: hirer.did, signingPublicKeyBase64: hirer.signingPublicKeyBase64, sign: hirer.sign },
    provider: verifiedProviderFor(provider, providerEnc, price),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: BRIEF },
    price: { ...price, payerAccount: x402SessionAccountCaip10(CHAIN, PAYER_ADDR)! },
    ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS },
    nowMs: NOW,
    entropy: seededEntropy(0x5a5a5a),
  });
  if (!built.ok) throw new Error(`fixture hire failed: ${built.reason}`);
  const grant = built.wire.grant;
  const grantHash = built.keep.grant_hash;

  const validBefore = authorizationValidBeforeFor(grant);
  if (validBefore === null) throw new Error("fixture grant has an unparseable expires_at");
  const typed = await buildTransferAuthorizationTypedData({
    chain: grant.price_chain,
    from: grant.price_payer_account,
    to: grant.price_payee_account,
    value: grant.price_min_amount,
    validAfter: 0,
    validBefore: Number(validBefore),
    grantHash,
  });
  if (!typed.ok) throw new Error(`fixture typed data failed: ${typed.reason}`);
  // A throwaway key minted in-process. No real key material.
  const signature = await Wallet.createRandom().signTypedData(
    typed.typedData.domain,
    { TransferWithAuthorization: [...typed.typedData.types.TransferWithAuthorization] },
    typed.typedData.message,
  );
  const authorization = {
    scheme: PAYMENT_AUTHORIZATION_SCHEME,
    chain: grant.price_chain,
    asset: grant.price_asset,
    from: grant.price_payer_account,
    to: grant.price_payee_account,
    value: grant.price_min_amount,
    valid_after: "0",
    valid_before: validBefore,
    nonce: await settlementBindingReference(grantHash),
    signature,
  } as unknown as PaymentAuthorization;
  return { wire: built.wire, grantHash, authorization, sign: hirer.sign };
}

function submit(b: Built, url: string, fetchImpl: FetchLike, sign: Signer = b.sign) {
  return submitHire({
    url,
    wire: b.wire,
    grantHash: b.grantHash,
    authorization: b.authorization,
    sign,
    nowMs: NOW,
    fetchImpl,
  });
}

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

async function redirectPair(status: number) {
  const b = { hits: 0, bodies: [] as string[] };
  const bBase = await listen((req, res) => {
    b.hits += 1;
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      b.bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const a = { hits: 0 };
  const aBase = await listen((req, res) => {
    a.hits += 1;
    req.resume();
    res.writeHead(status, { location: `${bBase}/session/accept`, "content-type": "application/json" });
    res.end(JSON.stringify({ note: SYNTH }));
  });
  return { a, b, aUrl: `${aBase}/session/accept` };
}

const nodeFetch: FetchLike = (u, i) => fetch(u, i);

describe("postHire never follows a redirect", () => {
  for (const status of [307, 308]) {
    it(`a ${status} from A to B: B is never contacted, outcome is hire_redirect_refused`, async () => {
      const hire = await builtHire();
      const { a, b, aUrl } = await redirectPair(status);
      const out = await submit(hire, aUrl, nodeFetch);
      expect(out).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
      expect(a.hits).toBe(1);
      expect(b.hits).toBe(0);
      expect(b.bodies).toEqual([]);
      expect(JSON.stringify(out)).not.toContain(SYNTH);
    });
  }

  it("asks fetch for redirect: manual", async () => {
    const hire = await builtHire();
    const inits: RequestInit[] = [];
    const out = await submit(hire, "https://provider.invalid/session/accept", async (_u, init) => {
      inits.push(init);
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } });
    });
    expect(out).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
  });

  it("a browser's opaqueredirect is refused BEFORE the body is read", async () => {
    const hire = await builtHire();
    let bodyRead = false;
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
      text: async () => { bodyRead = true; return ""; },
      json: async () => { bodyRead = true; return {}; },
    } as unknown as Response;
    const out = await submit(hire, "https://provider.invalid/session/accept", async () => opaque);
    expect(out).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
    expect(bodyRead).toBe(false);
  });

  it("every 3xx is refused, and the redirect body is never read", async () => {
    const hire = await builtHire();
    for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
      let bodyRead = false;
      const res = {
        type: "basic",
        status,
        ok: false,
        headers: new Headers({ location: "https://elsewhere.invalid/" }),
        text: async () => { bodyRead = true; return JSON.stringify({ note: SYNTH }); },
      } as unknown as Response;
      const out = await submit(hire, "https://provider.invalid/session/accept", async () => res);
      expect(out, `status ${status}`).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
      expect(bodyRead, `status ${status}`).toBe(false);
    }
  });

  it("a fetchImpl that ignored manual and followed anyway is caught by `redirected`", async () => {
    const hire = await builtHire();
    const { b, aUrl } = await redirectPair(307);
    const following: FetchLike = (u, i) => fetch(u, { ...i, redirect: "follow" });
    const out = await submit(hire, aUrl, following);
    // The fetchImpl, not the SDK, re-sent the hire to B. B's answer is still
    // not read as the provider's.
    expect(b.hits).toBe(1);
    expect(out).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
  });

  it("`redirected` is checked before the body is read", async () => {
    const hire = await builtHire();
    let bodyRead = false;
    const followed = {
      type: "basic",
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => { bodyRead = true; return JSON.stringify({ note: SYNTH }); },
    } as unknown as Response;
    const out = await submit(hire, "https://provider.invalid/session/accept", async () => followed);
    expect(out).toEqual({ kind: "undelivered", detail: "hire_redirect_refused" });
    expect(bodyRead).toBe(false);
  });

  it("a 200 and a 5xx still go down the ordinary path (the floor is 3xx only)", async () => {
    const hire = await builtHire();
    const ok = await submit(hire, "https://provider.invalid/session/accept", async () =>
      new Response("not json", { status: 200 }));
    expect(ok).toEqual({ kind: "unverifiable", detail: "response_malformed" });
    const down = await submit(hire, "https://provider.invalid/session/accept", async () =>
      new Response("<html>bad gateway</html>", { status: 502 }));
    expect(down).toEqual({ kind: "undelivered", detail: "response_not_json" });
  });
});

describe("submitHire sends only over https, or http to a literal loopback address", () => {
  const refused = [
    "http://example.test/session/accept",
    "http://provider.invalid/session/accept",
    "http://127.0.0.1.example.test/session/accept",
    "http://localhost/session/accept",
    "http://localhost:8080/session/accept",
    "http://localhost./session/accept",
    "http://10.0.0.1/session/accept",
    "http://[::ffff:127.0.0.1]/session/accept",
    "ftp://provider.invalid/session/accept",
    "ws://127.0.0.1/session/accept",
    "file:///etc/hosts",
    "not a url",
    "",
  ];
  for (const url of refused) {
    it(`refuses ${JSON.stringify(url)} with no fetch and no signature`, async () => {
      const hire = await builtHire();
      let fetches = 0;
      let signs = 0;
      const out = await submit(
        hire,
        url,
        async () => { fetches += 1; throw new Error("must not be reached"); },
        (bytes) => { signs += 1; return hire.sign(bytes); },
      );
      expect(out).toEqual({ kind: "unbuildable", reason: "hire_url_not_https" });
      expect(fetches).toBe(0);
      expect(signs).toBe(0);
      if (url) expect(JSON.stringify(out)).not.toContain(url);
    });
  }

  const allowed = [
    "https://provider.invalid/session/accept",
    "http://127.0.0.1:8123/session/accept",
    "http://127.9.8.7/session/accept",
    "http://[::1]/session/accept",
    "http://[::1]:8123/session/accept",
  ];
  for (const url of allowed) {
    it(`allows ${url}: fetch is called once with that exact URL`, async () => {
      const hire = await builtHire();
      const seen: string[] = [];
      const out = await submit(hire, url, async (u) => {
        seen.push(u);
        return new Response("<html>down</html>", { status: 503 });
      });
      expect(seen).toEqual([url]);
      expect(out).toEqual({ kind: "undelivered", detail: "response_not_json" });
    });
  }

  it("a real loopback provider over http is reached", async () => {
    const hire = await builtHire();
    let hits = 0;
    const base = await listen((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("down");
    });
    const out = await submit(hire, `${base}/session/accept`, nodeFetch);
    expect(hits).toBe(1);
    expect(out).toEqual({ kind: "undelivered", detail: "response_not_json" });
  });
});

// ── the settlement-hint door gets the same two floors ───────────────────────

const HINT_TX = `0x${"5c".repeat(32)}`;

function hint(b: Built, url: string, fetchImpl: FetchLike) {
  return submitSettlementHint({
    url,
    grant: b.wire.grant,
    grantHash: b.grantHash,
    evidence: x402SessionEvidence(HINT_TX),
    sign: b.sign,
    nowMs: NOW,
    fetchImpl,
  });
}

describe("submitSettlementHint never follows a redirect", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} from A to B: B is never contacted and nothing is acknowledged`, async () => {
      const hire = await builtHire();
      const b = { hits: 0 };
      const bBase = await listen((req, res) => {
        b.hits += 1;
        req.resume();
        req.on("end", () => {
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "accepted" }));
        });
      });
      const aBase = await listen((req, res) => {
        req.resume();
        res.writeHead(status, { location: `${bBase}/session/deliver-hint` });
        res.end(JSON.stringify({ status: "accepted", note: SYNTH }));
      });
      const out = await hint(hire, `${aBase}/session/deliver-hint`, nodeFetch);
      expect(b.hits).toBe(0);
      expect(out).toEqual({ kind: "unrecognized", status, detail: "hint_redirect_refused" });
      expect(JSON.stringify(out)).not.toContain(SYNTH);
    });
  }

  it("asks fetch for redirect: manual", async () => {
    const hire = await builtHire();
    const inits: RequestInit[] = [];
    await hint(hire, "https://provider.invalid/session/deliver-hint", async (_u, init) => {
      inits.push(init);
      return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
    });
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
  });

  it("an opaqueredirect is refused before the body is read", async () => {
    const hire = await builtHire();
    let bodyRead = false;
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      redirected: false,
      headers: new Headers(),
      text: async () => { bodyRead = true; return JSON.stringify({ status: "accepted" }); },
    } as unknown as Response;
    const out = await hint(hire, "https://provider.invalid/session/deliver-hint", async () => opaque);
    expect(out).toEqual({ kind: "unrecognized", status: 0, detail: "hint_redirect_refused" });
    expect(bodyRead).toBe(false);
  });

  it("a fetchImpl that ignored manual and followed anyway is caught by `redirected`", async () => {
    const hire = await builtHire();
    const followed = {
      type: "basic",
      status: 202,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ status: "accepted" }),
    } as unknown as Response;
    const out = await hint(hire, "https://provider.invalid/session/deliver-hint", async () => followed);
    expect(out).toEqual({ kind: "unrecognized", status: 202, detail: "hint_redirect_refused" });
  });

  it("a plain 202 accepted from the door itself is still acknowledged", async () => {
    const hire = await builtHire();
    const out = await hint(hire, "https://provider.invalid/session/deliver-hint", async () =>
      new Response(JSON.stringify({ status: "accepted" }), { status: 202 }));
    expect(out.kind).toBe("acknowledged");
  });
});

describe("submitSettlementHint sends only over https, or http to a literal loopback address", () => {
  const refused = [
    "http://provider.example.test/session/deliver-hint",
    "http://127.0.0.1.example.test/session/deliver-hint",
    "http://localhost/session/deliver-hint",
    "http://10.0.0.1/session/deliver-hint",
    "ws://127.0.0.1/session/deliver-hint",
    "not a url",
  ];
  for (const url of refused) {
    it(`refuses ${JSON.stringify(url)} with no fetch and no signature`, async () => {
      const hire = await builtHire();
      let fetches = 0;
      let signs = 0;
      const out = await submitSettlementHint({
        url,
        grant: hire.wire.grant,
        grantHash: hire.grantHash,
        evidence: x402SessionEvidence(HINT_TX),
        sign: (bytes) => { signs += 1; return hire.sign(bytes); },
        nowMs: NOW,
        fetchImpl: async () => { fetches += 1; throw new Error("must not be reached"); },
      });
      expect(out).toEqual({ kind: "unbuildable", reason: "hint_url_not_https" });
      expect(fetches).toBe(0);
      expect(signs).toBe(0);
      expect(JSON.stringify(out)).not.toContain(url);
    });
  }

  for (const url of ["https://provider.invalid/h", "http://127.0.0.1:8123/h", "http://[::1]/h"]) {
    it(`allows ${url}`, async () => {
      const hire = await builtHire();
      const seen: string[] = [];
      const out = await hint(hire, url, async (u) => {
        seen.push(u);
        return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
      });
      expect(seen).toEqual([url]);
      expect(out.kind).toBe("acknowledged");
    });
  }
});
