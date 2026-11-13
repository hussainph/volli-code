/**
 * Retention in the upgrade that published a safety copy does not re-check it
 * while it is the file that was verified (VC-1204); every other copy, and a
 * copy that changed, is checked in full through the real filesystem.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { verifyMigrationBackup } from "./backup-integrity";
import { migrate, type Migration } from "./migrations";
import { openRawDb } from "./test-helpers";

vi.mock("./backup-integrity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backup-integrity")>();
  return { ...actual, verifyMigrationBackup: vi.fn(actual.verifyMigrationBackup) };
});

let directory: string | undefined;
afterEach(() => {
  vi.mocked(verifyMigrationBackup).mockClear();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const FROM = 5;

/** A closed v5 database with one index page to damage, and its page number. */
function profile(): { dbPath: string; page: number } {
  directory = mkdtempSync(join(tmpdir(), "volli-backup-reverify-"));
  const dbPath = join(directory, "volli.db");
  const db = openRawDb(dbPath);
  db.exec("CREATE TABLE integrity_probe (value TEXT UNIQUE)");
  db.prepare("INSERT INTO integrity_probe VALUES (?)").run("evidence");
  db.pragma(`user_version = ${FROM}`);
  const { rootpage } = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_integrity_probe_1'")
    .get() as { rootpage: number };
  db.close();
  return { dbPath, page: rootpage };
}

function zeroPage(path: string, page: number): void {
  const bytes = readFileSync(path);
  const pageSize = bytes.readUInt16BE(16);
  bytes.fill(0, (page - 1) * pageSize, page * pageSize);
  writeFileSync(path, bytes);
}

function upgrade(dbPath: string, during?: (db: Database.Database) => void): void {
  const migration: Migration = {
    version: FROM + 1,
    name: "probe",
    sql: "",
    apply: (db) => {
      db.exec("CREATE TABLE upgraded (value TEXT)");
      during?.(db);
    },
  };
  const db = openRawDb(dbPath);
  db.pragma("journal_mode = WAL");
  try {
    migrate(db, dbPath, { migrations: [migration] });
  } finally {
    db.close();
  }
}

const checkedNames = (dbPath: string) =>
  vi
    .mocked(verifyMigrationBackup)
    .mock.calls.map(([path]) => path.slice(dbPath.length).replace(/pending-[\da-f-]+$/, "pending"));

const names = () => readdirSync(directory!).toSorted();

describe("migrate — retention of this upgrade's safety copy (VC-1204)", () => {
  it("checks this upgrade's copy once, before publishing it, and every older copy in full", () => {
    const { dbPath } = profile();
    copyFileSync(dbPath, `${dbPath}.backup-v3`);
    copyFileSync(dbPath, `${dbPath}.backup-v4`);

    upgrade(dbPath);

    expect(checkedNames(dbPath)).toEqual([".backup-v5.pending", ".backup-v3", ".backup-v4"]);
    expect(existsSync(`${dbPath}.backup-v3`)).toBe(false);
    expect(existsSync(`${dbPath}.backup-v4`)).toBe(true);
    verifyMigrationBackup(`${dbPath}.backup-v5`);
  });

  it("refuses the upgrade when the copy it just made is damaged", () => {
    const { dbPath, page } = profile();
    copyFileSync(dbPath, `${dbPath}.backup-v4`);
    const db = openRawDb(dbPath);
    db.pragma("journal_mode = WAL");
    const pragma = db.pragma.bind(db);
    vi.spyOn(db, "pragma").mockImplementation((source, options) => {
      const result = pragma(source, options);
      // Damage after the source check, before the copy is taken.
      if (source === "wal_checkpoint(TRUNCATE)") zeroPage(dbPath, page);
      return result;
    });
    try {
      expect(() =>
        migrate(db, dbPath, {
          migrations: [{ version: FROM + 1, name: "probe", sql: "CREATE TABLE upgraded (v)" }],
        }),
      ).toThrow(/safety copy failed integrity verification/);
    } finally {
      db.close();
    }
    expect(checkedNames(dbPath)).toEqual([".backup-v5.pending"]);
    expect(existsSync(`${dbPath}.backup-v5`)).toBe(false);
    expect(names().filter((name) => name.endsWith(".corrupt"))).toHaveLength(1);
    expect(existsSync(`${dbPath}.backup-v4`)).toBe(true);
  });

  it("still quarantines a damaged older copy", () => {
    const { dbPath, page } = profile();
    copyFileSync(dbPath, `${dbPath}.backup-v4`);
    zeroPage(`${dbPath}.backup-v4`, page);

    upgrade(dbPath);

    expect(checkedNames(dbPath)).toEqual([".backup-v5.pending", ".backup-v4"]);
    expect(existsSync(`${dbPath}.backup-v4`)).toBe(false);
    expect(names().filter((name) => name.startsWith("volli.db.backup-v4.corrupt-"))).toHaveLength(
      1,
    );
    expect(existsSync(`${dbPath}.backup-v5`)).toBe(true);
  });

  it.each(["damaged in place", "replaced by another file"])(
    "checks this upgrade's copy again when it was %s after verification, and prunes nothing",
    (change) => {
      const { dbPath, page } = profile();
      copyFileSync(dbPath, `${dbPath}.backup-v3`);
      copyFileSync(dbPath, `${dbPath}.backup-v4`);

      upgrade(dbPath, () => {
        const copy = `${dbPath}.backup-v5`;
        if (change === "damaged in place") {
          zeroPage(copy, page);
        } else {
          copyFileSync(copy, `${copy}.other`);
          zeroPage(`${copy}.other`, page);
          renameSync(`${copy}.other`, copy);
        }
      });

      expect(checkedNames(dbPath)).toEqual([
        ".backup-v5.pending",
        ".backup-v5",
        ".backup-v3",
        ".backup-v4",
      ]);
      // Failed its check: out of the recovery names, and no clean copy deleted on its word.
      expect(existsSync(`${dbPath}.backup-v5`)).toBe(false);
      expect(names().filter((name) => name.startsWith("volli.db.backup-v5.corrupt-"))).toHaveLength(
        1,
      );
      expect(existsSync(`${dbPath}.backup-v3`)).toBe(true);
      expect(existsSync(`${dbPath}.backup-v4`)).toBe(true);
    },
  );

  it("checks this upgrade's copy again when bytes appear in its WAL", () => {
    const { dbPath } = profile();
    copyFileSync(dbPath, `${dbPath}.backup-v4`);

    upgrade(dbPath, () => writeFileSync(`${dbPath}.backup-v5-wal`, "frames"));

    expect(checkedNames(dbPath)).toEqual([".backup-v5.pending", ".backup-v5", ".backup-v4"]);
  });

  it("does not count an empty WAL beside the copy as a change", () => {
    const { dbPath } = profile();

    upgrade(dbPath, () => writeFileSync(`${dbPath}.backup-v5-wal`, ""));

    expect(checkedNames(dbPath)).toEqual([".backup-v5.pending"]);
  });
});
