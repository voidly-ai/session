
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import {
  providerConfigFor,
  verifiedProviderFromConfig,
} from "./_manifestFixture";
import type { VerifiedProvider } from "../src/index";
import {
  buildHire,
  deriveDidFromSigningKey,
  envelopeHash,
  signCanonical,
  x402SessionAccountCaip10,
  x402SessionAssetCaip19,
  type HireWire,
  type SessionEntropy,
  type SessionOfferEnvelope,
  type Signer,
  type TaskCapsule,
  type TaskGrantEnvelope,
} from "../src/index";

export const CHAIN = "eip155:8453";
export const NOW = 1_760_000_000_000;
export const PRICE = "1000000";
export const PAYER_ADDR = "0x1111111111111111111111111111111111111111";
export const PAYEE_ADDR = "0x2222222222222222222222222222222222222222";
export const OFFER_TTL_MS = 60 * 60_000;
export const GRANT_TTL_MS = 30 * 60_000;
export const BRIEF =
  "Summarise every confirmed DNS-tampering incident in IR between 2026-01 and 2026-06, with permalinks.";

export function seededEntropy(seed: number): SessionEntropy {
  const seed0 = seed >>> 0;
  let s = seed >>> 0;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  let counter = 0;
  return {
    random(n: number) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = next() & 0xff;
      if (out.every((b) => b === 0)) out[0] = 1;
      return out;
    },
    nonce() {
      counter += 1;
      return `n${seed0.toString(16).padStart(8, "0")}${String(counter).padStart(7, "0")}`;
    },
  };
}

export function signerFor(secretKey: Uint8Array): Signer {
  return (bytes: Uint8Array) => nacl.sign.detached(bytes, secretKey);
}

export interface Party {
  signingPublicKey: Uint8Array;
  signingPublicKeyBase64: string;
  sign: Signer;
  did: string;
}

export function party(seed: number): Party {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  return {
    signingPublicKey: kp.publicKey,
    signingPublicKeyBase64: encodeBase64(kp.publicKey),
    sign: signerFor(kp.secretKey),
    did: deriveDidFromSigningKey(kp.publicKey),
  };
}

export function verifiedProviderFor(
  p: Party,
  enc: nacl.BoxKeyPair,
  price: {
    chain: string;
    asset: string;
    payeeAccount: string;
    minAmount: string;
    maxAmount: string;
  },
  ref = "voidly.research.censorship-summary",
): VerifiedProvider {
  const entry = {
    publicKeyBase64: encodeBase64(enc.publicKey),
    secretKey: enc.secretKey,
    retainUntilMs: null,
  };
  return verifiedProviderFromConfig(
    {
      did: p.did,
      signingPublicKey: p.signingPublicKey,
      sign: (bytes: Uint8Array) => p.sign(bytes) as Uint8Array,
      currentEncryption: entry,
      encryptionKeyring: [entry],
    },
    providerConfigFor([{ ref, ...price }]),
  );
}

export async function freshHire(seed = 0xabcdef) {
  const hirer = party(1);
  const provider = party(2);
  const attestor = party(3);
  const providerEnc = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
  const hire = await buildHire({
    hirer: {
      did: hirer.did,
      signingPublicKeyBase64: hirer.signingPublicKeyBase64,
      sign: hirer.sign,
    },
    provider: verifiedProviderFor(provider, providerEnc, {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
      minAmount: PRICE,
      maxAmount: PRICE,
    }),
    service: { ref: "voidly.research.censorship-summary" },
    task: { brief: BRIEF },
    price: {
      chain: CHAIN,
      asset: x402SessionAssetCaip19(CHAIN)!,
      payerAccount: x402SessionAccountCaip10(CHAIN, PAYER_ADDR)!,
      payeeAccount: x402SessionAccountCaip10(CHAIN, PAYEE_ADDR)!,
      minAmount: PRICE,
      maxAmount: PRICE,
    },
    ttl: { offerMs: OFFER_TTL_MS, grantMs: GRANT_TTL_MS },
    nowMs: NOW,
    entropy: seededEntropy(seed),
  });
  if (!hire.ok) throw new Error(`fixture hire failed: ${hire.reason}`);
  return { hirer, provider, attestor, providerEnc, hire };
}

export async function sealWire(
  hirer: Party,
  offer: SessionOfferEnvelope,
  grant: TaskGrantEnvelope,
  capsule: TaskCapsule,
): Promise<HireWire> {
  const offerSig = await signCanonical(offer, hirer.sign);
  const grantSig = await signCanonical(grant, hirer.sign);
  if (offerSig === null || grantSig === null) throw new Error("fixture signing failed");
  return {
    offer,
    offer_signature_base64: offerSig,
    grant,
    grant_signature_base64: grantSig,
    capsule,
  };
}

export async function rebind(
  offer: SessionOfferEnvelope,
  grant: TaskGrantEnvelope,
  capsule: TaskCapsule,
): Promise<{ offer: SessionOfferEnvelope; grant: TaskGrantEnvelope; capsule: TaskCapsule }> {
  const offerHash = await envelopeHash(offer);
  const cap: TaskCapsule = { ...capsule, offer_hash: offerHash };
  const capsuleHash = await envelopeHash(cap);
  return {
    offer,
    grant: { ...grant, offer_hash: offerHash, capsule_hash: capsuleHash },
    capsule: cap,
  };
}
