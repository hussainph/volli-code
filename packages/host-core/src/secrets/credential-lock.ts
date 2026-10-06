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
 * NEVER A SYNCHRONOUS WAIT. {@link CredentialLock.withSync} tries once,
 * without SQLite's busy handler, and refuses at once with
 * {@link CredentialLockBusyError} when another process (or this one) holds
 * the lock: it runs on Electron's main thread, which must never stall on
 * another process. A caller that can wait retries asynchronously, between
 * attempts, never holding the lock across an await
 * (`retryWhileBusy`). {@link CredentialLock.with} is the asynchronous holder,
 * for work that must await while holding: a process-wide FIFO queue, then
 * polled non-blocking attempts, bounded by one deadline.
 *
 * ONE LOCK FILE. Each acquisition checks that the inode it locked is still the
 * one at the path (`dev`, `ino`), and starts again on the new one if the file
 * was unlinked and recreated, so processes cannot stay split across two
 * inodes. A lock file that is a symlink, not a regular file or another user's
 * is {@link CredentialLockUnusableError}: credentials `locked`
 * (`lock-unusable`), with a sentence naming the file and the fix, and never a
 * reason to reset the store it guards. One of ours that is merely not empty
 * (it should always be) is emptied in place, which keeps its inode.
 */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import Database from "better-sqlite3";

import { CredentialLockUnusableError } from "./credential-state";

export { CredentialLockUnusableError } from "./credential-state";

/** The lock file's name, beside the sealed files it guards. */
export const CREDENTIAL_LOCK_FILE_NAME = "host-credentials.lock";

/** An asynchronous holder's longest wait, queue included. */
export const CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS = 10_000;

/** Between non-blocking attempts while another process holds the lock. */
const POLL_MS = [5, 10, 25, 50, 100];

/** Another holder has the lock now. Nothing was read or changed. */
export class CredentialLockBusyError extends Error {
  readonly code = "credential-lock-busy";
  constructor() {
    super("Saved credentials are busy in another Volli process. Try again.");
    this.name = "CredentialLockBusyError";
  }
}

interface Holder {
  database: Database.Database | null;
  /** The inode {@link database} opened, checked against the path on every acquisition. */
  identity: { dev: number; ino: number } | null;
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

/**
 * Runs `attempt`, which takes the lock synchronously and so may throw
 * {@link CredentialLockBusyError}, again after short asynchronous pauses until
 * it stops being busy or `timeoutMs` passes. The thread is free between
 * attempts and the lock is never held across one. The last busy refusal
 * reaches the caller.
 */
export async function retryWhileBusy<T>(
  attempt: () => T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (let tries = 0; ; tries += 1) {
    signal?.throwIfAborted();
    try {
      return attempt();
    } catch (error) {
      const wait = Math.min(POLL_MS[Math.min(tries, POLL_MS.length - 1)]!, deadline - Date.now());
      if (!(error instanceof CredentialLockBusyError) || wait <= 0) throw error;
      await pause(wait, undefined, { signal });
    }
  }
}

export class CredentialLock {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  /**
   * Runs `fn` holding the lock, or refuses at once with
   * {@link CredentialLockBusyError}: it never waits. `fn` must not await; the
   * lock is released when it returns.
   */
  withSync<T>(fn: () => T): T {
    const holder = this.#holder();
    if (holder.held) throw new CredentialLockBusyError();
    acquire(this.path, holder);
    holder.held = true;
    try {
      return fn();
    } finally {
      release(holder);
    }
  }

