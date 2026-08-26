
import { sha256Hex } from "./hash";

export const MIN_EVIDENCE_ID_LENGTH = 8;
export const MAX_EVIDENCE_ID_LENGTH = 128;
const EVIDENCE_ID_RE = /^[-._:a-zA-Z0-9]{8,128}$/;

export function isEvidenceId(value: unknown): value is string {
  return typeof value === "string" && EVIDENCE_ID_RE.test(value);
}

const EVIDENCE_ID_SEPARATOR = /([-._:])/;
const HEX_TOKEN_RE = /^(0[xX])?([0-9a-fA-F]+)$/;

export function canonicalEvidenceId(value: unknown): string | null {
  if (!isEvidenceId(value)) return null;
  const folded = value
    .split(EVIDENCE_ID_SEPARATOR)
    .map((token) => {
      const hex = HEX_TOKEN_RE.exec(token);
      return hex ? hex[2].toLowerCase() : token;
    })
    .join("");
  return isEvidenceId(folded) ? folded : null;
}

export function isCanonicalEvidenceId(value: unknown): value is string {
  return typeof value === "string" && canonicalEvidenceId(value) === value;
}

export const SETTLEMENT_BINDING_DOMAIN = "voidly-session-settlement-binding/v1|";

export async function settlementBindingReference(grantHash: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(SETTLEMENT_BINDING_DOMAIN + grantHash));
}

