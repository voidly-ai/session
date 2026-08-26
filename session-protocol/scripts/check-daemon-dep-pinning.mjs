#!/usr/bin/env node

import { existsSync, realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const ROOT =
  rootFlag !== -1 && argv[rootFlag + 1]
    ? resolve(argv[rootFlag + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SYMLINK_ONLY_PACKAGES = ["session-protocol", "voidly-session-sdk"];
const PIN_SOURCE = join("worker", "package-lock.json");
const PINNED_TREE = join("worker", "node_modules");

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

const rel = (p) => relative(ROOT, p) || ".";
const underPinnedTree = (p) => {
  const base = realpathSync(join(ROOT, PINNED_TREE));
  return p === base || p.startsWith(base + sep);
};

const lockPath = join(ROOT, PIN_SOURCE);
let lock = null;
if (!existsSync(lockPath)) {
  fail(`${PIN_SOURCE} is missing — nothing pins the dependencies the daemon bundles.`);
} else {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
  let isRepo = true;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT, stdio: "pipe" });
  } catch {
    isRepo = false;
    notes.push(`${rel(ROOT)} is not a git work tree — skipped the tracked-by-git assertion.`);
  }
  if (isRepo) {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", PIN_SOURCE], { cwd: ROOT, stdio: "pipe" });
    } catch {
      fail(
        `${PIN_SOURCE} exists but is NOT tracked by git. It is the only pin set for ` +
          `${SYMLINK_ONLY_PACKAGES.join(" and ")}; untracked, a fresh clone resolves them floating.`
      );
    }
  }
}

if (!existsSync(join(ROOT, PINNED_TREE))) {
  fail(
    `${PINNED_TREE} is not installed, so dependency resolution cannot be verified. ` +
      `Run \`npm ci\` in worker/ first. (Refusing to report green on an unverified tree.)`
  );
}

let satisfies = null;
if (lock && existsSync(join(ROOT, PINNED_TREE))) {
  try {
    satisfies = createRequire(join(ROOT, PINNED_TREE, "x.js"))("semver").satisfies;
  } catch {
    fail("Could not load `semver` from the pinned tree; cannot verify declared ranges.");
  }
}

for (const pkg of SYMLINK_ONLY_PACKAGES) {
  const manifestPath = join(ROOT, pkg, "package.json");
  if (!existsSync(manifestPath)) {
    fail(`${pkg}/package.json is missing.`);
    continue;
  }
  const deps = JSON.parse(readFileSync(manifestPath, "utf8")).dependencies || {};
  if (Object.keys(deps).length === 0) notes.push(`${pkg}: declares no runtime dependencies.`);

  const req = createRequire(join(ROOT, pkg, "src", "__resolve__.js"));

  for (const [dep, range] of Object.entries(deps)) {
    let real;
    try {
      real = realpathSync(req.resolve(`${dep}/package.json`));
    } catch {
      fail(`${pkg}: dependency \`${dep}\` does not resolve at all — the daemon cannot bundle it.`);
      continue;
    }
    if (!underPinnedTree(real)) {
      fail(
        `${pkg}: \`${dep}\` resolves to ${rel(real)}, OUTSIDE the pinned tree ${PINNED_TREE}. ` +
          `That copy is not covered by ${PIN_SOURCE} — most likely a stray \`npm install\` ` +
          `inside ${pkg}/ replaced the symlink into worker/node_modules with a floating install.`
      );
      continue;
    }
    const version = JSON.parse(readFileSync(real, "utf8")).version;
    const pinned = lock?.packages?.[`node_modules/${dep}`];
    if (!pinned) {
      fail(`${pkg}: \`${dep}\` resolves inside the pinned tree but has no entry in ${PIN_SOURCE}.`);
      continue;
    }
    if (pinned.version !== version) {
      fail(
        `${pkg}: \`${dep}\` on disk is ${version} but ${PIN_SOURCE} pins ${pinned.version} — ` +
          `the installed tree has drifted from the lockfile.`
      );
      continue;
    }
    if (satisfies && !satisfies(version, range)) {
      fail(
        `${pkg}: declares \`${dep}\`: "${range}" but the pinned version actually bundled is ` +
          `${version}. The manifest describes a dependency the daemon does not use.`
      );
      continue;
    }
    notes.push(`${pkg}: ${dep}@${version} <- ${PIN_SOURCE} (declared "${range}")`);
  }
}

const label = "daemon dependency pinning";
if (failures.length) {
  console.error(`FAIL: ${label}\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\n${failures.length} problem(s). The session-provider daemon bundles ` +
      `${SYMLINK_ONLY_PACKAGES.join(" and ")} from source at every boot; anything above means ` +
      `part of that bundle is not covered by a committed lockfile.`
  );
  process.exit(1);
}
console.log(`OK: ${label}`);
for (const n of notes) console.log(`  - ${n}`);
