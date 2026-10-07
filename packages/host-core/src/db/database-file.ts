/**
 * The database file: the one module that may put a file at the Volli database
 * path, or publish a copy of one (VC-628).
 *
 * Three operations need to replace or copy the live file: opening it (which
 * creates it on first run), the migration safety copy, and swapping in a
 * staged database (backup recovery, and a bundle restore's profile
 * activation). Each has the same crash rules, and they live here once:
 *
 * - **The open lock** (`open-lock.ts`) serializes boot against a swap, so a
 *   dormant boot handle cannot resume against a different inode.
 * - **The intent marker** (`recovery-pending.ts`) is durable before anything
 *   is displaced. While it exists, {@link openVolliDb} refuses to open, so an
 *   interruption can never turn a missing or half-swapped live path into an
 *   apparently successful, empty first-run database.
 * - **fsync** of every file before a name points at it, and of every
 *   directory after its entries change, so a power loss cannot leave a name
 *   pointing at torn content.
 * - **Sidecars** (`-wal`, `-shm`, `-journal`) move with their base and never
 *   attach to a different one. A swap first takes SQLite's exclusive
 *   ownership of the live file and checkpoints it, so its base stands alone;
 *   the base then gains a second name in the set-aside directory and STAYS at
 *   the live path until the staged file replaces it with one atomic rename.
 *   The live path is never empty.
 *
 * Every step that changes the disk first calls the optional
 * {@link DatabaseFileFaults} hook with its name. A throw there is, to this
 * module, indistinguishable from an I/O failure at that point; a crash test
 * copies the directory inside the hook to see exactly what a power cut there
 * would leave (`database-file.test.ts`). Production callers never pass one.
 *
 * Nothing outside this module imports the lock or the marker
 * (`database-file-boundary.test.ts`).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { verifyMigrationBackup } from "./backup-integrity";
import { assertMigrationDiskSpace } from "./disk-preflight";
import { checkMigrationHistory, describeMigrationHistory } from "./migration-history";
import { migrate, SCHEMA_HEAD } from "./migrations";
import { acquireDatabaseOpenLock } from "./open-lock";
import {
  assertNoPendingDatabaseRecovery,
  beginDatabaseRecovery,
  finishDatabaseRecovery,
  hasPendingDatabaseRecovery,
  readDatabaseRecoveryIntent,
  recoveryPendingPath,
  syncRecoveryPath,
} from "./recovery-pending";
import { checkSchemaCompatibility, DatabaseFromNewerVersionError } from "./schema-compatibility";
import type { SchemaCompatibility } from "./schema-compatibility";
import { guardTransactionOwnership, logTransactionViolation } from "./transaction-gate";
import type { TransactionViolationHandler } from "./transaction-gate";
import { hostLogger } from "../log/root";

// Read-only questions about the fence, for recovery's listing.
export { hasPendingDatabaseRecovery, recoveryPendingPath };

const log = hostLogger("db");
/** Rollback-point lines share the retention pass's component: one vocabulary for the copies. */
const retentionLog = hostLogger("backup-retention");

/** A named point, just before a change to the disk, where a test may stop the operation. */
export type DatabaseFileStep =
  | "rollback-point:copy"
  | `rollback-point:preserve${"" | "-wal" | "-shm" | "-journal"}`
  | "rollback-point:preserve-sync"
  | `rollback-point:release${"" | "-wal" | "-shm" | "-journal"}`
  | "rollback-point:release-sync"
  | "rollback-point:publish"
  | "rollback-point:sync"
  | "swap:lock"
  | "swap:preserve-raw"
  | "swap:mark"
  | "swap:own"
  | `swap:set-aside:${string}`
  | `swap:install:${string}`
  | "swap:publish"
  | "swap:verify"
  | "swap:finish"
  | `swap:rollback:${string}`;

/**
 * Called before each step that changes the disk. A throw is treated exactly as
 * an I/O failure at that step. Crash tests only; production never passes one.
 */
export type DatabaseFileFaults = (step: DatabaseFileStep) => void;

const noFaults: DatabaseFileFaults = () => {};

const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const FAMILY = ["", ...SIDECARS] as const;

/** Another SQLite connection holds the file the operation needs to own. */
export class DatabaseFileBusyError extends Error {
  constructor(
    /** `opening`: another boot holds the open lock. `in-use`: a live connection holds the file. */
    readonly phase: "opening" | "in-use",
    options?: ErrorOptions,
  ) {
    super(
      phase === "opening"
        ? "The database is being opened by another Volli instance."
        : "The database is in use.",
      options,
    );
    this.name = "DatabaseFileBusyError";
  }
}

/**
 * A swap failed, and putting the original back failed too. The intent marker
 * stays, so boot refuses instead of creating an empty profile; the original
 * files are in {@link asideDirectory}.
 */
export class DatabaseSwapRollbackError extends Error {
  constructor(
    readonly asideDirectory: string,
    options?: ErrorOptions,
  ) {
    super(
      `The swap failed and the original database could not be put back. It is preserved in ${asideDirectory}.`,
      options,
    );
    this.name = "DatabaseSwapRollbackError";
  }
}

/**
 * The staged database is installed, checked and durable, but the intent
 * marker could not be cleared. Undoing a verified install is never the answer.
 */
