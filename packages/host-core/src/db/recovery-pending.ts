import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const recoveryPendingPath = (dbPath: string): string => `${dbPath}.recovery-pending`;

export function hasPendingDatabaseRecovery(dbPath: string): boolean {
  try {
    lstatSync(recoveryPendingPath(dbPath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function assertNoPendingDatabaseRecovery(dbPath: string): void {
  if (hasPendingDatabaseRecovery(dbPath)) {
    throw new Error(
      "A database restore was interrupted. Restore from the last backup that checks clean. Your original files are preserved for manual recovery.",
    );
  }
}

/** Persist preservation copies and directory entries before displacing a live DB. */
export function syncRecoveryPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function beginDatabaseRecovery(dbPath: string, preservedDirectory: string): void {
  if (hasPendingDatabaseRecovery(dbPath)) {
    // A retry may inherit a marker whose first directory fsync failed. Re-fence
    // BOTH its existence and this attempt's new preservation directory entry.
    syncRecoveryPath(recoveryPendingPath(dbPath));
    syncRecoveryPath(dirname(dbPath));
    return;
  }
  const fd = openSync(recoveryPendingPath(dbPath), "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ preservedDirectory }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncRecoveryPath(dirname(dbPath));
}

export function finishDatabaseRecovery(dbPath: string): void {
  unlinkSync(recoveryPendingPath(dbPath));
  syncRecoveryPath(dirname(dbPath));
}
