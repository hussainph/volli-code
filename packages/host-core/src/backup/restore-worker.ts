import { errorMessage } from "@volli/shared";
import { randomUUID } from "node:crypto";
import { Worker, parentPort, workerData } from "node:worker_threads";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { platform, totalmem } from "node:os";
import { parseFreePercentage } from "../process/memory-pressure";
import { runInventoryTool } from "../process/inventory";
import { setImmediate as yieldNow, setTimeout as delay } from "node:timers/promises";
import { restoreBackupBundleFile, type RestoreResult } from "./restore";
import { DATA_PATH } from "./bundle";
import { openVerifiedBackupBundleFile } from "./streaming";
import { activateScheduledBackupRestore } from "./restore-schedule";

export type RestoreWorkerRequest =
  | { kind: "inspect"; root: string; bundlePath: string }
  | {
      kind: "stage";
      root: string;
      bundlePath: string;
      projectPaths: Record<string, string>;
      now: number;
      expectedDataSha256?: string;
    }
  | { kind: "activate"; root: string };
export type RestoreWorkerResult =
  | RestoreResult
  | {
      ok: true;
      projects: { id: string; name: string }[];
      dataSha256: string;
    }
  | { ok: true; activated: true };

/** Settles only after the worker exits: a cancelled attempt can no longer write. */
export function runRestoreWorker(
  entry: string | URL,
  request: RestoreWorkerRequest,
  signal: AbortSignal,
  onCheckpoint: (count: number, paused: boolean) => void,
  execArgv?: string[],
): Promise<RestoreWorkerResult> {
  if (signal.aborted) return Promise.reject(new Error("Restore cancelled."));
  return new Promise((resolve, reject) => {
    const inspectWork =
      request.kind === "inspect"
        ? join(request.root, `.volli-inspect-${process.pid}-${randomUUID()}`)
        : null;
    const worker = new Worker(entry, {
      workerData: inspectWork ? { ...request, workDir: inspectWork } : request,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
      ...(execArgv ? { execArgv } : {}),
    });
    let result: RestoreWorkerResult | undefined;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      worker.postMessage({ cancel: true }, []);
      if (request.kind !== "activate") timer = setTimeout(() => void worker.terminate(), 5000);
    };
    signal.addEventListener("abort", cancel, { once: true });
    worker.on(
      "message",
      (message: {
        checkpoints?: number;
        paused?: boolean;
        result?: RestoreWorkerResult;
        error?: string;
      }) => {
        if (message.checkpoints !== undefined)
          onCheckpoint(message.checkpoints, message.paused ?? false);
        if (message.result) result = message.result;
        if (message.error) failure = new Error(message.error);
      },
    );
    worker.on("error", (error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) {
        const cleanup =
          result?.ok && "report" in result && result.report.stagedPath
            ? rm(result.report.stagedPath, { recursive: true, force: true })
            : request.kind === "stage"
              ? rm(join(request.root, `.volli-restore-${request.now}`), {
                  recursive: true,
                  force: true,
                })
              : inspectWork
                ? rm(inspectWork, { recursive: true, force: true })
                : Promise.resolve();
        void cleanup.then(
          () => reject(new Error("Restore cancelled. The current profile is unchanged.")),
          reject,
        );
      } else if (!failure && code === 0 && result) resolve(result);
      else
        reject(
          failure ??
            new Error(
              `Restore worker stopped (${code}). The current profile has not been opened or changed by this attempt.`,
            ),
        );
    });
  });
}
export function serveRestoreWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("Restore must run in a worker.");
  const request = workerData as RestoreWorkerRequest & { workDir?: string };
  let cancelled = false;
  let checkpoints = 0;
  port.on("message", () => {
    cancelled = true;
  });
  let nextPressureCheck = 0;
  let underPressure = false;
  const checkpoint = async () => {
    await yieldNow();
    for (;;) {
      if (cancelled) throw new Error("Restore cancelled. The current profile is unchanged.");
      if (Date.now() >= nextPressureCheck) {
        const reading =
          platform() === "darwin" ? await runInventoryTool("memory_pressure", ["-Q"]) : null;
        const free = reading === null ? null : parseFreePercentage(reading);
        underPressure = free === null ? process.availableMemory() < totalmem() * 0.2 : free < 20;
        nextPressureCheck = Date.now() + 30_000;
      }
      if (!underPressure) {
        port.postMessage({ checkpoints: ++checkpoints, paused: false });
        return;
      }
      port.postMessage({ checkpoints, paused: true });
      await delay(250);
    }
  };
  const run = async (): Promise<RestoreWorkerResult> => {
    if (request.kind === "activate") {
      await activateScheduledBackupRestore(request.root);
      return { ok: true, activated: true };
    }
    await checkpoint();
    if (request.kind === "stage")
      return restoreBackupBundleFile({
        bundlePath: request.bundlePath,
        profileRoot: request.root,
        projectPaths: request.projectPaths,
        now: request.now,
        stageOnly: true,
        checkpoint,
        expectedDataSha256: request.expectedDataSha256,
      });
    const work = request.workDir;
    if (!work) throw new Error("Restore inspection requires supervisor-owned scratch space.");
    try {
      const result = await openVerifiedBackupBundleFile(request.bundlePath, work, checkpoint);
      if (!result.ok) return result;
      try {
        return {
          ok: true,
          projects: [...result.inventory.projects()],
          dataSha256: result.inventory.verifiedEntry(DATA_PATH)!.sha256,
        };
      } finally {
        result.inventory.close();
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
  void run()
    .then(
      (result) => port.postMessage({ result }),
      (error: unknown) => port.postMessage({ error: errorMessage(error) }),
    )
    .finally(() => {
      port.removeAllListeners();
      port.close();
    });
}