export class DatabaseSwapFinalizeError extends Error {
  constructor(options?: ErrorOptions) {
    super("The swap was installed and checked, but could not be finalized.", options);
    this.name = "DatabaseSwapFinalizeError";
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** fsync a file, or a directory tree bottom-up: children before their directory. */
function syncTree(path: string): void {
  const info = lstatSync(path);
  if (info.isDirectory()) {
    for (const name of readdirSync(path)) syncTree(join(path, name));
  } else if (!info.isFile()) {
    return;
  }
  syncRecoveryPath(path);
}

function regularFile(path: string): void {
  if (!lstatSync(path).isFile())
    throw new Error("Recovery requires regular local files, not links or directories.");
}

function isBusy(error: unknown): boolean {
  return (error as { code?: string }).code === "SQLITE_BUSY";
}

function checkpoint(db: Database.Database): void {
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (rows.length !== 1 || rows[0]?.busy !== 0) throw new DatabaseFileBusyError("in-use");
}

function checksClean(db: Database.Database): boolean {
  const rows = db.pragma("quick_check") as { quick_check: string }[];
  return rows.length === 1 && rows[0]?.quick_check === "ok";
}

/**
 * A full `integrity_check`, timed and logged: on a large profile it can take
 * tens of seconds, so it runs only before deleting pending copies, which only
 * an interrupted rollback-point publish leaves. Anything but exactly `ok`,
 * including a throw, is not clean.
 */
function checksFullyClean(db: Database.Database, dbPath: string): boolean {
  const started = performance.now();
  let clean = false;
  let error: unknown;
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    clean = rows.length === 1 && rows[0]?.integrity_check === "ok";
  } catch (caught) {
    error = caught;
  }
  retentionLog.info("live database integrity checked", {
    action: "checked-live",
    check: "integrity_check",
    name: basename(dbPath),
    clean,
    durationMs: Math.round(performance.now() - started),
    ...(error === undefined ? {} : { error }),
  });
  return clean;
}

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

/** `user_version`, from the header bytes: no SQLite handle, no sidecar created. */
function stagedSchemaVersion(path: string): number {
  assertDatabaseHeader(path);
  const fd = openSync(path, "r");
  const field = Buffer.alloc(4);
  try {
    readSync(fd, field, 0, 4, 60);
  } finally {
    closeSync(fd);
  }
  return field.readInt32BE(0);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * The read-only checks an existing live file passes before anything opens it
 * for writing. A read-only handle cannot checkpoint/delete a damaged WAL on
 * close or overwrite a clean migration safety copy before recovery becomes
 * available.
 *
 * With `fullCheck` (only when pending copies would be deleted on its word),
 * also runs a full `integrity_check`, which `quick_check` is not: it checks
 * that every index agrees with its table. `fullyClean` is its verdict; a
 * failure there does not refuse the boot, since the routine preflight never
 * asked it, but it keeps the pending copies.
 */
function preflight(
  dbPath: string,
  fullCheck: boolean,
): { compatibility: SchemaCompatibility; fullyClean: boolean | undefined } {
  assertDatabaseHeader(dbPath);
  const check = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!checksClean(check)) {
      throw new Error(
        "The local database failed its integrity check. Restore from the last backup that checks clean.",
      );
    }
    // The downgrade guard, on the read-only handle. A refusal opens no
    // writable handle, checkpoints nothing and takes no safety copy: the db
    // file and its WAL stay byte-identical; `-shm`, an index with no data, may
    // be created or reset by SQLite's read-only reader, exactly as the
    // preflight above already does.
    const compatibility = checkSchemaCompatibility(check, SCHEMA_HEAD);
    return { compatibility, fullyClean: fullCheck ? checksFullyClean(check, dbPath) : undefined };
  } finally {
    check.close();
  }
}

/**
 * Compares the file's applied-migration history with this build's lock
 * (VC-633) and logs one named line when another lineage migrated it. Never
 * refuses and never throws: a diverged file still opens (see
 * `migration-history.ts` for why), and a history that cannot be read is
 * reported the same way rather than failing the boot.
 */
