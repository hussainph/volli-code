/**
 * Crash tests for the fenced database-file module (VC-628), through its
 * interface, on real SQLite files in a temp directory.
 *
 * A "crash" at a step is a byte copy of the whole profile directory taken
 * inside the fault hook, just before that step changes the disk: exactly what
 * a killed process would leave there (a power cut can lose only what was not
 * yet fsynced, which the ordering tests at the bottom pin). Every crash copy
 * must boot to the original database, refuse to boot behind the intent
 * marker, or boot to the new one — never to an empty first-run database —
 * and every refusal must heal through a recovery swap. Every injected failure
 * must roll back to the original, WAL frames included.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const { fdPaths, log } = vi.hoisted(() => ({
  fdPaths: new Map<number, string>(),
  log: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    copyFileSync: vi.fn(fs.copyFileSync),
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      fdPaths.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      fdPaths.delete(fd);
      return fs.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      log.push(`fsync ${fdPaths.get(fd) ?? "?"}`);
      return fs.fsyncSync(fd);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      log.push(`rename ${String(args[0])} -> ${String(args[1])}`);
      return fs.renameSync(...args);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      log.push(`link ${String(args[0])} -> ${String(args[1])}`);
      return fs.linkSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      log.push(`unlink ${String(args[0])}`);
      return fs.unlinkSync(...args);
    },
  };
});

import Database from "better-sqlite3";
import { DatabaseRecovery } from "../database-recovery";
import {
  DatabaseFileBusyError,
  DatabaseSwapFinalizeError,
  DatabaseSwapRollbackError,
  openVolliDb,
  publishRollbackPoint,
  restoreDatabaseFile,
  swapInStagedProfile,
} from "./database-file";
import type { DatabaseFileStep } from "./database-file";
import { migrate, SCHEMA_HEAD } from "./migrations";
import { recoveryPendingPath } from "./recovery-pending";
import {
  DatabaseFromNewerVersionError,
  MIN_READER_VERSION_KEY,
  raiseMinReaderVersion,
} from "./schema-compatibility";
import { openRawDb } from "./test-helpers";
import { captureHostLog } from "../testing/log";

const PROBE = "database-file-probe";
const COMPANIONS = ["blobs", "session-transcripts"] as const;

class SimulatedCrash extends Error {}

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-dbfile-${prefix}-`));
  scratch.push(dir);
  return dir;
}

let template: string;
beforeAll(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  template = tempDir("template");
  buildLiveProfile(join(template, "live"));
  stageProfile(join(template, "staged"), "staged");
  stageProfile(join(template, "heal"), "healed");
});
afterEach(() => {
  log.length = 0;
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setProbe(db: Database.Database, value: string): void {
  db.prepare(
    "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(PROBE, value);
}

function readProbe(db: Database.Database): string {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(PROBE) as
    | { value: string }
    | undefined;
  // A database without the probe row is a fresh first-run database.
  return row?.value ?? "first-run";
}

/**
 * A live profile as a running app leaves it: the probe row committed only to
 * the WAL (never checkpointed), plus companion directories with content.
 */
function buildLiveProfile(root: string): void {
  mkdirSync(root, { recursive: true });
  const seed = tempDir("seed");
  const db = openVolliDb(join(seed, "volli.db"));
  db.pragma("wal_autocheckpoint = 0");
  setProbe(db, "original");
  for (const suffix of ["", "-wal", "-shm"])
    copyFileSync(join(seed, `volli.db${suffix}`), join(root, `volli.db${suffix}`));
  db.close();
  expect(readFileSync(join(root, "volli.db-wal")).length).toBeGreaterThan(32);
  mkdirSync(join(root, "blobs", "aa"), { recursive: true });
  writeFileSync(join(root, "blobs", "aa", "blob"), "original blob");
  mkdirSync(join(root, "session-transcripts"));
  writeFileSync(join(root, "session-transcripts", "t.json"), "original transcript");
}

/** A staged profile as restore and recovery leave it: checkpointed and closed. */
function stageProfile(root: string, value: string): void {
  mkdirSync(root, { recursive: true });
  const db = openVolliDb(join(root, "volli.db"));
  setProbe(db, value);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  mkdirSync(join(root, "blobs", "bb"), { recursive: true });
  writeFileSync(join(root, "blobs", "bb", "blob"), `${value} blob`);
  mkdirSync(join(root, "session-transcripts"));
  writeFileSync(join(root, "session-transcripts", "t.json"), `${value} transcript`);
}

interface Fixture {
  root: string;
  dbPath: string;
}

function fixture(options: { live?: boolean } = {}): Fixture {
  const root = tempDir("case");
  if (options.live !== false) cpSync(join(template, "live"), root, { recursive: true });
  cpSync(join(template, "staged"), join(root, ".staged"), { recursive: true });
  cpSync(join(template, "heal"), join(root, ".heal"), { recursive: true });
  return { root, dbPath: join(root, "volli.db") };
}

type Mode = "healthy" | "damaged";

function swap(
  { root, dbPath }: Fixture,
  replacing: Mode,
  faults?: (step: DatabaseFileStep) => void,
): void {
  swapInStagedProfile({
    dbPath,
    stagedPath: join(root, ".staged", "volli.db"),
    asideDirectory: join(root, ".aside"),
    replacing,
    companions: COMPANIONS,
    faults,
  });
}

/** What the next boot of this directory sees. */
function boot(dbPath: string): string {
  let db: Database.Database;
  try {
    db = openVolliDb(dbPath);
  } catch (error) {
    if (/interrupted/.test((error as Error).message)) return "refused";
    throw error;
  }
  try {
    return readProbe(db);
  } finally {
    db.close();
  }
}

/** The probe as the file holds it, read without the fence. */
function contents(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return readProbe(db);
  } finally {
    db.close();
  }
}

type Run = (faults: (step: DatabaseFileStep) => void) => void;

