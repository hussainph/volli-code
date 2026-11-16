/**
 * The schema upgrade, off the thread that serves the app (VC-1105).
 *
 * Opening a database an older build wrote runs the whole upgrade before the
 * open returns: the integrity checks, the migration safety copy, every pending
 * migration, ANALYZE, compaction and retention of older copies. On a large
 * profile that is a minute of synchronous SQLite. Run on Electron main, it
 * froze the app with no window. Here it runs in a worker thread with its own
 * connection, through the same {@link openVolliDb}, so every crash rule of
 * `database-file.ts` holds unchanged: the worker holds the open lock for the
 * whole upgrade, and the host opens the database only after the worker has
 * closed it.
 *
 * Every launch with a large database comes through here (VC-1203), not only
 * one that upgrades: a routine open's preflight `quick_check` reads every
 * page, which is seconds of main on a large profile (`databaseStartupWork`). With nothing pending the
 * worker's open migrates nothing, so it is that check, the same one, every
 * launch, on another thread.
 *
 * The worker's answer is one of three:
 *
 * - **Opened**, upgraded if it was older, with the identity of the file it
 *   closed. The host's own open then skips the routine quick check while the
 *   file is still exactly that one: the worker just asked it.
 * - **Refused**, already classified and worded here (an error object does not
 *   cross a thread). The host goes degraded with it and does not try again on
 *   its own thread, which would repeat a long refusal there.
 * - **No answer** (`null`): the worker never ran or died without replying. The
 *   host opens on its own thread as every earlier build did, so a missing or
 *   broken worker costs speed, never the boot.
 *
 * The worker's log lines go to the host's log: each record is posted to the
 * parent and written there under its own component.
 *
 * A quit during this work (VC-1208): an upgrade is never cut short, and the
 * quit waits for it. A routine check reads only until its open is about to
 * write (`beforeFirstWrite`); until then a quit may claim it
 * (`process/live-workers.ts`) and end the process without waiting for its
 * SQLite call, and a claimed check then writes nothing at all.
 */
import Database from "better-sqlite3";
import { declareWorkerExitKind, type LogLevel, type LogRecord } from "@volli/shared";
import { existsSync } from "node:fs";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  classifyDbOpenFailure,
  dbOpenFailureLogLine,
  describeDbOpenFailure,
  type DbOpenFailure,
} from "../db-open-failure";
import { hostLogger, installHostLog } from "../log/root";
import {
  attachReadOnlyGate,
  createReadOnlyGate,
  leaveReadOnlyPhase,
} from "../process/live-workers";
import { checkedDatabaseFile, type CheckedDatabaseFile } from "./checked-file";
import { openVolliDb } from "./database-file";
import { logTransactionViolation } from "./transaction-gate";

export interface DatabaseUpgradeRequest {
  readonly dbPath: string;
  /** The host log's level: the worker formats nothing the host would drop. */
  readonly logLevel: LogLevel;
  /** A development build: the refusal is worded for its developer. */
  readonly dev: boolean;
  /**
   * What the launch asked for (`databaseStartupWork`). A `check` is read-only
   * until its open is about to write, and a quit may end the process during
   * that phase (VC-1208); an `upgrade`, the default, is never cut short.
   */
  readonly work?: "check" | "upgrade";
  /**
   * Smokes only (`VOLLI_SMOKE_DATABASE_WORKER_HOLD_ROWS`): before the open,
   * one SQLite statement on a read-only connection to the file counts this
   * many rows, so a smoke can quit while the worker is inside a long native
   * call. Changes nothing the open does.
   */
  readonly holdRows?: number;
  /**
   * Smokes only (`VOLLI_SMOKE_DATABASE_WORKER_HOLD_UNTIL`): after `holdRows`,
   * the worker keeps counting rows in such statements until this file
   * exists, so a smoke decides when the open goes on.
   */
  readonly holdUntil?: string;
}

/** What the worker receives: the request, and a check's phase. */
interface DatabaseUpgradeWorkerData extends DatabaseUpgradeRequest {
  readonly readOnlyGate?: SharedArrayBuffer;
}

/** A refusal, prepared where the error object still exists. */
export interface PreparedDbOpenFailure {
  readonly failure: DbOpenFailure;
  /** {@link describeDbOpenFailure}'s message for the request's audience. */
  readonly message: string;
  /** {@link dbOpenFailureLogLine}'s detail. */
  readonly logLine: string;
}

export type DatabaseUpgradeOutcome =
  | {
      readonly ok: true;
      /** The file as the worker closed it; `null` when it could not be pinned down. */
      readonly checked: CheckedDatabaseFile | null;
    }
  | ({ readonly ok: false } & PreparedDbOpenFailure);

