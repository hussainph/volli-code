import { basename } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  BACKUP_RETENTION_LOG_PREFIX,
  logMigrationBackupRetention,
  migrationBackupCandidatePattern,
  pruneMigrationBackups,
  type BackupRetentionFs,
} from "./backup-retention";

interface FakeEntry {
  sizeBytes: number;
  kind?: "file" | "directory";
  statError?: Error;
  removeError?: Error;
}

function fakeFilesystem(initial: Record<string, FakeEntry>) {
  const entries = new Map(Object.entries(initial));
  const removeAttempts: string[] = [];
  const deps: BackupRetentionFs = {
    readDirectory: () => [...entries.keys()],
    readFileInfo: (path) => {
      const name = basename(path);
      const entry = entries.get(name);
      if (entry === undefined) throw new Error(`ENOENT: ${name}`);
      if (entry.statError !== undefined) throw entry.statError;
      return { sizeBytes: entry.sizeBytes, isFile: entry.kind !== "directory" };
    },
    removeFile: (path) => {
      const name = basename(path);
      removeAttempts.push(name);
      const entry = entries.get(name);
      if (entry === undefined) throw new Error(`ENOENT: ${name}`);
      if (entry.removeError !== undefined) throw entry.removeError;
      entries.delete(name);
    },
  };
  return {
    deps,
    names: () => [...entries.keys()].toSorted(),
    removeAttempts,
  };
}

describe("migration backup candidate matching", () => {
  it("escapes the database basename and requires a numeric version plus an exact sidecar suffix", () => {
    const pattern = migrationBackupCandidatePattern("/profile/volli.db");

    expect(
      ["volli.db.backup-v12", "volli.db.backup-v12-wal", "volli.db.backup-v12-shm"].map((name) =>
        pattern.test(name),
      ),
    ).toEqual([true, true, true]);
    for (const name of [
      "volli.db",
      "volli.db-wal",
      "volli.db-shm",
      "volliXdb.backup-v3",
      "volli.db.backup-v",
      "volli.db.backup-v3.tmp",
      "volli.db.backup-v3-wal-extra",
    ]) {
      expect(pattern.test(name), name).toBe(false);
    }
  });

  it("uses a custom database basename", () => {
    const pattern = migrationBackupCandidatePattern("/profile/custom.sqlite");

    expect(pattern.test("custom.sqlite.backup-v9")).toBe(true);
    expect(pattern.test("volli.db.backup-v9")).toBe(false);
  });
});

