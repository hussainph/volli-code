import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { acquireDatabaseOpenLock } from "./open-lock";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function dbPath(): string {
  directory = mkdtempSync(join(tmpdir(), "volli-open-lock-"));
  return join(directory, "volli.db");
}

describe("the database open lock", () => {
  it("keeps the production 5000 ms default", () => {
    const lock = acquireDatabaseOpenLock(dbPath());
    try {
      expect(lock.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(lock.inTransaction).toBe(true);
    } finally {
      lock.close();
    }
  });

  it("injects a no-wait refusal, closes the failed contender and allows a later acquisition", () => {
    const path = dbPath();
    const lock = acquireDatabaseOpenLock(path, 0);
    try {
      expect(lock.pragma("busy_timeout", { simple: true })).toBe(0);
      expect(() => acquireDatabaseOpenLock(path, 0)).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
    } finally {
      lock.close();
    }
    const next = acquireDatabaseOpenLock(path, 7);
    try {
      expect(next.pragma("busy_timeout", { simple: true })).toBe(7);
      expect(next.inTransaction).toBe(true);
    } finally {
      next.close();
    }
  });

  it("refuses a non-file lock path before opening SQLite", () => {
    const path = dbPath();
    mkdirSync(`${path}.open-lock`);
    expect(() => acquireDatabaseOpenLock(path, 0)).toThrow(
      "The database opening lock is not a regular file.",
    );
  });
});
