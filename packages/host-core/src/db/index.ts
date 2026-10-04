import Database from "better-sqlite3";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { migrate, SCHEMA_HEAD } from "./migrations";
import { acquireDatabaseOpenLock } from "./open-lock";
import { assertNoPendingDatabaseRecovery } from "./recovery-pending";
import { checkSchemaCompatibility } from "./schema-compatibility";
import type { SchemaCompatibility } from "./schema-compatibility";
import { guardTransactionOwnership, logTransactionViolation } from "./transaction-gate";
import type { TransactionViolationHandler } from "./transaction-gate";

export function assertDatabaseHeader(dbPath: string): void {
  // SQLite can update SHM even on a read-only handle. Reject a broken header
  // without invoking SQLite, preserving malformed sidecars as raw evidence.
  const fd = openSync(dbPath, "r");
  const header = Buffer.alloc(100);
  let bytesRead: number;
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (bytesRead !== header.length || header.subarray(0, 16).toString() !== "SQLite format 3\0") {
    throw new Error(
      "The local database has a damaged header. Restore from the last backup that checks clean.",
    );
  }
}

/**
 * Opens (creating if absent) the Volli SQLite database at `dbPath`, applies
 * the pragmas migration 001 assumes — WAL journaling, foreign keys ON, a
 * busy timeout so a brief writer/reader overlap blocks instead of erroring,
 * NORMAL synchronous (safe under WAL) — plus the read-tuning pragmas
 * (VC-355): a 64 MB page cache, 256 MB of memory-mapped I/O, and in-memory
 * temp storage, so reads over a large history avoid the OS round-trip and
 * sorts/hashes stay off disk. The WAL itself is bounded by an aggressive
 * `wal_autocheckpoint` (see below) and, when migrations run, a bounded ANALYZE
 * refreshes the planner statistics without making routine opens write.
 *
 * Runs any pending migrations — unless the file is from a newer build
 * (VC-602). Before anything opens it for writing, the read-only preflight
 * compares its `user_version` and minimum reader version with this build's
 * schema head (`schema-compatibility.ts`): a newer, compatible file opens
 * with no migration and its `user_version` untouched, and a newer,
 * incompatible one throws `DatabaseFromNewerVersionError` with the file
 * byte-for-byte as it was.
 * The parent directory must already exist; `src/main/index.ts` creates it
 * (and catches everything this throws) before calling in, since that's also
 * where the open+migrate failure is turned into the degraded IPC story.
 */
export function openVolliDb(
  dbPath: string,
  options: {
    allowPendingRecovery?: boolean;
    /** Tests/dev opt into failure; packaged startup explicitly uses logging. */
    onTransactionViolation?: TransactionViolationHandler;
  } = {},
): Database.Database {
  // A crash or full disk during publication must never turn a missing live
  // pathname into an apparently successful, empty first-run database.
  if (!options.allowPendingRecovery) assertNoPendingDatabaseRecovery(dbPath);
  // Hold the startup mutex across construction AND first SQLite operations.
  // Recovery holds the same mutex through publication, so a dormant boot
  // handle cannot resume against a different inode after a successful restore.
  const openLock = options.allowPendingRecovery ? undefined : acquireDatabaseOpenLock(dbPath);
  try {
    if (!options.allowPendingRecovery) assertNoPendingDatabaseRecovery(dbPath);
    let compatibility: SchemaCompatibility | undefined;
    if (existsSync(dbPath)) {
      // Read-only preflight cannot checkpoint/delete a damaged WAL on close or
      // overwrite a clean migration safety copy before recovery becomes available.
      assertDatabaseHeader(dbPath);
      const check = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = check.pragma("quick_check") as { quick_check: string }[];
        if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
          throw new Error(
            "The local database failed its integrity check. Restore from the last backup that checks clean.",
          );
        }
        // The downgrade guard, on the read-only handle: a refusal leaves the
        // file exactly as it was — no writable handle, no WAL checkpoint, no
        // migration safety copy.
        compatibility = checkSchemaCompatibility(check, SCHEMA_HEAD);
      } finally {
        check.close();
      }
    }
    const db = new Database(dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      db.pragma("synchronous = NORMAL");
      // VC-355 read tuning. `cache_size` is negative = KiB (64 MB); `mmap_size`
      // lets SQLite read pages straight from the page cache of the OS. Both are
      // per-handle and harmless on a small database — they only set ceilings.
      db.pragma("cache_size = -64000");
      db.pragma("mmap_size = 268435456");
      db.pragma("temp_store = MEMORY");
      // Bound the WAL: checkpoint (and restart from zero) once it passes 400
      // pages (~1.6 MB at the 4 KiB page size migration 001 assumes). The default
      // 1000 already exists, but the session ledger appends densely and a smaller
      // ceiling keeps the WAL file itself from dominating a 260k-event history's
      // disk footprint while the automatic checkpoint still amortizes to a page
      // or two per commit.
      db.pragma("wal_autocheckpoint = 400");
      if (compatibility?.newer === true) {
        console.warn(
          `[volli] database schema ${compatibility.schemaVersion} is newer than this build's ${SCHEMA_HEAD} and declares it compatible; opening without migrating.`,
        );
      }
      const migrated = migrate(db, dbPath);
      // Post-migration, so it sees the final schema. A bounded ANALYZE
      // (`analysis_limit` keeps each table's scan proportional — SQLite's own
      // recommendation for routine maintenance) keeps a migration from leaving
      // the planner blind. Do not repeat it on a routine open: ANALYZE takes a
      // write lock and changes sqlite_stat1 even when application data did not.
      if (migrated) {
        db.pragma("analysis_limit = 1000");
        db.exec("ANALYZE");
      }
      guardTransactionOwnership(db, options.onTransactionViolation ?? logTransactionViolation);
      return db;
    } catch (error) {
      // A degraded boot must not leave a writer alive during backup recovery.
      db.close();
      throw error;
    }
  } finally {
    openLock?.close();
  }
}
