/** Deletes stale migration safety copies through an exact-name, single-directory allowlist. */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const BACKUP_RETENTION_LOG_PREFIX = "[migration backup retention]";

export type BackupSizeBytes = number | "unknown";

export interface BackupRetentionEntry {
  name: string;
  sizeBytes: BackupSizeBytes;
}

export interface BackupRetentionFailure extends BackupRetentionEntry {
  operation: "list" | "verify" | "remove";
  error: string;
}

export interface BackupRetentionReport {
  kept: BackupRetentionEntry[];
  removed: BackupRetentionEntry[];
  failed: BackupRetentionFailure[];
}

export interface BackupRetentionFileInfo {
  sizeBytes: number;
  isFile: boolean;
}

export interface BackupRetentionFs {
  readDirectory(directory: string): string[];
  readFileInfo(path: string): BackupRetentionFileInfo;
  removeFile(path: string): void;
}

const nodeFs: BackupRetentionFs = {
  readDirectory: (directory) => readdirSync(directory),
  readFileInfo: (path) => {
    const stats = lstatSync(path);
    return { sizeBytes: stats.size, isFile: stats.isFile() };
  },
  removeFile: (path) => unlinkSync(path),
};

interface MigrationBackupCandidate {
  name: string;
  path: string;
  version: bigint;
  sidecar: "-wal" | "-shm" | undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function migrationBackupCandidatePattern(dbPath: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename(dbPath))}\\.backup-v(\\d+)(-wal|-shm)?$`);
}

function sizeOf(candidate: MigrationBackupCandidate, fs: BackupRetentionFs): BackupSizeBytes {
  try {
    return fs.readFileInfo(candidate.path).sizeBytes;
  } catch {
    return "unknown";
  }
}

function reportEntry(
  candidate: MigrationBackupCandidate,
  fs: BackupRetentionFs,
): BackupRetentionEntry {
  return { name: candidate.name, sizeBytes: sizeOf(candidate, fs) };
}

export function pruneMigrationBackups(
  dbPath: string,
  currentVersion: number,
  fs: BackupRetentionFs = nodeFs,
): BackupRetentionReport {
  const report: BackupRetentionReport = { kept: [], removed: [], failed: [] };
  const directory = dirname(dbPath);
  const dbBasename = basename(dbPath);
  const currentBackupName = `${dbBasename}.backup-v${currentVersion}`;
  const candidatePattern = migrationBackupCandidatePattern(dbPath);

  let candidates: MigrationBackupCandidate[];
  try {
    candidates = fs
      .readDirectory(directory)
      .flatMap((name) => {
        const match = candidatePattern.exec(name);
        if (match === null) return [];
        return [
          {
            name,
            path: join(directory, name),
            version: BigInt(match[1]),
            sidecar: match[2] as "-wal" | "-shm" | undefined,
          },
        ];
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    report.failed.push({
      operation: "list",
      name: dbBasename,
      sizeBytes: "unknown",
      error: describeError(error),
    });
    return report;
  }

  const currentBackup = candidates.find(
    (candidate) => candidate.name === currentBackupName && candidate.sidecar === undefined,
  );
  if (currentBackup === undefined) {
    report.kept = candidates.map((candidate) => reportEntry(candidate, fs));
    report.failed.push({
      operation: "verify",
      name: currentBackupName,
      sizeBytes: "unknown",
      error: "this run's safety copy is missing",
    });
    return report;
  }

  let currentBackupInfo: BackupRetentionFileInfo;
  try {
    currentBackupInfo = fs.readFileInfo(currentBackup.path);
  } catch (error) {
    report.kept = candidates.map((candidate) => reportEntry(candidate, fs));
    report.failed.push({
      operation: "verify",
      name: currentBackupName,
      sizeBytes: "unknown",
      error: describeError(error),
    });
    return report;
  }
  if (!currentBackupInfo.isFile) {
    report.kept = candidates.map((candidate) => reportEntry(candidate, fs));
    report.failed.push({
      operation: "verify",
      name: currentBackupName,
      sizeBytes: currentBackupInfo.sizeBytes,
      error: "this run's safety copy is not a regular file",
    });
    return report;
  }

  let newestOtherBase: MigrationBackupCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.sidecar !== undefined || candidate.name === currentBackupName) continue;
    if (
      newestOtherBase === undefined ||
      candidate.version > newestOtherBase.version ||
      (candidate.version === newestOtherBase.version && candidate.name > newestOtherBase.name)
    ) {
      newestOtherBase = candidate;
    }
  }

  const keptBaseNames = new Set([currentBackupName]);
  if (newestOtherBase !== undefined) keptBaseNames.add(newestOtherBase.name);
  const keptVersions = new Set(
    candidates
      .filter((candidate) => candidate.sidecar === undefined && keptBaseNames.has(candidate.name))
      .map((candidate) => candidate.version.toString()),
  );

  for (const candidate of candidates) {
    const keep =
      candidate.sidecar === undefined
        ? keptBaseNames.has(candidate.name)
        : keptVersions.has(candidate.version.toString());
    if (keep) {
      report.kept.push(reportEntry(candidate, fs));
      continue;
    }

    const entry = reportEntry(candidate, fs);
    try {
      fs.removeFile(candidate.path);
      report.removed.push(entry);
    } catch (error) {
      report.failed.push({
        operation: "remove",
        ...entry,
        error: describeError(error),
      });
    }
  }

  return report;
}

export function logMigrationBackupRetention(
  report: BackupRetentionReport,
  logger: Pick<Console, "info" | "error"> = console,
): void {
  for (const entry of report.kept) {
    logger.info(BACKUP_RETENTION_LOG_PREFIX, { action: "kept", ...entry });
  }
  for (const entry of report.removed) {
    logger.info(BACKUP_RETENTION_LOG_PREFIX, { action: "removed", ...entry });
  }
  for (const failure of report.failed) {
    logger.error(BACKUP_RETENTION_LOG_PREFIX, { action: "failed", ...failure });
  }
}
