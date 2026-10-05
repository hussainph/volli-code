/**
 * The credential lock: one kernel advisory exclusive lock that every
 * locking-aware process sharing a data directory takes before it reads a
 * sealed credential file for use or changes one (VC-642;
 * `docs/plans/sealed-credential-store.md` §6).
 *
 * Desktop, hostd and `volli-hostd credentials` may share one store. An atomic
 * rename keeps a sealed file whole, but it does not stop two processes that
 * each loaded generation A from overwriting each other's change. So every
 * read-for-use and read-modify-write holds this lock, reloads what is on disk
 * and applies only its own scoped change (`sealed-document.ts`).
 *
 * MECHANISM. The lock is SQLite's own file lock on a stable, empty sibling
 * `host-credentials.lock`: `BEGIN EXCLUSIVE` on a connection that never writes,
 * keeps its journal in memory and is released by `ROLLBACK`, so the file stays
 * zero bytes and no `-journal` sibling is ever made, even by a crash. It is the mechanism `db/open-lock.ts` and hostd's instance
 * lock already use, so it adds no native dependency to either host. On Linux
 * and macOS SQLite's unix VFS takes POSIX `fcntl` record locks, which:
 *
 * - are kernel locks, released when the holding process dies, so a crash never
 *   leaves a stale lock and no lock is ever stolen by age or PID;
 * - lock the inode, not the name, so two spellings of one data directory (a
 *   symlinked path, say) still meet at one lock;
 * - are not inherited by a child process, and SQLite opens the file
 *   close-on-exec, so a Session's commands never hold or keep it;
 * - are shared between connections of one process by SQLite itself, so two
 *   `CredentialLock`s on one file in one process still exclude each other.
 *
 * `fcntl` drops every lock a process holds on a file when the process closes
 * ANY descriptor to it. Nothing here opens the lock file except to create it
 * (`O_EXCL`, which never opens an existing file); nothing else may open it.
 * The ciphertext is never the locked file: a rename replaces its inode.
 *
 * Advisory: it binds only processes that take it. An older build, or a
 * malicious process running as the same user, ignores it. Stop older
 * processes before an upgrade (§6).
 *
 * WAITING. {@link CredentialLock.withSync} waits a bounded time in SQLite's
 * busy handler, for critical sections that never await: the JS thread is not
 * needed to release a lock another process holds, and this process never holds
 * it across a tick while such a section runs, because one that finds it held
 * here refuses at once rather than wait on itself. {@link CredentialLock.with}
 * is the asynchronous form, for work that must await: a process-wide FIFO
 * queue, then a polled, non-blocking attempt, both bounded by one deadline.
 * Neither waits forever; a timeout is {@link CredentialLockBusyError}.
 */
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";

import { SealedStoreUnreadableError } from "./credential-state";

/** The lock file's name, beside the sealed files it guards. */
export const CREDENTIAL_LOCK_FILE_NAME = "host-credentials.lock";

/** A synchronous critical section's longest wait for another process. */
export const CREDENTIAL_LOCK_SYNC_TIMEOUT_MS = 2_000;
/** An asynchronous holder's longest wait, queue included. */
export const CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS = 10_000;

/** Between non-blocking attempts while another process holds the lock. */
const POLL_MS = [5, 10, 25, 50, 100];

/** Another holder kept the lock past the wait. Nothing was read or changed. */
export class CredentialLockBusyError extends Error {
  readonly code = "credential-lock-busy";
  constructor() {
    super("Saved credentials are busy in another Volli process. Try again.");
    this.name = "CredentialLockBusyError";
  }
}

/**
 * The lock file could not be made or opened. Never carries a path or a
 * cause. Saved credentials cannot be read safely, so it is an unreadable
 * store: credentials `locked` (`store-unreadable`).
 */
export class CredentialLockUnavailableError extends SealedStoreUnreadableError {
  readonly code = "credential-lock-unavailable";
  constructor() {
    super();
    this.message = "Could not take the lock on saved credentials.";
    this.name = "CredentialLockUnavailableError";
  }
}

interface Holder {
  database: Database.Database | null;
  /** Whether {@link database} keeps its rollback journal in memory yet. */
  configured: boolean;
  /** Held, or reserved by an asynchronous acquirer, in this process. */
  held: boolean;
  readonly waiters: Array<() => void>;
}

/** One connection per lock path per process; SQLite shares the inode's lock state. */
const holders = new Map<string, Holder>();

/** The credential lock for the sealed file at `file`: its sibling lock file. */
export function credentialLockFor(file: string): CredentialLock {
  return new CredentialLock(join(dirname(file), CREDENTIAL_LOCK_FILE_NAME));
}

