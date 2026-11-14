import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "./test-fixture";
import { AutomaticProfileBackups } from "./automatic";
import { readBackupBundle } from "./bundle";
import { withProfileMaintenance } from "./profile-maintenance";
import { WAL_AUTOCHECKPOINT_PAGES } from "../db/autocheckpoint";
import {
  automaticBackupDiskRequirement,
  checkpointHoldClient,
  createAutomaticBackup,
  runAutomaticBackupWorker,
} from "./automatic-worker";

const diskMock = vi.hoisted(() => ({
  statfs: vi.fn<typeof import("node:fs/promises").statfs>(),
  stat: vi.fn<typeof import("node:fs/promises").stat>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: diskMock.statfs,
  stat: diskMock.stat,
}));
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let profile: FixtureProfile;
beforeEach(() => {
  diskMock.statfs.mockReset().mockImplementation(actualFs.statfs);
  diskMock.stat.mockReset().mockImplementation(actualFs.stat);
  profile = createFixtureProfile();
  profile.db.pragma("journal_mode = WAL");
});
afterEach(() => {
  vi.restoreAllMocks();
  profile.cleanup();
});
function request() {
  return {
    dataDir: profile.root,
    dbPath: profile.dbPath,
    blobsRoot: profile.blobsRoot,
    transcriptsRoot: profile.transcriptsRoot,
    appVersion: "test",
    outputPath: join(profile.root, "backups", "bundle.tar.gz"),
    now: Date.now(),
  };
}
const ENTRY = new URL("./test-support/worker-under-node.mjs", import.meta.url);
const ARGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
const HOLDING = new URL("./test-support/hold-checkpoints-worker.mjs", import.meta.url);

