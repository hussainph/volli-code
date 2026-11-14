/**
 * A consistent copy of the live database, taken under a read transaction
 * that lasts milliseconds instead of the whole copy (VC-1201).
 *
 * The backup used to copy the live database with one `backup()` step. That
 * holds one read transaction for the whole copy (8-33 s on a 2.3 GB profile
 * under load), and while it is open main's automatic checkpoints cannot
 * backfill past it or restart the WAL. The WAL grew to 30-130 MB, and the
 * next commit on main backfilled all of it synchronously: a 400-600 ms
 * stall, mostly waiting on IO. A multi-step `backup()` is no fix: another
 * connection's write restarts it, and Sessions write many times a second.
 *
 * Instead, the read-only `source` opens a read transaction and, while it is
 * open, copies the live WAL's bytes (it is small: main checkpoints it at 400
 * pages) and clones the database file. On APFS a clone takes milliseconds
 * whatever the file's size. SQLite's WAL locks make the pair consistent:
 *
 * - While the read transaction holds a read mark above zero, a checkpoint
 *   backfills only frames at or before that mark, and the WAL cannot restart.
 *   Every page of the database file that may change during the copy is in
 *   one of those frames, so recovering the copied WAL over the copied file
 *   overwrites any page caught mid-backfill with its frame.
 * - While it holds read mark zero (the WAL was fully backfilled when it
 *   began), no checkpoint may write the database file at all, but a writer may
 *   restart the WAL. The copied WAL is kept only if its header still matches
 *   the live WAL's after the copy: each restart writes new salts, so a match
 *   means no frame was overwritten while it was copied.
 *
 * Recovery keeps frames up to the last valid commit, so the copy is the
 * database at the read transaction's start or at a commit after it. It is
 * then checkpointed into one rollback-journal file. Nothing here writes the
 * live database, its WAL or its `-shm`: the worker stays read-only (VC-1208).
 *
 * An APFS clone is lazy: the first write into either file pays for its
 * bookkeeping, 70-600 ms on a 2.3 GB database. That write must be ours, not
 * a checkpoint on main. So main holds its automatic checkpoint for the
 * moment of the copy (`holdCheckpoints`), and the copy is written once, in
 * place, before the hold ends. Main's commits only append to the WAL
 * meanwhile, which is never cloned.
 *
 * The live database file is opened only by SQLite and by a `cp` child. On
 * POSIX, closing ANY descriptor for a file drops every fcntl lock the process
 * holds on it, SQLite's included, so this process never opens it with plain
 * fs calls. The WAL file is read and copied here: SQLite never takes fcntl
 * locks on it. In `os_unix.c` they are set only on the main database file
 * (`unixLock`, which the pager calls on its main file alone) and on the
 * `-shm` (`unixShmSystemLock`), where all WAL-mode locks live; `wal.c` never
 * calls `sqlite3OsLock` on the WAL handle. An F_GETLK probe from another
 * process, with a reader and a writer mid-transaction, found locks on the
 * database and the `-shm` and none on the `-wal`.
 *
 * Where the volume cannot clone, `cp` copies the bytes: still consistent,
 * with the read transaction (and the hold) lasting as long as that copy.
 * The recovered copy must pass `quick_check` before it is bundled: it reads
 * the whole file once (18-38 s cold, 2 s warm, on a 2.3 GB profile).
 */
