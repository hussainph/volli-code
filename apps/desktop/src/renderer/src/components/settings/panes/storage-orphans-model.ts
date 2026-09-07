/**
 * What Storage SAYS about orphaned worktrees — the sentences, and the exact
 * plan behind the confirmation (VC-284).
 *
 * It is a pure module beside the pane for the reason the audit found: the old
 * surface labelled every removed row "Removed at launch" whoever had asked for
 * it, and its one button said "Rescan" while sending a request that deleted
 * directories. Both are decisions about what a person is told before and after
 * an irreversible act, and neither is visible in a screenshot — so they live
 * here, where a test can hold them to the record main actually kept.
 *
 * The rule every function obeys: never claim an act nobody performed, and never
 * describe a cleanup as something a launch did.
 */
import type {
  KeptWorktreeOrphan,
  OrphanCleanupItem,
  OrphanCleanupRun,
  PrunableWorktreeMetadata,
  RemovableWorktreeOrphan,
} from "../../../../../ipc/contract";

/** The scan snapshot the pane holds, as the IPC result delivers it. */
export interface OrphansScan {
  scannedAt: number;
  retentionDays: number;
  prunable: PrunableWorktreeMetadata[];
  removable: RemovableWorktreeOrphan[];
  keptRecent: KeptWorktreeOrphan[];
  dirty: { path: string; projectId?: string; reason: string }[];
  runs: OrphanCleanupRun[];
}

/**
 * Exactly what a cleanup would change, and what it would leave alone. The
 * confirmation renders this and the request sends `paths`/`projectIds` — one
 * object, so what is shown and what is asked for cannot drift.
 */
export interface CleanupPlan {
  paths: string[];
  projectIds: string[];
  worktrees: RemovableWorktreeOrphan[];
  metadata: { projectPath: string; path: string; reason: string }[];
  preservation: string[];
  isEmpty: boolean;
}

/** Local date, or `null` when there is no timestamp to show. */
function day(at: number | null): string | null {
  return at === null ? null : new Date(at).toLocaleDateString();
}

/** Local date and time — used where WHEN an act happened is the point. */
function moment(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * What cleanup keeps, in the confirmation's own words. It is not a summary of
 * the code's intentions: every line here is a refusal main re-checks per path
 * immediately before it acts (`worktree/cleanup.ts`).
 */
export const CLEANUP_PRESERVATION = [
  "Branches, their commits, and pull-request links stay in git — only the folder goes.",
  "Main checkouts, bare repos, ticket-linked worktrees, folders outside Volli, and other installs' folders are never touched.",
  "Anything with uncommitted work, a lock, unreadable git state, recent use, or a live terminal or agent is left in place.",
  "Every folder is checked again immediately before it is removed, and skipped if anything changed.",
];

export function planCleanup(scan: OrphansScan): CleanupPlan {
  const metadata = scan.prunable.flatMap((project) =>
    project.entries.map((entry) => ({
      projectPath: project.projectPath,
      path: entry.path,
      reason: entry.reason,
    })),
  );
  return {
    paths: scan.removable.map((entry) => entry.path),
    projectIds: scan.prunable.map((project) => project.projectId),
    worktrees: scan.removable,
    metadata,
    preservation: CLEANUP_PRESERVATION,
    isEmpty: scan.removable.length === 0 && metadata.length === 0,
  };
}

/** Whether the pane has anything to offer a cleanup at all. */
export function hasCleanupWork(scan: OrphansScan): boolean {
  return !planCleanup(scan).isEmpty;
}

/**
 * A candidate row: what cleanup would do to it, since when it has been
 * eligible, and what survives. Stated as a proposal, never as a fact — nothing
 * has happened to this directory.
 */
export function describeRemovable(entry: RemovableWorktreeOrphan): string {
  const since = day(entry.removableAt);
  const eligible =
    since === null ? "Eligible for cleanup." : `Eligible for cleanup since ${since}.`;
  return entry.branch === null
    ? `${eligible} No branch is checked out here.`
    : `${eligible} Branch ${entry.branch} would stay in git.`;
}

/** A kept row: the deadline when there is one, and the honest shrug when there isn't. */
export function describeKept(entry: KeptWorktreeOrphan): string {
  const until = day(entry.removableAt);
  return until === null
    ? "Kept — Volli can't tell when this was last used."
    : `Kept until ${until} — used recently.`;
}

/** A prunable-metadata row: a record, not a directory, and it says so. */
export function describeMetadata(entry: { path: string; reason: string }): string {
  return `Stale git record — ${entry.reason}. Cleanup would prune it; nothing on disk changes.`;
}

/** The retention window Storage shows so an eligibility date can be understood. */
export function retentionNote(retentionDays: number): string {
  return `Unused folders become eligible after ${retentionDays} day(s).`;
}

/** One row of durable history: what was removed, by whom, and when. */
export interface HistoryRow {
  key: string;
  path: string;
  meta: string;
}

/**
 * The truthful label for one completed item. `source` decides the verb: a
 * launch may only ever have scanned, so a cleanup a person asked for is never
 * described as something the app did on its own — the mislabelling A02 found.
 */
export function describeCompleted(run: OrphanCleanupRun, item: OrphanCleanupItem): string {
  const when = moment(item.finishedAt ?? run.startedAt);
  if (item.kind === "metadata") return `Stale git records pruned during startup at ${when}.`;
  const by =
    run.source === "startup"
      ? `Removed during startup at ${when}`
      : `Removed by cleanup at ${when}`;
  return item.branch === null
    ? `${by}. No branch was checked out here.`
    : `${by}. Branch ${item.branch} is still in git.`;
}

/**
 * Every completed removal across the recorded runs, newest first, one row per
 * path. Metadata items are left out: a pruned record has no directory to show,
 * and the run summary already accounts for it.
 */
export function historyRows(runs: readonly OrphanCleanupRun[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    for (const item of run.items) {
      if (item.kind !== "worktree" || item.status !== "completed") continue;
      const key = `${run.id}:${item.path}`;
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      rows.push({ key, path: item.path, meta: describeCompleted(run, item) });
    }
  }
  return rows;
}

/**
 * A run the app never finished, said plainly: what completed, what was skipped,
 * and what was never attempted. The remaining items are offered back as
 * something to scan again — never re-run silently, since the world has moved.
 */
export function describeInterrupted(run: OrphanCleanupRun): string {
  const done = run.items.filter((item) => item.status === "completed").length;
  const skipped = run.items.filter((item) => item.status === "skipped").length;
  const failed = run.items.filter((item) => item.status === "failed").length;
  const remaining = run.items.filter((item) => item.status === "pending").length;
  const when = moment(run.interruptedAt ?? run.startedAt);
  const parts = [`${done} completed`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${remaining} not attempted`);
  return `A cleanup was interrupted on ${when}: ${parts.join(", ")}. Scan again to review what is left.`;
}

/** Runs that stopped mid-flight and still have work nobody accounted for. */
export function unfinishedRuns(runs: readonly OrphanCleanupRun[]): OrphanCleanupRun[] {
  return runs.filter(
    (run) => run.finishedAt === null && run.items.some((item) => item.status === "pending"),
  );
}

/** What a finished cleanup did, for the toast that follows it. */
export function cleanupSummary(run: OrphanCleanupRun): string {
  const done = run.items.filter((item) => item.status === "completed").length;
  const skipped = run.items.filter((item) => item.status === "skipped").length;
  const failed = run.items.filter((item) => item.status === "failed").length;
  const parts = [`${done} cleaned up`];
  if (skipped > 0) parts.push(`${skipped} kept`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}
