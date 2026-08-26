
import { SessionCryptoUnavailableError } from "./errors";

export interface SessionEntropy {
  random(n: number): Uint8Array;
  nonce(): string;
}

function assertWebCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new SessionCryptoUnavailableError(
      "crypto.getRandomValues is unavailable. In a browser this means the page " +
        "is on an insecure origin; there is no fallback and there must not be one.",
    );
  }
  return c;
}

export function webCryptoEntropy(): SessionEntropy {
  return {
    random(n: number): Uint8Array {
      if (!Number.isInteger(n) || n <= 0 || n > 1024) {
        throw new RangeError(`webCryptoEntropy.random: n must be 1..1024, got ${String(n)}`);
      }
      const out = new Uint8Array(n);
      assertWebCrypto().getRandomValues(out);
      return out;
    },
    nonce(): string {
      const bytes = new Uint8Array(16);
      assertWebCrypto().getRandomValues(bytes);
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}
