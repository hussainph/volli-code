import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createFixtureProfile, type FixtureProfile } from "./test-fixture";
import { createBackupBundle } from "./bundle";
import { restoreBackupBundleFile, RESTORE_CREDENTIALS } from "./restore";
import {
  acceptPreparedBackupRestore,
  activateScheduledBackupRestore,
  cancelScheduledBackupRestore,
  hasScheduledBackupRestore,
  scheduleBackupRestore,
} from "./restore-schedule";
import { ProfileRestoreService, listRestoreBundles } from "./restore-service";
import { runRestoreWorker } from "./restore-worker";

const ENTRY = new URL("./test-support/restore-worker-under-node.mjs", import.meta.url);
const ARGS = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
let profile: FixtureProfile;
let bundlePath: string;
let paths: Record<string, string>;
beforeEach(() => {
  profile = createFixtureProfile();
  paths = { "proj-alpha": join(profile.root, "alpha"), "proj-beta": join(profile.root, "beta") };
  for (const [id, path] of Object.entries(paths)) {
    mkdirSync(path);
    profile.db.prepare("UPDATE projects SET path = ? WHERE id = ?").run(path, id);
  }
  mkdirSync(join(profile.root, "backups"));
  bundlePath = join(profile.root, "backups", "test.tar.gz");
  writeFileSync(
    bundlePath,
    createBackupBundle({
      db: profile.db,
      blobsRoot: profile.blobsRoot,
      transcriptsRoot: profile.transcriptsRoot,
      appVersion: "test",
      now: 1700000000000,
    }).bytes,
  );
  profile.db
    .prepare("UPDATE tickets SET title = 'change after backup' WHERE id = 'ticket-live'")
    .run();
});
afterEach(() => {
  profile.cleanup();
  vi.restoreAllMocks();
});
function stage(now = 1800000000000) {
  return restoreBackupBundleFile({
    bundlePath,
    profileRoot: profile.root,
    projectPaths: paths,
    now,
    stageOnly: true,
    checkpoint: async () => {},
  });
}
function liveTitle() {
  return (
    profile.db.prepare("SELECT title FROM tickets WHERE id = 'ticket-live'").get() as {
      title: string;
    }
  ).title;
}
function service() {
  return new ProfileRestoreService({
    root: profile.root,
    workerEntry: ENTRY,
    workerExecArgv: ARGS,
    available: () => true,
    pickBundle: async () => bundlePath,
    pickDirectory: async () => paths["proj-alpha"]!,
    restart: vi.fn(),
    localProjects: () =>
      profile.db.prepare("SELECT id, name, path FROM projects").all() as {
        id: string;
        name: string;
        path: string;
      }[],
  });
}
describe("Storage restore staging and restart", () => {
  it("prepares under a live writer, switches only before opening the next profile, and keeps the previous history", async () => {
    const result = await stage();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.stagedPath).toBeTruthy();
    expect(liveTitle()).toBe("change after backup");
    expect(existsSync(result.report.replacedPath)).toBe(false);
    expect(result.report.credentials).toEqual(RESTORE_CREDENTIALS);
    await scheduleBackupRestore(profile.root, result.report);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    acceptPreparedBackupRestore(profile.root);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(true);
    // The existing live-writer fence still refuses an accidental activation.
    profile.db.exec("BEGIN IMMEDIATE");
    await expect(activateScheduledBackupRestore(profile.root)).rejects.toThrow();
    profile.db.exec("ROLLBACK");
    expect(liveTitle()).toBe("change after backup");
    profile.db.close();
    await activateScheduledBackupRestore(profile.root);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    const restored = new Database(profile.dbPath, { readonly: true });
    const previous = new Database(join(result.report.replacedPath, "volli.db"), { readonly: true });
    try {
      expect(
        (
          restored.prepare("SELECT title FROM tickets WHERE id = 'ticket-live'").get() as {
            title: string;
          }
        ).title,
      ).not.toBe("change after backup");
      expect(
        (
          previous.prepare("SELECT title FROM tickets WHERE id = 'ticket-live'").get() as {
            title: string;
          }
        ).title,
      ).toBe("change after backup");
      expect(restored.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
      expect(restored.prepare("SELECT COUNT(*) FROM projects").pluck().get()).toBe(2);
      expect(restored.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBeGreaterThan(0);
    } finally {
      restored.close();
      previous.close();
    }
  }, 15000);
  it("withdraws a prepared restore durably without touching the current profile", async () => {
    const result = await stage();
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    await scheduleBackupRestore(profile.root, result.report);
    await cancelScheduledBackupRestore(profile.root);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    expect(existsSync(result.report.stagedPath!)).toBe(false);
    expect(liveTitle()).toBe("change after backup");
  });
  it("refuses a changed staged database and leaves the live database untouched", async () => {
    const result = await stage();
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    await scheduleBackupRestore(profile.root, result.report);
    acceptPreparedBackupRestore(profile.root);
    writeFileSync(join(result.report.stagedPath!, "volli.db"), "damaged");
    await expect(activateScheduledBackupRestore(profile.root)).rejects.toThrow("changed");
    expect(liveTitle()).toBe("change after backup");
  });
  it("a worker crash mid-restore never changes the live profile or schedules activation", async () => {
    const before = readFileSync(profile.dbPath);
    const worker = new Worker(ENTRY, {
      workerData: {
        kind: "stage",
        root: profile.root,
        bundlePath,
        projectPaths: paths,
        now: 1800000000001,
      },
      execArgv: ARGS,
    });
    await new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: { checkpoints?: number }) => {
        if (message.checkpoints === 3) void worker.terminate().then(() => resolve(), reject);
      });
    });
    expect(readFileSync(profile.dbPath)).toEqual(before);
    expect(liveTitle()).toBe("change after backup");
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
  });
  it("worker inspection returns verified project labels, and cancellation crosses the real worker boundary", async () => {
    const inspect = await runRestoreWorker(
      ENTRY,
      { kind: "inspect", root: profile.root, bundlePath },
      new AbortController().signal,
      () => {},
      ARGS,
    );
    expect(inspect).toMatchObject({
      ok: true,
      projects: [
        { id: "proj-alpha", name: "Alpha" },
        { id: "proj-beta", name: "Beta" },
      ],
    });
    const abort = new AbortController();
    await expect(
      runRestoreWorker(
        ENTRY,
        { kind: "stage", root: profile.root, bundlePath, projectPaths: paths, now: 1800000000002 },
        abort.signal,
        () => abort.abort(),
        ARGS,
      ),
    ).rejects.toThrow("cancelled");
    expect(liveTitle()).toBe("change after backup");
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
  });
  it("lists receipt states and kept move bundles; service requires the current mapping revision", async () => {
    writeFileSync(
      `${bundlePath}.json`,
      JSON.stringify({
        fileName: "test.tar.gz",
        createdAt: 1700000000000,
        sizeBytes: readFileSync(bundlePath).length,
        verified: true,
      }),
    );
    writeFileSync(join(profile.root, "backups", "broken.tar.gz.failed"), "broken");
    writeFileSync(join(profile.root, "backups", "pre-cloud-move-test.tar.gz"), "kept");
    writeFileSync(join(profile.root, "backups", "pre-cloud-move-test.tar.gz.kept"), "");
    expect(await listRestoreBundles(profile.root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fileName: "test.tar.gz", verification: "verified" }),
        expect.objectContaining({ fileName: "broken.tar.gz.failed", verification: "failed" }),
        expect.objectContaining({ fileName: "pre-cloud-move-test.tar.gz", keptForMove: true }),
      ]),
    );
    const restore = service();
    expect((await restore.choose("test.tar.gz")).phase).toBe("checking");
    await restore.settled();
    const mapped = await restore.status();
    expect(mapped.phase).toBe("mapping");
    expect(mapped.projects[0]).toEqual({
      id: "proj-alpha",
      name: "Alpha",
      directory: paths["proj-alpha"],
    });
    expect((await restore.start("stale", paths)).phase).toBe("mapping");
    expect((await restore.start(mapped.revision, paths)).phase).toBe("staging");
    await restore.settled();
    const ready = await restore.status();
    expect(ready.phase).toBe("ready");
    expect(ready.credentialsMessage).toBe(RESTORE_CREDENTIALS.message);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    expect(liveTitle()).toBe("change after backup");
    await expect(restore.choose("../test.tar.gz")).rejects.toThrow();
    await restore.restart(ready.revision);
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    restore.restartRefused();
    restore.acceptRestart();
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
    await restore.restart(ready.revision);
    restore.acceptRestart();
    expect(await hasScheduledBackupRestore(profile.root)).toBe(true);
    expect((await restore.cancel(ready.revision)).phase).toBe("cancelled");
    expect(await hasScheduledBackupRestore(profile.root)).toBe(false);
  });
});
