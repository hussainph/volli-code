import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { verifyMigrationBackup } from "./backup-integrity";
import { openRawDb } from "./test-helpers";

let directory: string;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function backupPath(): string {
  directory = mkdtempSync(join(tmpdir(), "volli-backup-integrity-test-"));
  return join(directory, "volli.db.backup-v51");
}

describe("verifyMigrationBackup", () => {
  it("does not create a missing copy", () => {
    const path = backupPath();
    expect(() => verifyMigrationBackup(path)).toThrow(/ENOENT/);
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an empty copy rather than treating it as a fresh SQLite database", () => {
    const path = backupPath();
    writeFileSync(path, "");
    expect(() => verifyMigrationBackup(path)).toThrow(/non-empty regular file/);
  });

  it.each(["", "-wal", "-shm", "-journal"])(
    "never follows a linked backup or sidecar (%s)",
    (suffix) => {
      const path = backupPath();
      const target = join(directory, "untouched.db");
      writeFileSync(target, "evidence");
      if (suffix) {
        const db = openRawDb(path);
        db.exec("CREATE TABLE evidence (value TEXT)");
        db.close();
      }
      symlinkSync(target, `${path}${suffix}`);
      expect(() => verifyMigrationBackup(path)).toThrow(/regular file/);
    },
  );
});
