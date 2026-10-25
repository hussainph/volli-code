/**
 * The last-seen Volli Cloud board, on disk (VC-889, D3): what a cloud launch
 * that cannot reach the backend shows, read-only, until it can.
 *
 * - **Per account.** One file per signed-in person under
 *   `<userData>/cloud-board-snapshots/`, named by a hash of their user id; the
 *   window never names a path, and only ever reads its own launch's account.
 * - **Opaque here.** The window encodes and validates the board
 *   (`stores/cloud-board/snapshot.ts`, schema-versioned); main stores the text
 *   as it is, bounded, never parsed.
 * - **Atomic.** Written to a temporary file and renamed over the old one, so
 *   a crash mid-write leaves the previous snapshot whole. Owner-only mode.
 * - **Gone with the sign-in.** Cleared whenever the account ends up signed out
 *   (a sign-out, a refused refresh, an account deletion): no other person's
 *   board survives on this Mac.
 *
 * It is a cache of what the backend already holds, never a fact the backend
 * has not accepted: nothing here is ever sent anywhere.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory under `userData` the snapshots live in. */
export const CLOUD_SNAPSHOT_DIRECTORY = "cloud-board-snapshots";

/** The largest snapshot kept, in UTF-16 code units of its text. */
export const CLOUD_SNAPSHOT_MAX_LENGTH = 16 * 1024 * 1024;

/** One account's file name: a hash of its user id, so the directory names nobody. */
export function snapshotFileName(userId: string): string {
  return `${createHash("sha256").update(userId).digest("hex").slice(0, 32)}.json`;
}

export interface CloudSnapshotFiles {
  /** The account's snapshot text, or `null` when there is none. */
  read(userId: string): string | null;
  /** Replaces the account's snapshot, atomically. */
  write(userId: string, text: string): void;
  /** Removes every snapshot on this Mac. */
  clearAll(): void;
}

/** The snapshots under `directory`. */
export function cloudSnapshotFiles(directory: string): CloudSnapshotFiles {
  return {
    read(userId) {
      try {
        return readFileSync(join(directory, snapshotFileName(userId)), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write(userId, text) {
      if (text.length > CLOUD_SNAPSHOT_MAX_LENGTH) {
        throw new Error("The board snapshot is too large to keep.");
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, snapshotFileName(userId));
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    clearAll() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
