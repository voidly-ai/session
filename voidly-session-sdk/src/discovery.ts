
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
