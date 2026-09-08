import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { buildSync } from "esbuild";
import { verifySettlement } from "../src/index";
import { honest, TYPED } from "./_settlementFixtures";
import { ensureBuilt } from "./_ensureBuilt";
import { runTsc } from "./_tsc";
const PKG = resolve(__dirname, "..");
const RUNTIME = { tweetnacl: "1.0.3", "tweetnacl-util": "0.15.1" };
let temporary: string, consumer: string, installed: string, fixtureJson: string;
const EXERCISE = `async function exercise(sdk, fixture) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const makeFetch = mode => async (url, init) => {
    const call = JSON.parse(init.body);
    assert(init.method === 'POST' && init.redirect === 'error' && call.jsonrpc === '2.0', 'wrong HTTP boundary');
    let result;
    if (call.method === 'eth_chainId') result = '0x2105';
    else if (call.method === 'eth_getTransactionReceipt') {
      result = JSON.parse(JSON.stringify(fixture.receipt));
      if (mode === 'nonce') result.logs[0].topics[2] = '0x' + 'ff'.repeat(32);
      if (mode === 'divergence' && String(url).includes('rpc-b.')) result.extra = null;
    } else if (call.method === 'eth_getBlockByNumber') result = { number: '0x100', hash: fixture.receipt.blockHash };
    else if (call.method === 'eth_blockNumber') result = '0x10c';
    else throw new Error('unexpected method');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: mode === 'id' ? String(call.id) : call.id, result }));
  };
  const success = await sdk.verifySettlement({ ...fixture.input, fetch: makeFetch('good') });
  assert(success.ok && success.confirmations === 12 && success.headOperators === 2 && !success.unpinned, 'packed quorum refused');
  assert(success.assurance.level === 'rpc-quorum-inclusion' && success.assurance.safe === 'not-checked' && success.assurance.finalized === 'not-checked', 'overstated assurance');
  for (const [mode, reason] of [['id','rpc_envelope_invalid'], ['nonce','nonce_not_spent_by_this_tx'], ['divergence','rpc_divergence']]) {
    const result = await sdk.verifySettlement({ ...fixture.input, fetch: makeFetch(mode) });
    assert(!result.ok && result.reason === reason, 'packed negative failed: ' + mode);
  }
  const unpinned = await sdk.verifySettlement({ ...fixture.input, allowedRpcHosts: [], allowUnpinnedRpc: true, fetch: makeFetch('good') });
  assert(unpinned.ok && unpinned.unpinned && unpinned.unpinnedHosts.length === 2, 'unpinned status lost');
  assert(!('createSettlementRpc' in sdk) && !('rpcReadErrorCode' in sdk), 'internal transport exported');
  return { success: true, hostileCases: 3, unpinned: true };
}`;
beforeAll(async () => {
  ensureBuilt(PKG);
  temporary = mkdtempSync(join(tmpdir(), "voidly-settlement-package-"));
  consumer = join(temporary, "consumer");
  installed = join(consumer, "node_modules/@voidly/session");
  mkdirSync(installed, { recursive: true });
  const pack = JSON.parse(execFileSync("npm", ["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", temporary], { cwd: PKG, encoding: "utf8" }))[0];
  execFileSync("tar", ["xzf", join(temporary, pack.filename), "--strip-components=1", "-C", installed]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  const require = createRequire(join(PKG, "package.json"));
  for (const name of Object.keys(RUNTIME)) cpSync(dirname(require.resolve(`${name}/package.json`)), join(consumer, "node_modules", name), { recursive: true });
  fixtureJson = JSON.stringify({ input: TYPED, receipt: await honest() });
  const sourceResult = await (new Function(`${EXERCISE}; return exercise;`)())({ verifySettlement }, JSON.parse(fixtureJson));
  expect(sourceResult).toEqual({ success: true, hostileCases: 3, unpinned: true });
}, 120000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe("settlement verification in the actual package", () => {
  it("retains the exact runtime dependencies and emitted bytes", () => {
    expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).dependencies).toEqual(RUNTIME);
    expect(existsSync(join(consumer, "node_modules/ethers"))).toBe(false);
    expect(readFileSync(join(installed, "dist/index.mjs"), "utf8")).toBe(readFileSync(join(PKG, "dist/index.mjs"), "utf8"));
    expect(readFileSync(join(installed, "dist/index.d.ts"), "utf8")).toBe(readFileSync(join(PKG, "dist/index.d.ts"), "utf8"));
  });
  it("checks packed quorum, identity failures and unpinned semantics in native Node", () => {
    writeFileSync(join(consumer, "exercise.mjs"), `
globalThis.fetch = () => { throw new Error('external fetch forbidden'); };
const sdk = await import('@voidly/session');
${EXERCISE}
console.log(JSON.stringify(await exercise(sdk, ${fixtureJson})));
`);
    const output = execFileSync(process.execPath, ["exercise.mjs"], { cwd: consumer, encoding: "utf8", timeout: 15000 });
    expect(JSON.parse(output)).toEqual({ success: true, hostileCases: 3, unpinned: true });
  });
  it("has no new emitted or packed externals and runs the browser bundle without Node globals", async () => {
    const closure = buildSync({ entryPoints: [join(installed, "dist/index.mjs")], bundle: true, write: false, platform: "neutral", format: "esm", metafile: true, external: Object.keys(RUNTIME) });
    expect([...new Set(Object.values(closure.metafile!.outputs).flatMap(output => output.imports).filter(edge => edge.external).map(edge => edge.path))].sort()).toEqual(Object.keys(RUNTIME).sort());
    const browser = buildSync({ stdin: { contents: 'export * from "@voidly/session";', resolveDir: consumer }, bundle: true, write: false, format: "iife", globalName: "PackedSession", platform: "browser", target: "es2021", metafile: true });
    expect(Object.values(browser.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    const context = createContext({ crypto: webcrypto, TextEncoder, TextDecoder, URL, Response, ReadableStream, AbortController, performance, setTimeout, clearTimeout, atob, btoa });
    runInContext("globalThis.self = globalThis", context);
    runInContext(browser.outputFiles[0].text, context, { timeout: 10000 });
    expect(runInContext('typeof process === "undefined" && typeof Buffer === "undefined" && typeof require === "undefined" && typeof fetch === "undefined"', context)).toBe(true);
    const result = await runInContext(`${EXERCISE}\nexercise(PackedSession, ${fixtureJson})`, context, { timeout: 10000 });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ success: true, hostileCases: 3, unpinned: true });
  });
  it("ships browser declarations without exposing unchecked RPC-result injection", () => {
    writeFileSync(join(consumer, "probe.ts"), `
import { verifySettlement, type VerifySettlementInput, type SettlementVerificationResult } from '@voidly/session';
declare const input: VerifySettlementInput;
void verifySettlement({ tx: 'synthetic', grantHash: 'synthetic', payer: 'synthetic', payee: 'synthetic', amount: '50000', rpcUrls: [], allowedRpcHosts: [], fetch });
declare const result: SettlementVerificationResult;
if (result.ok) {
  const assurance: 'not-checked' = result.assurance.finalized;
  // @ts-expect-error assurance is immutable
  result.assurance.safe = 'checked';
  // @ts-expect-error host evidence is immutable
  result.rpcHosts.push('other');
  void assurance;
}
// @ts-expect-error results cannot be supplied above the HTTP boundary
void verifySettlement({ ...input, rpc: async () => ({ status: '0x1' }) });
// @ts-expect-error internal transport is not a public API
import { createSettlementRpc } from '@voidly/session';
`);
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2021", module: "NodeNext", moduleResolution: "NodeNext", strict: true, lib: ["ES2021", "DOM"], types: [], skipLibCheck: false, noEmit: true }, include: ["probe.ts"] }));
    const result = runTsc(consumer); expect(result.ok, result.out).toBe(true);
  }, 120000);
});
