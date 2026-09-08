import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MIGRATION_COMPACTION_LOG_PREFIX,
  compactMigrationDatabase,
  decideMigrationCompaction,
  logMigrationCompaction,
  type MigrationCompactionDatabase,
  type MigrationCompactionFileStat,
} from "./migration-compaction";
import { openRawDb } from "./test-helpers";

const MIB = 1024 * 1024;
const PAGE_SIZE = 4096;

let tempDirectory: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDirectory !== undefined) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

function fakeDb(overrides: Partial<MigrationCompactionDatabase> = {}): MigrationCompactionDatabase {
  return {
    exec: vi.fn(),
    pragma: vi.fn((source: string) => {
      if (source === "page_size") return PAGE_SIZE;
      if (source === "page_count") return 10_000;
      if (source === "freelist_count") return 0;
      if (source === "wal_checkpoint(TRUNCATE)") {
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      }
      throw new Error(`unexpected PRAGMA: ${source}`);
    }),
    ...overrides,
  };
}

function stagedFileSizes(...sizes: number[]): MigrationCompactionFileStat & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fileSize(path) {
      calls.push(path);
      const size = sizes.shift();
      if (size === undefined) throw new Error("unexpected stat");
      return size;
    },
  };
}

describe("decideMigrationCompaction", () => {
  it("uses the 32 MiB floor and treats exact equality as qualifying", () => {
    const atThreshold = decideMigrationCompaction(PAGE_SIZE, 10_000, (32 * MIB) / PAGE_SIZE);
    const onePageBelow = decideMigrationCompaction(
      PAGE_SIZE,
      10_000,
      32 * (MIB / PAGE_SIZE) - 1,
    );

    expect(atThreshold).toEqual({
      shouldCompact: true,
      freeBytes: 32 * MIB,
      thresholdBytes: 32 * MIB,
    });
    expect(onePageBelow).toEqual({
      shouldCompact: false,
      freeBytes: 32 * MIB - PAGE_SIZE,
      thresholdBytes: 32 * MIB,
    });
  });

  it("uses twenty percent of the whole database when that exceeds the floor", () => {
    const decision = decideMigrationCompaction(PAGE_SIZE, 50_000, 10_000);

    expect(decision).toEqual({
      shouldCompact: true,
      freeBytes: 40_960_000,
      thresholdBytes: 40_960_000,
    });
  });
});

