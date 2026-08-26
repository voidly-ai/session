
import { afterEach, describe, expect, it } from "vitest";
import { MIN_NONCE_LENGTH, SessionCryptoUnavailableError, webCryptoEntropy } from "../src/index";

const REAL_CRYPTO = (globalThis as unknown as { crypto: Crypto }).crypto;

afterEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: REAL_CRYPTO,
    configurable: true,
    writable: true,
  });
});

function setCrypto(value: unknown) {
  Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
}

describe("the bytes come from getRandomValues, not from anywhere else", () => {
  it("random(n) hands back exactly the buffer WebCrypto filled", () => {
    const seen: Array<{ buf: ArrayBufferView; copy: Uint8Array }> = [];
    setCrypto({
      getRandomValues(buf: Uint8Array) {
        REAL_CRYPTO.getRandomValues(buf);
        seen.push({ buf, copy: Uint8Array.from(buf) });
        return buf;
      },
    });

    const out = webCryptoEntropy().random(32);
    expect(seen.length, "random() did not call crypto.getRandomValues at all").toBe(1);
    expect(seen[0].buf, "the filled buffer is not the buffer returned").toBe(out);
    expect(Array.from(out)).toEqual(Array.from(seen[0].copy));
  });

  it("nonce() is derived from getRandomValues, 16 bytes of it", () => {
    const widths: number[] = [];
    setCrypto({
      getRandomValues(buf: Uint8Array) {
        widths.push(buf.length);
        return REAL_CRYPTO.getRandomValues(buf);
      },
    });

    const n = webCryptoEntropy().nonce();
    expect(widths, "nonce() did not call crypto.getRandomValues").toEqual([16]);
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it("random(n) is never all-zero — the core refuses that value BY NAME", () => {
    const e = webCryptoEntropy();
    for (const n of [24, 32]) {
      for (let i = 0; i < 32; i++) {
        expect(e.random(n).every((b) => b === 0)).toBe(false);
      }
    }
  });

  it("two draws of 32 bytes are never equal", () => {
    const e = webCryptoEntropy();
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) seen.add(e.random(32).join(","));
    expect(seen.size).toBe(64);
  });
});

describe("nonce() clears the protocol's own floor", () => {
  it("is at least MIN_NONCE_LENGTH characters", () => {
    expect(MIN_NONCE_LENGTH).toBe(16);
    expect(webCryptoEntropy().nonce().length).toBeGreaterThanOrEqual(MIN_NONCE_LENGTH);
  });

  it("is fresh on every call", () => {
    const e = webCryptoEntropy();
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) seen.add(e.nonce());
    expect(seen.size, "nonce() repeated itself — a nonce that repeats is not a nonce").toBe(256);
  });

  it("POSITIVE CONTROL: the freshness check would catch a constant", () => {
    const constant = () => "0000000000000000";
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(constant());
    expect(seen.size).not.toBe(8);
  });
});

describe("a host without WebCrypto is REFUSED, never quietly downgraded", () => {
  it.each([
    ["crypto absent", undefined],
    ["crypto present but empty", {}],
    ["getRandomValues not a function", { getRandomValues: 42 }],
  ])("random() throws when %s", (_label, value) => {
    setCrypto(value);
    expect(() => webCryptoEntropy().random(32)).toThrow(SessionCryptoUnavailableError);
  });

  it.each([
    ["crypto absent", undefined],
    ["crypto present but empty", {}],
  ])("nonce() throws when %s", (_label, value) => {
    setCrypto(value);
    expect(() => webCryptoEntropy().nonce()).toThrow(SessionCryptoUnavailableError);
  });

  it("the refusal names the cause, so a reader is not sent to debug their own code", () => {
    setCrypto(undefined);
    try {
      webCryptoEntropy().random(1);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCryptoUnavailableError);
      expect((err as SessionCryptoUnavailableError).code).toBe("session_crypto_unavailable");
      expect((err as Error).message).toMatch(/getRandomValues/);
    }
  });
});

describe("random(n) refuses a width it cannot honestly serve", () => {
  it.each([0, -1, 1.5, 1025, Number.NaN])("refuses n = %s", (n) => {
    expect(() => webCryptoEntropy().random(n as number)).toThrow(RangeError);
  });

  it("accepts the two widths this protocol actually uses", () => {
    expect(webCryptoEntropy().random(24)).toHaveLength(24);
    expect(webCryptoEntropy().random(32)).toHaveLength(32);
  });
});