function warnOnDivergedHistory(db: Database.Database): void {
  let summary: string;
  try {
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    if (report.consistent) return;
    summary = describeMigrationHistory(report);
  } catch (error) {
    log.warn("migration history could not be read", { error });
    return;
  }
  log.warn("migration history diverged", { summary });
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
 * byte-for-byte as it was. The free-space preflight (`disk-preflight.ts`)
 * runs at the same point, before the writable open, so an
 * `InsufficientDiskSpaceError` also leaves the file and its WAL unchanged.
 *
 * Refuses while a swap's intent marker exists, so a crash mid-swap fails
 * boot closed rather than creating an empty first-run database at a path the
 * swap had not finished filling.
 *
 * Removes the unpublished copies a dead migration attempt left behind only
 * once the live file exists, passes the preflight and passes a full
 * `integrity_check` (run only when such copies exist). If it is missing or
 * fails the preflight, they are kept and the refusal names them: one may be
 * the only intact copy of the database, and a missing live file beside one is
 * never a first run. If only the full check fails, the boot goes on as it
 * would without them, and they are kept and named in a warning.
 *
 * The parent directory must already exist; the host creates it (and catches
 * everything this throws) before calling in, since that's also where the
 * open+migrate failure is turned into the degraded IPC story.
 */
export function openVolliDb(
  dbPath: string,
  options: {
    /** The caller already holds the fence: a swap verifying what it installed. */
    allowPendingRecovery?: boolean;
    /** Tests/dev opt into failure; packaged startup explicitly uses logging. */
    onTransactionViolation?: TransactionViolationHandler;
  } = {},
): Database.Database {
  // A crash or full disk during publication must never turn a missing live
  // pathname into an apparently successful, empty first-run database.
  if (!options.allowPendingRecovery) assertNoPendingDatabaseRecovery(dbPath);
  // Hold the startup mutex across construction AND first SQLite operations.
  // A swap holds the same mutex through publication, so a dormant boot
  // handle cannot resume against a different inode after a successful swap.
  const openLock = options.allowPendingRecovery ? undefined : acquireDatabaseOpenLock(dbPath);
  try {
    // Under the lock no rollback point is being published: any pending copy
    // is from an attempt that died before it could publish. It may still be
    // the only intact copy of the database, so it is only listed here, and
    // removed below once the live file has passed a full integrity check.
    if (!options.allowPendingRecovery) assertNoPendingDatabaseRecovery(dbPath);
    const abandoned = options.allowPendingRecovery ? [] : abandonedRollbackCopies(dbPath);
    let compatibility: SchemaCompatibility | undefined;
    let fullyClean: boolean | undefined;
    if (exists(dbPath)) {
      try {
        ({ compatibility, fullyClean } = preflight(dbPath, abandoned.length > 0));
      } catch (error) {
        throw keepingAbandonedCopies(error, abandoned);
      }
    } else if (abandoned.length > 0) {
      // A missing live file beside an unpublished copy is a lost database,
      // not a first run. Creating an empty profile here would hide the copy.
      throw new Error(
        `The local database is missing, but an unpublished safety copy of it was kept: ${abandoned.join(", ")}. Nothing was created. Recover the database from that copy before starting Volli again.`,
      );
    }
    if (fullyClean === true) {
      // The live database exists and passes a full integrity check: the
      // pending copies are redundant now, and never recovery candidates.
      removeAbandonedRollbackCopies(abandoned);
    } else if (abandoned.length > 0) {
      // Usable enough to open, as on any boot, but not proven whole: a
      // pending copy may be the only intact database. Leave it for a person.
      retentionLog.warn(
        "live database failed its full integrity check; unpublished safety copies kept",
        { action: "kept-abandoned", names: abandoned },
      );
    }
    // The free-space preflight (VC-633), while nothing holds the file open for
    // writing: a writable handle's close checkpoints the WAL into the db, so a
    // refusal measured any later would no longer leave the file as it was.
    // Asked only where the runner would take a safety copy (an existing file
    // with migrations pending); it fails open when the disk cannot be measured.
    const pendingFrom = compatibility?.schemaVersion ?? 0;
    if (pendingFrom > 0 && pendingFrom < SCHEMA_HEAD) assertMigrationDiskSpace(dbPath);
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
        log.warn("database schema is newer and declares itself compatible; not migrating", {
          schemaVersion: compatibility.schemaVersion,
          schemaHead: SCHEMA_HEAD,
        });
      }
      const migrated = migrate(db, dbPath, { diskChecked: true });
      warnOnDivergedHistory(db);
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

// ---------------------------------------------------------------------------
// Publish rollback point (the migration safety copy)
// ---------------------------------------------------------------------------

type FamilySuffix = (typeof FAMILY)[number];

interface PreservedFamily {
  /** Where the old family now lives, or undefined when only stale names were released. */
  path: string | undefined;
  /** Suffixes given a second name at {@link path}, in order. */
  linked: FamilySuffix[];
  /** Suffixes whose old name was removed, in order. */
  released: FamilySuffix[];
}

function inode(path: string): string {
  const info = lstatSync(path);
  return `${info.dev}:${info.ino}`;
}

/** The inodes of every sidecar that belongs to a whole preserved family of `backupPath`. */
function preservedSidecarInodes(backupPath: string): Set<string> {
  const directory = dirname(backupPath);
  const prefix = `${basename(backupPath)}.preserved-`;
  const inodes = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const sidecar = SIDECARS.find((suffix) => name.endsWith(suffix));
    if (sidecar === undefined) continue;
    // Only a family that has its base: a base-less one is not a candidate.
    if (!exists(join(directory, name.slice(0, -sidecar.length)))) continue;
    inodes.add(inode(join(directory, name)));
  }
  return inodes;
}

/**
 * Moves the family at a rollback name (base plus any sidecars) to a fresh
 * `.preserved-<uuid>` name, so the new copy can be published there.
 *
 * By hard link, never by rename, and in this order, so that no crash between
 * any two steps can strand data or offer an incomplete database to recovery:
 *
 * 1. link the sidecars, then the base, to the preserved names; fsync the
 *    directory. A preserved base never exists without its sidecars, so
 *    recovery (which lists bases) never sees a partial family there;
 * 2. remove the old base name, then the old sidecar names; fsync the
 *    directory. The old name never holds a base without its sidecars. A crash
 *    here leaves base-less sidecars that are, provably, second names of a
 *    whole preserved family (the same inode), and the next attempt releases
 *    them. Nothing is copied, so a full disk cannot stop this half way.
 *
 * Base-less sidecars that are NOT such second names and hold data (a WAL or
 * journal with frames) are not this module's: they are refused, never
 * discarded. Ones without data (an empty WAL, an SHM index) are preserved
 * like any family.
 */
function preserveRollbackFamily(
  backupPath: string,
  faults: DatabaseFileFaults,
): PreservedFamily | undefined {
  const present = FAMILY.filter((suffix) => {
    const info = lstatSync(`${backupPath}${suffix}`, { throwIfNoEntry: false });
    if (info === undefined) return false;
    if (!info.isFile()) throw new Error("existing safety copy family is not regular files");
    return true;
  });
  if (present.length === 0) return undefined;
  const family: PreservedFamily = { path: undefined, linked: [], released: [] };
  let keep: FamilySuffix[] = present;
  if (!present.includes("")) {
    const duplicates = preservedSidecarInodes(backupPath);
    keep = [];
    for (const suffix of present) {
      const path = `${backupPath}${suffix}`;
      if (duplicates.has(inode(path))) {
        // An interrupted release: this name's data is safe in a whole
        // preserved family, so removing the name loses nothing.
        faults(`rollback-point:release${suffix}`);
        unlinkSync(path);
        continue;
      }
      if (suffix !== "-shm" && lstatSync(path).size > 0)
        throw new Error("existing safety copy family is missing its base");
      keep.push(suffix);
    }
    if (keep.length === 0) {
      faults("rollback-point:release-sync");
      syncRecoveryPath(dirname(backupPath));
      return family;
    }
  }
  family.path = `${backupPath}.preserved-${randomUUID()}`;
  const base = keep.includes("") ? (["" as const] as FamilySuffix[]) : [];
  const sidecars = keep.filter((suffix) => suffix !== "");
  try {
    for (const suffix of [...sidecars, ...base]) {
      faults(`rollback-point:preserve${suffix}`);
      linkSync(`${backupPath}${suffix}`, `${family.path}${suffix}`);
      family.linked.push(suffix);
    }
    faults("rollback-point:preserve-sync");
    syncRecoveryPath(dirname(backupPath));
    for (const suffix of [...base, ...sidecars]) {
      faults(`rollback-point:release${suffix}`);
      unlinkSync(`${backupPath}${suffix}`);
      family.released.push(suffix);
    }
    faults("rollback-point:release-sync");
    syncRecoveryPath(dirname(backupPath));
  } catch (error) {
    undoPreservation(backupPath, family);
    throw error;
  }
  return family;
}

/**
 * Best effort: give the old family its rollback name back (sidecars first,
 * base last) and make those names durable, then drop the preserved second
 * names (base first) and make that durable: the forward path's barrier, in
 * reverse, so a power cut can never persist the removals without the
 * restored names. Stopping anywhere leaves a state
 * {@link preserveRollbackFamily} resumes from.
 */
function undoPreservation(backupPath: string, family: PreservedFamily): void {
  const { path } = family;
  if (path === undefined) return;
  try {
    const released = [...family.released];
    for (const suffix of [
      ...released.filter((item) => item !== ""),
      ...released.filter((item) => item === ""),
    ]) {
      linkSync(`${path}${suffix}`, `${backupPath}${suffix}`);
    }
    syncRecoveryPath(dirname(backupPath));
    for (const suffix of [
      ...family.linked.filter((item) => item === ""),
      ...family.linked.filter((item) => item !== ""),
    ]) {
      unlinkSync(`${path}${suffix}`);
    }
    syncRecoveryPath(dirname(backupPath));
  } catch (error) {
    retentionLog.error("rollback family preservation failed", {
      action: "failed",
      operation: "preserve",
      name: path,
      error,
    });
  }
}

/**
 * A `.pending-<uuid>` copy exists only while {@link publishRollbackPoint}
 * runs, and migrations run only under the open lock. One found while holding
 * that lock is therefore from an attempt that died before publishing: the
 * migration it protected never ran. Such a copy (up to a full database in
 * size) is never a recovery candidate, but it may be the only intact copy of
 * the database left, so this only lists them; {@link openVolliDb} removes
 * them once the live database has passed a full integrity check, and names
 * them in any refusal or warning otherwise. A `.corrupt` quarantine is evidence, and is never
 * listed.
 */
function abandonedRollbackCopies(dbPath: string): string[] {
  const name = basename(dbPath).replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const uuid = "[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}";
  const pending = new RegExp(`^${name}\\.backup-v\\d+\\.pending-${uuid}(?:-wal|-shm)?$`);
  const directory = dirname(dbPath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of names.toSorted()) {
    if (!pending.test(entry)) continue;
    const path = join(directory, entry);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isFile() === true) found.push(path);
  }
  return found;
}