describe("compactMigrationDatabase", () => {
  it("reports threshold numbers and issues no VACUUM when free space is below the floor", () => {
    const db = fakeDb({
      pragma: vi.fn((source: string) => {
        if (source === "page_size") return PAGE_SIZE;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return (32 * MIB) / PAGE_SIZE - 1;
        throw new Error(`unexpected PRAGMA: ${source}`);
      }),
    });
    const fileStat = stagedFileSizes(45 * MIB);

    const report = compactMigrationDatabase(db, "/profile/volli.db", fileStat);

    expect(db.exec).not.toHaveBeenCalled();
    expect(report).toEqual({
      ran: false,
      beforeBytes: 45 * MIB,
      afterBytes: "unknown",
      freelistBefore: (32 * MIB) / PAGE_SIZE - 1,
      reason: `below threshold: freeBytes=${32 * MIB - PAGE_SIZE} thresholdBytes=${32 * MIB}`,
    });
  });

  it("runs only VACUUM, checkpoints it, and measures afterBytes only after checkpoint success", () => {
    const operations: string[] = [];
    const db = fakeDb({
      exec: vi.fn((source: string) => operations.push(`exec:${source}`)),
      pragma: vi.fn((source: string) => {
        operations.push(`pragma:${source}`);
        if (source === "page_size") return PAGE_SIZE;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return (32 * MIB) / PAGE_SIZE;
        if (source === "wal_checkpoint(TRUNCATE)") {
          return [{ busy: 0, log: 7, checkpointed: 7 }];
        }
        throw new Error(`unexpected PRAGMA: ${source}`);
      }),
    });
    const fileStat: MigrationCompactionFileStat = {
      fileSize: vi.fn(() => {
        operations.push("stat");
        return operations.filter((operation) => operation === "stat").length === 1
          ? 45 * MIB
          : 12 * MIB;
      }),
    };

    const report = compactMigrationDatabase(db, "/profile/volli.db", fileStat);

    expect(operations).toEqual([
      "stat",
      "pragma:page_size",
      "pragma:page_count",
      "pragma:freelist_count",
      "exec:VACUUM",
      "pragma:wal_checkpoint(TRUNCATE)",
      "stat",
    ]);
    expect(report).toEqual({
      ran: true,
      beforeBytes: 45 * MIB,
      afterBytes: 12 * MIB,
      freelistBefore: (32 * MIB) / PAGE_SIZE,
      reason: `compacted: freeBytes=${32 * MIB} thresholdBytes=${32 * MIB}`,
    });
  });

  it("catches a VACUUM error with its SQLite code and never checkpoints or measures afterBytes", () => {
    const sqliteFull = Object.assign(new Error("database or disk is full"), {
      code: "SQLITE_FULL",
    });
    const db = fakeDb({
      exec: vi.fn(() => {
        throw sqliteFull;
      }),
      pragma: vi.fn((source: string) => {
        if (source === "page_size") return PAGE_SIZE;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return (32 * MIB) / PAGE_SIZE;
        throw new Error(`unexpected PRAGMA after VACUUM failure: ${source}`);
      }),
    });
    const fileStat = stagedFileSizes(45 * MIB);

    const report = compactMigrationDatabase(db, "/profile/volli.db", fileStat);

    expect(report).toEqual({
      ran: false,
      beforeBytes: 45 * MIB,
      afterBytes: "unknown",
      freelistBefore: (32 * MIB) / PAGE_SIZE,
      reason: "VACUUM failed: SQLITE_FULL: database or disk is full",
    });
    expect(fileStat.calls).toEqual(["/profile/volli.db"]);
    expect(db.pragma).not.toHaveBeenCalledWith("wal_checkpoint(TRUNCATE)");
  });

  it("keeps ran true but withholds afterBytes when the checkpoint reports busy", () => {
    const db = fakeDb({
      pragma: vi.fn((source: string) => {
        if (source === "page_size") return PAGE_SIZE;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return (32 * MIB) / PAGE_SIZE;
        if (source === "wal_checkpoint(TRUNCATE)") {
          return [{ busy: 1, log: 9, checkpointed: 4 }];
        }
        throw new Error(`unexpected PRAGMA: ${source}`);
      }),
    });
    const fileStat = stagedFileSizes(45 * MIB);

    const report = compactMigrationDatabase(db, "/profile/volli.db", fileStat);

    expect(db.exec).toHaveBeenCalledExactlyOnceWith("VACUUM");
    expect(report).toEqual({
      ran: true,
      beforeBytes: 45 * MIB,
      afterBytes: "unknown",
      freelistBefore: (32 * MIB) / PAGE_SIZE,
      reason: "checkpoint failed: busy=1 log=9 checkpointed=4",
    });
    expect(fileStat.calls).toEqual(["/profile/volli.db"]);
  });

  it("reports unreadable PRAGMAs without issuing VACUUM or throwing", () => {
    const sqliteBusy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const db = fakeDb({
      pragma: vi.fn((source: string) => {
        if (source === "page_size") throw sqliteBusy;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return 123;
        throw new Error(`unexpected PRAGMA: ${source}`);
      }),
    });

    const report = compactMigrationDatabase(db, "/profile/volli.db", stagedFileSizes(45 * MIB));

    expect(db.exec).not.toHaveBeenCalled();
    expect(db.pragma).toHaveBeenCalledWith("page_count", { simple: true });
    expect(db.pragma).toHaveBeenCalledWith("freelist_count", { simple: true });
    expect(report).toEqual({
      ran: false,
      beforeBytes: 45 * MIB,
      afterBytes: "unknown",
      freelistBefore: 123,
      reason: "PRAGMA read failed: page_size=SQLITE_BUSY: database is locked",
    });
  });

  it("uses unknown for stat failures without preventing a qualifying compaction", () => {
    const db = fakeDb({
      pragma: vi.fn((source: string) => {
        if (source === "page_size") return PAGE_SIZE;
        if (source === "page_count") return 10_000;
        if (source === "freelist_count") return (32 * MIB) / PAGE_SIZE;
        if (source === "wal_checkpoint(TRUNCATE)") {
          return [{ busy: 0, log: 0, checkpointed: 0 }];
        }
        throw new Error(`unexpected PRAGMA: ${source}`);
      }),
    });
    const fileStat: MigrationCompactionFileStat = {
      fileSize: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("stat denied");
        })
        .mockReturnValueOnce(12 * MIB),
    };

    const report = compactMigrationDatabase(db, "/profile/volli.db", fileStat);

    expect(db.exec).toHaveBeenCalledExactlyOnceWith("VACUUM");
    expect(report).toEqual({
      ran: true,
      beforeBytes: "unknown",
      afterBytes: 12 * MIB,
      freelistBefore: (32 * MIB) / PAGE_SIZE,
      reason: `compacted: freeBytes=${32 * MIB} thresholdBytes=${32 * MIB}; before-size stat failed: Error: stat denied`,
    });
  });
});

