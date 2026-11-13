/**
 * The schema upgrade off the calling thread (VC-1105), through a real worker
 * thread running the shipped worker protocol: what it answers, what it leaves
 * on disk, what its log lines become here, and the handoff that lets the
 * host's own open skip the quick check the worker just ran.
 */
import Database from "better-sqlite3";
import {
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { captureHostLog, type CapturedHostLog } from "../testing/log";
import { recoveryPendingPath } from "./recovery-pending";
import {
  checkedDatabaseFile,
  databaseStartupWork,
  openVolliDb,
  pendingDatabaseUpgrade,
  ROUTINE_CHECK_OFF_MAIN_BYTES,
} from "./database-file";
import { prepareDbOpenFailure, runDatabaseUpgradeWorker } from "./database-upgrade";
import type { FileCloneDeps } from "./file-clone";
import { migrate, SCHEMA_HEAD } from "./migrations";
import { MIN_READER_VERSION_KEY } from "./schema-compatibility";
import { openRawDb } from "./test-helpers";

const ENTRY = new URL("./test-support/upgrade-worker-under-node.mjs", import.meta.url);
const ARGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
const FROM = SCHEMA_HEAD - 3;

let dir: string | undefined;
let log: CapturedHostLog | undefined;
afterEach(() => {
  log?.restore();
  log = undefined;
  vi.restoreAllMocks();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A closed database an older build left: schema {@link FROM}, one probe row. */
function olderDatabase(): string {
  dir = mkdtempSync(join(tmpdir(), "volli-db-upgrade-"));
  const dbPath = join(dir, "volli.db");
  const db = openRawDb(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db, dbPath, { toVersion: FROM });
  db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('probe', 'kept', 1)").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return dbPath;
}

function upgrade(dbPath: string) {
  return runDatabaseUpgradeWorker(ENTRY, { dbPath, logLevel: "info", dev: false }, ARGS);
}

function quickChecks(): () => number {
  const pragma = vi.spyOn(Database.prototype, "pragma");
  return () => pragma.mock.calls.filter(([source]) => source === "quick_check").length;
}

describe("pendingDatabaseUpgrade", () => {
  it("answers only for an existing database older than this build", () => {
    const dbPath = olderDatabase();
    expect(pendingDatabaseUpgrade(dbPath)).toEqual({ fromVersion: FROM, toVersion: SCHEMA_HEAD });
    // A swap's fence: the ordinary open refuses it, so nothing is upgraded here.
    writeFileSync(recoveryPendingPath(dbPath), "{}");
    expect(pendingDatabaseUpgrade(dbPath)).toBeNull();
    rmSync(recoveryPendingPath(dbPath));

    const current = openVolliDb(dbPath);
    current.close();
    expect(pendingDatabaseUpgrade(dbPath)).toBeNull();
    expect(pendingDatabaseUpgrade(join(dir!, "missing.db"))).toBeNull();
    const damaged = join(dir!, "damaged.db");
    writeFileSync(damaged, "not a database, and long enough to have a header to read....");
    expect(pendingDatabaseUpgrade(damaged)).toBeNull();
    const fresh = join(dir!, "fresh.db");
    new Database(fresh).close();
    expect(pendingDatabaseUpgrade(fresh)).toBeNull();
  });
});

describe("databaseStartupWork", () => {
  it("sends every upgrade and every large database to the worker, and leaves the rest to the host", () => {
    const dbPath = olderDatabase();
    expect(databaseStartupWork(dbPath)).toEqual({
      kind: "upgrade",
      fromVersion: FROM,
      toVersion: SCHEMA_HEAD,
    });
    openVolliDb(dbPath).close();
    // Nothing to migrate is still the routine check, on every launch, off
    // main from the size where it can take long; below it, on main as before.
    const bytes = statSync(dbPath).size;
    expect(databaseStartupWork(dbPath, bytes)).toEqual({ kind: "check", bytes });
    expect(databaseStartupWork(dbPath, bytes + 1)).toBeNull();
    expect(databaseStartupWork(dbPath)).toBeNull();
    expect(ROUTINE_CHECK_OFF_MAIN_BYTES).toBeGreaterThan(bytes);
    // A WAL's frames are read by the check too.
    writeFileSync(`${dbPath}-wal`, Buffer.alloc(8));
    expect(databaseStartupWork(dbPath, bytes + 8)).toEqual({ kind: "check", bytes: bytes + 8 });
    rmSync(`${dbPath}-wal`);
    writeFileSync(recoveryPendingPath(dbPath), "{}");
    expect(databaseStartupWork(dbPath, 0)).toBeNull();
    rmSync(recoveryPendingPath(dbPath));
    expect(databaseStartupWork(join(dir!, "missing.db"), 0)).toBeNull();
    const damaged = join(dir!, "damaged.db");
    writeFileSync(damaged, "not a database, and long enough to have a header to read....");
    expect(databaseStartupWork(damaged, 0)).toBeNull();
  });
});

/** Overwrites one page of a closed database in the middle of `app_state`'s table b-tree. */
function damageAppStatePage(dbPath: string): void {
  const db = new Database(dbPath);
  const insert = db.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)");
  db.transaction(() => {
    for (let i = 0; i < 400; i++) insert.run(`filler-${i}`, "x".repeat(200));
  })();
  const { rootpage } = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'app_state'")
    .get() as { rootpage: number };
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const fd = openSync(dbPath, "r+");
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, (rootpage - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
}

describe("a routine launch's check in the worker (VC-1203)", () => {
  it("hands back a clean file's identity, so the host's open does not ask again", async () => {
    const dbPath = olderDatabase();
    openVolliDb(dbPath).close();
    const outcome = await upgrade(dbPath);
    expect(outcome).toEqual({ ok: true, checked: checkedDatabaseFile(dbPath) });
    if (outcome?.ok !== true || outcome.checked === null) throw new Error("no handoff");
    const count = quickChecks();
    openVolliDb(dbPath, { checked: outcome.checked }).close();
    expect(count()).toBe(0);
  });

  it("refuses a damaged file exactly as the host's own open does, leaving it as it was", async () => {
    const dbPath = olderDatabase();
    openVolliDb(dbPath).close();
    damageAppStatePage(dbPath);
    const before = readFileSync(dbPath);

    const outcome = await upgrade(dbPath);
    let onMain: unknown;
    try {
      openVolliDb(dbPath).close();
    } catch (error) {
      onMain = error;
    }
    expect(onMain).toBeInstanceOf(Error);
    expect(outcome).toEqual({ ok: false, ...prepareDbOpenFailure(onMain, false) });
    // A damaged b-tree page: the quick check refuses it (here SQLite throws first).
    expect(outcome?.ok === false && outcome.message).toMatch(/malformed|integrity check/);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });
});

describe("the safety copy an upgrade publishes", () => {
  it.each([
    ["clones", "cp-clone"],
    ["cannot clone", "copy"],
  ] as const)("is the same verified rollback point on a volume that %s", (_volume, method) => {
    const dbPath = olderDatabase();
    log = captureHostLog("info");
    const touched: string[] = [];
    const fileClone: FileCloneDeps = {
      platform: "darwin",
      cloneWithCp: (source, target) => {
        if (method === "copy") throw new Error("cp: clonefile failed");
        copyFileSync(source, target);
      },
      copyFile: (source, target) => copyFileSync(source, target),
      touch: (target) => touched.push(target),
      now: () => new Date(),
    };
    openVolliDb(dbPath, { fileClone }).close();
    const backupPath = `${dbPath}.backup-v${FROM}`;
    expect(touched).toEqual(method === "cp-clone" ? [expect.stringContaining(".pending-")] : []);
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "safety copy staged", method, version: FROM }),
    );
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(FROM);
      expect(backup.prepare("SELECT value FROM app_state WHERE key = 'probe'").get()).toEqual({
        value: "kept",
      });
    } finally {
      backup.close();
    }
  });
});

