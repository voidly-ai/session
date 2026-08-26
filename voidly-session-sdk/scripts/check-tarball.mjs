#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const FORBIDDEN_IDENTIFIERS = [
  "redeemGrant", "createSerializedSessionJournalStore", "createMemorySessionJournalStore",
  "createMemorySessionJournalBackend", "createD1SessionJournalBackend",
  "SERIALIZED_SESSION_JOURNAL", "freezeJournalRow", "isSessionJournalStore",
  "isSessionJournalPrunable", "REDEEMED_ROW_KEYS", "EXPIRED_ROW_KEYS",
  "deliverResult", "recoverTask", "reattestRedemption", "readOnlyJournal", "READ_ONLY_JOURNAL",
  "buildRedemptionAttestation",
  "VERIFIED_GRANT", "isVerifiedGrant",
  "openCapsule",
  "evaluateSettlement", "lookupSettlementAdapter", "createX402SessionAdapter",
  "SESSION_SETTLEMENT_ADAPTERS",
  "verifySessionProviderProof", "retireDeadSessionProofSpends",
  "handleSessionRedeem", "serveSessionHire",
  "classifySession", "dispositionOf",
  "buildManifest",
  "authenticateSettlementHint", "validateSettlementHint", "hirerKeyFromStoredHire",
  "hireRefusalFor", "HIRE_REFUSAL_REASON", "hasRelayHistory", "PROVIDER_ROW_SCHEMA",
  "sweepCandidates", "mintProviderProofHeader", "mintReattestProofHeader",
  "READ_DOOR_ALLOW",
];

const FORBIDDEN_PATHS = [
  /(^|\/)\.env/i, /(^|\/)\.dev\.vars/i, /(^|\/)wrangler\.(toml|jsonc?)$/i,
  /(^|\/)tests?\//, /(^|\/)__tests__\//, /\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/,
  /(^|\/)scripts\//, /(^|\/)\.git/, /(^|\/)node_modules\//,
  /\.pem$/, /\.key$/, /(^|\/)id_[a-z0-9]+$/,
  /\.map$/,
  /(^|\/)NOTES-internal\.md$/i, /(^|\/)WORK-QUEUE\.md$/i,
];

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "openai-style secret key"],
  [/\bcfk_[A-Za-z0-9_-]{16,}/, "cloudflare token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\b(private_?key|secret|seed|mnemonic|passphrase|signing_?key)\b\s*[:=]\s*["'][^"']{16,}["']/i,
   "literal bound to a secret-shaped name"],
];

const NARRATIVE_PATTERNS = [
  [/\bC[0-9][0-9]\b/, "a C-number incident reference"],
  [/\banvil\b/i, "the fork harness"],
  [/\bmutation\b/i, "mutation-testing narrative"],
  [/worker\/src\//, "a worker source path"],
];

const TEXT_EXT = /\.(m?[jt]sx?|json|md|txt|map|d\.ts)$/;

function pack(dir) {
  const out = mkdtempSync(join(tmpdir(), "voidly-gate-"));
  const json = execFileSync("npm", ["pack", "--json", "--pack-destination", out], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  return join(out, JSON.parse(json)[0].filename);
}

function extract(tgz) {
  const out = mkdtempSync(join(tmpdir(), "voidly-gate-x-"));
  execFileSync("tar", ["-xzf", tgz, "-C", out]);
  return join(out, "package");
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, acc);
    else acc.push({ abs, rel: abs.slice(base.length + 1).split(sep).join("/") });
  }
  return acc;
}

function declRe(id) {
  return new RegExp(
    `(^|[\\n;}])\\s*(export\\s+)?(declare\\s+)?(async\\s+)?(function|class|const|let|var|interface|type|enum)\\s+${id}\\b` +
      `|\\bexport\\s*\\{[^}]*\\b${id}\\b[^}]*\\}` +
      `|\\b${id}\\s*(:|as)\\s*\\w`,
    "m",
  );
}

const arg = process.argv[2];
const tgz = arg ? resolve(arg) : pack(resolve(process.cwd()));
const root = extract(tgz);
const files = walk(root);
const findings = [];

{
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  } catch {
    manifest = {};
  }
  const declared = manifest.files;
  const packed = files.map((f) => f.rel);
  for (const decl of Array.isArray(declared) ? declared : []) {
    const name = decl.replace(/^\.?\//, "").replace(/\/$/, "");
    const present = packed.some((p) => p === name || p.startsWith(name + "/"));
    if (!present) {
      findings.push(
        `DECLARED BUT ABSENT  package.json "files" names ${JSON.stringify(decl)}, ` +
          `and the tarball has no such entry. npm omits it silently — this is the only ` +
          `check that looks. Either create the file or stop declaring it.`,
      );
    }
  }

  const targets = new Set();
  const collect = (node) => {
    if (typeof node === "string") {
      if (node.startsWith("./")) targets.add(node.slice(2));
      return;
    }
    if (node && typeof node === "object") for (const v of Object.values(node)) collect(v);
    if (Array.isArray(node)) for (const v of node) collect(v);
  };
  collect(manifest.exports);
  for (const t of [...targets].sort()) {
    if (t === "package.json") continue;
    if (!packed.includes(t)) {
      findings.push(
        `EXPORTS TARGET ABSENT  package.json "exports" resolves to ${JSON.stringify("./" + t)}, ` +
          `and the tarball has no such file. Every import of that subpath is ` +
          `ERR_MODULE_NOT_FOUND, and an "exports" map cannot be widened on a version ` +
          `already published. Either emit the file or remove the subpath.`,
      );
    }
  }
}

