/** A separately bundled worker entry keeps SQLite iteration and gzip off the UI thread. */
import { Worker, parentPort, workerData } from "node:worker_threads";
import { mkdir, mkdtemp, rename, rm, stat, statfs, opendir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay, setImmediate as yieldNow } from "node:timers/promises";
import Database from "better-sqlite3";
import { platform, totalmem } from "node:os";
import { parseFreePercentage } from "../process/memory-pressure";
import { runInventoryTool } from "../process/inventory";
import { profileMaintenanceActive } from "./profile-maintenance";
import { writeBackupBundleFile } from "./streaming";

export interface AutomaticBackupRequest {
  dataDir: string;
  dbPath: string;
  blobsRoot: string;
  transcriptsRoot: string;
  appVersion: string;
  outputPath: string;
  now: number;
}

type WorkerMessage =
  | { type: "notice"; notice: string | null }
  | { type: "done"; sizeBytes: number }
  | { type: "failed"; message: string };

export function runAutomaticBackupWorker(
  entry: string | URL,
  request: AutomaticBackupRequest,
  signal: AbortSignal,
  onNotice: (notice: string | null) => void,
  execArgv?: string[],
): Promise<{ sizeBytes: number }> {
  if (signal.aborted)
    return Promise.reject(new Error("Backup interrupted because Volli is closing."));
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, {
      workerData: request,
      ...(execArgv ? { execArgv } : {}),
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });
    let result: { sizeBytes: number } | undefined;
    let failure: Error | undefined;
    const cancel = () => worker.postMessage({ type: "cancel" }, []);
    signal.addEventListener("abort", cancel, { once: true });
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "notice") onNotice(message.notice);
      else if (message.type === "done") result = { sizeBytes: message.sizeBytes };
      else failure = new Error(message.message);
    });
    worker.on("error", (error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
    // Settle only when no worker can still be writing (including native backup()).
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", cancel);
      if (!failure && code === 0 && result) resolve(result);
      else reject(failure ?? new Error(`Backup worker stopped (${code}). Try Back up now.`));
    });
  });
}

/** Conservative bound includes JSON expansion and on-disk verification staging. */
export function automaticBackupDiskRequirement(
  databaseBytes: number,
  artifactBytes: number,
): number {
  return Math.max(64 * 1024 * 1024, databaseBytes * 12 + artifactBytes * 4);
}

async function treeBytes(path: string): Promise<number> {
  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let bytes = 0;
  for await (const entry of directory) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}

export async function createAutomaticBackup(
  request: AutomaticBackupRequest,
  checkpoint: () => Promise<void>,
): Promise<{ sizeBytes: number }> {
  await checkpoint();
  const directory = dirname(request.outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A killed worker cannot run finally. Reclaim only our scratch namespace,
  // never its archive (which remains available for diagnosis/recovery).
  for (const name of await readdir(directory)) {
    const match = /^\.automatic-(\d+)-[A-Za-z0-9]{6}$/.exec(name);
    if (!match) continue;
    let abandoned = Number(match[1]) === process.pid;
    if (!abandoned) {
      try {
        process.kill(Number(match[1]), 0);
      } catch (error) {
        abandoned = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (abandoned) await rm(join(directory, name), { recursive: true, force: true });
  }
  let databaseBytes = (await stat(request.dbPath)).size;
  try {
    databaseBytes += (await stat(`${request.dbPath}-wal`)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const artifacts =
    (await treeBytes(request.blobsRoot)) + (await treeBytes(request.transcriptsRoot));
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < automaticBackupDiskRequirement(databaseBytes, artifacts)) {
    throw new Error(
      "Backup skipped: not enough free disk space for two copies of the bundle and verification. Free disk space, then Back up now.",
    );
  }
  const workDir = await mkdtemp(join(directory, `.automatic-${process.pid}-`));
  const partial = `${request.outputPath}.partial`;
  try {
    await checkpoint();
    const source = new Database(request.dbPath, { readonly: true, fileMustExist: true });
    const snapshotPath = join(workDir, "snapshot.db");
    try {
      source.pragma("cache_size = -2048");
      await source.backup(snapshotPath);
    } finally {
      source.close();
    }
    await checkpoint();
    const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("cache_size = -2048");
      db.pragma("temp_store = FILE");
      const result = await writeBackupBundleFile({
        ...request,
        db,
        outputPath: partial,
        workDir,
        checkpoint,
      });
      await checkpoint();
      const remaining = await statfs(directory);
      if (remaining.bavail * remaining.bsize < result.sizeBytes * 2) {
        throw new Error(
          "Backup could not be published: free disk space is below twice the bundle size. The failed bundle was kept.",
        );
      }
      await rename(partial, request.outputPath);
      return result;
    } finally {
      db.close();
    }
  } catch (error) {
    try {
      await rename(partial, `${request.outputPath}.failed`);
    } catch (renameError) {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
    }
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function serveAutomaticBackupWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("Automatic backup must run in a worker.");
  const request = workerData as AutomaticBackupRequest;
  let cancelled = false;
  port.on("message", () => {
    cancelled = true;
  });
  let nextPressureCheck = 0;
  let underPressure = false;
  let lastNotice: string | null | undefined;
  const notice = (value: string | null) => {
    if (value !== lastNotice) {
      lastNotice = value;
      port.postMessage({ type: "notice", notice: value } satisfies WorkerMessage);
    }
  };
  const checkpoint = async () => {
    await yieldNow();
    for (;;) {
      if (cancelled)
        throw new Error(
          "Backup interrupted because Volli is closing; partial bundle kept as failed.",
        );
      if (Date.now() >= nextPressureCheck) {
        // Swap may remain allocated long after pressure has ended. Backups yield
        // on the current OS reading, not on historical swap allocation.
        const reading =
          platform() === "darwin" ? await runInventoryTool("memory_pressure", ["-Q"]) : null;
        const free = reading === null ? null : parseFreePercentage(reading);
        underPressure = free === null ? process.availableMemory() < totalmem() * 0.2 : free < 20;
        nextPressureCheck = Date.now() + 30_000;
      }
      const maintenance = await profileMaintenanceActive(request.dataDir);
      if (!underPressure && !maintenance) {
        notice(null);
        return;
      }
      notice(
        maintenance
          ? "Backup paused during a profile migration or move."
          : "Backup paused while memory is under pressure.",
      );
      await delay(1000);
    }
  };
  void createAutomaticBackup(request, checkpoint)
    .then(
      (result) => port.postMessage({ type: "done", ...result } satisfies WorkerMessage),
      (error: unknown) =>
        port.postMessage({
          type: "failed",
          message: error instanceof Error ? error.message : "Backup failed. Try Back up now.",
        } satisfies WorkerMessage),
    )
    .finally(() => {
      port.removeAllListeners();
      port.close();
    });
}
