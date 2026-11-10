/**
 * The machine-local perf store (VC-1092): every stall the app logged, kept
 * bounded and queryable, so "what are the top offenders since build X, and
 * did my change move them?" is a query rather than a grep through daily log
 * files.
 *
 * **Its own SQLite file, `<userData>/perf.db`, not a table in `volli.db`.**
 * Stalls are machine state (the Store rule allows SQLite for that), but
 * nothing about them belongs to the profile's durable data: they are not
 * backed up (`perf.db*` is excluded in `backup/decisions.ts`), never
 * migrated with the profile's registry, and the file can be deleted at any
 * time to start over. Older builds can still read and write it, so schema
 * changes must remain expand-only and nullable. A separate file avoids a
 * `volli.db` migration and keeps these writes off the profile database's WAL.
 * SQLite rather than a rolling JSONL file because the reads are aggregations
 * over a time window — an index on `at` answers them
 * without parsing every line ever written.
 *
 * **Off the hot path.** {@link PerfStore.record} only pushes onto an
 * in-memory buffer (bounded: past {@link PERF_STORE_BOUNDS}`.maxPending` a
 * row is counted as dropped). An unref'd timer writes the buffer in one
 * transaction every `flushMs`, and a read flushes first so an answer includes
 * the stall that just happened. The aggregations read the store a chunk at a
 * time ({@link PerfStore.scanStalls}), yielding the event loop between
 * chunks, so `volli perf` over the whole store is never itself a stall.
 *
 * **Bounded by count and age.** After each write the store deletes rows past
 * `maxRows` (oldest first) and, at most once per `pruneEveryMs`, rows older
 * than `maxAgeMs`, with the runs no row needs any more.
 *
 * **Runs.** Each open writes one `runs` row (when it started, the version and
 * build, and when it was last seen alive, refreshed while it runs), so a
 * reader can say how long the app was watching in any window and compare
 * builds per hour observed rather than by raw counts.
 *
 * The schema is expand-only: a later build may add a column or table, never
 * rename or drop one, and `PRAGMA user_version` names the newest layout that
 * wrote it.
 *
 * Diagnostics only: nothing here changes what the app does, and a store that
 * fails to open or write is logged once and stops — it never stops the app.
 */
import { join } from "node:path";

import Database from "better-sqlite3";
import {
  rendererScriptInvoker,
  rendererStallFile,
  rendererStallFunction,
  rendererStallMs,
  type PerfProcess,
} from "@volli/shared";

import { hostLogger } from "../log/root";
import type { PerfRun, PerfStallRecord } from "./report";

/** The store's file under the profile root. */
export const PERF_STORE_FILE_NAME = "perf.db";

/** Where a profile's perf store lives. */
export function perfStorePath(userData: string): string {
  return join(userData, PERF_STORE_FILE_NAME);
}

/** The store's bounds and cadence. */
export interface PerfStoreBounds {
  /** Rows kept at most; the oldest go first. */
  readonly maxRows: number;
  /** Rows older than this are deleted. */
  readonly maxAgeMs: number;
  /** Rows waiting for a write at most; past it a row is dropped and counted. */
  readonly maxPending: number;
  /** How often the buffer is written. */
  readonly flushMs: number;
  /** How often the age bound is applied. */
  readonly pruneEveryMs: number;
  /** How often a run's `last_seen_at` is refreshed while nothing else is written. */
  readonly heartbeatMs: number;
}

export const PERF_STORE_BOUNDS: PerfStoreBounds = Object.freeze({
  maxRows: 100_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  maxPending: 2_000,
  flushMs: 5_000,
  pruneEveryMs: 60 * 60 * 1000,
  heartbeatMs: 60_000,
});

/** The newest layout this build writes (`PRAGMA user_version`). */
export const PERF_STORE_SCHEMA_VERSION = 2;

/** Characters a stored identifier keeps: every real door, operation or label is far shorter. */
export const PERF_FIELD_MAX = 160;