/** Only after the live database has passed a full integrity check: see {@link abandonedRollbackCopies}. */
function removeAbandonedRollbackCopies(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
      retentionLog.info("abandoned rollback copy removed", {
        action: "removed-abandoned",
        name: basename(path),
      });
    } catch (error) {
      retentionLog.error("abandoned rollback copy removal failed", {
        action: "failed",
        operation: "remove-abandoned",
        name: basename(path),
        error,
      });
    }
  }
}

/**
 * A refusal to open a live database that is damaged also names any pending
 * copies, which were kept and may be the only intact database left. A
 * newer-version refusal is rethrown as is: its type routes the recovery
 * screen, and the live file it guards is intact.
 */
function keepingAbandonedCopies(error: unknown, abandoned: readonly string[]): unknown {
  if (abandoned.length === 0 || error instanceof DatabaseFromNewerVersionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message} An unpublished safety copy of the database was kept: ${abandoned.join(", ")}.`,
    { cause: error },
  );
}

export const MIGRATION_RECOVERY_ACTION =
  "Recovery action: quit Volli and restore the newest integrity-checked clean backup before retrying the upgrade.";

/**
 * Publishes `<dbPath>.backup-v<version>`: a verified, durable copy of the
 * database as it is before a migration runs, and returns its path.
 *
 * Checkpoints first, so the base file alone is the whole database, then
 * copies it to a unique staged name, verifies the copy, fsyncs it, sets any
 * existing family at the rollback name aside, renames the copy into place and
 * fsyncs the directory. By the time a migration can commit, the rollback
 * point is on disk under its name; a power cut can never leave a torn copy
 * behind a migrated database.
 */
export function publishRollbackPoint(
  db: Database.Database,
  dbPath: string,
  version: number,
  options: { faults?: DatabaseFileFaults } = {},
): string {
  const faults = options.faults ?? noFaults;
  const recovery = MIGRATION_RECOVERY_ACTION;
  const result = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
  if (result.length !== 1 || result[0]?.busy !== 0) {
    throw new Error(`Migration refused: WAL checkpoint did not complete. ${recovery}`);
  }
  const backupPath = `${dbPath}.backup-v${version}`;
  // Stage separately so a failed copy/check cannot overwrite an existing
  // clean rollback point at the same version (e.g. after a failed upgrade).
  const stagedPath = `${backupPath}.pending-${randomUUID()}`;
  faults("rollback-point:copy");
  copyFileSync(dbPath, stagedPath);
  try {
    verifyMigrationBackup(stagedPath);
  } catch (error) {
    const quarantinePath = `${stagedPath}.corrupt`;
    try {
      renameSync(stagedPath, quarantinePath);
      retentionLog.error("safety copy failed verification and was quarantined", {
        action: "quarantined",
        name: quarantinePath,
      });
    } catch (quarantineError) {
      retentionLog.error("safety copy quarantine failed", {
        action: "failed",
        operation: "quarantine",
        name: stagedPath,
        error: quarantineError,
      });
    }
    throw new Error(`Migration refused: safety copy failed integrity verification. ${recovery}`, {
      cause: error,
    });
  }
  // Readonly WAL verification can create empty WAL/SHM files. These belong
  // only to our unique staged snapshot, not to any existing backup family.
  for (const suffix of ["-wal", "-shm"]) rmSync(`${stagedPath}${suffix}`, { force: true });
  let preserved: PreservedFamily | undefined;
  try {
    // The copy's bytes are durable before any name can point at them.
    syncRecoveryPath(stagedPath);
    // A verified backup's readonly check can leave WAL/SHM behind. Preserve
    // the entire old family before publishing, including on restore/re-upgrade.
    // Never attach an old WAL or journal to the newly verified base file.
    preserved = preserveRollbackFamily(backupPath, faults);
    faults("rollback-point:publish");
    renameSync(stagedPath, backupPath);
  } catch (error) {
    // Put the old family back at its name. If that fails too, every state it
    // can stop in is one the next attempt resumes from (see below).
    if (preserved !== undefined) undoPreservation(backupPath, preserved);
    throw new Error(
      `Migration refused: could not preserve and publish the safety copy. Recovery action: quit Volli and recover the complete backup family kept beside ${backupPath} before retrying.`,
      { cause: error },
    );
  }
  try {
    // The new name is durable before the migration it protects can commit.
    faults("rollback-point:sync");
    syncRecoveryPath(dirname(dbPath));
  } catch (error) {
    throw new Error(`Migration refused: the safety copy could not be made durable. ${recovery}`, {
      cause: error,
    });
  }
  if (preserved?.path !== undefined)
    retentionLog.info("previous rollback family preserved", {
      action: "preserved",
      name: preserved.path,
    });
  return backupPath;
}

// ---------------------------------------------------------------------------
// Swap in a staged profile
// ---------------------------------------------------------------------------

export interface StagedProfileSwap {
  /** The live database path. */
  dbPath: string;
  /**
   * A closed, checkpointed database file, in a staging directory on the same
   * volume. It is renamed into place; its staging directory stays the caller's.
   */
  stagedPath: string;
  /**
   * Where the live files go. Must not exist yet and must sit beside
   * `dbPath`: the marker names it, and a rename must not cross volumes.
   */
  asideDirectory: string;
  /**
   * `damaged` (backup recovery): the live file is known bad. Its raw bytes are
   * copied into `<aside>/before-checkpoint` before SQLite touches it, and a
   * failed swap keeps the marker, so boot still refuses and recovery can
   * resume. `healthy` (bundle restore): a failed swap puts the profile back
   * and clears the marker, so the app opens exactly as before; it refuses to
   * start over an interrupted swap.
   */
  replacing: "damaged" | "healthy";
  /**
   * Profile entries beside the database that move as one profile with it, by
   * name, from the staging directory and to the set-aside directory.
   */
  companions?: readonly string[];
  faults?: DatabaseFileFaults;
}

/**
 * Makes a staged database (and its companion entries) the live profile, under
 * the fence, and checks it there before declaring success.
 *
 * Holds the open lock throughout. Takes and holds SQLite's exclusive ownership
 * of the live file — refusing with {@link DatabaseFileBusyError} before writing
 * a new marker, rather than detaching a live writer. Writes the intent marker
 * before checkpointing or displacing anything. Gives the live base a second name
 * in the set-aside directory and moves its sidecars and companions there. Installs the staged
 * companions, then renames the staged file over the live path: the commit
 * point, atomic, so the live path is never empty. Re-opens and checks the
 * installed file, fsyncs, and clears the marker.
 *
 * Any failure before the check passes is rolled back to the original files
 * and rethrown; see {@link StagedProfileSwap.replacing} for the marker.
 * Failing to roll back throws {@link DatabaseSwapRollbackError}; failing to
 * clear the marker after a verified install throws
 * {@link DatabaseSwapFinalizeError}.
 */
export function swapInStagedProfile(request: StagedProfileSwap): void {
  swapStagedProfile(request);
}

/** Internal only: a rollback verifies an exact old schema without ever migrating it. */
type SwapRequest = StagedProfileSwap & { restoreSchema?: number; restoreSource?: string };

export interface DatabaseFileRestore {
  dbPath: string;
  /** A checkpointed, closed source. Copied, never consumed or opened by SQLite. */
  sourcePath: string;
  /** The operator's explicit target schema, not this build's head. */
  schemaVersion: number;
  /** Crash tests only. */
  faults?: DatabaseFileFaults;
}

export interface DatabaseFileRestoreResult {
  /** The database family displaced by this attempt. */
  preservedDirectory: string;
  /** The first interrupted attempt's evidence, which may hold later writes absent from this attempt. */
  earlierPreservedDirectory?: string;
}

/**
 * Restore a cold copy or migration rollback point, keeping its exact schema.
 * The current build must not migrate the file destined for an older binary.
 * Stage and fully check a disposable copy, then use the same fenced swap as
 * recovery. An interrupted attempt is retryable from the unchanged source;
 * failed attempts retain the marker and evidence, so boot fails closed.
 * Returns both this attempt's preservation directory and, on retry, the first
 * interrupted attempt's directory. Keep both: the earlier one may be the only
 * copy of writes made since the rollback point.
 */
export function restoreDatabaseFile(request: DatabaseFileRestore): DatabaseFileRestoreResult {
  const { dbPath, sourcePath, schemaVersion } = request;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SCHEMA_HEAD)
    throw new Error(`Restore needs a schema between 1 and ${SCHEMA_HEAD}. Nothing was restored.`);
  regularFile(sourcePath);
  if (exists(dbPath) && inode(sourcePath) === inode(dbPath))
    throw new Error("Restore requires a separate source, never the live database.");
  assertStandalone(sourcePath);
  const staging = mkdtempSync(join(dirname(dbPath), ".database-restore-"));
  const stagedPath = join(staging, basename(dbPath));
  const asideDirectory = join(dirname(dbPath), `rolled-back-${randomUUID()}`);
  try {
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL);
    checkExactRestore(stagedPath, schemaVersion);
    const earlierPreservedDirectory = swapStagedProfile({
      dbPath,
      stagedPath,
      asideDirectory,
      replacing: "damaged",
      restoreSchema: schemaVersion,
      restoreSource: resolve(sourcePath),
      faults: request.faults,
    });
    return {
      preservedDirectory: asideDirectory,
      ...(earlierPreservedDirectory === undefined ? {} : { earlierPreservedDirectory }),
    };
  } finally {
    // Source and set-aside evidence stay. A staging cleanup failure must not
    // turn a verified, durable install into a reported failed restore.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (error) {
      log.error("staging cleanup failed", { staging, error });
    }
  }
}

function assertStandalone(path: string): void {
  for (const suffix of SIDECARS) {
    const sidecar = `${path}${suffix}`;
    if (!exists(sidecar)) continue;
    regularFile(sidecar);
    if (suffix !== "-shm" && lstatSync(sidecar).size !== 0)
      throw new Error("The staged database still has an unfinished journal. Nothing was swapped.");
  }
}

/** Writable check includes CHECK constraints; only our disposable copy/live install is opened. */
function checkExactRestore(path: string, schemaVersion: number): void {
  if (stagedSchemaVersion(path) !== schemaVersion)
    throw new Error(`The restore file is not at schema ${schemaVersion}. Nothing was restored.`);
  const db = new Database(path, { fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
      throw new Error("The restore file failed its integrity check.");
    checkpoint(db);
  } finally {
    db.close();
  }
}

function swapStagedProfile(request: SwapRequest): string | undefined {
  const { dbPath, stagedPath, asideDirectory } = request;
  if (resolve(dirname(asideDirectory)) !== resolve(dirname(dbPath)))
    throw new Error("A swap sets the live database aside beside it, never elsewhere.");
  if (resolve(stagedPath) === resolve(dbPath))
    throw new Error("A swap installs a staged copy, never the live database itself.");
  regularFile(stagedPath);
  // A staged WAL with frames would be left behind and its data lost.
  assertStandalone(stagedPath);
  // The verification open must never migrate at the live path: that would
  // take a safety copy beside the live profile and could write the reader
  // floor there (VC-602). Callers migrate in staging; refuse anything older.
  if (request.restoreSchema !== undefined) {
    if (stagedSchemaVersion(stagedPath) !== request.restoreSchema)
      throw new Error("The staged restore schema changed. Nothing was swapped.");
  } else if (stagedSchemaVersion(stagedPath) < SCHEMA_HEAD)
    throw new Error(
      `The staged database is not at this build's schema (${SCHEMA_HEAD}). Nothing was swapped.`,
    );
  // A directory fsync flushes its own entries, not its descendants'. Every
  // staged companion file and directory is durable before the swap begins, so
  // a power cut after success cannot leave a booting database whose
  // attachments were never written. Outside the lock: it is staging-only work.
  for (const entry of request.companions ?? []) {
    const path = join(dirname(stagedPath), entry);
    if (exists(path)) syncTree(path);
  }
  (request.faults ?? noFaults)("swap:lock");
  let lock: Database.Database;
  try {
    lock = acquireDatabaseOpenLock(dbPath);
  } catch (error) {
    if (isBusy(error)) throw new DatabaseFileBusyError("opening", { cause: error });
    throw error;
  }
  try {
    // A healthy swap never adopts someone else's interrupted one: its rollback
    // would clear a marker that may be guarding a missing live file.
    if (request.replacing === "healthy") assertNoPendingDatabaseRecovery(dbPath);
    // Read under the open lock, before the successful swap clears the marker.
    // A retry never overwrites the first attempt's preservation metadata.
    const priorIntent = readDatabaseRecoveryIntent(dbPath);
    new Swap(request).run();
    return priorIntent === undefined
      ? undefined
      : join(dirname(dbPath), priorIntent.preservedDirectory);
  } finally {
    lock.close();
  }
}