describe("runDatabaseUpgradeWorker", () => {
  it("upgrades in the worker, closes it, and hands back the file it left", async () => {
    const dbPath = olderDatabase();
    log = captureHostLog("info");
    const outcome = await upgrade(dbPath);

    expect(outcome).toEqual({ ok: true, checked: checkedDatabaseFile(dbPath) });
    expect(outcome?.ok === true && outcome.checked).not.toBeNull();
    expect(pendingDatabaseUpgrade(dbPath)).toBeNull();
    // The rollback point an upgrade always publishes, at the name every build reads.
    expect(readdirSync(dir!)).toContain(`volli.db.backup-v${FROM}`);
    const backup = new Database(join(dir!, `volli.db.backup-v${FROM}`), { readonly: true });
    try {
      expect(backup.pragma("user_version", { simple: true })).toBe(FROM);
    } finally {
      backup.close();
    }
    // The worker's lines are the host's, marked with the thread they came from.
    const upgraded = log.records.find((record) => record.msg === "database upgraded");
    expect(upgraded).toMatchObject({
      component: "db",
      thread: "database-upgrade",
      fromVersion: FROM,
      toVersion: SCHEMA_HEAD,
    });
    expect(Object.keys(upgraded?.["stepsMs"] as object)).toEqual(
      expect.arrayContaining([
        "preflight",
        "source-check",
        "copy",
        "verify-copy",
        "publish",
        "migrations",
        "retention",
        "analyze",
      ]),
    );
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "safety copy staged", thread: "database-upgrade" }),
    );

    // The host's open trusts the worker's check while the file is that file...
    if (outcome?.ok !== true || outcome.checked === null) throw new Error("no handoff");
    const count = quickChecks();
    const db = openVolliDb(dbPath, { checked: outcome.checked });
    expect(db.prepare("SELECT value FROM app_state WHERE key = 'probe'").get()).toEqual({
      value: "kept",
    });
    db.close();
    expect(count()).toBe(0);
    // ...and asks again once anything has changed it.
    const writer = new Database(dbPath);
    writer.prepare("UPDATE app_state SET value = 'changed' WHERE key = 'probe'").run();
    writer.close();
    expect(checkedDatabaseFile(dbPath)).not.toEqual(outcome.checked);
    openVolliDb(dbPath, { checked: outcome.checked }).close();
    expect(count()).toBe(1);
  });

  it("never trusts a handoff across a WAL that holds frames", () => {
    const dbPath = olderDatabase();
    openVolliDb(dbPath).close();
    const checked = checkedDatabaseFile(dbPath);
    expect(checked).not.toBeNull();
    const writer = new Database(dbPath);
    writer.pragma("wal_autocheckpoint = 0");
    writer.prepare("UPDATE app_state SET value = 'in the WAL' WHERE key = 'probe'").run();
    expect(checkedDatabaseFile(dbPath)).toBeNull();
    const count = quickChecks();
    openVolliDb(dbPath, { checked: checked! }).close();
    writer.close();
    expect(count()).toBe(1);
  });

  it("brings a refusal back classified and worded, the file untouched", async () => {
    const dbPath = olderDatabase();
    const stamp = new Database(dbPath);
    stamp.pragma(`user_version = ${SCHEMA_HEAD + 1}`);
    stamp
      .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1)")
      .run(MIN_READER_VERSION_KEY, String(SCHEMA_HEAD + 1));
    stamp.pragma("wal_checkpoint(TRUNCATE)");
    stamp.close();
    const before = checkedDatabaseFile(dbPath);

    await expect(upgrade(dbPath)).resolves.toEqual({
      ok: false,
      failure: {
        kind: "newer-version",
        schemaVersion: SCHEMA_HEAD + 1,
        supportedVersion: SCHEMA_HEAD,
        minReaderVersion: SCHEMA_HEAD + 1,
      },
      message:
        "This database was created by a newer version of Volli. Nothing was changed. Update Volli, or restore an older backup.",
      logLine: expect.stringContaining(`Database schema ${SCHEMA_HEAD + 1} is newer`),
    });
    expect(checkedDatabaseFile(dbPath)).toEqual(before);
  });

  it("answers nothing when the worker never runs, so the host opens it itself", async () => {
    const dbPath = olderDatabase();
    log = captureHostLog("info");
    const missing = new URL("./test-support/no-such-worker.mjs", import.meta.url);
    await expect(
      runDatabaseUpgradeWorker(missing, { dbPath, logLevel: "info", dev: false }, ARGS),
    ).resolves.toBeNull();
    expect(log.records).toContainEqual(
      expect.objectContaining({ msg: "database upgrade worker stopped without an answer" }),
    );
    expect(pendingDatabaseUpgrade(dbPath)).toEqual({ fromVersion: FROM, toVersion: SCHEMA_HEAD });
  });
});