  /** Runs `fn`, which may await, holding the lock. Waits in turn, asynchronously, bounded. */
  async with<T>(
    fn: () => Promise<T> | T,
    timeoutMs: number = CREDENTIAL_LOCK_ASYNC_TIMEOUT_MS,
  ): Promise<T> {
    const holder = this.#holder();
    const deadline = Date.now() + timeoutMs;
    // Reserved in this process from here: a synchronous caller refuses.
    await turn(holder, deadline);
    try {
      await retryWhileBusy(() => acquire(this.path, holder), Math.max(0, deadline - Date.now()));
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
    disconnect(holder);
  }

  #holder(): Holder {
    let holder = holders.get(this.path);
    if (holder === undefined) {
      holder = { database: null, identity: null, held: false, waiters: [] };
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
    disconnect(holder);
  }
  vacate(holder);
}

function disconnect(holder: Holder): void {
  holder.database?.close();
  holder.database = null;
  holder.identity = null;
}

/**
 * One non-blocking attempt at the kernel lock. Locks the inode, then checks
 * it is still the one at the path; when the file was replaced, lets that one
 * go and tries the current file, once.
 */
function acquire(path: string, holder: Holder): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const database = connect(path, holder);
    begin(path, database);
    let current: Stats;
    try {
      // `lstat`: the lock file is never a symlink (connect refuses one).
      current = lstatSync(path);
    } catch {
      current = { dev: -1, ino: -1 } as Stats;
    }
    if (current.dev === holder.identity!.dev && current.ino === holder.identity!.ino) return;
    database.exec("ROLLBACK");
    disconnect(holder);
  }
  // The file keeps changing under us: treat it as held.
  throw new CredentialLockBusyError();
}

function begin(path: string, database: Database.Database): void {
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    throw sqliteFailure(path, error);
  }
}

function sqliteFailure(path: string, error: unknown): Error {
  const code = (error as { code?: unknown }).code;
  if (code === "SQLITE_BUSY") return new CredentialLockBusyError();
  return unusable(path, `could not be locked (${String(code)})`);
}

/**
 * This process's connection to the lock file: made (0600, never through a
 * symlink) when absent, checked to be this user's regular file, and set to
 * keep its rollback journal in memory, so holding the lock never makes a
 * `-journal` file a crash could leave behind, and a read-only directory can
 * still lock. Setting that reads the file, so it is busy like BEGIN.
 */
function connect(path: string, holder: Holder): Database.Database {
  if (holder.database !== null) return holder.database;
  for (let attempt = 0; ; attempt += 1) {
    const before = inspect(path);
    let database: Database.Database;
    try {
      // `timeout: 0`: SQLite's busy handler would otherwise wait (better-sqlite3
      // defaults to five seconds), blocking the thread.
      database = new Database(path, { fileMustExist: true, timeout: 0 });
    } catch (error) {
      throw unusable(path, `could not be opened (${String((error as { code?: unknown }).code)})`);
    }
    const after = inspect(path);
    try {
      if (before.ino !== after.ino || before.dev !== after.dev) throw new CredentialLockBusyError();
      database.pragma("journal_mode = MEMORY");
    } catch (error) {
      database.close();
      if ((error as { code?: unknown }).code === "SQLITE_NOTADB" && attempt === 0) {
        // Ours, and not empty as a lock file always is: empty it in place.
        empty(path, after);
        continue;
      }
      throw error instanceof CredentialLockBusyError ? error : sqliteFailure(path, error);
    }
    holder.database = database;
    holder.identity = { dev: after.dev, ino: after.ino };
    return database;
  }
}

/** The lock file's metadata, creating it when absent; refuses one that is not ours to use. */
function inspect(path: string): Stats {
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw unusable(path, `could not be created (${code})`);
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw unusable(path, `could not be read (${(error as NodeJS.ErrnoException).code})`);
  }
  if (!stat.isFile()) throw unusable(path, "is not a regular file");
  const uid = process.getuid!();
  if (stat.uid !== uid) {
    throw unusable(path, `belongs to uid ${stat.uid}, not to the user Volli runs as (uid ${uid})`);
  }
  return stat;
}

/**
 * Empties our own lock file without replacing it: the same inode, so no
 * process is split from another. No lock on it can be held while it is not a
 * lock file, so the descriptor opened here drops nothing.
 */
function empty(path: string, expected: Stats): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (stat.ino !== expected.ino || stat.dev !== expected.dev) throw new Error("replaced");
    ftruncateSync(fd, 0);
  } catch {
    throw unusable(path, "is not a lock file and could not be emptied");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function unusable(path: string, problem: string): CredentialLockUnusableError {
  return new CredentialLockUnusableError(
    `The credential lock file ${path} ${problem}, so saved credentials are not used. ` +
      "Move it aside; Volli makes a new one. Saved credentials are untouched: do not reset them.",
  );
}
