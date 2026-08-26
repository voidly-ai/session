
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  manifestSigningBytes,
  PROVIDER_MANIFEST_SCHEMA,
  verifyProvider,
} from "../../session-protocol/src/providerManifest";
import type { ProviderManifest } from "../../session-protocol/src/providerManifest";
import type { VerifiedProvider } from "../../session-protocol/src/verifiedProvider";
import { SESSION_HIRE_SCHEMA } from "../../session-protocol/src/hire";
import { MAX_GRANT_TTL_MS, MIN_GRANT_TTL_MS } from "../../session-protocol/src/schemas";
import { deriveDidFromSigningKey } from "../../session-protocol/src/didDerivation";

export interface EncryptionEntry {
  readonly publicKeyBase64: string;
  readonly secretKey: Uint8Array;
  readonly retainUntilMs: number | null;
}

export interface ProviderKeys {
  readonly did: string;
  readonly signingPublicKey: Uint8Array;
  sign(bytes: Uint8Array): Uint8Array;
  readonly currentEncryption: EncryptionEntry;
  readonly encryptionKeyring?: readonly EncryptionEntry[];
}

export interface OfferingSpec {
  readonly ref: string;
  readonly chain: string;
  readonly asset: string;
  readonly payeeAccount: string;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly description?: string;
}

export interface ProviderConfig {
  readonly acceptUrl: string;
  readonly workerBaseUrl: string;
  readonly attestorPublicKey: Uint8Array;
  readonly services: readonly OfferingSpec[];
  readonly minGrantTtlMs: number;
  readonly maxGrantTtlMs: number;
  readonly acceptanceTtlMs: number;
}

export const FIXTURE_ATTESTOR_PUBLIC_KEY = nacl.sign.keyPair.fromSeed(
  new Uint8Array(32).fill(0xa7),
).publicKey;

export function buildManifest(keys: ProviderKeys, config: ProviderConfig): ProviderManifest {
  const body: Omit<ProviderManifest, "signature_base64"> = {
    schema: PROVIDER_MANIFEST_SCHEMA,
    provider_did: keys.did,
    signing_public_key_base64: encodeBase64(keys.signingPublicKey),
    encryption_public_key_base64: keys.currentEncryption.publicKeyBase64,
    attestor_public_key_base64: encodeBase64(config.attestorPublicKey),
    accept_url: config.acceptUrl,
    hire_message_schema: SESSION_HIRE_SCHEMA,
    worker_base_url: config.workerBaseUrl,
    grant_ttl_ms: { min: config.minGrantTtlMs, max: config.maxGrantTtlMs },
    acceptance_ttl_ms: config.acceptanceTtlMs,
    services: config.services.map((s) => ({
      ref: s.ref,
      description: s.description ?? `fixture offering ${s.ref}`,
      price: {
        chain: s.chain,
        asset: s.asset,
        payee_account: s.payeeAccount,
        min_amount: s.minAmount,
        max_amount: s.maxAmount,
      },
    })),
    payment_buys: "an attempt, not an outcome",
    notes: Object.freeze([
      "Payment buys an attempt. Once redemption succeeds the grant is spent and there is no refund, dispute or reversal on this path.",
      "This document is SIGNED. Verify it before sealing a brief to its encryption key or paying its payee account.",
    ]),
  };
  return { ...body, signature_base64: encodeBase64(keys.sign(manifestSigningBytes(body))) };
}

export function providerKeysFrom(
  signingKeyPair: nacl.SignKeyPair,
  encryptionKeyPair: nacl.BoxKeyPair,
): ProviderKeys {
  const entry: EncryptionEntry = {
    publicKeyBase64: encodeBase64(encryptionKeyPair.publicKey),
    secretKey: encryptionKeyPair.secretKey,
    retainUntilMs: null,
  };
  return {
    did: deriveDidFromSigningKey(signingKeyPair.publicKey),
    signingPublicKey: signingKeyPair.publicKey,
    sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, signingKeyPair.secretKey),
    currentEncryption: entry,
    encryptionKeyring: [entry],
  };
}

export function providerConfigFor(
  offerings: readonly OfferingSpec[],
  over: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    acceptUrl: "https://provider.example.test/session/accept",
    workerBaseUrl: "https://api.example.test",
    attestorPublicKey: FIXTURE_ATTESTOR_PUBLIC_KEY,
    services: offerings,
    minGrantTtlMs: MIN_GRANT_TTL_MS,
    maxGrantTtlMs: MAX_GRANT_TTL_MS,
    acceptanceTtlMs: 5 * 60_000,
    ...over,
  };
}

export function verifiedProviderFromConfig(
  keys: ProviderKeys,
  config: ProviderConfig,
): VerifiedProvider {
  const wire: unknown = JSON.parse(JSON.stringify(buildManifest(keys, config)));
  const verdict = verifyProvider(wire, keys.did);
  if (!verdict.ok) {
    throw new Error(`manifest fixture did not verify: ${verdict.reason}`);
  }
  return verdict.provider;
}

export function verifiedProviderFor(
  keys: ProviderKeys,
  offerings: readonly OfferingSpec[],
  over: Partial<ProviderConfig> = {},
): VerifiedProvider {
  return verifiedProviderFromConfig(keys, providerConfigFor(offerings, over));
}
