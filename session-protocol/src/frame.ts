
import { HEX64_RE } from "./schemas";
import {
  FRAME_BODY_NONCE_BYTES,
  FRAME_HEADER_LENGTH,
  FRAME_OFFER_HASH_BYTES,
  MAX_FRAME_BUCKET_BYTES,
  MIN_FRAME_BUCKET,
  frameBucketSize,
} from "./wireBudget";

export {
  FRAME_BODY_NONCE_BYTES,
  FRAME_HEADER_LENGTH,
  FRAME_OFFER_HASH_BYTES,
  MIN_FRAME_BUCKET,
  frameBucketSize,
};

const FRAME_LENGTH_OFFSET = FRAME_OFFER_HASH_BYTES + FRAME_BODY_NONCE_BYTES;

function hex64ToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || !HEX64_RE.test(hex)) return null;
  const out = new Uint8Array(FRAME_OFFER_HASH_BYTES);
  for (let i = 0; i < FRAME_OFFER_HASH_BYTES; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function frameSealedPayload(
  payload: Uint8Array,
  offerHash: string,
  bodyNonce: Uint8Array,
): Uint8Array | null {
  const bound = hex64ToBytes(offerHash);
  if (!bound) return null;
  if (!(bodyNonce instanceof Uint8Array) || bodyNonce.length !== FRAME_BODY_NONCE_BYTES) return null;

  const total = FRAME_HEADER_LENGTH + payload.length;
  if (frameBucketSize(total) > MAX_FRAME_BUCKET_BYTES) return null;
  const framed = new Uint8Array(frameBucketSize(total));
  framed.set(bound, 0);
  framed.set(bodyNonce, FRAME_OFFER_HASH_BYTES);
  viewOf(framed).setUint32(FRAME_LENGTH_OFFSET, payload.length, false);
  framed.set(payload, FRAME_HEADER_LENGTH);
  return framed;
}

export function unframeSealedPayload(
  framed: Uint8Array,
  offerHash: string,
  bodyNonce: Uint8Array,
): Uint8Array | null {
  if (!(framed instanceof Uint8Array) || framed.length < FRAME_HEADER_LENGTH) return null;
  const bound = hex64ToBytes(offerHash);
  if (!bound) return null;
  if (!(bodyNonce instanceof Uint8Array) || bodyNonce.length !== FRAME_BODY_NONCE_BYTES) return null;

  let diff = 0;
  for (let i = 0; i < FRAME_OFFER_HASH_BYTES; i++) diff |= framed[i] ^ bound[i];
  for (let i = 0; i < FRAME_BODY_NONCE_BYTES; i++) {
    diff |= framed[FRAME_OFFER_HASH_BYTES + i] ^ bodyNonce[i];
  }
  if (diff !== 0) return null;

  const length = viewOf(framed).getUint32(FRAME_LENGTH_OFFSET, false);
  const total = FRAME_HEADER_LENGTH + length;
  if (framed.length !== frameBucketSize(total)) return null;
  if (framed.length > MAX_FRAME_BUCKET_BYTES) return null;

  for (let i = total; i < framed.length; i++) {
    if (framed[i] !== 0) return null;
  }
  return framed.slice(FRAME_HEADER_LENGTH, total);
}
