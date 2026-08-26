
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";

import {
  fetchVerifiedProvider,
  isVerifiedProvider,
  PROVIDER_MANIFEST_PATH,
  deriveDidFromSigningKey,
} from "../src/index";
import type { FetchLike } from "../src/index";
import { buildManifest } from "./_manifestFixture";
import type { ProviderManifest } from "../../session-protocol/src/providerManifest";

const CHAIN = "eip155:8453";
const URL = `https://provider.example.test${PROVIDER_MANIFEST_PATH}`;

const HONEST_KP = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const HONEST_ENC = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(11));
const HONEST_DID = deriveDidFromSigningKey(HONEST_KP.publicKey);

const ATTACKER_KP = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const ATTACKER_ENC = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(29));
const ATTACKER_DID = deriveDidFromSigningKey(ATTACKER_KP.publicKey);

function manifestFor(kp: nacl.SignKeyPair, enc: nacl.BoxKeyPair): ProviderManifest {
  const entry = {
    publicKeyBase64: encodeBase64(enc.publicKey),
    secretKey: enc.secretKey,
    retainUntilMs: null,
  };
  return buildManifest(
    {
      did: deriveDidFromSigningKey(kp.publicKey),
      signingPublicKey: kp.publicKey,
      sign: (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
      currentEncryption: entry,
      encryptionKeyring: [entry],
    },
    {
      acceptUrl: "https://provider.example.test/session/accept",
      workerBaseUrl: "https://api.voidly.ai",
      attestorPublicKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).publicKey,
      services: [
        {
          ref: "observatory/query",
          description: "one observatory query",
          chain: CHAIN,
          asset: `${CHAIN}/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`,
          payeeAccount: `${CHAIN}:0x2222222222222222222222222222222222222222`,
          minAmount: "1000000",
          maxAmount: "1500000",
        },
      ],
      minGrantTtlMs: 60_000,
      maxGrantTtlMs: 6 * 60 * 60_000,
      acceptanceTtlMs: 5 * 60_000,
    },
  );
}

const HONEST = manifestFor(HONEST_KP, HONEST_ENC);
const ATTACKER = manifestFor(ATTACKER_KP, ATTACKER_ENC);

function serving(body: string, status = 200): FetchLike {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("fetchVerifiedProvider", () => {
  it("the happy path returns the BRAND, not a parsed document", async () => {
    const r = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: serving(JSON.stringify(HONEST)),
    });
    expect(r.ok, r.ok ? "" : `refused: ${r.reason}`).toBe(true);
    if (!r.ok) return;
    expect(isVerifiedProvider(r.provider)).toBe(true);
    expect(r.provider.manifest.provider_did).toBe(HONEST_DID);
    expect(Object.isFrozen(r.provider.manifest)).toBe(true);
  });

  it("SELECTIVE TAMPERING over the socket is refused — honest DID, attacker key", async () => {
    const tampered = {
      ...HONEST,
      encryption_public_key_base64: encodeBase64(ATTACKER_ENC.publicKey),
      accept_url: "http://attacker.example.test/session/accept",
    };
    const r = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: serving(JSON.stringify(tampered)),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("manifest_signature_invalid");
  });

  it("the attacker's own perfectly-signed manifest is refused BY THE PIN", async () => {
    const r = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: serving(JSON.stringify(ATTACKER)),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("manifest_did_not_pinned");
    const own = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: ATTACKER_DID,
      fetchImpl: serving(JSON.stringify(ATTACKER)),
    });
    expect(own.ok).toBe(true);
  });

  it("a pin that is not a DID is refused before the document is even read", async () => {
    let fetched = 0;
    const counting: FetchLike = async (u, i) => {
      fetched += 1;
      return serving(JSON.stringify(HONEST))(u, i);
    };
    const r = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: "not-a-did",
      fetchImpl: counting,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("manifest_pin_not_a_did");
    expect(fetched).toBe(1);
  });

  it("the two transport words are this package's OWN, and they carry no body", async () => {
    const dead: FetchLike = async () => {
      throw Object.assign(new Error("https://rpc.example/v2/SUPERSECRETKEY refused"), {
        name: "TypeError",
      });
    };
    const unreachable = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: dead,
    });
    expect(unreachable.ok).toBe(false);
    if (unreachable.ok) return;
    expect(unreachable.reason).toBe("manifest_unreachable");
    expect(unreachable.detail).not.toContain("SUPERSECRETKEY");

    const notFound = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: serving("nope", 404),
    });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.reason).toBe("manifest_unreachable");

    const garbage = await fetchVerifiedProvider({
      manifestUrl: URL,
      expectedProviderDid: HONEST_DID,
      fetchImpl: serving("<html>SECRET-BODY-MARKER</html>"),
    });
    expect(garbage.ok).toBe(false);
    if (garbage.ok) return;
    expect(garbage.reason).toBe("manifest_not_json");
    expect(garbage.detail).not.toContain("SECRET-BODY-MARKER");
  });

  it("there is no arm that returns an unverified manifest", async () => {
    const refusals = await Promise.all([
      fetchVerifiedProvider({ manifestUrl: URL, expectedProviderDid: "x", fetchImpl: serving("{}") }),
      fetchVerifiedProvider({
        manifestUrl: URL,
        expectedProviderDid: HONEST_DID,
        fetchImpl: serving("{}"),
      }),
      fetchVerifiedProvider({
        manifestUrl: URL,
        expectedProviderDid: HONEST_DID,
        fetchImpl: serving(JSON.stringify({ ...HONEST, signature_base64: undefined })),
      }),
    ]);
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      expect("provider" in r).toBe(false);
    }
  });
});
