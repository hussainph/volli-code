/** One bounded, reusable usage reader per database, never one worker per rail. */
import { Worker } from "node:worker_threads";
import type Database from "better-sqlite3";
import type { ReportSessionUsageQuery } from "@volli/session-engine";
import type { SessionUsageReport } from "@volli/shared";
import type { SqliteSessionLedgerScope } from "./sqlite-ledger";

export interface UsageReportJob {
  id: number;
  query: ReportSessionUsageQuery;
  /** Source-code predicate, already expanded with the usage table's id column. */
  predicate?: string;
  bindings?: SqliteSessionLedgerScope["bindings"];
}

export type UsageReportAnswer =
  | { id: number; report: SessionUsageReport }
  | { id: number; error: string };

type Reporter = (
  query: ReportSessionUsageQuery,
  scope?: SqliteSessionLedgerScope,
) => Promise<SessionUsageReport>;
const reporters = new WeakMap<Database.Database, Reporter>();

export function sqliteUsageReporter(db: Database.Database): Reporter | undefined {
  return reporters.get(db);
}

/**
 * Installed by host composition, before any reader is exposed. Scoped ledgers
 * sharing the writer's connection share this worker, but send their own SQL
 * predicate and bindings on EVERY request. No unscoped result cache crosses
 * an account boundary. The worker opens a separate read-only connection and
 * runs the existing codec and pure fold under one synchronous read snapshot.
 *
 * Only reports cross the thread boundary, not hundreds of thousands of rows.
 * Reads queue on one worker; it leaves after 30 seconds idle. Closing the host
 * rejects pending reads and terminates it before the database is closed.
 */
export function installSqliteUsageWorker(
  db: Database.Database,
  entry: string | URL,
): () => Promise<void> {
  let worker: Worker | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let stopped = false;
  const pending = new Map<
    number,
    { resolve(report: SessionUsageReport): void; reject(error: Error): void }
  >();

  const retiring = new Set<Promise<void>>();
  const retire = (error: Error, graceful = false): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    const old = worker;
    worker = undefined;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    if (old !== undefined) {
      const exited = new Promise<void>((resolve) => old.once("exit", () => resolve()));
      retiring.add(exited);
      void exited.then(() => retiring.delete(exited));
      if (graceful) {
        // Let the reader explicitly close its native SQLite handle. Keep the
        // thread referenced until exit so a shutdown join cannot be stranded.
        old.ref();
        try {
          old.postMessage({ type: "close" }, []);
        } catch {
          void old.terminate();
        }
      } else {
        void old.terminate();
      }
    }
  };

  const report: Reporter = (query, scope) => {
    if (stopped) return Promise.reject(new Error("Usage reader is closed"));
    if (idle !== undefined) clearTimeout(idle);
    idle = undefined;
    if (worker === undefined) {
      const current = new Worker(entry, { workerData: { dbPath: db.name } });
      worker = current;
      current.on("error", (error) => {
        if (worker === current) retire(error instanceof Error ? error : new Error(String(error)));
      });
      current.on("exit", (code) => {
        if (worker !== current) return;
        worker = undefined;
        retire(new Error(`Usage reader exited (${code})`));
      });
      current.on("message", (answer: UsageReportAnswer) => {
        if (worker !== current) return;
        const request = pending.get(answer.id);
        if (request === undefined) return;
        pending.delete(answer.id);
        if ("error" in answer) request.reject(new Error(answer.error));
        else request.resolve(answer.report);
        if (pending.size === 0) {
          current.unref();
          idle = setTimeout(() => retire(new Error("Usage reader idle"), true), 30_000);
          idle.unref();
        }
      });
    }
    worker.ref();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker!.postMessage(
          {
            id,
            query,
            ...(scope === undefined
              ? {}
              : {
                  predicate: scope.predicate("session_usage.session_id"),
                  bindings: scope.bindings,
                }),
          } satisfies UsageReportJob,
          [],
        );
      } catch (error) {
        retire(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  reporters.set(db, report);
  return () => {
    stopped = true;
    reporters.delete(db);
    retire(new Error("Usage reader is closed"), true);
    return Promise.all(retiring).then(() => undefined);
  };
}
