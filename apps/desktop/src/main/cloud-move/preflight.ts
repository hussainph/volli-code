/**
 * The read-only dry run: what a move would carry, decided by running the real
 * exporter, the real verifier and the real plan over each selected project in
 * a scratch directory that is deleted again. Nothing is uploaded and nothing
 * local is written — the snapshot the exporter takes is `VACUUM INTO`, and the
 * project's own database file is only ever opened read-only by that worker.
 *
 * Each project fails alone: one refusal leaves the other projects' counts,
 * estimates and warnings in the answer, with the refused project named by a
 * plain sentence and no operating-system detail or record content.
 */
import { randomUUID } from "node:crypto";
import { mkdir, opendir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { isUuid, type MigrationTarget } from "@volli/shared/cloud";
import type {
  CloudMoveBlocker,
  CloudMoveCounts,
  CloudMovePreflight,
  CloudMovePreflightInput,
  CloudMoveProject,
} from "@volli/shared";
import {
  automaticBackupDiskRequirement,
  exportRecords,
  fileSha256,
  localProductRow,
  movePlan,
  runMigrationExportInWorker,
  verifyMigrationExport,
} from "@volli/host-core/migration-export";

import { countsForMove, MOVE_HISTORY_SETTLE_SECONDS } from "./facts";

// Validation only: these replace the export's identity placeholders in a discarded local plan.
// They never reach the backend, and a real move always uses its signed-in person's target.
const VALIDATION_TARGET: MigrationTarget = {
  userId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  runnerId: "00000000-0000-4000-8000-000000000003",
};
/** The move backup writer's own extra allowance (`createMoveBackupPort` defaults to the same). */
const HEADROOM_BYTES = 256 * 1024 * 1024;
/** The estimate's conservative starting rates: 1k records/s each way, 20 Mbit/s files, plus backup and setup. */
const ESTIMATE_FIXED_SECONDS = 120;
const ESTIMATE_ROWS_PER_SECOND = 500;
const ESTIMATE_FILE_BYTES_PER_SECOND = 2_500_000;
/** host-core's `BACKUPS_DIRECTORY`: the kept profile backups live beside the database. */
const BACKUP_DIRECTORY = "backups";
/** A project row is missing; the id alone is not shown, because a UUID tells a person nothing. */
const UNKNOWN_PROJECT = "Unavailable project";

/**
 * The work the exporter refuses to carry, and the Session each waiting row
 * belongs to. Its predicates are the manifest's `PENDING_RUNNER_FACTS` ones:
 * the same rows make the export stop, so a dry run that passed over one would
 * promise a move that cannot start.
 */
const PENDING_WORK = [
  [
    "session_follow_up_queue",
    "r.pending_count > 0",
    "Settle this Session’s queued messages first.",
  ],
  ["host_notice_outbox", "r.receipt IS NULL", "Deliver this Session’s waiting notices first."],
  [
    "automation_run_deliveries",
    "r.delivered_at IS NULL",
    "Settle this Session’s waiting Run messages first.",
  ],
] as const;

/**
 * An unfinished worktree cleanup, which the exporter counts as pending work for
 * the projects its intent names. Those rows carry their project inside JSON, so
 * this is the one blocker that cannot be attributed to a Session.
 */
const OPEN_CLEANUP = `SELECT c.id FROM worktree_cleanup_commands c
    WHERE NOT EXISTS (SELECT 1 FROM worktree_cleanup_receipts r
      WHERE r.command_id = c.id AND r.status IN ('completed','rejected'))
      AND NOT EXISTS (SELECT 1 FROM worktree_cleanup_facts f
        WHERE f.command_id = c.id AND f.kind = 'cleanup.run.interrupted')`;

interface LocalProject {
  id: string;
  name: string;
  removed_at: number | null;
}
export interface PreviewSummary {
  counts: CloudMoveCounts;
  estimatedExportBytes: number;
  pausedAutomations: string[];
  expected: Record<string, number>;
}
export interface PreparedLocalMoves {
  preflight: CloudMovePreflight;
  input: CloudMovePreflightInput;
  estimatedExportBytes: number;
  summaries: Record<string, PreviewSummary>;
  failures: Record<string, string>;
}
export interface MovePreflightOptions {
  db: Database.Database;
  profilePath: string;
  workRoot: string;
  workerEntry: string | URL;
  appVersion: string;
  stores: { blobsDir: string; transcriptsDir: string; piLogsDir: string };
  busySessionIds(): ReadonlySet<string>;
  hasMove(projectId: string): boolean;
  hasCloudCopy?(projectId: string): boolean;
  eventRecord(record: Record<string, unknown>): Record<string, unknown>;
  workerExecArgv?: string[];
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
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
    else if (entry.isFile()) bytes += await fileBytes(child);
  }
  return bytes;
}

