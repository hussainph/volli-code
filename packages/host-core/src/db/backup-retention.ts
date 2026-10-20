/** Deletes stale migration safety copies through an exact-name, single-directory allowlist. */
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Logger } from "../log/logger";
import { hostLogger } from "../log/root";
import { verifyMigrationBackup } from "./backup-integrity";

const log = hostLogger("backup-retention");

export type BackupSizeBytes = number | "unknown";

export interface BackupRetentionEntry {
  name: string;
  sizeBytes: BackupSizeBytes;
}

export interface BackupRetentionFailure extends BackupRetentionEntry {
  operation: "list" | "verify" | "quarantine" | "remove";
  error: string;
}

export interface BackupRetentionReport {
  kept: BackupRetentionEntry[];
  removed: BackupRetentionEntry[];
  quarantined: BackupRetentionEntry[];
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
  verifyIntegrity(path: string): void;
  quarantineFile(path: string, destination: string): void;
}

const nodeFs: BackupRetentionFs = {
  readDirectory: (directory) => readdirSync(directory),
  readFileInfo: (path) => {
    const stats = lstatSync(path);
    return { sizeBytes: stats.size, isFile: stats.isFile() };
  },
  removeFile: (path) => unlinkSync(path),
  verifyIntegrity: verifyMigrationBackup,
  quarantineFile: (path, destination) => renameSync(path, destination),
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
  const report: BackupRetentionReport = { kept: [], removed: [], quarantined: [], failed: [] };
  const directory = dirname(dbPath);
  const dbBasename = basename(dbPath);
  const currentBackupName = `${dbBasename}.backup-v${currentVersion}`;
  const candidatePattern = migrationBackupCandidatePattern(dbPath);

  let candidates: MigrationBackupCandidate[];
  const preservedBaseNames = new Set<string>();
  try {
    const names = fs.readDirectory(directory);
    const preservedPattern = new RegExp(
      `^${escapeRegExp(dbBasename)}\\.backup-v\\d+\\.(?:corrupt|preserved)-[\\da-f-]+$`,
    );
    for (const name of names) {
      if (preservedPattern.test(name))
        preservedBaseNames.add(name.replace(/\.(?:corrupt|preserved)-[\da-f-]+$/, ""));
    }
    candidates = names
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
    report.failed.push({
      operation: "verify",
      name: currentBackupName,
      sizeBytes: "unknown",
      error: "this run's safety copy is missing",
    });
  }

  const unsafeNames = new Set<string>();
  const verify = (candidate: MigrationBackupCandidate): boolean => {
    try {
      const info = fs.readFileInfo(candidate.path);
      if (!info.isFile) throw new Error("safety copy is not a regular file");
      fs.verifyIntegrity(candidate.path);
      return true;
    } catch (error) {
      report.failed.push({
        operation: "verify",
        ...reportEntry(candidate, fs),
        error: describeError(error),
      });
      // Keep failed checks out of the rollback allowlist. One suffix preserves
      // the base/sidecar relationship; quarantined files are never pruned.
      const suffix = `.corrupt-${randomUUID()}`;
      const family = [
        candidate,
        ...candidates.filter(
          (item) => item.name === `${candidate.name}-wal` || item.name === `${candidate.name}-shm`,
        ),
      ];
      for (const member of family) unsafeNames.add(member.name);
      const moved: {
        member: MigrationBackupCandidate;
        destination: string;
        entry: BackupRetentionEntry;
      }[] = [];
      for (const member of family) {
        const entry = reportEntry(member, fs);
        const destination = `${candidate.path}${suffix}${member.sidecar ?? ""}`;
        try {
          // Move the base first; never detach its WAL if that move fails.
          if (!fs.readFileInfo(member.path).isFile) {
            throw new Error("not a regular file", { cause: error });
          }
          fs.quarantineFile(member.path, destination);
          moved.push({ member, destination, entry });
        } catch (quarantineError) {
          report.failed.push({
            operation: "quarantine",
            ...entry,
            error: describeError(quarantineError),
          });
          // Restore sidecars before restoring the base. If rollback fails,
          // leave the base quarantined, never an incomplete rollback point.
          while (moved.length > 0) {
            const last = moved.at(-1)!;
            try {
              fs.quarantineFile(last.destination, last.member.path);
              moved.pop();
            } catch (rollbackError) {
              report.failed.push({
                operation: "quarantine",
                ...last.entry,
                error: `quarantine rollback failed: ${describeError(rollbackError)}`,
              });
              break;
            }
          }
          break;
        }
      }
      for (const { destination, entry } of moved) {
        report.quarantined.push({ ...entry, name: basename(destination) });
      }
      return false;
    }
  };

  // An unreadable or corrupt new copy must never authorize deletion. Still
  // check the older copies so failed checks are not logged as rollback points.
  const currentIsClean = currentBackup !== undefined && verify(currentBackup);

  let newestOtherBase: MigrationBackupCandidate | undefined;
  let newestOlderBase: MigrationBackupCandidate | undefined;
  for (const candidate of candidates) {
    if (candidate.sidecar !== undefined || candidate.name === currentBackupName) continue;
    if (!verify(candidate)) continue;
    if (
      candidate.version < BigInt(currentVersion) &&
      (newestOlderBase === undefined ||
        candidate.version > newestOlderBase.version ||
        (candidate.version === newestOlderBase.version && candidate.name > newestOlderBase.name))
    ) {
      newestOlderBase = candidate;
    }
    if (
      newestOtherBase === undefined ||
      candidate.version > newestOtherBase.version ||
      (candidate.version === newestOtherBase.version && candidate.name > newestOtherBase.name)
    ) {
      newestOtherBase = candidate;
    }
  }

  if (!currentIsClean) {
    report.kept = candidates
      .filter((candidate) => !unsafeNames.has(candidate.name))
      .map((candidate) => reportEntry(candidate, fs));
    return report;
  }

  const keptBaseNames = new Set([currentBackupName]);
  if (newestOtherBase !== undefined) keptBaseNames.add(newestOtherBase.name);
  // After a restore, a future-version copy must not displace the newest
  // earlier clean recovery point. This only adds a third copy on that path.
  if (newestOlderBase !== undefined) keptBaseNames.add(newestOlderBase.name);
  const keptVersions = new Set(
    candidates
      .filter((candidate) => candidate.sidecar === undefined && keptBaseNames.has(candidate.name))
      .map((candidate) => candidate.version.toString()),
  );

  for (const candidate of candidates) {
    if (unsafeNames.has(candidate.name)) continue;
    const keep =
      candidate.sidecar === undefined
        ? keptBaseNames.has(candidate.name)
        : keptVersions.has(candidate.version.toString()) ||
          // A partial preservation/quarantine may leave a sidecar at its
          // original name. Keep it for recovery alongside the base held aside.
          preservedBaseNames.has(candidate.name.slice(0, -candidate.sidecar.length));
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
  logger: Pick<Logger, "info" | "error"> = log,
): void {
  for (const entry of report.kept) {
    logger.info("migration backup kept", { action: "kept", ...entry });
  }
  for (const entry of report.removed) {
    logger.info("migration backup removed", { action: "removed", ...entry });
  }
  for (const entry of report.quarantined) {
    logger.error("migration backup quarantined", { action: "quarantined", ...entry });
  }
  for (const failure of report.failed) {
    logger.error("migration backup retention failed", { action: "failed", ...failure });
  }
}
