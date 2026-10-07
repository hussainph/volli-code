/**
 * The applied-migration history (VC-633, migration 060): which migrations
 * this FILE has been through, each with the lock fingerprint of the exact
 * migration that ran, beside `user_version`'s high-water mark. Flyway's
 * `flyway_schema_history` and Rails' `schema_migrations` play the same part.
 *
 * `user_version` says how far a file got, not by which road. Two builds can
 * both write "54" after running different migrations under that number: the
 * history already has a renumbering (031 → 039) and a 053/054 lineage
 * collision, both repaired by probe-gated `apply` functions. With a record of
 * what ran, a build can tell at open that a file went down another lineage's
 * road, instead of finding out from whatever breaks next.
 *
 * WHAT A MISMATCH DOES: it warns, and it never refuses. A diverged file is
 * one a developer or canary build already ran; the data in it is whatever it
 * is, and refusing would stop the person reaching it, including to back it up.
 * So the open logs one named line (`[volli] migration history`), the support
 * report carries {@link describeMigrationHistory}'s sentence, and nothing else
 * changes. A probe-gated `apply` stays the repair; this is the detector.
 *
 * WHY IT NEEDS NO FLOOR RAISE: it is a new table no older build reads or
 * writes. Nothing an older build does on the compatible path can make it
 * wrong, because an older build never applies a migration to a newer file:
 * `user_version` is above its head, so its runner finds nothing pending. A
 * backup an older build makes carries no history (the table is `rebuild` in
 * `backup/decisions.ts`), and the restore that migrates it writes a history
 * for the new file it builds. Builds from before this table simply ignore it.
 *
 * BACKFILL: a file migrated before 060 existed has no record of how it got
 * there. Migration 060 records versions `1 .. user_version` as `backfill`,
 * with no fingerprint and no time: present, but unverifiable. Every version
 * the runner applies from then on, in the same transaction as the schema
 * change, is `applied` with this build's lock fingerprint and the time.
 */
import type Database from "better-sqlite3";

import LOCK from "./migrations.lock.json" with { type: "json" };

/** The migration that creates the history; files below it have none to check. */
export const MIGRATION_HISTORY_VERSION = 60;

/**
 * Migration 060. `IF NOT EXISTS` and `OR IGNORE`, so a lineage re-offered
 * version 60 converges instead of failing. Reads `user_version` through the
 * `pragma_user_version` table-valued function: the runner sets it after each
 * migration, so it is the version the file stood at before this one.
 */
export const MIGRATION_HISTORY_MIGRATION = `
CREATE TABLE IF NOT EXISTS migration_history (
  version     INTEGER PRIMARY KEY CHECK (version >= 1),
  fingerprint TEXT CHECK (fingerprint IS NULL OR
                          (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
  applied_at  INTEGER,
  origin      TEXT NOT NULL CHECK (origin IN ('applied', 'backfill'))
);

WITH RECURSIVE prior(version) AS (
  SELECT 1 FROM pragma_user_version WHERE user_version >= 1
  UNION ALL
  SELECT version + 1 FROM prior
   WHERE version < (SELECT user_version FROM pragma_user_version)
)
INSERT OR IGNORE INTO migration_history (version, fingerprint, applied_at, origin)
  SELECT version, NULL, NULL, 'backfill' FROM prior;
`;

/** Version → lock fingerprint, as `migrations.lock.json` froze this build's migrations. */
export type MigrationFingerprints = Readonly<Record<number, string>>;

/** This build's lock fingerprints. */
export const LOCKED_FINGERPRINTS: MigrationFingerprints = Object.freeze(
  Object.fromEntries(
    Object.entries(LOCK as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([version, fingerprint]) => [Number(version), fingerprint]),
  ),
);

function hasHistory(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_history'")
      .get() !== undefined
  );
}

/**
 * Records the migrations the runner just applied, inside its transaction.
 * Does nothing while the file has no history yet (a batch that stopped below
 * 060, like a restore migrating to an older bundle's version). A version
 * with no lock entry (an unlocked migration in a dev build) is recorded with
 * no fingerprint: applied, but nothing to compare it with.
 */
