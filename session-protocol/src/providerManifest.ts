
import nacl from "tweetnacl";
import { decodeBase64 } from "tweetnacl-util";
import { isCaip10, isCaip19, isCaip2, isPositiveDecimalString } from "./caip";
import { SESSION_HIRE_SCHEMA } from "./hire";
import {
  DID_RE,
  hasOnlyKeys,
  isBase64Key32,
  MAX_GRANT_TTL_MS,
  MAX_SERVICE_REF_LENGTH,
} from "./schemas";
import { mintVerifiedProvider } from "./verifiedProvider";
import type { VerifiedProvider } from "./verifiedProvider";
import { canonicalBytes } from "./envelope";
import { deriveDidFromSigningKey } from "./didDerivation";

export const PROVIDER_MANIFEST_SCHEMA = "voidly.session.provider.manifest/v1";

export interface ProviderManifest {
  readonly schema: typeof PROVIDER_MANIFEST_SCHEMA;
  readonly provider_did: string;
  readonly signing_public_key_base64: string;
  readonly encryption_public_key_base64: string;
  readonly attestor_public_key_base64: string;
  readonly accept_url: string;
  readonly hire_message_schema: typeof SESSION_HIRE_SCHEMA;
  readonly worker_base_url: string;
  readonly grant_ttl_ms: { readonly min: number; readonly max: number };
  readonly acceptance_ttl_ms: number;
  readonly services: ReadonlyArray<{
    readonly ref: string;
    readonly description: string;
    readonly price: {
      readonly chain: string;
      readonly asset: string;
      readonly payee_account: string;
      readonly min_amount: string;
      readonly max_amount: string;
    };
  }>;
  readonly payment_buys: "an attempt, not an outcome";
  readonly notes: readonly string[];
  readonly signature_base64: string;
}

export const PROVIDER_MANIFEST_KEYS = [
  "schema",
  "provider_did",
  "signing_public_key_base64",
  "encryption_public_key_base64",
  "attestor_public_key_base64",
  "accept_url",
  "hire_message_schema",
  "worker_base_url",
  "grant_ttl_ms",
  "acceptance_ttl_ms",
  "services",
  "payment_buys",
  "notes",
  "signature_base64",
] as const;

export function manifestSigningBytes(m: Omit<ProviderManifest, "signature_base64">): Uint8Array {
  return canonicalBytes(m);
}

export type ManifestRejectReason =
  | "manifest_not_object"
  | "manifest_schema_mismatch"
  | "manifest_unexpected_field"
  | "manifest_field_malformed"
  | "manifest_signature_missing"
  | "manifest_signature_malformed"
  | "manifest_signature_invalid"
  | "manifest_did_not_derived"
  | "manifest_did_not_pinned";

export type ManifestVerdict =
  | { readonly ok: true; readonly manifest: ProviderManifest }
  | { readonly ok: false; readonly reason: ManifestRejectReason };

function isNonEmptyString(v: unknown, max = 2048): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

