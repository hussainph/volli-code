import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AutomaticProfileBackups,
  retainedAutomaticBackups,
  rotateAutomaticBackups,
  type AutomaticBackupRecord,
} from "./automatic";
import { ProfileBackupError } from "./errors";
import { profileMaintenanceActive, withProfileMaintenance } from "./profile-maintenance";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "automatic-backup-test-"));
  roots.push(root);
  return root;
}
const DAY = 86_400_000;
const START = Date.parse("2026-10-26T12:00:00Z");
function record(index: number): AutomaticBackupRecord {
  return {
    fileName: `auto-${START - index * DAY}-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.tar.gz`,
    createdAt: START - index * DAY,
    sizeBytes: 6,
    verified: true,
  };
}

describe("automatic profile backups", () => {
  it("runs once per 24h, persists across launches, coalesces clicks, and stops", async () => {
    const dataDir = await directory();
    let now = START;
    const run = vi.fn(async (path: string) => {
      await writeFile(path, "bundle");
      return { sizeBytes: 6 };
    });
    const service = new AutomaticProfileBackups({
      dataDir,
      now: () => now,
      run,
      reveal: async () => {},
    });
    expect(service.run()).toBe(service.run());
    await service.run();
    await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
    const reopened = new AutomaticProfileBackups({
      dataDir,
      now: () => now,
      run,
      reveal: async () => {},
    });
    await reopened.tick();
    expect(run).toHaveBeenCalledTimes(1);
    now += DAY;
    await reopened.tick();
    expect(run).toHaveBeenCalledTimes(2);
    reopened.stop();
    now += DAY;
    await reopened.tick();
    await expect(reopened.run()).rejects.toThrow("closing");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports failed verification, keeps the failed file, and throttles automatic retries", async () => {
    const dataDir = await directory();
    let now = START;
    const run = vi.fn(async (path: string) => {
      await writeFile(`${path}.failed`, "bad bundle");
      throw new ProfileBackupError(
        "verification",
        "Backup verification failed; failed bundle kept.",
      );
    });
    const service = new AutomaticProfileBackups({
      dataDir,
      now: () => now,
      run,
      reveal: async () => {},
    });
    await service.tick();
    expect(await service.status()).toMatchObject({
      running: false,
      lastBackup: null,
      notice: "Backup verification failed; failed bundle kept.",
    });
    await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (await readdir(join(dataDir, "backups"))).filter((name) => name.endsWith(".failed")),
    ).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(dataDir, "backups", "automatic-state.json"), "utf8")).notice,
    ).toContain("verification failed");
    now += 60 * 60_000;
    await service.tick();
    expect(run).toHaveBeenCalledTimes(1);
    now += DAY;
    await service.tick();
    expect(run).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it("makes a revision-conditional manual intent idempotent across completion and restart", async () => {
    const dataDir = await directory();
    const run = vi.fn(async (path: string) => {
      await writeFile(path, "bundle");
      return { sizeBytes: 6 };
    });
    const options = { dataDir, now: () => START, run, reveal: async () => {} };
    const service = new AutomaticProfileBackups(options);
    const revision = (await service.status()).revision;
    const first = await service.run(revision);
    expect(first.revision).not.toBe(revision);
    await service.run(revision);
    const reopened = new AutomaticProfileBackups(options);
    await reopened.run(revision);
    expect(run).toHaveBeenCalledTimes(1);
    await reopened.run(first.revision);
    expect(run).toHaveBeenCalledTimes(2);
    service.stop();
    reopened.stop();
  });

  it("bounds the failed tier while preserving kept failed bundles", async () => {
    const root = await directory();
    const records = Array.from({ length: 20 }, (_, index) => ({
      ...record(index),
      fileName: `${record(index).fileName}.failed`,
      verified: false,
    }));
    for (const item of records) {
      await writeFile(join(root, item.fileName), "bundle");
      await writeFile(join(root, `${item.fileName}.json`), JSON.stringify(item));
    }
    await writeFile(join(root, `${records[15]!.fileName}.kept`), "");
    await rotateAutomaticBackups(root, START, "failed");
    const files = (await readdir(root)).filter((name) => name.endsWith(".failed"));
    expect(files).toHaveLength(9); // Seven dailies, one weekly, one explicit keep.
    expect(files).toContain(records[15]!.fileName);
  });

  it("backs up an empty history on start, with no duplicate timer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = await directory();
    const service = new AutomaticProfileBackups({
      dataDir,
      now: () => START,
      run: async (path) => {
        await writeFile(path, "bundle");
        return { sizeBytes: 6 };
      },
      reveal: async () => {},
    });
    service.start();
    service.start();
    expect(vi.getTimerCount()).toBe(1);
    await service.run();
    service.stop();
    service.stop();
    service.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps seven distinct daily snapshots and the most recent completed week's backup", () => {
    const records = Array.from({ length: 20 }, (_, index) => record(index));
    const keep = retainedAutomaticBackups(records, START);
    expect(keep).toEqual(
      new Set([...records.slice(0, 7), records[8]!].map((item) => item.fileName)),
    );
    // Late in the week, last Sunday is the eighth daily and remains as weekly.
    const sunday = START + DAY * 6;
    const later = records.map((item) =>
      Object.assign({}, item, { createdAt: item.createdAt + DAY * 6 }),
    );
    expect(retainedAutomaticBackups(later, sunday).size).toBe(8);
    expect(
      retainedAutomaticBackups([...later, { ...record(19), kept: true }], sunday).has(
        record(19).fileName,
      ),
    ).toBe(true);
  });

  it("rotates only verified owned bundles; never kept, failed, unknown or move bundles", async () => {
    const root = await directory();
    const records = Array.from({ length: 15 }, (_, index) => record(index));
    for (const item of records) {
      await writeFile(join(root, item.fileName), "bundle");
      await writeFile(join(root, `${item.fileName}.json`), JSON.stringify(item));
    }
    await writeFile(join(root, `${records[10]!.fileName}.kept`), "");
    await writeFile(
      join(root, `${records[11]!.fileName}.json`),
      JSON.stringify({ ...records[11], kept: true }),
    );
    await writeFile(join(root, `${records[12]!.fileName}.json`), "broken");
    await writeFile(join(root, "move-backup.tar.gz"), "bundle");
    await writeFile(join(root, "old.tar.gz.failed"), "failed");
    await rotateAutomaticBackups(root, START);
    const names = await readdir(root);
    expect(names).not.toContain(records[9]!.fileName);
    for (const index of [0, 6, 10, 11, 12]) expect(names).toContain(records[index]!.fileName);
    expect(names).toContain("move-backup.tar.gz");
    expect(names).toContain("old.tar.gz.failed");
  });

  it("pauses while any migration/move lease is held and releases after failure", async () => {
    const root = await directory();
    expect(await profileMaintenanceActive(root)).toBe(false);
    await expect(
      withProfileMaintenance(root, async () => {
        expect(await profileMaintenanceActive(root)).toBe(true);
        await withProfileMaintenance(root, async () => {
          expect(await profileMaintenanceActive(root)).toBe(true);
        });
        expect(await profileMaintenanceActive(root)).toBe(true);
        throw new Error("move failed");
      }),
    ).rejects.toThrow("move failed");
    expect(await profileMaintenanceActive(root)).toBe(false);
  });
});
