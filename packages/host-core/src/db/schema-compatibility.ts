/**
 * The downgrade guard (VC-602): what a build does with a `volli.db` written by
 * a NEWER build than itself.
 *
 * `PRAGMA user_version` says which migrations a file has been through. It
 * cannot say whether a build that knows fewer of them can still use it. A
 * second number answers that: the **minimum reader version**, the oldest
 * schema head that can safely read AND write the file (writing includes taking
 * a backup bundle of it). It lives in `app_state` under
 * {@link MIN_READER_VERSION_KEY}, which every schema since migration 001 has,
 * so a build can read it before it runs or even knows any newer migration.
 *
 * When `user_version` is above a build's head:
 *  - head >= the floor: the newer schema promised to stay readable. The build
 *    opens it, runs no migration, and never lowers `user_version`.
 *  - head <  the floor: the build refuses with
 *    {@link DatabaseFromNewerVersionError} before anything writes to the file.
 *    The db file and its WAL stay byte-identical; `-shm`, an index with no
 *    data, may be created or reset by SQLite's read-only reader.
 *
 * Only a migration that breaks older readers raises the floor
 * (`raisesMinReader: true` in `migrations.ts`, where the rule for authors is
 * written down). Additive migrations leave it alone, which is what keeps a
 * canary user who drops back to stable working.
 *
 * Builds that predate this module ignore the marker. The guard binds only
 * builds that contain it, and every one of those has a head of at least
 * {@link MIN_READER_VERSION_BASELINE}.
 */
import type Database from "better-sqlite3";

/** The `app_state` key the floor is stored under. Durable: never rename it. */
export const MIN_READER_VERSION_KEY = "volli:min-reader-version";

/**
 * The floor of a file that carries no marker: schema 58, the head this guard
 * first shipped at.
 *
 * Why 58, and why it is a constant rather than "the current head":
 *  - It is the truth about every file a guarded build can write. By the
 *    definition above a v57 build is NOT a safe writer of a v58 file: its
 *    backup bundle stamps schema 58 but omits `workspace_epochs`, so neither
 *    v57 nor v58 can restore it (VC-550's verifier, 2026-10-03). Every guarded
 *    build has a head of at least 58 and knows that table.
 *  - It binds no build that reads it. Every build containing this guard has a
 *    head >= 58, so a missing marker can never refuse anybody; builds older
 *    than 58 cannot read the marker at all.
 *  - It is frozen. Seeding "the current head" instead would make a v60 build
 *    stamp 60 on a fresh file and lock out a v59 build for no reason. The
 *    floor moves only when a migration declares it does.
 *
 * Nothing writes the baseline. A missing marker reads as 58, which keeps a
 * routine open read-only and keeps the marker out of every database that has
 * never run a migration that raises it.
 */
export const MIN_READER_VERSION_BASELINE = 58;

/** Why a build refused a database: it is from a newer Volli that this build cannot safely use. */
export class DatabaseFromNewerVersionError extends Error {
  override readonly name = "DatabaseFromNewerVersionError";
  constructor(
    /** The file's `user_version`. */
    readonly schemaVersion: number,
    /** This build's schema head. */
    readonly supportedVersion: number,
    /** The file's floor, or `null` when the marker was present but unreadable. */
    readonly minReaderVersion: number | null,
  ) {
    super(
      `Database schema ${schemaVersion} is newer than this build's schema ${supportedVersion}, and ` +
        (minReaderVersion === null
          ? "its minimum reader version is unreadable."
          : `it needs schema ${minReaderVersion} or newer to open it.`) +
        " Nothing was changed. Update Volli, or restore an older backup.",
    );
  }
}

/** The stored floor, or `undefined` when absent, or `null` when present but not a version. */
function storedMinReaderVersion(db: Database.Database): number | null | undefined {
  // Not the `prepared` cache: this runs on the read-only boot preflight handle,
  // which closes before the ownership guard exists (see db/index.ts).
  const row = db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(MIN_READER_VERSION_KEY) as { value: string } | undefined;
  if (row === undefined) return undefined;
  return /^[1-9]\d{0,8}$/.test(row.value) ? Number(row.value) : null;
}

/**
 * The file's floor: the stored marker, or {@link MIN_READER_VERSION_BASELINE}
 * when there is none. `null` when the stored value is not a version, which a
 * caller deciding whether to open a newer file must treat as a refusal.
 */
export function readMinReaderVersion(db: Database.Database): number | null {
  const stored = storedMinReaderVersion(db);
  return stored === undefined ? MIN_READER_VERSION_BASELINE : stored;
}

/**
 * Raises the floor to `version`, never lowering it. The migration runner calls
 * this inside the same transaction that applies a `raisesMinReader` migration,
 * so the floor and the `user_version` that needs it commit together: a crash
 * between them would otherwise leave a file an older build opens unguarded.
 *
 * An unreadable stored value is replaced. It never constrained anything this
 * build could check, and the migration is the authority on its own floor.
 */
export function raiseMinReaderVersion(db: Database.Database, version: number, now: number): void {
  const current = storedMinReaderVersion(db);
  if (typeof current === "number" && current >= version) return;
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(MIN_READER_VERSION_KEY, String(version), now);
}

/** What the boot check found about a file this build may open. */
export interface SchemaCompatibility {
  /** The file's `user_version`. */
  schemaVersion: number;
  /** True when the file is from a newer, compatible build: open it, migrate nothing. */
  newer: boolean;
}

/**
 * The boot check. Reads only: run it on a read-only handle before anything
 * opens the file for writing. Throws {@link DatabaseFromNewerVersionError}
 * when the file is newer than `head` and its floor is above `head` (or
 * cannot be read, including a newer file that no longer has `app_state`).
 *
 * A file at or below `head` passes without reading the marker: the migration
 * runner owns it from there.
 */
export function checkSchemaCompatibility(db: Database.Database, head: number): SchemaCompatibility {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  if (schemaVersion <= head) return { schemaVersion, newer: false };
  let floor: number | null;
  try {
    floor = readMinReaderVersion(db);
  } catch {
    // A newer file without a readable `app_state` cannot vouch for itself.
    floor = null;
  }
  if (floor === null || floor > head) {
    throw new DatabaseFromNewerVersionError(schemaVersion, head, floor);
  }
  return { schemaVersion, newer: true };
}
