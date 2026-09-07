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
 * The rule every function obeys: never claim an act nobody performed, never
 * describe a cleanup as something a launch did, and never call a run a
 * success when something in it failed or is still uncertain.
 *
 * Review round two moved the confirmed cleanup onto a real command contract —
 * `{ commandId, scanRevision, itemIds }` — and split what used to be one loose
 * `status` field into `state` (with `executing`/`indeterminate` alongside
 * `pending`/`completed`/`skipped`/`failed`), gave every item an id and its own
 * `startedAt`/`settledAt`, and moved the preservation policy into
 * `@volli/shared`'s typed vocabulary. This module follows that contract
 * exactly; nothing here re-derives a policy sentence or a path main did not
 * already name.
 */
import { CLEANUP_PRESERVATION_RULES, preservationRuleText } from "@volli/shared";

import type {
  KeptWorktreeMetadata,
  KeptWorktreeOrphan,
  OrphanAgeBasis,
  OrphanCleanupItem,
  OrphanCleanupRejectionCode,
  OrphanCleanupRun,
  PrunableWorktreeMetadata,
  RemovableWorktreeOrphan,
  UnreadableWorktreeProject,
} from "../../../../../ipc/contract";

/** The scan snapshot the pane holds, as the IPC result delivers it. */
export interface OrphansScan {
  /** The opaque revision a confirmed cleanup must name (VC-284 review C1). */
  revision: string;
  scannedAt: number;
  retentionDays: number;
  prunable: PrunableWorktreeMetadata[];
  removable: RemovableWorktreeOrphan[];
  keptRecent: KeptWorktreeOrphan[];
  keptMetadata: KeptWorktreeMetadata[];
  unreadableProjects: UnreadableWorktreeProject[];
  dirty: { path: string; projectId?: string; projectName?: string; reason: string }[];
  runs: OrphanCleanupRun[];
}

/**
 * Exactly what a cleanup would change, and what it would leave alone. The
 * confirmation renders this and the request sends `scanRevision`/`itemIds` —
 * one object, so what is shown and what is asked for cannot drift (VC-284
 * review C1/C2/C4). It carries no paths of its own: `worktrees` and
 * `metadata` are main's own scan rows, so a row shown is a row an id in
 * `itemIds` can only ever mean.
 */
export interface CleanupPlan {
  scanRevision: string;
  itemIds: string[];
  worktrees: RemovableWorktreeOrphan[];
  metadata: PrunableWorktreeMetadata[];
  /**
   * The preservation policy's sentences, rendered from
   * `CLEANUP_PRESERVATION_RULES` through `preservationRuleText` — never a
   * hand-written list (VC-284 review S3), so this can never silently drift
   * from what main actually enforces.
   */
  preservation: string[];
  isEmpty: boolean;
}

export function planCleanup(scan: OrphansScan): CleanupPlan {
  const worktrees = scan.removable;
  const metadata = scan.prunable;
  return {
    scanRevision: scan.revision,
    itemIds: [...worktrees.map((entry) => entry.id), ...metadata.map((entry) => entry.id)],
    worktrees,
    metadata,
    preservation: CLEANUP_PRESERVATION_RULES.map((rule) =>
      preservationRuleText(rule, { retentionDays: scan.retentionDays }),
    ),
    isEmpty: worktrees.length === 0 && metadata.length === 0,
  };
}

