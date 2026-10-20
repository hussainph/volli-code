/**
 * The downgrade guard (VC-602): the floor marker, every boot branch of
 * `openVolliDb` against a file newer than this build, and the migration
 * runner's floor write.
 *
 * A "newer" file here is a real database migrated to this build's head and
 * then stamped past it, which is exactly what a newer build's additive
 * migration leaves behind as far as this build can see.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openVolliDb } from "./index";
import { MIGRATIONS, SCHEMA_HEAD, migrate } from "./migrations";
import type { Migration } from "./migrations";
import {
  DatabaseFromNewerVersionError,
  MIN_READER_VERSION_BASELINE,
  MIN_READER_VERSION_KEY,
  checkSchemaCompatibility,
  raiseMinReaderVersion,
  readMinReaderVersion,
} from "./schema-compatibility";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-schema-compat-"));
  dirs.push(dir);
  return dir;
}

/** A database at this build's head, written the way the app writes one, then closed. */
function headDatabase(): string {
  const dbPath = join(scratch(), "volli.db");
  openVolliDb(dbPath).close();
  return dbPath;
}

/**
 * Stamps a closed database as a newer build would leave it: a new table and a
 * new column (additive), `user_version` past this head, and optionally a floor.
 * Checkpointed, so every byte lives in the main file.
 */
