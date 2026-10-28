/** The queue's first step: a kept, whole-profile v1 backup, never a project export. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKUPS_DIRECTORY } from "../backup/automatic";
import { runAutomaticBackupWorker } from "../backup/automatic-worker";
import { ProfileBackupError } from "../backup/errors";
import type { MoveBackupPort } from "./ports";

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
export function createMoveBackupPort(options: MoveBackupOptions): MoveBackupPort {
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
        `pre-cloud-move-${new Date(now).toISOString().replaceAll(":", "-")}-${randomUUID()}.tar.gz`,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Written before delivery. There is no expiry: only the person removes this safety copy.
      await writeFile(`${path}.kept`, "", { flag: "wx", mode: 0o600 });
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
        signal.throwIfAborted();
        if (!result.sha256) throw new Error("Move backup worker did not return a digest.");
        return { path, bytes: result.sizeBytes, sha256: result.sha256 };
      } catch (error) {
        // The move engine already pauses on disk-full and AbortError, never on error prose.
        if (error instanceof ProfileBackupError && error.code === "disk-space")
          throw Object.assign(new Error(error.message, { cause: error }), { code: "ENOSPC" });
        if (error instanceof ProfileBackupError && error.code === "cancelled")
          throw new DOMException("Move backup cancelled.", "AbortError");
        throw error;
      }
    },
  };
}
