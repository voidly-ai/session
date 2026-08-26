
import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runResolved, runTsc, toolPath } from "./_tsc";

const PKG_DIR = resolve(__dirname, "..");
const TSC_TIMEOUT_MS = 120_000;

function fixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "voidly-tsc-harness-"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2021",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2021"],
        types: [],
        strict: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    }),
  );
  writeFileSync(join(dir, "probe.ts"), source);
  return dir;
}

describe("the tsc harness distinguishes a verdict from a broken harness", () => {

  it("A TOOL THAT IS ON NO SEARCHED PATH IS NAMED, WITH EVERY PATH TRIED", () => {
    let thrown: unknown;
    try {
      toolPath("tsc-this-tool-does-not-exist");
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "resolving a nonexistent tool returned instead of throwing").toBeInstanceOf(Error);
    const msg = String((thrown as Error).message);
    expect(msg).toContain("tsc-this-tool-does-not-exist");
    expect(msg).toContain("Looked in:");
    expect(msg).toContain(join(PKG_DIR, "node_modules", ".bin", "tsc-this-tool-does-not-exist"));
  });

  it("A SPAWN THAT NEVER STARTS IS AN ERROR, NOT A `{ ok: false }`", () => {
    const dir = fixture("export const x: number = 1;\n");
    const absent = join(PKG_DIR, "node_modules", ".bin", "tsc-HOISTED-AWAY");
    let thrown: unknown;
    let returned: unknown;
    try {
      returned = runResolved(absent, "tsc", dir);
    } catch (e) {
      thrown = e;
    }
    expect(
      returned,
      `runResolved RETURNED ${JSON.stringify(returned)} for a compiler that does not exist — ` +
        "that value is what the negative controls read as `tsc objected`",
    ).toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    const msg = String((thrown as Error).message);
    expect(msg).toContain("DID NOT RUN");
    expect(msg).toContain("tsc");
    expect(msg).toContain(absent);
    expect(msg).toContain("ENOENT");
  });

  it("A NON-ZERO EXIT WITH NO DIAGNOSTICS IS AN ERROR, NOT A `{ ok: false }`", () => {
    const dir = fixture("export const x: number = 1;\n");
    const stubDir = mkdtempSync(join(tmpdir(), "voidly-tsc-stub-"));
    const stub = join(stubDir, "silent-tsc");
    writeFileSync(stub, "#!/bin/sh\nexit 2\n");
    chmodSync(stub, 0o755);

    let thrown: unknown;
    let returned: unknown;
    try {
      returned = runResolved(stub, "tsc", dir);
    } catch (e) {
      thrown = e;
    }
    expect(returned, "a silent non-zero exit was returned as a verdict").toBeUndefined();
    expect(thrown).toBeInstanceOf(Error);
    const msg = String((thrown as Error).message);
    expect(msg).toContain("NO DIAGNOSTICS");
    expect(msg).toContain("exited 2");
    expect(msg).toContain(stub);
  }, TSC_TIMEOUT_MS);

  it("THE REAL tsc RESOLVES, AND A CLEAN PROJECT COMPILES", () => {
    const bin = toolPath("tsc");
    expect(bin).toMatch(/[\\/]tsc$/);
    const r = runTsc(fixture("export const x: number = 1;\n"));
    expect(r.ok, `a valid project did not compile:\n${r.out}`).toBe(true);
  }, TSC_TIMEOUT_MS);

  it("THE REAL tsc REPORTS A REAL FAILURE, WITH DIAGNOSTICS THAT NAME IT", () => {
    const r = runTsc(fixture("export const x: number = thisIdentifierIsNotDefined;\n"));
    expect(r.ok, "tsc accepted an undefined identifier under `strict`").toBe(false);
    expect(r.out).toContain("thisIdentifierIsNotDefined");
    expect(r.out.trim().length).toBeGreaterThan(0);
  }, TSC_TIMEOUT_MS);
});
