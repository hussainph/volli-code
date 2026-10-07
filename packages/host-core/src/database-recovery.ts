import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSafetyCopy } from "@volli/shared";
import {
  DatabaseFileBusyError,
  DatabaseSwapFinalizeError,
  DatabaseSwapRollbackError,
  hasPendingDatabaseRecovery,
  openVolliDb,
  recoveryPendingPath,
  swapInStagedProfile,
} from "./db/database-file";
import type { DatabaseFileFaults } from "./db/database-file";
import { SCHEMA_HEAD } from "./db/migrations";
import { DatabaseFromNewerVersionError, checkSchemaCompatibility } from "./db/schema-compatibility";
import { migrationBackupCandidatePattern } from "./db/backup-retention";
import { hostLogger } from "./log/root";

const log = hostLogger("database-recovery");

export class RecoveryFailure extends Error {}

export const NO_CLEAN_BACKUP =
  "No local backup checks clean. Nothing was restored. Your database and safety copies are preserved for manual recovery.";

function existsSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function regularFile(path: string): void {
  if (!lstatSync(path).isFile())
    throw new Error("Recovery requires regular local files, not links or directories.");
}

function checksClean(db: Database.Database): boolean {
  const rows = db.pragma("quick_check") as { quick_check: string }[];
  return rows.length === 1 && rows[0]?.quick_check === "ok";
}

/** In-memory checks cannot write to a safety copy or create its WAL/SHM files. */
function integrity(path: string): DatabaseSafetyCopy["integrity"] {
  let db: Database.Database | undefined;
  try {
    regularFile(path);
    // Read-only verification can leave an empty WAL and SHM cache (VC-520).
    // Those contain no durable frames. Never ignore a nonempty journal or follow
    // a sidecar link; a backup requiring journal replay needs manual recovery.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${path}${suffix}`;
      if (!existsSync(sidecar)) continue;
      regularFile(sidecar);
      if (suffix !== "-shm" && lstatSync(sidecar).size !== 0) return "unavailable";
    }
    const bytes = readFileSync(path);
    if (bytes.length < 100 || bytes.subarray(0, 16).toString() !== "SQLite format 3\0")
      return "damaged";
    // A checkpointed WAL file still carries WAL read/write flags. SQLite's
    // deserialize API cannot open WAL images; normalize ONLY this disposable
    // buffer to rollback journaling. The on-disk copy stays byte-for-byte intact.
    if (bytes[18] === 2 && bytes[19] === 2) {
      bytes[18] = 1;
      bytes[19] = 1;
    }
    db = new Database(bytes);
    if (!checksClean(db)) return "damaged";
    // A clean copy this build would refuse to open (VC-602) is not one it can
    // restore: the boot check would refuse it all over again.
    checkSchemaCompatibility(db, SCHEMA_HEAD);
    return "clean";
  } catch (error) {
    if (error instanceof DatabaseFromNewerVersionError) return "newer";
    const code = (error as { code?: string }).code;
    return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB" ? "damaged" : "unavailable";
  } finally {
    db?.close();
  }
}

export interface DatabaseRecoveryOptions {
  dbPath: string;
  userData: string;
  /** Crash tests only: stop the database-file swap at a named step. */
  faults?: DatabaseFileFaults;
}

/** No renderer-provided paths: all candidates come from one exact-name directory allowlist. */
export class DatabaseRecovery {
  constructor(private readonly options: DatabaseRecoveryOptions) {}

  private scope(): void {
    const { dbPath, userData } = this.options;
    if (
      resolve(dirname(dbPath)) !== resolve(userData) ||
      realpathSync(dirname(dbPath)) !== realpathSync(userData)
    ) {
      throw new Error("Backup recovery is only available for the local user-data database.");
    }
    const pending = hasPendingDatabaseRecovery(dbPath);
    if (pending) regularFile(recoveryPendingPath(dbPath));
    // An interrupted switch may have moved the live pathname away. Boot is
    // blocked by the durable marker; the remaining safety copies can still heal it.
    if (existsSync(dbPath)) regularFile(dbPath);
    else if (!pending) throw new Error("The local database is missing.");
  }