import { execFile } from "node:child_process";
import { copyFile, open, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";

const run = promisify(execFile);
const CP = "/bin/cp";

/** The WAL header: a restart rewrites it with new salts. */
const WAL_HEADER_BYTES = 32;
/**
 * The bytes of a clone rewritten with themselves to claim it. Any write pays
 * the clone's deferred cost; the file header (the first 100 bytes of page 1)
 * is always present, and rewriting its start with its own bytes changes
 * nothing SQLite reads.
 */
const CLONE_CLAIM_BYTES = 16;
/** A restart that keeps beating the copy is not expected; a third gives up. */
const MAX_WAL_COPY_ATTEMPTS = 3;

export type LiveFileCopyMethod = "cp-clone" | "cp";

/** Why a live copy failed; `message` is the code. */
export type LiveSnapshotFailure =
  | "wal-kept-restarting"
  | "copy-checkpoint-busy"
  | "copy-journal-mode"
  | "copy-integrity";

export class LiveSnapshotError extends Error {
  // A declared field, not a parameter property: the bench loads this file
  // with Node's type stripping, which has no parameter properties.
  readonly reason: LiveSnapshotFailure;
  constructor(reason: LiveSnapshotFailure) {
    super(reason);
    this.name = "LiveSnapshotError";
    this.reason = reason;
  }
}

export interface LiveSnapshotOptions {
  /** Copies the live database file outside this process ({@link copyFileOutOfProcess}). */
  clone: (source: string, target: string) => Promise<LiveFileCopyMethod>;
  /** Asks main to hold its automatic checkpoint; resolves with the release. */
  holdCheckpoints: () => Promise<() => void>;
}

export interface LiveSnapshotResult {
  /** How long the read transaction on the live database stayed open. */
  readTransactionMs: number;
  /** How long main's automatic checkpoint was held. */
  holdMs: number;
  /** Bytes of live WAL copied and recovered into the copy. */
  walBytes: number;
  method: LiveFileCopyMethod;
  /** How long the copy's `quick_check` took. */
  quickCheckMs: number;
}

/**
 * Copies `source` to `target` in a `cp` child, so this process opens no
 * descriptor on `source`. `clone` asks for `cp -c` (`clonefile(2)`, macOS);
 * if that fails, or without it, plain `cp` copies the bytes.
 */
export async function copyFileOutOfProcess(
  source: string,
  target: string,
  options: { clone: boolean },
): Promise<LiveFileCopyMethod> {
  if (options.clone) {
    try {
      await run(CP, ["-c", "--", source, target]);
      return "cp-clone";
    } catch {
      // A volume or a cp without clones: copy the bytes instead.
    }
  }
  await run(CP, ["--", source, target]);
  return "cp";
}

/**
 * Copies the database `source` reads (at `dbPath`) to `snapshotPath`, in the
 * caller's scratch directory, as one self-contained database file that passed
 * `quick_check`. `source` must be a read-only connection with no open
 * transaction.
 */
export async function copyLiveDatabase(
  source: Database.Database,
  dbPath: string,
  snapshotPath: string,
  options: LiveSnapshotOptions,
): Promise<LiveSnapshotResult> {
  const snapshotWal = `${snapshotPath}-wal`;
  const release = await options.holdCheckpoints();
  const held = performance.now();
  let holdMs: number;
  let readTransactionMs: number;
  let walBytes: number;
  let method: LiveFileCopyMethod;
  try {
    const began = performance.now();
    source.exec("BEGIN");
    try {
      // The first read takes the read lock and fixes the snapshot.
      source.prepare("SELECT count(*) FROM sqlite_schema").get();
      walBytes = await copyLiveWal(`${dbPath}-wal`, snapshotWal);
      method = await options.clone(dbPath, snapshotPath);
    } finally {
      source.exec("COMMIT");
      readTransactionMs = performance.now() - began;
    }
    // A plain copy shares nothing; claiming it is harmless and cheap.
    await claimClone(snapshotPath);
  } finally {
    release();
    holdMs = performance.now() - held;
  }
  // The copy is the caller's scratch file: recovering, checkpointing and
  // checking it touches nothing the live database shares.
  const copy = new Database(snapshotPath, { fileMustExist: true });
  let quickCheckMs: number;
  try {
    copy.pragma("cache_size = -2048");
    const [checkpoint] = copy.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint?.busy !== 0) throw new LiveSnapshotError("copy-checkpoint-busy");
    if (copy.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new LiveSnapshotError("copy-journal-mode");
    const checked = performance.now();
    let result: unknown;
    try {
      result = copy.pragma("quick_check", { simple: true });
    } catch {
      // SQLITE_CORRUPT and the like: the copy is not sound either way.
      result = undefined;
    }
    quickCheckMs = performance.now() - checked;
    if (result !== "ok") throw new LiveSnapshotError("copy-integrity");
  } finally {
    copy.close();
  }
  await rm(snapshotWal, { force: true });
  await rm(`${snapshotPath}-shm`, { force: true });
  return { readTransactionMs, holdMs, walBytes, method, quickCheckMs };
}

/** Copies the live WAL's bytes, again if a restart landed mid-copy. 0 when there is none. */
async function copyLiveWal(liveWal: string, copyPath: string): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    await rm(copyPath, { force: true });
    try {
      // Never a clone: main appends to this file throughout.
      await copyFile(liveWal, copyPath);
    } catch (error) {
      // The read transaction pins an existing WAL: none now means none to copy.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const [copied, live] = await Promise.all([walHeader(copyPath), walHeader(liveWal)]);
    // A copy too short for a header carries no frame recovery would replay.
    if (copied === null || (live !== null && copied.equals(live)))
      return (await stat(copyPath)).size;
    if (attempt >= MAX_WAL_COPY_ATTEMPTS) throw new LiveSnapshotError("wal-kept-restarting");
  }
}

/** Rewrites a clone's first bytes with themselves, so the clone pays its deferred cost. */
async function claimClone(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const head = Buffer.alloc(CLONE_CLAIM_BYTES);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    await handle.write(head, 0, bytesRead, 0);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

async function walHeader(path: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const header = Buffer.alloc(WAL_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length ? header : null;
  } finally {
    await handle.close();
  }
}
