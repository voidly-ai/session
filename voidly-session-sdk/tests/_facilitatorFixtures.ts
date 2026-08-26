
import { createFacilitatorSubmitter } from "../src/index";
import type { FacilitatorPreflightResult, SignedTransferAuthorization } from "../src/index";
import { CHAIN, GRANT_HASH, PAYEE, signedWithRealKey as signedPayload, USDC } from "./_transferAuthFixtures";

export { CHAIN, GRANT_HASH, PAYEE, USDC };

export const OTHER_CHAIN = "eip155:84532";
export const THIEF = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

export const TX = `0x${"7f".repeat(32)}`;
export const OTHER_TX = `0x${"11".repeat(32)}`;
export const ZERO_TX = `0x${"0".repeat(64)}`;

export async function signedWithRealKey(chain = CHAIN): Promise<SignedTransferAuthorization> {
  return (await signedPayload({ chain })).signed;
}

export function preflight(over: Record<string, unknown> = {}): FacilitatorPreflightResult {
  return {
    schema: "voidly.pay.facilitator-preflight/v1",
    verdict: "usable",
    reason: "eip3009_exact_advertised",
    detail: "advertises eip3009",
    chain: CHAIN,
    frozenAsset: USDC,
    url: "https://facilitator.example.test/supported",
    httpStatus: 200,
    matched: {
      x402Version: 2,
      scheme: "exact",
      network: CHAIN,
      resolvedChain: CHAIN,
      assetTransferMethod: "eip3009",
    },
    observations: [],
    undetermined: [],
    ...over,
  } as unknown as FacilitatorPreflightResult;
}

export function facilitator(
  reply: { status: number; body: string } | { throws: unknown },
  over: Record<string, unknown> = {},
) {
  const calls: Array<{ url: string; body: string }> = [];
  const submitter = createFacilitatorSubmitter({
    preflight: preflight(over),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      if ("throws" in reply) throw reply.throws;
      return new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  });
  return { submitter, calls };
}
