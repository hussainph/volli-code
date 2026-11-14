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
 * Where the volume cannot clone, `clone` copies the bytes: still consistent,
 * with the read transaction (and the hold) lasting as long as that copy.
 */
import { copyFile, open, rm, stat } from "node:fs/promises";
import Database from "better-sqlite3";

/** The WAL header: a restart rewrites it with new salts. */
const WAL_HEADER_BYTES = 32;
/** A restart that keeps beating the copy is not expected; a third gives up. */
const MAX_WAL_COPY_ATTEMPTS = 3;

export interface LiveSnapshotOptions {
  /** Copies a whole file, cloning where the volume can (`cloneOrCopyFile`). */
  clone: (source: string, target: string) => "cp-clone" | "copy";
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
  method: "cp-clone" | "copy";
}

/**
 * Copies the database `source` reads (at `dbPath`) to `snapshotPath`, in the
 * caller's scratch directory, as one self-contained database file. `source`
 * must be a read-only connection with no open transaction.
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
  let method: "cp-clone" | "copy";
  try {
    const began = performance.now();
    source.exec("BEGIN");
    try {
      // The first read takes the read lock and fixes the snapshot.
      source.prepare("SELECT count(*) FROM sqlite_schema").get();
      walBytes = await copyLiveWal(`${dbPath}-wal`, snapshotWal);
      method = options.clone(dbPath, snapshotPath);
    } finally {
      source.exec("COMMIT");
      readTransactionMs = performance.now() - began;
    }
    if (method === "cp-clone") await claimClone(snapshotPath);
  } finally {
    release();
    holdMs = performance.now() - held;
  }
  // The copy is the caller's scratch file: recovering and checkpointing it
  // writes nothing the live database shares.
  const copy = new Database(snapshotPath, { fileMustExist: true });
  try {
    copy.pragma("cache_size = -2048");
    const [checkpoint] = copy.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint?.busy !== 0) throw new Error("The database copy could not be checkpointed.");
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  await rm(snapshotWal, { force: true });
  await rm(`${snapshotPath}-shm`, { force: true });
  return { readTransactionMs, holdMs, walBytes, method };
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
    if (attempt >= MAX_WAL_COPY_ATTEMPTS)
      throw new Error("The live WAL kept restarting while it was copied.");
  }
}

/** Rewrites a clone's first bytes with themselves, so the clone pays its deferred cost. */
async function claimClone(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    const head = Buffer.alloc(WAL_HEADER_BYTES);
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
