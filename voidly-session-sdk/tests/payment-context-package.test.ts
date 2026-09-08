import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { buildSync } from "esbuild";
import { Wallet } from "ethers";
import { ensureBuilt } from "./_ensureBuilt";
import { runTsc } from "./_tsc";

const PKG = resolve(__dirname, "..");
const RUNTIME_DEPS = { tweetnacl: "1.0.3", "tweetnacl-util": "0.15.1" };
const PAYMENT_EXPORTS = [
  "createPaymentContext", "checkPaymentSignRequest", "verifyPaymentSignature", "checkPaymentSubmitRequest",
];
const ENTRY_POINTS = ["receive_with_authorization", "transfer_with_authorization"] as const;
let directory: string;
let consumer: string;
let installed: string;
let emitted: string;
let fixtureJson: string;

const EXERCISE = `async function exercise(sdk, fixtures) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let verified = 0;
  for (const fixture of fixtures) {
    const created = await sdk.createPaymentContext({ grant: fixture.grant, entryPoint: fixture.entryPoint });
    check(created.ok, "packed context refused");
    const context = created.context;
    const admitted = sdk.checkPaymentSignRequest({ context, typedData: context.typedData });
    check(admitted.ok && Object.isFrozen(admitted.typedData.message), "signing payload is not frozen");
    const signature = fixture.signature;
    const signed = sdk.verifyPaymentSignature({ context, signature });
    check(signed.ok && signed.signature === signature, "verified signature bytes changed");
    check(!sdk.verifyPaymentSignature({ context: { ...context }, signature }).ok, "copied context admitted");
    const opposite = fixture.entryPoint === "receive_with_authorization"
      ? "transfer_with_authorization" : "receive_with_authorization";
    const other = await sdk.createPaymentContext({ grant: fixture.grant, entryPoint: opposite });
    check(other.ok && !sdk.verifyPaymentSignature({ context: other.context, signature }).ok, "wrong entry point admitted");
    const sign = fixture.entryPoint === "receive_with_authorization"
      ? sdk.signReceiveAuthorization : sdk.signTransferAuthorization;
    const encode = fixture.entryPoint === "receive_with_authorization"
      ? sdk.buildReceiveWithAuthorizationCalldata : sdk.buildTransferWithAuthorizationCalldata;
    const built = await sign({
      chain: context.grant.price_chain, from: context.grant.price_payer_account,
      to: context.grant.price_payee_account, value: context.amount, validAfter: 0,
      validBefore: Number(context.typedData.message.validBefore),
      grantHash: context.grantHash, nowMs: Date.now(),
    }, () => signature);
    check(built.ok, "actual SDK signing builder refused");
    const calldata = encode(built.signed);
    check(calldata.ok, "actual SDK calldata builder refused");
    const request = sdk.checkPaymentSubmitRequest({ context, signature, request: calldata.request });
    check(request.ok && Object.isFrozen(request.request), "packed submit request refused or mutable");
    check(Object.keys(request.request).sort().join() === "chainId,data,to,value", "unexpected transaction fields");
    check(!sdk.checkPaymentSubmitRequest({ context, signature,
      request: { ...calldata.request, data: calldata.request.data + "00" } }).ok, "trailing calldata admitted");
    verified++;
  }
  return { verified, exports: ${JSON.stringify(PAYMENT_EXPORTS)}.every(name => typeof sdk[name] === "function") };
}`;

