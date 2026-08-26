
import { CAPSULE_NONCE_LENGTH } from "./hash";

export const FRAME_OFFER_HASH_BYTES = 32;
export const FRAME_BODY_NONCE_BYTES = CAPSULE_NONCE_LENGTH;
export const FRAME_HEADER_LENGTH = FRAME_OFFER_HASH_BYTES + FRAME_BODY_NONCE_BYTES + 4;
export const MIN_FRAME_BUCKET = 512;

export function frameBucketSize(totalBytes: number): number {
  let size = MIN_FRAME_BUCKET;
  while (size < totalBytes) size *= 2;
  return size;
}

export const SECRETBOX_TAG_BYTES = 16;

export const CAPSULE_SALT_BYTES = 32;

export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

export const SESSION_MAX_BODY_BYTES = 32 * 1024;

export const SESSION_WORST_CASE_ENVELOPE_BYTES = 4_972;

export const MAX_FRAME_BUCKET_BYTES = ((): number => {
  let best = 0;
  for (let bucket = MIN_FRAME_BUCKET; bucket <= SESSION_MAX_BODY_BYTES; bucket *= 2) {
    const wire = base64Length(bucket + SECRETBOX_TAG_BYTES) + SESSION_WORST_CASE_ENVELOPE_BYTES;
    if (wire <= SESSION_MAX_BODY_BYTES) best = bucket;
  }
  if (best === 0) {
    throw new Error("wireBudget: the transport ceiling cannot carry the minimum frame bucket");
  }
  return best;
})();

export const MAX_CAPSULE_BODY_BYTES = MAX_FRAME_BUCKET_BYTES + SECRETBOX_TAG_BYTES;

export const MAX_CAPSULE_BODY_BASE64_LENGTH = base64Length(MAX_CAPSULE_BODY_BYTES);

export const MAX_SEALED_PAYLOAD_BYTES = MAX_FRAME_BUCKET_BYTES - FRAME_HEADER_LENGTH;

export const SESSION_EVIDENCE_HEADROOM_BYTES =
  SESSION_MAX_BODY_BYTES - MAX_CAPSULE_BODY_BASE64_LENGTH - SESSION_WORST_CASE_ENVELOPE_BYTES;
