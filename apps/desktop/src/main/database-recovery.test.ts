import Database from "better-sqlite3";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { DatabaseRecoveryListResult, DatabaseRecoveryRestoreResult } from "../ipc/contract";

function fullDiskFailure() {
  return Object.assign(new Error("injected full disk"), { code: "ENOSPC" });
}

const { handlers, faults } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  faults: { dbPath: "", publish: false, rollback: false, moveWal: false, finish: false },
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      // Putting an original sidecar back from the preserved directory.
      if (
        faults.rollback &&
        String(args[0]).includes(".damaged-") &&
        String(args[1]).startsWith(faults.dbPath)
      )
        throw fullDiskFailure();
      return fs.linkSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (faults.finish && String(args[0]) === `${faults.dbPath}.recovery-pending`)
        throw fullDiskFailure();
      return fs.unlinkSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.moveWal && String(args[0]) === `${faults.dbPath}-wal`) throw fullDiskFailure();
      // Publishing the staged copy onto the live path.
      if (
        faults.publish &&
        String(args[0]).includes(".restore-") &&
        String(args[1]) === faults.dbPath
      )
        throw fullDiskFailure();
      return fs.renameSync(...args);
    },
  };
});
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));

import * as database from "@volli/host-core/db";
import { migrate, MIGRATIONS, MIN_READER_VERSION_KEY } from "@volli/host-core/db";
import { DatabaseRecovery, NO_CLEAN_BACKUP } from "@volli/host-core/maintenance";
import { beginDatabaseRecovery, recoveryPendingPath } from "@volli/host-core/testing";
import { registerDatabaseRecoveryIpcHandlers } from "./database-recovery-ipc";

const head = MIGRATIONS.at(-1)!.version;
const headBackupName = `volli.db.backup-v${head}`;
const templates = new Map<number, Buffer>();
let templateDirectory: string;
let damagedTemplate: Buffer;
let directory: string;
let dbPath: string;
let recovery: DatabaseRecovery;

// Build real, empty SQLite schemas once; each test writes its own independent
// copy. Closing the WAL-mode handles checkpoints the templates but retains the
// WAL header flags, so integrity verification still exercises deserialization.
// The one remaining full template migration can be I/O-bound on loaded CI.
beforeAll(() => {
  templateDirectory = mkdtempSync(join(tmpdir(), "volli-recovery-templates-"));
  for (const version of [1, 2, head]) {
    const path = join(templateDirectory, `template-v${version}.db`);
    const db = new Database(path);
    try {
      db.pragma("journal_mode = WAL");
      migrate(db, path, { toVersion: version });
    } finally {
      db.close();
    }
    templates.set(version, readFileSync(path));
  }
  const damagedPath = join(templateDirectory, "damaged.db");
  const damaged = new Database(damagedPath);
  damaged.exec(
    "CREATE TABLE damaged_probe(value TEXT); CREATE INDEX damaged_probe_idx ON damaged_probe(value); INSERT INTO damaged_probe VALUES ('evidence')",
  );
  const { rootpage } = damaged
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'damaged_probe_idx'")
    .get() as { rootpage: number };
  const pageSize = damaged.pragma("page_size", { simple: true }) as number;
  damaged.close();
  damagedTemplate = readFileSync(damagedPath);
  damagedTemplate.fill(0, (rootpage - 1) * pageSize, rootpage * pageSize);
}, 15000);

afterAll(() => {
  templates.clear();
  rmSync(templateDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "volli-recovery-test-"));
  dbPath = join(directory, "volli.db");
  Object.assign(faults, { dbPath, publish: false, rollback: false, moveWal: false, finish: false });
  writeFileSync(dbPath, damagedTemplate);
  recovery = new DatabaseRecovery({ dbPath, userData: directory });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  handlers.clear();
  rmSync(directory, { recursive: true, force: true });
});

function writeTemplate(path: string, version = head): void {
  const bytes = templates.get(version);
  if (!bytes) throw new Error(`Missing recovery template for schema ${version}`);
  writeFileSync(path, bytes);
}

// Swap, checkpoint, integrity and IPC tests need real schemas, not repeated
// full upgrades. Only the explicit upgrade tests below use old-version copies.
function backup(version = head, value = "saved", modifiedAt = 1000): string {
  const path = `${dbPath}.backup-v${version}`;
  writeTemplate(path, version);
  const db = new Database(path);
  try {
    db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "recovery-test",
      value,
      1,
    );
  } finally {
    db.close();
  }
  utimesSync(path, modifiedAt, modifiedAt);
  return path;
}