  list(): DatabaseSafetyCopy[] {
    this.scope();
    const { dbPath } = this.options;
    const pattern = migrationBackupCandidatePattern(dbPath);
    return readdirSync(dirname(dbPath))
      .flatMap((name): DatabaseSafetyCopy[] => {
        // VC-520 preserves same-version originals/quarantines under UUID names.
        // They are still safety copies; a transient check failure may check clean
        // later. Strip only that exact suffix before the directory allowlist.
        const baseName = name.replace(
          /\.(?:preserved|corrupt)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/,
          "",
        );
        const match = pattern.exec(baseName);
        if (match === null || match[2] !== undefined) return [];
        const path = join(dirname(dbPath), name);
        try {
          return [{ name, modifiedAt: lstatSync(path).mtimeMs, integrity: integrity(path) }];
        } catch {
          return [{ name, modifiedAt: 0, integrity: "unavailable" }];
        }
      })
      .toSorted((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  }

  restore(): string {
    const selected = this.list().find((backup) => backup.integrity === "clean");
    if (selected === undefined) throw new Error(NO_CLEAN_BACKUP);
    const { dbPath, userData } = this.options;
    const name = basename(dbPath);
    const stageDirectory = mkdtempSync(join(userData, `${name}.restore-`));
    const stagedPath = join(stageDirectory, name);
    try {
      // Upgrade in isolation: the ordinary migration runner may overwrite/prune
      // safety copies, so it must never run beside the user's original backups.
      copyFileSync(join(userData, selected.name), stagedPath, constants.COPYFILE_EXCL);
      if (integrity(stagedPath) !== "clean")
        throw new Error("The selected backup no longer checks clean. Nothing was restored.");
      const staged = openVolliDb(stagedPath);
      try {
        if (!checksClean(staged))
          throw new Error("The backup failed its integrity check after migration.");
        this.checkpoint(staged);
      } finally {
        staged.close();
      }
      // The fenced swap: open lock, durable intent, raw evidence, exclusive
      // ownership, atomic publication, and a re-check of the installed file.
      const savedDirectory = join(userData, `${name}.damaged-${randomUUID().slice(0, 8)}`);
      swapInStagedProfile({
        dbPath,
        stagedPath,
        asideDirectory: savedDirectory,
        replacing: "damaged",
        faults: this.options.faults,
      });
      log.info("database restored from backup", {
        backup: selected.name,
        preserved: savedDirectory,
      });
      return selected.name;
    } catch (error) {
      if (error instanceof DatabaseFileBusyError && error.phase === "opening")
        throw new RecoveryFailure(
          "The database is being opened by another Volli instance. Close other Volli instances before restoring.",
        );
      if (error instanceof DatabaseSwapFinalizeError) {
        // The replacement is already durable. A marker cleanup failure must not
        // undo it after the boot guard may have been removed.
        log.error("restore finalization failed", { error });
        throw new RecoveryFailure(
          "The backup was restored and checked, but recovery could not be finalized. Your original files and safety copies are preserved for manual recovery.",
        );
      }
      if (error instanceof DatabaseSwapRollbackError) {
        log.error("restore rollback failed", {
          savedDirectory: error.asideDirectory,
          error: error.cause,
        });
        throw new RecoveryFailure(
          "Restore failed. The original database files are preserved for manual recovery, but could not be put back. Volli remains unavailable.",
        );
      }
      log.error("restore failed", { error });
      const reason =
        error instanceof DatabaseFileBusyError
          ? " The database is in use. Close other Volli instances before restoring."
          : error instanceof RecoveryFailure
            ? ` ${error.message}`
            : "";
      throw new RecoveryFailure(
        `Restore failed. Your original database and safety copies are preserved for manual recovery.${reason}`,
      );
    } finally {
      try {
        rmSync(stageDirectory, { recursive: true, force: true });
      } catch (error) {
        // A leftover private staging directory must not turn a verified restore
        // into a reported failure or prevent the restart that completes recovery.
        log.error("staging cleanup failed", { stageDirectory, error });
      }
    }
  }

  private checkpoint(db: Database.Database): void {
    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (rows.length !== 1 || rows[0]?.busy !== 0)
      throw new RecoveryFailure(
        "The database is in use. Close other Volli instances before restoring.",
      );
  }
}
