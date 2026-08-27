
import { decodeBase64, encodeBase64 } from "tweetnacl-util";

import {
  destroySessionKey,
  envelopeHash,
  exportSessionKeyBytes,
  importSessionKey,
  timestampMs,
} from "./protocol";
import type { HireWire, SessionKey } from "./protocol";

export const SESSION_KEEP_VERSION = 1 as const;

export const SESSION_KEEP_DIR_MODE = 0o700;

export const SESSION_KEEP_FILE_MODE = 0o600;

const SESSION_KEY_LENGTH = 32;

const GRANT_HASH_RE = /^[0-9a-f]{64}$/;

const REDACTION_MARKER = "[redacted:session-key]";

export interface SessionKeepFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  chmodSync(path: string, mode: number): void;
  openSync(path: string, flags: string, mode?: number): number;
  writeSync(fd: number, data: string): unknown;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf-8"): string;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
}

export interface StoredSessionKeep {
  readonly v: typeof SESSION_KEEP_VERSION;
  readonly grant_hash: string;
  readonly endpoint_base_url: string;
  readonly wire: HireWire;
  readonly session_key_base64: string;
  readonly created_at_ms: number;
}

export interface SessionKeepRecord {
  readonly grantHash: string;
  readonly endpointBaseUrl: string;
  readonly wire: HireWire;
  readonly sessionKey: SessionKey;
  readonly createdAtMs: number;
}

export type SessionKeepRefusal =
  | "session_key_unavailable"
  | "session_key_wrong_length"
  | "grant_hash_unusable"
  | "grant_hash_mismatch"
  | "endpoint_unusable"
  | "wire_unusable"
  | "serialization_would_not_restore"
  | "not_found"
  | "unreadable"
  | "version_unsupported"
  | "malformed"
  | "io_failed";

export type PersistSessionKeepOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: SessionKeepRefusal };

export type LoadSessionKeepOutcome =
  | { readonly ok: true; readonly keep: SessionKeepRecord; readonly path: string }
  | { readonly ok: false; readonly reason: SessionKeepRefusal };

export function defaultSessionKeepDir(homeDir: string): string {
  const trimmed = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  return `${trimmed}/.voidly/sessions`;
}

