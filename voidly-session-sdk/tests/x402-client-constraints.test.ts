
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildTransferAuthorizationTypedData,
  createFacilitatorSubmitter,
  createReadOnlyEvmRpc,
  FORBIDDEN_RPC_METHODS,
  READ_ONLY_RPC_METHODS,
  settlementNonce,
  EVM_USDC_EIP712_DOMAINS,
  X402_SESSION_USDC_BY_CHAIN,
} from "../src/index";
import type { FacilitatorPreflightResult, SignedTransferAuthorization } from "../src/index";

const SRC = resolve(__dirname, "..", "src");
const GRANT_HASH = "a".repeat(64);
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function code(path: string): string {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");
}

const SRC_FILES = walk(SRC);

describe("the EIP-3009 nonce is DERIVED from the grant, never drawn", () => {
  it("the same grant yields the same nonce, every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(await settlementNonce(GRANT_HASH));
    expect(seen.size).toBe(1);
  });

  it("the built payload's nonce IS that value, not a fresh draw", async () => {
    const base = {
      chain: "eip155:8453",
      from: PAYER,
      to: PAYEE,
      value: "1000000",
      validAfter: 0,
      validBefore: 1_800_000_000,
      grantHash: GRANT_HASH,
    };
    const a = await buildTransferAuthorizationTypedData(base);
    const b = await buildTransferAuthorizationTypedData(base);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.typedData.message.nonce).toBe(b.typedData.message.nonce);
    expect(a.typedData.message.nonce).toBe(await settlementNonce(GRANT_HASH));
  });

  it("this package takes NO x402 client dependency — it cannot inherit that nonce", () => {
    const offenders: string[] = [];
    for (const f of SRC_FILES) {
      if (/\b(?:@x402\/|["']x402["']|createNonce)\b/.test(code(f))) {
        offenders.push(f.slice(SRC.length + 1));
      }
    }
    expect(
      offenders,
      "@x402/evm's createNonce() is random with NO override, so the stock client " +
        "cannot produce this rail's binding nonce. Anything importing it must still " +
        "sign the EIP-712 payload this package builds.",
    ).toEqual([]);
  });
});

describe("the facilitator path cannot be assembled without its preflight", () => {
  it("createFacilitatorSubmitter takes a preflight RESULT, so there is no un-preflighted door", () => {
    let fetches = 0;
    const submitter = createFacilitatorSubmitter({
      preflight: {
        schema: "voidly.pay.facilitator-preflight/v1",
        verdict: "unusable",
        reason: "transfer_method_permit2",
        detail: "advertises permit2",
        chain: "eip155:8453",
        frozenAsset: null,
        url: "https://facilitator.example.test/supported",
        httpStatus: 200,
        matched: null,
        observations: [],
        undetermined: [],
      } as unknown as FacilitatorPreflightResult,
      fetchImpl: (async () => {
        fetches++;
        return new Response("{}", { status: 200 });
      }) as never,
    });
    expect(submitter.kind).toBe("facilitator");
    return submitter
      .submit({
        typedData: { message: {} },
        signature: "0x",
        v: 27,
        r: "0x",
        s: "0x",
        chain: "eip155:8453",
        grantHash: GRANT_HASH,
      } as unknown as SignedTransferAuthorization)
      .then((out) => {
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.reason).toBe("facilitator_not_usable");
        expect(fetches).toBe(0);
      });
  });

  it("the /supported preflight is imported from the core, never reimplemented here", () => {
    const hirer = code(join(SRC, "hirer.ts"));
    const submission = code(join(SRC, "submission.ts"));
    const seamImport = /import\s*\{[^}]*preflightFacilitator[^}]*\}\s*from\s*"\.\/protocol"/s;
    const importers = [
      ["hirer.ts", hirer],
      ["submission.ts", submission],
    ].filter(([, src]) => seamImport.test(src as string));
    expect(
      importers.map(([name]) => name),
      "`preflightFacilitator` must be imported through the seam by exactly one module",
    ).toEqual(["hirer.ts"]);
    expect(hirer).toContain("preflightAdmitsPayment");
    expect(submission).toContain("export function preflightAdmitsPayment");
  });
});