export class CredentialLock {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /**
   * Runs `fn` holding the lock. `fn` must not await: the lock is released
   * when it returns. Refuses at once when this process already holds the lock,
   * as a nested call or an asynchronous holder, since waiting would block the
   * thread that has to release it.
   */
  withSync<T>(fn: () => T, timeoutMs: number = CREDENTIAL_LOCK_SYNC_TIMEOUT_MS): T {
    const holder = this.#holder();
    if (holder.held) throw new CredentialLockBusyError();
    const database = open(this.path, holder);
    database.pragma(`busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    begin(holder, database);
    holder.held = true;
    try {
      return fn();
    } finally {
      release(holder);
    }
  }

  /** Runs `fn`, which may await, holding the lock. Waits in turn, bounded. */
  async with<T>(
    fn: () => Promise<T> | T,
    timeoutMs: number = CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS,
  ): Promise<T> {
    const holder = this.#holder();
    const deadline = Date.now() + timeoutMs;
    // Reserved in this process from here: a synchronous caller refuses.
    await turn(holder, deadline);
    try {
      const database = open(this.path, holder);
      database.pragma("busy_timeout = 0");
      for (let attempt = 0; ; attempt += 1) {
        try {
          begin(holder, database);
          break;
        } catch (error) {
          const wait = Math.min(
            POLL_MS[Math.min(attempt, POLL_MS.length - 1)]!,
            deadline - Date.now(),
          );
          if (!(error instanceof CredentialLockBusyError) || wait <= 0) throw error;
          await new Promise((settle) => setTimeout(settle, wait));
        }
      }
    } catch (error) {
      vacate(holder);
      throw error;
    }
    try {
      return await fn();
    } finally {
      release(holder);
    }
  }

  /** Closes this process's connection to the lock file, if it is not held. */
  close(): void {
    const holder = holders.get(this.path);
    if (holder === undefined || holder.held) return;
    holder.database?.close();
    holder.database = null;
    holder.configured = false;
  }

  #holder(): Holder {
    let holder = holders.get(this.path);
    if (holder === undefined) {
      holder = { database: null, configured: false, held: false, waiters: [] };
      holders.set(this.path, holder);
    }
    return holder;
  }
}

/** Reserves the lock in this process for the caller, in arrival order. */
function turn(holder: Holder, deadline: number): Promise<void> {
  if (!holder.held) {
    holder.held = true;
    return Promise.resolve();
  }
  return new Promise((settle, refuse) => {
    const wake = () => {
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(
      () => {
        holder.waiters.splice(holder.waiters.indexOf(wake), 1);
        refuse(new CredentialLockBusyError());
      },
      Math.max(0, deadline - Date.now()),
    );
    holder.waiters.push(wake);
  });
}

/** Gives the reservation up, handing it to the next waiter in this process, if any. */
function vacate(holder: Holder): void {
  const wake = holder.waiters.shift();
  holder.held = wake !== undefined;
  wake?.();
}

function release(holder: Holder): void {
  try {
    holder.database!.exec("ROLLBACK");
  } catch {
    // Closing the connection is what drops the kernel lock for certain.
    holder.database!.close();
    holder.database = null;
    holder.configured = false;
  }
  vacate(holder);
}

function begin(holder: Holder, database: Database.Database): void {
  try {
    // An in-memory journal: holding the lock never makes a `-journal` file a
    // crash could leave behind, and a read-only directory can still lock.
    // Setting it reads the file, so it waits on another holder like BEGIN.
    if (!holder.configured) {
      database.pragma("journal_mode = MEMORY");
      holder.configured = true;
    }
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    if ((error as { code?: unknown }).code === "SQLITE_BUSY") throw new CredentialLockBusyError();
    // eslint-disable-next-line preserve-caught-error -- never a path or a SQLite message
    throw new CredentialLockUnavailableError();
  }
}

/** This process's connection to the lock file, made (0600, never through a symlink) once. */
function open(path: string, holder: Holder): Database.Database {
  if (holder.database !== null) return holder.database;
  try {
    create(path);
    holder.database = new Database(path, { fileMustExist: true });
    return holder.database;
  } catch {
    throw new CredentialLockUnavailableError();
  }
}

/** Creates the empty lock file, or checks the one that is there is a regular file. */
function create(path: string): void {
  try {
    // O_EXCL never opens an existing file, so this cannot drop a lock held here.
    closeSync(
      openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    // There already, made by another process or an earlier launch: the same lock.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(path).isFile()) throw new Error("not a regular file", { cause: error });
  }
}
