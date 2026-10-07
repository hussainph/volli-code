import { afterEach, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations";
import { applyMigrationsByHand, openRawDb } from "./test-helpers";

const handles: Database.Database[] = [];
function memoryDb(): Database.Database {
  // No filesystem durability is under test here: compare the helper's
  // statement semantics and connection settings without rebuilding the
  // fsync-heavy fixtures that VC-717 removes from migrations.test.ts.
  const db = openRawDb(":memory:");
  handles.push(db);
  db.pragma("foreign_keys = ON");
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
});

describe("applyMigrationsByHand", () => {
  it.each([
    { version: 34, skip: 20 },
    { version: 43, skip: 0 },
  ])("preserves the v$version lineage (skipping $skip)", ({ version, skip }) => {
    const include = (migration: (typeof MIGRATIONS)[number]) =>
      migration.version <= version && migration.version !== skip;
    const baseline = memoryDb();
    for (const migration of MIGRATIONS.filter(include)) {
      if (migration.apply !== undefined) migration.apply(baseline);
      else baseline.exec(migration.sql);
    }
    const fixture = memoryDb();
    applyMigrationsByHand(fixture, include);
    expect(fixture.serialize().equals(baseline.serialize())).toBe(true);
    expect(fixture.pragma("foreign_keys", { simple: true })).toBe(1);
    // The caller, not this helper, owns user_version.
    expect(fixture.pragma("user_version", { simple: true })).toBe(0);
  });

  it.each([1, 2, 3])("restores synchronous = %i after success", (synchronous) => {
    const db = memoryDb();
    db.pragma(`synchronous = ${synchronous}`);
    applyMigrationsByHand(db, (migration) => {
      expect(db.pragma("synchronous", { simple: true })).toBe(0);
      return migration.version === 1;
    });
    expect(db.pragma("synchronous", { simple: true })).toBe(synchronous);
    expect(db.inTransaction).toBe(false);
  });

  it("restores synchronous when fixture selection throws", () => {
    const db = memoryDb();
    db.pragma("synchronous = NORMAL");
    const failure = new Error("fixture selection failed");
    expect(() =>
      applyMigrationsByHand(db, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("restores synchronous when applying a migration throws", () => {
    const db = memoryDb();
    db.pragma("synchronous = FULL");
    db.exec("CREATE TABLE projects (id TEXT)");
    expect(() => applyMigrationsByHand(db, (migration) => migration.version === 1)).toThrow(
      "table projects already exists",
    );
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.inTransaction).toBe(false);
  });
});
