/**
 * The free-space preflight before a migration's safety copy (VC-633).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { LogRecord } from "@volli/shared";
import { captureHostLog, type CapturedHostLog } from "../testing/log";
import { openVolliDb } from "./database-file";
import {
  assertMigrationDiskSpace,
  formatBytes,
  InsufficientDiskSpaceError,
  MIGRATION_DISK_HEADROOM_BYTES,
  migrationDiskRequirement,
  nodeDiskProbe,
  type DiskProbe,
} from "./disk-preflight";
import { migrate, SCHEMA_HEAD } from "./migrations";

const MIB = 1024 * 1024;

let dir: string;
let log: CapturedHostLog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-disk-preflight-"));
  log = captureHostLog();
});
afterEach(() => {
  log.restore();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** The error Node's `statfsSync` throws when the filesystem or kernel cannot answer. */
function statfsError(code: "ENOSYS" | "EIO", path: string): NodeJS.ErrnoException {
  const message = code === "ENOSYS" ? "function not implemented" : "i/o error";
  return Object.assign(new Error(`${code}: ${message}, statfs '${path}'`), {
    code,
    syscall: "statfs",
    path,
  });
}

/** Every warning the preflight logged. */
function preflightWarnings(): LogRecord[] {
  return log.of("disk-preflight").filter((record) => record.level === "warn");
}

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/** A database one migration behind this build, closed and checkpointed. */
function behindHead(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    migrate(db, dbPath, { toVersion: SCHEMA_HEAD - 1 });
  } finally {
    db.close();
  }
}

function probe(sizes: Record<string, number>, free: number): DiskProbe {
  return {
    fileSize: (path) => sizes[path] ?? 0,
    freeBytes: () => free,
  };
}

describe("formatBytes", () => {
  it("reads as a person reads a disk", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(950 * MIB)).toBe("950.0 MB");
    expect(formatBytes(2.8 * 1024 * MIB)).toBe("2.8 GB");
    expect(formatBytes(3 * 1024 ** 5)).toBe("3072.0 TB");
  });
});

describe("assertMigrationDiskSpace", () => {
  it("needs two copies of the database, its WAL included, plus headroom", () => {
    expect(migrationDiskRequirement(950 * MIB)).toBe(1900 * MIB + MIGRATION_DISK_HEADROOM_BYTES);
    const dbPath = join(dir, "volli.db");
    const sizes = { [dbPath]: 900 * MIB, [`${dbPath}-wal`]: 50 * MIB };
    const needed = migrationDiskRequirement(950 * MIB);
    expect(() => assertMigrationDiskSpace(dbPath, probe(sizes, needed))).not.toThrow();

    let caught: unknown;
    try {
      assertMigrationDiskSpace(dbPath, probe(sizes, needed - 1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientDiskSpaceError);
    const refusal = caught as InsufficientDiskSpaceError;
    expect(refusal).toMatchObject({
      name: "InsufficientDiskSpaceError",
      directory: dir,
      databaseBytes: 950 * MIB,
      requiredBytes: needed,
      freeBytes: needed - 1,
    });
    expect(refusal.message).toBe(
      `Migration refused: not enough free disk space to upgrade the database safely. ` +
        `Upgrading needs about 1.9 GB free in ${dir} (a safety copy of the 950.0 MB database, then room to rewrite it), ` +
        `and 1.9 GB is free. Nothing was changed. Free up at least 1 byte on that disk, then open Volli again.`,
    );
  });

  it("reads real sizes and the volume's free space", () => {
    const dbPath = join(dir, "volli.db");
    writeFileSync(dbPath, Buffer.alloc(4096));
    expect(nodeDiskProbe.fileSize(dbPath)).toBe(4096);
    expect(nodeDiskProbe.fileSize(`${dbPath}-wal`)).toBe(0);
    expect(() => nodeDiskProbe.fileSize(join(dbPath, "not-a-directory"))).toThrow(/ENOTDIR/);
    expect(nodeDiskProbe.freeBytes(dir)).toBeGreaterThan(0);
    expect(() => assertMigrationDiskSpace(dbPath)).not.toThrow();
  });
});

describe("a free-space measurement that fails", () => {
  it.each(["ENOSYS", "EIO"] as const)(
    "fails open on %s from statfs: one warning naming the error, no refusal",
    (code) => {
      const dbPath = join(dir, "volli.db");
      const failing: DiskProbe = {
        fileSize: () => 900 * MIB,
        freeBytes: (directory) => {
          throw statfsError(code, directory);
        },
      };
      expect(() => assertMigrationDiskSpace(dbPath, failing)).not.toThrow();
      expect(preflightWarnings()).toEqual([
        expect.objectContaining({
          msg: "could not measure free disk space; migrating unchecked",
          directory: dir,
          error: expect.objectContaining({
            name: "Error",
            message: `${code}: ${code === "ENOSYS" ? "function not implemented" : "i/o error"}, statfs '${dir}'`,
            code,
          }),
        }),
      ]);
    },
  );

  it("fails open when the database's size cannot be read either", () => {
    const freeBytes = vi.fn(() => 0);
    const failing: DiskProbe = {
      fileSize: (path) => {
        throw statfsError("EIO", path);
      },
      freeBytes,
    };
    expect(() => assertMigrationDiskSpace(join(dir, "volli.db"), failing)).not.toThrow();
    expect(preflightWarnings()).toHaveLength(1);
    expect(JSON.stringify(preflightWarnings()[0])).toContain("EIO: i/o error");
    // A zero it never got to read is not a refusal either.
    expect(freeBytes).not.toHaveBeenCalled();
  });

  it.each(["ENOSYS", "EIO"] as const)(
    "lets openVolliDb upgrade when statfs throws %s, logging one warning",
    (code) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const dbPath = join(dir, "volli.db");
      behindHead(dbPath);
      const statfs = vi.spyOn(nodeDiskProbe, "freeBytes").mockImplementation((directory) => {
        throw statfsError(code, directory);
      });
      const db = openVolliDb(dbPath);
      try {
        expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
      } finally {
        db.close();
      }
      // Measured once, before the writable open; the runner does not ask again.
      expect(statfs).toHaveBeenCalledTimes(1);
      const warnings = preflightWarnings();
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings[0])).toContain(`${code}: `);
      // The upgrade went ahead as it always had: with its safety copy.
      expect(existsSync(`${dbPath}.backup-v${SCHEMA_HEAD - 1}`)).toBe(true);
    },
  );
});