function keepPath(dir: string, grantHash: string): string {
  if (!GRANT_HASH_RE.test(grantHash)) {
    throw new Error("keepPath: grant hash is not hex-64");
  }
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${trimmed}/${grantHash}.json`;
}

let tempCounter = 0;

function writeKeepFileAtomic(fs: SessionKeepFs, dir: string, path: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: SESSION_KEEP_DIR_MODE });
  fs.chmodSync(dir, SESSION_KEEP_DIR_MODE);

  const pid = typeof process === "object" && process ? (process as { pid?: number }).pid : undefined;
  const tmp = `${dir}/.${pid ?? 0}.${tempCounter++}.keep.tmp`;

  const fd = fs.openSync(tmp, "wx", SESSION_KEEP_FILE_MODE);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, SESSION_KEEP_FILE_MODE);
  fs.renameSync(tmp, path);

  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function wireIsUsable(wire: unknown): wire is HireWire {
  if (!isObject(wire)) return false;
  return (
    isObject(wire.offer) &&
    typeof wire.offer_signature_base64 === "string" &&
    isObject(wire.grant) &&
    typeof wire.grant_signature_base64 === "string" &&
    isObject(wire.capsule)
  );
}

export async function persistSessionKeep(input: {
  readonly fs: SessionKeepFs;
  readonly dir: string;
  readonly grantHash: string;
  readonly endpointBaseUrl: string;
  readonly wire: HireWire;
  readonly sessionKey: SessionKey;
  readonly nowMs: number;
}): Promise<PersistSessionKeepOutcome> {
  if (typeof input.grantHash !== "string" || !GRANT_HASH_RE.test(input.grantHash)) {
    return { ok: false, reason: "grant_hash_unusable" };
  }
  if (typeof input.endpointBaseUrl !== "string" || input.endpointBaseUrl.length === 0) {
    return { ok: false, reason: "endpoint_unusable" };
  }
  if (!wireIsUsable(input.wire)) {
    return { ok: false, reason: "wire_unusable" };
  }

  let derived: string;
  try {
    derived = await envelopeHash(input.wire.grant as unknown as object);
  } catch {
    return { ok: false, reason: "wire_unusable" };
  }
  if (derived !== input.grantHash) {
    return { ok: false, reason: "grant_hash_mismatch" };
  }

  const bytes = exportSessionKeyBytes(input.sessionKey);
  if (bytes === null) {
    return { ok: false, reason: "session_key_unavailable" };
  }
  if (bytes.length !== SESSION_KEY_LENGTH) {
    bytes.fill(0);
    return { ok: false, reason: "session_key_wrong_length" };
  }

  const record: StoredSessionKeep = {
    v: SESSION_KEEP_VERSION,
    grant_hash: input.grantHash,
    endpoint_base_url: input.endpointBaseUrl,
    wire: input.wire,
    session_key_base64: encodeBase64(bytes),
    created_at_ms: input.nowMs,
  };

  let json: string;
  try {
    json = JSON.stringify(record, null, 2);
  } catch {
    bytes.fill(0);
    return { ok: false, reason: "serialization_would_not_restore" };
  }

  if (!restoresTheSameBytes(json, bytes)) {
    bytes.fill(0);
    return { ok: false, reason: "serialization_would_not_restore" };
  }
  bytes.fill(0);

  const path = keepPath(input.dir, input.grantHash);
  try {
    writeKeepFileAtomic(input.fs, trimTrailingSlash(input.dir), path, json);
  } catch {
    return { ok: false, reason: "io_failed" };
  }
  return { ok: true, path };
}

function trimTrailingSlash(dir: string): string {
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function restoresTheSameBytes(json: string, expected: Uint8Array): boolean {
  if (json.includes(REDACTION_MARKER)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  const b64 = parsed.session_key_base64;
  if (typeof b64 !== "string" || b64.length === 0) return false;
  let restored: Uint8Array;
  try {
    restored = decodeBase64(b64);
  } catch {
    return false;
  }
  if (restored.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= restored[i] ^ expected[i];
  restored.fill(0);
  return diff === 0;
}

export async function loadSessionKeep(input: {
  readonly fs: SessionKeepFs;
  readonly dir: string;
  readonly grantHash: string;
}): Promise<LoadSessionKeepOutcome> {
  if (typeof input.grantHash !== "string" || !GRANT_HASH_RE.test(input.grantHash)) {
    return { ok: false, reason: "grant_hash_unusable" };
  }
  const path = keepPath(input.dir, input.grantHash);

  let text: string;
  try {
    if (!input.fs.existsSync(path)) return { ok: false, reason: "not_found" };
    text = input.fs.readFileSync(path, "utf-8");
  } catch {
    return { ok: false, reason: "io_failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!isObject(parsed)) return { ok: false, reason: "unreadable" };
  if (parsed.v !== SESSION_KEEP_VERSION) return { ok: false, reason: "version_unsupported" };

  const { grant_hash, endpoint_base_url, wire, session_key_base64, created_at_ms } = parsed;
  if (typeof grant_hash !== "string" || grant_hash !== input.grantHash) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof endpoint_base_url !== "string" || endpoint_base_url.length === 0) {
    return { ok: false, reason: "endpoint_unusable" };
  }
  if (!wireIsUsable(wire)) return { ok: false, reason: "wire_unusable" };
  if (typeof created_at_ms !== "number" || !Number.isFinite(created_at_ms)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof session_key_base64 !== "string" || session_key_base64.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (session_key_base64 === REDACTION_MARKER) {
    return { ok: false, reason: "serialization_would_not_restore" };
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(session_key_base64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (bytes.length !== SESSION_KEY_LENGTH) {
    bytes.fill(0);
    return { ok: false, reason: "session_key_wrong_length" };
  }

  let derived: string;
  try {
    derived = await envelopeHash(wire.grant as unknown as object);
  } catch {
    bytes.fill(0);
    return { ok: false, reason: "wire_unusable" };
  }
  if (derived !== grant_hash) {
    bytes.fill(0);
    return { ok: false, reason: "grant_hash_mismatch" };
  }

  const sessionKey = importSessionKey(bytes);
  bytes.fill(0);

  return {
    ok: true,
    path,
    keep: {
      grantHash: grant_hash,
      endpointBaseUrl: endpoint_base_url,
      wire,
      sessionKey,
      createdAtMs: created_at_ms,
    },
  };
}

export function eraseSessionKeep(input: {
  readonly fs: SessionKeepFs;
  readonly dir: string;
  readonly grantHash: string;
}): { readonly ok: true; readonly erased: boolean } | { readonly ok: false; readonly reason: SessionKeepRefusal } {
  if (typeof input.grantHash !== "string" || !GRANT_HASH_RE.test(input.grantHash)) {
    return { ok: false, reason: "grant_hash_unusable" };
  }
  const path = keepPath(input.dir, input.grantHash);
  try {
    if (!input.fs.existsSync(path)) return { ok: true, erased: false };
    input.fs.unlinkSync(path);
    return { ok: true, erased: true };
  } catch {
    return { ok: false, reason: "io_failed" };
  }
}

export function listSessionKeeps(input: { readonly fs: SessionKeepFs; readonly dir: string }): string[] {
  const dir = trimTrailingSlash(input.dir);
  let entries: string[];
  try {
    if (!input.fs.existsSync(dir)) return [];
    entries = input.fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const hash = e.slice(0, -".json".length);
    if (GRANT_HASH_RE.test(hash)) out.push(hash);
  }
  return out.sort();
}

export function pruneSessionKeeps(input: {
  readonly fs: SessionKeepFs;
  readonly dir: string;
  readonly nowMs: number;
  readonly recoveryTtlMs: number;
}): { readonly erased: string[]; readonly kept: string[] } {
  const dir = trimTrailingSlash(input.dir);
  const erased: string[] = [];
  const kept: string[] = [];

  for (const grantHash of listSessionKeeps({ fs: input.fs, dir })) {
    const deadline = recoverableUntilMsOf(input.fs, dir, grantHash, input.recoveryTtlMs);
    if (deadline === null || deadline > input.nowMs) {
      kept.push(grantHash);
      continue;
    }
    const gone = eraseSessionKeep({ fs: input.fs, dir, grantHash });
    if (gone.ok && gone.erased) erased.push(grantHash);
    else kept.push(grantHash);
  }
  return { erased, kept };
}

function recoverableUntilMsOf(
  fs: SessionKeepFs,
  dir: string,
  grantHash: string,
  recoveryTtlMs: number,
): number | null {
  if (!Number.isFinite(recoveryTtlMs) || recoveryTtlMs < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(keepPath(dir, grantHash), "utf-8"));
  } catch {
    return null;
  }
  if (!isObject(parsed) || !isObject(parsed.wire)) return null;
  const grant = parsed.wire.grant;
  if (!isObject(grant)) return null;
  const expiresMs = timestampMs(grant.expires_at);
  if (expiresMs === null) return null;
  return expiresMs + recoveryTtlMs;
}

export function closeOutSessionKeep(input: {
  readonly fs: SessionKeepFs;
  readonly dir: string;
  readonly grantHash: string;
  readonly sessionKey: SessionKey;
}): { readonly ok: true; readonly erased: boolean } | { readonly ok: false; readonly reason: SessionKeepRefusal } {
  const gone = eraseSessionKeep({ fs: input.fs, dir: input.dir, grantHash: input.grantHash });
  destroySessionKey(input.sessionKey);
  return gone;
}