describe("the automatic backup worker", () => {
  it("checks disk before creating staging or a bundle", async () => {
    const disk = diskMock.statfs.mockResolvedValue({ bavail: 1, bsize: 1 } as Awaited<
      ReturnType<typeof fs.statfs>
    >);
    const target = request();
    await expect(createAutomaticBackup(target, async () => {})).rejects.toThrow(
      "not enough free disk",
    );
    expect(disk).toHaveBeenCalledOnce();
    expect(await fs.readdir(join(profile.root, "backups"))).toEqual([]);
    expect(automaticBackupDiskRequirement(100_000_000, 1000)).toBeGreaterThanOrEqual(200_000_000);
  });
  it("reserves twice the queue export plus headroom on a shared volume before staging", async () => {
    const target = {
      ...request(),
      move: {
        exportRoot: join(profile.root, "cloud-moves"),
        estimatedExportBytes: 500_000_000,
        headroomBytes: 100_000_000,
      },
    };
    diskMock.statfs.mockResolvedValue({ bavail: 1_100_000_000, bsize: 1 } as Awaited<
      ReturnType<typeof fs.statfs>
    >);
    await expect(createAutomaticBackup(target, async () => {})).rejects.toMatchObject({
      code: "disk-space",
      message: expect.stringContaining("bytes available"),
    });
    expect(await fs.readdir(join(profile.root, "backups"))).toEqual([]);
  });
  it("checks export and backup volumes separately for a chosen backup folder", async () => {
    const exportRoot = join(profile.root, "cloud-moves");
    const target = {
      ...request(),
      move: { exportRoot, estimatedExportBytes: 100_000_000, headroomBytes: 1000 },
    };
    diskMock.stat.mockImplementation(async (...args) => {
      const value = await actualFs.stat(args[0]);
      return args[0] === exportRoot ? Object.assign(value, { dev: value.dev + 1 }) : value;
    });
    diskMock.statfs.mockImplementation(async (...args) => {
      if (args[0] === exportRoot)
        return { bavail: 200_000_999, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>;
      return actualFs.statfs(...args);
    });
    await expect(createAutomaticBackup(target, async () => {})).rejects.toMatchObject({
      code: "disk-space",
      message: expect.stringContaining("200001000 bytes free; 200000999 bytes available"),
    });
    expect(existsSync(target.outputPath)).toBe(false);
    // Enough space on both volumes succeeds without summing their allowances.
    diskMock.statfs.mockImplementation(actualFs.statfs);
    expect((await createAutomaticBackup(target, async () => {})).sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
  it("does not reclaim a daily worker's paused staging or partial archive", async () => {
    const target = {
      ...request(),
      move: {
        exportRoot: join(profile.root, "cloud-moves"),
        estimatedExportBytes: 0,
        headroomBytes: 0,
      },
    };
    const directory = join(profile.root, "backups");
    const dailyScratch = join(directory, `.automatic-${process.pid}-abcdef`);
    const dailyPartial = join(
      directory,
      `auto-${Date.now()}-00000000-0000-4000-8000-000000000000.tar.gz.partial`,
    );
    await fs.mkdir(dailyScratch, { recursive: true });
    await fs.writeFile(join(dailyScratch, "snapshot.db"), "paused snapshot");
    await fs.writeFile(dailyPartial, "paused archive");
    await createAutomaticBackup(target, async () => {});
    expect(await fs.readFile(join(dailyScratch, "snapshot.db"), "utf8")).toBe("paused snapshot");
    expect(await fs.readFile(dailyPartial, "utf8")).toBe("paused archive");
  }, 30_000);
  it("refuses a move publication if its reserved export space disappears", async () => {
    const target = {
      ...request(),
      move: {
        exportRoot: join(profile.root, "cloud-moves"),
        estimatedExportBytes: 1024,
        headroomBytes: 1024,
      },
    };
    let published = false;
    diskMock.statfs.mockImplementation(async (...args) => {
      if (existsSync(`${target.outputPath}.partial`)) {
        published = true;
        return { bavail: 2048, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>;
      }
      return actualFs.statfs(...args);
    });
    await expect(createAutomaticBackup(target, async () => {})).rejects.toMatchObject({
      code: "disk-space",
    });
    expect(published).toBe(true);
    expect(existsSync(target.outputPath)).toBe(false);
    expect(existsSync(`${target.outputPath}.failed`)).toBe(true);
  }, 30_000);
  it("takes a consistent WAL snapshot, verifies it, and answers through a real worker codec", async () => {
    const target = request();
    profile.db
      .prepare(
        "INSERT INTO app_state (key, value, updated_at) VALUES ('wal-only-backup', 'present', 1)",
      )
      .run();
    const result = await runAutomaticBackupWorker(
      ENTRY,
      target,
      new AbortController().signal,
      () => {},
      { execArgv: ARGS },
    );
    expect(result.sizeBytes).toBeGreaterThan(0);
    const read = readBackupBundle(readFileSync(target.outputPath));
    expect(read.ok).toBe(true);
    if (read.ok)
      expect(
        read.bundle.document.tables.app_state!.rows.some((row) => row.includes("wal-only-backup")),
      ).toBe(true);
    expect(
      (await fs.readdir(join(profile.root, "backups"))).filter((name) =>
        name.startsWith(".automatic-"),
      ),
    ).toEqual([]);
  }, 30_000);
  it("holds main's automatic checkpoint only while the worker copies the live database", async () => {
    profile.db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    const settings: unknown[] = [];
    const pragma = profile.db.pragma.bind(profile.db);
    vi.spyOn(profile.db, "pragma").mockImplementation((source, options) => {
      if (source.startsWith("wal_autocheckpoint =")) settings.push(source);
      return pragma(source, options);
    });
    const target = request();
    const result = await runAutomaticBackupWorker(
      ENTRY,
      target,
      new AbortController().signal,
      () => {},
      { execArgv: ARGS, liveDatabase: profile.db },
    );
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(readBackupBundle(readFileSync(target.outputPath)).ok).toBe(true);
    expect(settings).toEqual([
      "wal_autocheckpoint = 0",
      `wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`,
    ]);
    expect(pragma("wal_autocheckpoint", { simple: true })).toBe(WAL_AUTOCHECKPOINT_PAGES);
  }, 30_000);
  it("copies without the pause when main cannot hold its checkpoint", async () => {
    profile.db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    const pragma = profile.db.pragma.bind(profile.db);
    vi.spyOn(profile.db, "pragma").mockImplementation((source, options) => {
      if (source === "wal_autocheckpoint = 0")
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return pragma(source, options);
    });
    const target = request();
    const result = await runAutomaticBackupWorker(
      ENTRY,
      target,
      new AbortController().signal,
      () => {},
      { execArgv: ARGS, liveDatabase: profile.db },
    );
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(readBackupBundle(readFileSync(target.outputPath)).ok).toBe(true);
    expect(pragma("wal_autocheckpoint", { simple: true })).toBe(WAL_AUTOCHECKPOINT_PAGES);
  }, 30_000);
  it("copies without the pause when main never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const posted: string[] = [];
      const client = checkpointHoldClient((message) => posted.push(message.type));
      let resolved = false;
      const flight = client.request().then((release) => {
        resolved = true;
        return release;
      });
      expect(posted).toEqual(["hold-checkpoints"]);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      (await flight)();
      // The release still reaches main, which ignores one it holds nothing for.
      expect(posted).toEqual(["hold-checkpoints", "release-checkpoints"]);
      // A late answer is harmless.
      client.answered();
    } finally {
      vi.useRealTimers();
    }
  });
  it("ends the hold when the worker dies holding it", async () => {
    profile.db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    await expect(
      runAutomaticBackupWorker(
        HOLDING,
        { ...request(), appVersion: "exit" },
        new AbortController().signal,
        () => {},
        { liveDatabase: profile.db },
      ),
    ).rejects.toThrow("stopped (3)");
    expect(profile.db.pragma("wal_autocheckpoint", { simple: true })).toBe(
      WAL_AUTOCHECKPOINT_PAGES,
    );
  });
  it("ends a hold the worker never releases after its limit", async () => {
    profile.db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const controller = new AbortController();
      const flight = runAutomaticBackupWorker(
        HOLDING,
        { ...request(), appVersion: "wait" },
        controller.signal,
        () => {},
        { liveDatabase: profile.db },
      );
      // Real turns of the loop: the fake clock must not move while the worker starts.
      while (profile.db.pragma("wal_autocheckpoint", { simple: true }) !== 0)
        await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(29_999);
      expect(profile.db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
      vi.advanceTimersByTime(1);
      expect(profile.db.pragma("wal_autocheckpoint", { simple: true })).toBe(
        WAL_AUTOCHECKPOINT_PAGES,
      );
      controller.abort();
      await expect(flight).rejects.toThrow("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a real verification failure and keeps its failed archive with a receipt", async () => {
    profile.db.pragma("foreign_keys = OFF");
    profile.db
      .prepare("UPDATE tickets SET project_id = ? WHERE id = ?")
      .run("proj-missing", "ticket-live");
    const service = new AutomaticProfileBackups({
      dataDir: profile.root,
      run: (outputPath, signal, notice) =>
        runAutomaticBackupWorker(ENTRY, { ...request(), outputPath }, signal, notice, {
          execArgv: ARGS,
        }),
      reveal: async () => {},
    });
    try {
      const status = await service.run((await service.status()).revision);
      expect(status.lastBackup).toBeNull();
      expect(status.notice).toContain("verification failed");
      expect(status.notice).not.toContain("Check disk space");
      const files = (await fs.readdir(join(profile.root, "backups"))).filter((name) =>
        name.endsWith(".failed"),
      );
      expect(files).toHaveLength(1);
      expect(
        JSON.parse(await fs.readFile(join(profile.root, "backups", `${files[0]}.json`), "utf8"))
          .verified,
      ).toBe(false);
    } finally {
      service.stop();
      await service.settled();
    }
  }, 30_000);

  it("finishes a snapshot while Sessions continuously write through WAL", async () => {
    const insert = profile.db.prepare(
      "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)",
    );
    profile.db.transaction(() => {
      for (let index = 0; index < 20_000; index++)
        insert.run(`active-${index}`, "x".repeat(512), 1);
    })();
    let writes = 0;
    const update = profile.db.prepare(
      "INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES ('active-writer', ?, ?)",
    );
    const timer = setInterval(() => {
      writes++;
      update.run(String(writes), writes);
    }, 2);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const target = request();
      await runAutomaticBackupWorker(ENTRY, target, controller.signal, () => {}, {
        execArgv: ARGS,
      });
      expect(writes).toBeGreaterThan(2);
      const read = readBackupBundle(readFileSync(target.outputPath));
      expect(read.ok).toBe(true);
      if (read.ok) {
        const table = read.bundle.document.tables.app_state!;
        const row = table.rows.find(
          (item) => item[table.columns.indexOf("key")] === "active-writer",
        )!;
        expect(row[table.columns.indexOf("value")]).toBe(
          String(row[table.columns.indexOf("updated_at")]),
        );
      }
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      controller.abort();
    }
  }, 30_000);

  it("retains a failed archive when verification or publication fails", async () => {
    let checks = 0;
    const target = request();
    const original = actualFs.statfs;
    diskMock.statfs.mockImplementation(async (...args) => {
      checks += 1;
      if (checks === 1) return original(...args);
      return { bavail: 0, bsize: 1 } as Awaited<ReturnType<typeof fs.statfs>>;
    });
    await expect(createAutomaticBackup(target, async () => {})).rejects.toThrow(
      "failed bundle was kept",
    );
    expect(existsSync(target.outputPath)).toBe(false);
    expect(existsSync(`${target.outputPath}.failed`)).toBe(true);
  }, 30_000);
  it("pauses a real worker across a database-path override and resumes after the move", async () => {
    const target = {
      ...request(),
      dataDir: join(profile.root, "alternate-profile"),
      outputPath: join(profile.root, "alternate-profile", "backups", "bundle.tar.gz"),
    };
    const notices: Array<string | null> = [];
    let observed!: () => void;
    const paused = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let flight!: Promise<{ sizeBytes: number }>;
    await withProfileMaintenance(profile.root, async () => {
      flight = runAutomaticBackupWorker(
        ENTRY,
        target,
        new AbortController().signal,
        (notice) => {
          notices.push(notice);
          if (notice?.includes("migration or move")) observed();
        },
        { execArgv: ARGS },
      );
      await paused;
      expect(existsSync(target.outputPath)).toBe(false);
    });
    expect((await flight).sizeBytes).toBeGreaterThan(0);
    expect(notices).toContain("Backup paused during a profile migration or move.");
    expect(notices.at(-1)).toBeNull();
  }, 30_000);
  it("refuses an already cancelled command without starting a thread", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAutomaticBackupWorker(ENTRY, request(), controller.signal, () => {}, { execArgv: ARGS }),
    ).rejects.toThrow("interrupted");
  });
});
