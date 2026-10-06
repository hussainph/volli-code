import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runDatabaseRestore, type DatabaseRestoreCommand } from "./database";
import { acquireInstanceLock } from "./instance-lock";

let root: string;
let command: DatabaseRestoreCommand;
let out: string;
let err: string;

function seed(path: string, value: string, schema: number): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE probe (value TEXT); PRAGMA user_version = ${schema}`);
  db.prepare("INSERT INTO probe VALUES (?)").run(value);
  db.close();
}
function restore(): number {
  return runDatabaseRestore(command, {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  });
}
function probe(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT value FROM probe").get() as { value: string }).value;
  } finally {
    db.close();
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hostd-db-restore-"));
  command = {
    kind: "database-restore",
    dataDir: root,
    sourcePath: join(root, "backup"),
    schemaVersion: 59,
    confirmed: true,
  };
  out = "";
  err = "";
  seed(join(root, "volli.db"), "later writes", 60);
  seed(command.sourcePath, "rollback point", 59);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("stopped-host database restore", () => {
  it("keeps the exact old schema and source bytes, preserves later writes, and releases the lock", () => {
    const source = readFileSync(command.sourcePath);
    expect(restore()).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("Restored schema 59.");
    expect(probe(join(root, "volli.db"))).toBe("rollback point");
    const aside = readdirSync(root).find((name) => name.startsWith("rolled-back-"))!;
    expect(probe(join(root, aside, "volli.db"))).toBe("later writes");
    expect(readFileSync(command.sourcePath)).toEqual(source);
    expect(existsSync(join(root, "volli.db.recovery-pending"))).toBe(false);
    const lock = acquireInstanceLock(root);
    lock.release();
  });
  it("reports both preservation directories after retrying an interrupted restore", () => {
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../../packages/host-core/src/db/database-file-crash-child.test-fixture.mjs",
            import.meta.url,
          ),
        ),
        "--restore",
        join(root, "volli.db"),
        command.sourcePath,
        "59",
        "swap:finish",
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const earlier = readdirSync(root).find((name) => name.startsWith("rolled-back-"))!;
    expect(probe(join(root, earlier, "volli.db"))).toBe("later writes");
    expect(probe(join(root, "volli.db"))).toBe("rollback point");
    expect(restore()).toBe(0);
    const current = readdirSync(root).find(
      (name) => name.startsWith("rolled-back-") && name !== earlier,
    )!;
    expect(out).toContain(`This attempt's database family preserved in ${join(root, current)}`);
    expect(out).toContain(
      `earlier interrupted attempt preserved the pre-restore database in ${join(root, earlier)}`,
    );
    expect(out).toContain("Keep every rolled-back-*");
    expect(probe(join(root, earlier, "volli.db"))).toBe("later writes");
    expect(probe(join(root, current, "volli.db"))).toBe("rollback point");
  }, 90_000);
  it("requires --yes before touching anything", () => {
    command.confirmed = false;
    expect(restore()).toBe(1);
    expect(err).toContain("Restoring discards later writes");
    expect(existsSync(join(root, "hostd.lock"))).toBe(false);
  });
  it("refuses a running host, even if its database is idle", () => {
    const lock = acquireInstanceLock(root);
    try {
      expect(restore()).toBe(1);
    } finally {
      lock.release();
    }
    expect(err).toContain("Another volli-hostd is serving");
    expect(probe(join(root, "volli.db"))).toBe("later writes");
  });
  it("reports failures without starting anything and releases the lock", () => {
    command.schemaVersion = 58;
    expect(restore()).toBe(1);
    expect(err).toContain("not at schema 58");
    expect(err).toContain("Keep hostd stopped");
    const lock = acquireInstanceLock(root);
    lock.release();
  });
  it("refuses missing, non-directory and world-writable data directories", () => {
    const file = join(root, "file");
    writeFileSync(file, "");
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    for (const dir of [join(root, "missing"), file, open]) {
      command.dataDir = dir;
      expect(restore()).toBe(1);
      expect(existsSync(join(dir, "hostd.lock"))).toBe(false);
    }
  });
  it("requires the data directory's owner", () => {
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(restore()).toBe(1);
    expect(err).toContain("Run as the service user");
  });
});
