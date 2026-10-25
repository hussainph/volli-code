import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";
import { openTestDb } from "../db/test-helpers";
import { EXPORT_SOURCES, STREAM_DESTINATIONS, type StreamName } from "./sources";
import { MIGRATION_TABLE_DECISIONS } from "./tables";

let db: Database.Database;
let cleanup: () => void;

beforeAll(() => {
  ({ db, cleanup } = openTestDb());
});
afterAll(() => cleanup());

function liveTables(): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

describe("the migration table register", () => {
  it("decides every table in the live schema exactly once", () => {
    const decided = MIGRATION_TABLE_DECISIONS.map((decision) => decision.table);
    expect(new Set(decided).size).toBe(decided.length);
    expect(decided.toSorted()).toEqual(liveTables());
  });

  it("gives every decision a reason", () => {
    for (const decision of MIGRATION_TABLE_DECISIONS) expect(decision.reason).toMatch(/\S.*\.$/);
  });

  it("matches the sources: every exported or archived table is read, and nothing else is", () => {
    const read = new Set(EXPORT_SOURCES.flatMap((source) => source.tables));
    for (const decision of MIGRATION_TABLE_DECISIONS) {
      if (decision.disposition === "export" || decision.disposition === "legacy") {
        expect(read.has(decision.table), decision.table).toBe(true);
      }
    }
    const carried = new Set(
      MIGRATION_TABLE_DECISIONS.filter(
        (decision) => decision.disposition === "export" || decision.disposition === "legacy",
      ).map((decision) => decision.table),
    );
    for (const table of read) expect(carried.has(table), table).toBe(true);
  });

  it("has a writer for every stream and unique source ids", () => {
    const written = new Set(EXPORT_SOURCES.flatMap((source) => source.streams));
    expect([...written].toSorted()).toEqual(
      (Object.keys(STREAM_DESTINATIONS) as StreamName[]).toSorted(),
    );
    const ids = EXPORT_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ends every source query in an ORDER BY that prepares against the live schema", () => {
    for (const source of EXPORT_SOURCES) {
      // Uniqueness of each key is checked by hand against the schema; this
      // holds the shape a resume's OFFSET depends on.
      expect(source.sql, source.id).toMatch(/ORDER BY [^)]*$/);
      // The query must at least prepare against the live schema.
      expect(() => db.prepare(source.sql), source.id).not.toThrow();
    }
  });
});
