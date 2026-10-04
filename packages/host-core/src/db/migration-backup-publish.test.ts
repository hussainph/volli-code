import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let directory: string;
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(actualFs.renameSync);
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
      vi.mocked(renameSync).mockImplementation((from, to) => {
        const path = String(from);
        const destination = String(to);
        const shouldFail =
          failure === "base"
            ? path === backupPath
            : failure === "sidecar"
              ? path === `${backupPath}-shm`
              : path.includes(".pending-") && destination === backupPath;
        if (!failed && shouldFail) {
          failed = true;
          throw new Error("injected rename failure");
        }
        if (failure === "rollback" && failed && destination === `${backupPath}-shm`)
          throw new Error("injected rollback failure");
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
          expect(existsSync(backupPath)).toBe(false);
          const name = readdirSync(directory).find((entry) =>
            /^volli\.db\.backup-v55\.preserved-[\da-f-]+$/.test(entry),
          );
          expect(name).toBeDefined();
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
