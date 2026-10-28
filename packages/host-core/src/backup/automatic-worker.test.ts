import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "./test-fixture";
import { readBackupBundle } from "./bundle";
import { withProfileMaintenance } from "./profile-maintenance";
import {
  automaticBackupDiskRequirement,
  createAutomaticBackup,
  runAutomaticBackupWorker,
} from "./automatic-worker";

const diskMock = vi.hoisted(() => ({ statfs: vi.fn<typeof import("node:fs/promises").statfs>() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  statfs: diskMock.statfs,
}));
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let profile: FixtureProfile;
beforeEach(() => {
  diskMock.statfs.mockReset().mockImplementation(actualFs.statfs);
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
      ARGS,
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
  it("pauses a real worker during a move and resumes once its lease ends", async () => {
    const notices: Array<string | null> = [];
    let observed!: () => void;
    const paused = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let flight!: Promise<{ sizeBytes: number }>;
    await withProfileMaintenance(profile.root, async () => {
      flight = runAutomaticBackupWorker(
        ENTRY,
        request(),
        new AbortController().signal,
        (notice) => {
          notices.push(notice);
          if (notice?.includes("migration or move")) observed();
        },
        ARGS,
      );
      await paused;
      expect(existsSync(request().outputPath)).toBe(false);
    });
    expect((await flight).sizeBytes).toBeGreaterThan(0);
    expect(notices).toContain("Backup paused during a profile migration or move.");
    expect(notices.at(-1)).toBeNull();
  }, 30_000);
  it("refuses an already cancelled command without starting a thread", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAutomaticBackupWorker(ENTRY, request(), controller.signal, () => {}, ARGS),
    ).rejects.toThrow("interrupted");
  });
});
