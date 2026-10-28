import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rotateAutomaticBackups } from "../backup/automatic";
import { readBackupBundle } from "../backup/bundle";
import { withProfileMaintenance } from "../backup/profile-maintenance";
import { createFixtureProfile, type FixtureProfile } from "../backup/test-fixture";
import { createMoveBackupPort, type MoveBackupOptions } from "./backup";

const publication = vi.hoisted(() => ({
  onKept: undefined as (() => void) | undefined,
  cleanupBusy: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (publication.cleanupBusy && String(args[0]).endsWith(".work"))
        throw Object.assign(new Error("cleanup busy"), { code: "EBUSY" });
      return original.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      await original.writeFile(...args);
      if (String(args[0]).endsWith(".kept")) publication.onKept?.();
    },
  };
});

let profile: FixtureProfile;
beforeEach(() => {
  publication.onKept = undefined;
  publication.cleanupBusy = false;
  profile = createFixtureProfile();
  profile.db.pragma("journal_mode = WAL");
});
afterEach(() => profile.cleanup());

function options(): MoveBackupOptions {
  return {
    workerEntry: new URL("../backup/test-support/worker-under-node.mjs", import.meta.url),
    workerExecArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"],
    dataDir: profile.root,
    dbPath: profile.dbPath,
    blobsRoot: profile.blobsRoot,
    transcriptsRoot: profile.transcriptsRoot,
    appVersion: "test",
    workRoot: join(profile.root, "cloud-moves"),
    estimatedExportBytes: 1024,
  };
}

describe("the move's whole-profile backup", () => {
  it("reads back a real v1 bundle under the move lease and returns its path, bytes and digest", async () => {
    const result = await withProfileMaintenance(profile.root, () =>
      createMoveBackupPort(options()).write(new AbortController().signal),
    );
    expect(dirname(result.path)).toBe(join(profile.root, "backups"));
    expect(basename(result.path)).toMatch(/^pre-cloud-move-.*\.tar\.gz$/);
    expect(existsSync(`${result.path}.kept`)).toBe(true);
    const bytes = readFileSync(result.path);
    expect(result.bytes).toBe(bytes.length);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const read = readBackupBundle(bytes);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.bundle.document.tables.projects!.rows.length).toBeGreaterThan(1);
      expect(read.bundle.document.tables.session_events!.rows.length).toBeGreaterThan(0);
      expect(read.bundle.document.tables.secrets).toBeUndefined();
    }
    expect(existsSync(`${result.path}.partial`)).toBe(false);

    // Even a kept bundle inside the daily writer's namespace is not deletion authority.
    const directory = dirname(result.path);
    const start = Date.UTC(2026, 0, 1);
    const DAY = 86_400_000;
    const old = `auto-${start}-00000000-0000-4000-8000-000000000000.tar.gz`;
    await copyFile(result.path, join(directory, old));
    await writeFile(join(directory, `${old}.kept`), "");
    for (let day = 0; day < 16; day++) {
      const fileName =
        day === 0 ? old : `auto-${start + day * DAY}-00000000-0000-4000-8000-000000000000.tar.gz`;
      if (day !== 0) await copyFile(result.path, join(directory, fileName));
      await writeFile(
        join(directory, `${fileName}.json`),
        JSON.stringify({
          fileName,
          createdAt: start + day * DAY,
          sizeBytes: result.bytes,
          verified: true,
        }),
      );
    }
    await rotateAutomaticBackups(directory, start + 40 * DAY);
    await rotateAutomaticBackups(directory, start + 40 * DAY, "failed");
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(`${result.path}.kept`)).toBe(true);
    expect(existsSync(join(directory, old))).toBe(true);
    expect(
      existsSync(
        join(directory, `auto-${start + DAY}-00000000-0000-4000-8000-000000000000.tar.gz`),
      ),
    ).toBe(false);
  }, 30_000);

  it("returns a published backup in the chosen folder even if cancellation arrives with its keep marker", async () => {
    const abort = new AbortController();
    publication.onKept = () => abort.abort();
    const directory = join(profile.root, "chosen-backups");
    const result = await createMoveBackupPort({ ...options(), directory }).write(abort.signal);
    expect(abort.signal.aborted).toBe(true);
    expect(dirname(result.path)).toBe(directory);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(`${result.path}.kept`)).toBe(true);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it("never returns a backup when read-back detects corrupt record links", async () => {
    profile.db.pragma("foreign_keys = OFF");
    profile.db.prepare("UPDATE tickets SET project_id = 'missing' WHERE id = 'ticket-live'").run();
    await expect(
      createMoveBackupPort(options()).write(new AbortController().signal),
    ).rejects.toMatchObject({ code: "verification" });
    const files = await readdir(join(profile.root, "backups"));
    expect(files).toEqual([]);
  }, 30_000);

  it.each([false, true])(
    "preserves the disk-full pause even if cleanup fails (%s)",
    async (cleanupBusy) => {
      publication.cleanupBusy = cleanupBusy;
      await expect(
        createMoveBackupPort({ ...options(), estimatedExportBytes: 1_000_000_000_000_000 }).write(
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "ENOSPC", message: expect.stringContaining("bytes free") });
      const files = await readdir(join(profile.root, "backups"));
      expect(files).toEqual([]);
    },
    30_000,
  );

  it("reclaims a crashed move's scratch and partial, never a final bundle or live worker's files", async () => {
    const directory = join(profile.root, "backups");
    const pathFor = (pid: number) =>
      join(
        directory,
        `pre-cloud-move-2026-01-01T00-00-00.000Z-${pid}-00000000-0000-4000-8000-000000000000.tar.gz`,
      );
    const dead = pathFor(2147483647);
    const live = pathFor(process.pid);
    await mkdir(`${dead}.work`, { recursive: true });
    await mkdir(`${live}.work`, { recursive: true });
    for (const path of [
      `${dead}.partial`,
      `${dead}.failed`,
      `${dead}.failed.json`,
      `${live}.partial`,
      dead,
      `${dead}.kept`,
    ])
      await writeFile(path, "leave final/live files alone");
    await createMoveBackupPort(options()).write(new AbortController().signal);
    for (const path of [`${dead}.work`, `${dead}.partial`, `${dead}.failed`, `${dead}.failed.json`])
      expect(existsSync(path)).toBe(false);
    for (const path of [dead, `${dead}.kept`, `${live}.work`, `${live}.partial`])
      expect(existsSync(path)).toBe(true);
  }, 30_000);

  it("does not start an already cancelled backup or accept invalid byte estimates", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(createMoveBackupPort(options()).write(abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(join(profile.root, "backups"))).toBe(false);
    for (const estimatedExportBytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => createMoveBackupPort({ ...options(), estimatedExportBytes })).toThrow(
        RangeError,
      );
    }
  });
});
