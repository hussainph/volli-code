/**
 * Why a migration export stopped. Each code names one recovery, so a caller
 * (the migration screen, VC-903) can show the one action that fixes it.
 *
 * - `cancelled` — the caller asked it to stop. The staging area is kept, and
 *   the next run resumes from the last checkpoint.
 * - `disk_full` — the volume ran out of room (or the preflight measured too
 *   little). Free space and run again; it resumes.
 * - `output_exists` — a complete export is already at the target path.
 * - `source_unreadable` — the database could not be opened or snapshotted.
 * - `schema_unsupported` — the database was written by a build this exporter
 *   does not know (newer than this build, or older than its floor).
 * - `source_corrupt` — the snapshot failed its integrity check, or holds a
 *   fact the cloud format cannot carry without a gap.
 * - `integrity_failed` — a written export does not match its manifest.
 * - `worker_failed` — the worker thread died without answering.
 */
export type MigrationExportErrorCode =
  | "cancelled"
  | "disk_full"
  | "output_exists"
  | "source_unreadable"
  | "schema_unsupported"
  | "source_corrupt"
  | "integrity_failed"
  | "worker_failed";

export const MIGRATION_EXPORT_ERROR_CODES: readonly MigrationExportErrorCode[] = [
  "cancelled",
  "disk_full",
  "output_exists",
  "source_unreadable",
  "schema_unsupported",
  "source_corrupt",
  "integrity_failed",
  "worker_failed",
];

export class MigrationExportError extends Error {
  override readonly name = "MigrationExportError";
  readonly code: MigrationExportErrorCode;
  constructor(code: MigrationExportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Whether an error is the filesystem or SQLite saying the disk is full. */
export function isDiskFullError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "SQLITE_FULL";
}
