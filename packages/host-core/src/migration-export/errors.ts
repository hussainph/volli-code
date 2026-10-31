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
 * - `source_corrupt` — the snapshot failed its integrity check, SQLite
 *   reported it damaged, or it holds a fact the cloud format cannot carry
 *   without a gap.
 * - `pi_log_too_large` — a Session's Pi log holds one line (one record: a
 *   large tool output or an inline image) longer than a move carries
 *   (`PI_MOVE_LINE_MAX_BYTES`). Nothing local is wrong; the project stays on
 *   this Mac. Names the Session (`sessionId`).
 * - `pi_log_incomplete` — a Session's Pi log ends partway through a line, so
 *   its history cannot be copied whole. Names the Session (`sessionId`).
 * - `integrity_failed` — a written export does not match its manifest.
 * - `in_progress` — another run is exporting into the same target.
 * - `io_failed` — the filesystem refused something the export needed
 *   (permissions, a read-only volume, a path in the way).
 * - `worker_failed` — the worker thread died without answering.
 * - `internal` — anything else: a bug, with its message kept.
 */
export type MigrationExportErrorCode =
  | "cancelled"
  | "disk_full"
  | "output_exists"
  | "source_unreadable"
  | "schema_unsupported"
  | "source_corrupt"
  | "pi_log_too_large"
  | "pi_log_incomplete"
  | "integrity_failed"
  | "in_progress"
  | "io_failed"
  | "worker_failed"
  | "internal";

export const MIGRATION_EXPORT_ERROR_CODES: readonly MigrationExportErrorCode[] = [
  "cancelled",
  "disk_full",
  "output_exists",
  "source_unreadable",
  "schema_unsupported",
  "source_corrupt",
  "pi_log_too_large",
  "pi_log_incomplete",
  "integrity_failed",
  "in_progress",
  "io_failed",
  "worker_failed",
  "internal",
];

export interface MigrationExportErrorOptions extends ErrorOptions {
  /** The Session whose local history the refusal is about, when it is one Session's. */
  sessionId?: string;
}

export class MigrationExportError extends Error {
  override readonly name = "MigrationExportError";
  readonly code: MigrationExportErrorCode;
  readonly sessionId: string | undefined;
  constructor(
    code: MigrationExportErrorCode,
    message: string,
    options?: MigrationExportErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.sessionId = options?.sessionId;
  }
}

/** Whether an error is the filesystem or SQLite saying the disk is full. */
export function isDiskFullError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "SQLITE_FULL";
}
