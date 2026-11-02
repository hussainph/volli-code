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
 * Read paths now persist a full fold themselves, so a listing heals what it
 * touches. This pass is for the rest, and for doing it off the person's
 * critical path: it asks the engine for each such Session's projection, which
 * folds it and writes the checkpoint back (`projectStoredSessionAndPersist`),
 * most recently inserted first, because those are what a listing shows first. It is the
 * engine's own read, so the row it writes is exactly the one a read would
 * write — no second encoder here to drift from the first.
 *
 * Idempotent and cheap to repeat: once every Session has a current row the
 * candidate query returns nothing, so running it at each launch is how it
 * stays "one-time" across builds that bump the schema version.
 *
 * Main-thread budget: candidates are found a page at a time, and the host is
 * given a macrotask turn whenever a slice of work has run for
 * {@link BACKFILL_SLICE_MS}. One Session's fold cannot be split, so a single
 * enormous Session can still hold one slice longer — the same cost its first
 * listing would have paid, paid once and in the background.
 */
import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import { SESSION_PROJECTION_CHECKPOINT_VERSION } from "@volli/shared";

import { setImmediate } from "node:timers";
import { prepared } from "../db/prepared";
import { hostLogger } from "../log/root";

const log = hostLogger("session-checkpoint");

/** How long one stretch of backfill may hold the main thread before yielding. */
export const BACKFILL_SLICE_MS = 8;

/** How many Sessions one candidate read considers. */
const BACKFILL_PAGE = 256;

export interface CheckpointBackfillPorts {
  readonly db: Database.Database;
  /** The host's engine: its read folds and persists a missing checkpoint. */
  readonly engine: Pick<SessionEngine, "getSession">;
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
  const { db, engine, signal } = ports;
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
        await engine.getSession({ sessionId: row.id });
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
