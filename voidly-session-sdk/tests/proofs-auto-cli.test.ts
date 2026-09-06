import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalBytes, sha256Hex } from "../src/index";
import { automaticFixture, AUTO_NOW, PUBLIC_MANIFEST } from "./_automaticFixture";
import { AUTOMATIC_BASE, AUTOMATIC_ISSUER } from "../src/proofsAuto";
import { proofArtworkSvg, SESSIONS_PROOFS_PROVIDER } from "../src/proofs";
import { ensureBuilt } from "./_ensureBuilt";

const PKG = resolve(__dirname, "..");
let consumer: string; let cli: string;
beforeAll(() => {
  ensureBuilt(PKG);
  consumer = mkdtempSync(join(tmpdir(), "voidly-auto-packed-"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], { cwd: PKG, encoding: "utf8" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--prefer-offline", "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--save-exact", join(consumer, packed[0].filename)], { cwd: consumer, encoding: "utf8", timeout: 60000 });
  cli = join(consumer, "node_modules/@voidly/session/dist/proofsCli.mjs");
}, 120000);

async function run(mode: "success" | "export-failure" | "symlink" | "altered-receipt" | "recovery" = "success") {
  const fixture = await automaticFixture();
  if (mode === "altered-receipt") fixture.receipt.signature_hex = "0".repeat(128);
  if (mode === "recovery") fixture.complete.already_completed = true;
  const cwd = mkdtempSync(join(consumer, "proof-run-"));
  const setup = join(cwd, "fixture.mjs");
  const sentinel = join(cwd, "keep.txt"); writeFileSync(sentinel, "do not overwrite");
  writeFileSync(setup, `
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const f=${JSON.stringify(fixture)};
const mode=${JSON.stringify(mode)};
const base=${JSON.stringify(AUTOMATIC_BASE)}, issuer=${JSON.stringify(AUTOMATIC_ISSUER)};
const provider=${JSON.stringify(SESSIONS_PROOFS_PROVIDER)}, manifest=${JSON.stringify(PUBLIC_MANIFEST)};
Date.now=()=>${AUTO_NOW};
if(mode==='export-failure') { fs.mkdtemp=async()=>{throw new Error('DO_NOT_ECHO_LOCAL_ERROR')}; syncBuiltinESMExports(); }
if(mode==='symlink') {
  const original=fs.mkdtemp;
  fs.mkdtemp=async(...args)=>{const dir=await original(...args);await fs.symlink(${JSON.stringify(sentinel)},join(dir,'proof-receipt.json'));return dir};
  syncBuiltinESMExports();
}
const reply=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
let submits=0;
globalThis.fetch=async(url,init={})=>{
  const headers=new Headers(init.headers);
  if(String(url).includes(f.handoff.completion_capability)||String(init.body).includes(f.handoff.completion_capability))throw new Error('credential_leak');
  if([base+'/result',base+'/exercise',base+'/submit'].includes(url)) {
    if(headers.get('authorization')!=='Bearer '+f.handoff.completion_capability||init.method!=='POST'||JSON.parse(init.body).run_id!==f.handoff.run_id)throw new Error('wrong_capability_request');
  } else if(headers.has('authorization')||init.method!=='GET')throw new Error('credential_forwarded');
  if(init.redirect!=='error'||init.credentials!=='omit')throw new Error('unsafe_request');
  if(url===base+'/result')return reply(mode==='recovery'?f.complete:f.pending);
  if(url===base+'/exercise')return reply({schema:'voidpay.proof-collection.response/v4',ok:true,action:'exercise',run_id:f.handoff.run_id,exercise:f.exercise});
  if(url===base+'/submit'){if(++submits>1)throw new Error('duplicate_submit');return reply(f.complete)}
  if(url===issuer)return reply(f.issuer);
  if(url===provider.index_url)return reply({providers:[provider]});
  if(url===provider.manifest_url)return reply(manifest);
  throw new Error('unexpected_request');
};
`);
  const output = spawnSync(process.execPath, ["--import", setup, cli, "complete"], { cwd,
    input: JSON.stringify(fixture.handoff), encoding: "utf8", timeout: 15000, maxBuffer: 512000 });
  return { fixture, cwd, output, sentinel };
}

describe("packed one-command completion and local artwork", () => {
  it("saves, verifies and creates attachable artwork and receipt without a second user step", async () => {
    const { output, fixture, cwd } = await run();
    expect(output.status, output.stderr).toBe(0);
    const result = JSON.parse(output.stdout);
    expect(result.saved_proof).toBe(true); expect(result.visibility).toBe("private"); expect(result.artifacts.ok).toBe(true);
    expect(result).toMatchObject({ outcome: "PASS", checks_passed: 7, receipt_verified: true });
    expect(Object.keys(result)[0]).toBe("artifacts");
    expect(output.stderr).toContain("Your proof was saved");
    expect(output.stdout + output.stderr).not.toContain(fixture.handoff.completion_capability);
    expect(result.artifacts.artwork_path.startsWith(realpathSync(cwd) + "/voidpay-proof-")).toBe(true);
    const svg = readFileSync(result.artifacts.artwork_path, "utf8");
    expect(svg).toBe(proofArtworkSvg(fixture.record.event_id)); expect(await sha256Hex(new TextEncoder().encode(svg))).toBe(result.artwork.sha256);
    expect(result.artwork.svg).toBeUndefined(); expect(output.stdout.length).toBeLessThan(8000);
    expect(JSON.parse(readFileSync(result.artifacts.receipt_path, "utf8"))).toEqual(fixture.receipt);
    expect(await sha256Hex(canonicalBytes(result.receipt.statement))).toBe(await sha256Hex(canonicalBytes(fixture.receipt.statement)));
    expect(statSync(result.artifacts.artwork_path).mode & 0o777).toBe(0o600);
    expect(statSync(result.artifacts.receipt_path).mode & 0o777).toBe(0o600);
    expect(svg).not.toContain(fixture.handoff.completion_capability);
    expect(readFileSync(result.artifacts.receipt_path, "utf8")).not.toContain(fixture.handoff.completion_capability);
  });
  it("does not create art or receipt before authenticity is verified", async () => {
    const { output, cwd, fixture } = await run("altered-receipt");
    expect(output.status).toBe(1); expect(output.stdout).toBe(""); expect(output.stderr).toContain("receipt_invalid");
    expect(output.stderr).not.toContain(fixture.handoff.completion_capability);
    expect(readdirSync(cwd).filter(name => name.startsWith("voidpay-proof-"))).toEqual([]);
  });
  it("returns saved success with inline SVG when local export is unavailable", async () => {
    const { output } = await run("export-failure");
    expect(output.status).toBe(0); const result = JSON.parse(output.stdout);
    expect(result.saved_proof).toBe(true); expect(result.artifacts).toEqual({ ok: false, artwork_path: null, receipt_path: null, error: "local_export_failed" });
    expect(result.artwork.svg).toContain("<svg"); expect(output.stderr).toContain("do not start another proof");
    expect(output.stdout + output.stderr).not.toContain("DO_NOT_ECHO_LOCAL_ERROR");
  });
  it("refuses a pre-existing output symlink and leaves the target untouched", async () => {
    const { output, sentinel } = await run("symlink");
    expect(output.status).toBe(0); expect(JSON.parse(output.stdout).artifacts.ok).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("do not overwrite");
  });
  it("recovers and exports the same event without repeating its check", async () => {
    const { output, fixture } = await run("recovery");
    expect(output.status, output.stderr).toBe(0); const result = JSON.parse(output.stdout);
    expect(result.already_completed).toBe(true); expect(result.event_id).toBe(fixture.record.event_id);
    expect(output.stderr).toContain("existing proof was recovered");
  });
  it("retains an ordinary importable Node-free automatic subpath", () => {
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", "import {completeAutomaticProof,AUTOMATIC_TASK} from '@voidly/session/proofs-auto'; console.log(typeof completeAutomaticProof,AUTOMATIC_TASK.id)"], { cwd: consumer, encoding: "utf8", timeout: 10000 });
    expect(stdout.trim()).toBe("function sessions-auto-save-01");
    const code = readFileSync(join(consumer, "node_modules/@voidly/session/dist/proofsAuto.mjs"), "utf8");
    expect(code).not.toMatch(/node:fs|process\.env|node:child_process|readFile|writeFile|eval\(/);
  });
  it.each([[], ["complete", "DO_NOT_ECHO"], ["complete", "--token", "DO_NOT_ECHO"]])("refuses argv capabilities: %s", (...args: string[]) => {
    const output = spawnSync(process.execPath, [cli, ...args], { cwd: consumer, input: "{}", encoding: "utf8", timeout: 10000 });
    expect(output.status).toBe(1); expect(output.stdout).toBe(""); expect(output.stderr).not.toContain("DO_NOT_ECHO");
  });
  it.each(["{}", '{"token":"DO_NOT_ECHO"}', "x".repeat(1025)])("does not reflect invalid handoff or create files", input => {
    const cwd = mkdtempSync(join(consumer, "invalid-"));
    const output = spawnSync(process.execPath, [cli, "complete"], { cwd, input, encoding: "utf8", timeout: 10000 });
    expect(output.status).toBe(1); expect(output.stdout).toBe(""); expect(output.stderr).not.toContain("DO_NOT_ECHO");
    expect(readdirSync(cwd)).toEqual([]);
  });
});