/** Every step a run passes, in order; a run that fails on purpose still lists its rollback. */
function stepsOf(run: Run): DatabaseFileStep[] {
  const steps: DatabaseFileStep[] = [];
  try {
    run((step) => {
      steps.push(step);
    });
  } catch {
    // Expected for runs that inject their own failure.
  }
  return steps;
}

/**
 * A byte copy of a directory tree that keeps hard links as hard links, as the
 * disk itself does: names that share an inode in `from` share one in `to`.
 */
function snapshot(from: string, to: string): void {
  const copied = new Map<string, string>();
  const walk = (source: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const path = join(source, entry.name);
      const destination = join(target, entry.name);
      if (entry.isDirectory()) {
        walk(path, destination);
        continue;
      }
      const info = statSync(path);
      const key = `${info.dev}:${info.ino}`;
      const first = copied.get(key);
      if (first === undefined) {
        copyFileSync(path, destination);
        copied.set(key, destination);
      } else {
        linkSync(first, destination);
      }
    }
  };
  walk(from, to);
}

/**
 * Runs `run`, and as a crash would, stops it just before its `index`-th step,
 * after copying the whole directory. Indices, not names: a rollback passes
 * some names twice. Returns the copy.
 */
function crashAt(root: string, index: number, run: Run): Fixture {
  const crash = tempDir("crash");
  let seen = 0;
  let crashed = false;
  try {
    run(() => {
      if (seen++ !== index) return;
      snapshot(root, crash);
      crashed = true;
      throw new SimulatedCrash();
    });
  } catch {
    // The process "died" here; only the copy matters.
  }
  expect(crashed, `never reached step ${index}`).toBe(true);
  return { root: crash, dbPath: join(crash, "volli.db") };
}

/**
 * Fails verification after SQLite left sidecars beside the installed file, so
 * the rest of the run is the whole rollback.
 */
function failingVerification(fx: Fixture, mode: Mode): Run {
  return (faults) =>
    swap(fx, mode, (step) => {
      faults(step);
      if (step !== "swap:verify") return;
      writeFileSync(`${fx.dbPath}-wal`, "");
      writeFileSync(`${fx.dbPath}-shm`, Buffer.alloc(32768));
      throw new Error("injected verification failure");
    });
}

/** Any crash copy that refuses to boot heals through a recovery swap. */
function healAndBoot(copy: Fixture): void {
  swapInStagedProfile({
    dbPath: copy.dbPath,
    stagedPath: join(copy.root, ".heal", "volli.db"),
    asideDirectory: join(copy.root, ".heal-aside"),
    replacing: "damaged",
  });
  expect(boot(copy.dbPath)).toBe("healed");
}

function companion(root: string, entry: string): string[] {
  const dir = join(root, entry);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => readFileSync(join(item.parentPath, item.name), "utf8"))
    .toSorted();
}

describe("swapInStagedProfile — success", () => {
  it.each(["healthy", "damaged"] as const)(
    "installs the staged profile and keeps the original beside it (%s)",
    (mode) => {
      const fx = fixture();
      const floorBefore = minReader(join(fx.root, ".staged", "volli.db"));
      swap(fx, mode);
      expect(boot(fx.dbPath)).toBe("staged");
      expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
      expect(companion(fx.root, "blobs")).toEqual(["staged blob"]);
      expect(companion(fx.root, "session-transcripts")).toEqual(["staged transcript"]);
      // The set-aside family is whole: its WAL frames came with it (folded in
      // by the ownership checkpoint), and so did its companions.
      expect(contents(join(fx.root, ".aside", "volli.db"))).toBe("original");
      expect(companion(join(fx.root, ".aside"), "blobs")).toEqual(["original blob"]);
      if (mode === "damaged") {
        // Raw evidence, byte for byte, from before SQLite touched it.
        expect(readFileSync(join(fx.root, ".aside", "before-checkpoint", "volli.db-wal"))).toEqual(
          readFileSync(join(template, "live", "volli.db-wal")),
        );
      }
      // VC-602: the swap's verification open writes no reader floor.
      expect(minReader(fx.dbPath)).toEqual(floorBefore);
    },
    15_000,
  );

  it("heals an interrupted switch whose live path is already empty", () => {
    const fx = fixture({ live: false });
    writeFileSync(recoveryPendingPath(fx.dbPath), JSON.stringify({ preservedDirectory: "x" }));
    expect(boot(fx.dbPath)).toBe("refused");
    expect(existsSync(fx.dbPath)).toBe(false);
    swap(fx, "damaged");
    expect(boot(fx.dbPath)).toBe("staged");
  });

  it("installs onto a profile that never had a database", () => {
    const fx = fixture({ live: false });
    swap(fx, "healthy");
    expect(boot(fx.dbPath)).toBe("staged");
  });
});

function minReader(dbPath: string): unknown {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT value FROM app_state WHERE key = ?").get(MIN_READER_VERSION_KEY);
  } finally {
    db.close();
  }
}

const FORWARD: DatabaseFileStep[] = [
  "swap:lock",
  "swap:own",
  "swap:mark",
  "swap:set-aside:volli.db",
  "swap:set-aside:volli.db-wal",
  "swap:set-aside:volli.db-shm",
  "swap:set-aside:blobs",
  "swap:set-aside:session-transcripts",
  "swap:install:blobs",
  "swap:install:session-transcripts",
  "swap:publish",
  "swap:verify",
  "swap:finish",
];
const ROLLBACK: DatabaseFileStep[] = [
  "swap:rollback:failed-restore-wal",
  "swap:rollback:failed-restore-shm",
  "swap:rollback:failed-restore",
  "swap:rollback:volli.db",
  "swap:rollback:session-transcripts",
  "swap:rollback:blobs",
  "swap:rollback:volli.db-wal",
  "swap:rollback:volli.db-shm",
  "swap:rollback:blobs",
  "swap:rollback:session-transcripts",
];
const STEPS: Record<Mode, DatabaseFileStep[]> = {
  healthy: FORWARD,
  damaged: ["swap:lock", "swap:preserve-raw", ...FORWARD.slice(1)],
};
const ROLLBACK_STEPS: Record<Mode, DatabaseFileStep[]> = {
  healthy: [...ROLLBACK, "swap:rollback:finish"],
  damaged: ROLLBACK,
};

