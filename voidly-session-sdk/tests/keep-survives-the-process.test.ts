
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { importSessionKey, sealTaskResult } from "../src/index";
import type { SessionKey, TaskResultCapsule } from "../src/index";
import { openTaskResult } from "../src/hirer";
import { destroySessionKey, exportSessionKeyBytes } from "../src/protocol";
import {
  SESSION_KEEP_VERSION,
  defaultSessionKeepDir,
  eraseSessionKeep,
  listSessionKeeps,
  loadSessionKeep,
  persistSessionKeep,
  pruneSessionKeeps,
} from "../src/keep";
import { NOW, freshHire, seededEntropy } from "./_fixtures";
import { toolPath } from "./_tsc";

const PKG_DIR = resolve(__dirname, "..");
const ENDPOINT = "https://rail.example.test";
const RESULT_TEXT = "IR: 41 confirmed DNS-tampering incidents, 2026-01..2026-06. See permalinks.";

const MAX_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let root: string;
let childBundle: string;
let fixturePath: string;
let grantHash: string;
let wire: Awaited<ReturnType<typeof freshHire>>["hire"] extends { ok: true; wire: infer W } ? W : never;
let sessionKey: SessionKey;
let resultCapsule: TaskResultCapsule;
let resultCommitment: string;

function bundleChild(out: string): void {
  execFileSync(
    toolPath("esbuild"),
    [
      join(PKG_DIR, "tests", "_keepChild.ts"),
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=es2021",
      "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
      `--outfile=${out}`,
      "--log-level=warning",
    ],
    { cwd: PKG_DIR, stdio: ["ignore", "inherit", "inherit"] },
  );
}

function runChild(dir: string, hash: string): Record<string, unknown> {
  const out = execFileSync(process.execPath, [childBundle, dir, hash, fixturePath], {
    cwd: PKG_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "voidly-keep-"));
  childBundle = join(root, "child.mjs");
  bundleChild(childBundle);

  const { hire } = await freshHire(0x5eed01);
  if (!hire.ok) throw new Error("fixture hire failed");
  wire = hire.wire;
  grantHash = hire.keep.grant_hash;
  sessionKey = hire.keep.sessionKey;

  const sealed = await sealTaskResult({
    result: RESULT_TEXT,
    grantHash,
    sessionKey,
    briefCapsule: hire.wire.capsule,
    entropy: seededEntropy(0x5eed02),
  });
  resultCapsule = sealed.capsule;
  resultCommitment = sealed.resultCommitment;

  fixturePath = join(root, "delivered.json");
  fs.writeFileSync(fixturePath, JSON.stringify({ resultCapsule, resultCommitment }));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the trap — what the naive fix actually writes", () => {
  it("`JSON.stringify` SUCCEEDS and writes the redaction marker where the key should be", () => {
    const naive = JSON.stringify({ sessionKey, grant_hash: grantHash, wire });
    expect(naive.length).toBeGreaterThan(0);
    const parsed = JSON.parse(naive) as Record<string, unknown>;
    expect(parsed.sessionKey).toBe("[redacted:session-key]");
  });

  it("`structuredClone` is worse — an empty object, with no marker to notice", () => {
    const cloned = structuredClone({ sessionKey, grant_hash: grantHash }) as unknown as {
      sessionKey: Record<string, unknown>;
    };
    expect(typeof cloned.sessionKey).toBe("object");
    expect(Object.keys(cloned.sessionKey)).toEqual([]);
  });

  it("the handle has NO own property — which is why a structural walk finds nothing", () => {
    expect(Object.keys(sessionKey as unknown as object)).toEqual([]);
  });
});

