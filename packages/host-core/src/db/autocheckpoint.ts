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
 * threshold again, so a hold cannot outlive the process. A restore that fails
 * (the connection busy) is retried on a timer until it takes, because a WAL
 * with no automatic checkpoint grows without bound.
 */
import type Database from "better-sqlite3";
import { hostLogger } from "../log/root";

/**
 * Checkpoint and restart the WAL once it passes this many pages (~1.6 MB at
 * the 4 KiB page size migration 001 assumes).
 */
export const WAL_AUTOCHECKPOINT_PAGES = 400;

/** How soon a failed restore tries again. */
const AUTOCHECKPOINT_RESTORE_RETRY_MS = 1000;

const log = hostLogger("db");

interface HoldState {
  holds: number;
  /** Set while the threshold is still 0 after the last release failed to restore it. */
  retry: ReturnType<typeof setTimeout> | undefined;
}

const states = new WeakMap<Database.Database, HoldState>();

/**
 * Stops `db`'s automatic checkpoint until every hold is released. Throws, and
 * holds nothing, when the setting cannot be changed. The release never throws
 * and is idempotent.
 */
export function holdAutocheckpoint(db: Database.Database): () => void {
  const state = states.get(db) ?? { holds: 0, retry: undefined };
  // A pending restore means the threshold is still 0: nothing to set.
  if (state.holds === 0 && state.retry === undefined) db.pragma("wal_autocheckpoint = 0");
  clearTimeout(state.retry);
  state.retry = undefined;
  state.holds += 1;
  states.set(db, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.holds -= 1;
    if (state.holds === 0) restore(db, state, true);
  };
}

function restore(db: Database.Database, state: HoldState, first: boolean): void {
  state.retry = undefined;
  // A new hold arrived, or the connection closed (the next open sets the threshold).
  if (state.holds > 0 || !db.open) return;
  try {
    db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  } catch (error) {
    if (first)
      log.warn("autocheckpoint restore failed", {
        code: "autocheckpoint-restore-failed",
        sqliteCode: sqliteCode(error),
      });
    state.retry = setTimeout(() => restore(db, state, false), AUTOCHECKPOINT_RESTORE_RETRY_MS);
    state.retry.unref?.();
  }
}

function sqliteCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}
