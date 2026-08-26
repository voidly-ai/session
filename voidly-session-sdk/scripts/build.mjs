#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toolBin } from "./_toolBin.mjs";

const PKG_DIR = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(PKG_DIR, "dist");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function bundle(entrySrc, outName) {
  execFileSync(
    toolBin("esbuild", PKG_DIR),
    [
      join(PKG_DIR, entrySrc),
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--target=es2021",
      "--minify-whitespace",
      "--minify-syntax",
      "--legal-comments=none",
      "--external:tweetnacl",
      "--external:tweetnacl-util",
      `--outfile=${join(DIST, outName)}`,
      "--log-level=warning",
    ],
    { cwd: PKG_DIR, stdio: ["ignore", "inherit", "inherit"] },
  );
}
bundle("src/index.ts", "index.mjs");
bundle("src/breakEven.ts", "breakEven.mjs");

execFileSync(process.execPath, [join(PKG_DIR, "scripts/build-types.mjs")], {
  cwd: PKG_DIR,
  stdio: ["ignore", "inherit", "inherit"],
});

function fixTweetnaclUtilNamedImports(outName) {
  const file = join(DIST, outName);
  let out = readFileSync(file, "utf8");
  let n = 0;
  out = out.replace(/import\{([^}]*)\}from"tweetnacl-util"/g, (_m, names) => {
    const binding = `__naclUtil${n++}`;
    const spec = names
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"))
      .join(", ");
    return `import ${binding} from"tweetnacl-util";const{${spec}}=${binding}`;
  });
  if (n > 0) writeFileSync(file, out);
  if (/import\{[^}]*\}from"tweetnacl-util"/.test(readFileSync(file, "utf8"))) {
    throw new Error(`build: CJS interop did not apply - a named import survives in ${outName}`);
  }
  console.log(`cjs-interop - rewrote ${n} named import(s) of tweetnacl-util in ${outName}`);
}
fixTweetnaclUtilNamedImports("index.mjs");
fixTweetnaclUtilNamedImports("breakEven.mjs");

function assertNativeNodeImport(outName, minExports) {
  execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(join(DIST, outName))}).then(m=>{const n=Object.keys(m).length;if(n<${minExports})throw new Error("too few exports: "+n);console.log("native-node import - ${outName} OK, "+n+" exports")}).catch(e=>{console.error("NATIVE NODE IMPORT FAILED (${outName}): "+e.message);process.exit(1)})`],
    { cwd: PKG_DIR, stdio: ["ignore", "inherit", "inherit"] },
  );
}
assertNativeNodeImport("index.mjs", 50);
assertNativeNodeImport("breakEven.mjs", 8);

const js = statSync(join(DIST, "index.mjs")).size;
const dts = statSync(join(DIST, "index.d.ts")).size;
const bejs = statSync(join(DIST, "breakEven.mjs")).size;
const bedts = statSync(join(DIST, "breakEven.d.ts")).size;
console.log(`dist/index.mjs — ${(js / 1024).toFixed(1)} kB · dist/index.d.ts — ${(dts / 1024).toFixed(1)} kB`);
console.log(`dist/breakEven.mjs — ${(bejs / 1024).toFixed(1)} kB · dist/breakEven.d.ts — ${(bedts / 1024).toFixed(1)} kB`);
