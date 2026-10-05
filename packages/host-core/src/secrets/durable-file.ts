/**
 * The durable file contract for sealed credential files (VC-642;
 * `docs/plans/sealed-credential-store.md` §6). Callers hold the
 * {@link CredentialLock} around both halves.
 *
 * READ. {@link readSealedFile} opens without following a symlink and without
 * blocking on a FIFO, and answers the bytes, or `null` when there is no file.
 *
 * WRITE. {@link publishSealedFile} replaces the active file whole, so a reader
 * or a crash sees the old bytes or the new ones, never a mixture:
 *
 * 1. **Compare before write.** The active file must still be the bytes the
 *    caller authenticated (or still absent). Anything else, from a writer that
 *    ignores the lock or a hand edit, is {@link SealedFileChangedError} and is
 *    never overwritten. The caller opened those bytes with their key, so this
 *    is also the key-id check: nothing sealed under a key this process did not
 *    open with is ever replaced by a save.
 * 2. A unique same-directory temporary (`<name>.<pid>.<random>.tmp`), created
 *    `O_EXCL | O_NOFOLLOW`, mode 0600, written whole and fsynced.
 * 3. `rename` over the active name: the commit point.
 * 4. fsync the directory, so the new name survives a power cut.
 *
 * A directory that cannot be synced leaves a commit that happened but may not
 * be durable. That is reported (`synced: false`), or with
 * `requireDirectorySync` thrown as {@link SealedFileIndeterminateError}: the
 * caller must read again before retrying, never assume nothing committed.
 *
 * Temporaries a crashed writer left are swept, under the lock, before the
 * next write: no locking-aware writer is between steps 2 and 3 then. On macOS
 * `fsync` reaches the drive but not necessarily its platter (`F_FULLFSYNC`,
 * which Node does not expose); the order of the steps still holds.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { SealedStoreUnreadableError } from "./credential-state";

/** The points {@link publishSealedFile} reports, in order, for crash tests. */
export type PublishStep = "temporary-written" | "temporary-synced" | "renamed" | "directory-synced";

export interface PublishOptions {
  /** The bytes the caller read and authenticated, or `null` when it found no file. */
  readonly expected: Buffer | null;
  /** Throw {@link SealedFileIndeterminateError} when the directory cannot be synced. */
  readonly requireDirectorySync?: boolean;
  /** Called after each step. A test stops the process here to prove crash safety. */
  readonly step?: (step: PublishStep) => void;
}

/** The active file is not the one the caller read. Nothing was written. */
export class SealedFileChangedError extends Error {
  readonly code = "sealed-file-changed";
  constructor() {
    super("Saved credentials changed outside Volli's lock, so nothing was written over them.");
    this.name = "SealedFileChangedError";
  }
}

/** The new file replaced the old one, and its directory could not be synced. */
export class SealedFileIndeterminateError extends Error {
  readonly code = "sealed-file-indeterminate";
  constructor() {
    super("Saved credentials were written, but the disk could not confirm the change is durable.");
    this.name = "SealedFileIndeterminateError";
  }
}

/**
 * The sealed file's bytes, or `null` when nothing is at `path`. A file that
 * cannot be opened is {@link SealedStoreUnreadableError} (credentials
 * `locked`); something that is not a regular file is a plain error (the
 * caller's `corrupt`). Tightens a found file to 0600, as the store always has.
 */
export function readSealedFile(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new SealedStoreUnreadableError();
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Saved credentials are not a file.");
    fchmodSync(fd, 0o600);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replaces the sealed file at `path` with `bytes`; see this module's comment. */
export function publishSealedFile(
  path: string,
  bytes: Buffer,
  options: PublishOptions,
): { synced: boolean } {
  const active = readSealedFile(path);
  if (!sameBytes(active, options.expected)) throw new SealedFileChangedError();
  sweepTemporaries(path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, 0o600);
      options.step?.("temporary-written");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    options.step?.("temporary-synced");
    renameSync(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(temporary, { force: true });
  }
  options.step?.("renamed");
  const synced = syncDirectory(dirname(path));
  if (!synced && options.requireDirectorySync === true) throw new SealedFileIndeterminateError();
  options.step?.("directory-synced");
  return { synced };
}

export function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right);
}

/** Removes `<name>.<pid>.<12 hex>.tmp` siblings a crashed writer left. Best effort. */
function sweepTemporaries(path: string): void {
  const name = basename(path);
  const directory = dirname(path);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.startsWith(`${name}.`) ||
      !/^\.\d+\.[0-9a-f]{12}\.tmp$/.test(entry.slice(name.length))
    ) {
      continue;
    }
    try {
      rmSync(join(directory, entry), { force: true });
    } catch {
      // A leftover temporary holds ciphertext only and is excluded from backups.
    }
  }
}

/** Whether `directory` synced. Some filesystems cannot; the caller decides what that means. */
export function syncDirectory(directory: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