/** One swap's progress, so a failure undoes exactly what happened and no more. */
class Swap {
  private readonly faults: DatabaseFileFaults;
  private readonly profile: string;
  private readonly staging: string;
  private readonly name: string;
  private readonly companions: readonly string[];
  private createdAside = false;
  private marked = false;
  private owner: Database.Database | undefined;
  /** The live base also has its name in the set-aside directory. */
  private baseLinked = false;
  /** Sidecars and companions moved into the set-aside directory, in order. */
  private readonly setAside: { entry: string; sidecar: boolean }[] = [];
  /** Staged companions moved into the profile, in order. */
  private readonly installed: string[] = [];
  private published = false;
  private verified = false;

  constructor(private readonly request: SwapRequest) {
    this.faults = request.faults ?? noFaults;
    this.profile = dirname(request.dbPath);
    this.staging = dirname(request.stagedPath);
    this.name = basename(request.dbPath);
    this.companions = request.companions ?? [];
  }

  run(): void {
    const { dbPath, stagedPath, asideDirectory, replacing } = this.request;
    try {
      // Links and directories at the live names are refused before SQLite or
      // a rename can follow them anywhere.
      for (const suffix of FAMILY)
        if (exists(`${dbPath}${suffix}`)) regularFile(`${dbPath}${suffix}`);
      mkdirSync(asideDirectory);
      this.createdAside = true;
      if (replacing === "damaged") {
        // Preserve BEFORE ownership and checkpoint: even a failed checkpoint
        // can modify pages. Raw evidence and the post-checkpoint files survive.
        this.faults("swap:preserve-raw");
        try {
          this.preserveRaw();
        } catch (error) {
          // These are only this attempt's incomplete copies. No SQLite open,
          // marker or displacement has happened; keep the live family intact.
          this.removeUnusedAside();
          throw error;
        }
      }
      // Probe and HOLD exclusivity before marking: a busy refusal must not
      // create a new recovery intent. Holding ownership avoids a probe/swap
      // race; the open lock still excludes boots throughout.
      this.faults("swap:own");
      this.owner = this.takeOwnership();
      // Durable intent precedes checkpoint and ANY displacement. An
      // interruption or failed rollback now fails boot closed.
      this.faults("swap:mark");
      beginDatabaseRecovery(
        dbPath,
        basename(asideDirectory),
        this.request.restoreSource === undefined || this.request.restoreSchema === undefined
          ? undefined
          : { sourcePath: this.request.restoreSource, schemaVersion: this.request.restoreSchema },
      );
      this.marked = true;
      // The base must stand alone while its sidecars move; only checkpoint
      // after the intent is durable, even though ownership was acquired earlier.
      if (this.owner !== undefined) checkpoint(this.owner);
      this.setLiveAside();
      for (const entry of this.companions) {
        if (!exists(join(this.staging, entry))) continue;
        this.faults(`swap:install:${entry}`);
        renameSync(join(this.staging, entry), join(this.profile, entry));
        this.installed.push(entry);
      }
      // The staged bytes are durable before the live name points at them.
      syncRecoveryPath(stagedPath);
      this.faults("swap:publish");
      renameSync(stagedPath, dbPath);
      this.published = true;
      syncRecoveryPath(this.profile);
      this.faults("swap:verify");
      this.verifyInstalled();
      // Release the old inode only now; the open lock still excludes boots.
      this.owner?.close();
      this.owner = undefined;
      syncRecoveryPath(dbPath);
      syncRecoveryPath(asideDirectory);
      syncRecoveryPath(this.profile);
      this.verified = true;
      this.faults("swap:finish");
      finishDatabaseRecovery(dbPath);
    } catch (error) {
      if (this.verified) throw new DatabaseSwapFinalizeError({ cause: error });
      if (!this.marked) {
        // Nothing displaced. A healthy swap leaves no trace; recovery keeps
        // whatever raw evidence it had already copied.
        if (
          (replacing === "healthy" || error instanceof DatabaseFileBusyError) &&
          this.createdAside
        )
          this.removeUnusedAside();
        throw error;
      }
      try {
        this.rollback();
      } catch (rollbackError) {
        throw new DatabaseSwapRollbackError(asideDirectory, { cause: rollbackError });
      }
      throw error;
    } finally {
      this.owner?.close();
    }
  }

