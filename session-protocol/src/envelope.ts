
import nacl from "tweetnacl";
import { decodeBase64 } from "tweetnacl-util";

export const MIN_NONCE_LENGTH = 16;

export const MAX_WINDOW_MS = 60 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 30 * 1000;

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error("canonicalize: only finite integers supported");
    }
    return value.toString(10);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== null && obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

export async function envelopeHash(env: object): Promise<string> {
  const bytes = canonicalBytes(env);
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function verifyEnvelopeSignature(
  env: object,
  signatureBase64: string,
  publicKey: Uint8Array,
): boolean {
  try {
    if (publicKey.length !== 32) return false;
    const sig = decodeBase64(signatureBase64);
    if (sig.length !== 64) return false;
    const bytes = canonicalBytes(env);
    return nacl.sign.detached.verify(bytes, sig, publicKey);
  } catch {
    return false;
  }
}
