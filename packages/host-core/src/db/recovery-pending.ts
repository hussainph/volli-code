import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";

export interface DatabaseRecoveryIntent {
  preservedDirectory: string;
  restore?: { sourcePath: string; schemaVersion: number };
}

/** Metadata is advisory: a malformed old marker still fences boot and can be retried. */
export function readDatabaseRecoveryIntent(dbPath: string): DatabaseRecoveryIntent | undefined {
  let fd: number;
  try {
    // Validate and read the same inode; never follow a marker symlink or reopen
    // a pathname that may have been replaced after checking its file type.
    fd = openSync(recoveryPendingPath(dbPath), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(fd, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
    if (value === null || typeof value !== "object") return undefined;
    const intent = value as Partial<DatabaseRecoveryIntent>;
    if (
      typeof intent.preservedDirectory !== "string" ||
      intent.preservedDirectory.length === 0 ||
      basename(intent.preservedDirectory) !== intent.preservedDirectory ||
      intent.preservedDirectory === "." ||
      intent.preservedDirectory === ".."
    ) {
      return undefined;
    }
    const restore = intent.restore;
    return {
      preservedDirectory: intent.preservedDirectory,
      ...(restore !== null &&
      typeof restore === "object" &&
      typeof restore.sourcePath === "string" &&
      restore.sourcePath.length > 0 &&
      Number.isSafeInteger(restore.schemaVersion) &&
      restore.schemaVersion > 0
        ? { restore }
        : {}),
    };
  } finally {
    closeSync(fd);
  }
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

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
    const restore = readDatabaseRecoveryIntent(dbPath)?.restore;
    const command = `volli-hostd database restore --data-dir ${shellQuote(dirname(dbPath))} --from ${restore ? shellQuote(restore.sourcePath) : "<same-source>"} --schema ${restore?.schemaVersion ?? "<same-schema>"} --yes`;
    throw new Error(
      `A database restore was interrupted. Keep hostd stopped and retry: \`${command}\`. Your original files are preserved for manual recovery. For desktop recovery, restore from the last backup that checks clean.`,
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

export function beginDatabaseRecovery(
  dbPath: string,
  preservedDirectory: string,
  restore?: DatabaseRecoveryIntent["restore"],
): void {
  if (hasPendingDatabaseRecovery(dbPath)) {
    // A retry may inherit a marker whose first directory fsync failed. Re-fence
    // BOTH its existence and this attempt's new preservation directory entry.
    syncRecoveryPath(recoveryPendingPath(dbPath));
    syncRecoveryPath(dirname(dbPath));
    return;
  }
  const fd = openSync(recoveryPendingPath(dbPath), "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ preservedDirectory, ...(restore ? { restore } : {}) }));
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
