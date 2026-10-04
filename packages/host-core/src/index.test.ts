import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(() => strict.database.db.exec("BEGIN")).toThrow("transaction ownership");
    expect(strict.database.db.inTransaction).toBe(false);

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
    expect(log.error).toHaveBeenCalledWith(
      "[volli] failed to open database:",
      expect.stringContaining("damaged header"),
    );
  });
});
