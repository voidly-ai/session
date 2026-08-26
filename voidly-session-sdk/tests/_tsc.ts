
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { toolBin } from "../scripts/_toolBin.mjs";

const PKG_DIR = resolve(__dirname, "..");

const cache = new Map<string, string>();

export function toolPath(binName = "tsc"): string {
  const hit = cache.get(binName);
  if (hit) return hit;
  const p = toolBin(binName, PKG_DIR);
  cache.set(binName, p);
  return p;
}

export interface TscRun {
  readonly ok: boolean;
  readonly out: string;
}

export function runTsc(dir: string, binName = "tsc"): TscRun {
  return runResolved(toolPath(binName), binName, dir);
}

export function runResolved(bin: string, binName: string, dir: string): TscRun {
  try {
    execFileSync(bin, ["-p", join(dir, "tsconfig.json")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: "" };
  } catch (e) {
    const err = e as {
      status?: number | null;
      signal?: string | null;
      code?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;

    if (typeof err.status !== "number") {
      throw new Error(
        `${binName} DID NOT RUN — this is a broken harness, not a finding about the artifact.\n` +
          `  tool:     ${binName}\n` +
          `  resolved: ${bin}\n` +
          `  spawn:    ${err.code ?? "no error code"}` +
          `${err.signal ? ` (killed by ${err.signal})` : ""}\n` +
          `  message:  ${err.message ?? "(none)"}\n` +
          `  A compile that never happened cannot say anything about dist/. Install the\n` +
          `  package's devDependencies (\`npm install\`, at the repository root if this\n` +
          `  package is part of a workspace) and run the suite again.`,
      );
    }

    if (!out.trim()) {
      throw new Error(
        `${binName} exited ${err.status} WITH NO DIAGNOSTICS on stdout or stderr — a\n` +
          `  silent failure is not a verdict about the declaration file.\n` +
          `  tool:     ${binName}\n` +
          `  resolved: ${bin}\n` +
          `  project:  ${join(dir, "tsconfig.json")}`,
      );
    }

    return { ok: false, out };
  }
}
