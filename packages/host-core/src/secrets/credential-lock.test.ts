import Database from "better-sqlite3";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SealedStoreUnreadableError } from "./credential-state";
import {
  CREDENTIAL_LOCK_FILE_NAME,
  CredentialLock,
  CredentialLockBusyError,
  credentialLockFor,
  CredentialLockUnavailableError,
} from "./credential-lock";
import { startChild } from "./test-support/processes";

let dir: string;
const locks: CredentialLock[] = [];
function lockAt(path = join(dir, CREDENTIAL_LOCK_FILE_NAME)): CredentialLock {
  const lock = new CredentialLock(path);
  locks.push(lock);
  return lock;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-credential-lock-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of locks.splice(0)) lock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("credential lock in one process", () => {
  it("creates an empty 0600 lock file beside the sealed file, and never writes it", () => {
    const lock = credentialLockFor(join(dir, "host-credentials.enc"));
    locks.push(lock);
    expect(lock.path).toBe(join(dir, CREDENTIAL_LOCK_FILE_NAME));
    expect(lock.withSync(() => 42)).toBe(42);
    expect(lock.withSync(() => "again")).toBe("again");
    const stat = lstatSync(lock.path);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(0);
    // No journal or other sibling: ROLLBACK of a transaction that never wrote.
    expect(readdirSync(dir)).toEqual([CREDENTIAL_LOCK_FILE_NAME]);
  });

  it("refuses a nested synchronous hold rather than wait on itself", () => {
    const lock = lockAt();
    expect(() => lock.withSync(() => lockAt().withSync(() => 1))).toThrow(CredentialLockBusyError);
    // Released after the refusal and after a throw.
    expect(() =>
      lock.withSync(() => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(lock.withSync(() => "free")).toBe("free");
  });

  it("queues asynchronous holders in order, and refuses a synchronous one meanwhile", async () => {
    const lock = lockAt();
    const order: string[] = [];
    let open!: () => void;
    const first = lock.with(async () => {
      order.push("first");
      await new Promise<void>((settle) => (open = settle));
      expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
      order.push("first done");
    });
    const second = lock.with(() => {
      order.push("second");
      return "second";
    });
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    open();
    await first;
    expect(await second).toBe("second");
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("gives up a queued wait at its deadline and keeps the queue moving", async () => {
    const lock = lockAt();
    let open!: () => void;
    const holder = lock.with(() => new Promise<void>((settle) => (open = settle)));
    await expect(lock.with(() => "late", 20)).rejects.toThrow(CredentialLockBusyError);
    const after = lock.with(() => "after");
    open();
    await holder;
    expect(await after).toBe("after");
  });

  it("excludes a second connection to the same file through another path", async () => {
    const alias = join(dir, "alias");
    symlinkSync(dir, alias);
    const lock = lockAt();
    const other = lockAt(join(alias, CREDENTIAL_LOCK_FILE_NAME));
    expect(other.path).not.toBe(lock.path);
    lock.withSync(() => {
      // SQLite shares the inode's lock between connections of one process.
      expect(() => other.withSync(() => 0, 0)).toThrow(CredentialLockBusyError);
    });
    let open!: () => void;
    const holding = lock.with(() => new Promise<void>((settle) => (open = settle)));
    await expect(other.with(() => 0, 40)).rejects.toThrow(CredentialLockBusyError);
    open();
    await holding;
    expect(await other.with(() => "through the alias")).toBe("through the alias");
  });

  it("refuses a lock path that is a symlink or not a file, as unreadable credentials", () => {
    writeFileSync(join(dir, "elsewhere"), "");
    symlinkSync(join(dir, "elsewhere"), join(dir, "link.lock"));
    mkdirSync(join(dir, "dir.lock"));
    for (const name of ["link.lock", "dir.lock"]) {
      const error = (() => {
        try {
          lockAt(join(dir, name)).withSync(() => 0);
        } catch (caught) {
          return caught as Error;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(CredentialLockUnavailableError);
      expect(error).toBeInstanceOf(SealedStoreUnreadableError);
      expect(error!.message).not.toContain(dir);
    }
    expect(() => lockAt(join(dir, "missing", "x.lock")).withSync(() => 0)).toThrow(
      CredentialLockUnavailableError,
    );
  });

  it("refuses asynchronously when the lock cannot be opened, and releases the queue", async () => {
    const lock = lockAt(join(dir, "missing", "x.lock"));
    await expect(lock.with(() => 0)).rejects.toThrow(CredentialLockUnavailableError);
    await expect(lock.with(() => 0)).rejects.toThrow(CredentialLockUnavailableError);
  });

  it("joins a lock file another process created first", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "", { mode: 0o600 });
    expect(lockAt(path).withSync(() => "joined")).toBe("joined");
  });

  it("maps a SQLite failure other than busy to unavailable", () => {
    const lock = lockAt();
    lock.withSync(() => 0);
    vi.spyOn(Database.prototype, "exec").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    });
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockUnavailableError);
  });

  it("closes the connection when ROLLBACK fails, so the kernel lock still drops", async () => {
    const lock = lockAt();
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(
      function (this: Database.Database, sql) {
        if (sql === "ROLLBACK") throw new Error("no transaction");
        return exec.call(this, sql);
      },
    );
    lock.withSync(() => 0);
    vi.restoreAllMocks();
    // A fresh connection, and another process can take it.
    expect(lock.withSync(() => "reopened")).toBe("reopened");
    const child = startChild({ kind: "hold", lock: lock.path, ms: 0 });
    expect(await child.next()).toEqual({ held: true });
    await child.exited;
  });

  it("does nothing on close while held, and closes after", () => {
    const lock = lockAt();
    lock.withSync(() => lock.close());
    lock.close();
    lock.close();
    expect(lock.withSync(() => "reopened")).toBe("reopened");
  });
});

describe("credential lock across processes", () => {
  it("excludes another process until it releases, and an async waiter then gets it", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path, ms: 300 });
    expect(await child.next()).toEqual({ held: true });
    expect(() => lock.withSync(() => 0, 20)).toThrow(CredentialLockBusyError);
    await expect(lock.with(() => 0, 30)).rejects.toThrow(CredentialLockBusyError);
    const started = Date.now();
    expect(await lock.with(() => "mine", 5_000)).toBe("mine");
    expect(Date.now() - started).toBeGreaterThan(50);
    expect(await child.next()).toEqual({ released: true });
  });

  it("waits synchronously, bounded, for a short hold in another process", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path, ms: 150 });
    await child.next();
    expect(lock.withSync(() => "after the hold", 5_000)).toBe("after the hold");
    await child.exited;
  });

  it("is released by the kernel when the holder is killed, never stolen", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path });
    await child.next();
    expect(() => lock.withSync(() => 0, 50)).toThrow(CredentialLockBusyError);
    child.process.kill("SIGKILL");
    expect((await child.exited).signal).toBe("SIGKILL");
    expect(lock.withSync(() => "after the crash", 1_000)).toBe("after the crash");
  });

  it("is not kept by a process the holder started", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path, sleeper: true });
    const { sleeper } = (await child.next()) as { sleeper: number };
    try {
      child.process.kill("SIGKILL");
      await child.exited;
      // The holder's own child still runs, and holds nothing.
      expect(() => process.kill(sleeper, 0)).not.toThrow();
      expect(lock.withSync(() => "free", 1_000)).toBe("free");
    } finally {
      process.kill(sleeper, "SIGKILL");
    }
  });
});
