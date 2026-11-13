import Database from "better-sqlite3";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  checkedDatabaseFile,
  isCheckedDatabaseFile,
  type CheckedDatabaseFile,
} from "./checked-file";

let directory: string | undefined;
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function closedDatabase(): string {
  directory = mkdtempSync(join(tmpdir(), "volli-checked-file-"));
  const path = join(directory, "volli.db");
  const db = new Database(path);
  db.exec("CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('x')");
  db.close();
  return path;
}

describe("checked database file identity", () => {
  it("matches the same untouched file", () => {
    const path = closedDatabase();
    const checked = checkedDatabaseFile(path)!;
    expect(isCheckedDatabaseFile(path, checked)).toBe(true);
  });

  it.each(["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)(
    "refuses an identity whose %s differs",
    (field) => {
      const path = closedDatabase();
      const checked = checkedDatabaseFile(path)!;
      const other: CheckedDatabaseFile = { ...checked, [field]: `${checked[field]}1` };
      expect(isCheckedDatabaseFile(path, other)).toBe(false);
    },
  );

  it("refuses a file written, restamped or replaced since", () => {
    const path = closedDatabase();
    const checked = checkedDatabaseFile(path)!;
    // Restamping writes no bytes, but moves the ctime (and here the mtime).
    const stamp = new Date(Number(BigInt(checked.mtimeNs) / 1_000_000n));
    utimesSync(path, stamp, stamp);
    expect(isCheckedDatabaseFile(path, checked)).toBe(false);

    const again = checkedDatabaseFile(path)!;
    copyFileSync(path, `${path}.other`);
    renameSync(`${path}.other`, path);
    expect(isCheckedDatabaseFile(path, again)).toBe(false);
  });

  it("has no identity with WAL frames beside it, and throws when the file is gone", () => {
    const path = closedDatabase();
    const checked = checkedDatabaseFile(path)!;
    writeFileSync(`${path}-wal`, "frames");
    expect(checkedDatabaseFile(path)).toBeNull();
    expect(isCheckedDatabaseFile(path, checked)).toBe(false);
    rmSync(path);
    rmSync(`${path}-wal`);
    expect(() => isCheckedDatabaseFile(path, checked)).toThrow();
  });
});
