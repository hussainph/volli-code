/**
 * One host per data directory, for the host's whole life.
 *
 * Two hosts on one database would each believe it is the authority, so the
 * second must be refused even when it was given a different `--socket` and
 * started in the same instant as the first. A status file or a socket probe
 * cannot promise that (both are check-then-act). This holds an exclusive
 * SQLite lock on `<dataDir>/hostd.lock` instead: SQLite's file locks are
 * atomic, are refused at once rather than waited on (`busy_timeout = 0`), and
 * are released by the kernel when the process dies, so a crash never leaves a
 * stale lock behind. It is the same mechanism host-core's own open lock uses
 * (`db/open-lock.ts`), held for the process lifetime rather than for boot.
 */
import { join } from "node:path";

import Database from "better-sqlite3";

import { HostdBootError } from "./boot-error";

export const LOCK_FILE_NAME = "hostd.lock";

export interface InstanceLock {
  /** Gives the lock up. Idempotent. Process exit gives it up too. */
  release(): void;
}

export function acquireInstanceLock(dataDir: string): InstanceLock {
  const path = join(dataDir, LOCK_FILE_NAME);
  let lock: Database.Database | undefined;
  try {
    lock = new Database(path);
    lock.pragma("busy_timeout = 0");
    lock.exec(
      "CREATE TABLE IF NOT EXISTS hostd_instance (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE",
    );
  } catch (error) {
    lock?.close();
    const code = (error as { code?: unknown }).code;
    throw code === "SQLITE_BUSY"
      ? new HostdBootError(
          "already-running",
          `Another volli-hostd is serving ${dataDir}: its instance lock ${path} is held.`,
          { lockPath: path },
        )
      : new HostdBootError(
          "data-dir",
          `Could not take the instance lock ${path}: ${(error as Error).message}`,
          { lockPath: path },
        );
  }
  const held = lock;
  return {
    release() {
      // Closing with the transaction open rolls it back and drops the lock.
      if (held.open) held.close();
    },
  };
}