/**
 * Why this project cannot move as it stands. Every check here is one the export
 * or the move engine itself performs, so passing the dry run means passing
 * them too, and each names the Session a person has to settle.
 */
function projectBlockers(options: MovePreflightOptions, projectId: string): CloudMoveBlocker[] {
  // A project id is also a directory name under the scratch root.
  if (!isUuid(projectId)) return [{ message: "This project has an unsupported local identifier." }];
  const blockers: CloudMoveBlocker[] = [];
  if (options.hasCloudCopy?.(projectId))
    blockers.push({
      message:
        "Volli Cloud keeps a copy of this project. Moving again would not merge its changes.",
    });
  if (options.hasMove(projectId))
    blockers.push({ message: "This project already has a move. Open its progress to continue." });
  // The engine's own idle check reads every Session of the project, drained and
  // cloud-born ones included, so the dry run must not stop short of that.
  const busy = options.busySessionIds();
  if (busy.size > 0) {
    const own = options.db
      .prepare("SELECT s.id FROM sessions s WHERE s.project_id = ?")
      .all(projectId) as { id: string }[];
    for (const session of own)
      if (busy.has(session.id))
        blockers.push({
          message: "Finish this Session’s turn, shell or terminal first.",
          sessionId: session.id,
        });
  }
  // The exporter reads these tables through its selection views, which hold only
  // this project's *local* Sessions: a drained or cloud-born Session's queue is
  // not this Mac's work to settle and never stops the export.
  const local = localProductRow("s", "session");
  for (const [table, predicate, message] of PENDING_WORK) {
    const rows = options.db
      .prepare(`SELECT DISTINCT r.session_id AS id FROM ${table} r
      JOIN sessions s ON s.id = r.session_id
      WHERE s.project_id = ? AND ${local} AND ${predicate}`)
      .all(projectId) as { id: string }[];
    for (const row of rows) blockers.push({ message, sessionId: row.id });
  }
  const cleanup = options.db
    .prepare(`${OPEN_CLEANUP}
      AND EXISTS (SELECT 1 FROM json_each(c.intent,'$.items') item
        WHERE json_extract(item.value,'$.projectId') = ?) LIMIT 1`)
    .get(projectId);
  if (cleanup !== undefined)
    blockers.push({ message: "Let this project’s worktree cleanup finish first." });
  return blockers;
}

/** A source problem is named without forwarding an OS exception or quoting any record content. */
function problemOf(error: unknown): { code: string; message: string } {
  const raw = error as { code?: unknown } | null;
  const code = typeof raw?.code === "string" ? raw.code : "unreadable";
  if (code === "disk_full" || code === "ENOSPC")
    return { code: "disk_full", message: "Free disk space, then run the dry run again." };
  if (code === "row_refused" || code === "row_unstorable")
    return { code, message: "A local record has an unsupported identifier or format." };
  if (code === "source_corrupt")
    return { code, message: "A local record is inconsistent, so this project cannot move yet." };
  if (code === "integrity_failed")
    return { code, message: "The dry run’s own export did not verify. Run it again." };
  if (code === "io_failed")
    return {
      code,
      message: "This Mac refused to write the dry run. Check free space and file permissions.",
    };
  if (code === "worker_failed")
    return { code, message: "The dry run stopped unexpectedly. Run it again." };
  if (code === "cancelled") return { code, message: "The dry run was cancelled." };
  return { code, message: "This project could not pass the dry run. Its local copy is unchanged." };
}

/** A requested project this dry run cannot consider, with the one thing that would change it. */
function unavailable(id: string, known: LocalProject | undefined): CloudMoveProject {
  const removed = known !== undefined && known.removed_at !== null;
  return {
    id,
    name: known?.name ?? UNKNOWN_PROJECT,
    removed,
    counts: null,
    estimateSeconds: null,
    blockers: [
      {
        message: removed
          ? "This project was removed. Turn on Include removed projects to move it."
          : "This project is no longer a local project on this Mac.",
      },
    ],
    exclusions: [],
    warnings: [],
  };
}

/** Why the move's own warnings belong to this project: the other side is named, never the raw ids. */
const REFERENCE_LABELS: Record<string, string> = {
  delegation: "Session links",
  sharedBlob: "shared attachments",
  ticketKey: "ticket references",
};

