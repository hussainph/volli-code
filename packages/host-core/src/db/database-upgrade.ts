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
 */
import type { LogLevel, LogRecord } from "@volli/shared";
import { parentPort, Worker, workerData } from "node:worker_threads";

import {
  classifyDbOpenFailure,
  dbOpenFailureLogLine,
  describeDbOpenFailure,
  type DbOpenFailure,
} from "../db-open-failure";
import { hostLogger, installHostLog } from "../log/root";
import { checkedDatabaseFile, openVolliDb, type CheckedDatabaseFile } from "./database-file";
import { logTransactionViolation } from "./transaction-gate";

export interface DatabaseUpgradeRequest {
  readonly dbPath: string;
  /** The host log's level: the worker formats nothing the host would drop. */
  readonly logLevel: LogLevel;
  /** A development build: the refusal is worded for its developer. */
  readonly dev: boolean;
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
export function upgradeVolliDb(dbPath: string): CheckedDatabaseFile | null {
  const db = openVolliDb(dbPath, { onTransactionViolation: logTransactionViolation });
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
  const request = workerData as DatabaseUpgradeRequest;
  installHostLog({
    level: request.logLevel,
    sink: { write: (record) => port.postMessage({ log: record } satisfies WorkerMessage) },
  });
  let outcome: DatabaseUpgradeOutcome;
  try {
    outcome = { ok: true, checked: upgradeVolliDb(request.dbPath) };
  } catch (error) {
    outcome = { ok: false, ...prepareDbOpenFailure(error, request.dev) };
  }
  port.postMessage({ outcome } satisfies WorkerMessage);
  port.close();
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
    try {
      worker = new Worker(entry, { workerData: request, ...(execArgv ? { execArgv } : {}) });
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