  /** Cleanup never hides the original refusal, and never removes an inherited directory. */
  private removeUnusedAside(): void {
    if (!this.createdAside) return;
    try {
      rmSync(this.request.asideDirectory, { recursive: true, force: true });
      this.createdAside = false;
    } catch (error) {
      log.error("set-aside cleanup failed", {
        asideDirectory: this.request.asideDirectory,
        error,
      });
    }
  }

  /** Byte-for-byte copies of the live family, before SQLite opens it for writing. */
  private preserveRaw(): void {
    const { dbPath, asideDirectory } = this.request;
    const rawDirectory = join(asideDirectory, "before-checkpoint");
    mkdirSync(rawDirectory);
    for (const suffix of FAMILY) {
      const source = `${dbPath}${suffix}`;
      if (!exists(source)) continue;
      const saved = join(rawDirectory, `${this.name}${suffix}`);
      copyFileSync(source, saved, constants.COPYFILE_EXCL);
      syncRecoveryPath(saved);
    }
    syncRecoveryPath(rawDirectory);
    syncRecoveryPath(asideDirectory);
  }

  /**
   * A checkpoint alone does not exclude idle connections. Acquire and HOLD
   * SQLite's exclusive file ownership through set-aside and publication. If
   * corruption prevents ownership, refuse rather than detach a live writer.
   */
  private takeOwnership(): Database.Database | undefined {
    const { dbPath } = this.request;
    if (!exists(dbPath)) return undefined;
    // Failed SQLite ownership acquisition can delete malformed WAL/SHM on
    // close. A non-SQLite header must fail before creating that connection.
    assertDatabaseHeader(dbPath);
    const owner = new Database(dbPath, { fileMustExist: true });
    try {
      owner.pragma("busy_timeout = 5000");
      owner.pragma("locking_mode = EXCLUSIVE");
      try {
        owner.exec("BEGIN EXCLUSIVE; COMMIT");
      } catch (error) {
        if (isBusy(error)) throw new DatabaseFileBusyError("in-use", { cause: error });
        throw error;
      }
      // Checkpoint only AFTER durable intent; retain exclusivity until then.
      return owner;
    } catch (error) {
      owner.close();
      throw error;
    }
  }