function stampNewer(dbPath: string, schemaVersion: number, floor?: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE future_feature (id TEXT PRIMARY KEY);
      ALTER TABLE tickets ADD COLUMN future_column TEXT;
    `);
    db.pragma(`user_version = ${schemaVersion}`);
    if (floor !== undefined) {
      db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)").run(
        MIN_READER_VERSION_KEY,
        floor,
      );
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function migrationCopies(dbPath: string): string[] {
  return readdirSync(join(dbPath, "..")).filter((name) => name.includes(".backup-v"));
}

describe("the minimum reader version marker", () => {
  it("reads the baseline when absent, and the stored version when present", () => {
    const db = new Database(headDatabase());
    try {
      expect(readMinReaderVersion(db)).toBe(MIN_READER_VERSION_BASELINE);
      raiseMinReaderVersion(db, SCHEMA_HEAD + 3, 5);
      expect(readMinReaderVersion(db)).toBe(SCHEMA_HEAD + 3);
      expect(
        db
          .prepare("SELECT value, updated_at FROM app_state WHERE key = ?")
          .get(MIN_READER_VERSION_KEY),
      ).toEqual({ value: String(SCHEMA_HEAD + 3), updated_at: 5 });
    } finally {
      db.close();
    }
  });

  it("never lowers the floor", () => {
    const db = new Database(headDatabase());
    try {
      raiseMinReaderVersion(db, 80, 1);
      raiseMinReaderVersion(db, 70, 2);
      raiseMinReaderVersion(db, 80, 3);
      expect(readMinReaderVersion(db)).toBe(80);
      expect(
        db.prepare("SELECT updated_at FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
      ).toEqual({ updated_at: 1 });
    } finally {
      db.close();
    }
  });

  it.each(["", "abc", "0", "-3", "58.5", "060", "1e3", "9999999999"])(
    "reads a stored %j as unreadable, and a raise replaces it",
    (value) => {
      const db = new Database(headDatabase());
      try {
        db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)").run(
          MIN_READER_VERSION_KEY,
          value,
        );
        expect(readMinReaderVersion(db)).toBeNull();
        raiseMinReaderVersion(db, 61, 2);
        expect(readMinReaderVersion(db)).toBe(61);
      } finally {
        db.close();
      }
    },
  );

  it("is readable on a read-only handle at every shipped schema head", () => {
    // `app_state` is migration 001's, so the marker read never depends on a
    // migration this build might not know. Prove it at each head.
    for (const migration of MIGRATIONS) {
      const dbPath = join(scratch(), "volli.db");
      const writer = new Database(dbPath);
      migrate(writer, dbPath, { toVersion: migration.version });
      writer.close();
      const reader = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        expect(readMinReaderVersion(reader)).toBe(MIN_READER_VERSION_BASELINE);
        expect(checkSchemaCompatibility(reader, migration.version)).toEqual({
          schemaVersion: migration.version,
          newer: false,
        });
      } finally {
        reader.close();
      }
    }
  });

  it("refuses a newer file whose app_state is gone rather than guessing", () => {
    const db = new Database(":memory:");
    try {
      db.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
      expect(() => checkSchemaCompatibility(db, SCHEMA_HEAD)).toThrow(
        DatabaseFromNewerVersionError,
      );
    } finally {
      db.close();
    }
  });

  it("names the versions and the remedy in the refusal", () => {
    expect(new DatabaseFromNewerVersionError(99, 58, 99).message).toBe(
      "Database schema 99 is newer than this build's schema 58, and it needs schema 99 or newer to open it. Nothing was changed. Update Volli, or restore an older backup.",
    );
    expect(new DatabaseFromNewerVersionError(99, 58, null).message).toContain(
      "its minimum reader version is unreadable.",
    );
    expect(new DatabaseFromNewerVersionError(99, 58, 99).name).toBe(
      "DatabaseFromNewerVersionError",
    );
  });
});

describe("openVolliDb against a database's schema version (VC-602)", () => {
  it("migrates an older database up and leaves no marker behind", () => {
    const dbPath = join(scratch(), "volli.db");
    const seed = new Database(dbPath);
    migrate(seed, dbPath, { toVersion: SCHEMA_HEAD - 1 });
    seed.close();
    const db = openVolliDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
      // No shipped migration raises the floor, so none was written.
      expect(
        db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("opens a database at the head without migrating or writing the marker", () => {
    const dbPath = headDatabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = openVolliDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
      expect(
        db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
      ).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    ["no marker (the baseline)", undefined],
    ["a floor below the head", String(MIN_READER_VERSION_BASELINE)],
    ["a floor at the head", String(SCHEMA_HEAD)],
  ])("opens a newer, compatible database with %s, migrating nothing", (_label, floor) => {
    const dbPath = headDatabase();
    const newer = SCHEMA_HEAD + 41;
    stampNewer(dbPath, newer, floor);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = openVolliDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(newer);
      // The newer schema is still there, and the build can write to it.
      db.prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('written-by-older', '1', 1)",
      ).run();
      expect(db.prepare("SELECT COUNT(*) AS n FROM future_feature").get()).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT value FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY),
      ).toEqual(floor === undefined ? undefined : { value: floor });
    } finally {
      db.close();
    }
    // Logged once, with both versions; no migration ran, so no safety copy.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[db] database schema is newer and declares itself compatible; not migrating",
      { schemaVersion: newer, schemaHead: SCHEMA_HEAD },
    );
    expect(migrationCopies(dbPath)).toEqual([]);
    const reopened = new Database(dbPath, { readonly: true });
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(newer);
    } finally {
      reopened.close();
    }
  });

  it.each([
    ["a floor above the head", String(SCHEMA_HEAD + 41)],
    ["an unreadable floor", "not-a-version"],
  ])(
    "refuses a newer, incompatible database with %s, leaving the file byte-identical",
    (_label, floor) => {
      const dbPath = headDatabase();
      const newer = SCHEMA_HEAD + 41;
      stampNewer(dbPath, newer, floor);
      const before = sha256(dbPath);
      const namesBefore = new Set(readdirSync(join(dbPath, "..")).toSorted());

      let caught: unknown;
      try {
        openVolliDb(dbPath).close();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DatabaseFromNewerVersionError);
      const refusal = caught as DatabaseFromNewerVersionError;
      expect(refusal.schemaVersion).toBe(newer);
      expect(refusal.supportedVersion).toBe(SCHEMA_HEAD);
      expect(refusal.minReaderVersion).toBe(floor === "not-a-version" ? null : newer);
      expect(sha256(dbPath)).toBe(before);
      expect(migrationCopies(dbPath)).toEqual([]);
      // The invariant: the db file and its WAL are byte-identical; `-shm`, an
      // index with no data, may be created or reset by SQLite's read-only
      // reader. Only the open mutex and those sidecars may appear, and a WAL
      // the reader created carries no frames.
      const added = readdirSync(join(dbPath, ".."))
        .filter((name) => !namesBefore.has(name))
        .toSorted();
      for (const name of added) {
        expect(["volli.db-shm", "volli.db-wal", "volli.db.open-lock"]).toContain(name);
      }
      if (existsSync(`${dbPath}-wal`)) expect(readFileSync(`${dbPath}-wal`).length).toBe(0);
    },
  );
});

describe("the migration runner's floor write", () => {
  const base: readonly Migration[] = [
    { version: 1, name: "app state", sql: MIGRATIONS[0]!.sql },
    { version: 2, name: "additive", sql: "CREATE TABLE additive (id INTEGER);" },
  ];

  it("raises the floor to a breaking migration's version, atomically with it", () => {
    const dbPath = join(scratch(), "volli.db");
    const db = new Database(dbPath);
    try {
      migrate(db, dbPath, { migrations: base });
      expect(db.prepare("SELECT 1 FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY)).toBe(
        undefined,
      );
      const breaking: Migration[] = [
        ...base,
        {
          version: 3,
          name: "breaking",
          sql: "CREATE TABLE b (id INTEGER);",
          raisesMinReader: true,
        },
        { version: 4, name: "additive again", sql: "CREATE TABLE c (id INTEGER);" },
      ];
      migrate(db, dbPath, { migrations: breaking });
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(readMinReaderVersion(db)).toBe(3);

      // A failed batch rolls the floor back with the schema.
      const failing: Migration[] = [
        ...breaking,
        { version: 5, name: "raise", sql: "CREATE TABLE d (id INTEGER);", raisesMinReader: true },
        { version: 6, name: "fails", sql: "THIS IS NOT SQL;" },
      ];
      expect(() => migrate(db, dbPath, { migrations: failing })).toThrow();
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(readMinReaderVersion(db)).toBe(3);
    } finally {
      db.close();
    }
  });

  it("keeps the baseline's history at the default: the floor of those files is the baseline", () => {
    expect(
      MIGRATIONS.filter(
        (migration) =>
          migration.version <= MIN_READER_VERSION_BASELINE && migration.raisesMinReader === true,
      ),
    ).toEqual([]);
    expect(MIN_READER_VERSION_BASELINE).toBeLessThanOrEqual(SCHEMA_HEAD);
  });
});
