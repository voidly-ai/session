
export interface SessionParty {
  readonly did: string;
  readonly signingPublicKey: Uint8Array;
}

export interface SessionParties {
  readonly hirer: SessionParty;
  readonly provider: SessionParty;
}

export function isSessionParty(value: unknown): value is SessionParty {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<SessionParty>;
  if (typeof p.did !== "string" || p.did.length === 0) return false;
  return p.signingPublicKey instanceof Uint8Array && p.signingPublicKey.length === 32;
}