  private setLiveAside(): void {
    const { dbPath, asideDirectory } = this.request;
    if (exists(dbPath)) {
      // A second name, not a move: the live path keeps the original until the
      // staged file atomically replaces it.
      this.faults(`swap:set-aside:${this.name}`);
      linkSync(dbPath, join(asideDirectory, this.name));
      this.baseLinked = true;
    }
    for (const suffix of SIDECARS) {
      const source = `${dbPath}${suffix}`;
      if (!exists(source)) continue;
      regularFile(source);
      const entry = `${this.name}${suffix}`;
      this.faults(`swap:set-aside:${entry}`);
      renameSync(source, join(asideDirectory, entry));
      this.setAside.push({ entry, sidecar: true });
    }
    for (const entry of this.companions) {
      if (!exists(join(this.profile, entry))) continue;
      this.faults(`swap:set-aside:${entry}`);
      renameSync(join(this.profile, entry), join(asideDirectory, entry));
      this.setAside.push({ entry, sidecar: false });
    }
    syncRecoveryPath(asideDirectory);
    syncRecoveryPath(this.profile);
  }

  /**
   * Re-open the installed file, not just the staging copy. It is already at
   * the current schema, so this runs no migration and writes no floor.
   */
  private verifyInstalled(): void {
    if (this.request.restoreSchema !== undefined) {
      checkExactRestore(this.request.dbPath, this.request.restoreSchema);
      return;
    }
    const restored = openVolliDb(this.request.dbPath, { allowPendingRecovery: true });
    try {
      if (!checksClean(restored))
        throw new Error("The restored database failed its integrity check.");
      checkpoint(restored);
    } finally {
      restored.close();
    }
  }

