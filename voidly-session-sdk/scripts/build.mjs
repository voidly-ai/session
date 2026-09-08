#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { toolBin } from "./_toolBin.mjs";

const PKG_DIR = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(PKG_DIR, "dist");
let boundary;
let guard;
if (process.env.VOIDLY_BOUNDARY_METADATA_DIR || process.env.VOIDLY_BOUNDARY_CAPTURE_MODULE) {
  try {
    const external = process.env.VOIDLY_BOUNDARY_CAPTURE_MODULE;
    if (!process.env.VOIDLY_BOUNDARY_METADATA_DIR) throw new Error("metadata required");
    if (external && (!isAbsolute(external) || resolve(external) !== external || realpathSync(external) !== external
      || external.startsWith(resolve(PKG_DIR, "..") + sep) || !statSync(external).isFile())) {
      throw new Error("external capture module refused");
    }
    const hooks = await import(external ? pathToFileURL(external).href : "../../tools/private-source-boundary/capture.mjs");
    guard = hooks.guarded;
    boundary = guard(() => hooks.beginBuild(PKG_DIR, process.env.VOIDLY_BOUNDARY_METADATA_DIR, toolBin("esbuild", PKG_DIR)));
  } catch {
    console.error("Private source boundary setup refused.");
    process.exit(1);
  }
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

function bundle(entrySrc, outName) {
  const compile = () => execFileSync(
    boundary ? boundary.esbuildExecutable() : toolBin("esbuild", PKG_DIR),
    [
      join(PKG_DIR, entrySrc),
      "--bundle",
      "--format=esm",
      entrySrc === "src/index.ts" ? "--platform=browser" : "--platform=neutral",
      "--target=es2021",
      "--minify-whitespace",
      "--minify-syntax",
      "--legal-comments=none",
      "--external:tweetnacl",
      "--external:tweetnacl-util",
      ...(entrySrc === "src/proofsCli.ts" ? ["--external:node:fs", "--external:node:fs/promises", "--external:node:path"] : []),
      ...(entrySrc === "src/nodeFiles.ts" ? ["--external:node:fs", "--external:node:path"] : []),
      `--outfile=${join(DIST, outName)}`,
      ...(boundary ? [`--metafile=${boundary.metafilePath(outName.slice(0, -4))}`] : []),
      ...(boundary ? [`--tsconfig=${boundary.tsconfigPath()}`] : []),
      "--log-level=warning",
    ],
    { cwd: PKG_DIR, stdio: boundary ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"] },
  );
  if (boundary) guard(compile);
  else compile();
  if (boundary) guard(() => boundary.recordRuntime(outName.slice(0, -4)));
}
bundle("src/index.ts", "index.mjs");
bundle("src/breakEven.ts", "breakEven.mjs");
bundle("src/proofs.ts", "proofs.mjs");
bundle("src/proofsAuto.ts", "proofsAuto.mjs");
bundle("src/proofsCli.ts", "proofsCli.mjs");
bundle("src/nodeFiles.ts", "nodeFiles.mjs");

const buildDeclarations = () => execFileSync(process.execPath, [join(PKG_DIR, "scripts/build-types.mjs")], {
  cwd: PKG_DIR,
  stdio: boundary ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
});
if (boundary) guard(buildDeclarations);
else buildDeclarations();

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
fixTweetnaclUtilNamedImports("proofs.mjs");
fixTweetnaclUtilNamedImports("proofsAuto.mjs");
fixTweetnaclUtilNamedImports("proofsCli.mjs");
fixTweetnaclUtilNamedImports("nodeFiles.mjs");

for (const name of ["proofs.mjs", "proofsAuto.mjs", "proofsCli.mjs", "nodeFiles.mjs"]) {
  const file = join(DIST, name);
  const format = () => execFileSync(boundary ? boundary.esbuildExecutable() : toolBin("esbuild", PKG_DIR), [
    "--format=esm", "--target=es2021", "--legal-comments=none", "--log-level=warning",
  ], { input: readFileSync(file, "utf8"), encoding: "utf8", cwd: PKG_DIR });
  const readable = boundary ? guard(format) : format();
  writeFileSync(file, readable);
}

function assertNativeNodeImport(outName, minExports) {
  execFileSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(join(DIST, outName))}).then(m=>{const n=Object.keys(m).length;if(n<${minExports})throw new Error("too few exports: "+n);console.log("native-node import - ${outName} OK, "+n+" exports")}).catch(e=>{console.error("NATIVE NODE IMPORT FAILED (${outName}): "+e.message);process.exit(1)})`],
    { cwd: PKG_DIR, stdio: ["ignore", "inherit", "inherit"] },
  );
}
assertNativeNodeImport("index.mjs", 50);
assertNativeNodeImport("breakEven.mjs", 8);
assertNativeNodeImport("proofs.mjs", 10);
assertNativeNodeImport("proofsAuto.mjs", 5);
assertNativeNodeImport("nodeFiles.mjs", 3);
if (boundary) guard(() => boundary.finishBuild());

const js = statSync(join(DIST, "index.mjs")).size;
const dts = statSync(join(DIST, "index.d.ts")).size;
const bejs = statSync(join(DIST, "breakEven.mjs")).size;
const bedts = statSync(join(DIST, "breakEven.d.ts")).size;
console.log(`dist/index.mjs — ${(js / 1024).toFixed(1)} kB · dist/index.d.ts — ${(dts / 1024).toFixed(1)} kB`);
console.log(`dist/breakEven.mjs — ${(bejs / 1024).toFixed(1)} kB · dist/breakEven.d.ts — ${(bedts / 1024).toFixed(1)} kB`);
