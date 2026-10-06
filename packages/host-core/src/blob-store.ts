/**
 * File-store for attachment BYTES (VC-50), replacing `attachment-store.ts`'s
 * id-keyed layout. Distinct from `db/blobs-repo.ts`, which owns the `blobs`
 * row — this module owns the file that row's hash names. Bytes live under
 * Electron `userData` at `<blobsRoot>/<ab>/<sha256>`, so identical bytes are
 * stored once no matter how many Tickets and Sessions link them.
 *
 * Content-addressing does more than deduplicate: it makes the traversal guard
 * total. The old store had to reject `..` and separators in an id and a
 * filename it was handed; here the only path segment is a hash the store
 * computed itself, and `blobRelPath` refuses anything that is not 64 hex
 * digits. There is no input from which a caller could construct an escape.
 *
 * Root-path dependency-injected (never reaches for Electron's `app` itself) so
 * it stays testable against a tmp dir — mirroring how `db/index.ts` is handed
 * its `dbPath`; `apps/desktop/src/main/index.ts` is the one call site that
 * resolves the real `app.getPath("userData")`.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { blobRelPath } from "@volli/shared";

/** The Blob store root under a given Electron `userData` path. */
export function blobsRoot(userDataPath: string): string {
  return join(userDataPath, "blobs");
}

/** The absolute path a Blob's bytes are (or would be) stored at, under `root`. */
export function blobFilePath(root: string, hash: string): string {
  return join(root, blobRelPath(hash));
}

/** The sha256 of some bytes, lowercase hex — a Blob's whole identity. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const sweptRoots = new Set<string>();
const stagingMaxAgeMs = 60 * 60 * 1000;

/** Reclaim crash leftovers once per root, without making housekeeping a failure. */
function sweepStagingOnce(root: string): void {
  const key = resolve(root);
  if (sweptRoots.has(key)) return;
  sweptRoots.add(key);
  const cutoff = Date.now() - stagingMaxAgeMs;
  try {
    for (const shard of readdirSync(root, { withFileTypes: true })) {
      // Never traverse a symlink or an unrelated directory in the store.
      if (!/^[a-f0-9]{2}$/.test(shard.name) || !shard.isDirectory()) continue;
      const shardPath = join(root, shard.name);
      try {
        for (const entry of readdirSync(shardPath, { withFileTypes: true })) {
          if (!entry.name.startsWith(".blob-") || !entry.isFile()) continue;
          const path = join(shardPath, entry.name);
          try {
            const stat = lstatSync(path);
            if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(path);
          } catch {
            // Another process may have removed it, or permissions may forbid it.
          }
        }
      } catch {
        // An unreadable shard must not prevent using the rest of the store.
      }
    }
  } catch {
    // A missing or unreadable root is normal before the first write.
  }
}

/** Whether a Blob's bytes are present in the store. */
export function blobExists(root: string, hash: string): boolean {
  const path = blobFilePath(root, hash);
  sweepStagingOnce(root);
  return existsSync(path);
}

/**
 * Writes bytes into the store and returns their hash. Idempotent: bytes
 * already present are left exactly as they are rather than rewritten, since
 * identical content is what produced the same path in the first place — and a
 * rewrite would briefly truncate a file another link is reading.
 */
export function writeBlob(root: string, bytes: Uint8Array): string {
  const hash = hashBytes(bytes);
  const destPath = blobFilePath(root, hash);
  sweepStagingOnce(root);
  try {
    // A descriptor-only fast path preserves deduplication even when the store
    // is read-only or full. No later write relies on this existence check.
    const existing = openBlob(destPath);
    closeSync(existing);
    return hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(destPath), { recursive: true });
  // Stage complete bytes on an exclusively created inode, then publish with a
  // hard link: link is atomic and refuses any existing destination, including a
  // dangling symlink. Filesystems without hard links use atomic rename instead:
  // equal-hash writers have identical bytes, and open readers keep their inode.
  // As with the rest of the store, ancestor directories must be user-owned.
  const temporaryPath = join(dirname(destPath), `.blob-${randomUUID()}`);
  const fd = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o666,
  );
  try {
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Blob must be a regular file");
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    try {
      try {
        linkSync(temporaryPath, destPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!code || !["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code)) {
          throw error;
        }
        renameSync(temporaryPath, destPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Idempotence is only for real files, not symlinks or special files. This
      // check is descriptor-based too, and never opens the winner for writing.
      const existing = openBlob(destPath);
      closeSync(existing);
    }
    return hash;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Open and validate the inode that will actually be read, never a leaf symlink. */
function openBlob(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Blob must be a regular file");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Reads a Blob's bytes. Throws when they are absent — a missing Blob is a real failure, not an empty file. */
export function readBlob(root: string, hash: string): Buffer {
  const path = blobFilePath(root, hash);
  sweepStagingOnce(root);
  const fd = openBlob(path);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Removes a Blob's bytes. Idempotent — a missing file is not an error. */
export function removeBlob(root: string, hash: string): void {
  const path = blobFilePath(root, hash);
  sweepStagingOnce(root);
  rmSync(path, { force: true });
}
