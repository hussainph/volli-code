/** The queue's first step: a kept, whole-profile v1 backup, never a project export. */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKUPS_DIRECTORY } from "../backup/automatic";
import { runAutomaticBackupWorker } from "../backup/automatic-worker";
import { ProfileBackupError } from "../backup/errors";
import { profileOwnerAlive } from "../backup/profile-maintenance";
import type { MoveBackupPort } from "./ports";
import { hostLogger } from "../log/root";

export interface MoveBackupOptions {
  workerEntry: string | URL;
  dataDir: string;
  dbPath: string;
  blobsRoot: string;
  transcriptsRoot: string;
  appVersion: string;
  /** The engine's staging root, including when the chosen backup folder is on another volume. */
  workRoot: string;
  /** Conservative total export estimate for the queue, not only its first project. */
  estimatedExportBytes: number;
  /** Defaults to 256 MiB in addition to the backup writer's own staging allowance. */
  headroomBytes?: number;
  directory?: string;
  now?: () => number;
  onNotice?: (notice: string | null) => void;
  workerExecArgv?: string[];
}

/** Composed by the move UI beside withProfileMaintenance for the whole engine run. */
export function createMoveBackupPort(options: MoveBackupOptions) {
  const headroomBytes = options.headroomBytes ?? 256 * 1024 * 1024;
  for (const value of [options.estimatedExportBytes, headroomBytes]) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value * 2))
      throw new RangeError("Move disk estimates must be non-negative safe byte counts.");
  }
  return {
    async write(signal) {
      signal.throwIfAborted();
      const now = (options.now ?? Date.now)();
      const directory = options.directory ?? join(options.dataDir, BACKUPS_DIRECTORY);
      const path = join(
        directory,
        `pre-cloud-move-${new Date(now).toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID()}.tar.gz`,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await reclaimInterruptedBackups(directory);
      try {
        const result = await runAutomaticBackupWorker(
          options.workerEntry,
          {
            dataDir: options.dataDir,
            dbPath: options.dbPath,
            blobsRoot: options.blobsRoot,
            transcriptsRoot: options.transcriptsRoot,
            appVersion: options.appVersion,
            outputPath: path,
            now,
            move: {
              exportRoot: options.workRoot,
              estimatedExportBytes: options.estimatedExportBytes,
              headroomBytes,
            },
          },
          signal,
          options.onNotice ?? (() => {}),
          options.workerExecArgv,
        );
        if (!result.sha256) throw new Error("Move backup worker did not return a digest.");
        // No expiry. Do not throw on a late cancellation after publication: the
        // engine must journal this result before it honors cancellation at freeze.
        await writeFile(`${path}.kept`, "", { flag: "wx", mode: 0o600 });
        return { path, bytes: result.sizeBytes, sha256: result.sha256 };
      } catch (error) {
        // The worker has exited, so these exact, exclusively owned paths cannot
        // still be written. Only successful safety copies are kept indefinitely.
        await removeBackupFiles(path, { removeFinal: true });
        // The move engine already pauses on disk-full and AbortError, never on error prose.
        if (error instanceof ProfileBackupError && error.code === "disk-space")
          throw Object.assign(new Error(error.message, { cause: error }), { code: "ENOSPC" });
        if (error instanceof ProfileBackupError && error.code === "cancelled")
          throw new DOMException("Move backup cancelled.", "AbortError");
        throw error;
      }
    },
  } satisfies MoveBackupPort;
}

/** A dead process cannot finish its partial. Never reclaim a final safety copy,
 * or another live worker's scratch (including one paused under this move).
 */
async function reclaimInterruptedBackups(directory: string): Promise<void> {
  const abandoned = new Set<string>();
  for (const name of await readdir(directory)) {
    const match =
      /^(pre-cloud-move-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(\d+)-[a-f0-9-]{36}\.tar\.gz)\.(?:work|partial|failed(?:\.json)?)$/.exec(
        name,
      );
    if (match && !profileOwnerAlive(Number(match[2]))) abandoned.add(match[1]!);
  }
  for (const name of abandoned) {
    const path = join(directory, name);
    await removeBackupFiles(path, { removeFinal: false });
  }
}

async function removeBackupFiles(path: string, options: { removeFinal: boolean }): Promise<void> {
  const files = ["partial", "failed", "failed.json"].map((suffix) => `${path}.${suffix}`);
  if (options.removeFinal) files.push(path, `${path}.kept`);
  const results = await Promise.allSettled([
    rm(`${path}.work`, { recursive: true, force: true }),
    ...files.map((file) => rm(file, { force: true })),
  ]);
  for (const result of results) {
    if (result.status === "rejected")
      hostLogger("cloud-move").warn("move backup cleanup incomplete", { error: result.reason });
  }
}