describe("swapInStagedProfile — the step matrix", () => {
  it.each(["healthy", "damaged"] as const)("names every step it takes, in order (%s)", (mode) => {
    expect(stepsOf((faults) => swap(fixture(), mode, faults))).toEqual(STEPS[mode]);
    const failed = stepsOf(failingVerification(fixture(), mode));
    expect(failed).toEqual([
      ...STEPS[mode].slice(0, STEPS[mode].indexOf("swap:verify") + 1),
      ...ROLLBACK_STEPS[mode],
    ]);
  });
});

describe.each(["healthy", "damaged"] as const)("swapInStagedProfile — %s", (mode) => {
  it.each(STEPS[mode].map((step, index) => [step, index] as const))(
    "a crash just before %s boots the original or refuses, then heals; never first-run",
    (_step, index) => {
      const fx = fixture();
      const copy = crashAt(fx.root, index, (faults) => swap(fx, mode, faults));
      // The live path is never empty, and always holds a whole database.
      expect(existsSync(copy.dbPath)).toBe(true);
      const marked = existsSync(recoveryPendingPath(copy.dbPath));
      expect(marked).toBe(index > STEPS[mode].indexOf("swap:mark"));
      expect(boot(copy.dbPath)).toBe(marked ? "refused" : "original");
      expect(["original", "staged"]).toContain(contents(copy.dbPath));
      if (marked) healAndBoot(copy);
    },
  );

  const rollbackFrom = STEPS[mode].indexOf("swap:verify") + 1;
  it.each(ROLLBACK_STEPS[mode].map((step, index) => [step, rollbackFrom + index] as const))(
    "a crash during rollback, just before %s, still refuses to boot and heals",
    (_step, index) => {
      const fx = fixture();
      const copy = crashAt(fx.root, index, failingVerification(fx, mode));
      expect(existsSync(copy.dbPath)).toBe(true);
      expect(boot(copy.dbPath)).toBe("refused");
      expect(["original", "staged"]).toContain(contents(copy.dbPath));
      healAndBoot(copy);
    },
  );

  const markAt = STEPS[mode].indexOf("swap:mark");
  it.each(STEPS[mode].filter((step) => step !== "swap:finish"))(
    "a failure at %s puts the original profile back, WAL frames included",
    (step) => {
      const fx = fixture();
      expect(() =>
        swap(fx, mode, (at) => {
          if (at === step) throw new Error("injected failure");
        }),
      ).toThrow("injected failure");
      expect(contents(fx.dbPath)).toBe("original");
      expect(companion(fx.root, "blobs")).toEqual(["original blob"]);
      expect(companion(fx.root, "session-transcripts")).toEqual(["original transcript"]);
      // Staged companions are back in staging, for the caller to drop. A
      // published staged file stays only as recovery's failed-install evidence.
      expect(companion(join(fx.root, ".staged"), "blobs")).toEqual(["staged blob"]);
      if (STEPS[mode].indexOf(step) <= STEPS[mode].indexOf("swap:publish"))
        expect(contents(join(fx.root, ".staged", "volli.db"))).toBe("staged");
      else if (mode === "damaged")
        expect(contents(join(fx.root, ".aside", "failed-restore"))).toBe("staged");
      const marked = STEPS[mode].indexOf(step) > markAt;
      if (mode === "healthy") {
        // A healthy profile boots exactly as before, with no trace left.
        expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
        expect(existsSync(join(fx.root, ".aside"))).toBe(false);
        expect(boot(fx.dbPath)).toBe("original");
      } else {
        // Recovery keeps its intent: boot refuses until a swap completes.
        expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(marked);
        if (marked) expect(boot(fx.dbPath)).toBe("refused");
      }
    },
  );

  it("never undoes a verified install when the marker cannot be cleared", () => {
    const fx = fixture();
    expect(() =>
      swap(fx, mode, (step) => {
        if (step === "swap:finish") throw new Error("injected marker failure");
      }),
    ).toThrow(DatabaseSwapFinalizeError);
    expect(contents(fx.dbPath)).toBe("staged");
    expect(boot(fx.dbPath)).toBe("refused");
    expect(contents(join(fx.root, ".aside", "volli.db"))).toBe("original");
  });

  it("keeps the marker and every original file when the rollback itself fails", () => {
    const fx = fixture();
    const error = (() => {
      try {
        swap(fx, mode, (step) => {
          if (step === "swap:verify") throw new Error("injected verification failure");
          if (step === "swap:rollback:volli.db") throw new Error("injected rollback failure");
        });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(DatabaseSwapRollbackError);
    expect((error as DatabaseSwapRollbackError).asideDirectory).toBe(join(fx.root, ".aside"));
    expect(existsSync(fx.dbPath)).toBe(true);
    expect(boot(fx.dbPath)).toBe("refused");
    expect(contents(join(fx.root, ".aside", "volli.db"))).toBe("original");
    healAndBoot(fx);
  });
});

describe("swapInStagedProfile — refusals", () => {
  it.each([false, true])(
    "a damaged-profile busy refusal creates no marker and keeps any inherited intent (%s)",
    (inherited) => {
      const fx = fixture();
      const writer = openVolliDb(fx.dbPath);
      const marker = JSON.stringify({ preservedDirectory: "earlier-attempt" });
      if (inherited) writeFileSync(recoveryPendingPath(fx.dbPath), marker);
      try {
        expect(() => swap(fx, "damaged")).toThrow(DatabaseFileBusyError);
        expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(inherited);
        if (inherited) expect(readFileSync(recoveryPendingPath(fx.dbPath), "utf8")).toBe(marker);
        expect(existsSync(join(fx.root, ".aside"))).toBe(false);
        setProbe(writer, "written after busy refusal");
      } finally {
        writer.close();
      }
      if (!inherited) expect(boot(fx.dbPath)).toBe("written after busy refusal");
      else expect(boot(fx.dbPath)).toBe("refused");
    },
    15_000,
  );

  it.each([false, true])(
    "cleans only a new incomplete raw safety copy on ENOSPC (inherited intent: %s)",
    (inherited) => {
      const fx = fixture();
      const original = readFileSync(fx.dbPath);
      const wal = readFileSync(`${fx.dbPath}-wal`);
      const earlier = join(fx.root, "earlier-attempt");
      mkdirSync(earlier);
      writeFileSync(join(earlier, "keep"), "earlier evidence");
      const marker = JSON.stringify({ preservedDirectory: "earlier-attempt" });
      if (inherited) writeFileSync(recoveryPendingPath(fx.dbPath), marker);
      vi.mocked(copyFileSync).mockImplementationOnce((_source, target) => {
        writeFileSync(target, "partial copy");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      expect(() => swap(fx, "damaged")).toThrow("disk full");
      expect(existsSync(join(fx.root, ".aside"))).toBe(false);
      expect(readFileSync(fx.dbPath)).toEqual(original);
      expect(readFileSync(`${fx.dbPath}-wal`)).toEqual(wal);
      expect(readFileSync(join(earlier, "keep"), "utf8")).toBe("earlier evidence");
      expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(inherited);
      if (inherited) expect(readFileSync(recoveryPendingPath(fx.dbPath), "utf8")).toBe(marker);
    },
    // Copies whole-profile fixtures and durably stages/checks a database even
    // on refusal; allow the same I/O budget as the covered rollback tests.
    30_000,
  );

  it("refuses a live writer instead of detaching it, and leaves a healthy profile as it was", () => {
    const fx = fixture();
    const writer = openVolliDb(fx.dbPath);
    try {
      expect(() => swap(fx, "healthy")).toThrow(DatabaseFileBusyError);
      setProbe(writer, "written after the refusal");
    } finally {
      writer.close();
    }
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
    expect(existsSync(join(fx.root, ".aside"))).toBe(false);
    expect(boot(fx.dbPath)).toBe("written after the refusal");
  }, 15_000);

  it("never starts a healthy swap over an interrupted one", () => {
    const fx = fixture();
    writeFileSync(recoveryPendingPath(fx.dbPath), JSON.stringify({ preservedDirectory: "x" }));
    expect(() => swap(fx, "healthy")).toThrow(/interrupted/);
    expect(existsSync(join(fx.root, ".aside"))).toBe(false);
  });

  it("refuses a staged database whose WAL still holds frames", () => {
    const fx = fixture();
    const staged = join(fx.root, ".staged", "volli.db");
    writeFileSync(`${staged}-wal`, "frames");
    expect(() => swap(fx, "healthy")).toThrow(/unfinished journal/);
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
  });

  it("refuses a staged database below this build's schema, so verification never migrates live", () => {
    const fx = fixture();
    const staged = join(fx.root, ".staged", "volli.db");
    const db = new Database(staged);
    db.pragma("user_version = 57");
    db.close();
    expect(() => swap(fx, "damaged")).toThrow(/not at this build's schema/);
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
    expect(existsSync(join(fx.root, ".aside"))).toBe(false);
    expect(boot(fx.dbPath)).toBe("original");
  });

  it("sets the live database aside only beside it", () => {
    const fx = fixture();
    expect(() =>
      swapInStagedProfile({
        dbPath: fx.dbPath,
        stagedPath: join(fx.root, ".staged", "volli.db"),
        asideDirectory: join(tempDir("elsewhere"), "aside"),
        replacing: "healthy",
      }),
    ).toThrow(/beside it/);
    expect(() =>
      swapInStagedProfile({
        dbPath: fx.dbPath,
        stagedPath: fx.dbPath,
        asideDirectory: join(fx.root, ".aside"),
        replacing: "healthy",
      }),
    ).toThrow(/staged copy/);
  });

  it("never removes a set-aside directory it did not create", () => {
    const fx = fixture();
    mkdirSync(join(fx.root, ".aside"));
    writeFileSync(join(fx.root, ".aside", "keep"), "someone else's");
    expect(() => swap(fx, "healthy")).toThrow(/EEXIST/);
    expect(readFileSync(join(fx.root, ".aside", "keep"), "utf8")).toBe("someone else's");
    expect(boot(fx.dbPath)).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// The migration safety copy
// ---------------------------------------------------------------------------

interface RollbackFixture extends Fixture {
  db: Database.Database;
  backupPath: string;
  /** What the existing rollback family holds, read whole (base plus WAL). */
  previous: string;
}

/**
 * A v55 database ("current") with an older rollback family already at its
 * name. With `walData`, that family's last committed state lives ONLY in its
 * WAL (a supported shape, `migrations.test.ts`): its base alone reads an older
 * value, so a base detached from its WAL is an incomplete database.
 */
function rollbackFixture(walData: boolean): RollbackFixture {
  const root = tempDir("rollback-point");
  const dbPath = join(root, "volli.db");
  const backupPath = `${dbPath}.backup-v55`;
  const db = openRawDb(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db, dbPath, { toVersion: 55 });
  setProbe(db, walData ? "older base only" : "previous");
  db.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath, backupPath);
  if (walData) {
    const writer = new Database(backupPath);
    writer.pragma("wal_autocheckpoint = 0");
    setProbe(writer, "previous, committed in WAL");
    const wal = tempDir("wal-family");
    for (const suffix of ["", "-wal", "-shm"])
      copyFileSync(`${backupPath}${suffix}`, join(wal, `f${suffix}`));
    writer.close();
    for (const suffix of ["", "-wal", "-shm"])
      copyFileSync(join(wal, `f${suffix}`), `${backupPath}${suffix}`);
    expect(readFileSync(`${backupPath}-wal`).length).toBeGreaterThan(32);
  } else {
    writeFileSync(`${backupPath}-wal`, "");
    writeFileSync(`${backupPath}-shm`, Buffer.alloc(32768));
  }
  setProbe(db, "current");
  const previous = walData ? "previous, committed in WAL" : "previous";
  return { root, dbPath, db, backupPath, previous };
}

const ROLLBACK_POINT_STEPS: DatabaseFileStep[] = [
  "rollback-point:copy",
  "rollback-point:preserve-wal",
  "rollback-point:preserve-shm",
  "rollback-point:preserve",
  "rollback-point:preserve-sync",
  "rollback-point:release",
  "rollback-point:release-wal",
  "rollback-point:release-shm",
  "rollback-point:release-sync",
  "rollback-point:publish",
  "rollback-point:sync",
];

/**
 * After a crash at any step: the live database is whole; every database
 * recovery would offer reads, with its sidecars, as either the old rollback
 * point or the current state, never a base cut off from its WAL; the next
 * upgrade succeeds; and the old rollback point's data is still offered.
 */
function assertRollbackPointCrash(copy: Fixture, previous: string): void {
  expect(contents(copy.dbPath)).toBe("current");
  const offered = (): string[] =>
    new DatabaseRecovery({ dbPath: copy.dbPath, userData: copy.root })
      .list()
      .map(({ name }) => contents(join(copy.root, name)));
  for (const value of offered()) expect([previous, "current"]).toContain(value);
  const db = openRawDb(copy.dbPath);
  try {
    expect(migrate(db, copy.dbPath)).toBe(true);
  } finally {
    db.close();
  }
  expect(contents(`${copy.dbPath}.backup-v55`)).toBe("current");
  const after = offered();
  expect(after).toContain(previous);
  for (const value of after) expect([previous, "current"]).toContain(value);
  // Nothing at the rollback name is left without its base.
  const wal = `${copy.dbPath}.backup-v55-wal`;
  expect(existsSync(wal) && statSync(wal).size > 0).toBe(false);
}

describe("publishRollbackPoint", () => {
  it.each([false, true])("names every step it takes, in order (WAL data: %s)", (walData) => {
    const fx = rollbackFixture(walData);
    try {
      expect(stepsOf((faults) => publishRollbackPoint(fx.db, fx.dbPath, 55, { faults }))).toEqual(
        ROLLBACK_POINT_STEPS,
      );
      expect(contents(fx.backupPath)).toBe("current");
      // The old family is whole under one preserved name.
      const preserved = readdirSync(fx.root).find((name) => /\.preserved-[\da-f-]+$/.test(name));
      expect(contents(join(fx.root, preserved as string))).toBe(fx.previous);
    } finally {
      fx.db.close();
    }
  });

  describe.each([false, true])("WAL data in the old family: %s", (walData) => {
    it.each(ROLLBACK_POINT_STEPS.map((step, index) => [step, index] as const))(
      "a crash just before %s keeps every rollback point whole and the next upgrade working",
      (_step, index) => {
        const fx = rollbackFixture(walData);
        let copy: Fixture;
        try {
          copy = crashAt(fx.root, index, (faults) =>
            publishRollbackPoint(fx.db, fx.dbPath, 55, { faults }),
          );
        } finally {
          fx.db.close();
        }
        assertRollbackPointCrash(copy, fx.previous);
      },
      15_000,
    );
  });

  // A real process kill, not a thrown exception: whatever the kernel had
  // when the process died is what the next launch finds.
  it.each(ROLLBACK_POINT_STEPS.map((step, index) => [step, index] as const))(
    "a SIGKILL just before %s, with WAL data in the old family, loses nothing",
    (step, index) => {
      const fx = rollbackFixture(true);
      fx.db.close();
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./database-file-crash-child.test-fixture.mjs", import.meta.url)),
          fx.dbPath,
          "55",
          String(index),
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(child.signal, child.stderr).toBe("SIGKILL");
      expect(child.stdout).toContain(`SIGKILL before ${step}`);
      assertRollbackPointCrash(fx, fx.previous);
    },
    90_000,
  );

  it("removes a pending copy abandoned by a dead attempt, under the open lock, and keeps quarantines", () => {
    const fx = fixture();
    const abandoned = `${fx.dbPath}.backup-v57.pending-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
    copyFileSync(fx.dbPath, abandoned);
    writeFileSync(`${abandoned}-shm`, "");
    writeFileSync(`${abandoned}.corrupt`, "quarantined evidence");
    expect(boot(fx.dbPath)).toBe("original");
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(`${abandoned}-shm`)).toBe(false);
    expect(readFileSync(`${abandoned}.corrupt`, "utf8")).toBe("quarantined evidence");
  });

  // A publication failure leaves a verified pending copy and no published
  // rollback point. If the next boot then finds the live file damaged or
  // gone, that copy may be the only intact database left: it is kept, the
  // refusal names it, and no empty first-run profile is created beside it.
  it.each(["damaged", "missing"] as const)(
    "keeps a pending copy, names it and refuses when the live database is %s",
    (state) => {
      const fx = rollbackFixture(false);
      try {
        expect(() =>
          publishRollbackPoint(fx.db, fx.dbPath, 55, {
            faults: (step) => {
              if (step === "rollback-point:publish") throw new Error("injected publish failure");
            },
          }),
        ).toThrow(/could not preserve and publish/);
      } finally {
        fx.db.close();
      }
      const pendingName = readdirSync(fx.root).find((name) => /\.pending-[\da-f-]+$/.test(name));
      expect(pendingName).toBeDefined();
      const pending = join(fx.root, pendingName as string);
      for (const suffix of ["-wal", "-shm"]) rmSync(`${fx.dbPath}${suffix}`, { force: true });
      if (state === "damaged") {
        const bytes = readFileSync(fx.dbPath);
        bytes.write("BROKEN", 0);
        writeFileSync(fx.dbPath, bytes);
      } else {
        rmSync(fx.dbPath);
      }
      // The open lock is the one name a boot may add: it holds no data.
      const listing = () =>
        readdirSync(fx.root)
          .filter((name) => !name.endsWith(".open-lock"))
          .toSorted();
      const before = listing();
      const pendingBytes = readFileSync(pending);
      const liveBytes = state === "damaged" ? readFileSync(fx.dbPath) : undefined;

      let refusal: Error | undefined;
      try {
        openVolliDb(fx.dbPath).close();
      } catch (error) {
        refusal = error as Error;
      }
      expect(refusal?.message).toMatch(
        state === "damaged" ? /damaged header/ : /missing.*Nothing was created/,
      );
      expect(refusal?.message).toContain(pending);
      // Nothing was removed or created; the copy and the live bytes are untouched.
      expect(listing()).toEqual(before);
      expect(readFileSync(pending).equals(pendingBytes)).toBe(true);
      if (liveBytes !== undefined) expect(readFileSync(fx.dbPath).equals(liveBytes)).toBe(true);
      expect(existsSync(fx.dbPath)).toBe(state === "damaged");
      // A second boot refuses the same way: the evidence survives repeated launches.
      expect(() => openVolliDb(fx.dbPath)).toThrow(pending);

      // The copy is a usable database: put it back, and boot opens it and
      // only then drops the now-redundant pending copy.
      copyFileSync(pending, fx.dbPath);
      const db = openVolliDb(fx.dbPath);
      try {
        expect(readProbe(db)).toBe("current");
      } finally {
        db.close();
      }
      expect(existsSync(pending)).toBe(false);
    },
  );

  // `quick_check` checks B-tree structure, not that an index agrees with its
  // table. A live file whose index lost a row passes it, opens, and silently
  // misses that row on an indexed lookup: the pending copy may be the only
  // intact database, so deleting it needs a full integrity check.
  it.each([55, SCHEMA_HEAD])(
    "keeps a pending copy when the live index disagrees with its table (schema %i)",
    (version) => {
      const root = tempDir("index-corrupt");
      const dbPath = join(root, "volli.db");
      const seed = openRawDb(dbPath);
      try {
        seed.pragma("journal_mode = WAL");
        migrate(seed, dbPath, { toVersion: version });
        setProbe(seed, "retained");
        seed.pragma("wal_checkpoint(TRUNCATE)");
        expect(() =>
          publishRollbackPoint(seed, dbPath, version, {
            faults: (step) => {
              if (step === "rollback-point:publish") throw new Error("injected publish failure");
            },
          }),
        ).toThrow(/could not preserve and publish/);
      } finally {
        seed.close();
      }
      const pending = join(
        root,
        readdirSync(root).find((name) => /\.pending-[\da-f-]+$/.test(name)) as string,
      );
      const pendingBytes = readFileSync(pending);

      // Rewrite the probe's key in the app_state primary-key index leaf to
      // another of the same length and sort position: structure intact,
      // index content wrong.
      const reader = new Database(dbPath, { readonly: true });
      const { rootpage } = reader
        .prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'sqlite_autoindex_app_state_1'")
        .get() as { rootpage: number };
      const pageSize = reader.pragma("page_size", { simple: true }) as number;
      reader.close();
      const bytes = readFileSync(dbPath);
      const page = (rootpage - 1) * pageSize;
      expect(bytes[page]).toBe(10); // an index leaf
      const at = bytes.subarray(page, page + pageSize).indexOf(PROBE);
      expect(at).toBeGreaterThanOrEqual(0);
      bytes.write(`${PROBE.slice(0, -1)}f`, page + at);
      writeFileSync(dbPath, bytes);
      const check = new Database(dbPath, { readonly: true });
      try {
        expect(check.pragma("quick_check", { simple: true })).toBe("ok");
        expect(check.pragma("integrity_check", { simple: true })).not.toBe("ok");
      } finally {
        check.close();
      }

      const hostLog = captureHostLog();
      try {
        // The boot goes on, as it would without the copy: quick_check passes.
        const db = openVolliDb(dbPath);
        db.close();
      } finally {
        hostLog.restore();
      }
      // The copy survives byte-identical, and the warning names it.
      expect(readFileSync(pending).equals(pendingBytes)).toBe(true);
      expect(hostLog.of("backup-retention")).toContainEqual(
        expect.objectContaining({
          level: "warn",
          action: "kept-abandoned",
          names: expect.arrayContaining([pending]) as unknown,
        }),
      );
      expect(hostLog.of("backup-retention")).toContainEqual(
        expect.objectContaining({
          level: "info",
          action: "checked-live",
          check: "integrity_check",
          clean: false,
          durationMs: expect.any(Number) as unknown,
        }),
      );
      const copy = new Database(pending, { readonly: true });
      try {
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(readProbe(copy)).toBe("retained");
      } finally {
        copy.close();
      }
    },
  );

  it("keeps pending copies on a newer-version refusal, which leaves everything as it was", () => {
    const fx = fixture();
    const abandoned = `${fx.dbPath}.backup-v57.pending-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
    copyFileSync(fx.dbPath, abandoned);
    const db = openRawDb(fx.dbPath);
    db.pragma("user_version = 9999");
    raiseMinReaderVersion(db, 9999, 1);
    db.close();
    expect(() => openVolliDb(fx.dbPath)).toThrow(DatabaseFromNewerVersionError);
    expect(existsSync(abandoned)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Durability ordering: what a power cut may lose
// ---------------------------------------------------------------------------

function position(pattern: (entry: string) => boolean, after = -1): number {
  const index = log.findIndex((entry, at) => at > after && pattern(entry));
  expect(index, `missing in ${JSON.stringify(log, null, 1)}`).toBeGreaterThan(after);
  return index;
}

describe("durability ordering", () => {
  it("migrate fsyncs the safety copy before naming it, and its directory before migrating", () => {
    const fx = rollbackFixture(true);
    try {
      log.length = 0;
      expect(migrate(fx.db, fx.dbPath)).toBe(true);
    } finally {
      fx.db.close();
    }
    const contentSync = position(
      (entry) => entry.startsWith(`fsync ${fx.backupPath}.pending-`) && !entry.endsWith("-shm"),
    );
    // The old family gains its preserved names, sidecars before base, and
    // those names are durable before any old name goes.
    const old = (suffix: string) => `${fx.backupPath}${suffix} -> ${fx.backupPath}.preserved-`;
    const linkWal = position((entry) => entry.startsWith(`link ${old("-wal")}`), contentSync);
    const linkBase = position((entry) => entry.startsWith(`link ${old("")}`), linkWal);
    const linksSync = position((entry) => entry === `fsync ${fx.root}`, linkBase);
    // Old names go base first, and that is durable before the new copy is named.
    const releaseBase = position((entry) => entry === `unlink ${fx.backupPath}`, linksSync);
    const releaseWal = position((entry) => entry === `unlink ${fx.backupPath}-wal`, releaseBase);
    const releaseSync = position((entry) => entry === `fsync ${fx.root}`, releaseWal);
    const publish = position(
      (entry) =>
        entry.startsWith(`rename ${fx.backupPath}.pending-`) && entry.endsWith(fx.backupPath),
      releaseSync,
    );
    position((entry) => entry === `fsync ${fx.root}`, publish);
  });

  it("a failed publish puts the old names back durably before dropping the preserved ones", () => {
    const fx = rollbackFixture(true);
    try {
      expect(() =>
        publishRollbackPoint(fx.db, fx.dbPath, 55, {
          faults: (step) => {
            if (step === "rollback-point:publish") throw new Error("injected publish failure");
          },
        }),
      ).toThrow(/could not preserve and publish/);
    } finally {
      fx.db.close();
    }
    const releaseSync = position(
      (entry) => entry === `fsync ${fx.root}`,
      position((entry) => entry === `unlink ${fx.backupPath}-shm`),
    );
    const preserved = (suffix: string) => (entry: string) =>
      new RegExp(`^link ${fx.backupPath}\\.preserved-[\\da-f-]+${suffix} -> `).test(entry) &&
      entry.endsWith(` -> ${fx.backupPath}${suffix}`);
    // Sidecars first, base last, then durable before any preserved name goes.
    const relinkWal = position(preserved("-wal"), releaseSync);
    const relinkBase = position(preserved(""), relinkWal);
    const relinkSync = position((entry) => entry === `fsync ${fx.root}`, relinkBase);
    const drop = (suffix: string) => (entry: string) =>
      new RegExp(`^unlink ${fx.backupPath}\\.preserved-[\\da-f-]+${suffix}$`).test(entry);
    const dropBase = position(drop(""), relinkSync);
    const dropWal = position(drop("-wal"), dropBase);
    position((entry) => entry === `fsync ${fx.root}`, dropWal);
    expect(contents(fx.backupPath)).toBe(fx.previous);
    expect(readdirSync(fx.root).some((name) => name.includes(".preserved-"))).toBe(false);
  });

  it("a swap's marker is durable before anything moves, its content before its name, its name before the marker clears", () => {
    const fx = fixture();
    const staged = join(fx.root, ".staged", "volli.db");
    log.length = 0;
    swap(fx, "healthy");
    const markerSync = position((entry) => entry === `fsync ${recoveryPendingPath(fx.dbPath)}`);
    const firstMove = log.findIndex(
      (entry) => entry.startsWith(`link ${fx.dbPath}`) || entry.startsWith(`rename ${fx.root}/`),
    );
    expect(firstMove).toBeGreaterThan(
      position((entry) => entry === `fsync ${fx.root}`, markerSync),
    );
    const stagedSync = position((entry) => entry === `fsync ${staged}`);
    const publish = position((entry) => entry === `rename ${staged} -> ${fx.dbPath}`, stagedSync);
    const nameSync = position((entry) => entry === `fsync ${fx.root}`, publish);
    position((entry) => entry === `unlink ${recoveryPendingPath(fx.dbPath)}`, nameSync);
    // Companion contents: each staged file before its directories, bottom-up,
    // all before anything in the live profile moves.
    const stagedFiles = [
      ["blobs/bb/blob", "blobs/bb", "blobs"],
      ["session-transcripts/t.json", "session-transcripts"],
    ];
    for (const chain of stagedFiles) {
      let previous = -1;
      for (const path of chain) {
        previous = position(
          (entry) => entry === `fsync ${join(fx.root, ".staged", path)}`,
          previous,
        );
      }
      expect(previous).toBeLessThan(markerSync);
    }
  });
});

/** An actual old schema, not a newer database with its header number changed. */
function rollbackSource(root: string): string {
  const sourcePath = join(root, "volli.db.backup-v59");
  const db = openRawDb(sourcePath);
  try {
    db.pragma("journal_mode = WAL");
    migrate(db, sourcePath, { toVersion: 59 });
    setProbe(db, "rollback point");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return sourcePath;
}

function schemaAt(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.pragma("user_version", { simple: true }) as number;
  } finally {
    db.close();
  }
}

describe("restoreDatabaseFile — exact-schema box rollback", () => {
  it.each(["swap:publish", "swap:verify", "swap:finish"])(
    "a real SIGKILL before %s blocks boot and retry restores the exact rollback point",
    (step) => {
      const fx = fixture();
      const sourcePath = rollbackSource(fx.root);
      const bytes = readFileSync(sourcePath);
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./database-file-crash-child.test-fixture.mjs", import.meta.url)),
          "--restore",
          fx.dbPath,
          sourcePath,
          "59",
          step,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(child.signal, child.stderr).toBe("SIGKILL");
      expect(child.stdout).toContain(`SIGKILL before ${step}`);
      expect(existsSync(fx.dbPath)).toBe(true);
      expect(() => openVolliDb(fx.dbPath)).toThrow(/restore was interrupted/);
      const marker = JSON.parse(readFileSync(recoveryPendingPath(fx.dbPath), "utf8")) as {
        preservedDirectory: string;
      };
      expect(() => openVolliDb(fx.dbPath)).toThrow(
        `volli-hostd database restore --data-dir '${fx.root}' --from '${sourcePath}' --schema 59 --yes`,
      );
      const result = restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion: 59 });
      expect(result.earlierPreservedDirectory).toBe(join(fx.root, marker.preservedDirectory));
      expect(result.preservedDirectory).not.toBe(result.earlierPreservedDirectory);
      expect(contents(join(result.earlierPreservedDirectory!, "volli.db"))).toBe("original");
      expect(contents(join(result.preservedDirectory, "volli.db"))).toBe(
        step === "swap:publish" ? "original" : "rollback point",
      );
      expect(contents(fx.dbPath)).toBe("rollback point");
      expect(schemaAt(fx.dbPath)).toBe(59);
      expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
      expect(readFileSync(sourcePath)).toEqual(bytes);
    },
    90_000,
  );
  it("crashing between set-aside and publication refuses boot, then retry recovers the rollback point, never empty", () => {
    const fx = fixture();
    const sourcePath = rollbackSource(fx.root);
    const before = readFileSync(sourcePath);
    const crash = tempDir("box-rollback-crash");
    let reached = false;
    expect(() =>
      restoreDatabaseFile({
        dbPath: fx.dbPath,
        sourcePath,
        schemaVersion: 59,
        faults: (step) => {
          if (step !== "swap:publish") return;
          // Includes the durable marker and set-aside files. Throwing unwinds
          // the ORIGINAL; this snapshot is the process-killed disk state.
          snapshot(fx.root, crash);
          reached = true;
          throw new SimulatedCrash();
        },
      }),
    ).toThrow(SimulatedCrash);
    expect(reached).toBe(true);
    const crashedDb = join(crash, "volli.db");
    expect(existsSync(crashedDb)).toBe(true);
    expect(contents(crashedDb)).toBe("original");
    expect(() => openVolliDb(crashedDb)).toThrow(/restore was interrupted/);
    const saved = readdirSync(crash).find((name) => name.startsWith("rolled-back-"))!;
    expect(contents(join(crash, saved, "volli.db"))).toBe("original");
    expect(contents(join(crash, saved, "before-checkpoint", "volli.db"))).toBe("original");
    // Retry the command's SAME explicit source, not a new first-run open.
    restoreDatabaseFile({
      dbPath: crashedDb,
      sourcePath: join(crash, "volli.db.backup-v59"),
      schemaVersion: 59,
    });
    expect(contents(crashedDb)).toBe("rollback point");
    expect(schemaAt(crashedDb)).toBe(59);
    expect(existsSync(recoveryPendingPath(crashedDb))).toBe(false);
    expect(readFileSync(join(crash, "volli.db.backup-v59"))).toEqual(before);
    expect(
      readdirSync(crash).some((name) => name.startsWith("volli.db.backup-v59.preserved")),
    ).toBe(false);
    // Multiple durable swaps plus a whole-profile snapshot: CI's covered,
    // concurrent Linux lane needs an I/O budget, not the unit-test default.
  }, 30_000);

  it("fully checks the old schema without migrating and preserves the original WAL family", () => {
    const fx = fixture();
    const sourcePath = rollbackSource(fx.root);
    const source = readFileSync(sourcePath);
    const { preservedDirectory: aside, earlierPreservedDirectory } = restoreDatabaseFile({
      dbPath: fx.dbPath,
      sourcePath,
      schemaVersion: 59,
    });
    expect(earlierPreservedDirectory).toBeUndefined();
    expect(contents(fx.dbPath)).toBe("rollback point");
    expect(schemaAt(fx.dbPath)).toBe(59);
    expect(contents(join(aside, "volli.db"))).toBe("original");
    expect(contents(join(aside, "before-checkpoint", "volli.db"))).toBe("original");
    expect(readFileSync(sourcePath)).toEqual(source);
    expect(companion(fx.root, "blobs")).toEqual(["original blob"]);
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
    // Durability and sidecar sequencing are the SAME swap, not a shell copy.
    const publish = log.findIndex((line) => line.endsWith(` -> ${fx.dbPath}`));
    expect(publish).toBeGreaterThan(0);
    expect(
      log.slice(0, publish).some((line) => line === `fsync ${recoveryPendingPath(fx.dbPath)}`),
    ).toBe(true);
    expect(
      log.slice(0, publish).some((line) => /fsync .*\.database-restore-.*\/volli.db$/.test(line)),
    ).toBe(true);
    expect(log.slice(publish).some((line) => line === `fsync ${fx.root}`)).toBe(true);
  }, 30_000);

  it("refuses bad schemas, same-file sources and unfinished or linked source sidecars before displacement", () => {
    const fx = fixture();
    const sourcePath = rollbackSource(fx.root);
    for (const schemaVersion of [0, -1, 1.5, SCHEMA_HEAD + 1, Number.NaN])
      expect(() => restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion })).toThrow(
        /schema between/,
      );
    expect(() => restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion: 58 })).toThrow(
      /not at schema 58/,
    );
    const linked = join(fx.root, "linked-source");
    linkSync(fx.dbPath, linked);
    expect(() =>
      restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath: linked, schemaVersion: SCHEMA_HEAD }),
    ).toThrow(/separate source/);
    writeFileSync(`${sourcePath}-wal`, "uncheckpointed frames");
    expect(() => restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion: 59 })).toThrow(
      /unfinished journal/,
    );
    rmSync(`${sourcePath}-wal`);
    mkdirSync(`${sourcePath}-shm`);
    expect(() => restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion: 59 })).toThrow(
      /regular local files/,
    );
    expect(contents(fx.dbPath)).toBe("original");
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
  });

  it("refuses a copy whose CHECK constraints fail, even when a read-only check says ok", () => {
    const fx = fixture();
    const sourcePath = rollbackSource(fx.root);
    const db = new Database(sourcePath);
    db.exec(
      "CREATE TABLE bad (n INTEGER CHECK(n > 0)); PRAGMA ignore_check_constraints = ON; INSERT INTO bad VALUES (-1)",
    );
    db.close();
    expect(() => restoreDatabaseFile({ dbPath: fx.dbPath, sourcePath, schemaVersion: 59 })).toThrow(
      /integrity check/,
    );
    expect(contents(fx.dbPath)).toBe("original");
    expect(existsSync(recoveryPendingPath(fx.dbPath))).toBe(false);
  });
});
