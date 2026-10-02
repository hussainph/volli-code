import { lstatSync } from "node:fs";
import Database from "better-sqlite3";

/** Check every result: SQLite can return multiple diagnostic rows without throwing. */
export function assertDatabaseIntegrity(db: Pick<Database.Database, "pragma">): void {
  const result = db.pragma("quick_check") as unknown;
  if (
    !Array.isArray(result) ||
    result.length !== 1 ||
    typeof result[0] !== "object" ||
    result[0] === null ||
    (result[0] as Record<string, unknown>).quick_check !== "ok"
  ) {
    throw new Error(`PRAGMA quick_check failed: ${JSON.stringify(result)}`);
  }
}

/** Never create a missing file, follow a symlink, or accept an empty SQLite database. */
export function verifyMigrationBackup(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.size === 0) {
    throw new Error("safety copy is not a non-empty regular file");
  }
  // SQLite also opens sidecars, and may update SHM even on a readonly handle.
  // Reject links/non-files before SQLite can follow them outside this directory.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      if (!lstatSync(`${path}${suffix}`).isFile()) {
        throw new Error(`safety copy sidecar ${suffix} is not a regular file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(db);
  } finally {
    db.close();
  }
}