export function verifyManifest(raw: unknown, expectedProviderDid?: string): ManifestVerdict {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "manifest_not_object" };
  }
  const r: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (r.schema !== PROVIDER_MANIFEST_SCHEMA) return { ok: false, reason: "manifest_schema_mismatch" };
  if (!hasOnlyKeys(r, PROVIDER_MANIFEST_KEYS)) {
    return { ok: false, reason: "manifest_unexpected_field" };
  }

  if (r.signature_base64 === undefined || r.signature_base64 === null) {
    return { ok: false, reason: "manifest_signature_missing" };
  }
  if (typeof r.signature_base64 !== "string" || r.signature_base64.length === 0) {
    return { ok: false, reason: "manifest_signature_malformed" };
  }
  let signature: Uint8Array;
  try {
    signature = decodeBase64(r.signature_base64);
  } catch {
    return { ok: false, reason: "manifest_signature_malformed" };
  }
  if (signature.length !== nacl.sign.signatureLength) {
    return { ok: false, reason: "manifest_signature_malformed" };
  }

  if (!isBase64Key32(r.signing_public_key_base64, decodeBase64)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (!isBase64Key32(r.encryption_public_key_base64, decodeBase64)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (!isBase64Key32(r.attestor_public_key_base64, decodeBase64)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (typeof r.provider_did !== "string" || !DID_RE.test(r.provider_did)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (!isNonEmptyString(r.accept_url) || !isNonEmptyString(r.worker_base_url)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (r.hire_message_schema !== SESSION_HIRE_SCHEMA) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (r.payment_buys !== "an attempt, not an outcome") {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (!isPositiveInt(r.acceptance_ttl_ms)) return { ok: false, reason: "manifest_field_malformed" };

  const ttl = r.grant_ttl_ms;
  if (typeof ttl !== "object" || ttl === null || Array.isArray(ttl)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  const ttlSnap = { ...(ttl as Record<string, unknown>) };
  if (!hasOnlyKeys(ttlSnap, ["min", "max"])) return { ok: false, reason: "manifest_field_malformed" };
  if (!isPositiveInt(ttlSnap.min) || !isPositiveInt(ttlSnap.max)) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  if (ttlSnap.min > ttlSnap.max || ttlSnap.max > MAX_GRANT_TTL_MS) {
    return { ok: false, reason: "manifest_field_malformed" };
  }

  const rawNotes: unknown = r.notes;
  if (!Array.isArray(rawNotes)) return { ok: false, reason: "manifest_field_malformed" };
  const notes: string[] = [];
  for (let i = 0; i < rawNotes.length; i += 1) {
    const note: unknown = rawNotes[i];
    if (!isNonEmptyString(note, 4096)) return { ok: false, reason: "manifest_field_malformed" };
    notes.push(note);
  }

  const rawServices: unknown = r.services;
  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    return { ok: false, reason: "manifest_field_malformed" };
  }
  const services: ProviderManifest["services"][number][] = [];
  for (let i = 0; i < rawServices.length; i += 1) {
    const entry: unknown = rawServices[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    const s = { ...(entry as Record<string, unknown>) };
    if (!hasOnlyKeys(s, ["ref", "description", "price"])) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (!isNonEmptyString(s.ref, MAX_SERVICE_REF_LENGTH) || typeof s.description !== "string") {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    const price = s.price;
    if (typeof price !== "object" || price === null || Array.isArray(price)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    const p = { ...(price as Record<string, unknown>) };
    if (!hasOnlyKeys(p, ["chain", "asset", "payee_account", "min_amount", "max_amount"])) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (typeof p.chain !== "string" || !isCaip2(p.chain)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (typeof p.asset !== "string" || !isCaip19(p.asset)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (typeof p.payee_account !== "string" || !isCaip10(p.payee_account)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (typeof p.min_amount !== "string" || !isPositiveDecimalString(p.min_amount)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    if (typeof p.max_amount !== "string" || !isPositiveDecimalString(p.max_amount)) {
      return { ok: false, reason: "manifest_field_malformed" };
    }
    services.push({
      ref: s.ref,
      description: s.description,
      price: {
        chain: p.chain,
        asset: p.asset,
        payee_account: p.payee_account,
        min_amount: p.min_amount,
        max_amount: p.max_amount,
      },
    });
  }

  const signingKey = decodeBase64(r.signing_public_key_base64);

  let derived: string | null = null;
  try {
    derived = deriveDidFromSigningKey(signingKey);
  } catch {
    derived = null;
  }
  if (derived === null || derived !== r.provider_did) {
    return { ok: false, reason: "manifest_did_not_derived" };
  }

  const body: Omit<ProviderManifest, "signature_base64"> = {
    schema: PROVIDER_MANIFEST_SCHEMA,
    provider_did: r.provider_did,
    signing_public_key_base64: r.signing_public_key_base64,
    encryption_public_key_base64: r.encryption_public_key_base64,
    attestor_public_key_base64: r.attestor_public_key_base64,
    accept_url: r.accept_url,
    hire_message_schema: SESSION_HIRE_SCHEMA,
    worker_base_url: r.worker_base_url,
    grant_ttl_ms: { min: ttlSnap.min, max: ttlSnap.max },
    acceptance_ttl_ms: r.acceptance_ttl_ms,
    services,
    payment_buys: "an attempt, not an outcome",
    notes,
  };
  let verified = false;
  try {
    verified = nacl.sign.detached.verify(manifestSigningBytes(body), signature, signingKey);
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "manifest_signature_invalid" };

  if (expectedProviderDid !== undefined && expectedProviderDid !== body.provider_did) {
    return { ok: false, reason: "manifest_did_not_pinned" };
  }

  return { ok: true, manifest: { ...body, signature_base64: r.signature_base64 } };
}

export type VerifiedProviderRejectReason =
  | ManifestRejectReason
  | "manifest_pin_not_a_did"
  | "manifest_service_ref_duplicated";

export type VerifiedProviderVerdict =
  | { readonly ok: true; readonly provider: VerifiedProvider }
  | { readonly ok: false; readonly reason: VerifiedProviderRejectReason };

export type ProviderTermsRejectReason =
  | "provider_not_verified"
  | "provider_service_not_offered"
  | "provider_price_chain_not_offered"
  | "provider_price_asset_not_offered"
  | "provider_payee_not_manifested"
  | "provider_price_below_manifest_floor"
  | "provider_price_above_manifest_ceiling"
  | "provider_grant_ttl_below_manifest_floor"
  | "provider_grant_ttl_above_manifest_ceiling";

export function verifyProvider(
  raw: unknown,
  expectedProviderDid: string,
): VerifiedProviderVerdict {
  if (typeof expectedProviderDid !== "string" || !DID_RE.test(expectedProviderDid)) {
    return { ok: false, reason: "manifest_pin_not_a_did" };
  }

  const verdict = verifyManifest(raw, expectedProviderDid);
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const refs = new Set<string>();
  for (const offering of verdict.manifest.services) {
    if (refs.has(offering.ref)) {
      return { ok: false, reason: "manifest_service_ref_duplicated" };
    }
    refs.add(offering.ref);
  }

  return { ok: true, provider: mintVerifiedProvider(verdict.manifest) };
}