describe("pruneMigrationBackups", () => {
  it("removes nothing when this run's safety copy is absent", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v1": { sizeBytes: 10 },
      "volli.db.backup-v9": { sizeBytes: 90 },
    });

    const report = pruneMigrationBackups("/profile/volli.db", 2, fs.deps);

    expect(fs.removeAttempts).toEqual([]);
    expect(fs.names()).toEqual(["volli.db.backup-v1", "volli.db.backup-v9"]);
    expect(report).toEqual({
      kept: [
        { name: "volli.db.backup-v1", sizeBytes: 10 },
        { name: "volli.db.backup-v9", sizeBytes: 90 },
      ],
      removed: [],
      failed: [
        {
          operation: "verify",
          name: "volli.db.backup-v2",
          sizeBytes: "unknown",
          error: "this run's safety copy is missing",
        },
      ],
    });
  });

  it("removes nothing when this run's safety-copy path is a directory", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v1": { sizeBytes: 10 },
      "volli.db.backup-v2": { sizeBytes: 64, kind: "directory" },
      "volli.db.backup-v9": { sizeBytes: 90 },
    });

    const report = pruneMigrationBackups("/profile/volli.db", 2, fs.deps);

    expect(fs.removeAttempts).toEqual([]);
    expect(fs.names()).toEqual(["volli.db.backup-v1", "volli.db.backup-v2", "volli.db.backup-v9"]);
    expect(report.failed).toEqual([
      {
        operation: "verify",
        name: "volli.db.backup-v2",
        sizeBytes: 64,
        error: "this run's safety copy is not a regular file",
      },
    ]);
  });

  it("returns the exact kept and removed files while retaining sidecars by numeric version", () => {
    const fs = fakeFilesystem({
      "volli.db": { sizeBytes: 2_000 },
      "volli.db-wal": { sizeBytes: 200 },
      "volli.db.backup-v2": { sizeBytes: 20 },
      "volli.db.backup-v2-wal": { sizeBytes: 21 },
      "volli.db.backup-v3": { sizeBytes: 30 },
      "volli.db.backup-v3-shm": { sizeBytes: 31 },
      "volli.db.backup-v10": { sizeBytes: 100 },
      "volli.db.backup-v10-wal": { sizeBytes: 101 },
      "volli.db.backup-v11-shm": { sizeBytes: 111 },
      "volliXdb.backup-v3": { sizeBytes: 300 },
      "volli.db.backup-v": { sizeBytes: 301 },
    });

    const report = pruneMigrationBackups("/profile/volli.db", 2, fs.deps);

    expect(report).toEqual({
      kept: [
        { name: "volli.db.backup-v10", sizeBytes: 100 },
        { name: "volli.db.backup-v10-wal", sizeBytes: 101 },
        { name: "volli.db.backup-v2", sizeBytes: 20 },
        { name: "volli.db.backup-v2-wal", sizeBytes: 21 },
      ],
      removed: [
        { name: "volli.db.backup-v11-shm", sizeBytes: 111 },
        { name: "volli.db.backup-v3", sizeBytes: 30 },
        { name: "volli.db.backup-v3-shm", sizeBytes: 31 },
      ],
      failed: [],
    });
    expect(fs.names()).toEqual([
      "volli.db",
      "volli.db-wal",
      "volli.db.backup-v",
      "volli.db.backup-v10",
      "volli.db.backup-v10-wal",
      "volli.db.backup-v2",
      "volli.db.backup-v2-wal",
      "volliXdb.backup-v3",
    ]);
  });

  it("reports an unreadable removal failure, continues, and logs from the report structure", () => {
    const removalError = new Error("permission denied");
    const fs = fakeFilesystem({
      "volli.db.backup-v1": {
        sizeBytes: 10,
        statError: new Error("stat denied"),
        removeError: removalError,
      },
      "volli.db.backup-v1-wal": { sizeBytes: 11 },
      "volli.db.backup-v2": { sizeBytes: 20 },
      "volli.db.backup-v10": { sizeBytes: 100 },
    });

    const report = pruneMigrationBackups("/profile/volli.db", 2, fs.deps);

    expect(report).toEqual({
      kept: [
        { name: "volli.db.backup-v10", sizeBytes: 100 },
        { name: "volli.db.backup-v2", sizeBytes: 20 },
      ],
      removed: [{ name: "volli.db.backup-v1-wal", sizeBytes: 11 }],
      failed: [
        {
          operation: "remove",
          name: "volli.db.backup-v1",
          sizeBytes: "unknown",
          error: "Error: permission denied",
        },
      ],
    });
    expect(fs.removeAttempts).toEqual(["volli.db.backup-v1", "volli.db.backup-v1-wal"]);

    const logger = { info: vi.fn(), error: vi.fn() };
    logMigrationBackupRetention(report, logger);

    expect(logger.info).toHaveBeenCalledWith(BACKUP_RETENTION_LOG_PREFIX, {
      action: "removed",
      name: "volli.db.backup-v1-wal",
      sizeBytes: 11,
    });
    expect(logger.error).toHaveBeenCalledWith(BACKUP_RETENTION_LOG_PREFIX, {
      action: "failed",
      operation: "remove",
      name: "volli.db.backup-v1",
      sizeBytes: "unknown",
      error: "Error: permission denied",
    });
  });
});