// Buffer.equals checks every byte and the length in native code. Generic deep
// equality enumerates hundreds of thousands of byte properties for head-schema
// images, which can consume most of the default test timeout under CI load.
function expectFileBytes(path: string, bytes: Buffer): void {
  expect(readFileSync(path).equals(bytes), path).toBe(true);
}

function bundle(): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(directory).map((name) => [name, readFileSync(join(directory, name))]),
  );
}

function invoke<T>(channel: string, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler({ sender: {} }, ...args) as T;
}

function preservedDirectory(): string {
  const name = readdirSync(directory).find((entry) => entry.startsWith("volli.db.damaged-"));
  if (!name) throw new Error("No preserved database");
  return join(directory, name);
}

describe("DatabaseRecovery", () => {
  it("lists exact-name safety copies newest first, with clean, damaged and unavailable status", () => {
    backup(1, "older", 200);
    backup(2, "newer", 300);
    writeFileSync(`${dbPath}.backup-v3`, Buffer.alloc(4096));
    utimesSync(`${dbPath}.backup-v3`, 400, 400);
    symlinkSync(`${dbPath}.backup-v1`, `${dbPath}.backup-v4`);
    utimesSync(dbPath, 500, 500);
    writeFileSync(`${dbPath}.backup-v1.extra`, "not a backup");
    writeFileSync(`${dbPath}.backup-v5-wal`, "not a standalone backup");
    const entries = recovery.list();
    expect(entries.map((entry) => entry.name)).toEqual([
      "volli.db.backup-v4",
      "volli.db.backup-v3",
      "volli.db.backup-v2",
      "volli.db.backup-v1",
    ]);
    expect(entries.map((entry) => entry.integrity)).toEqual([
      "unavailable",
      "damaged",
      "clean",
      "clean",
    ]);
    expect(readdirSync(directory).some((name) => name.endsWith("-shm"))).toBe(false);
  });

  // This upgrade must run real migrations, safety-copy fsyncs and integrity
  // checks rather than a head template; allow for loaded CI disk latency.
  it("restores the newest clean backup, upgrades and rechecks it, preserving all other copies", () => {
    const old = backup(1, "old", 100);
    const chosen = backup(2, "chosen", 200);
    const bad = `${dbPath}.backup-v3`;
    writeFileSync(bad, "corrupt newer copy");
    utimesSync(bad, 300, 300);
    const originalCopies = [old, chosen, bad].map((path) => [path, readFileSync(path)] as const);
    expect(recovery.restore()).toBe("volli.db.backup-v2");
    for (const [path, bytes] of originalCopies) expectFileBytes(path, bytes);
    const restored = database.openVolliDb(dbPath);
    try {
      expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
      expect(restored.pragma("user_version", { simple: true })).toBe(MIGRATIONS.at(-1)?.version);
      expect(
        restored.prepare("SELECT value FROM app_state WHERE key = 'recovery-test'").get(),
      ).toEqual({ value: "chosen" });
    } finally {
      restored.close();
    }
    expect(readdirSync(directory).some((name) => name.startsWith("volli.db.restore-"))).toBe(false);
  }, 15000);

  it("preserves the damaged database and its original WAL/SHM byte-for-byte before checkpoint", () => {
    backup();
    writeFileSync(`${dbPath}-wal`, "damaged WAL evidence");
    writeFileSync(`${dbPath}-shm`, "damaged SHM evidence");
    const original = ["", "-wal", "-shm"].map(
      (suffix) => [suffix, readFileSync(`${dbPath}${suffix}`)] as const,
    );
    recovery.restore();
    const saved = preservedDirectory();
    for (const [suffix, bytes] of original)
      expectFileBytes(join(saved, "before-checkpoint", `volli.db${suffix}`), bytes);
    expectFileBytes(join(saved, "volli.db"), original[0]![1]);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  it.each([false, true])(
    "fails closed without touching anything when no backup is clean (corrupt copy: %s)",
    (includeCopy) => {
      if (includeCopy) writeFileSync(`${dbPath}.backup-v1`, "also damaged");
      writeFileSync(`${dbPath}-wal`, "keep WAL");
      const original = bundle();
      expect(() => recovery.restore()).toThrow(NO_CLEAN_BACKUP);
      expect(bundle()).toEqual(original);
    },
  );

  it("detects a zeroed index page in an otherwise valid SQLite image", () => {
    const path = backup();
    const db = new Database(path);
    db.exec(
      "CREATE TABLE integrity_probe (value TEXT); CREATE INDEX integrity_probe_idx ON integrity_probe(value); INSERT INTO integrity_probe VALUES ('saved')",
    );
    const row = db
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'integrity_probe_idx'")
      .get() as { rootpage: number };
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    db.close();
    const bytes = readFileSync(path);
    bytes.fill(0, (row.rootpage - 1) * pageSize, row.rootpage * pageSize);
    writeFileSync(path, bytes);
    expect(recovery.list()[0]?.integrity).toBe("damaged");
    expect(() => recovery.restore()).toThrow(NO_CLEAN_BACKUP);
    expectFileBytes(path, bytes);
  });

  it("accepts empty verification WAL/SHM caches without modifying or following them", () => {
    const path = backup();
    const bytes = readFileSync(path);
    writeFileSync(`${path}-wal`, "");
    writeFileSync(`${path}-shm`, Buffer.alloc(32768));
    const shm = readFileSync(`${path}-shm`);
    expect(recovery.list()[0]?.integrity).toBe("clean");
    expect(recovery.restore()).toBe(headBackupName);
    expectFileBytes(path, bytes);
    expectFileBytes(`${path}-shm`, shm);
    expect(readFileSync(`${path}-wal`).length).toBe(0);
  });

  it("offers a clean same-version original preserved by migration safety checks", () => {
    const path = backup();
    const name = `${headBackupName}.preserved-01234567-89ab-cdef-0123-456789abcdef`;
    renameSync(path, join(directory, name));
    const bytes = readFileSync(join(directory, name));
    expect(recovery.list()[0]).toMatchObject({ name, integrity: "clean" });
    expect(recovery.restore()).toBe(name);
    expectFileBytes(join(directory, name), bytes);
  });

  it("checks real WAL-mode migration copies without modifying their bytes", () => {
    const path = backup();
    const bytes = readFileSync(path);
    expect([bytes[18], bytes[19]]).toEqual([2, 2]);
    expect(recovery.list()[0]?.integrity).toBe("clean");
    expectFileBytes(path, bytes);
  });

  it("rejects an empty file and a backup with a journal rather than checking only its base", () => {
    backup();
    writeFileSync(`${dbPath}.backup-v${head}-wal`, "uncheckpointed data");
    writeFileSync(`${dbPath}.backup-v2`, "");
    expect(
      recovery
        .list()
        .map((entry) => entry.integrity)
        .toSorted(),
    ).toEqual(["damaged", "unavailable"]);
    expect(() => recovery.restore()).toThrow(NO_CLEAN_BACKUP);
  });

  it("rolls back to the original bundle if re-opening the installed database fails", () => {
    backup();
    writeFileSync(`${dbPath}-wal`, "original WAL");
    const original = readFileSync(dbPath);
    const originalWal = readFileSync(`${dbPath}-wal`);
    const failing = new DatabaseRecovery({
      dbPath,
      userData: directory,
      faults: (step) => {
        if (step === "swap:verify") throw new Error("injected installed re-open failure");
      },
    });
    expect(() => failing.restore()).toThrow("Restore failed");
    expectFileBytes(dbPath, original);
    expectFileBytes(join(preservedDirectory(), "before-checkpoint", "volli.db-wal"), originalWal);
    expect(existsSync(join(preservedDirectory(), "failed-restore"))).toBe(true);
    expect(recovery.list()[0]?.integrity).toBe("clean");
  });

  it("fails before switching the current DB if a clean but incompatible backup cannot migrate", () => {
    const path = `${dbPath}.backup-v1`;
    const incompatible = new Database(path);
    incompatible.exec("CREATE TABLE unrelated (id INTEGER); PRAGMA user_version = 1");
    incompatible.close();
    const original = bundle();
    expect(recovery.list()[0]?.integrity).toBe("clean");
    expect(() => recovery.restore()).toThrow("Restore failed");
    // Staging fails before the swap takes any lock: nothing at all changed.
    expect(bundle()).toEqual(original);
  });

  it("refuses out-of-userData paths and linked current databases", () => {
    backup();
    const other = new DatabaseRecovery({ dbPath, userData: join(directory, "other") });
    expect(() => other.list()).toThrow("local user-data database");
    const linked = join(directory, "linked.db");
    symlinkSync(dbPath, linked);
    expect(() => new DatabaseRecovery({ dbPath: linked, userData: directory }).restore()).toThrow(
      "regular local files",
    );
  });

  // Real lock refusal waits for SQLite's 5 s busy timeout; leave room for CI load.
  it("refuses a WAL reader before marking or displacing the current DB", () => {
    backup();
    rmSync(dbPath);
    writeTemplate(dbPath);
    const writer = database.openVolliDb(dbPath);
    writer
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
      .run("busy-test", "original", 1);
    const reader = new Database(dbPath);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM app_state").all();
      writer.prepare("UPDATE app_state SET value = 'newer' WHERE key = 'busy-test'").run();
      expect(() => recovery.restore()).toThrow("Close other Volli instances");
      expect(writer.prepare("SELECT value FROM app_state WHERE key = 'busy-test'").get()).toEqual({
        value: "newer",
      });
      expect(recovery.list()[0]?.integrity).toBe("clean");
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
      expect(readdirSync(directory).some((entry) => entry.startsWith("volli.db.damaged-"))).toBe(
        false,
      );
    } finally {
      reader.close();
      writer.close();
    }
    const reopened = database.openVolliDb(dbPath);
    try {
      expect(reopened.prepare("SELECT value FROM app_state WHERE key = 'busy-test'").get()).toEqual(
        {
          value: "newer",
        },
      );
    } finally {
      reopened.close();
    }
  }, 15000);

  it.each(["publication", "rollback", "sidecar-move"] as const)(
    "fails closed across a full-disk %s boundary and can resume",
    (boundary) => {
      const path = backup();
      const backupBytes = readFileSync(path);
      const damagedBytes = readFileSync(dbPath);
      writeFileSync(`${dbPath}-wal`, "preserved WAL evidence");
      faults.publish = boundary !== "sidecar-move";
      faults.rollback = boundary === "rollback";
      faults.moveWal = boundary === "sidecar-move";
      expect(() => recovery.restore()).toThrow("Restore failed");
      expect(existsSync(recoveryPendingPath(dbPath))).toBe(true);
      // The live path never went empty: the damaged base stayed in place.
      expectFileBytes(dbPath, damagedBytes);
      expect(() => database.openVolliDb(dbPath)).toThrow("interrupted");
      const saved = preservedDirectory();
      expectFileBytes(join(saved, "before-checkpoint", "volli.db"), damagedBytes);
      expect(readFileSync(join(saved, "before-checkpoint", "volli.db-wal")).toString()).toBe(
        "preserved WAL evidence",
      );
      expectFileBytes(path, backupBytes);
      Object.assign(faults, { publish: false, rollback: false, moveWal: false });
      expect(recovery.restore()).toBe(headBackupName);
      expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
      expectFileBytes(path, backupBytes);
    },
  );

  it("refuses a malformed header without letting SQLite delete its WAL or SHM", () => {
    const path = backup();
    writeFileSync(dbPath, "damaged header evidence");
    writeFileSync(`${dbPath}-wal`, "WAL evidence");
    writeFileSync(`${dbPath}-shm`, "SHM evidence");
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path].map(
      (file) => [file, readFileSync(file)] as const,
    );
    expect(() => recovery.restore()).toThrow("Restore failed");
    for (const [file, bytes] of files) expectFileBytes(file, bytes);
    // Header validation now precedes intent. No swap began, but damaged files
    // still refuse boot and their raw evidence remains available for recovery.
    expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
    const saved = preservedDirectory();
    for (const suffix of ["", "-wal", "-shm"])
      expectFileBytes(
        join(saved, "before-checkpoint", `volli.db${suffix}`),
        readFileSync(`${dbPath}${suffix}`),
      );
    expect(() => database.openVolliDb(dbPath)).toThrow("damaged header");
    for (const [file, bytes] of files) expectFileBytes(file, bytes);
  });

  it("does not undo a verified publication when marker cleanup fails", () => {
    const path = backup();
    const original = readFileSync(dbPath);
    faults.finish = true;
    expect(() => recovery.restore()).toThrow("restored and checked");
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(recoveryPendingPath(dbPath))).toBe(true);
    const restored = database.openVolliDb(dbPath, { allowPendingRecovery: true });
    expect(
      restored.prepare("SELECT value FROM app_state WHERE key = 'recovery-test'").get(),
    ).toEqual({ value: "saved" });
    restored.close();
    expectFileBytes(join(preservedDirectory(), "before-checkpoint", "volli.db"), original);
    expect(existsSync(path)).toBe(true);
    faults.finish = false;
    expect(recovery.restore()).toBe(headBackupName);
  });

  // The real startup fence waits up to 5 s; the timeout also covers loaded CI I/O.
  it("blocks restoration while another boot has a dormant uninitialized DB handle", () => {
    backup();
    rmSync(dbPath);
    writeTemplate(dbPath);
    const seeded = database.openVolliDb(dbPath);
    seeded
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
      .run("current-only", "original", 1);
    seeded.close();
    const pragma = Database.prototype.pragma;
    let intercepted = false;
    const spy = vi
      .spyOn(Database.prototype, "pragma")
      .mockImplementation(function (this: Database.Database, source, options) {
        if (
          !intercepted &&
          !this.readonly &&
          this.name === dbPath &&
          source === "journal_mode = WAL"
        ) {
          // Constructor has returned, but the current handle has not executed its
          // first SQLite operation. The adjacent startup mutex is already held.
          intercepted = true;
          expect(() => recovery.restore()).toThrow("Close other Volli instances");
        }
        return pragma.call(this, source, options);
      });
    try {
      const booted = database.openVolliDb(dbPath);
      expect(intercepted).toBe(true);
      expect(
        booted.prepare("SELECT value FROM app_state WHERE key = 'current-only'").get(),
      ).toEqual({ value: "original" });
      booted.close();
      expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  }, 15000);

  // Real exclusive-ownership refusal waits for SQLite's 5 s busy timeout.
  it("refuses an idle existing writer, not just an active WAL reader", () => {
    backup();
    rmSync(dbPath);
    writeTemplate(dbPath);
    const writer = database.openVolliDb(dbPath);
    writer.exec(
      "CREATE TABLE idle_writer_probe (value TEXT); INSERT INTO idle_writer_probe VALUES ('before')",
    );
    try {
      expect(() => recovery.restore()).toThrow("Close other Volli instances");
      writer.exec("INSERT INTO idle_writer_probe VALUES ('after')");
      expect(writer.prepare("SELECT value FROM idle_writer_probe ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "after" },
      ]);
      expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
      expect(readdirSync(directory).some((entry) => entry.startsWith("volli.db.damaged-"))).toBe(
        false,
      );
    } finally {
      writer.close();
    }
    const reopened = database.openVolliDb(dbPath);
    try {
      expect(reopened.prepare("SELECT value FROM idle_writer_probe ORDER BY rowid").all()).toEqual([
        { value: "before" },
        { value: "after" },
      ]);
    } finally {
      reopened.close();
    }
  }, 15000);

  it("resumes an interrupted switch without allowing boot to create an empty database", () => {
    backup();
    const original = readFileSync(dbPath);
    const preserved = join(directory, "prior-preserved.db");
    writeFileSync(preserved, original);
    beginDatabaseRecovery(dbPath, "prior-preservation-directory");
    rmSync(dbPath);
    expect(() => database.openVolliDb(dbPath)).toThrow("interrupted");
    expect(existsSync(dbPath)).toBe(false);
    expect(recovery.list()[0]?.integrity).toBe("clean");
    expect(recovery.restore()).toBe(headBackupName);
    expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
    expectFileBytes(preserved, original);
    const reopened = database.openVolliDb(dbPath);
    reopened.close();
  });

  it("keeps interrupted-recovery intent when a publication re-open fails", () => {
    backup();
    const failing = new DatabaseRecovery({
      dbPath,
      userData: directory,
      faults: (step) => {
        if (step === "swap:verify") throw new Error("injected re-open failure");
      },
    });
    expect(() => failing.restore()).toThrow("Restore failed");
    expect(existsSync(recoveryPendingPath(dbPath))).toBe(true);
    expect(() => database.openVolliDb(dbPath)).toThrow("interrupted");
    expect(recovery.restore()).toBe(headBackupName);
    expect(existsSync(recoveryPendingPath(dbPath))).toBe(false);
  });

  it("refuses a linked damaged WAL and preserves its target", () => {
    const clean = backup();
    const bytes = readFileSync(clean);
    const original = readFileSync(dbPath);
    symlinkSync(clean, `${dbPath}-wal`);
    expect(() => recovery.restore()).toThrow("Restore failed");
    expectFileBytes(dbPath, original);
    expectFileBytes(clean, bytes);
  });
});