describe("this package can read a chain and cannot write to one", () => {
  it("the allowlist admits no method that signs, sends or lists accounts", () => {
    for (const method of READ_ONLY_RPC_METHODS) {
      expect(method, `${method} is not read-only`).not.toMatch(
        /send|sign|account|personal|unlock|import|submit/i,
      );
    }
    for (const method of FORBIDDEN_RPC_METHODS) {
      expect(method).toMatch(/send|sign|account|personal|unlock|import|submit/i);
    }
    for (const method of FORBIDDEN_RPC_METHODS) {
      expect(READ_ONLY_RPC_METHODS).not.toContain(method);
    }
  });

  it("a broadcast attempt is refused BEFORE the network is touched", async () => {
    let fetches = 0;
    const rpc = createReadOnlyEvmRpc({
      url: "https://mainnet.base.org",
      fetchImpl: (async () => {
        fetches++;
        return new Response('{"jsonrpc":"2.0","id":1,"result":"0x"}', { status: 200 });
      }) as never,
    });
    for (const method of FORBIDDEN_RPC_METHODS) {
      const res = await rpc.request(method, ["0xdeadbeef"]);
      expect(res.ok, method).toBe(false);
      if (res.ok) continue;
      expect(res.reason, method).toBe("rpc_method_not_read_only");
    }
    expect(fetches, "a refused method still reached the network").toBe(0);

    const ok = await rpc.request("eth_chainId", []);
    expect(ok.ok).toBe(true);
    expect(fetches).toBe(1);
  });

  it("the write-method names appear in src/ only inside the refusal list", () => {
    const MARKERS = [
      "eth_sendRawTransaction",
      "eth_sendTransaction",
      "privateKey",
      "signTransaction",
      "sendTransaction",
    ];
    const offenders: string[] = [];
    for (const f of SRC_FILES) {
      const name = f.slice(SRC.length + 1);
      let src = code(f);
      if (name === "relay.ts") {
        src = src.replace(
          /export const FORBIDDEN_RPC_METHODS[\s\S]*?\]\);/,
          "/* FORBIDDEN_RPC_METHODS excised */",
        );
        expect(src, "the FORBIDDEN_RPC_METHODS literal was not found to excise").not.toContain(
          "eth_sendRawTransaction",
        );
      }
      for (const marker of MARKERS) {
        if (src.includes(marker)) offenders.push(`${name} → ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the two token tables cannot drift apart", () => {
  it("they name the same chains", () => {
    expect([...EVM_USDC_EIP712_DOMAINS.keys()].sort()).toEqual(
      [...X402_SESSION_USDC_BY_CHAIN.keys()].sort(),
    );
  });

  it("they name the same contract for each chain, spelled identically", () => {
    for (const [chain, d] of EVM_USDC_EIP712_DOMAINS) {
      expect(X402_SESSION_USDC_BY_CHAIN.get(chain)).toBe(d.verifyingContract);
      expect(d.verifyingContract, "the rail compares with === and no normalisation").toBe(
        d.verifyingContract.toLowerCase(),
      );
    }
  });
});

describe("the built payload folds address case, because the rail compares with ===", () => {
  it("a checksummed address is lowercased before it is signed", async () => {
    const CHECKSUMMED_PAYER = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const CHECKSUMMED_PAYEE = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453",
      from: CHECKSUMMED_PAYER,
      to: CHECKSUMMED_PAYEE,
      value: "1000000",
      validAfter: 0,
      validBefore: 1_800_000_000,
      grantHash: GRANT_HASH,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.typedData.message.from).toBe(CHECKSUMMED_PAYER.toLowerCase());
    expect(built.typedData.message.to).toBe(CHECKSUMMED_PAYEE.toLowerCase());
  });

  it("a CAIP-10 account is folded the same way", async () => {
    const built = await buildTransferAuthorizationTypedData({
      chain: "eip155:8453",
      from: "eip155:8453:0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
      to: PAYEE,
      value: "1",
      validAfter: 0,
      validBefore: 1_800_000_000,
      grantHash: GRANT_HASH,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.typedData.message.from).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});
