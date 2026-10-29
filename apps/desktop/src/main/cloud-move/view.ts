/** Content-free desktop projection of the engine's kept plan and reports. */
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { CloudMoveCheck, CloudMoveStatus } from "@volli/shared";
import { projectFreeze, type MoveRow, type QueueRow } from "@volli/host-core/cloud-move";
import {
  exportRecords,
  type MigrationExportManifest,
  type MovePlan,
} from "@volli/host-core/migration-export";
import type { PreviewSummary } from "./preflight";
import { describeMove } from "./presentation";
import { countsForMove, moveRateEstimator, MOVE_HISTORY_SETTLE_SECONDS } from "./facts";
import { hostLogger } from "@volli/host-core/log";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const validCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not read the move’s saved report.", { cause: error });
  }
}
export async function saveMovePreview(
  root: string,
  row: MoveRow,
  summary: PreviewSummary | undefined,
): Promise<void> {
  if (summary === undefined) return;
  const directory = join(root, row.moveId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "preview.json");
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, JSON.stringify(summary), { mode: 0o600 });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}
const REAL_CHECKS: Record<string, string> = {
  boardTickets: "Board ticket count",
  boardTicket: "Board tickets",
  ticketBody: "Ticket text",
  ticketComments: "Ticket comments",
  ticketActivity: "Ticket activity",
  project: "Project",
  allSessionsFolded: "All Session views",
  sessionFolded: "Opened Session views",
  sessionEventsReadable: "Readable Session events",
  sessionHistory: "Session history pages",
};
export function moveChecks(report: MoveRow["report"]): CloudMoveCheck[] {
  if (report === null) return [];
  const checks: CloudMoveCheck[] = [];
  const verify = record(report.verify);
  if (Object.keys(verify).length > 0) {
    checks.push({ label: "Every record", passed: verify.ok === true });
    const streams = record(verify.streams);
    for (const [key, label] of [
      ["tickets", "Tickets"],
      ["sessions", "Sessions"],
      ["sessionEvents", "Events"],
      ["blobs", "Attachments"],
    ] as const) {
      if (!Object.hasOwn(streams, key)) continue;
      const item = record(streams[key]);
      checks.push({
        label,
        passed: item.match === true,
        sourceCount: count(item.expected),
        cloudCount: count(item.read),
      });
    }
    const objects = record(verify.objects);
    checks.push({
      label: "Files and checksums",
      passed: count(objects.missing) === 0 && count(objects.damaged) === 0 && verify.ok === true,
    });
  }
  const realPath = record(report.realPath);
  if (Object.keys(realPath).length > 0) {
    checks.push({ label: "Opened in Volli Cloud", passed: realPath.ok === true });
    for (const [key, label] of Object.entries(REAL_CHECKS)) {
      const source = record(realPath.checks);
      if (!Object.hasOwn(source, key)) continue;
      const item = record(source[key]);
      checks.push({
        label,
        passed: item.failed === 0,
        sourceCount: count(item.checked),
        cloudCount: Math.max(0, count(item.checked) - count(item.failed)),
      });
    }
  }
  if (report.handover !== undefined)
    checks.push({ label: "Working folders", passed: record(report.handover).collisions === 0 });
  return checks;
}

