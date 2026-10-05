/**
 * The free-space preflight before a migration's safety copy (VC-633).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-disk-preflight-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
