import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { openVolliDb } from "./index";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("openVolliDb read tuning (VC-355)", () => {
  it("applies the read-tuning pragmas and bounds the WAL", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-tuning-"));
    const db = openVolliDb(join(dir, "volli.db"));
    try {
      expect(db.pragma("cache_size", { simple: true })).toBe(-64000);
      expect(db.pragma("mmap_size", { simple: true })).toBe(268435456);
      expect(db.pragma("temp_store", { simple: true })).toBe(2); // MEMORY
      expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(400);
      // The pre-existing steady-state pragmas survive alongside the new ones.
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    } finally {
      db.close();
    }
  });

  it("leaves bounded planner statistics behind after migrations", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-tuning-"));
    const db = openVolliDb(join(dir, "volli.db"));
    try {
      // The bounded ANALYZE after migrations leaves planner statistics
      // behind, so the planner never starts a launch blind.
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'sqlite_stat1'")
        .get() as { count: number } | undefined;
      expect(row?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("does not rerun ANALYZE on a routine open", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-tuning-"));
    const path = join(dir, "volli.db");
    const first = openVolliDb(path);
    first.exec(`
      CREATE TABLE analyze_probe (id INTEGER PRIMARY KEY, value TEXT);
      CREATE INDEX analyze_probe_value ON analyze_probe(value);
      INSERT INTO analyze_probe (value) VALUES ('present');
      ANALYZE analyze_probe;
      DELETE FROM sqlite_stat1 WHERE tbl = 'analyze_probe';
    `);
    first.close();

    const reopened = openVolliDb(path);
    try {
      expect(
        reopened
          .prepare("SELECT COUNT(*) AS count FROM sqlite_stat1 WHERE tbl = 'analyze_probe'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      reopened.close();
    }
  });
});