/** One stall as the hook hands it over. Identifiers and durations only; never content. */
export interface PerfStallInput {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly process: PerfProcess;
  readonly kind: string;
  readonly door: string;
  readonly operation: string;
  readonly label?: string | null;
  readonly sessionId?: string | null;
  readonly windowId?: number | null;
  readonly durationMs: number;
  readonly hint?: string | null;
  /** Total attributed script duration, not just the longest script. */
  readonly scriptTotalMs?: number;
  readonly blockingMs?: number;
  /** Inclusive render start to frame end. */
  readonly renderMs?: number;
  /** Style/layout start to frame end; a subset of renderMs. */
  readonly styleLayoutMs?: number;
  readonly scriptFile?: string;
  readonly scriptFunction?: string;
  readonly scriptInvoker?: string;
  /** The longest attributed script's duration. */
  readonly scriptMs?: number;
}

export interface PerfStallFilter {
  /** Epoch ms, inclusive. */
  readonly since?: number;
  readonly process?: PerfProcess;
  readonly door?: string;
  /** An operation alone, or `door/operation`. */
  readonly operation?: string;
  readonly label?: string;
  /** A version, a build label, or `version+build` (`perfVersionKey`). */
  readonly version?: string;
}

/** What the store holds, for a reader to say how far back an answer can reach. */
export interface PerfStoreStats {
  readonly rows: number;
  readonly oldestAt: number | null;
  /** Rows the buffer dropped since this launch because writes fell behind. */
  readonly dropped: number;
  readonly maxRows: number;
  readonly maxAgeMs: number;
}

export interface PerfStore {
  /** Buffers one stall. O(1); never touches the disk, never throws. */
  record(stall: PerfStallInput): void;
  /** Writes the buffer now. */
  flush(): void;
  /** Stalls in `filter`, newest first, at most `limit` (all when absent). For a bounded listing. */
  stalls(filter: PerfStallFilter, limit?: number): PerfStallRecord[];
  /**
   * Hands every stall in `filter` to `visit`, {@link PERF_READ_CHUNK} rows per
   * turn of the event loop, so folding the whole store never holds main's
   * thread for more than one chunk. Oldest first. For the aggregations.
   */
  scanStalls(
    filter: PerfStallFilter,
    visit: (stalls: readonly PerfStallRecord[]) => void,
  ): Promise<void>;
  /** Every run the store remembers; this launch's is seen alive now. */
  runs(): PerfRun[];
  stats(): PerfStoreStats;
  /** Records this launch's build label, once it is known (a dev build asks git). */
  setBuild(build: string | null): void;
  /** Writes what is buffered and closes the file. Idempotent. */
  close(): void;
}

export interface PerfStoreOptions {
  /** The SQLite file; `:memory:` in a test. */
  readonly path: string;
  /** The app version this launch is. */
  readonly version: string;
  /** This launch's build label, when known at open. */
  readonly build?: string | null;
  readonly bounds?: Partial<PerfStoreBounds>;
  /** A wall clock in epoch milliseconds; `Date.now` unless a test pins it. */
  readonly now?: () => number;
  /** Arms the periodic write; an unref'd `setInterval` unless a test drives it. */
  readonly every?: (run: () => void, ms: number) => () => void;
}

const log = hostLogger("perf-store");

function unrefInterval(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

function clip(value: string): string {
  return value.length > PERF_FIELD_MAX ? value.slice(0, PERF_FIELD_MAX) : value;
}

function clipOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? clip(value) : null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    version TEXT NOT NULL,
    build TEXT
  );
  CREATE TABLE IF NOT EXISTS stalls (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    process TEXT NOT NULL,
    kind TEXT NOT NULL,
    door TEXT NOT NULL,
    operation TEXT NOT NULL,
    label TEXT,
    session_id TEXT,
    window_id INTEGER,
    duration_ms INTEGER NOT NULL,
    hint TEXT
  );
  CREATE INDEX IF NOT EXISTS stalls_at ON stalls (at);