export async function prepareLocalMoves(
  options: MovePreflightOptions,
  input: CloudMovePreflightInput,
  signal: AbortSignal,
): Promise<PreparedLocalMoves> {
  signal.throwIfAborted();
  const all = options.db
    .prepare(
      `SELECT p.id,p.name,p.removed_at FROM projects p WHERE ${localProductRow("p", "project")} ORDER BY p.sort_order,p.id`,
    )
    .all() as LocalProject[];
  const eligible = all.filter((project) => input.includeRemoved || project.removed_at === null);
  // `undefined` is Move all; an id list is a choice, and every id in it is
  // answered — including the ones this dry run will not export.
  const requested = input.projectIds === undefined ? null : [...new Set(input.projectIds)];
  const wanted = requested === null ? null : new Set(requested);
  const selected =
    wanted === null ? eligible : eligible.filter((project) => wanted.has(project.id));
  const chosen = new Set(selected.map((project) => project.id));
  const refused = requested?.filter((id) => !chosen.has(id)) ?? [];
  const byId = new Map(all.map((project) => [project.id, project]));
  const id = randomUUID();
  const root = join(options.workRoot, "preflight", id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const projects: CloudMoveProject[] = [];
  const summaries: Record<string, PreviewSummary> = {};
  const failures: Record<string, string> = {};
  let estimatedExportBytes = 0;
  try {
    for (const project of selected) {
      signal.throwIfAborted();
      const view: CloudMoveProject = {
        id: project.id,
        name: project.name,
        removed: project.removed_at !== null,
        counts: null,
        estimateSeconds: null,
        blockers: projectBlockers(options, project.id),
        exclusions: [],
        warnings: [],
      };
      projects.push(view);
      if (view.blockers.length > 0) continue;
      const workDir = join(root, project.id);
      const exportDir = join(workDir, "export");
      try {
        await runMigrationExportInWorker(
          options.workerEntry,
          {
            sourcePath: options.profilePath,
            outDir: exportDir,
            projectIds: [project.id],
            includeRemovedProjects: input.includeRemoved,
            appVersion: options.appVersion,
            blobsDir: options.stores.blobsDir,
            transcriptsDir: options.stores.transcriptsDir,
            piLogsDir: options.stores.piLogsDir,
          },
          {
            signal,
            ...(options.workerExecArgv === undefined ? {} : { execArgv: options.workerExecArgv }),
          },
        );
        const { manifest, bytes } = await verifyMigrationExport(exportDir);
        const plan = await movePlan({
          workDir,
          exportDir,
          manifest,
          exportManifestSha256: (await fileSha256(join(exportDir, "manifest.json"))).sha256,
          target: VALIDATION_TARGET,
          eventRecord: options.eventRecord,
          signal,
        });
        let transcriptBytes = 0;
        for await (const record of exportRecords(exportDir, manifest, "transcriptArtifacts")) {
          signal.throwIfAborted();
          // A stream's record is whatever the exporter wrote: read it as untyped.
          const canonical = record.canonicalJson;
          if (typeof canonical === "string")
            transcriptBytes += Buffer.byteLength(canonical, "utf8");
        }
        const counts = countsForMove(plan, {
          transcriptBytes,
          piLogBytes: manifest.piLogFiles.reduce((sum, file) => sum + file.fileBytes, 0),
        });
        const pausedAutomations: string[] = [];
        for await (const record of exportRecords(exportDir, manifest, "automations"))
          if (typeof record.name === "string") pausedAutomations.push(record.name);
        const estimate = bytes + counts.attachmentBytes;
        estimatedExportBytes += estimate;
        view.counts = counts;
        const rows = plan.expected.reduce((sum, stream) => sum + stream.count, 0);
        const transferBytes = counts.attachmentBytes + transcriptBytes + counts.piLogBytes;
        // History is uploaded through signed URLs, so the verify step waits them out first.
        const settling =
          transcriptBytes > 0 || counts.piLogBytes > 0 ? MOVE_HISTORY_SETTLE_SECONDS : 0;
        view.estimateSeconds =
          settling +
          Math.ceil(
            ESTIMATE_FIXED_SECONDS +
              rows / ESTIMATE_ROWS_PER_SECOND +
              transferBytes / ESTIMATE_FILE_BYTES_PER_SECOND,
          );
        if (pausedAutomations.length > 0)
          view.exclusions.push({
            label: "Automatic starts",
            count: pausedAutomations.length,
            reason: "Automations move paused; re-arm them in Volli Cloud.",
          });
        const automationNames = new Map<string, number>();
        for (const name of pausedAutomations)
          automationNames.set(name, (automationNames.get(name) ?? 0) + 1);
        for (const [name, total] of automationNames)
          view.exclusions.push({
            label: `Automation: ${name}`,
            count: total,
            reason: "Moves paused; re-arm it in Volli Cloud.",
          });
        // A clash or a reference is reported by the project it belongs to: every
        // project's manifest carries the whole profile's, and a person moving one
        // project is not being warned about another one's.
        for (const clash of manifest.prefixClashes) {
          if (!clash.projectIds.includes(project.id)) continue;
          view.warnings.push(
            `Ticket prefix ${clash.prefix} is used by ${clash.projectIds.length} projects; ticket keys may be ambiguous.`,
          );
        }
        for (const reference of manifest.crossProjectReferences) {
          if (reference.fromProjectId !== project.id) continue;
          const other =
            all.find((item) => item.id === reference.toProjectId)?.name ??
            "a project that stays on this Mac";
          view.warnings.push(
            `${reference.count} ${REFERENCE_LABELS[reference.kind] ?? "references"} to ${other}.`,
          );
        }
        summaries[project.id] = {
          counts,
          estimatedExportBytes: estimate,
          pausedAutomations,
          expected: Object.fromEntries(
            plan.expected.map((stream) => [stream.stream, stream.count]),
          ),
        };
      } catch (error) {
        signal.throwIfAborted();
        const problem = problemOf(error);
        failures[project.id] = problem.code;
        view.blockers.push({ message: problem.message });
      } finally {
        await rm(workDir, { recursive: true, force: true, maxRetries: 3 });
        await rm(`${exportDir}.partial`, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
  for (const refusedId of refused) projects.push(unavailable(refusedId, byId.get(refusedId)));
  const databaseBytes =
    (await fileBytes(options.profilePath)) + (await fileBytes(`${options.profilePath}-wal`));
  const artifactBytes =
    (await treeBytes(options.stores.blobsDir)) + (await treeBytes(options.stores.transcriptsDir));
  const backupDirectory = join(dirname(options.profilePath), BACKUP_DIRECTORY);
  // The move writer independently enforces this same bound again before writing
  // anything: the backup and its staging on the volume holding the database, and
  // the move's own reserve on the volume the exports are staged under. Both are
  // added only when one volume carries them — `statfs` reports free space but not
  // which volume, so the directories' own device numbers say whether they match.
  const backupRequired = automaticBackupDiskRequirement(databaseBytes, artifactBytes);
  const reserveBytes = 2 * estimatedExportBytes + HEADROOM_BYTES;
  const backupVolume = dirname(options.profilePath);
  const [backupSpace, exportSpace, backupDevice, exportDevice] = await Promise.all([
    statfs(backupVolume),
    statfs(options.workRoot),
    stat(backupVolume),
    stat(options.workRoot),
  ]);
  const freeOnBackup = backupSpace.bavail * backupSpace.bsize;
  const freeOnExport = exportSpace.bavail * exportSpace.bsize;
  // One answer for the person, about whichever volume runs out first.
  const disk =
    backupDevice.dev === exportDevice.dev
      ? { requiredBytes: backupRequired + reserveBytes, freeBytes: freeOnBackup }
      : freeOnBackup - backupRequired <= freeOnExport - reserveBytes
        ? { requiredBytes: backupRequired, freeBytes: freeOnBackup }
        : { requiredBytes: reserveBytes, freeBytes: freeOnExport };
  // Stop at the first problem: on for each single project and for the profile's
  // first queue of several, off once one has run before — the default the
  // engine's `enqueue` takes when it is not told, counted the same way.
  const priorMultiProjectQueues = options.db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT queue_id FROM cloud_moves
      GROUP BY queue_id HAVING COUNT(DISTINCT project_id) > 1)`)
    .get() as { n: number };
  const startable = projects.filter((project) => project.blockers.length === 0).length;
  return {
    input,
    estimatedExportBytes,
    summaries,
    failures,
    preflight: {
      id,
      projects,
      backupDirectory,
      disk,
      stopAtFirstProblem: startable <= 1 || priorMultiProjectQueues.n === 0,
      exclusions: [
        { label: "Personal files", reason: "Skills and templates stay on this Mac." },
        {
          label: "Secrets and API keys",
          reason:
            "Credentials stay sealed on this Mac; re-enter them on other machines or for teammates.",
        },
        {
          label: "Removed projects",
          reason: input.includeRemoved
            ? "Included only because you selected them."
            : "Not moved unless you include them.",
        },
      ],
    },
  };
}
