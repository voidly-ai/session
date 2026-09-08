import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySettlement } from "../src/index";
import { RpcReadError } from "../src/settlementRpc";

const CAP = 4 * 1024 * 1024;
const SECRET = "DO_NOT_ECHO_RPC_SECRET_https://user:password@rpc.example/key";
const TERMS = {
  tx: `0x${"ab".repeat(32)}`,
  grantHash: "aa".repeat(32),
  payer: `0x${"11".repeat(20)}`,
  payee: `0x${"22".repeat(20)}`,
  amount: "50000",
  rpcUrls: ["https://rpc-a.example.test/key", "https://rpc-b.example.test/key"],
  allowedRpcHosts: ["rpc-a.example.test", "rpc-b.example.test"],
};
type Post = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Handler = (post: Post, init: RequestInit, call: number) => Response | Promise<Response>;
function response(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), init);
}
function admitted(post: Post): Response {
  return response({ jsonrpc: "2.0", id: post.id, result: post.method === "eth_chainId" ? "0x2105" : null });
}
function transport(handler: Handler = admitted) {
  const posts: Post[] = [];
  const calls = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const post = JSON.parse(String(init?.body)) as Post;
    posts.push(post);
    return handler(post, init!, posts.length);
  });
  const run = () => verifySettlement({ ...TERMS, fetch: calls as typeof globalThis.fetch });
  return { posts, calls, run };
}
function refusal(result: Awaited<ReturnType<typeof verifySettlement>>, reason: string) {
  expect(result).toMatchObject({ ok: false, reason });
  expect(JSON.stringify(result)).not.toContain(SECRET);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("settlement HTTP transport through the public verifier", () => {
  it("sends only admitted reads with numeric IDs, pinned redirect behavior, and JSON bodies", async () => {
    const rpc = transport((post, init) => {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(post.jsonrpc).toBe("2.0");
      expect(Number.isSafeInteger(post.id)).toBe(true);
      expect(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber"]).toContain(post.method);
      expect(post.params).toEqual(post.method === "eth_chainId" ? [] : [TERMS.tx]);
      return admitted(post);
    });
    refusal(await rpc.run(), "tx_not_found");
    expect(rpc.posts.map(post => post.method)).toEqual([
      "eth_chainId", "eth_chainId", "eth_getTransactionReceipt", "eth_getTransactionReceipt",
    ]);
    expect(new Set(rpc.posts.map(post => post.id)).size).toBe(4);
  });

  it("refuses a declared body above 4 MiB before reading its stream", async () => {
    const pull = vi.fn(), cancel = vi.fn();
    const rpc = transport(() => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { "content-length": String(CAP + 1) },
    }));
    refusal(await rpc.run(), "rpc_body_too_large");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("caps cumulative streamed bytes even when content-length understates them", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const rpc = transport(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new Uint8Array(chunk <= 2 ? CAP / 2 : 1));
      }, cancel,
    }, { highWaterMark: 0 }), { headers: { "content-length": "1" } }));
    refusal(await rpc.run(), "rpc_body_too_large");
    expect(chunk).toBe(3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 4 MiB, including trailing JSON whitespace", async () => {
    const rpc = transport((post, _init, call) => {
      if (call !== 1) return admitted(post);
      const json = JSON.stringify({ jsonrpc: "2.0", id: post.id, result: "0x2105" });
      return new Response(json + " ".repeat(CAP - json.length), { headers: { "content-length": String(CAP) } });
    });
    refusal(await rpc.run(), "tx_not_found");
    expect(rpc.calls).toHaveBeenCalledTimes(4);
  });

  it("counts UTF-8 bytes rather than JavaScript characters", async () => {
    const rpc = transport(post => {
      const json = JSON.stringify({ jsonrpc: "2.0", id: post.id, result: "0x2105", padding: "é".repeat(CAP / 2) });
      expect(json.length).toBeLessThan(CAP);
      return new Response(json);
    });
    refusal(await rpc.run(), "rpc_body_too_large");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("allows depth 64 and ignores escaped brackets within strings", async () => {
    const rpc = transport((post, _init, call) => {
      if (call !== 1) return admitted(post);
      let padding: unknown = "[".repeat(100) + '\\"}]' + "\\";
      for (let index = 0; index < 63; index += 1) padding = [padding];
      return response({ jsonrpc: "2.0", id: post.id, result: "0x2105", padding });
    });
    refusal(await rpc.run(), "tx_not_found");
  });

  it("refuses depth 65 before attempting to parse even malformed JSON", async () => {
    const rpc = transport(post => new Response(`{"jsonrpc":"2.0","id":${post.id},"result":${"[".repeat(64)}`));
    refusal(await rpc.run(), "rpc_body_too_deep");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty body", () => new Response(null, { status: 204 })],
    ["non-JSON body", () => new Response(SECRET)],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff, 0xfe]))],
  ] as const)("does not retry %s", async (_label, make) => {
    const rpc = transport(make);
    refusal(await rpc.run(), "rpc_json_invalid");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  const malformedEnvelopes: [string, (post: Post) => unknown][] = [
    ["array envelope", () => []],
    ["null envelope", () => null],
    ["scalar envelope", () => SECRET],
    ["missing version", post => ({ id: post.id, result: null })],
    ["wrong version", post => ({ jsonrpc: "1.0", id: post.id, result: null })],
    ["missing ID", () => ({ jsonrpc: "2.0", result: null })],
    ["wrong numeric ID", post => ({ jsonrpc: "2.0", id: post.id + 1, result: null })],
    ["string ID", post => ({ jsonrpc: "2.0", id: String(post.id), result: null })],
    ["null ID", () => ({ jsonrpc: "2.0", id: null, result: null })],
    ["no result or error", post => ({ jsonrpc: "2.0", id: post.id })],
    ["result plus error", post => ({ jsonrpc: "2.0", id: post.id, result: null, error: { code: -32000, message: SECRET } })],
    ["result plus null error", post => ({ jsonrpc: "2.0", id: post.id, result: null, error: null })],
    ["null error", post => ({ jsonrpc: "2.0", id: post.id, error: null })],
    ["array error", post => ({ jsonrpc: "2.0", id: post.id, error: [] })],
    ["string error", post => ({ jsonrpc: "2.0", id: post.id, error: SECRET })],
    ["missing error code", post => ({ jsonrpc: "2.0", id: post.id, error: { message: SECRET } })],
    ["fractional error code", post => ({ jsonrpc: "2.0", id: post.id, error: { code: 1.5, message: SECRET } })],
    ["string error code", post => ({ jsonrpc: "2.0", id: post.id, error: { code: "-32000", message: SECRET } })],
    ["missing error message", post => ({ jsonrpc: "2.0", id: post.id, error: { code: -32000 } })],
  ];
  it.each(malformedEnvelopes)("refuses %s without retry or response-text disclosure", async (_label, make) => {
    const rpc = transport(post => response(make(post)));
    refusal(await rpc.run(), "rpc_envelope_invalid");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("refuses a valid remote JSON-RPC error without retry or message/data disclosure", async () => {
    const rpc = transport(post => response({ jsonrpc: "2.0", id: post.id, error: { code: -32000, message: SECRET, data: SECRET } }));
    refusal(await rpc.run(), "rpc_error");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 307, 308])("refuses HTTP %s redirects without a second endpoint request", async status => {
    const rpc = transport(() => new Response(SECRET, { status, headers: { location: `https://redirect.example/${SECRET}` } }));
    refusal(await rpc.run(), "rpc_redirect");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("refuses a Response marked redirected even when status is successful", async () => {
    const rpc = transport(post => Object.defineProperty(admitted(post), "redirected", { value: true }));
    refusal(await rpc.run(), "rpc_redirect");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 408])("does not retry HTTP %s or disclose its body", async status => {
    const rpc = transport(() => new Response(SECRET, { status }));
    refusal(await rpc.run(), "rpc_http");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503, 599, "fetch failed"] as const)("retries %s only after 400 and 1200 ms, then accepts the third answer", async failure => {
    vi.useFakeTimers();
    const rpc = transport((post, _init, call) => {
      if (call > 2) return admitted(post);
      if (typeof failure === "number") return new Response(SECRET, { status: failure });
      throw new TypeError(failure);
    });
    const pending = rpc.run();
    await vi.advanceTimersByTimeAsync(399);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rpc.calls).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1199);
    expect(rpc.calls).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    refusal(await pending, "tx_not_found");
    expect(rpc.posts.slice(0, 3).map(post => post.method)).toEqual(["eth_chainId", "eth_chainId", "eth_chainId"]);
    expect(new Set(rpc.posts.map(post => post.id)).size).toBe(6);
    expect(rpc.calls).toHaveBeenCalledTimes(6);
  });

  it.each([429, 503, "fetch failed"] as const)("exhausts exactly three attempts for %s", async failure => {
    vi.useFakeTimers();
    const rpc = transport(() => {
      if (typeof failure === "number") return new Response(SECRET, { status: failure });
      throw new TypeError(failure);
    });
    const pending = rpc.run();
    await vi.advanceTimersByTimeAsync(1600);
    refusal(await pending, typeof failure === "number" ? "rpc_http" : "rpc_network");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(rpc.calls).toHaveBeenCalledTimes(3);
  });

  it("rejects an old numeric ID after a retry instead of accepting a stale answer", async () => {
    vi.useFakeTimers();
    let firstId = 0;
    const rpc = transport((post, _init, call) => {
      if (call === 1) { firstId = post.id; return new Response(null, { status: 503 }); }
      return response({ jsonrpc: "2.0", id: firstId, result: "0x2105" });
    });
    const pending = rpc.run();
    await vi.advanceTimersByTimeAsync(400);
    refusal(await pending, "rpc_envelope_invalid");
    expect(rpc.calls).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ordinary Error", () => new Error("fetch failed")],
    ["expanded TypeError", () => new TypeError(`fetch failed ${SECRET}`)],
    ["remote-looking error", () => ({ name: "RpcReadError", code: SECRET, retryable: true })],
    ["throwing error accessor", () => Object.defineProperty(new TypeError(), "message", { get() { throw new Error(SECRET); } })],
  ] as const)("wraps %s without retry or raw-text disclosure", async (_label, error) => {
    const rpc = transport(() => { throw error(); });
    refusal(await rpc.run(), "rpc_network");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("does not apply the fetch retry policy to a failed response stream", async () => {
    const rpc = transport(() => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("fetch failed")); },
    })));
    refusal(await rpc.run(), "rpc_network");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("redacts exceptions from an injected Response accessor", async () => {
    const rpc = transport(post => Object.defineProperty(admitted(post), "headers", {
      get() { throw { code: SECRET, retryable: true }; },
    }));
    refusal(await rpc.run(), "rpc_network");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("does not admit a forged RpcReadError thrown while snapshotting caller input", async () => {
    const readCode = vi.fn(() => SECRET);
    const forged = Object.create(RpcReadError.prototype, { code: { get: readCode } });
    const calls = vi.fn();
    const input = new Proxy({ ...TERMS, fetch: calls as typeof globalThis.fetch }, {
      ownKeys() { throw forged; },
    });
    refusal(await verifySettlement(input), "verifier_exception");
    expect(readCode).not.toHaveBeenCalled();
    expect(calls).not.toHaveBeenCalled();
  });

  it.each(["fetch", "stream"] as const)("refuses late %s completion after a wall-clock backstep before timer dispatch", async phase => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => 1_000 + elapsed);
    let complete!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const rpc = transport((post, _init, call) => {
      if (call !== 1) return admitted(post);
      if (phase === "fetch") return new Promise<Response>(resolve => {
        complete = () => resolve(admitted(post));
        ready();
      });
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: post.id, result: "0x2105" })));
            return;
          }
          complete = () => controller.close();
          ready();
        },
      }, { highWaterMark: 0 }));
    });
    const pending = rpc.run();
    await waiting;
    vi.setSystemTime(new Date("2026-09-07T23:59:00Z"));
    elapsed = 20_000;
    complete();
    refusal(await pending, "rpc_timeout");
    expect(rpc.calls).toHaveBeenCalledTimes(1);
    expect(rpc.calls.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a fetch that never settles at 20 seconds and never retries it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined, settled = false;
    const rpc = transport((_post, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });
    const pending = rpc.run().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    refusal(await pending, "rpc_timeout");
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("shares one 20-second deadline across fetch and a stream whose read/cancel never settle", async () => {
    vi.useFakeTimers();
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let settled = false;
    const rpc = transport(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }))), 10_000);
    }));
    const pending = rpc.run().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    refusal(await pending, "rpc_timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });

  it("cancels a response that arrives after timeout without reading or retrying it", async () => {
    vi.useFakeTimers();
    let deliver!: (value: Response) => void;
    const rpc = transport(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const pending = rpc.run();
    await vi.advanceTimersByTimeAsync(20_000);
    refusal(await pending, "rpc_timeout");
    const pull = vi.fn(), cancel = vi.fn();
    deliver(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(rpc.calls).toHaveBeenCalledTimes(1);
  });
});
