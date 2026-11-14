import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cloneOrCopyFile } from "../db/file-clone";
import { copyLiveDatabase } from "./live-snapshot";

const copyMock = vi.hoisted(() => ({
  copyFile: vi.fn<typeof import("node:fs/promises").copyFile>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  copyFile: copyMock.copyFile,
}));
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let root: string;
let dbPath: string;
let live: Database.Database;

/** Each commit writes one row to both tables: a copy is consistent only if they match. */
function openLive(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 400");
  db.exec(
    "CREATE TABLE IF NOT EXISTS lefts (id INTEGER PRIMARY KEY, body TEXT);" +
      "CREATE TABLE IF NOT EXISTS rights (id INTEGER PRIMARY KEY, body TEXT);",
  );
  return db;
}
function commit(db: Database.Database, id: number): void {
  db.transaction(() => {
    db.prepare("INSERT INTO lefts (id, body) VALUES (?, ?)").run(id, "l".repeat(900));
    db.prepare("INSERT INTO rights (id, body) VALUES (?, ?)").run(id, "r".repeat(900));
  })();
}
function counts(path: string): { lefts: number; rights: number; check: string } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      lefts: (db.prepare("SELECT count(*) AS n FROM lefts").get() as { n: number }).n,
      rights: (db.prepare("SELECT count(*) AS n FROM rights").get() as { n: number }).n,
      check: db.pragma("integrity_check", { simple: true }) as string,
    };
  } finally {
    db.close();
  }
}
const clone = (from: string, to: string) => cloneOrCopyFile(from, to);
const noHold = async () => () => {};

beforeEach(() => {
  copyMock.copyFile.mockReset().mockImplementation(actualFs.copyFile);
  root = mkdtempSync(join(tmpdir(), "volli-live-snapshot-"));
  dbPath = join(root, "volli.db");
  live = openLive();
  for (let id = 1; id <= 2000; id++) commit(live, id);
});
afterEach(() => {
  if (live.open) live.close();
  rmSync(root, { recursive: true, force: true });
});

