import Database from "better-sqlite3";
import {
  chmodSync,
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

import { credentialStatusFor } from "./credential-state";
import {
  CREDENTIAL_LOCK_FILE_NAME,
  CredentialLock,
  CredentialLockBusyError,
  credentialLockFor,
  CredentialLockUnusableError,
  retryWhileBusy,
} from "./credential-lock";
import { startChild } from "./test-support/processes";

const faults = vi.hoisted(() => ({
  /** Report this inode for the next `lstat` calls, as if the file were swapped. */
  lstatIno: [] as number[],
  /** Make `ftruncate` do nothing. */
  keepJunk: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args)!;
      const ino = faults.lstatIno.shift();
      if (ino === -1) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return ino === undefined ? stat : Object.assign(Object.create(stat), { ino });
    },
    ftruncateSync: (...args: Parameters<typeof actual.ftruncateSync>) =>
      faults.keepJunk ? undefined : actual.ftruncateSync(...args),
  };
});

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
  faults.lstatIno = [];
  faults.keepJunk = false;
  vi.restoreAllMocks();
  for (const lock of locks.splice(0)) lock.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("credential lock in one process", { timeout: 30_000 }, () => {
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
      expect(() => other.withSync(() => 0)).toThrow(CredentialLockBusyError);
    });
    let open!: () => void;
    const holding = lock.with(() => new Promise<void>((settle) => (open = settle)));
    await expect(other.with(() => 0, 40)).rejects.toThrow(CredentialLockBusyError);
    open();
    await holding;
    expect(await other.with(() => "through the alias")).toBe("through the alias");
  });

  it("refuses a lock path that is a symlink or not a file as an unusable lock file, never as the store", () => {
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
      expect(error).toBeInstanceOf(CredentialLockUnusableError);
      // The operator's sentence names the file and the fix; the status only the reason.
      expect(error!.message).toContain(join(dir, name));
      expect(error!.message).toContain("Move it aside");
      expect(credentialStatusFor(error)).toMatchObject({
        state: "locked",
        reason: "lock-unusable",
      });
    }
    expect(() => lockAt(join(dir, "missing", "x.lock")).withSync(() => 0)).toThrow(
      CredentialLockUnusableError,
    );
  });

  it("refuses another user's lock file", () => {
    const lock = lockAt();
    lock.withSync(() => 0);
    lock.close();
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => lock.withSync(() => 0)).toThrow(/belongs to uid/);
  });

  it("empties our own lock file in place when it holds junk, keeping its inode", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "this is not a lock file at all, just junk bytes", { mode: 0o600 });
    const before = lstatSync(path);
    expect(lockAt(path).withSync(() => "repaired")).toBe("repaired");
    const after = lstatSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(0);
  });

  it("is unusable when emptying junk does not help, or the file was swapped meanwhile", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "junk junk junk junk junk junk junk junk junk junk", { mode: 0o600 });
    faults.keepJunk = true;
    expect(() => lockAt(path).withSync(() => 0)).toThrow(/could not be locked/);
    faults.keepJunk = false;
    // Before, after: the same (fake) inode, so it reaches the emptying, which sees the real one.
    faults.lstatIno = [1, 1];
    expect(() => lockAt(path).withSync(() => 0)).toThrow(/could not be emptied/);
  });

  it("is unusable when the lock file vanishes as it is checked", () => {
    faults.lstatIno = [-1];
    expect(() => lockAt().withSync(() => 0)).toThrow(/could not be read \(ENOENT\)/);
  });

  it("treats a lock file swapped while it was being opened as busy", () => {
    faults.lstatIno = [1, 2];
    expect(() => lockAt().withSync(() => 0)).toThrow(CredentialLockBusyError);
    expect(lockAt().withSync(() => "then fine")).toBe("then fine");
  });

  it.skipIf(process.getuid?.() === 0)("is unusable when SQLite cannot open it", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "", { mode: 0o000 });
    try {
      expect(() => lockAt(path).withSync(() => 0)).toThrow(/could not be opened/);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("is unusable when junk cannot be emptied", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "junk junk junk junk junk junk junk junk junk junk", { mode: 0o600 });
    if (process.getuid!() === 0) return;
    chmodSync(path, 0o400);
    try {
      expect(() => lockAt(path).withSync(() => 0)).toThrow(CredentialLockUnusableError);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("refuses asynchronously when the lock cannot be opened, and releases the queue", async () => {
    const lock = lockAt(join(dir, "missing", "x.lock"));
    await expect(lock.with(() => 0)).rejects.toThrow(CredentialLockUnusableError);
    await expect(lock.with(() => 0)).rejects.toThrow(CredentialLockUnusableError);
  });

  it("joins a lock file another process created first", () => {
    const path = join(dir, CREDENTIAL_LOCK_FILE_NAME);
    writeFileSync(path, "", { mode: 0o600 });
    expect(lockAt(path).withSync(() => "joined")).toBe("joined");
  });

  it("maps a SQLite failure other than busy to an unusable lock file", () => {
    const lock = lockAt();
    lock.withSync(() => 0);
    vi.spyOn(Database.prototype, "exec").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    });
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockUnusableError);
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

// Each test starts real `node` children; a loaded machine starts them slowly.
describe("credential lock across processes", { timeout: 30_000 }, () => {
  it("excludes another process until it releases, and an async waiter then gets it", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path, ms: 300 });
    expect(await child.next()).toEqual({ held: true });
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
    await expect(lock.with(() => 0, 30)).rejects.toThrow(CredentialLockBusyError);
    const started = Date.now();
    expect(await lock.with(() => "mine", 5_000)).toBe("mine");
    expect(Date.now() - started).toBeGreaterThan(50);
    expect(await child.next()).toEqual({ released: true });
  });

  it("leaves no journal beside the lock while held, and locks in a read-only directory", async () => {
    const lock = lockAt();
    lock.withSync(() => 0);
    const child = startChild({ kind: "hold", lock: lock.path });
    try {
      await child.next();
      expect(readdirSync(dir)).toEqual([CREDENTIAL_LOCK_FILE_NAME]);
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(readdirSync(dir)).toEqual([CREDENTIAL_LOCK_FILE_NAME]);
    if (process.getuid!() === 0) return;
    chmodSync(dir, 0o500);
    try {
      // A fresh connection, configured while the directory is read-only.
      lock.close();
      expect(lock.withSync(() => 1)).toBe(1);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("never waits synchronously: refuses at once, and retries only asynchronously", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path, ms: 300 });
    await child.next();
    const started = performance.now();
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
    expect(performance.now() - started).toBeLessThan(100);
    // The thread stays free while a caller that can wait retries.
    let ticked = false;
    setTimeout(() => (ticked = true), 10);
    const result = retryWhileBusy(
      () =>
        lock.withSync(() => {
          expect(ticked).toBe(true);
          return "after the hold";
        }),
      5_000,
    );
    expect(await result).toBe("after the hold");
    await child.exited;
    // Bounded: a hold longer than the wait is the busy refusal, and other errors are not retried.
    const holding = startChild({ kind: "hold", lock: lock.path });
    try {
      await holding.next();
      await expect(retryWhileBusy(() => lock.withSync(() => 0), 30)).rejects.toThrow(
        CredentialLockBusyError,
      );
      await expect(
        retryWhileBusy(() => {
          throw new Error("other");
        }, 1_000),
      ).rejects.toThrow("other");
    } finally {
      holding.process.kill("SIGKILL");
      await holding.exited;
    }
  });

  it("follows a lock file that was unlinked and recreated, so no two processes split", async () => {
    const lock = lockAt();
    lock.withSync(() => 0); // This process has the old inode open.
    rmSync(lock.path);
    writeFileSync(lock.path, "", { mode: 0o600 });
    const child = startChild({ kind: "hold", lock: lock.path });
    try {
      await child.next();
      // Locking the old inode would succeed; the identity check sends it to the new one.
      expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(lock.withSync(() => "the new file")).toBe("the new file");
    // Removed while held here: the next acquisition makes and uses a new one.
    lock.withSync(() => rmSync(lock.path));
    expect(lock.withSync(() => "made again")).toBe("made again");
    expect(lstatSync(lock.path).isFile()).toBe(true);
  });

  it("treats a lock file replaced on every attempt as busy", () => {
    const lock = lockAt();
    const exec = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(
      function (this: Database.Database, sql) {
        const result = exec.call(this, sql);
        if (sql === "BEGIN EXCLUSIVE") {
          rmSync(lock.path);
          writeFileSync(lock.path, "", { mode: 0o600 });
        }
        return result;
      },
    );
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
  });

  it("is released by the kernel when the holder is killed, never stolen", async () => {
    const lock = lockAt();
    const child = startChild({ kind: "hold", lock: lock.path });
    await child.next();
    expect(() => lock.withSync(() => 0)).toThrow(CredentialLockBusyError);
    child.process.kill("SIGKILL");
    expect((await child.exited).signal).toBe("SIGKILL");
    expect(await retryWhileBusy(() => lock.withSync(() => "after the crash"), 1_000)).toBe(
      "after the crash",
    );
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
      expect(await retryWhileBusy(() => lock.withSync(() => "free"), 1_000)).toBe("free");
    } finally {
      process.kill(sleeper, "SIGKILL");
    }
  });
});
