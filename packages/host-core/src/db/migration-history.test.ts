/**
 * Migration 060 and the applied-migration history (VC-633): what each file
 * records about the migrations it ran, and what an open concludes from it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openVolliDb } from "./database-file";
import {
  checkMigrationHistory,
  describeMigrationHistory,
  LOCKED_FINGERPRINTS,
  MIGRATION_HISTORY_MIGRATION,
  MIGRATION_HISTORY_VERSION,
  recordAppliedMigrations,
} from "./migration-history";
import { migrate, MIGRATIONS, SCHEMA_HEAD } from "./migrations";
import { MIN_READER_VERSION_BASELINE, readMinReaderVersion } from "./schema-compatibility";

interface Row {
  version: number;
  fingerprint: string | null;
  applied_at: number | null;
  origin: string;
}

let dir: string;
let dbPath: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-migration-060-"));
  dbPath = join(dir, "volli.db");
  db = new Database(dbPath);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = (handle = db) =>
  handle.prepare("SELECT * FROM migration_history ORDER BY version").all() as Row[];

const lock = JSON.parse(
  readFileSync(new URL("./migrations.lock.json", import.meta.url), "utf8"),
) as Record<string, string | number>;

describe("migration 060: the applied-migration history", () => {
  it("is additive: it leaves the floor where it was", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === MIGRATION_HISTORY_VERSION)!;
    expect(migration.sql).toBe(MIGRATION_HISTORY_MIGRATION);
    expect(migration.raisesMinReader).toBeUndefined();
    expect(migration.apply).toBeUndefined();
    migrate(db, dbPath);
    expect(readMinReaderVersion(db)).toBe(MIN_READER_VERSION_BASELINE);
  });

  it("carries this build's lock, and only versions", () => {
    const { format, ...versions } = lock;
    expect(format).toBe(1);
    expect(LOCKED_FINGERPRINTS).toEqual(
      Object.fromEntries(
        Object.entries(versions).map(([version, hash]) => [Number(version), hash]),
      ),
    );
    expect(Object.keys(LOCKED_FINGERPRINTS)).toHaveLength(SCHEMA_HEAD);
  });

  it("records every migration a fresh database runs, with its fingerprint and the time", () => {
    const before = Date.now();
    migrate(db, dbPath);
    const history = rows();
    expect(history.map((row) => row.version)).toEqual(MIGRATIONS.map((entry) => entry.version));
    for (const row of history) {
      expect(row.origin).toBe("applied");
      expect(row.fingerprint).toBe(LOCKED_FINGERPRINTS[row.version]);
      expect(row.applied_at).toBeGreaterThanOrEqual(before);
    }
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toEqual({
      schemaVersion: SCHEMA_HEAD,
      consistent: true,
      diverged: [],
      unrecorded: [],
      ahead: [],
      backfilled: 0,
    });
    expect(describeMigrationHistory(report)).toBe("consistent");
  });

  it("backfills what an existing database ran before it, unverified, and records the rest", () => {
    migrate(db, dbPath, { toVersion: 57 });
    migrate(db, dbPath);
    const history = rows();
    expect(history).toHaveLength(SCHEMA_HEAD);
    for (const row of history.slice(0, 57)) {
      expect(row).toMatchObject({ fingerprint: null, applied_at: null, origin: "backfill" });
    }
    // 58 and 59 ran in the same batch as 060, so this build knows exactly what they were.
    for (const row of history.slice(57)) {
      expect(row).toMatchObject({
        fingerprint: LOCKED_FINGERPRINTS[row.version],
        origin: "applied",
      });
    }
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toMatchObject({ consistent: true, backfilled: 57 });
    expect(describeMigrationHistory(report)).toBe(
      "consistent (57 versions from before the history are unverified)",
    );
  });

  it("converges when a lineage re-offers 060, and backfills nothing on an empty file", () => {
    db.exec(MIGRATION_HISTORY_MIGRATION);
    expect(rows()).toEqual([]);
    db.pragma("user_version = 3");
    db.exec(MIGRATION_HISTORY_MIGRATION);
    expect(rows().map((row) => [row.version, row.origin])).toEqual([
      [1, "backfill"],
      [2, "backfill"],
      [3, "backfill"],
    ]);
  });

  it("rejects a fingerprint that is not a lowercase SHA-256", () => {
    db.exec(MIGRATION_HISTORY_MIGRATION);
    const insert = db.prepare(
      "INSERT INTO migration_history (version, fingerprint, origin) VALUES (?, ?, 'applied')",
    );
    expect(() => insert.run(1, "A".repeat(64))).toThrow(/CHECK/);
    expect(() => insert.run(2, "a".repeat(63))).toThrow(/CHECK/);
    expect(() => insert.run(3, "a".repeat(64))).not.toThrow();
  });
});

describe("recordAppliedMigrations", () => {
  it("does nothing before the history exists, or for an empty batch", () => {
    recordAppliedMigrations(db, [1], LOCKED_FINGERPRINTS, 1);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'migration_history'").get(),
    ).toBeUndefined();
    db.exec(MIGRATION_HISTORY_MIGRATION);
    recordAppliedMigrations(db, [], LOCKED_FINGERPRINTS, 1);
    expect(rows()).toEqual([]);
  });

  it("records a version the lock does not know with no fingerprint", () => {
    db.exec(MIGRATION_HISTORY_MIGRATION);
    recordAppliedMigrations(db, [1, 999], LOCKED_FINGERPRINTS, 5);
    expect(rows()).toEqual([
      { version: 1, fingerprint: LOCKED_FINGERPRINTS[1], applied_at: 5, origin: "applied" },
      { version: 999, fingerprint: null, applied_at: 5, origin: "applied" },
    ]);
  });

  it("records a test's own migration list with no fingerprint unless given one", () => {
    const list = [
      { version: 1, name: "one", sql: "CREATE TABLE one (id INTEGER);" },
      { version: 2, name: "history", sql: MIGRATION_HISTORY_MIGRATION },
    ];
    migrate(db, dbPath, { migrations: list });
    expect(rows().map((row) => row.fingerprint)).toEqual([null, null]);
    const other = new Database(join(dir, "other.db"));
    try {
      migrate(other, join(dir, "other.db"), {
        migrations: list,
        fingerprints: { 1: "a".repeat(64) },
      });
      expect(rows(other).map((row) => row.fingerprint)).toEqual(["a".repeat(64), null]);
    } finally {
      other.close();
    }
  });
});

describe("checkMigrationHistory", () => {
  it("has nothing to compare below 060", () => {
    migrate(db, dbPath, { toVersion: MIGRATION_HISTORY_VERSION - 1 });
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toMatchObject({
      consistent: true,
      schemaVersion: MIGRATION_HISTORY_VERSION - 1,
    });
    expect(describeMigrationHistory(report)).toBe("not recorded (schema before 60)");
  });

  it("names a version another lineage ran under the same number", () => {
    migrate(db, dbPath);
    db.prepare("UPDATE migration_history SET fingerprint = ? WHERE version IN (54, 60)").run(
      "f".repeat(64),
    );
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toMatchObject({ consistent: false, diverged: [54, 60] });
    expect(describeMigrationHistory(report)).toBe(
      "diverged: this database ran a different migration than this build at 54, 60. Another build (a branch or dogfood build) migrated it; its data is intact, but a migration this build expects may not have run. Nothing was changed.",
    );
  });

  it("names a file another build stamped past 060 without this history", () => {
    migrate(db, dbPath);
    db.exec("DROP TABLE migration_history");
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toMatchObject({
      consistent: false,
      unrecorded: MIGRATIONS.filter(({ version }) => version >= MIGRATION_HISTORY_VERSION).map(
        ({ version }) => version,
      ),
      backfilled: 0,
    });
    expect(describeMigrationHistory(report)).toContain("has no record of 60");
  });

  it("names a version recorded above the file's own schema, and every problem at once", () => {
    migrate(db, dbPath);
    db.prepare("UPDATE migration_history SET fingerprint = ? WHERE version = 1").run(
      "0".repeat(64),
    );
    db.prepare("DELETE FROM migration_history WHERE version = 60").run();
    db.prepare(
      "INSERT INTO migration_history (version, fingerprint, applied_at, origin) VALUES (70, NULL, 1, 'applied')",
    ).run();
    const report = checkMigrationHistory(db, SCHEMA_HEAD);
    expect(report).toMatchObject({ diverged: [1], unrecorded: [60], ahead: [70] });
    expect(describeMigrationHistory(report)).toContain(
      `ran a different migration than this build at 1; has no record of 60; records 70 above its schema ${SCHEMA_HEAD}`,
    );
  });

  it("does not compare what this build cannot know: a newer file's versions, unknown fingerprints", () => {
    migrate(db, dbPath);
    db.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    db.prepare(
      "INSERT INTO migration_history (version, fingerprint, applied_at, origin) VALUES (?, ?, 1, 'applied')",
    ).run(SCHEMA_HEAD + 1, "e".repeat(64));
    db.prepare("UPDATE migration_history SET fingerprint = NULL WHERE version = 2").run();
    expect(checkMigrationHistory(db, SCHEMA_HEAD)).toMatchObject({ consistent: true });
    // A version the lock never had (a dev build's unlocked migration) is not a divergence either.
    expect(checkMigrationHistory(db, SCHEMA_HEAD + 1, LOCKED_FINGERPRINTS)).toMatchObject({
      consistent: true,
    });
  });
});

describe("openVolliDb and the history", () => {
  it("opens a diverged file and logs one named line, without refusing", () => {
    migrate(db, dbPath);
    db.prepare("UPDATE migration_history SET fingerprint = ? WHERE version = 60").run(
      "f".repeat(64),
    );
    db.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const opened = openVolliDb(dbPath);
    opened.close();
    expect(warn).toHaveBeenCalledWith("[db] migration history diverged", {
      summary: expect.stringMatching(/^diverged: .* at 60\./),
    });
  });

  it("says nothing about a consistent file, and reports a history it cannot read", () => {
    migrate(db, dbPath);
    db.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openVolliDb(dbPath).close();
    expect(warn).not.toHaveBeenCalled();

    db = new Database(dbPath);
    db.exec("DROP TABLE migration_history; CREATE TABLE migration_history (version INTEGER)");
    db.close();
    openVolliDb(dbPath).close();
    expect(warn).toHaveBeenCalledWith("[db] migration history could not be read", {
      error: expect.objectContaining({ message: expect.any(String) }),
    });
  });
});