describe("copyLiveDatabase", () => {
  it("copies commits still only in the WAL into one self-contained file", async () => {
    live.pragma("wal_autocheckpoint = 0");
    for (let id = 2001; id <= 2100; id++) commit(live, id);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    const snapshot = join(root, "snapshot.db");
    const result = await copyLiveDatabase(source, dbPath, snapshot, {
      clone,
      holdCheckpoints: noHold,
    });
    source.close();
    expect(result.walBytes).toBeGreaterThan(0);
    expect(counts(snapshot)).toEqual({ lefts: 2100, rights: 2100, check: "ok" });
    // The copy needs neither a WAL nor a -shm beside it.
    await expect(fs.stat(`${snapshot}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${snapshot}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
    const copy = new Database(snapshot, { readonly: true });
    expect(copy.pragma("journal_mode", { simple: true })).toBe("delete");
    copy.close();
  });

  it("stays consistent under continuous writes, and leaves the WAL free to restart", async () => {
    let id = 2000;
    const writer = setInterval(() => {
      for (let n = 0; n < 5; n++) commit(live, ++id);
    }, 1);
    const holds: string[] = [];
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    const snapshot = join(root, "snapshot.db");
    try {
      for (let round = 0; round < 3; round++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await fs.rm(snapshot, { force: true });
        const before = id;
        await copyLiveDatabase(source, dbPath, snapshot, {
          clone,
          holdCheckpoints: async () => {
            holds.push("held");
            return () => holds.push("released");
          },
        });
        const copied = counts(snapshot);
        expect(copied.check).toBe("ok");
        expect(copied.lefts).toBe(copied.rights);
        expect(copied.lefts).toBeGreaterThanOrEqual(before);
      }
    } finally {
      clearInterval(writer);
      source.close();
    }
    expect(holds).toEqual(["held", "released", "held", "released", "held", "released"]);
    // No read transaction outlives the copy: a full checkpoint finishes and the WAL restarts.
    const [row] = live.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    expect(row?.busy).toBe(0);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
  });

  it("copies the WAL again when a restart overwrites it mid-copy", async () => {
    live.pragma("wal_autocheckpoint = 0");
    for (let id = 2001; id <= 2050; id++) commit(live, id);
    // Fully backfilled but not restarted: the copy's reader takes read mark
    // zero, which lets a writer restart the WAL while the copy runs.
    live.pragma("wal_checkpoint(PASSIVE)");
    let restarted = false;
    copyMock.copyFile.mockImplementation(async (...args) => {
      await actualFs.copyFile(...args);
      if (!restarted) {
        restarted = true;
        commit(live, 2051);
      }
    });
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    const snapshot = join(root, "snapshot.db");
    await copyLiveDatabase(source, dbPath, snapshot, { clone, holdCheckpoints: noHold });
    source.close();
    expect(copyMock.copyFile).toHaveBeenCalledTimes(2);
    const copied = counts(snapshot);
    expect(copied.check).toBe("ok");
    expect(copied.lefts).toBe(copied.rights);
    expect([2050, 2051]).toContain(copied.lefts);
  });

  it("gives up when no copy of the WAL matches the live header, and still releases", async () => {
    live.pragma("wal_autocheckpoint = 0");
    for (let id = 2001; id <= 2010; id++) commit(live, id);
    // Stands in for a copy that a restart overwrote every time: the salts differ.
    copyMock.copyFile.mockImplementation(async (from, to) => {
      await actualFs.copyFile(from, to);
      const handle = await actualFs.open(to as string, "r+");
      await handle.write(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, 16);
      await handle.close();
    });
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    const released = vi.fn();
    await expect(
      copyLiveDatabase(source, dbPath, join(root, "snapshot.db"), {
        clone,
        holdCheckpoints: async () => released,
      }),
    ).rejects.toThrow("kept restarting");
    expect(copyMock.copyFile).toHaveBeenCalledTimes(3);
    expect(released).toHaveBeenCalledOnce();
    // The read transaction ended with the failure.
    expect(source.inTransaction).toBe(false);
    source.close();
  });

  it("copies a database that has no WAL file", async () => {
    live.pragma("wal_checkpoint(TRUNCATE)");
    live.close();
    await fs.rm(`${dbPath}-wal`, { force: true });
    await fs.rm(`${dbPath}-shm`, { force: true });
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    const snapshot = join(root, "snapshot.db");
    const result = await copyLiveDatabase(source, dbPath, snapshot, {
      clone,
      holdCheckpoints: noHold,
    });
    source.close();
    expect(result.walBytes).toBe(0);
    expect(counts(snapshot)).toEqual({ lefts: 2000, rights: 2000, check: "ok" });
  });

  it.each(["hold", "wal-copied", "cloned", "claimed", "done"])(
    "leaves the live database whole when the process is killed at %s",
    async (step) => {
      let id = 2000;
      const writer = setInterval(() => commit(live, ++id), 1);
      const child = spawn(
        process.execPath,
        [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          fileURLToPath(new URL("./live-snapshot-kill-child.test-fixture.mjs", import.meta.url)),
          dbPath,
          join(root, "snapshot.db"),
          step,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
        child.once("exit", (_code, killed) => resolve(killed)),
      );
      clearInterval(writer);
      expect(output).toContain(`SIGKILL at ${step}`);
      expect(signal).toBe("SIGKILL");
      const written = id;
      // The next launch: a fresh connection opens it, checks it clean, and
      // folds the WAL; no lock outlived the killed reader.
      live.close();
      const next = new Database(dbPath);
      try {
        expect(next.pragma("integrity_check", { simple: true })).toBe("ok");
        const [row] = next.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
        expect(row?.busy).toBe(0);
      } finally {
        next.close();
      }
      expect(counts(dbPath)).toEqual({ lefts: written, rights: written, check: "ok" });
    },
    30_000,
  );
});