beforeAll(async () => {
  emitted = ensureBuilt(PKG);
  directory = mkdtempSync(join(tmpdir(), "voidly-payment-context-package-"));
  consumer = join(directory, "consumer");
  installed = join(consumer, "node_modules/@voidly/session");
  mkdirSync(installed, { recursive: true });
  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", directory,
  ], { cwd: PKG, encoding: "utf8", timeout: 30_000 }))[0];
  execFileSync("tar", ["xzf", join(directory, packed.filename), "--strip-components=1", "-C", installed]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));

  const require_ = createRequire(join(PKG, "package.json"));
  for (const name of Object.keys(RUNTIME_DEPS)) {
    const source = dirname(require_.resolve(`${name}/package.json`));
    cpSync(source, join(consumer, "node_modules", name), { recursive: true });
  }

  const sdk = await import(pathToFileURL(emitted).href);
  const payer = Wallet.createRandom();
  const now = Date.now();
  const grant = {
    schema: "voidly-task-grant/v1", hirer_did: "did:voidly:mPJNnvvYiKrFuY96NeESb",
    provider_did: "did:voidly:6rGTFa5apSnKNF14bGXZfu",
    provider_signing_pubkey_base64: "L16pOb+7U0Qjgs43s61D8KiLi6KRAJ1CpqszP6FzCyE=",
    provider_enc_pubkey_base64: "BC4/bHqUQHnwt593WsVhgz1loPpUyESJV/Oy6SU5h1k=",
    offer_hash: "aa".repeat(32), capsule_hash: "bb".repeat(32), brief_commitment: "cc".repeat(32),
    price_chain: "eip155:8453",
    price_asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    price_payer_account: `eip155:8453:${payer.address.toLowerCase()}`,
    price_payee_account: "eip155:8453:0xb0b3fca940e04f99367f08e665e1c2cb4ebd4912",
    price_min_amount: "50000", price_max_amount: "5000000", nonce: "n".repeat(24),
    issued_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 540_000).toISOString(),
  };
  const fixtures = [];
  for (const entryPoint of ENTRY_POINTS) {
    const created = await sdk.createPaymentContext({ grant, entryPoint });
    expect(created.ok).toBe(true);
    const { domain, types, message } = created.context.typedData;
    const { EIP712Domain: _domain, ...applicationTypes } = types;
    const signature = await payer.signTypedData(domain, applicationTypes, message);
    fixtures.push({ grant, entryPoint, signature: `0x${signature.slice(2).toUpperCase()}` });
  }
  fixtureJson = JSON.stringify(fixtures);
}, 120_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("payment context in the emitted and packed package", () => {
  it("retains exactly the existing runtime dependencies and needs no ethers installation", () => {
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual(RUNTIME_DEPS);
    expect(existsSync(join(consumer, "node_modules/ethers"))).toBe(false);
    expect(existsSync(join(consumer, "node_modules/@noble"))).toBe(false);
    for (const name of Object.keys(RUNTIME_DEPS)) {
      const dependency = JSON.parse(readFileSync(join(consumer, "node_modules", name, "package.json"), "utf8"));
      expect(dependency.version).toBe(RUNTIME_DEPS[name as keyof typeof RUNTIME_DEPS]);
      expect(dependency.dependencies ?? {}).toEqual({});
    }
    expect(readFileSync(join(installed, "dist/index.mjs"), "utf8")).toBe(readFileSync(emitted, "utf8"));
    expect(readFileSync(join(installed, "dist/index.d.ts"), "utf8"))
      .toBe(readFileSync(join(PKG, "dist/index.d.ts"), "utf8"));
  });

  it("has only the two reviewed runtime externals in both emitted and packed roots", () => {
    for (const entry of [emitted, join(installed, "dist/index.mjs")]) {
      const built = buildSync({
        entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "neutral",
        target: "es2021", metafile: true, external: Object.keys(RUNTIME_DEPS),
      });
      const edges = [
        ...Object.values(built.metafile!.inputs).flatMap(input => input.imports),
        ...Object.values(built.metafile!.outputs).flatMap(output => output.imports),
      ].filter(edge => edge.external).map(edge => edge.path);
      expect([...new Set(edges)].sort()).toEqual(Object.keys(RUNTIME_DEPS).sort());
      expect(Object.keys(built.metafile!.inputs).some(name => /node_modules\/(?:ethers|@noble)\//.test(name))).toBe(false);
    }
  });

  it("verifies both entry points and exact submit calldata through a native packed import", () => {
    writeFileSync(join(consumer, "exercise.mjs"), `
let networkRequests = 0;
globalThis.fetch = () => { networkRequests++; throw new Error("offline consumer"); };
const sdk = await import("@voidly/session");
${EXERCISE}
const result = await exercise(sdk, ${fixtureJson});
console.log(JSON.stringify({ ...result, networkRequests }));
`);
    const result = JSON.parse(execFileSync(process.execPath, ["exercise.mjs"], {
      cwd: consumer, encoding: "utf8", timeout: 20_000,
    }));
    expect(result).toEqual({ verified: 2, exports: true, networkRequests: 0 });
  });

  it("runs the packed browser bundle with WebCrypto and no Node globals or externals", async () => {
    const built = buildSync({
      stdin: { contents: 'export * from "@voidly/session";', resolveDir: consumer },
      bundle: true, write: false, format: "iife", globalName: "PackedSession", platform: "browser",
      target: "es2021", metafile: true,
    });
    const outputs = Object.values(built.metafile!.outputs);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].imports).toEqual([]);
    expect(Object.keys(built.metafile!.inputs).some(name => /node_modules\/(?:ethers|@noble)\//.test(name))).toBe(false);
    let networkRequests = 0;
    const context = createContext({
      crypto: webcrypto, TextEncoder, TextDecoder, atob, btoa,
      fetch: () => { networkRequests++; throw new Error("offline browser"); },
    });
    runInContext("globalThis.self = globalThis;", context);
    runInContext(built.outputFiles[0].text, context, { timeout: 10_000 });
    expect(runInContext('typeof process === "undefined" && typeof Buffer === "undefined" && typeof require === "undefined"', context)).toBe(true);
    const result = await runInContext(`${EXERCISE}\nexercise(PackedSession, ${fixtureJson})`, context, { timeout: 10_000 });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ verified: 2, exports: true });
    expect(networkRequests).toBe(0);
  });

  it("ships browser-compatible declarations with an opaque, deeply readonly context", () => {
    writeFileSync(join(consumer, "probe.ts"), `
import { createPaymentContext, checkPaymentSignRequest, verifyPaymentSignature, checkPaymentSubmitRequest } from "@voidly/session";
type Context = Extract<Awaited<ReturnType<typeof createPaymentContext>>, { ok: true }>['context'];
declare const context: Context;
declare const grant: unknown;
void createPaymentContext({ grant, entryPoint: "receive_with_authorization" });
void createPaymentContext({ grant, entryPoint: "transfer_with_authorization", amount: "50000" });
void checkPaymentSignRequest({ context, typedData: context.typedData });
void verifyPaymentSignature({ context, signature: "synthetic" });
void checkPaymentSubmitRequest({ context, signature: "synthetic", request: {} });
// @ts-expect-error plain data does not carry the context's opaque brand
const forged: Context = { grant: context.grant, grantHash: context.grantHash, entryPoint: context.entryPoint, amount: context.amount, typedData: context.typedData };
// @ts-expect-error the selected amount is readonly
context.amount = "5000000";
// @ts-expect-error the retained grant is readonly
context.grant.price_payee_account = "changed";
// @ts-expect-error the typed payment is readonly
context.typedData.message.value = "5000000";
// @ts-expect-error domain fields are readonly
context.typedData.domain.chainId = 1;
// @ts-expect-error nested type descriptors are readonly
context.typedData.types.EIP712Domain[0].type = "bytes32";
void forged;
`);
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2021", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      lib: ["ES2021", "DOM"], noEmit: true, skipLibCheck: false, types: [],
    }, include: ["probe.ts"] }));
    const result = runTsc(consumer);
    expect(result.ok, result.out).toBe(true);
  }, 120_000);
});
