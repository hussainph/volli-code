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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Whether a Blob's bytes are present in the store. */
export function blobExists(root: string, hash: string): boolean {
  return existsSync(blobFilePath(root, hash));
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
  if (existsSync(destPath)) return hash;
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, bytes);
  return hash;
}

/** Reads a Blob's bytes. Throws when they are absent — a missing Blob is a real failure, not an empty file. */
export function readBlob(root: string, hash: string): Buffer {
  return readFileSync(blobFilePath(root, hash));
}

/** Removes a Blob's bytes. Idempotent — a missing file is not an error. */
export function removeBlob(root: string, hash: string): void {
  rmSync(blobFilePath(root, hash), { force: true });
}
