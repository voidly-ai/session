
export const SESSION_PROVIDER_PROOF_HEADER = "x-voidly-session-provider-proof";

export const SESSION_PROVIDER_PROOF_SCHEMA = "voidly-session-provider-redemption/v1";

export const SESSION_REATTEST_PROOF_SCHEMA = "voidly-session-provider-reattestation/v1";

export type SessionProviderProofSchema =
  | typeof SESSION_PROVIDER_PROOF_SCHEMA
  | typeof SESSION_REATTEST_PROOF_SCHEMA;

export const SESSION_PROVIDER_PROOF_MAX_WINDOW_MS = 2 * 60_000;
export interface SessionProviderProofEnvelope {
  schema: SessionProviderProofSchema;
  provider_did: string;
  grant_hash: string;
  action_nonce: string;
  issued_at: string;
  expires_at: string;
}

interface SessionProviderProofFields {
  providerDid: string;
  grantHash: string;
  actionNonce: string;
  nowMs: number;
  ttlMs?: number;
}

function proofEnvelope(
  schema: SessionProviderProofSchema,
  input: SessionProviderProofFields,
): SessionProviderProofEnvelope {
  const ttl = Math.min(
    input.ttlMs ?? SESSION_PROVIDER_PROOF_MAX_WINDOW_MS,
    SESSION_PROVIDER_PROOF_MAX_WINDOW_MS,
  );
  return {
    schema,
    provider_did: input.providerDid,
    grant_hash: input.grantHash,
    action_nonce: input.actionNonce,
    issued_at: new Date(input.nowMs).toISOString(),
    expires_at: new Date(input.nowMs + ttl).toISOString(),
  };
}

export function sessionProviderProofEnvelope(
  input: SessionProviderProofFields,
): SessionProviderProofEnvelope {
  return proofEnvelope(SESSION_PROVIDER_PROOF_SCHEMA, input);
}

export function sessionReattestProofEnvelope(
  input: SessionProviderProofFields,
): SessionProviderProofEnvelope {
  return proofEnvelope(SESSION_REATTEST_PROOF_SCHEMA, input);
}

export function encodeSessionProviderProof(
  envelope: SessionProviderProofEnvelope,
  signatureBase64: string,
): string {
  const json = JSON.stringify({ envelope, signature: signatureBase64 });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
