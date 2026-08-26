#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INPUT_DIRS = ["src", "scripts", "../session-protocol/src"];
const INPUT_FILES = ["package.json", "README.md", "LICENSE", ".npmignore"];

function git(args, cwd = PKG_DIR) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

function newestMtime(paths) {
  let newest = 0;
  for (const p of paths) newest = Math.max(newest, statSync(p).mtimeMs);
  return newest;
}

const findings = [];
const note = (s) => findings.push(s);

let root;
try {
  root = git(["rev-parse", "--show-toplevel"]);
} catch {
  console.error("PUBLISH BLOCKED — 1 finding(s):");
  console.error(
    "  NOT A GIT CHECKOUT. This directory has no history, so nothing published " +
      "from it can be attributed to a commit. If this is a generated de-narrated " +
      "copy, commit it to the public repository first and publish from THAT " +
      "checkout — the point of the public repo is that it is the origin, not a " +
      "staging area.",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

const inputs = [];
for (const d of INPUT_DIRS) {
  const abs = resolve(PKG_DIR, d);
  if (existsSync(abs)) inputs.push(...walk(abs));
}
for (const f of INPUT_FILES) {
  const abs = join(PKG_DIR, f);
  if (existsSync(abs)) inputs.push(abs);
}
const relToRoot = inputs.map((p) => relative(root, p));

if (relToRoot.length === 0) {
  note("THE INPUT SET IS EMPTY — this gate is not testing anything");
}

let untracked = [];
try {
  const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...relToRoot], {
    cwd: root,
    encoding: "utf8",
  });
  untracked = out.split("\n").filter(Boolean);
} catch (e) {
  note(`git could not list untracked files: ${String(e)}`);
}
if (untracked.length) {
  note(
    `${untracked.length} PUBLISH INPUT(S) ARE UNTRACKED — no commit contains them, so the ` +
      `published bytes could not be reproduced from any revision:\n      ` +
      untracked.slice(0, 20).join("\n      "),
  );
}

let dirty = [];
try {
  const out = execFileSync("git", ["status", "--porcelain", "--", ...relToRoot], {
    cwd: root,
    encoding: "utf8",
  });
  dirty = out.split("\n").filter(Boolean).filter((l) => !l.startsWith("??"));
} catch (e) {
  note(`git could not read status: ${String(e)}`);
}
if (dirty.length) {
  note(
    `${dirty.length} PUBLISH INPUT(S) DIFFER FROM HEAD — publishing now ships bytes that ` +
      `exist in no commit. This is the agent-sdk shape: a public repository whose HEAD ` +
      `does not build what npm serves.\n      ` +
      dirty.slice(0, 20).map((l) => l.trim()).join("\n      "),
  );
}

let head = "";
try {
  head = git(["rev-parse", "HEAD"]);
  const contains = execFileSync("git", ["branch", "-r", "--contains", head], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!contains) {
    note(
      `HEAD ${head.slice(0, 12)} IS ON NO REMOTE BRANCH. Nothing published from it can be ` +
        `read by anyone. Push the branch before publishing.`,
    );
  }
} catch (e) {
  note(`could not determine whether HEAD is pushed: ${String(e)}`);
}

const DIST = join(PKG_DIR, "dist");
const sourceNewest = newestMtime(inputs);
for (const stem of ["index", "breakEven"]) {
  const entry = join(DIST, `${stem}.mjs`);
  const types = join(DIST, `${stem}.d.ts`);
  if (!existsSync(entry) || !existsSync(types)) {
    note(`dist/${stem}.mjs + dist/${stem}.d.ts — THE PAIR IS ABSENT OR INCOMPLETE — run \`npm run build\` before publishing`);
  } else {
    const built = Math.min(statSync(entry).mtimeMs, statSync(types).mtimeMs);
    if (built < sourceNewest) {
      note(
        `dist/${stem}.{mjs,d.ts} IS OLDER THAN ITS SOURCES. The tarball would carry a bundle built from ` +
          "earlier bytes than the commit it is attributed to — an attestation that is " +
          "true about the wrong artifact. Run `npm run build`.",
      );
    }
  }
}