describe("a safety copy from a newer Volli (VC-602)", () => {
  /** A clean copy stamped past this build's head, with the given floor. */
  function newerBackup(floor: number, modifiedAt: number): string {
    const path = backup(head, "newer", modifiedAt);
    const db = new Database(path);
    try {
      db.pragma(`user_version = ${head + 1}`);
      db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)").run(
        MIN_READER_VERSION_KEY,
        String(floor),
      );
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    // Same name family a newer build's migration leaves behind.
    const renamed = `${dbPath}.backup-v${head + 1}`;
    renameSync(path, renamed);
    utimesSync(renamed, modifiedAt, modifiedAt);
    return renamed;
  }

  // Keep a real v1 -> head restore after rejecting the newer copy. Its full
  // migration, checkpoint and fsync work needs headroom on loaded CI.
  it("is listed as newer and passed over for the newest copy this build can open", () => {
    backup(1, "older", 1000);
    const newer = newerBackup(head + 1, 3000);
    const bytes = readFileSync(newer);

    expect(recovery.list().map(({ name, integrity }) => ({ name, integrity }))).toEqual([
      { name: `volli.db.backup-v${head + 1}`, integrity: "newer" },
      { name: "volli.db.backup-v1", integrity: "clean" },
    ]);
    expect(recovery.restore()).toBe("volli.db.backup-v1");
    expectFileBytes(newer, bytes);
  }, 15000);

  it("is clean, and restorable, when its floor admits this build", () => {
    newerBackup(head, 3000);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(recovery.list()[0]?.integrity).toBe("clean");
    expect(recovery.restore()).toBe(`volli.db.backup-v${head + 1}`);
    const restored = new Database(dbPath, { readonly: true });
    try {
      // Opened as a compatible newer file: never migrated down.
      expect(restored.pragma("user_version", { simple: true })).toBe(head + 1);
    } finally {
      restored.close();
    }
  });
});

