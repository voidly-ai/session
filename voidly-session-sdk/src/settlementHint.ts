
import { canonicalBytes, sha256Hex } from "./protocol";

export const SETTLEMENT_HINT_SCHEMA = "voidly.session.settlement-hint/v1" as const;

export interface SettlementHintEnvelope {
  readonly schema: typeof SETTLEMENT_HINT_SCHEMA;
  readonly grant_hash: string;
  readonly provider_did: string;
  readonly evidence_hash: string;
  readonly issued_at: string;
}

export function hashSettlementEvidence(evidence: unknown): Promise<string> {
  return sha256Hex(canonicalBytes(evidence ?? null));
}

export async function buildSettlementHint(input: {
  grantHash: string;
  providerDid: string;
  evidence: unknown;
  nowMs: number;
}): Promise<SettlementHintEnvelope> {
  return {
    schema: SETTLEMENT_HINT_SCHEMA,
    grant_hash: input.grantHash,
    provider_did: input.providerDid,
    evidence_hash: await hashSettlementEvidence(input.evidence),
    issued_at: new Date(input.nowMs).toISOString(),
  };
}