describe("openVolliDb's preflight", () => {
  it("refuses before any writable handle, leaving the db and its WAL byte-identical", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const source = join(dir, "source.db");
    behindHead(source);
    // A crash image: data committed only to the WAL, never checkpointed, so a
    // writable open and close would fold it into the db and remove the WAL.
    const dbPath = join(dir, "volli.db");
    const writer = new Database(source);
    try {
      writer.pragma("journal_mode = WAL");
      writer.pragma("wal_autocheckpoint = 0");
      writer
        .prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
        .run("disk-preflight:wal-probe", "1", 1);
      copyFileSync(source, dbPath);
      copyFileSync(`${source}-wal`, `${dbPath}-wal`);
    } finally {
      writer.close();
    }
    rmSync(source);
    expect(readFileSync(`${dbPath}-wal`).length).toBeGreaterThan(0);

    const before = [sha256(dbPath), sha256(`${dbPath}-wal`)];
    vi.spyOn(nodeDiskProbe, "freeBytes").mockReturnValue(0);
    expect(() => openVolliDb(dbPath)).toThrow(InsufficientDiskSpaceError);
    expect([sha256(dbPath), sha256(`${dbPath}-wal`)]).toEqual(before);
    expect(readdirSync(dir).filter((name) => name.includes(".backup-"))).toEqual([]);

    // And the refused file is the one a roomier disk then upgrades, WAL data included.
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const db = openVolliDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
      expect(
        db.prepare("SELECT value FROM app_state WHERE key = ?").get("disk-preflight:wal-probe"),
      ).toEqual({ value: "1" });
    } finally {
      db.close();
    }
  });

  it("does not measure a database already at head, which takes no safety copy", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dbPath = join(dir, "volli.db");
    openVolliDb(dbPath).close();
    const statfs = vi.spyOn(nodeDiskProbe, "freeBytes").mockReturnValue(0);
    openVolliDb(dbPath).close();
    expect(statfs).not.toHaveBeenCalled();
  });
});

describe("the migration runner's preflight", () => {
  it("refuses an existing database before its safety copy, changing nothing", () => {
    const dbPath = join(dir, "volli.db");
    const db = new Database(dbPath);
    try {
      migrate(db, dbPath, { toVersion: SCHEMA_HEAD - 1 });
      const before = readdirSync(dir).toSorted();
      expect(() => migrate(db, dbPath, { disk: probe({}, 0) })).toThrow(InsufficientDiskSpaceError);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD - 1);
      expect(readdirSync(dir).toSorted()).toEqual(before);
      expect(existsSync(`${dbPath}.backup-v${SCHEMA_HEAD - 1}`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("leaves the measurement to a caller that already took it", () => {
    const dbPath = join(dir, "volli.db");
    const db = new Database(dbPath);
    try {
      migrate(db, dbPath, { toVersion: SCHEMA_HEAD - 1 });
      expect(migrate(db, dbPath, { disk: probe({}, 0), diskChecked: true })).toBe(true);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    } finally {
      db.close();
    }
  });

  it("does not ask a fresh database, which takes no safety copy", () => {
    const dbPath = join(dir, "volli.db");
    const db = new Database(dbPath);
    try {
      expect(migrate(db, dbPath, { disk: probe({}, 0) })).toBe(true);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    } finally {
      db.close();
    }
  });
});
