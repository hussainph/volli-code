import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import Database from "better-sqlite3";
import { openVolliDb } from "./index";
import { beginDatabaseRecovery } from "./recovery-pending";

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

  it("closes the connection when migration fails before entering degraded recovery", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-failed-open-"));
    const path = join(dir, "volli.db");
    const incompatible = new Database(path);
    incompatible.exec("CREATE TABLE unrelated (id INTEGER); PRAGMA user_version = 1");
    incompatible.close();
    const close = vi.spyOn(Database.prototype, "close");
    try {
      expect(() => openVolliDb(path)).toThrow();
      // Both the read-only preflight and the failed writer are closed.
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });

  it("preserves malformed startup files before any write-capable open", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-corrupt-open-"));
    const path = join(dir, "volli.db");
    const files = ["", "-wal", "-shm"].map(
      (suffix) => [path + suffix, Buffer.from(`damaged ${suffix} evidence`)] as const,
    );
    for (const [file, bytes] of files) writeFileSync(file, bytes);
    expect(() => openVolliDb(path)).toThrow();
    for (const [file, bytes] of files) expect(readFileSync(file)).toEqual(bytes);
  });

  it("does not create a missing DB after an interrupted recovery", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-interrupted-open-"));
    const path = join(dir, "volli.db");
    beginDatabaseRecovery(path, "preserved-original");
    expect(() => openVolliDb(path)).toThrow("interrupted");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a zeroed index before overwriting an existing clean migration copy", () => {
    dir = mkdtempSync(join(tmpdir(), "volli-db-corrupt-migration-"));
    const path = join(dir, "volli.db");
    const db = new Database(path);
    db.exec(
      "CREATE TABLE integrity_probe (value TEXT); CREATE INDEX integrity_probe_idx ON integrity_probe(value); INSERT INTO integrity_probe VALUES ('saved'); PRAGMA user_version = 1",
    );
    const { rootpage } = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'integrity_probe_idx'")
      .get() as { rootpage: number };
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    db.close();
    const clean = readFileSync(path);
    writeFileSync(`${path}.backup-v1`, clean);
    const damaged = Buffer.from(clean);
    damaged.fill(0, (rootpage - 1) * pageSize, rootpage * pageSize);
    writeFileSync(path, damaged);
    expect(() => openVolliDb(path)).toThrow();
    expect(readFileSync(`${path}.backup-v1`)).toEqual(clean);
    expect(readFileSync(path)).toEqual(damaged);
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
