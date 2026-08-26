
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STALE_LOCK_MS = 5 * 60_000;
const WAIT_DEADLINE_MS = 5 * 60_000;

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStale(pkgDir: string): boolean {
  const outputs = ["index.mjs", "index.d.ts", "breakEven.mjs", "breakEven.d.ts"].map((f) =>
    join(pkgDir, "dist", f),
  );
  if (!outputs.every((p) => existsSync(p))) return true;
  const built = Math.min(...outputs.map((p) => statSync(p).mtimeMs));
  const source = Math.max(
    newestMtime(join(pkgDir, "src")),
    newestMtime(join(pkgDir, "scripts")),
    statSync(join(pkgDir, "package.json")).mtimeMs,
  );
  return built < source;
}

export function ensureBuilt(pkgDir: string): string {
  const dir = resolve(pkgDir);
  const lock = join(tmpdir(), `voidly-session-build-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}`);
  const deadline = Date.now() + WAIT_DEADLINE_MS;

  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_LOCK_MS || Date.now() > deadline) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      pause(50);
    }
  }

  try {
    if (isStale(dir)) {
      execFileSync(process.execPath, [join(dir, "scripts", "build.mjs")], {
        cwd: dir,
        stdio: ["ignore", "ignore", "inherit"],
      });
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }

  return join(dir, "dist", "index.mjs");
}
