
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";

import {
  checkPartiesRegistered,
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

describe("checkPartiesRegistered", () => {
  const HIRER = "did:voidly:AotWKC6aYDcHMpv3F7dHfV";
  const PROVIDER = "did:voidly:6rGTFa5apSnKNF14bGXZfu";
  const HIRER_KEY = "T24z49Q85s9QPSSJM6dNuPvSBa6TT0Gv7QW1zRXi1Pk=";
  const PROVIDER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA=";

  const active = (did: string, key: string) => ({
    did,
    name: "agent",
    signing_public_key: key,
    encryption_public_key: "qatoNL5dHFpPhcc6I2S42ZvgwnGHAIgcRE0D1W2tomA=",
    capabilities: [],
    metadata: {},
    status: "active",
    created_at: "2026-08-26 23:17:37",
  });

  const registry = (rows: Record<string, unknown>): FetchLike =>
    (async (url: string) => {
      const did = decodeURIComponent(String(url).split("/v1/agent/identity/")[1] ?? "");
      const row = rows[did];
      if (row === undefined) {
        return new Response(JSON.stringify({ error: "Agent not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as FetchLike;

  const both = {
    [HIRER]: active(HIRER, HIRER_KEY),
    [PROVIDER]: active(PROVIDER, PROVIDER_KEY),
  };

  const check = (fetchImpl: FetchLike, over: Record<string, unknown> = {}) =>
    checkPartiesRegistered({
      registryBaseUrl: "https://api.voidly.ai",
      hirerDid: HIRER,
      providerDid: PROVIDER,
      hirerSigningPublicKeyBase64: HIRER_KEY,
      fetchImpl,
      ...over,
    });

  it("admits two active rows whose hirer key is the one the offer pins", async () => {
    expect(await check(registry(both))).toEqual({ ok: true });
  });

  it("refuses an unregistered hirer — the live 404 body, not a parse fault", async () => {
    const verdict = await check(registry({ [PROVIDER]: active(PROVIDER, PROVIDER_KEY) }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("hirer_unregistered");
    expect(verdict.detail).toContain("/v1/agent/register");
  });

  it("refuses a deactivated hirer — the rail's admit filter is `status='active'`", async () => {
    const verdict = await check(
      registry({ ...both, [HIRER]: { ...active(HIRER, HIRER_KEY), status: "deactivated" } }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("hirer_unregistered");
  });

  it("refuses a hirer registered UNDER A DIFFERENT KEY — the arm nothing local catches", async () => {
    const verdict = await check(
      registry({ ...both, [HIRER]: active(HIRER, "ZZZz49Q85s9QPSSJM6dNuPvSBa6TT0Gv7QW1zRXi1Pk=") }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("hirer_key_not_registered");
    expect(verdict.detail).toContain("422");
  });

  it("names the PROVIDER when the provider is the missing one", async () => {
    const verdict = await check(registry({ [HIRER]: active(HIRER, HIRER_KEY) }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("provider_unregistered");
  });

  it("a registry that throws or answers junk is a REFUSAL, never a pass", async () => {
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchLike;
    const thrown = await check(throwing);
    expect(thrown.ok).toBe(false);
    if (thrown.ok) throw new Error("unreachable");
    expect(thrown.reason).toBe("registry_unreadable");
    expect(thrown.detail).not.toContain("api.voidly.ai");

    const html = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as FetchLike;
    const junk = await check(html);
    expect(junk.ok).toBe(false);
    if (junk.ok) throw new Error("unreachable");
    expect(junk.reason).toBe("registry_unreadable");
  });

  it("without the key, `ok` means BOTH ROWS EXIST and never that they agree", async () => {
    const mismatched = registry({
      ...both,
      [HIRER]: active(HIRER, "ZZZz49Q85s9QPSSJM6dNuPvSBa6TT0Gv7QW1zRXi1Pk="),
    });
    expect(await check(mismatched, { hirerSigningPublicKeyBase64: undefined })).toEqual({
      ok: true,
    });
    expect((await check(mismatched)).ok).toBe(false);
  });

  it("a real DID reaches the route UNENCODED — the colons are legal and load-bearing", async () => {
    const asked: string[] = [];
    const spy = (async (url: string) => {
      asked.push(String(url));
      const did = String(url).split("/v1/agent/identity/")[1] ?? "";
      return new Response(JSON.stringify(active(did, did === HIRER ? HIRER_KEY : PROVIDER_KEY)), {
        status: 200,
      });
    }) as unknown as FetchLike;
    expect(await check(spy)).toEqual({ ok: true });
    expect(asked).toEqual([
      `https://api.voidly.ai/v1/agent/identity/${PROVIDER}`,
      `https://api.voidly.ai/v1/agent/identity/${HIRER}`,
    ]);
    for (const url of asked) expect(url).not.toContain("%3A");
  });

  it("a value that is not a DID is REFUSED, not mangled into a URL", async () => {
    let calls = 0;
    const spy = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as FetchLike;
    for (const bad of ["../../../admin/keys", "did:voidly:a/b", "did:other:xyz", "", "did:voidly:"]) {
      const verdict = await check(spy, { providerDid: bad });
      expect(verdict.ok, bad).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.reason, bad).toBe("registry_unreadable");
    }
    expect(calls, "a non-DID must not reach the network at all").toBe(0);
  });
});