export function createMoveView(options: {
  db: Database.Database;
  workRoot: string;
  workspaceName(id: string): string;
  credentials(projectId: string): Promise<string[]>;
}) {
  const rate = moveRateEstimator();
  const warned = new Set<string>();
  const credentials = new Map<string, { at: number; value: Promise<string[]> }>();
  const warn = (row: MoveRow, kind: string) => {
    const key = row.moveId + ":" + kind;
    if (warned.has(key)) return;
    warned.add(key);
    hostLogger("cloud-move").warn("local move details unavailable", { moveId: row.moveId, kind });
  };
  return async (row: MoveRow, queue: QueueRow): Promise<Omit<CloudMoveStatus, "actions">> => {
    const directory = join(options.workRoot, row.moveId);
    const project = options.db
      .prepare("SELECT name FROM projects WHERE id = ?")
      .get(row.projectId) as { name: string } | undefined;
    // The journal and freeze remain usable even if an optional counts cache or
    // credential-name read fails. One move can never take down every recovery control.
    const view: Omit<CloudMoveStatus, "actions"> = {
      ...describeMove(row),
      moveId: row.moveId,
      queueId: row.queueId,
      projectId: row.projectId,
      projectName: project?.name ?? "Local project",
      workspaceName: options.workspaceName(row.workspaceId),
      progress: null,
      estimateSeconds: null,
      localReadOnly: projectFreeze(options.db, row.projectId) !== null,
      confirmedAt: row.confirmedAt,
      backupPath: queue.backup?.path ?? null,
      returnExportPath: row.journal.returnedExport ?? directory,
      rollback: null,
      checks: moveChecks(row.report),
      counts: null,
      pausedAutomations: [],
      localCredentials: [],
    };
    let detailsUnavailable = false;
    try {
      let preview = (await json(join(directory, "preview.json"))) as
        | (PreviewSummary & { sourceManifest?: string })
        | null;
      const plan = (await json(join(directory, "plan.json"))) as MovePlan | null;
      // A dry run can precede the freeze. Keep actual frozen-export facts before Finish removes it.
      if (plan !== null && preview?.sourceManifest !== plan.exportManifestSha256) {
        const exportDir = join(directory, "export");
        const manifest = (await json(
          join(exportDir, "manifest.json"),
        )) as MigrationExportManifest | null;
        if (manifest !== null) {
          let transcriptBytes = 0;
          for await (const item of exportRecords(exportDir, manifest, "transcriptArtifacts")) {
            if (typeof item.canonicalJson !== "string")
              throw new Error("Transcript counts unavailable.");
            transcriptBytes += Buffer.byteLength(item.canonicalJson, "utf8");
          }
          const pausedAutomations: string[] = [];
          for await (const item of exportRecords(exportDir, manifest, "automations"))
            if (typeof item.name === "string") pausedAutomations.push(item.name);
          preview = {
            sourceManifest: plan.exportManifestSha256,
            counts: countsForMove(plan, {
              transcriptBytes,
              piLogBytes: manifest.piLogFiles.reduce((sum, item) => sum + item.fileBytes, 0),
            }),
            pausedAutomations,
            expected: Object.fromEntries(plan.expected.map((item) => [item.stream, item.count])),
            estimatedExportBytes: preview?.estimatedExportBytes ?? 0,
          };
          await saveMovePreview(options.workRoot, row, preview);
        }
      }
      view.counts =
        plan !== null && preview !== null
          ? countsForMove(plan, preview.counts)
          : (preview?.counts ?? null);
      view.pausedAutomations = preview?.pausedAutomations ?? [];
      const expected = plan?.expected.reduce((sum, item) => sum + item.count, 0) ?? 0;
      const copied = Object.values(row.journal.rows ?? {}).reduce((sum, item) => sum + item, 0);
      const bytes = plan?.objects.reduce((sum, item) => sum + item.bytes, 0) ?? 0;
      const uploaded =
        plan?.objects
          .slice(0, row.journal.objects ?? 0)
          .reduce((sum, item) => sum + item.bytes, 0) ?? 0;
      const sessions = plan?.sessionList.length ?? 0;
      view.progress =
        view.step === "upload" && bytes > 0
          ? { completed: uploaded, total: bytes, unit: "bytes" }
          : view.step === "copy" && expected > 0
            ? { completed: Math.min(copied, expected), total: expected, unit: "rows" }
            : view.step === "history" && sessions > 0
              ? {
                  completed: Math.min(row.journal.history ?? 0, sessions),
                  total: sessions,
                  unit: "sessions",
                }
              : null;
      const measured = rate(
        row.moveId,
        view.step,
        row.paused === null ? view.progress : null,
        performance.now(),
      );
      const hasHistoryFiles =
        (view.counts?.transcriptBytes ?? 0) + (view.counts?.piLogBytes ?? 0) > 0;
      if (measured !== null)
        view.estimateSeconds = measured + 120 + (hasHistoryFiles ? MOVE_HISTORY_SETTLE_SECONDS : 0);
      if (row.state === "history" && row.paused === null && hasHistoryFiles) {
        view.message =
          "Waiting for file uploads to settle before checking. This can take around 15 minutes.";
        // Presentation only: history completed after the last signed upload. This
        // conservative countdown never changes the engine's monotonic safety guard.
        view.estimateSeconds =
          Math.max(
            0,
            Math.ceil((row.updatedAt + MOVE_HISTORY_SETTLE_SECONDS * 1000 - Date.now()) / 1000),
          ) + 120;
      }
      if (
        view.counts !== null &&
        ![
          "tickets",
          "sessions",
          "events",
          "attachments",
          "attachmentBytes",
          "transcriptBytes",
          "piLogBytes",
        ].every((key) => validCount(record(view.counts)[key]))
      )
        throw new Error("Invalid cached counts.");
      if (
        !Array.isArray(view.pausedAutomations) ||
        view.pausedAutomations.some((name) => typeof name !== "string")
      )
        throw new Error("Invalid cached Automation names.");
      if (
        view.progress !== null &&
        (!validCount(view.progress.completed) || !validCount(view.progress.total))
      )
        throw new Error("Invalid cached progress.");
    } catch {
      view.counts = null;
      view.progress = null;
      view.pausedAutomations = [];
      detailsUnavailable = true;
      warn(row, "counts");
    }
    try {
      let cached = credentials.get(row.projectId);
      if (cached === undefined || performance.now() - cached.at > 30_000) {
        cached = { at: performance.now(), value: options.credentials(row.projectId) };
        credentials.set(row.projectId, cached);
      }
      view.localCredentials = await cached.value;
    } catch {
      credentials.delete(row.projectId);
      detailsUnavailable = true;
      warn(row, "credential_names");
    }
    if (detailsUnavailable)
      view.message += " Some local details are unavailable; copy the report for support.";
    return view;
  };
}