const prepub = pkg.scripts?.prepublishOnly ?? "";
for (const required of ["run build", "run gate"]) {
  if (!prepub.includes(required)) {
    note(`prepublishOnly NO LONGER RUNS \`${required}\` — the publish path has been unwired`);
  }
}
if (!prepub.includes("gate:origin")) {
  note("prepublishOnly NO LONGER RUNS `gate:origin` — this gate would not run on a publish");
}
const CERTIFIES = ["gate:narrative", "gate:seal", "check-assembly-seal"];
if (!CERTIFIES.some((k) => prepub.includes(k))) {
  note(
    "prepublishOnly NO LONGER RUNS A NARRATIVE-OR-SEAL CERTIFICATION STEP. The tarball's " +
      "SYMBOL gate and its NARRATIVE gate are different scans and the narrative one is the " +
      "stricter: it is what catches an internal document named in `description`, or the " +
      "deployment state named in a runtime error string. In the assembled public copy that " +
      "step is the ASSEMBLY SEAL, which certifies the published tree is byte-for-byte the " +
      "tree the private scan read. One of the two must run; today neither does.",
  );
}

if (pkg.private !== true) {
  const hasSubpath = Object.keys(pkg.exports ?? {}).some((k) => /break-?even/i.test(k));
  if (!hasSubpath) {
    note(
      "`private` IS LIFTED AND `exports` HAS NO BREAK-EVEN SUBPATH. `src/breakEven.ts` owns the " +
        "relay floor and reaches the published bundle nowhere: `dist/index.mjs` contains zero " +
        "breakEven bytes and `files` ships no `src`. Its only existing consumer imports it by a " +
        "relative path that no installed package can resolve, so a third party building a relaying " +
        "provider must re-spell the money rule. Add an \"./break-even\" entry point BEFORE the " +
        "first publish — `exports` cannot be widened retroactively for versions already on the " +
        "registry.",
    );
  }

  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!repo) {
    note(
      "`private` IS LIFTED AND `repository` IS ABSENT. A published package that names no " +
        "origin cannot carry npm provenance at all — GitHub withdrew provenance for private " +
        "sources in 2023 and there is no paid tier that restores it. Name the public repo.",
    );
  } else {
    let originUrl = "";
    try {
      originUrl = git(["remote", "get-url", "origin"], root);
    } catch {
      note("`private` IS LIFTED AND THIS CHECKOUT HAS NO `origin` REMOTE — nothing to attribute to");
    }
    const slug = (u) =>
      (u || "")
        .replace(/^git\+/, "")
        .replace(/\.git$/, "")
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/^ssh:\/\/git@/, "https://")
        .toLowerCase();
    if (originUrl && slug(repo) !== slug(originUrl)) {
      note(
        `ORIGIN DRIFT — package.json says the source lives at\n        ${slug(repo)}\n` +
          `      but this checkout pushes to\n        ${slug(originUrl)}\n` +
          `      Publishing here would advertise a repository that does not contain these ` +
          `bytes. Publish from a checkout of the repository you name.`,
      );
    }
  }

  if (!existsSync(join(PKG_DIR, "LICENSE"))) {
    note(
      "`private` IS LIFTED AND THERE IS NO LICENSE FILE. `files` already lists \"LICENSE\", " +
        "and npm omits a listed file that does not exist SILENTLY — so the tarball would " +
        "promise a licence in its manifest and ship none. A published package with no " +
        "licence grants no right to use it.",
    );
  }
  if (!pkg.license || pkg.license === "UNLICENSED") {
    note(
      `\`private\` IS LIFTED AND \`license\` IS ${JSON.stringify(pkg.license ?? null)}. ` +
        "Choose the licence before the first publish, not after: the terms attached to a " +
        "version that has been downloaded cannot be withdrawn from the copies people hold.",
    );
  }
}

const report = {
  package: pkg.name,
  version: pkg.version,
  private: pkg.private === true,
  head,
  inputsChecked: relToRoot.length,
  findings,
};
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(findings.length ? 1 : 0);
}

console.log(`origin gate — ${pkg.name}@${pkg.version} at ${head.slice(0, 12)}`);
console.log(`  ${relToRoot.length} publish input(s) checked, private=${pkg.private === true}`);
if (findings.length) {
  console.error(`\nPUBLISH BLOCKED — ${findings.length} finding(s):`);
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log("  attributable — every publish input is tracked, clean, pushed, and built from");