/** Whether the pane has anything to offer a cleanup at all. */
export function hasCleanupWork(scan: OrphansScan): boolean {
  return !planCleanup(scan).isEmpty;
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
 * The clock a deadline was measured against, in words a person can argue with
 * (VC-284 review C6): a deadline whose basis is invisible cannot be
 * questioned when it looks wrong.
 */
export function ageBasisText(basis: OrphanAgeBasis): string {
  return basis === "directory" ? "the folder's last modification" : "its branch's last commit";
}

/**
 * A candidate row: which project it belongs to, since when it has been
 * eligible and by which clock, and what survives. Stated as a proposal, never
 * as a fact — nothing has happened to this directory.
 */
export function describeRemovable(
  entry: RemovableWorktreeOrphan,
  options: { retentionDays: number },
): string {
  const since = day(entry.removableAt);
  const basis = ageBasisText(entry.ageBasis);
  const branchPart =
    entry.branch === null
      ? "No branch is checked out here."
      : `Branch ${entry.branch} would stay in git.`;
  return `${entry.projectName} — eligible for cleanup since ${since} (${basis}, past the ${options.retentionDays}-day retention window). ${branchPart}`;
}

/** A kept row: which project, the deadline and its basis when there is one, or the honest reason there isn't. */
export function describeKept(entry: KeptWorktreeOrphan): string {
  const prefix = `${entry.projectName} — `;
  if (entry.reason === "active") {
    return `${prefix}Kept — ${entry.detail ?? "in use right now"}.`;
  }
  if (entry.reason === "age-unknown") {
    return `${prefix}Kept — Volli can't tell when this was last used.`;
  }
  const until = day(entry.removableAt);
  const basis = entry.ageBasis === null ? "" : ` (${ageBasisText(entry.ageBasis)})`;
  return until === null
    ? `${prefix}Kept — used recently.`
    : `${prefix}Kept until ${until}${basis} — used recently.`;
}

/** A prunable-metadata row: which project, a record rather than a directory, and it says so. */
export function describeMetadata(entry: PrunableWorktreeMetadata): string {
  return `${entry.projectName} — stale git record (${entry.reason}). Cleanup would prune the record; nothing on disk changes.`;
}

/** A stale record cleanup will NOT prune, and why (VC-284 review C6). */
export function describeKeptMetadata(entry: KeptWorktreeMetadata): string {
  const why =
    entry.reason === "ticket-linked" ? "still linked to a ticket" : "not owned by this database";
  return `${entry.projectName} — stale git record (${entry.gitReason}) kept — ${why}.`;
}

/** A project whose worktrees couldn't even be listed — reported, not hidden (VC-284 review C6). */
export function describeUnreadableProject(entry: UnreadableWorktreeProject): string {
  return `${entry.projectName} — worktrees couldn't be listed: ${entry.error}.`;
}

/** The retention window Storage shows so an eligibility date can be understood. */
export function retentionNote(retentionDays: number): string {
  return `Unused folders become eligible after ${retentionDays} day(s).`;
}

/**
 * The policy row the list itself carries (VC-284 review C6): the configured
 * retention window, and the difference between an orphan and a ticket's
 * checkout. It is a ROW rather than prose under a control because the
 * acceptance asks Storage to SHOW the retention period — a summoned tooltip is
 * not shown — and because an orphan having no ticket to archive is the fact
 * that explains why this list's only verb is "remove the folder".
 */
export function orphanPolicyNote(retentionDays: number): string {
  return `${retentionNote(retentionDays)} An orphan has no ticket to archive, so a reviewed folder removal is all that can happen here; the branch stays in git. Archiving a ticket is a separate action.`;
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
 * described as something the app did on its own — the mislabelling the audit
 * found, and the one thing this function exists to make impossible to repeat.
 */
export function describeCompleted(run: OrphanCleanupRun, item: OrphanCleanupItem): string {
  const when = moment(item.settledAt ?? run.finishedAt ?? run.startedAt);
  const project = item.projectName ?? "Unknown project";
  if (item.kind === "metadata") {
    const verb = run.source === "startup" ? "pruned during startup" : "pruned by cleanup";
    return `${project} — stale git record ${verb} at ${when}.`;
  }
  const verb = run.source === "startup" ? "Removed during startup" : "Removed by cleanup";
  const branchPart =
    item.branch === null
      ? "No branch was checked out here."
      : `Branch ${item.branch} is still in git.`;
  return `${project} — ${verb} at ${when}. ${branchPart}`;
}

/**
 * Every completed item across the recorded runs, in the order the runs
 * arrived — one row per item, never folded away. Metadata items (a pruned
 * record) are included, not skipped: a pruned record is a completed act just
 * as much as a removed folder is, and the audit's other finding was history
 * that quietly dropped rows it should have kept (VC-284 review C6).
 */
export function historyRows(runs: readonly OrphanCleanupRun[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const run of runs) {
    for (const item of run.items) {
      if (item.state !== "completed") continue;
      rows.push({
        key: `${run.id}:${item.id}`,
        path: item.path,
        meta: describeCompleted(run, item),
      });
    }
  }
  return rows;
}

/** A short, human heading for one run: who ran it, and when it settled. */
function runHeading(run: OrphanCleanupRun): string {
  const when = moment(run.finishedAt ?? run.interruptedAt ?? run.startedAt);
  return run.source === "startup" ? `Startup cleanup at ${when}` : `Cleanup at ${when}`;
}

/** One row naming the exact preservation policy a completed run ran under. */
export interface PreservationHistoryRow {
  key: string;
  meta: string;
}

/**
 * The recorded preservation policy for every run that actually did something,
 * rendered through the same `preservationRuleText` the confirmation uses
 * (VC-284 review S3) — never a second, independent description of the same
 * policy. A rule id this build does not recognise (a record written by a
 * later version) still reads, because `preservationRuleText` renders it
 * rather than dropping it.
 */
export function preservationHistoryRows(
  runs: readonly OrphanCleanupRun[],
): PreservationHistoryRow[] {
  return runs
    .filter((run) => run.preservation.length > 0 && run.items.length > 0)
    .map((run) => ({
      key: `preservation:${run.id}`,
      meta: `${runHeading(run)} ran under: ${run.preservation
        .map((rule) => preservationRuleText(rule, { retentionDays: run.retentionDays }))
        .join(" ")}`,
    }));
}

/**
 * A run the app never finished, said plainly: what completed, what was
 * skipped, what may or may not have taken effect, and what was never
 * attempted. `executing`/`indeterminate` items get their own honest phrase
 * rather than being folded into "pending" — the world genuinely does not know
 * whether they took, which is a different statement from "never touched"
 * (VC-284 review C3/#6).
 */
export function describeInterrupted(run: OrphanCleanupRun): string {
  const completed = run.items.filter((item) => item.state === "completed").length;
  const skipped = run.items.filter((item) => item.state === "skipped").length;
  const failed = run.items.filter((item) => item.state === "failed").length;
  const uncertain = run.items.filter(
    (item) => item.state === "executing" || item.state === "indeterminate",
  ).length;
  const pending = run.items.filter((item) => item.state === "pending").length;
  const when = moment(run.interruptedAt ?? run.startedAt);
  const parts = [`${completed} completed`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (uncertain > 0) parts.push(`${uncertain} may or may not have taken effect`);
  parts.push(`${pending} never attempted`);
  return `A cleanup was interrupted on ${when}: ${parts.join(", ")}. Scan again to review what is left.`;
}

/** Runs that stopped mid-flight and still have work nobody accounted for. */
export function unfinishedRuns(runs: readonly OrphanCleanupRun[]): OrphanCleanupRun[] {
  return runs.filter(
    (run) =>
      run.finishedAt === null &&
      run.items.some(
        (item) =>
          item.state === "pending" || item.state === "executing" || item.state === "indeterminate",
      ),
  );
}

/**
 * A run that FINISHED but left something failed or indeterminate behind
 * (VC-284 review S2): distinct from `unfinishedRuns`, whose runs never even
 * settled. This is the case the old pane's `toast.success` erased — a run can
 * close out and still owe someone an explanation.
 */
export function runsWithFailures(runs: readonly OrphanCleanupRun[]): OrphanCleanupRun[] {
  return runs.filter(
    (run) =>
      run.finishedAt !== null &&
      run.items.some((item) => item.state === "failed" || item.state === "indeterminate"),
  );
}

/**
 * Every failed or indeterminate path in a run, WITH its reason, and the one
 * recovery action that answers both: scan again. (VC-284 review S2 — a
 * failure with no visible reason and no way back is worse than no message at
 * all.)
 */
export function describeRunFailures(run: OrphanCleanupRun): string {
  const failed = run.items.filter(
    (item) => item.state === "failed" || item.state === "indeterminate",
  );
  const detail = failed
    .map((item) => `${item.projectName ?? item.path}: ${item.detail ?? "no reason recorded"}`)
    .join("; ");
  return `${runHeading(run)} — ${failed.length} item(s) failed: ${detail}. Scan again to review what is left.`;
}

/** What a finished cleanup did, for the toast that follows it. */
export function cleanupSummary(run: OrphanCleanupRun): string {
  const done = run.items.filter((item) => item.state === "completed").length;
  const skipped = run.items.filter((item) => item.state === "skipped").length;
  const failed = run.items.filter((item) => item.state === "failed").length;
  const indeterminate = run.items.filter((item) => item.state === "indeterminate").length;
  const parts = [`${done} cleaned up`];
  if (skipped > 0) parts.push(`${skipped} kept`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (indeterminate > 0) parts.push(`${indeterminate} uncertain`);
  return parts.join(", ");
}

/** How a finished cleanup should be announced: a success is one with nothing failed or indeterminate in it. */
export interface CleanupOutcome {
  kind: "success" | "warning";
  message: string;
}

/**
 * The review's S2: a run containing `failed` items got `toast.success(...)`.
 * Every mutation this run attempted is accounted for, so the run itself
 * always "finishes" — but a finish with a failure in it is a warning, not a
 * success, and it names the recovery (scan again) in the same sentence.
 */
export function cleanupOutcome(run: OrphanCleanupRun): CleanupOutcome {
  const summary = cleanupSummary(run);
  const hasTrouble = run.items.some(
    (item) => item.state === "failed" || item.state === "indeterminate",
  );
  return hasTrouble
    ? {
        kind: "warning",
        message: `Cleanup finished with problems: ${summary}. Scan again to review what is left.`,
      }
    : { kind: "success", message: `Cleanup finished: ${summary}.` };
}

const REJECTION_TEXT: Record<OrphanCleanupRejectionCode, (error: string) => string> = {
  "scan-superseded": () =>
    "This scan has moved on since you opened it — nothing was changed. Scan again to see the current plan.",
  "unknown-items": (error) => `Couldn't clean up: ${error}. Scan again to refresh the plan.`,
  conflict: (error) => `Couldn't clean up: ${error}.`,
};

/**
 * The honest sentence for a refused cleanup command (VC-284 review C1): each
 * rejection code has its own recovery, so `"scan-superseded"` always names
 * Scan again, while `"unknown-items"` and `"conflict"` get their own sentence
 * rather than sharing one generic failure message.
 */
export function cleanupRejectionMessage(code: OrphanCleanupRejectionCode, error: string): string {
  return REJECTION_TEXT[code](error);
}