for (const { abs, rel } of files) {
  for (const re of FORBIDDEN_PATHS) {
    if (re.test(rel)) findings.push(`FORBIDDEN PATH  ${rel}  (matched ${re})`);
  }
  if (!TEXT_EXT.test(rel)) continue;
  const src = readFileSync(abs, "utf8");
  for (const id of FORBIDDEN_IDENTIFIERS) {
    if (declRe(id).test(src)) findings.push(`FORBIDDEN SYMBOL  ${id}  declared/exported in ${rel}`);
  }
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(src)) findings.push(`POSSIBLE SECRET  ${what}  in ${rel}`);
  }
  if (/^dist\//.test(rel) || /^README(\.|$)/i.test(rel)) {
    for (const [re, what] of NARRATIVE_PATTERNS) {
      const m = src.match(re);
      if (m) findings.push(`NARRATIVE IN dist  ${what} (\`${m[0]}\`) in ${rel}`);
    }
  }
}

const CANARY = ["privateHire", "bindAuthorizationToGrant", "settlementBindingReference"];
const distFiles = files.filter((f) => /^dist\/.*\.m?js$/.test(f.rel));
const distText = distFiles.map((f) => readFileSync(f.abs, "utf8")).join("\n");
const unseen = CANARY.filter((id) => !declRe(id).test(distText));
if (unseen.length) {
  findings.push(
    `GATE IS BLIND — required symbol(s) ${unseen.join(", ")} not found as declarations in dist/. ` +
      `The bundle is minified/mangled, so absence of a forbidden symbol proves nothing. ` +
      `Publish an unmangled dist (--minify-whitespace --minify-syntax, NOT --minify-identifiers), ` +
      `or run this gate against the pre-mangle artifact.`,
  );
}

for (const { abs, rel } of distFiles) {
  const dts = files.find((f) => f.rel === rel.replace(/\.m?js$/, ".d.ts"));
  if (!dts) continue;
  const declaredValues = [
    ...readFileSync(dts.abs, "utf8").matchAll(
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm,
    ),
  ].map((m) => m[1]);
  if (!declaredValues.length) continue;
  const body = readFileSync(abs, "utf8");
  if (!declaredValues.some((id) => declRe(id).test(body))) {
    findings.push(
      `GATE IS BLIND IN ${rel} — none of the ${declaredValues.length} value(s) declared by ` +
        `${dts.rel} can be found as a declaration or export binding in it. The forbidden-symbol, ` +
        `secret and narrative scans over this file therefore prove nothing. It is a stub, a ` +
        `truncated write, or a mangled emit.`,
    );
  }
}

const scanned = files.filter((f) => TEXT_EXT.test(f.rel)).length;
if (scanned === 0) findings.push("SCAN READ ZERO TEXT FILES — the gate is not testing anything");
if (files.length === 0) findings.push("THE TARBALL IS EMPTY — nothing was scanned");
if (!files.some((f) => f.rel === "dist/index.mjs")) {
  findings.push(
    "NO dist/index.mjs IN TARBALL — publishing raw src would ship the source instead of the bundle",
  );
}
if (!files.some((f) => f.rel === "dist/index.d.ts")) {
  findings.push("NO dist/index.d.ts IN TARBALL — a typed package with no types");
}
for (const [probe, text] of [
  ["redeemGrant", "\nexport declare function redeemGrant(x: number): void;\n"],
  ["classifySession", "\nfunction classifySession(a){return a}\n"],
  ["READ_ONLY_JOURNAL", "\nexport { READ_ONLY_JOURNAL };\n"],
]) {
  if (!declRe(probe).test(text)) {
    findings.push(`GATE IS BLIND — the declaration matcher failed on a planted \`${probe}\``);
  }
}

console.log(`tarball ${tgz}`);
console.log(
  `  ${files.length} files, ${scanned} scanned as text, ${(statSync(tgz).size / 1024).toFixed(1)} kB packed`,
);
if (findings.length) {
  console.error(`\nPUBLISH BLOCKED — ${findings.length} finding(s):`);
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log("  clean — no forbidden symbol, path, secret literal or narrative in the tarball");