`;

/** Nullable additions let a v1 writer continue inserting its original columns. */
const V2_COLUMNS = {
  script_total_ms: "REAL",
  blocking_ms: "REAL",
  render_ms: "REAL",
  style_layout_ms: "REAL",
  script_file: "TEXT",
  script_function: "TEXT",
  script_invoker: "TEXT",
  script_ms: "REAL",
} as const;

function upgradeSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(SCHEMA);
    const columns = new Set(
      (db.pragma("table_info(stalls)") as { name: string }[]).map((column) => column.name),
    );
    for (const [name, type] of Object.entries(V2_COLUMNS)) {
      if (!columns.has(name)) db.exec(`ALTER TABLE stalls ADD COLUMN ${name} ${type}`);
    }
    const version = db.pragma("user_version", { simple: true });
    if (typeof version !== "number" || version < PERF_STORE_SCHEMA_VERSION) {
      db.pragma(`user_version = ${PERF_STORE_SCHEMA_VERSION}`);
    }
  })();
}

interface StallRow {
  at: number;
  process: PerfProcess;
  kind: string;
  door: string;
  operation: string;
  label: string | null;
  session_id: string | null;
  window_id: number | null;
  duration_ms: number;
  hint: string | null;
  script_total_ms: number | null;
  blocking_ms: number | null;
  render_ms: number | null;
  style_layout_ms: number | null;
  script_file: string | null;
  script_function: string | null;
  script_invoker: string | null;
  script_ms: number | null;
  version: string;
  build: string | null;
}

/** The columns a stall row is read back with, its run's version and build included. */
const COLUMNS = `s.at, s.process, s.kind, s.door, s.operation, s.label, s.session_id,
  s.window_id, s.duration_ms, s.hint, s.script_total_ms, s.blocking_ms, s.render_ms,
  s.style_layout_ms, s.script_file, s.script_function, s.script_invoker, s.script_ms,
  r.version, r.build`;

/** Rows a chunked read takes per turn of the event loop. */
export const PERF_READ_CHUNK = 1_000;

function stallRecord(row: StallRow): PerfStallRecord {
  return {
    at: row.at,
    process: row.process,
    kind: row.kind,
    door: row.door,
    operation: row.operation,
    label: row.label,
    sessionId: row.session_id,
    windowId: row.window_id,
    durationMs: row.duration_ms,
    hint: row.hint,
    ...(row.script_total_ms === null ? {} : { scriptTotalMs: row.script_total_ms }),
    ...(row.blocking_ms === null ? {} : { blockingMs: row.blocking_ms }),
    ...(row.render_ms === null ? {} : { renderMs: row.render_ms }),
    ...(row.style_layout_ms === null ? {} : { styleLayoutMs: row.style_layout_ms }),
    ...(row.script_file === null ? {} : { scriptFile: row.script_file }),
    ...(row.script_function === null ? {} : { scriptFunction: row.script_function }),
    ...(row.script_invoker === null ? {} : { scriptInvoker: row.script_invoker }),
    ...(row.script_ms === null ? {} : { scriptMs: row.script_ms }),
    version: row.version,
    build: row.build,
  };
}

/** A filter as SQL conditions over `stalls s JOIN runs r`. */
function whereOf(filter: PerfStallFilter): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.since !== undefined) {
    clauses.push("s.at >= ?");
    params.push(filter.since);
  }
  if (filter.process !== undefined) {
    clauses.push("s.process = ?");
    params.push(filter.process);
  }
  if (filter.door !== undefined) {
    clauses.push("s.door = ?");
    params.push(filter.door);
  }
  if (filter.operation !== undefined) {
    clauses.push("(s.operation = ? OR s.door || '/' || s.operation = ?)");
    params.push(filter.operation, filter.operation);
  }
  if (filter.label !== undefined) {
    clauses.push("s.label = ?");
    params.push(filter.label);
  }
  if (filter.version !== undefined) {
    clauses.push("(r.version = ? OR r.build = ? OR r.version || '+' || r.build = ?)");
    params.push(filter.version, filter.version, filter.version);
  }
  return { clauses, params };
}

interface RunRow {
  id: number;
  started_at: number;
  last_seen_at: number;
  version: string;
  build: string | null;
}

/**
 * Opens (creating when absent) the perf store at `options.path`. Returns
 * `null`, logged once, when the file cannot be opened: the app runs without
 * a perf store rather than not at all.
 */
export function openPerfStore(options: PerfStoreOptions): PerfStore | null {
  const bounds: PerfStoreBounds = { ...PERF_STORE_BOUNDS, ...options.bounds };
  const now = options.now ?? Date.now;
  let db: Database.Database;
  try {
    // Never wait on a lock: a write that finds the file busy (someone
    // inspecting it with `sqlite3`) is retried on the next tick instead of
    // holding main's thread.
    db = new Database(options.path, { timeout: 0 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    upgradeSchema(db);
  } catch (error) {
    log.warn("perf store unavailable", { stage: "open", error: errorName(error) });
    return null;
  }
  return createStore(db, options, bounds, now);
}

/** An error as a log field: its SQLite code or class name, never its message (which can carry a path). */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : error.name;
}

function createStore(
  db: Database.Database,
  options: PerfStoreOptions,
  bounds: PerfStoreBounds,
  now: () => number,
): PerfStore {
  const startedAt = now();
  let build = options.build ?? null;
  const runId = Number(
    db
      .prepare("INSERT INTO runs (started_at, last_seen_at, version, build) VALUES (?, ?, ?, ?)")
      .run(startedAt, startedAt, clip(options.version), build === null ? null : clip(build))
      .lastInsertRowid,
  );

  const insert = db.prepare(
    `INSERT INTO stalls (run_id, at, process, kind, door, operation, label, session_id, window_id, duration_ms, hint,
       script_total_ms, blocking_ms, render_ms, style_layout_ms, script_file, script_function, script_invoker, script_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const touch = db.prepare("UPDATE runs SET last_seen_at = ? WHERE id = ?");
  const countRows = db.prepare("SELECT COUNT(*) AS n FROM stalls");
  const overflow = db.prepare(
    "DELETE FROM stalls WHERE id <= (SELECT id FROM stalls ORDER BY id DESC LIMIT 1 OFFSET ?)",
  );
  const expire = db.prepare("DELETE FROM stalls WHERE at < ?");
  const expireRuns = db.prepare(
    "DELETE FROM runs WHERE id != ? AND last_seen_at < ? AND id NOT IN (SELECT DISTINCT run_id FROM stalls)",
  );

  let rows = (countRows.get() as { n: number }).n;
  let pending: PerfStallInput[] = [];
  let dropped = 0;
  let lastTouchAt = startedAt;
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  let failed = false;
  let busyLogged = false;
  let closed = false;

  const write = db.transaction((batch: readonly PerfStallInput[], at: number) => {
    for (const stall of batch) {
      insert.run(
        runId,
        Math.round(stall.at),
        stall.process,
        clip(stall.kind),
        clip(stall.door),
        clip(stall.operation),
        clipOrNull(stall.label),
        clipOrNull(stall.sessionId),
        typeof stall.windowId === "number" ? stall.windowId : null,
        Math.max(0, Math.round(stall.durationMs)),
        clipOrNull(stall.hint),
        rendererStallMs(stall.scriptTotalMs),
        rendererStallMs(stall.blockingMs),
        rendererStallMs(stall.renderMs),
        rendererStallMs(stall.styleLayoutMs),
        stall.scriptFile === undefined ? null : rendererStallFile(stall.scriptFile),
        rendererStallFunction(stall.scriptFunction) ?? null,
        stall.scriptInvoker === undefined ? null : rendererScriptInvoker(stall.scriptInvoker),
        rendererStallMs(stall.scriptMs),
      );
    }
    rows += batch.length;
    touch.run(at, runId);
    if (rows > bounds.maxRows) rows -= overflow.run(bounds.maxRows).changes;
    if (at - lastPruneAt >= bounds.pruneEveryMs) {
      rows -= expire.run(at - bounds.maxAgeMs).changes;
      expireRuns.run(runId, at - bounds.maxAgeMs);
      lastPruneAt = at;
    }
  });

  const flush = (): void => {
    if (closed || failed) return;
    const at = now();
    const due = at - lastTouchAt >= bounds.heartbeatMs || at - lastPruneAt >= bounds.pruneEveryMs;
    if (pending.length === 0 && !due) return;
    try {
      write(pending, at);
      pending = [];
      lastTouchAt = at;
    } catch (error) {
      if (errorName(error) === "SQLITE_BUSY") {
        // Kept (the buffer is bounded) for the next tick.
        if (!busyLogged) log.warn("perf store busy: write deferred", { error: "SQLITE_BUSY" });
        busyLogged = true;
        return;
      }
      failed = true;
      pending = [];
      log.warn("perf store unavailable", { stage: "write", error: errorName(error) });
    }
  };

  flush();
  const stopTimer = (options.every ?? unrefInterval)(flush, bounds.flushMs);

  const runRows = db.prepare("SELECT id, started_at, last_seen_at, version, build FROM runs");

  return {
    record(stall) {
      if (closed || failed) return;
      if (pending.length >= bounds.maxPending) {
        dropped += 1;
        return;
      }
      pending.push(stall);
    },
    flush,
    stalls(filter, limit) {
      flush();
      const { clauses, params } = whereOf(filter);
      const sql = `SELECT ${COLUMNS} FROM stalls s JOIN runs r ON r.id = s.run_id
        ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
        ORDER BY s.at DESC, s.id DESC
        ${limit === undefined ? "" : "LIMIT ?"}`;
      if (limit !== undefined) params.push(limit);
      return (db.prepare(sql).all(...params) as StallRow[]).map(stallRecord);
    },
    async scanStalls(filter, visit) {
      flush();
      // The scan's range is fixed now: rows written while it yields are not
      // chased, and rows the bound deletes meanwhile simply are not read.
      const range = db
        .prepare(
          filter.since === undefined
            ? "SELECT MIN(id) AS low, MAX(id) AS high FROM stalls"
            : "SELECT MIN(id) AS low, (SELECT MAX(id) FROM stalls) AS high FROM stalls WHERE at >= ?",
        )
        .get(...(filter.since === undefined ? [] : [filter.since])) as {
        low: number | null;
        high: number | null;
      };
      if (range.low === null || range.high === null) return;
      const { clauses, params } = whereOf(filter);
      const chunk = db.prepare(
        `SELECT s.id, ${COLUMNS} FROM stalls s JOIN runs r ON r.id = s.run_id
          WHERE s.id >= ? AND s.id <= ? ${clauses.map((clause) => `AND ${clause}`).join(" ")}
          ORDER BY s.id LIMIT ${PERF_READ_CHUNK}`,
      );
      let cursor = range.low;
      for (;;) {
        const page = chunk.all(cursor, range.high, ...params) as (StallRow & { id: number })[];
        visit(page.map(stallRecord));
        if (page.length < PERF_READ_CHUNK) return;
        cursor = page.at(-1)!.id + 1;
        // Main's other work runs between chunks: a scan never holds the loop
        // for more than one chunk and its fold.
        await new Promise<void>((resolve) => setImmediate(resolve));
        // A close meanwhile ends the scan with what it has visited.
        if (closed) return;
      }
    },
    runs() {
      flush();
      const at = now();
      return (runRows.all() as RunRow[]).map((row) => ({
        startedAt: row.started_at,
        // This launch is alive as long as it can answer.
        lastSeenAt: row.id === runId ? at : row.last_seen_at,
        version: row.version,
        build: row.build,
      }));
    },
    stats() {
      flush();
      const oldest = db.prepare("SELECT MIN(at) AS at FROM stalls").get() as { at: number | null };
      return {
        rows,
        oldestAt: oldest.at,
        dropped,
        maxRows: bounds.maxRows,
        maxAgeMs: bounds.maxAgeMs,
      };
    },
    setBuild(next) {
      if (closed || failed) return;
      build = next;
      try {
        db.prepare("UPDATE runs SET build = ? WHERE id = ?").run(
          build === null ? null : clip(build),
          runId,
        );
      } catch (error) {
        log.warn("perf store build label not recorded", { error: errorName(error) });
      }
    },
    close() {
      if (closed) return;
      stopTimer();
      lastTouchAt = Number.NEGATIVE_INFINITY;
      flush();
      closed = true;
      try {
        db.close();
      } catch {
        // Closing a database that failed is already the outcome we want.
      }
    },
  };
}
