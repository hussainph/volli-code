/** The host bundles this entry separately; no Electron APIs or writable database. */
import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import { errorMessage, reportSessionUsage } from "@volli/shared";
import { createSqliteSessionLedger } from "./sqlite-ledger";
import type { UsageReportAnswer, UsageReportJob } from "./usage-reports";

export function serveUsageReportWorker(): void {
  if (parentPort === null) throw new Error("Usage reader must run inside a worker thread");
  const port = parentPort;
  const { dbPath } = workerData as { dbPath: string };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  port.on("message", async (job: UsageReportJob | { type: "close" }) => {
    if ("type" in job) {
      db.close();
      port.close();
      return;
    }
    try {
      const ledger = createSqliteSessionLedger(
        db,
        job.predicate === undefined
          ? undefined
          : { predicate: () => job.predicate!, bindings: job.bindings },
      );
      const report = await ledger.transaction((tx) =>
        reportSessionUsage(tx.listUsage(job.query), {
          ...job.query,
          meteredFrom: tx.usageMeteredFrom(),
        }),
      );
      port.postMessage({ id: job.id, report } satisfies UsageReportAnswer);
    } catch (error) {
      port.postMessage({ id: job.id, error: errorMessage(error) } satisfies UsageReportAnswer);
    }
  });
  port.on("close", () => {
    if (db.open) db.close();
  });
}
