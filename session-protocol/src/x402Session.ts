
import {
  caip2Of,
  compareDecimalStrings,
  isCaip10,
  isCaip19,
  isCaip2,
  isPositiveDecimalString,
} from "./caip";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
export const EIP155_CHAIN_RE = /^eip155:[1-9][0-9]{0,31}$/;
export const UINT256_DECIMAL_RE = /^(?:0|[1-9][0-9]{0,77})$/;
export const SIGNED_DECIMAL_RE = /^-?(?:0|[1-9][0-9]{0,77})$/;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const X402_SESSION_USDC_BY_CHAIN: ReadonlyMap<string, string> = Object.freeze(
  new Map<string, string>([
    ["eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
    ["eip155:84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e"],
  ]),
);

export function x402SessionAssetCaip19(chain: string): string | null {
  const token = X402_SESSION_USDC_BY_CHAIN.get(chain);
  if (!token) return null;
  const asset = `${chain}/erc20:${token}`;
  return isCaip19(asset) ? asset : null;
}

export function x402SessionAccountCaip10(chain: string, address: string): string | null {
  if (!isCaip2(chain) || typeof address !== "string" || !ADDRESS_RE.test(address)) return null;
  const account = `${chain}:${address.toLowerCase()}`;
  return isCaip10(account) ? account : null;
}

export function x402SessionAccountSpellingIsUnpayable(account: string): boolean {
  const chain = caip2Of(account);
  if (chain === null || !isCaip10(account)) return false;
  if (!X402_SESSION_USDC_BY_CHAIN.has(chain)) return false;
  const address = account.slice(chain.length + 1);
  return x402SessionAccountCaip10(chain, address) !== account;
}

export const X402_SESSION_EVIDENCE_SCHEMA = "voidly.session.settlement.x402/v1";

export interface X402SessionEvidence {
  readonly schema: typeof X402_SESSION_EVIDENCE_SCHEMA;
  readonly transaction_hash: string;
}

const EVIDENCE_KEYS: readonly string[] = Object.freeze(["schema", "transaction_hash"]);

export const X402_SESSION_REFUSED_EVIDENCE_KEYS: readonly string[] = Object.freeze([
  "authorization",
  "signature",
  "payload",
  "payment",
  "paymentPayload",
  "payment_payload",
  "paymentResponse",
  "payment_response",
  "settleResponse",
  "settle_response",
  "x402Version",
  "receipt",
  "facilitator",
]);

export function validateX402SessionEvidence(raw: unknown): X402SessionEvidence | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const e: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of Object.keys(e)) {
    if (!EVIDENCE_KEYS.includes(k)) return null;
  }
  if (e.schema !== X402_SESSION_EVIDENCE_SCHEMA) return null;
  if (typeof e.transaction_hash !== "string" || !HEX32_RE.test(e.transaction_hash)) return null;
  return Object.freeze({
    schema: X402_SESSION_EVIDENCE_SCHEMA,
    transaction_hash: e.transaction_hash.toLowerCase(),
  });
}

