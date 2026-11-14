/**
 * The main connection's automatic WAL checkpoint, and a short hold on it
 * (VC-1201).
 *
 * The automatic backup clones the database file. An APFS clone defers its
 * bookkeeping (70-600 ms on a 2 GB file) to the first write into either file,
 * so the backup writes its own copy first, and main must not checkpoint into
 * the live file meanwhile. Holding sets `wal_autocheckpoint = 0`: commits
 * still append to the WAL, they only skip the backfill. Releasing restores
 * the threshold, and the next commit past it checkpoints as before.
 *
 * Holds count, so overlapping holders release independently. The setting is
 * per connection and never persisted: a crash or a restart opens at the
 * threshold again, so a hold cannot outlive the process.
 */
import type Database from "better-sqlite3";

/**
 * Checkpoint and restart the WAL once it passes this many pages (~1.6 MB at
 * the 4 KiB page size migration 001 assumes).
 */
export const WAL_AUTOCHECKPOINT_PAGES = 400;

const holds = new WeakMap<Database.Database, number>();

/** Stops `db`'s automatic checkpoint until every hold is released. Release is idempotent. */
export function holdAutocheckpoint(db: Database.Database): () => void {
  const count = holds.get(db) ?? 0;
  if (count === 0) db.pragma("wal_autocheckpoint = 0");
  holds.set(db, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(db) ?? 1) - 1;
    holds.set(db, left);
    if (left === 0 && db.open) db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  };
}
