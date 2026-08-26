
import { canonicalBytes, verifyEnvelopeSignature } from "./envelope";
import { encodeBase64 } from "tweetnacl-util";

export type Signer = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export function verifyDetached(
  env: object,
  signatureBase64: string,
  publicKey: Uint8Array,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return verifyEnvelopeSignature(env as any, signatureBase64, publicKey);
}

export async function signCanonical(env: object, sign: Signer): Promise<string | null> {
  try {
    const sig = await sign(canonicalBytes(env));
    if (!(sig instanceof Uint8Array) || sig.length !== 64) return null;
    return encodeBase64(sig);
  } catch {
    return null;
  }
}
