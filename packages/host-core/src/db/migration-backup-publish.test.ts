import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { migrate } from "./migrations";
import { openRawDb } from "./test-helpers";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: vi.fn(fs.renameSync),
    linkSync: vi.fn(fs.linkSync),
    unlinkSync: vi.fn(fs.unlinkSync),
  };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let directory: string;
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
  vi.mocked(linkSync).mockReset().mockImplementation(actualFs.linkSync);
  vi.mocked(unlinkSync).mockReset().mockImplementation(actualFs.unlinkSync);
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("migration backup publication failure recovery", () => {
  it.each(["base", "sidecar", "publish", "rollback"])(
    "preserves recovery bytes if %s rename fails",
    (failure) => {
      directory = mkdtempSync(join(tmpdir(), "volli-backup-publish-"));
      const dbPath = join(directory, "volli.db");
      const backupPath = `${dbPath}.backup-v55`;
      const db = openRawDb(dbPath);
      db.pragma("journal_mode = WAL");
      migrate(db, dbPath, { toVersion: 55 });
      db.exec(
        "CREATE TABLE recovery_probe (value TEXT); INSERT INTO recovery_probe VALUES ('last clean state')",
      );
      db.pragma("wal_checkpoint(TRUNCATE)");
      copyFileSync(dbPath, backupPath);
      writeFileSync(`${backupPath}-wal`, "");
      writeFileSync(`${backupPath}-shm`, Buffer.alloc(32768));
      const suffixes = ["", "-wal", "-shm"];
      const before = suffixes.map((suffix) => readFileSync(`${backupPath}${suffix}`));
      db.exec("UPDATE recovery_probe SET value = 'current source'");
      let failed = false;
      const fail = () => {
        failed = true;
        throw new Error("injected failure");
      };
      // The old family is preserved by link (sidecars, then base) and its old
      // names released (base, then sidecars) before the new copy is renamed in.
      vi.mocked(linkSync).mockImplementation((from, to) => {
        const source = String(from);
        if (!failed && failure === "base" && source === backupPath) fail();
        // Undo puts the base back last; failing it is a failed rollback.
        if (failure === "rollback" && failed && String(to) === backupPath)
          throw new Error("injected rollback failure");
        actualFs.linkSync(from, to);
      });
      vi.mocked(unlinkSync).mockImplementation((path) => {
        if (!failed && failure === "sidecar" && String(path) === `${backupPath}-shm`) fail();
        actualFs.unlinkSync(path);
      });
      vi.mocked(renameSync).mockImplementation((from, to) => {
        const publishing = String(from).includes(".pending-") && String(to) === backupPath;
        if (!failed && (failure === "publish" || failure === "rollback") && publishing) fail();
        actualFs.renameSync(from, to);
      });
      try {
        expect(() => migrate(db, dbPath)).toThrow(
          /could not preserve and publish.*Recovery action/,
        );
        expect(db.pragma("user_version", { simple: true })).toBe(55);
        expect(db.prepare("SELECT value FROM recovery_probe").get()).toEqual({
          value: "current source",
        });
        if (failure === "rollback") {
          // The base could not be put back: the old name holds only second
          // names of the sidecars, and the whole family sits preserved.
          expect(existsSync(backupPath)).toBe(false);
          const name = readdirSync(directory).find((entry) =>
            /^volli\.db\.backup-v55\.preserved-[\da-f-]+$/.test(entry),
          );
          expect(name).toBeDefined();
          expect(
            suffixes.map((suffix) => readFileSync(join(directory, `${name}${suffix}`))),
          ).toEqual(before);
          // The next attempt resumes: those second names go, nothing else.
          vi.mocked(linkSync).mockImplementation(actualFs.linkSync);
          expect(migrate(db, dbPath)).toBe(true);
          expect(
            suffixes.map((suffix) => readFileSync(join(directory, `${name}${suffix}`))),
          ).toEqual(before);
        } else {
          expect(suffixes.map((suffix) => readFileSync(`${backupPath}${suffix}`))).toEqual(before);
          expect(readdirSync(directory).some((name) => name.includes(".preserved-"))).toBe(false);
          expect(migrate(db, dbPath)).toBe(true);
        }
      } finally {
        db.close();
      }
    },
    // Real migrations plus recovery retries took 4.6s on main's Linux coverage
    // lane before the Session suites moved here; allow their shared-runner load.
    15_000,
  );
});
