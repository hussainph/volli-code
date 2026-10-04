import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createHostCore,
  defaultDatabasePath,
  logTransactionViolation,
  throwTransactionViolation,
} from "./index";
import type { HostCore } from "./index";
import Database from "better-sqlite3";
import { SCHEMA_HEAD } from "./db/migrations";
import { MIN_READER_VERSION_KEY } from "./db/schema-compatibility";

const dirs: string[] = [];
const opened: HostCore[] = [];
afterEach(() => {
  for (const core of opened.splice(0)) if (core.database.ok) core.database.db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-host-core-"));
  dirs.push(dir);
  return dir;
}
function compose(...args: Parameters<typeof createHostCore>): HostCore {
  const core = createHostCore(...args);
  opened.push(core);
  return core;
}

describe("createHostCore", () => {
  it("opens and migrates <dataDir>/volli.db, creating the directory", () => {
    const root = join(dataDir(), "nested", "profile");
    const log = { error: vi.fn() };
    const core = compose(
      { log },
      { dataDir: root, onTransactionViolation: throwTransactionViolation, devDiagnostics: true },
    );
    expect(core.dataDir).toBe(root);
    expect(core.dbPath).toBe(defaultDatabasePath(root));
    expect(core.dbPath).toBe(join(root, "volli.db"));
    if (!core.database.ok) throw new Error(core.database.error);
    const tables = core.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .all();
    expect(tables).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("opens an explicit database path instead of the data directory's", () => {
    const root = dataDir();
    const databasePath = join(dataDir(), "elsewhere", "override.db");
    const core = compose(
      { log: { error: vi.fn() } },
      {
        dataDir: root,
        databasePath,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
      },
    );
    expect(core.dbPath).toBe(databasePath);
    expect(core.database.ok).toBe(true);
    expect(core.databaseFailure).toBeNull();
  });

  it("installs the transaction-ownership handler the host chose", () => {
    const strict = compose(
      { log: { error: vi.fn() } },
      {
        dataDir: dataDir(),
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: true,
      },
    );
    if (!strict.database.ok) throw new Error(strict.database.error);
    const strictDb = strict.database.db;
    expect(() => strictDb.exec("BEGIN")).toThrow("transaction ownership");
    expect(strictDb.inTransaction).toBe(false);

    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const packaged = compose(
      { log: { error: vi.fn() } },
      {
        dataDir: dataDir(),
        onTransactionViolation: logTransactionViolation,
        devDiagnostics: false,
      },
    );
    if (!packaged.database.ok) throw new Error(packaged.database.error);
    packaged.database.db.exec("BEGIN");
    packaged.database.db.exec("ROLLBACK");
    expect(report).toHaveBeenCalled();
    report.mockRestore();
  });

  it("returns a degraded database with a classified reason instead of throwing", () => {
    const root = dataDir();
    const databasePath = join(root, "volli.db");
    writeFileSync(databasePath, "not a database, and long enough to have a header to read....");
    const log = { error: vi.fn() };
    const core = compose(
      { log },
      {
        dataDir: root,
        databasePath,
        onTransactionViolation: throwTransactionViolation,
        devDiagnostics: false,
      },
    );
    expect(core.database).toEqual({
      ok: false,
      error: expect.stringContaining("damaged header") as unknown,
    });
    expect(core.databaseFailure).toEqual({ kind: "other" });
    expect(log.error).toHaveBeenCalledWith(
      "[volli] failed to open database:",
      expect.stringContaining("damaged header"),
    );
  });

  it("refuses a database from a newer Volli with a typed failure, touching nothing (VC-602)", () => {
    const root = dataDir();
    const seed = compose(
      { log: { error: vi.fn() } },
      { dataDir: root, onTransactionViolation: throwTransactionViolation, devDiagnostics: false },
    );
    if (!seed.database.ok) throw new Error(seed.database.error);
    seed.database.db.close();
    opened.pop();
    const stamp = new Database(seed.dbPath);
    stamp.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    stamp
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run(MIN_READER_VERSION_KEY, String(SCHEMA_HEAD + 1));
    stamp.pragma("wal_checkpoint(TRUNCATE)");
    stamp.close();
    const hash = () => createHash("sha256").update(readFileSync(seed.dbPath)).digest("hex");
    const before = hash();

    const log = { error: vi.fn() };
    const core = compose(
      { log },
      { dataDir: root, onTransactionViolation: throwTransactionViolation, devDiagnostics: false },
    );

    expect(core.database).toEqual({
      ok: false,
      error:
        "This database was created by a newer version of Volli. Nothing was changed. Update Volli, or restore an older backup.",
    });
    expect(core.databaseFailure).toEqual({
      kind: "newer-version",
      schemaVersion: SCHEMA_HEAD + 1,
      supportedVersion: SCHEMA_HEAD,
      minReaderVersion: SCHEMA_HEAD + 1,
    });
    expect(log.error).toHaveBeenCalledWith(
      "[volli] failed to open database:",
      expect.stringContaining(`Database schema ${SCHEMA_HEAD + 1} is newer`),
    );
    expect(hash()).toBe(before);
  });
});
