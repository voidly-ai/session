import fs from "node:fs";
import { dirname } from "node:path";

export type LocalFileErrorCode =
  | "permissions" | "unsupported" | "read" | "too_large" | "limit"
  | "symlink" | "not_regular" | "changed" | "close" | "moved"
  | "exists" | "verify" | "write" | "mode" | "sync";

interface LocalFileStats {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface LocalFileOps {
  lstatSync(path: string): LocalFileStats;
  statSync(path: string): LocalFileStats;
  fstatSync(fd: number): LocalFileStats;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  fchmodSync(fd: number, mode: number): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

export class LocalFileError extends Error {
  declare readonly code: LocalFileErrorCode;
  declare readonly bytes?: number;

  constructor(code: LocalFileErrorCode, bytes?: number) {
    super(`local_file_${code}`);
    this.code = code;
    if (Number.isSafeInteger(bytes)) this.bytes = bytes;
  }
}
const fail = (code: LocalFileErrorCode, bytes?: number): never => { throw new LocalFileError(code, bytes); };
const sameObject = (a: LocalFileStats, b: LocalFileStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const sameSnapshot = (a: LocalFileStats, b: LocalFileStats) => sameObject(a, b) && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const checkPrivateMode = (metadata: LocalFileStats, required: boolean) => {
  if (required && (metadata.mode & 0o077) !== 0) fail("permissions");
};
const flags = () => {
  const c = fs.constants;
  if (!Number.isInteger(c.O_NOFOLLOW) || !c.O_NOFOLLOW ||
      !Number.isInteger(c.O_NONBLOCK) || !c.O_NONBLOCK) fail("unsupported");
  return c.O_NOFOLLOW | c.O_NONBLOCK;
};
function readBounded(fd: number, cap: number, ops: LocalFileOps): Buffer {
  const buffer = Buffer.alloc(cap + 1);
  let size = 0;
  while (size < buffer.length) {
    const n = ops.readSync(fd, buffer, size, buffer.length - size, size);
    if (!Number.isInteger(n) || n < 0 || n > buffer.length - size) fail("read");
    if (n === 0) break;
    size += n;
  }
  if (size > cap) fail("too_large", size);
  return buffer.subarray(0, size);
}

export function readFileCapped(
  path: string,
  cap: number,
  { requirePrivate = false, ops = fs }: { requirePrivate?: boolean; ops?: LocalFileOps } = {},
): Buffer {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1024 * 1024) fail("limit");
  let fd: number | null = null;
  let failure: LocalFileError | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = ops.lstatSync(path);
    if (before.isSymbolicLink()) fail("symlink");
    if (!before.isFile()) fail("not_regular");
    checkPrivateMode(before, requirePrivate);
    if (before.size > cap) fail("too_large", before.size);
    fd = ops.openSync(path, fs.constants.O_RDONLY | flags());
    const opened = ops.fstatSync(fd);
    checkPrivateMode(opened, requirePrivate);
    if (!opened.isFile() || !sameSnapshot(before, opened)) fail("changed");
    bytes = readBounded(fd, cap, ops);
    const after = ops.fstatSync(fd), named = ops.lstatSync(path);
    checkPrivateMode(after, requirePrivate);
    checkPrivateMode(named, requirePrivate);
    if (bytes.length !== opened.size || !sameSnapshot(opened, after) ||
        !sameSnapshot(opened, named)) fail("changed");
  } catch (error) {
    failure = error instanceof LocalFileError ? error : new LocalFileError("read");
  } finally {
    if (fd !== null) {
      try { ops.closeSync(fd); } catch { failure ??= new LocalFileError("close"); }
    }
  }
  if (failure) throw failure;
  return bytes!;
}

export function writeNewVerifiedFile(
  path: string,
  bytes: Buffer,
  { aliases = [], ops = fs }: { aliases?: readonly string[]; ops?: LocalFileOps } = {},
): void {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024) fail("limit");
  let fd: number | null = null, parentFd: number | null = null;
  let failure: LocalFileError | undefined;
  const checkPaths = (file: LocalFileStats, parent: LocalFileStats) => {
    if (!sameObject(parent, ops.lstatSync(dirname(path)))) fail("moved");
    if (!sameSnapshot(file, ops.lstatSync(path))) fail("moved");
    for (const alias of aliases) {
      if (!sameSnapshot(file, ops.statSync(alias))) fail("moved");
    }
  };
  try {
    const nofollow = flags();
    if (!Number.isInteger(fs.constants.O_DIRECTORY) || !fs.constants.O_DIRECTORY) fail("unsupported");
    parentFd = ops.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | nofollow);
    const parent = ops.fstatSync(parentFd);
    if (!parent.isDirectory()) fail("moved");
    try {
      fd = ops.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow, 0o600);
    } catch (error) {
      if ((error as { code?: unknown } | null | undefined)?.code === "EEXIST") fail("exists");
      throw error;
    }
    const created = ops.fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1) fail("verify");
    let offset = 0;
    while (offset < bytes.length) {
      const n = ops.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(n) || n <= 0 || n > bytes.length - offset) fail("write");
      offset += n;
    }
    try { ops.fchmodSync(fd, 0o600); } catch { fail("mode"); }
    const written = ops.fstatSync(fd);
    if (!written.isFile() || written.dev !== created.dev || written.ino !== created.ino ||
        written.nlink !== 1 || (written.mode & 0o7777) !== 0o600 || written.size !== bytes.length) fail("verify");
    if (!readBounded(fd, bytes.length || 1, ops).equals(bytes) ||
        !sameSnapshot(written, ops.fstatSync(fd))) fail("verify");
    checkPaths(written, parent);
    try { ops.fsyncSync(fd); ops.fsyncSync(parentFd); } catch { fail("sync"); }
    if (!sameSnapshot(written, ops.fstatSync(fd))) fail("verify");
    checkPaths(written, parent);
  } catch (error) {
    failure = error instanceof LocalFileError ? error : new LocalFileError("write");
  } finally {
    for (const handle of [fd, parentFd]) {
      if (handle !== null) {
        try { ops.closeSync(handle); } catch { failure ??= new LocalFileError("close"); }
      }
    }
  }
  if (failure) throw failure;
}
