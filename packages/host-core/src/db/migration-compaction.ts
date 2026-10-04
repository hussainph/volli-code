import { statSync } from "node:fs";

export const MIGRATION_COMPACTION_LOG_PREFIX = "[migration compaction]";

const MINIMUM_FREE_BYTES = 32 * 1024 * 1024;
const MINIMUM_FREE_RATIO = 0.2;

export type MigrationCompactionMeasurement = number | "unknown";

export interface MigrationCompactionReport {
  ran: boolean;
  beforeBytes: MigrationCompactionMeasurement;
  afterBytes: MigrationCompactionMeasurement;
  freelistBefore: MigrationCompactionMeasurement;
  reason: string;
}

export interface MigrationCompactionDecision {
  shouldCompact: boolean;
  freeBytes: number;
  thresholdBytes: number;
}

/** The already-open connection methods used by post-migration compaction. */
export interface MigrationCompactionDatabase {
  exec(source: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

/** Injected so compaction can be tested without reading a profile from disk. */
export interface MigrationCompactionFileStat {
  fileSize(path: string): number;
}

const nodeFileStat: MigrationCompactionFileStat = {
  fileSize: (path) => statSync(path).size,
};

interface MeasurementResult {
  value: MigrationCompactionMeasurement;
  error?: string;
}

/** Pure threshold decision over SQLite's three page PRAGMA values. */
export function decideMigrationCompaction(
  pageSize: number,
  pageCount: number,
  freelistCount: number,
): MigrationCompactionDecision {
  const freeBytes = freelistCount * pageSize;
  const thresholdBytes = Math.max(MINIMUM_FREE_BYTES, MINIMUM_FREE_RATIO * pageCount * pageSize);
  return {
    shouldCompact: freeBytes >= thresholdBytes,
    freeBytes,
    thresholdBytes,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return `${code}: ${error.message}`;
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function readFileSize(dbPath: string, fileStat: MigrationCompactionFileStat): MeasurementResult {
  try {
    const value = fileStat.fileSize(dbPath);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`unexpected file size: ${String(value)}`);
    }
    return { value };
  } catch (error) {
    return { value: "unknown", error: describeError(error) };
  }
}

function readPagePragma(
  db: MigrationCompactionDatabase,
  name: "page_size" | "page_count" | "freelist_count",
): MeasurementResult {
  try {
    const value = db.pragma(name, { simple: true });
    const minimum = name === "page_size" ? 1 : 0;
    if (!Number.isInteger(value) || (value as number) < minimum) {
      throw new Error(`unexpected ${name} value: ${String(value)}`);
    }
    return { value: value as number };
  } catch (error) {
    return { value: "unknown", error: describeError(error) };
  }
}

function checkpointFailure(result: unknown): string | undefined {
  if (!Array.isArray(result) || result.length !== 1) {
    return `unexpected result ${safeJson(result)}`;
  }
  const row = result[0] as unknown;
  if (typeof row !== "object" || row === null) return `unexpected result ${safeJson(result)}`;
  const { busy, log, checkpointed } = row as Record<string, unknown>;
  if (typeof busy !== "number" || typeof log !== "number" || typeof checkpointed !== "number") {
    return `unexpected result ${safeJson(result)}`;
  }
  if (busy !== 0) return `busy=${busy} log=${log} checkpointed=${checkpointed}`;
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function withBeforeStatFailure(reason: string, before: MeasurementResult): string {
  return before.error === undefined
    ? reason
    : `${reason}; before-size stat failed: ${before.error}`;
}

/**
 * Measures and, when the pure threshold qualifies, compacts the already-open
 * connection. Every expected operational failure is returned as data so a
 * successful migration cannot be converted into a startup failure.
 */
export function compactMigrationDatabase(
  db: MigrationCompactionDatabase,
  dbPath: string,
  fileStat: MigrationCompactionFileStat = nodeFileStat,
): MigrationCompactionReport {
  const before = readFileSize(dbPath, fileStat);
  const pageSize = readPagePragma(db, "page_size");
  const pageCount = readPagePragma(db, "page_count");
  const freelist = readPagePragma(db, "freelist_count");
  const pragmaFailures = [
    ["page_size", pageSize],
    ["page_count", pageCount],
    ["freelist_count", freelist],
  ]
    .flatMap(([name, measurement]) => {
      const result = measurement as MeasurementResult;
      return result.error === undefined ? [] : [`${String(name)}=${result.error}`];
    })
    .join("; ");

  if (pragmaFailures.length > 0) {
    return {
      ran: false,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(`PRAGMA read failed: ${pragmaFailures}`, before),
    };
  }

  const decision = decideMigrationCompaction(
    pageSize.value as number,
    pageCount.value as number,
    freelist.value as number,
  );
  const thresholdDetail = `freeBytes=${decision.freeBytes} thresholdBytes=${decision.thresholdBytes}`;
  if (!decision.shouldCompact) {
    return {
      ran: false,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(`below threshold: ${thresholdDetail}`, before),
    };
  }

  try {
    db.exec("VACUUM");
  } catch (error) {
    return {
      ran: false,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(`VACUUM failed: ${describeError(error)}`, before),
    };
  }

  let checkpointResult: unknown;
  try {
    checkpointResult = db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (error) {
    return {
      ran: true,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(`checkpoint failed: ${describeError(error)}`, before),
    };
  }
  const checkpointError = checkpointFailure(checkpointResult);
  if (checkpointError !== undefined) {
    return {
      ran: true,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(`checkpoint failed: ${checkpointError}`, before),
    };
  }

  const after = readFileSize(dbPath, fileStat);
  if (after.error !== undefined) {
    return {
      ran: true,
      beforeBytes: before.value,
      afterBytes: "unknown",
      freelistBefore: freelist.value,
      reason: withBeforeStatFailure(
        `after-size stat failed: ${after.error}; compacted: ${thresholdDetail}`,
        before,
      ),
    };
  }
  return {
    ran: true,
    beforeBytes: before.value,
    afterBytes: after.value,
    freelistBefore: freelist.value,
    reason: withBeforeStatFailure(`compacted: ${thresholdDetail}`, before),
  };
}

/** Builds a structured non-attempt report without consulting SQLite page state. */
export function skippedMigrationCompaction(
  dbPath: string,
  reason: "no pending migrations" | "fresh database",
  fileStat: MigrationCompactionFileStat = nodeFileStat,
): MigrationCompactionReport {
  const before = readFileSize(dbPath, fileStat);
  return {
    ran: false,
    beforeBytes: before.value,
    afterBytes: "unknown",
    freelistBefore: "unknown",
    reason: withBeforeStatFailure(reason, before),
  };
}

function isFailure(report: MigrationCompactionReport): boolean {
  return (
    report.reason.startsWith("PRAGMA read failed:") ||
    report.reason.startsWith("VACUUM failed:") ||
    report.reason.startsWith("checkpoint failed:") ||
    report.reason.startsWith("after-size stat failed:")
  );
}

/** Logging stays outside the operation so callers control where reports go. */
export function logMigrationCompaction(
  report: MigrationCompactionReport,
  logger: Pick<Console, "info" | "error"> = console,
): void {
  if (isFailure(report)) logger.error(MIGRATION_COMPACTION_LOG_PREFIX, report);
  else logger.info(MIGRATION_COMPACTION_LOG_PREFIX, report);
}
