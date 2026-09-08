const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const ATTEMPT_TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [400, 1200] as const;
const READ_METHODS = new Set([
  "eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_blockNumber",
]);
const ERROR_CODES = new Set([
  "rpc_body_too_large", "rpc_body_too_deep", "rpc_timeout", "rpc_redirect",
  "rpc_http", "rpc_network", "rpc_json_invalid", "rpc_envelope_invalid",
  "rpc_error", "rpc_method_refused",
] as const);
type RpcReadErrorCode = typeof ERROR_CODES extends Set<infer Code> ? Code : never;
const issuedErrors = new WeakSet<RpcReadError>();

export class RpcReadError extends Error {
  readonly code: RpcReadErrorCode;
  readonly retryable: boolean;

  constructor(code: RpcReadErrorCode, retryable = false) {
    const admitted = ERROR_CODES.has(code) ? code : "rpc_network";
    super(admitted);
    this.name = "RpcReadError";
    this.code = admitted;
    this.retryable = retryable === true && (admitted === "rpc_http" || admitted === "rpc_network");
    issuedErrors.add(this);
    Object.freeze(this);
  }
}

export function rpcReadErrorCode(value: unknown): RpcReadErrorCode | null {
  return issuedErrors.has(value as RpcReadError) ? (value as RpcReadError).code : null;
}

function tooDeep(text: string): boolean {
  let depth = 0, inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1;
      else if (char === 0x22) inString = false;
    } else if (char === 0x22) inString = true;
    else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > MAX_DEPTH) return true;
    } else if (char === 0x5d || char === 0x7d) depth -= 1;
  }
  return false;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function parseResponse(text: string, id: number): unknown {
  if (tooDeep(text)) throw new RpcReadError("rpc_body_too_deep");
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new RpcReadError("rpc_json_invalid"); }
  if (!record(body) || !own(body, "jsonrpc") || body.jsonrpc !== "2.0"
    || !own(body, "id") || typeof body.id !== "number" || body.id !== id) {
    throw new RpcReadError("rpc_envelope_invalid");
  }
  const hasResult = own(body, "result"), hasError = own(body, "error");
  if (hasResult === hasError) throw new RpcReadError("rpc_envelope_invalid");
  if (hasError) {
    if (!record(body.error) || !own(body.error, "code") || !Number.isInteger(body.error.code)
      || !own(body.error, "message") || typeof body.error.message !== "string") {
      throw new RpcReadError("rpc_envelope_invalid");
    }
    throw new RpcReadError("rpc_error");
  }
  return body.result;
}

function fetchFailed(error: unknown): boolean {
  try { return error instanceof TypeError && error.message === "fetch failed"; }
  catch { return false; }
}

async function readOnce(
  fetchImpl: typeof globalThis.fetch, url: string, method: string, params: readonly unknown[], id: number,
): Promise<unknown> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timedOut = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    try {
      const pending = reader ? reader.cancel() : response?.body?.cancel();
      if (pending) void pending.catch(() => {});
    } catch { }
  };
  const checkDeadline = () => {
    if (timedOut || performance.now() - startedAt >= ATTEMPT_TIMEOUT_MS) {
      timedOut = true;
      throw new RpcReadError("rpc_timeout");
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new RpcReadError("rpc_timeout"));
      controller.abort();
      cancel();
    }, ATTEMPT_TIMEOUT_MS);
  });
  const task = async () => {
    try {
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", "accept-encoding": "identity" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch (error) {
        checkDeadline();
        throw new RpcReadError("rpc_network", fetchFailed(error));
      }
      checkDeadline();
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new RpcReadError("rpc_redirect");
      }
      if (!response.ok) {
        throw new RpcReadError("rpc_http", response.status === 429 || (response.status >= 500 && response.status <= 599));
      }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
        throw new RpcReadError("rpc_body_too_large");
      }
      if (!response.body) throw new RpcReadError("rpc_json_invalid");
      reader = response.body.getReader();
      let bytes = new Uint8Array(16 * 1024), total = 0;
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await reader.read(); }
        catch { checkDeadline(); throw new RpcReadError("rpc_network"); }
        checkDeadline();
        if (part.done) break;
        const chunk = part.value;
        if (!ArrayBuffer.isView(chunk) || Object.prototype.toString.call(chunk) !== "[object Uint8Array]") {
          throw new RpcReadError("rpc_json_invalid");
        }
        if (chunk.byteLength > MAX_BODY_BYTES - total) throw new RpcReadError("rpc_body_too_large");
        if (total + chunk.byteLength > bytes.byteLength) {
          const grown = new Uint8Array(Math.min(MAX_BODY_BYTES, Math.max(bytes.byteLength * 2, total + chunk.byteLength)));
          grown.set(bytes.subarray(0, total));
          bytes = grown;
        }
        bytes.set(chunk, total);
        total += chunk.byteLength;
      }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total)); }
      catch { throw new RpcReadError("rpc_json_invalid"); }
      checkDeadline();
      const result = parseResponse(text, id);
      checkDeadline();
      return result;
    } catch (error) {
      checkDeadline();
      if (issuedErrors.has(error as RpcReadError)) throw error;
      throw new RpcReadError("rpc_network");
    } finally {
      cancel();
    }
  };
  try { return await Promise.race([task(), timeout]); }
  finally {
    clearTimeout(timer!);
    controller.abort();
    cancel();
  }
}

export function createSettlementRpc(fetchImpl: typeof globalThis.fetch) {
  let nextId = 1;
  return async (url: string, method: string, params: readonly unknown[]): Promise<unknown> => {
    if (!READ_METHODS.has(method)) throw new RpcReadError("rpc_method_refused");
    for (let attempt = 0; ; attempt += 1) {
      const id = nextId;
      nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
      try { return await readOnce(fetchImpl, url, method, params, id); }
      catch (error) {
        if (!issuedErrors.has(error as RpcReadError) || !(error as RpcReadError).retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  };
}
