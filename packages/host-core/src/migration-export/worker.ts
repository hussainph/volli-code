/**
 * Runs the migration exporter in a worker thread, so the snapshot statement
 * and the hours of serialization never block the thread that serves the UI
 * and the Session runtime.
 *
 * The protocol is three messages out (`progress`, `done`, `failed`) and one
 * in (`cancel`), all JSON-safe. A cancel asks the worker to stop at its next
 * yield, which leaves a resumable staging area, and the worker answers
 * `failed: cancelled` once it has stopped writing. A single SQLite statement
 * cannot yield and cannot be interrupted, not even by `Worker.terminate()`:
 * the snapshot (`VACUUM INTO`, seconds per gigabyte), the integrity check and
 * a source's first sorted row each run to completion first. So after a grace
 * period the parent terminates the worker and settles only on its `exit`,
 * which comes when that statement returns; nothing is still writing to the
 * staging area when the caller hears "cancelled". The export is never
 * published, and a snapshot cut short has no `state.json`, so the next run
 * takes it again.
 *
 * Wiring: a host bundles `worker-entry.ts` as its own entry and passes that
 * file's URL to {@link runMigrationExportInWorker}. Bundlers each spell that
 * differently, which is why the entry is a parameter rather than a URL this
 * module computes. The receiving task is VC-903 (the migration screen).
 */
import { Worker, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { dirname } from "node:path";
import { withProfileMaintenance } from "../backup/profile-maintenance";
import {
  MIGRATION_EXPORT_ERROR_CODES,
  MigrationExportError,
  type MigrationExportErrorCode,
} from "./errors";
import {
  exportMigrationSnapshot,
  type MigrationExportProgress,
  type MigrationExportResult,
} from "./exporter";

/** What the worker is asked to export; every field crosses the thread boundary. */
export interface MigrationExportWorkerRequest {
  sourcePath: string;
  outDir: string;
  appVersion: string;
  projectIds?: readonly string[];
  includeRemovedProjects?: boolean;
  transcriptsDir?: string;
  piLogsDir?: string;
  blobsDir?: string;
  fresh?: boolean;
  integrityCheck?: boolean;
  chunkMaxBytes?: number;
  chunkMaxRecords?: number;
  measureHistory?: boolean;
  sharedSnapshot?: { keepAt: string } | { from: string };
}

export type MigrationExportWorkerMessage =
  | { type: "progress"; progress: MigrationExportProgress }
  | { type: "done"; result: MigrationExportResult }
  | { type: "failed"; code: MigrationExportErrorCode; message: string };

export type MigrationExportParentMessage = { type: "cancel" };

export interface RunMigrationExportInWorkerOptions {
  onProgress?: (progress: MigrationExportProgress) => void;
  signal?: AbortSignal;
  /** How long a cancel waits for the worker to stop itself before terminating it. Default 10 s. */
  cancelGraceMs?: number;
  /** Node options for the worker (a test passes its TypeScript loader here). */
  execArgv?: string[];
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;

function isErrorCode(value: unknown): value is MigrationExportErrorCode {
  return (MIGRATION_EXPORT_ERROR_CODES as readonly unknown[]).includes(value);
}

/** Starts the export in a worker at `entry` and settles with its result. */
export function runMigrationExportInWorker(
  entry: string | URL,
  request: MigrationExportWorkerRequest,
  options: RunMigrationExportInWorkerOptions = {},
): Promise<MigrationExportResult> {
  // The parent owns the pause, so a terminated/crashed worker cannot leave
  // a live-process lease behind for the rest of the app launch.
  return withProfileMaintenance(dirname(request.sourcePath), () =>
    startMigrationExportWorker(entry, request, options),
  );
}

function startMigrationExportWorker(
  entry: string | URL,
  request: MigrationExportWorkerRequest,
  options: RunMigrationExportInWorkerOptions,
): Promise<MigrationExportResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new MigrationExportError("cancelled", "The export was cancelled."));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, {
      workerData: request,
      ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
    });
    let settled = false;
    let cancelling = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    // Registered `once`, so a second abort never re-enters.
    const onAbort = () => {
      cancelling = true;
      // The empty transfer list is Node's second argument, not a browser target origin.
      worker.postMessage({ type: "cancel" } satisfies MigrationExportParentMessage, []);
      terminateTimer = setTimeout(() => {
        void worker.terminate();
      }, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: MigrationExportWorkerMessage) => {
      if (message.type === "progress") {
        options.onProgress?.(message.progress);
      } else if (message.type === "done") {
        settle(() => resolve(message.result));
      } else {
        const code = isErrorCode(message.code) ? message.code : "worker_failed";
        settle(() => reject(new MigrationExportError(code, message.message)));
      }
    });
    worker.on("error", (error) => {
      settle(() =>
        reject(
          new MigrationExportError("worker_failed", "The export worker failed.", { cause: error }),
        ),
      );
    });
    worker.on("exit", (exitCode) => {
      settle(() =>
        reject(
          cancelling
            ? new MigrationExportError("cancelled", "The export was cancelled.")
            : new MigrationExportError(
                "worker_failed",
                `The export worker exited (${exitCode}) without answering.`,
              ),
        ),
      );
    });
  });
}

/** The worker side: runs the export named by `data`, reporting over `port`. */
export function serveMigrationExportWorker(
  port: MessagePort | null = parentPort,
  data: unknown = workerData,
): void {
  if (port === null) throw new Error("serveMigrationExportWorker must run inside a worker thread");
  const request = data as MigrationExportWorkerRequest;
  const controller = new AbortController();
  const post = (message: MigrationExportWorkerMessage) => port.postMessage(message);
  port.on("message", (message: MigrationExportParentMessage) => {
    if (message.type === "cancel") controller.abort();
  });
  void exportMigrationSnapshot({
    ...request,
    signal: controller.signal,
    onProgress: (progress) => post({ type: "progress", progress }),
  })
    .then(
      (result) => post({ type: "done", result }),
      // `exportMigrationSnapshot` classifies every failure it throws.
      (error: MigrationExportError) =>
        post({ type: "failed", code: error.code, message: error.message }),
    )
    .finally(() => {
      // Nothing else is coming; let the thread exit once the answer is delivered.
      port.removeAllListeners("message");
      port.unref();
    });
}