  /**
   * Puts the original files back without ever leaving the live path empty
   * when it held a file. A failed install is kept as evidence; the original
   * returns by hard link, so a full disk cannot force a second full copy.
   */
  private rollback(): void {
    const { dbPath, asideDirectory, replacing } = this.request;
    if (this.published) {
      for (const suffix of SIDECARS) {
        if (!exists(`${dbPath}${suffix}`)) continue;
        this.faults(`swap:rollback:failed-restore${suffix}`);
        renameSync(`${dbPath}${suffix}`, join(asideDirectory, `failed-restore${suffix}`));
      }
      this.faults("swap:rollback:failed-restore");
      linkSync(dbPath, join(asideDirectory, "failed-restore"));
      if (this.baseLinked) {
        const spare = join(asideDirectory, `.${this.name}.reinstate-${randomUUID()}`);
        this.faults(`swap:rollback:${this.name}`);
        linkSync(join(asideDirectory, this.name), spare);
        renameSync(spare, dbPath);
      } else {
        // There was no live file before the swap; there is none after it.
        this.faults(`swap:rollback:${this.name}`);
        unlinkSync(dbPath);
      }
    }
    // Staged companions go back first, so the originals do not land on them.
    for (const entry of this.installed.toReversed()) {
      this.faults(`swap:rollback:${entry}`);
      renameSync(join(this.profile, entry), join(this.staging, entry));
    }
    for (const { entry, sidecar } of this.setAside) {
      this.faults(`swap:rollback:${entry}`);
      if (sidecar) {
        // Sidecars return by link, keeping the set-aside copy as evidence.
        linkSync(join(asideDirectory, entry), join(this.profile, entry));
      } else {
        renameSync(join(asideDirectory, entry), join(this.profile, entry));
      }
    }
    syncRecoveryPath(asideDirectory);
    syncRecoveryPath(this.profile);
    if (replacing === "healthy") {
      // The profile is exactly as it was, and durable: let it boot again.
      this.faults("swap:rollback:finish");
      finishDatabaseRecovery(dbPath);
      // Only extra names for files the profile owns again, plus the failed
      // install. A leftover directory is clutter, not a failed rollback.
      try {
        rmSync(asideDirectory, { recursive: true, force: true });
      } catch (error) {
        log.error("set-aside cleanup failed", { asideDirectory, error });
      }
    }
  }
}