export function recordAppliedMigrations(
  db: Database.Database,
  versions: readonly number[],
  fingerprints: MigrationFingerprints,
  now: number,
): void {
  if (versions.length === 0 || !hasHistory(db)) return;
  const record = db.prepare(
    `INSERT INTO migration_history (version, fingerprint, applied_at, origin)
     VALUES (?, ?, ?, 'applied')
     ON CONFLICT(version) DO UPDATE SET fingerprint = excluded.fingerprint,
       applied_at = excluded.applied_at, origin = 'applied'`,
  );
  for (const version of versions) record.run(version, fingerprints[version] ?? null, now);
}

/** What the open found when it compared the file's history with this build's lock. */
export interface MigrationHistoryReport {
  /** The file's `user_version`. */
  schemaVersion: number;
  /** True when nothing below disagrees. */
  consistent: boolean;
  /** Versions this build ships that the file recorded with a different fingerprint. */
  diverged: number[];
  /** Versions at or below both heads, from 060 on, that the file never recorded. */
  unrecorded: number[];
  /** Versions recorded above the file's own `user_version`. */
  ahead: number[];
  /** How many versions were recorded before the history existed (no fingerprint). */
  backfilled: number;
}

interface HistoryRow {
  version: number;
  fingerprint: string | null;
  origin: string;
}

/**
 * Compares the file's history with this build's lock. Reads only, so it runs
 * on any handle. A file below 060 has no history to compare and is
 * consistent; a file at or above it with no history table, or with a version
 * missing, ran another build's migration under one of these numbers.
 *
 * A version above this build's head is not compared: this build has no
 * fingerprint for it, and a newer file's floor already decided whether it may
 * open (`schema-compatibility.ts`).
 */
export function checkMigrationHistory(
  db: Database.Database,
  head: number,
  fingerprints: MigrationFingerprints = LOCKED_FINGERPRINTS,
): MigrationHistoryReport {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  const report: MigrationHistoryReport = {
    schemaVersion,
    consistent: true,
    diverged: [],
    unrecorded: [],
    ahead: [],
    backfilled: 0,
  };
  if (schemaVersion < MIGRATION_HISTORY_VERSION) return report;
  const rows = hasHistory(db)
    ? (db
        .prepare("SELECT version, fingerprint, origin FROM migration_history ORDER BY version")
        .all() as HistoryRow[])
    : [];
  const recorded = new Set<number>();
  for (const row of rows) {
    recorded.add(row.version);
    if (row.origin === "backfill") report.backfilled += 1;
    if (row.version > schemaVersion) report.ahead.push(row.version);
    const expected = fingerprints[row.version];
    if (
      row.version <= head &&
      row.fingerprint !== null &&
      expected !== undefined &&
      row.fingerprint !== expected
    ) {
      report.diverged.push(row.version);
    }
  }
  for (
    let version = MIGRATION_HISTORY_VERSION;
    version <= Math.min(schemaVersion, head);
    version++
  ) {
    if (!recorded.has(version)) report.unrecorded.push(version);
  }
  report.consistent =
    report.diverged.length === 0 && report.unrecorded.length === 0 && report.ahead.length === 0;
  return report;
}

/** One line for the log and the support report: what the history says, in plain words. */
export function describeMigrationHistory(report: MigrationHistoryReport): string {
  if (report.schemaVersion < MIGRATION_HISTORY_VERSION) return "not recorded (schema before 60)";
  if (report.consistent) {
    return report.backfilled > 0
      ? `consistent (${report.backfilled} versions from before the history are unverified)`
      : "consistent";
  }
  const problems: string[] = [];
  if (report.diverged.length > 0) {
    problems.push(`ran a different migration than this build at ${report.diverged.join(", ")}`);
  }
  if (report.unrecorded.length > 0) {
    problems.push(`has no record of ${report.unrecorded.join(", ")}`);
  }
  if (report.ahead.length > 0) {
    problems.push(`records ${report.ahead.join(", ")} above its schema ${report.schemaVersion}`);
  }
  return `diverged: this database ${problems.join("; ")}. Another build (a branch or dogfood build) migrated it; its data is intact, but a migration this build expects may not have run. Nothing was changed.`;
}