describe("migration compaction logging", () => {
  it("uses one stable prefix and error severity for a failed checkpoint report", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const report = {
      ran: true,
      beforeBytes: 45 * MIB,
      afterBytes: "unknown" as const,
      freelistBefore: (32 * MIB) / PAGE_SIZE,
      reason: "checkpoint failed: busy=1 log=9 checkpointed=4",
    };

    logMigrationCompaction(report, logger);

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(MIGRATION_COMPACTION_LOG_PREFIX, report);
  });
});

describe("migration compaction on a real WAL fixture", () => {
  it("reclaims a qualifying freelist, shrinks the main file, and preserves logical rows", () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "volli-compaction-test-"));
    const dbPath = join(tempDirectory, "volli.db");
    const db = openRawDb(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE preserved_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO preserved_rows (value) VALUES ('alpha'), ('beta');
      CREATE TABLE deleted_payload (payload BLOB NOT NULL);
      INSERT INTO deleted_payload (payload) VALUES (zeroblob(${40 * MIB}));
      DELETE FROM deleted_payload;
    `);
    db.pragma("wal_checkpoint(TRUNCATE)");

    const digestBefore = JSON.stringify(
      db.prepare("SELECT * FROM preserved_rows ORDER BY id").all(),
    );
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const pageCount = db.pragma("page_count", { simple: true }) as number;
    const freelistBefore = db.pragma("freelist_count", { simple: true }) as number;
    const beforeBytes = statSync(dbPath).size;
    const decision = decideMigrationCompaction(pageSize, pageCount, freelistBefore);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(decision.shouldCompact).toBe(true);

    const report = compactMigrationDatabase(db, dbPath);

    const afterBytes = statSync(dbPath).size;
    const digestAfter = JSON.stringify(db.prepare("SELECT * FROM preserved_rows ORDER BY id").all());
    expect(report).toEqual({
      ran: true,
      beforeBytes,
      afterBytes,
      freelistBefore,
      reason: `compacted: freeBytes=${decision.freeBytes} thresholdBytes=${decision.thresholdBytes}`,
    });
    expect(db.pragma("freelist_count", { simple: true })).toBe(0);
    expect(afterBytes).toBeLessThan(beforeBytes);
    expect(digestAfter).toBe(digestBefore);
    db.close();
  });
});
