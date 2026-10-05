/**
 * The free-space preflight before a migration (VC-633).
 *
 * Migrating an existing database needs room for three copies of it at once:
 * the file itself, the verified safety copy published beside it
 * (`publishRollbackPoint`), and the rewrite the migration and the compaction
 * after it put through the WAL (VACUUM rebuilds the whole file). On the
 * owner's 950 MB profile that is about 2.8 GB on one volume. A disk that runs
 * out halfway fails with SQLITE_FULL or ENOSPC from somewhere deep in the copy
 * or the transaction, which names neither the cause nor the remedy; this
 * check runs first, on the directory the copy is written to, and refuses
 * before anything is written, with how much is needed and how much is free.
 *
 * The estimate is deliberately simple: twice the current database (its file
 * plus any WAL, which the checkpoint folds in) plus fixed headroom for the
 * journal and the filesystem's own reserve. It errs high on a small migration
 * over a big file, and that is the right side: the alternative is a failure
 * mid-upgrade.
 */
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Headroom beyond the two copies: WAL growth, journal pages, filesystem slack. */
export const MIGRATION_DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Why a migration did not start: the disk cannot hold it. Nothing was written. */
export class InsufficientDiskSpaceError extends Error {
  override readonly name = "InsufficientDiskSpaceError";
  constructor(
    /** The directory the database and its safety copy live in. */
    readonly directory: string,
    /** The database's size today, its WAL included. */
    readonly databaseBytes: number,
    /** What the migration needs free. */
    readonly requiredBytes: number,
    /** What the volume has free for this user. */
    readonly freeBytes: number,
  ) {
    super(
      `Migration refused: not enough free disk space to upgrade the database safely. ` +
        `Upgrading needs about ${formatBytes(requiredBytes)} free in ${directory} ` +
        `(a safety copy of the ${formatBytes(databaseBytes)} database, then room to rewrite it), ` +
        `and ${formatBytes(freeBytes)} is free. Nothing was changed. ` +
        `Free up at least ${formatBytes(requiredBytes - freeBytes)} on that disk, then open Volli again.`,
    );
  }
}

/** Bytes as a person reads them: one decimal place, binary units. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** What the preflight reads, injected so a test can stage any disk. */
export interface DiskProbe {
  /** Size of a file in bytes, or 0 when it does not exist. */
  fileSize(path: string): number;
  /** Bytes free to an unprivileged writer on the volume holding `directory`. */
  freeBytes(directory: string): number;
}

export const nodeDiskProbe: DiskProbe = {
  fileSize(path) {
    try {
      return statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  },
  freeBytes(directory) {
    const stats = statfsSync(directory);
    return stats.bavail * stats.bsize;
  },
};

/** The free space a migration of a `databaseBytes` database needs. */
export function migrationDiskRequirement(databaseBytes: number): number {
  return 2 * databaseBytes + MIGRATION_DISK_HEADROOM_BYTES;
}

/**
 * Throws {@link InsufficientDiskSpaceError} when the volume holding `dbPath`
 * has less free than {@link migrationDiskRequirement}. Reads only.
 */
export function assertMigrationDiskSpace(dbPath: string, probe: DiskProbe = nodeDiskProbe): void {
  const directory = dirname(dbPath);
  const databaseBytes = probe.fileSize(dbPath) + probe.fileSize(`${dbPath}-wal`);
  const requiredBytes = migrationDiskRequirement(databaseBytes);
  const freeBytes = probe.freeBytes(directory);
  if (freeBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(directory, databaseBytes, requiredBytes, freeBytes);
  }
}
