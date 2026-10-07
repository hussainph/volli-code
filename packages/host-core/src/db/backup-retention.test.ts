import { basename } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
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
  integrityError?: Error;
  quarantineError?: Error;
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
    verifyIntegrity: (path) => {
      const entry = entries.get(basename(path));
      if (entry?.integrityError) throw entry.integrityError;
    },
    quarantineFile: (path, destination) => {
      const name = basename(path);
      const entry = entries.get(name);
      if (!entry) throw new Error(`ENOENT: ${name}`);
      if (entry.quarantineError) throw entry.quarantineError;
      entries.set(basename(destination), entry);
      entries.delete(name);
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
      quarantined: [],
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
      expect.objectContaining({
        operation: "verify",
        name: "volli.db.backup-v2",
        error: "Error: safety copy is not a regular file",
      }),
      expect.objectContaining({ operation: "quarantine", name: "volli.db.backup-v2" }),
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
      quarantined: [],
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

  it("reports a removal failure, continues, and logs from the report structure", () => {
    const removalError = new Error("permission denied");
    const fs = fakeFilesystem({
      "volli.db.backup-v1": {
        sizeBytes: 10,
        removeError: removalError,
      },
      "volli.db.backup-v1-wal": { sizeBytes: 11 },
      "volli.db.backup-v2": { sizeBytes: 20 },
      "volli.db.backup-v10": { sizeBytes: 100 },
    });

    const report = pruneMigrationBackups("/profile/volli.db", 10, fs.deps);

    expect(report).toEqual({
      kept: [
        { name: "volli.db.backup-v10", sizeBytes: 100 },
        { name: "volli.db.backup-v2", sizeBytes: 20 },
      ],
      quarantined: [],
      removed: [{ name: "volli.db.backup-v1-wal", sizeBytes: 11 }],
      failed: [
        {
          operation: "remove",
          name: "volli.db.backup-v1",
          sizeBytes: 10,
          error: "Error: permission denied",
        },
      ],
    });
    expect(fs.removeAttempts).toEqual(["volli.db.backup-v1", "volli.db.backup-v1-wal"]);

    const logger = { info: vi.fn(), error: vi.fn() };
    logMigrationBackupRetention(report, logger);

    expect(logger.info).toHaveBeenCalledWith("migration backup removed", {
      action: "removed",
      name: "volli.db.backup-v1-wal",
      sizeBytes: 11,
    });
    expect(logger.error).toHaveBeenCalledWith("migration backup retention failed", {
      action: "failed",
      operation: "remove",
      name: "volli.db.backup-v1",
      sizeBytes: 10,
      error: "Error: permission denied",
    });
  });
  it("never prunes a clean older copy when the new copy is corrupt", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v51": { sizeBytes: 51 },
      "volli.db.backup-v54": { sizeBytes: 54 },
      "volli.db.backup-v55": { sizeBytes: 55, integrityError: new Error("malformed") },
      "volli.db.backup-v55-wal": { sizeBytes: 5 },
    });
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(fs.removeAttempts).toEqual([]);
    expect(report.kept.map((entry) => entry.name)).toEqual([
      "volli.db.backup-v51",
      "volli.db.backup-v54",
    ]);
    expect(report.quarantined.map((entry) => entry.name)).toEqual([
      expect.stringMatching(/^volli\.db\.backup-v55\.corrupt-/),
      expect.stringMatching(/^volli\.db\.backup-v55\.corrupt-.*-wal$/),
    ]);
    expect(fs.names()).not.toContain("volli.db.backup-v55");
    const logger = { info: vi.fn(), error: vi.fn() };
    logMigrationBackupRetention(report, logger);
    expect(logger.error).toHaveBeenCalledWith(
      "migration backup quarantined",
      expect.objectContaining({ action: "quarantined" }),
    );
  });

  it("keeps backup-v51 when newer historical copies are corrupt, even with a clean new copy", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v50": { sizeBytes: 50 },
      "volli.db.backup-v51": { sizeBytes: 51 },
      "volli.db.backup-v54": { sizeBytes: 54, integrityError: new Error("malformed") },
      "volli.db.backup-v54-shm": { sizeBytes: 4 },
      "volli.db.backup-v55": { sizeBytes: 55 },
      "volli.db.backup-v53.corrupt-existing": { sizeBytes: 53 },
    });
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(report.kept.map((entry) => entry.name)).toEqual([
      "volli.db.backup-v51",
      "volli.db.backup-v55",
    ]);
    expect(fs.removeAttempts).toEqual(["volli.db.backup-v50"]);
    expect(fs.names()).toContain("volli.db.backup-v53.corrupt-existing");
    expect(report.quarantined).toHaveLength(2);
  });

  it("keeps unverifiable copies and their sidecars if quarantine fails", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v51": {
        sizeBytes: 51,
        integrityError: new Error("malformed"),
        quarantineError: new Error("denied"),
      },
      "volli.db.backup-v51-wal": { sizeBytes: 5, quarantineError: new Error("denied") },
      "volli.db.backup-v55": { sizeBytes: 55 },
    });
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(fs.removeAttempts).toEqual([]);
    expect(report.kept.map((entry) => entry.name)).toEqual(["volli.db.backup-v55"]);
    expect(report.failed.map((entry) => entry.operation)).toEqual(["verify", "quarantine"]);
  });
  it("leaves the base outside the rollback allowlist if restoring a sidecar fails", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v51": {
        sizeBytes: 51,
        integrityError: new Error("transient check failure"),
      },
      "volli.db.backup-v51-shm": { sizeBytes: 5 },
      "volli.db.backup-v51-wal": { sizeBytes: 6 },
      "volli.db.backup-v55": { sizeBytes: 55 },
    });
    const rename = fs.deps.quarantineFile;
    fs.deps.quarantineFile = (path, destination) => {
      if (path.endsWith(".backup-v51-wal") || destination.endsWith(".backup-v51-shm"))
        throw new Error("denied");
      rename(path, destination);
    };
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(fs.removeAttempts).toEqual([]);
    expect(fs.names()).not.toContain("volli.db.backup-v51");
    expect(fs.names()).toContain("volli.db.backup-v51-wal");
    expect(report.quarantined).toHaveLength(2);
    expect(report.failed.some((entry) => entry.error.includes("quarantine rollback failed"))).toBe(
      true,
    );
    const later = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(fs.removeAttempts).toEqual([]);
    expect(later.kept.map((entry) => entry.name)).toContain("volli.db.backup-v51-wal");
  });

  it.each(["base", "sidecar"])(
    "preserves the whole family after a %s-only quarantine failure",
    (failure) => {
      const fs = fakeFilesystem({
        "volli.db.backup-v51": {
          sizeBytes: 51,
          integrityError: new Error("transient check failure"),
          quarantineError: failure === "base" ? new Error("base denied") : undefined,
        },
        "volli.db.backup-v51-shm": { sizeBytes: 5 },
        "volli.db.backup-v51-wal": {
          sizeBytes: 6,
          quarantineError: failure === "sidecar" ? new Error("WAL denied") : undefined,
        },
        "volli.db.backup-v55": { sizeBytes: 55 },
      });
      const before = fs.names();
      const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
      expect(fs.names()).toEqual(before);
      expect(fs.removeAttempts).toEqual([]);
      expect(report.quarantined).toEqual([]);
      expect(report.kept.map((entry) => entry.name)).toEqual(["volli.db.backup-v55"]);
    },
  );
  it("classifies corrupt history even when this run's copy is missing, without pruning clean history", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v51": { sizeBytes: 51 },
      "volli.db.backup-v54": { sizeBytes: 54, integrityError: new Error("malformed") },
    });
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(fs.removeAttempts).toEqual([]);
    expect(report.kept.map((entry) => entry.name)).toEqual(["volli.db.backup-v51"]);
    expect(report.quarantined).toHaveLength(1);
    expect(report.failed.map((entry) => entry.name)).toEqual([
      "volli.db.backup-v55",
      "volli.db.backup-v54",
    ]);
  });

  it("keeps the newest earlier clean copy as well as a clean future-version copy after restore", () => {
    const fs = fakeFilesystem({
      "volli.db.backup-v50": { sizeBytes: 50 },
      "volli.db.backup-v51": { sizeBytes: 51 },
      "volli.db.backup-v55": { sizeBytes: 55 },
      "volli.db.backup-v56": { sizeBytes: 56 },
    });
    const report = pruneMigrationBackups("/profile/volli.db", 55, fs.deps);
    expect(report.kept.map((entry) => entry.name)).toEqual([
      "volli.db.backup-v51",
      "volli.db.backup-v55",
      "volli.db.backup-v56",
    ]);
    expect(fs.removeAttempts).toEqual(["volli.db.backup-v50"]);
  });
});
