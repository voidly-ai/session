
import { verifyProvider } from "./protocol";
import type { FetchLike, VerifiedProvider, VerifiedProviderRejectReason } from "./protocol";

export const PROVIDER_MANIFEST_PATH = "/.well-known/voidly-session-provider.json";

export type DiscoveryTransportReason = "manifest_unreachable" | "manifest_not_json";

export type FetchVerifiedProviderResult =
  | { readonly ok: true; readonly provider: VerifiedProvider }
  | {
      readonly ok: false;
      readonly reason: VerifiedProviderRejectReason | DiscoveryTransportReason;
      readonly detail: string;
    };

export interface FetchVerifiedProviderInput {
  readonly manifestUrl: string;
  readonly expectedProviderDid: string;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}

export async function fetchVerifiedProvider(
  input: FetchVerifiedProviderInput,
): Promise<FetchVerifiedProviderResult> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.manifestUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "manifest_unreachable",
      detail: `fetch failed: ${(e as Error).name}`,
    };
  }
  if (!response.ok) {
    return { ok: false, reason: "manifest_unreachable", detail: `http ${response.status}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "manifest_not_json", detail: "body is not JSON" };
  }

  const verdict = verifyProvider(parsed, input.expectedProviderDid);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.reason };
  return { ok: true, provider: verdict.provider };
}

export const AGENT_IDENTITY_PATH_PREFIX = "/v1/agent/identity/";

const REGISTRY_DID_RE = /^did:voidly:[A-Za-z0-9._-]{1,64}$/;

export type PartiesRegisteredRefusal =
  | "hirer_unregistered"
  | "hirer_key_not_registered"
  | "provider_unregistered"
  | "registry_unreadable";

export type CheckPartiesRegisteredResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: PartiesRegisteredRefusal;
      readonly detail: string;
    };

export interface CheckPartiesRegisteredInput {
  readonly registryBaseUrl: string;
  readonly hirerDid: string;
  readonly providerDid: string;
  readonly hirerSigningPublicKeyBase64?: string;
  readonly fetchImpl: FetchLike;
  readonly signal?: AbortSignal;
}

async function readIdentity(
  input: CheckPartiesRegisteredInput,
  did: string,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
  if (!REGISTRY_DID_RE.test(did)) {
    return { ok: false, detail: "not a did:voidly: — refusing to build a registry URL from it" };
  }

  let response: Response;
  try {
    response = await input.fetchImpl(
      `${input.registryBaseUrl}${AGENT_IDENTITY_PATH_PREFIX}${did}`,
      {
        method: "GET",
        headers: { accept: "application/json" },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (e) {
    return { ok: false, detail: `fetch failed: ${(e as Error).name}` };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, detail: `http ${response.status}, body is not JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, detail: `http ${response.status}, body is not an object` };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

export async function checkPartiesRegistered(
  input: CheckPartiesRegisteredInput,
): Promise<CheckPartiesRegisteredResult> {
  const provider = await readIdentity(input, input.providerDid);
  if (!provider.ok) {
    return { ok: false, reason: "registry_unreadable", detail: provider.detail };
  }
  if (typeof provider.body.signing_public_key !== "string" || provider.body.status !== "active") {
    return {
      ok: false,
      reason: "provider_unregistered",
      detail:
        "the agent registry holds no active row for the provider this manifest names, so the " +
        "rail would refuse the redemption 403 after the payment had settled.",
    };
  }

  const hirer = await readIdentity(input, input.hirerDid);
  if (!hirer.ok) {
    return { ok: false, reason: "registry_unreadable", detail: hirer.detail };
  }
  if (typeof hirer.body.signing_public_key !== "string" || hirer.body.status !== "active") {
    return {
      ok: false,
      reason: "hirer_unregistered",
      detail:
        "the agent registry holds no active row for this hirer. Register the DID " +
        "(POST /v1/agent/register) before hiring: the rail resolves both parties at redemption, " +
        "which is after settlement, and refuses 403 with the payment already spent.",
    };
  }

  if (
    input.hirerSigningPublicKeyBase64 !== undefined &&
    hirer.body.signing_public_key !== input.hirerSigningPublicKeyBase64
  ) {
    return {
      ok: false,
      reason: "hirer_key_not_registered",
      detail:
        "the agent registry holds a DIFFERENT signing key for this hirer than the one the offer " +
        "pins. Every artifact in such a hire verifies, so nothing local catches it — the rail " +
        "catches it at redemption with 422 hirer_key_mismatch, after the money has moved.",
    };
  }

  return { ok: true };
}
