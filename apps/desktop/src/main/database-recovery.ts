import Database from "better-sqlite3";
import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseOpenFault, DatabaseSafetyCopy } from "../ipc/contract";
import { assertDatabaseHeader, openVolliDb } from "@volli/host-core/db";
import { SCHEMA_HEAD } from "@volli/host-core/db/migrations";
import {
  DatabaseFromNewerVersionError,
  checkSchemaCompatibility,
} from "@volli/host-core/db/schema-compatibility";
import { migrationBackupCandidatePattern } from "@volli/host-core/db/backup-retention";
import { acquireDatabaseOpenLock } from "@volli/host-core/db/open-lock";
import {
  beginDatabaseRecovery,
  finishDatabaseRecovery,
  hasPendingDatabaseRecovery,
  recoveryPendingPath,
  syncRecoveryPath,
} from "@volli/host-core/db/recovery-pending";
import { DATABASE_RECOVERY_IPC } from "./ipc-descriptors";
import { registerGuardedIpcHandlers } from "./ipc-registry";

class RecoveryFailure extends Error {}

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
    let openLock: Database.Database;
    try {
      openLock = acquireDatabaseOpenLock(this.options.dbPath);
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_BUSY")
        throw new RecoveryFailure(
          "The database is being opened by another Volli instance. Close other Volli instances before restoring.",
        );
      throw error;
    }
    try {
      return this.restoreCopy(selected);
    } finally {
      openLock.close();
    }
  }

  private restoreCopy(selected: DatabaseSafetyCopy): string {
    const { dbPath, userData } = this.options;
    const name = basename(dbPath);
    const stageDirectory = mkdtempSync(join(userData, `${name}.restore-`));
    const stagedPath = join(stageDirectory, name);
    let savedDirectory: string | undefined;
    const moved: string[] = [];
    let installed = false;
    let verified = false;
    let damaged: Database.Database | undefined;
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

      // Preserve BEFORE checkpoint too: even a failed checkpoint can have
      // modified pages. Both raw evidence and the post-checkpoint bundle survive.
      savedDirectory = mkdtempSync(join(userData, `${name}.damaged-`));
      const rawDirectory = join(savedDirectory, "before-checkpoint");
      mkdirSync(rawDirectory);
      const suffixes = ["", "-wal", "-shm", "-journal"];
      for (const suffix of suffixes) {
        const source = `${dbPath}${suffix}`;
        if (!existsSync(source)) continue;
        regularFile(source);
        const saved = join(rawDirectory, `${name}${suffix}`);
        copyFileSync(source, saved, constants.COPYFILE_EXCL);
        syncRecoveryPath(saved);
      }
      syncRecoveryPath(rawDirectory);
      syncRecoveryPath(savedDirectory);
      // Durable intent precedes ANY displacement. An interruption/failed rollback
      // now fails boot closed instead of silently creating an empty profile.
      beginDatabaseRecovery(dbPath, basename(savedDirectory));
      // A checkpoint alone does not exclude idle connections. Acquire and HOLD
      // SQLite's exclusive file ownership through preservation and publication.
      // If corruption prevents ownership, refuse rather than detach a live writer.
      if (existsSync(dbPath)) {
        // Failed SQLite ownership acquisition can delete malformed WAL/SHM on
        // close. A non-SQLite header must fail before creating that connection.
        assertDatabaseHeader(dbPath);
        damaged = new Database(dbPath, { fileMustExist: true });
        damaged.pragma("busy_timeout = 5000");
        damaged.pragma("locking_mode = EXCLUSIVE");
        try {
          damaged.exec("BEGIN EXCLUSIVE; COMMIT");
        } catch (error) {
          if ((error as { code?: string }).code === "SQLITE_BUSY")
            throw new RecoveryFailure(
              "The database is in use. Close other Volli instances before restoring.",
            );
          throw error;
        }
      }
      if (damaged !== undefined) this.checkpoint(damaged);
      for (const suffix of suffixes) {
        const source = `${dbPath}${suffix}`;
        if (!existsSync(source)) continue;
        regularFile(source);
        renameSync(source, join(savedDirectory, `${name}${suffix}`));
        moved.push(suffix);
      }
      // Persist the post-checkpoint bundle's new names before publication too.
      syncRecoveryPath(savedDirectory);
      syncRecoveryPath(userData);
      // Exclusive atomic publication, with no partially copied live database.
      linkSync(stagedPath, dbPath);
      installed = true;
      // Re-open the installed file, not just the staging copy. It is already at
      // the current schema, so this cannot prune the original migration copies.
      const restored = openVolliDb(dbPath, { allowPendingRecovery: true });
      try {
        if (!checksClean(restored))
          throw new Error("The restored database failed its integrity check.");
        this.checkpoint(restored);
      } finally {
        restored.close();
      }
      // Release the old inode before allowing other app instances to boot.
      damaged?.close();
      damaged = undefined;
      syncRecoveryPath(dbPath);
      syncRecoveryPath(savedDirectory);
      syncRecoveryPath(userData);
      verified = true;
      finishDatabaseRecovery(dbPath);
      console.info("[database recovery] restored", {
        backup: selected.name,
        preserved: savedDirectory,
      });
      return selected.name;
    } catch (error) {
      if (verified) {
        // The replacement is already durable. A marker cleanup failure must not
        // undo it after the boot guard may have been removed.
        console.error("[database recovery] finalization failed", error);
        throw new RecoveryFailure(
          "The backup was restored and checked, but recovery could not be finalized. Your original files and safety copies are preserved for manual recovery.",
        );
      }
      if (savedDirectory !== undefined) {
        try {
          // Keep a failed installed copy as evidence as well; never overwrite a
          // database while putting the original bundle back.
          if (installed) {
            for (const suffix of ["", "-wal", "-shm", "-journal"]) {
              if (existsSync(`${dbPath}${suffix}`))
                renameSync(`${dbPath}${suffix}`, join(savedDirectory, `failed-restore${suffix}`));
            }
          }
          // Hard links are exclusive and do not allocate another DB-sized file:
          // a full disk cannot force a second full-data copy just to roll back.
          for (const suffix of moved)
            linkSync(join(savedDirectory, `${name}${suffix}`), `${dbPath}${suffix}`);
        } catch (rollbackError) {
          console.error("[database recovery] rollback failed", {
            savedDirectory,
            error: rollbackError,
          });
          throw new RecoveryFailure(
            "Restore failed. The original database files are preserved for manual recovery, but could not be put back. Volli remains unavailable.",
          );
        }
      }
      console.error("[database recovery] failed", error);
      throw new RecoveryFailure(
        `Restore failed. Your original database and safety copies are preserved for manual recovery.${error instanceof RecoveryFailure ? ` ${error.message}` : ""}`,
      );
    } finally {
      damaged?.close();
      try {
        rmSync(stageDirectory, { recursive: true, force: true });
      } catch (error) {
        // A leftover private staging directory must not turn a verified restore
        // into a reported failure or prevent the restart that completes recovery.
        console.error("[database recovery] staging cleanup failed", { stageDirectory, error });
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

export function registerDatabaseRecoveryIpcHandlers(
  options: DatabaseRecoveryOptions & {
    degraded: boolean;
    /**
     * Which recovery screen the renderer shows (VC-602): `newer-version` when
     * the database is from a newer Volli this build refused to open.
     */
    fault: DatabaseOpenFault;
    restart: () => void;
    /** Quits the app from the recovery screen. */
    quit: () => void;
  },
): void {
  const recovery = new DatabaseRecovery(options);
  let restored = false;
  const degraded = (): void => {
    if (!options.degraded)
      throw new Error("Backup recovery is only available when the database failed to open.");
  };
  const available = (): void => {
    degraded();
    if (restored) throw new Error("The database has been restored. Volli is restarting.");
  };
  registerGuardedIpcHandlers(DATABASE_RECOVERY_IPC, {
    "volli:database-recovery-fault": () => {
      degraded();
      return { ok: true, fault: options.fault };
    },
    "volli:database-recovery-quit": () => {
      degraded();
      options.quit();
      return { ok: true };
    },
    "volli:database-recovery-list": () => {
      available();
      try {
        return { ok: true, backups: recovery.list() };
      } catch (error) {
        console.error("[database recovery] could not list safety copies", error);
        return {
          ok: false,
          error:
            "Local safety copies could not be checked. Nothing was changed. Your files are preserved for manual recovery.",
        };
      }
    },
    "volli:database-recovery-restore": () => {
      available();
      let restoredBackup: string;
      try {
        restoredBackup = recovery.restore();
      } catch (error) {
        console.error("[database recovery] restore unavailable", error);
        return {
          ok: false,
          error:
            error instanceof RecoveryFailure ||
            (error instanceof Error && error.message === NO_CLEAN_BACKUP)
              ? error.message
              : "Restore could not start. Nothing was restored. Your files are preserved for manual recovery.",
        };
      }
      restored = true;
      options.restart();
      return { ok: true, restoredBackup };
    },
  });
}