type WorkerMessage = { readonly log: LogRecord } | { readonly outcome: DatabaseUpgradeOutcome };

/** Prepares a refusal for a thread the error object cannot reach. */
export function prepareDbOpenFailure(error: unknown, dev: boolean): PreparedDbOpenFailure {
  return {
    failure: classifyDbOpenFailure(error),
    message: describeDbOpenFailure(error, { dev }),
    logLine: dbOpenFailureLogLine(error),
  };
}

/**
 * Opens (upgrading) and closes `dbPath` on the calling thread, checkpointed,
 * and returns the file it left. Throws whatever {@link openVolliDb} throws.
 */
export function upgradeVolliDb(
  dbPath: string,
  beforeFirstWrite?: () => void,
): CheckedDatabaseFile | null {
  const db = openVolliDb(dbPath, {
    onTransactionViolation: logTransactionViolation,
    ...(beforeFirstWrite === undefined ? {} : { beforeFirstWrite }),
  });
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return checkedDatabaseFile(dbPath);
}

/** The worker's side: upgrade, answer once, exit. */
export function serveDatabaseUpgradeWorker(): void {
  const port = parentPort;
  if (port === null) throw new Error("The database upgrade must run in a worker.");
  const request = workerData as DatabaseUpgradeWorkerData;
  installHostLog({
    level: request.logLevel,
    sink: { write: (record) => port.postMessage({ log: record } satisfies WorkerMessage) },
  });
  let outcome: DatabaseUpgradeOutcome;
  try {
    if (request.holdRows !== undefined || request.holdUntil !== undefined)
      holdInsideSqlite(request.dbPath, request.holdRows ?? 0, request.holdUntil);
    const gate = request.readOnlyGate;
    outcome = {
      ok: true,
      checked: upgradeVolliDb(
        request.dbPath,
        gate === undefined ? undefined : () => leaveReadOnlyPhase(gate),
      ),
    };
  } catch (error) {
    outcome = { ok: false, ...prepareDbOpenFailure(error, request.dev) };
  }
  port.postMessage({ outcome } satisfies WorkerMessage);
  port.close();
}

/** The smokes' hold: long native calls that only read (see `holdRows`, `holdUntil`). */
function holdInsideSqlite(dbPath: string, rows: number, until: string | undefined): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = db.prepare(
      "WITH RECURSIVE counted(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counted WHERE n < ?) SELECT count(*) FROM counted",
    );
    count.get(rows);
    if (until !== undefined) {
      while (!existsSync(until)) count.get(1_000_000);
    }
  } finally {
    db.close();
  }
}

/** Writes a worker's record into this thread's host log, under its own component. */
function relayLogRecord(record: LogRecord): void {
  const { ts: _ts, level, component, msg, ...fields } = record;
  hostLogger(component, { thread: "database-upgrade" })[level](msg, fields);
}

/**
 * Runs the upgrade in a worker started from `entry` and settles once it has
 * exited, so the database is closed by then. `null` when the worker gave no
 * answer: the caller opens the database itself.
 */
export function runDatabaseUpgradeWorker(
  entry: string | URL,
  request: DatabaseUpgradeRequest,
  /** Tests only: a worker run under plain Node's TypeScript loader. */
  execArgv?: string[],
): Promise<DatabaseUpgradeOutcome | null> {
  const log = hostLogger("db");
  return new Promise((resolve) => {
    let outcome: DatabaseUpgradeOutcome | null = null;
    let worker: Worker;
    const check = request.work === "check";
    const readOnlyGate = check ? createReadOnlyGate() : undefined;
    const data: DatabaseUpgradeWorkerData = {
      ...request,
      ...(readOnlyGate === undefined ? {} : { readOnlyGate }),
    };
    try {
      worker = new Worker(entry, { workerData: data, ...(execArgv ? { execArgv } : {}) });
      declareWorkerExitKind(worker, check ? "database-check" : "database-upgrade");
      if (readOnlyGate !== undefined) attachReadOnlyGate(worker, readOnlyGate);
    } catch (error) {
      log.error("database upgrade worker did not start", { error });
      resolve(null);
      return;
    }
    worker.on("message", (message: WorkerMessage) => {
      if ("log" in message) relayLogRecord(message.log);
      else outcome = message.outcome;
    });
    worker.on("error", (error: unknown) => {
      log.error("database upgrade worker failed", { error });
    });
    worker.once("exit", (code) => {
      if (outcome === null)
        log.error("database upgrade worker stopped without an answer", { code });
      resolve(outcome);
    });
  });
}