describe("persist — fail closed, and before the wire", () => {
  it("writes a file whose `session_key_base64` is 32 real bytes, not a marker", async () => {
    const dir = join(root, "good");
    const wrote = await persistSessionKeep({
      fs,
      dir,
      grantHash,
      endpointBaseUrl: ENDPOINT,
      wire,
      sessionKey,
      nowMs: NOW,
    });
    expect(wrote).toEqual({ ok: true, path: join(dir, `${grantHash}.json`) });

    const text = fs.readFileSync(join(dir, `${grantHash}.json`), "utf-8");
    expect(text).not.toContain("[redacted:session-key]");

    const record = JSON.parse(text) as Record<string, unknown>;
    expect(record.v).toBe(SESSION_KEEP_VERSION);
    expect(record.grant_hash).toBe(grantHash);
    expect(record.endpoint_base_url).toBe(ENDPOINT);
    expect(typeof record.session_key_base64).toBe("string");
    expect(Buffer.from(String(record.session_key_base64), "base64").length).toBe(32);

    expect(text).not.toContain("Summarise every confirmed DNS-tampering incident");
    expect(text).not.toContain("signing_secret_key");
    expect(text).not.toContain("private_key");
  });

  it("is owner-only, inside an owner-only directory", () => {
    const dir = join(root, "good");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(dir, `${grantHash}.json`)).mode & 0o777).toBe(0o600);
  });

  it("refuses a `grant_hash` the `wire` does not hash to — the stale pairing", async () => {
    const other = "f".repeat(64);
    const out = await persistSessionKeep({
      fs,
      dir: join(root, "stale"),
      grantHash: other,
      endpointBaseUrl: ENDPOINT,
      wire,
      sessionKey,
      nowMs: NOW,
    });
    expect(out).toEqual({ ok: false, reason: "grant_hash_mismatch" });
    expect(fs.existsSync(join(root, "stale", `${other}.json`))).toBe(false);
  });

  it("leaves no temp file behind", () => {
    expect(fs.readdirSync(join(root, "good")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("THE CROSSING — a fresh process opens what the dead one paid for", () => {
  let childAnswer: Record<string, unknown>;

  beforeAll(async () => {
    destroySessionKey(sessionKey);
    childAnswer = runChild(join(root, "good"), grantHash);
  });

  it("the original handle really is dead — export answers null", () => {
    expect(exportSessionKeyBytes(sessionKey)).toBeNull();
  });

  it("and the dead handle cannot open the capsule in THIS process", async () => {
    const dead = await openTaskResult({ resultCapsule, sessionKey, grantHash, resultCommitment });
    expect(dead).toEqual({ kind: "unopenable" });
  });

  it("the child ran in a DIFFERENT process", () => {
    expect(typeof childAnswer.pid).toBe("number");
    expect(childAnswer.pid).not.toBe(process.pid);
  });

  it("THE CLAIM: the child opened the capsule, byte for byte", () => {
    expect(childAnswer.kind).toBe("opened");
    expect(childAnswer.result).toBe(RESULT_TEXT);
  });

  it("and it read the endpoint and the wire out of the same file", () => {
    expect(childAnswer.endpoint_base_url).toBe(ENDPOINT);
    expect(childAnswer.grant_hash).toBe(grantHash);
    expect(childAnswer.offer_signature_base64).toBe(wire.offer_signature_base64);
  });
});

describe("the controls — every one of these MUST fail to open", () => {
  it("the naive `JSON.stringify` file exists, is non-empty, and opens NOTHING", () => {
    const dir = join(root, "naive");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${grantHash}.json`);
    fs.writeFileSync(
      path,
      JSON.stringify({
        v: SESSION_KEEP_VERSION,
        sessionKey,
        grant_hash: grantHash,
        endpoint_base_url: ENDPOINT,
        wire,
        created_at_ms: NOW,
      }),
      { mode: 0o600 },
    );

    expect(fs.existsSync(path)).toBe(true);
    expect(fs.statSync(path).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(path, "utf-8")).toContain("[redacted:session-key]");

    const answer = runChild(dir, grantHash);
    expect(answer.kind).not.toBe("opened");
    expect(answer.result).toBeUndefined();
  });

  it("the trap IN THE RIGHT SHAPE — `session_key_base64` set to the marker", () => {
    const dir = join(root, "marker");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const good = JSON.parse(fs.readFileSync(join(root, "good", `${grantHash}.json`), "utf-8")) as Record<
      string,
      unknown
    >;
    good.session_key_base64 = JSON.parse(JSON.stringify({ k: sessionKey })).k;
    expect(good.session_key_base64).toBe("[redacted:session-key]");
    fs.writeFileSync(join(dir, `${grantHash}.json`), JSON.stringify(good), { mode: 0o600 });

    const answer = runChild(dir, grantHash);
    expect(answer).toMatchObject({ kind: "load_refused", reason: "serialization_would_not_restore" });
  });

  it("a keep holding 32 REAL bytes of the WRONG key does not open it either", () => {
    const dir = join(root, "wrongkey");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const good = JSON.parse(fs.readFileSync(join(root, "good", `${grantHash}.json`), "utf-8")) as Record<
      string,
      unknown
    >;
    good.session_key_base64 = Buffer.from(new Uint8Array(32).fill(0x5a)).toString("base64");
    fs.writeFileSync(join(dir, `${grantHash}.json`), JSON.stringify(good), { mode: 0o600 });

    const answer = runChild(dir, grantHash);
    expect(answer).toMatchObject({ kind: "unopenable" });
  });

  it("an empty directory refuses with `not_found`, not with a crash", () => {
    const dir = join(root, "empty");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(runChild(dir, grantHash)).toMatchObject({ kind: "load_refused", reason: "not_found" });
  });
});

describe("persist refuses a destroyed handle — and it refuses BEFORE the wire", () => {
  it("`session_key_unavailable`, and nothing is written", async () => {
    const dir = join(root, "afterdeath");
    const out = await persistSessionKeep({
      fs,
      dir,
      grantHash,
      endpointBaseUrl: ENDPOINT,
      wire,
      sessionKey,
      nowMs: NOW,
    });
    expect(out).toEqual({ ok: false, reason: "session_key_unavailable" });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("load, list, erase and prune", () => {
  const dir = () => join(root, "lifecycle");

  it("round-trips a key that opens the capsule in THIS process too", async () => {
    const fresh = importSessionKey(new Uint8Array(32).fill(0x2b));
    const resealed = await sealTaskResult({
      result: "second result",
      grantHash,
      sessionKey: fresh,
      briefCapsule: wire.capsule,
      entropy: seededEntropy(0x5eed03),
    });
    const wrote = await persistSessionKeep({
      fs,
      dir: dir(),
      grantHash,
      endpointBaseUrl: ENDPOINT,
      wire,
      sessionKey: fresh,
      nowMs: NOW,
    });
    expect(wrote.ok).toBe(true);
    destroySessionKey(fresh);

    const loaded = await loadSessionKeep({ fs, dir: dir(), grantHash });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const opened = await openTaskResult({
      resultCapsule: resealed.capsule,
      sessionKey: loaded.keep.sessionKey,
      grantHash,
      resultCommitment: resealed.resultCommitment,
    });
    expect(opened).toEqual({ kind: "opened", result: "second result" });
    destroySessionKey(loaded.keep.sessionKey);
  });

  it("lists exactly the grant hashes it holds, and ignores anything else", () => {
    fs.writeFileSync(join(dir(), "notes.txt"), "x");
    fs.writeFileSync(join(dir(), ".1.0.keep.tmp"), "x");
    fs.writeFileSync(join(dir(), "zz.json"), "x");
    expect(listSessionKeeps({ fs, dir: dir() })).toEqual([grantHash]);
  });

  it("prune KEEPS a keep inside the recovery window", () => {
    const out = pruneSessionKeeps({
      fs,
      dir: dir(),
      nowMs: NOW,
      recoveryTtlMs: MAX_RECOVERY_TTL_MS,
    });
    expect(out).toEqual({ erased: [], kept: [grantHash] });
    expect(fs.existsSync(join(dir(), `${grantHash}.json`))).toBe(true);
  });

  it("prune ERASES it once `grant.expires_at + MAX_RECOVERY_TTL_MS` has passed", () => {
    const past = NOW + MAX_RECOVERY_TTL_MS + 60 * 60_000 + 1;
    const out = pruneSessionKeeps({ fs, dir: dir(), nowMs: past, recoveryTtlMs: MAX_RECOVERY_TTL_MS });
    expect(out).toEqual({ erased: [grantHash], kept: [] });
    expect(fs.existsSync(join(dir(), `${grantHash}.json`))).toBe(false);
  });

  it("prune LEAVES a file it cannot parse — deleting the unreadable is the same defect", async () => {
    const dirty = join(root, "dirty");
    fs.mkdirSync(dirty, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(dirty, `${grantHash}.json`), "{not json", { mode: 0o600 });
    const out = pruneSessionKeeps({
      fs,
      dir: dirty,
      nowMs: NOW + 10 * MAX_RECOVERY_TTL_MS,
      recoveryTtlMs: MAX_RECOVERY_TTL_MS,
    });
    expect(out).toEqual({ erased: [], kept: [grantHash] });
    expect(fs.existsSync(join(dirty, `${grantHash}.json`))).toBe(true);
  });

  it("erase is idempotent, and a second call is not a fault", () => {
    expect(eraseSessionKeep({ fs, dir: dir(), grantHash })).toEqual({ ok: true, erased: false });
  });

  it("refuses a grant hash that is not hex-64 rather than touching the path", async () => {
    for (const bad of ["../../etc/passwd", "", "ABC", `${grantHash}x`]) {
      expect(eraseSessionKeep({ fs, dir: dir(), grantHash: bad })).toEqual({
        ok: false,
        reason: "grant_hash_unusable",
      });
      expect(await loadSessionKeep({ fs, dir: dir(), grantHash: bad })).toEqual({
        ok: false,
        reason: "grant_hash_unusable",
      });
    }
  });

  it("`defaultSessionKeepDir` sits beside the hirer identity, not inside it", () => {
    expect(defaultSessionKeepDir("/home/x")).toBe("/home/x/.voidly/sessions");
    expect(defaultSessionKeepDir("/home/x/")).toBe("/home/x/.voidly/sessions");
  });
});
