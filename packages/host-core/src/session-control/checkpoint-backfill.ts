/**
 * One background pass that gives every Session a usable projection checkpoint
 * (VC-1076).
 *
 * A checkpoint is a rebuildable cache, and until VC-1076 only a runtime fact
 * ever wrote one. A Session that was never attached since this table existed
 * had none, and a Session whose row an older build wrote at a schema version
 * this build refuses had one that every read ignored. Either way, every read
 * folded its whole log — on a measured 5,061-Session profile, 1,376 had no row
 * and 1,107 had a v1 row, and the first listing after launch re-folded all of
 * them on every launch.
 *
 * Listings now persist a full fold themselves, so a listing heals what it
 * touches. This pass is for the rest, and for doing it off the person's
 * critical path: for each such Session it folds the whole log and writes the
 * checkpoint, most recently inserted first, because those are what a listing
 * shows first. The fold is the shared `createSessionProjectionCheckpoint`
 * over the ledger's own projection read, and the write is the ledger's
 * `saveProjectionCheckpoint` — exactly what the engine does for a Session with
 * no usable row — so there is no second encoder here to drift from the first.
 * It runs through its own ledger rather than the engine because the engine's
 * single-Session read (`getSession`) is deliberately read-only.
 *
 * Idempotent and cheap to repeat: once every Session has a current row the
 * candidate query returns nothing, so running it at each launch is how it
 * stays "one-time" across builds that bump the schema version.
 *
 * Main-thread budget: candidates are found a page at a time, and the host is
 * given a macrotask turn whenever a slice of work has run for
 * {@link BACKFILL_SLICE_MS}. A Session's log is read and folded
 * {@link BACKFILL_FOLD_PAGE} events at a time too, each page in its own
 * transaction, resuming from the checkpoint the previous page left
 * (`advanceSessionProjection`, the same step the engine takes for every fact).
 * Reading the log is most of a fold's cost — on a measured 14.8k-event
 * Session, ~400 ms cold against ~9 ms for the fold itself — so one large
 * Session no longer holds the main thread for its whole history at once
 * (VC-1098; a single such block measured 2.2–2.8 s on a loaded machine).
 *
 * Splitting across transactions is sound because events are insert-only: a
 * page read later sees the same prefix plus, at most, facts appended since,
 * which the next page folds. The row is written in the transaction that read
 * the last page, so its cursor is never past that transaction's head.
 */
import type Database from "better-sqlite3";
import {
  advanceSessionProjection,
  createSessionProjectionCheckpoint,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
} from "@volli/shared";
import type { SessionProjectionCheckpoint } from "@volli/shared";

import { setImmediate } from "node:timers";
import { prepared } from "../db/prepared";
import { hostLogger } from "../log/root";
import { createSqliteSessionLedger } from "./sqlite-ledger";

const log = hostLogger("session-checkpoint");

/** How long one stretch of backfill may hold the main thread before yielding. */
export const BACKFILL_SLICE_MS = 8;

/** How many Sessions one candidate read considers. */
const BACKFILL_PAGE = 256;

/** How many events of one Session's log one transaction reads and folds. */
export const BACKFILL_FOLD_PAGE = 256;

export interface CheckpointBackfillPorts {
  readonly db: Database.Database;
  /**
   * A macrotask turn; see `SessionEnginePorts.yieldToHost` for why not a
   * microtask. Defaults to `setImmediate`.
   */
  readonly yieldToHost?: () => Promise<void>;
  /** Stops the pass between Sessions; a fold already running finishes. */
  readonly signal?: AbortSignal;
  /** Overridable for tests. */
  readonly now?: () => number;
}

export interface CheckpointBackfillResult {
  /** Sessions whose checkpoint was missing or at another schema version. */
  readonly candidates: number;
  /** Of those, how many now have a current row. */
  readonly refreshed: number;
}

/** Folds and persists every Session's missing or other-version checkpoint, yielding as it goes. */
export async function backfillProjectionCheckpoints(
  ports: CheckpointBackfillPorts,
): Promise<CheckpointBackfillResult> {
  const { db, signal } = ports;
  const ledger = createSqliteSessionLedger(db);
  const yieldToHost = ports.yieldToHost ?? yieldToMainProcess;
  const now = ports.now ?? (() => performance.now());
  const page = prepared(
    db,
    `SELECT s.rowid AS cursor, s.id AS id,
            c.session_id IS NOT NULL AND c.schema_version = @version AS current
       FROM sessions s
       LEFT JOIN session_projection_checkpoints c ON c.session_id = s.id
      WHERE s.rowid < @before
      ORDER BY s.rowid DESC
      LIMIT @limit`,
  );
  const isCurrent = prepared(
    db,
    `SELECT 1 FROM session_projection_checkpoints WHERE session_id = ? AND schema_version = ?`,
  );
  let before = Number.MAX_SAFE_INTEGER;
  let candidates = 0;
  let refreshed = 0;
  let sliceStartedAt = now();
  const yieldIfDue = async (): Promise<void> => {
    if (now() - sliceStartedAt < BACKFILL_SLICE_MS) return;
    await yieldToHost();
    sliceStartedAt = now();
  };
  for (;;) {
    if (signal?.aborted) break;
    const rows = page.all({
      version: SESSION_PROJECTION_CHECKPOINT_VERSION,
      before,
      limit: BACKFILL_PAGE,
    }) as { cursor: number; id: string; current: number }[];
    if (rows.length === 0) break;
    before = rows.at(-1)!.cursor;
    for (const row of rows) {
      if (row.current === 1) continue;
      if (signal?.aborted) break;
      candidates += 1;
      try {
        let checkpoint: SessionProjectionCheckpoint | null = null;
        for (;;) {
          const more = await ledger.transaction((transaction) => {
            const session = transaction.getSession(row.id);
            // Gone since the page was read: its project was deleted.
            if (session === null) return false;
            const events = transaction.listProjectionEvents({
              sessionId: session.id,
              afterSequence: checkpoint?.throughSequence ?? 0,
              limit: BACKFILL_FOLD_PAGE,
            });
            checkpoint =
              checkpoint === null
                ? createSessionProjectionCheckpoint(session, events)
                : advanceSessionProjection(checkpoint, events, session);
            // A short page is this transaction's head: write the row here.
            if (events.length < BACKFILL_FOLD_PAGE) {
              transaction.saveProjectionCheckpoint(checkpoint);
              return false;
            }
            return true;
          });
          if (!more) break;
          await yieldIfDue();
        }
        if (isCurrent.get(row.id, SESSION_PROJECTION_CHECKPOINT_VERSION) !== undefined) {
          refreshed += 1;
        }
      } catch (error) {
        // A Session that cannot be folded is a fault its own reads report;
        // the pass moves on rather than stopping every other Session's heal.
        log.warn("projection checkpoint backfill skipped a Session", {
          sessionId: row.id,
          error,
        });
      }
      await yieldIfDue();
    }
    await yieldIfDue();
  }
  return { candidates, refreshed };
}

function yieldToMainProcess(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
