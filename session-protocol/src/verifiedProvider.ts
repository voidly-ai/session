
import type { ProviderManifest } from "./providerManifest";

export const VERIFIED_PROVIDER: unique symbol = Symbol("voidly.session.verified-provider");

const MINTED = new WeakMap<object, ProviderManifest>();

export interface VerifiedProvider {
  readonly [VERIFIED_PROVIDER]: true;
  readonly manifest: ProviderManifest;
}

function containerCopy(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    const source = value as unknown as Record<string, unknown>;
    const copy: unknown[] = [];
    const sink = copy as unknown as Record<string, unknown>;
    for (const key of Object.keys(source)) sink[key] = source[key];
    return sink;
  }
  return { ...(value as Record<string, unknown>) };
}

function rebuildDocumentDeep(document: ProviderManifest): ProviderManifest {
  const top = containerCopy(document);
  if (top === null) return document;

  const window = containerCopy(top.grant_ttl_ms);
  if (window !== null) top.grant_ttl_ms = window;

  const rawNotes: unknown = top.notes;
  if (Array.isArray(rawNotes)) {
    const count = rawNotes.length;
    const notes: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const note: unknown = rawNotes[i];
      const frame = containerCopy(note);
      notes.push(frame === null ? note : frame);
    }
    top.notes = notes;
  }

  const rawServices: unknown = top.services;
  if (Array.isArray(rawServices)) {
    const count = rawServices.length;
    const services: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const entry: unknown = rawServices[i];
      const offering = containerCopy(entry);
      if (offering === null) {
        services.push(entry);
        continue;
      }
      const price = containerCopy(offering.price);
      if (price !== null) offering.price = price;
      services.push(offering);
    }
    top.services = services;
  }

  return top as unknown as ProviderManifest;
}

function freezeManifestDeep(m: ProviderManifest): ProviderManifest {
  if (m === null || typeof m !== "object") return m;
  Object.freeze(m.grant_ttl_ms);
  Object.freeze(m.notes);
  const services: unknown = m.services;
  if (Array.isArray(services)) {
    for (const offering of services) {
      if (offering !== null && typeof offering === "object") {
        Object.freeze((offering as { price?: unknown }).price);
      }
      Object.freeze(offering);
    }
  }
  Object.freeze(services);
  return Object.freeze(m);
}

export function mintVerifiedProvider(manifest: ProviderManifest): VerifiedProvider {
  const document = freezeManifestDeep(rebuildDocumentDeep(manifest));
  const provider = Object.freeze({ manifest: document }) as unknown as VerifiedProvider;
  MINTED.set(provider, document);
  return provider;
}

export function isVerifiedProvider(value: unknown): value is VerifiedProvider {
  if (value === null || typeof value !== "object") return false;
  if (!MINTED.has(value as object)) return false;
  const minted = MINTED.get(value as object);
  if ((value as { manifest?: unknown }).manifest !== minted) return false;
  const m = minted as Partial<ProviderManifest> | undefined;
  if (m === null || typeof m !== "object") return false;
  if (typeof m.provider_did !== "string") return false;
  if (typeof m.signing_public_key_base64 !== "string") return false;
  if (typeof m.encryption_public_key_base64 !== "string") return false;
  const ttl = m.grant_ttl_ms as Partial<ProviderManifest["grant_ttl_ms"]> | undefined;
  if (ttl === null || typeof ttl !== "object") return false;
  if (typeof ttl.min !== "number" || typeof ttl.max !== "number") return false;
  if (!Array.isArray(m.services)) return false;
  for (const offering of m.services as ReadonlyArray<unknown>) {
    if (offering === null || typeof offering !== "object") return false;
    const o = offering as Partial<ProviderManifest["services"][number]>;
    if (typeof o.ref !== "string") return false;
    const p = o.price as Partial<ProviderManifest["services"][number]["price"]> | undefined;
    if (p === null || typeof p !== "object") return false;
    if (typeof p.chain !== "string") return false;
    if (typeof p.asset !== "string") return false;
    if (typeof p.payee_account !== "string") return false;
    if (typeof p.min_amount !== "string") return false;
    if (typeof p.max_amount !== "string") return false;
  }
  return true;
}