describe("database recovery IPC", () => {
  function register(degraded = true, fault: "unreadable" | "newer-version" = "unreadable") {
    const restart = vi.fn();
    const quit = vi.fn();
    registerDatabaseRecoveryIpcHandlers({
      recovery,
      degraded,
      fault,
      restart,
      quit,
    });
    return Object.assign(restart, { quit });
  }

  it("names the fault and quits on request, only while degraded (VC-602)", () => {
    const degraded = register(true, "newer-version");
    expect(invoke("volli:database-recovery-fault")).toEqual({ ok: true, fault: "newer-version" });
    expect(invoke("volli:database-recovery-quit")).toEqual({ ok: true });
    expect(degraded.quit).toHaveBeenCalledOnce();
    expect(degraded).not.toHaveBeenCalled();

    const healthy = register(false);
    expect(invoke("volli:database-recovery-fault")).toMatchObject({
      ok: false,
      error: expect.stringContaining("failed to open"),
    });
    expect(invoke("volli:database-recovery-quit")).toMatchObject({ ok: false });
    expect(healthy.quit).not.toHaveBeenCalled();
    expect(invoke("volli:database-recovery-quit", "now")).toEqual({
      ok: false,
      error: "Invalid database recovery request",
    });
  });

  it("lists and restores despite degraded data IPC, then requests restart only on success", () => {
    backup();
    const restart = register();
    expect(invoke<DatabaseRecoveryListResult>("volli:database-recovery-list")).toMatchObject({
      ok: true,
      backups: [{ integrity: "clean" }],
    });
    expect(invoke<DatabaseRecoveryRestoreResult>("volli:database-recovery-restore")).toEqual({
      ok: true,
      restoredBackup: headBackupName,
    });
    expect(restart).toHaveBeenCalledOnce();
    expect(invoke<DatabaseRecoveryRestoreResult>("volli:database-recovery-restore")).toMatchObject({
      ok: false,
      error: expect.stringContaining("restarting"),
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("returns explicit no-clean failure and does not restart", () => {
    const restart = register();
    expect(invoke<DatabaseRecoveryRestoreResult>("volli:database-recovery-restore")).toEqual({
      ok: false,
      error: NO_CLEAN_BACKUP,
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it("refuses healthy-mode recovery and renderer-supplied paths", () => {
    backup();
    const restart = register(false);
    expect(invoke<DatabaseRecoveryListResult>("volli:database-recovery-list")).toMatchObject({
      ok: false,
      error: expect.stringContaining("failed to open"),
    });
    register();
    expect(
      invoke<DatabaseRecoveryRestoreResult>("volli:database-recovery-restore", "/tmp/other.db"),
    ).toEqual({ ok: false, error: "Invalid database recovery request" });
    expect(invoke<DatabaseRecoveryListResult>("volli:database-recovery-list", {})).toEqual({
      ok: false,
      error: "Invalid database recovery request",
    });
    expect(restart).not.toHaveBeenCalled();
  });
});
