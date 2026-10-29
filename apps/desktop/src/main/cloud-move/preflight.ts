/** Read-only dry runs use the real exporter, verifier and move plan. Each project fails alone. */
import { randomUUID } from "node:crypto";
import { mkdir, opendir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { isUuid, type MigrationTarget } from "@volli/shared/cloud";
import type { CloudMoveBlocker, CloudMoveCounts, CloudMovePreflight, CloudMovePreflightInput, CloudMoveProject } from "@volli/shared";
import {
  automaticBackupDiskRequirement, exportRecords, fileSha256, localProductRow, movePlan,
  runMigrationExportInWorker, verifyMigrationExport,
} from "@volli/host-core/migration-export";

// Validation only: these replace the export's identity placeholders in a discarded local plan.
// They never reach the backend, and a real move always uses its signed-in person's target.
const VALIDATION_TARGET: MigrationTarget = {
  userId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  runnerId: "00000000-0000-4000-8000-000000000003",
};
const HEADROOM = 256 * 1024 * 1024;
interface LocalProject { id: string; name: string; removed_at: number | null }
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
  eventRecord(record: Record<string, unknown>): Record<string, unknown>;
  workerExecArgv?: string[];
}

async function fileBytes(path: string): Promise<number> {
  try { return (await stat(path)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}
async function treeBytes(path: string): Promise<number> {
  let directory;
  try { directory = await opendir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let bytes = 0;
  for await (const entry of directory) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(child);
    else if (entry.isFile()) bytes += await fileBytes(child);
  }
  return bytes;
}

function projectBlockers(options: MovePreflightOptions, projectId: string): CloudMoveBlocker[] {
  if (!isUuid(projectId)) return [{ message: "This project has an unsupported local identifier." }];
  if (options.hasMove(projectId)) return [{ message: "This project already has a move. Open its progress to continue." }];
  const blockers: CloudMoveBlocker[] = [];
  const busy = options.busySessionIds();
  const own = options.db.prepare(`SELECT s.id FROM sessions s WHERE s.project_id = ? AND ${localProductRow("s", "session")}`).all(projectId) as { id: string }[];
  for (const session of own) if (busy.has(session.id)) blockers.push({ message: "Finish this Session’s turn, shell or terminal first.", sessionId: session.id });
  const pending = [
    ["session_follow_up_queue", "r.pending_count > 0", "Settle this Session’s queued messages first."],
    ["host_notice_outbox", "r.receipt IS NULL", "Deliver this Session’s waiting notices first."],
    ["automation_run_deliveries", "r.delivered_at IS NULL", "Settle this Session’s waiting Run messages first."],
  ] as const;
  for (const [table, predicate, message] of pending) {
    const rows = options.db.prepare(`SELECT DISTINCT r.session_id AS id FROM ${table} r JOIN sessions s ON s.id = r.session_id WHERE s.project_id = ? AND ${localProductRow("s", "session")} AND ${predicate}`).all(projectId) as { id: string }[];
    for (const row of rows) blockers.push({ message, sessionId: row.id });
  }
  return blockers;
}

/** A source problem is named without forwarding an OS exception or quoting any record content. */
function problemOf(error: unknown): { code: string; message: string } {
  const raw = error as { code?: unknown } | null;
  const code = typeof raw?.code === "string" ? raw.code : "unreadable";
  if (code === "disk_full" || code === "ENOSPC") return { code: "disk_full", message: "Free disk space, then run the dry run again." };
  if (code === "row_refused" || code === "row_unstorable") return { code, message: "A local record has an unsupported identifier or format." };
  if (code === "cancelled") return { code, message: "The dry run was cancelled." };
  return { code, message: "This project could not pass the dry run. Its local copy is unchanged." };
}

export async function prepareLocalMoves(options: MovePreflightOptions, input: CloudMovePreflightInput, signal: AbortSignal): Promise<PreparedLocalMoves> {
  signal.throwIfAborted();
  const all = options.db.prepare(`SELECT p.id,p.name,p.removed_at FROM projects p WHERE ${localProductRow("p", "project")} ORDER BY p.sort_order,p.id`).all() as LocalProject[];
  const selectedIds = input.projectIds === undefined ? null : new Set(input.projectIds);
  const selected = all.filter((project) => (selectedIds === null || selectedIds.has(project.id)) && (input.includeRemoved || project.removed_at === null));
  if (selectedIds !== null && selected.length !== selectedIds.size) throw new Error("A selected local project is no longer eligible.");
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
      const view: CloudMoveProject = { id: project.id, name: project.name, removed: project.removed_at !== null, counts: null, estimateSeconds: null, blockers: projectBlockers(options, project.id), exclusions: [], warnings: [] };
      projects.push(view);
      if (view.blockers.length > 0) continue;
      const workDir = join(root, project.id);
      const exportDir = join(workDir, "export");
      try {
        await runMigrationExportInWorker(options.workerEntry, {
          sourcePath: options.profilePath, outDir: exportDir, projectIds: [project.id], includeRemovedProjects: input.includeRemoved, appVersion: options.appVersion,
          blobsDir: options.stores.blobsDir, transcriptsDir: options.stores.transcriptsDir, piLogsDir: options.stores.piLogsDir,
        }, { signal, ...(options.workerExecArgv === undefined ? {} : { execArgv: options.workerExecArgv }) });
        const { manifest, bytes } = await verifyMigrationExport(exportDir);
        const plan = await movePlan({ workDir, exportDir, manifest, exportManifestSha256: (await fileSha256(join(exportDir, "manifest.json"))).sha256, target: VALIDATION_TARGET, eventRecord: options.eventRecord, signal });
        let transcriptBytes = 0;
        for await (const record of exportRecords(exportDir, manifest, "transcriptArtifacts")) {
          signal.throwIfAborted();
          transcriptBytes += Buffer.byteLength(record.canonicalJson as string, "utf8");
        }
        const counts: CloudMoveCounts = {
          tickets: plan.exported.tickets ?? 0, sessions: plan.exported.sessions ?? 0, events: plan.exported.sessionEvents ?? 0,
          attachments: plan.exported.blobs ?? 0,
          attachmentBytes: plan.objects.filter((object) => object.source === "blob").reduce((sum, object) => sum + object.bytes, 0),
          transcriptBytes,
          piLogBytes: manifest.piLogFiles.reduce((sum, file) => sum + file.fileBytes, 0),
        };
        const pausedAutomations: string[] = [];
        for await (const record of exportRecords(exportDir, manifest, "automations")) if (typeof record.name === "string") pausedAutomations.push(record.name);
        const estimate = bytes + counts.attachmentBytes;
        estimatedExportBytes += estimate;
        view.counts = counts;
        // Conservative starting rates: 1k records/s each way, 20 Mbit/s files, plus backup/setup.
        view.estimateSeconds = Math.ceil(120 + plan.expected.reduce((sum, stream) => sum + stream.count, 0) / 500 + (counts.attachmentBytes + transcriptBytes + counts.piLogBytes) / 2_500_000);
        if (pausedAutomations.length > 0) view.exclusions.push({ label: "Automatic starts", count: pausedAutomations.length, reason: "Automations move paused; re-arm them in Volli Cloud." });
        for (const clash of manifest.prefixClashes) view.warnings.push(`Ticket prefix ${clash.prefix} is used by ${clash.projectIds.length} projects; ticket keys may be ambiguous.`);
        for (const reference of manifest.crossProjectReferences) {
          const other = all.find((item) => item.id === reference.toProjectId)?.name ?? "another local project";
          view.warnings.push(`${reference.count} ${reference.kind === "delegation" ? "Session links" : reference.kind === "sharedBlob" ? "shared attachments" : "ticket references"} to ${other}.`);
        }
        summaries[project.id] = { counts, estimatedExportBytes: estimate, pausedAutomations, expected: Object.fromEntries(plan.expected.map((stream) => [stream.stream, stream.count])) };
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
  const databaseBytes = await fileBytes(options.profilePath) + await fileBytes(`${options.profilePath}-wal`);
  const artifactBytes = await treeBytes(options.stores.blobsDir) + await treeBytes(options.stores.transcriptsDir);
  // The backup writer independently enforces this same bound again before writing anything.
  const requiredBytes = automaticBackupDiskRequirement(databaseBytes, artifactBytes) + 2 * estimatedExportBytes + HEADROOM;
  const disk = await statfs(dirname(options.profilePath));
  const queueCount = options.db.prepare("SELECT COUNT(*) AS n FROM (SELECT queue_id FROM cloud_moves GROUP BY queue_id HAVING COUNT(DISTINCT project_id) > 1)").get() as { n: number };
  return { input, estimatedExportBytes, summaries, failures, preflight: { id, projects, backupDirectory: join(dirname(options.profilePath), "backups"), disk: { requiredBytes, freeBytes: disk.bavail * disk.bsize }, stopAtFirstProblem: projects.length === 1 || queueCount.n === 0, exclusions: [
    { label: "Personal files", reason: "Skills and templates stay on this Mac." },
    { label: "Secrets and API keys", reason: "Credentials stay sealed on this Mac." },
    { label: "Removed projects", reason: input.includeRemoved ? "Included only because you selected them." : "Not moved unless you include them." },
  ] } };
}
