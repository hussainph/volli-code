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

/**
 * Whether the retention window has moved since this scan measured its
 * proposal (VC-284 re-review C6).
 *
 * Every eligibility date on screen was computed against `scan.retentionDays`.
 * Change the setting and those dates describe a policy that no longer exists —
 * so the plan is stale, the confirmation must not be openable, and the row says
 * to scan again. Main agrees from the other side: a retention write supersedes
 * the cached revision, so a confirmation left open is refused rather than run.
 */
export function isScanStale(scan: OrphansScan, retentionDays: number | null): boolean {
  return retentionDays !== null && retentionDays !== scan.retentionDays;
}

/** The row that says why the list on screen may not be acted on. */
export function staleScanNote(scan: OrphansScan, retentionDays: number): string {
  return `The retention window changed from ${scan.retentionDays} to ${retentionDays} day(s) after this scan, so these dates were measured against the old one. Scan again to see what is eligible now.`;
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

/**
 * A kept row: which project, the deadline and its basis when there is one, or
 * the honest reason there isn't.
 *
 * An ACTIVE row carries its eligibility date too (VC-284 re-review C6). The
 * acceptance asks Storage to show each KNOWN eligibility date and its basis,
 * and a checkout that is old enough but occupied has one — saying only "in use"
 * hides the fact that it is otherwise eligible, which is exactly what a person
 * wondering why it is still listed needs to know.
 */
export function describeKept(entry: KeptWorktreeOrphan): string {
  const prefix = `${entry.projectName} — `;
  const until = day(entry.removableAt);
  const basis = entry.ageBasis === null ? "" : ` (${ageBasisText(entry.ageBasis)})`;
  if (entry.reason === "active") {
    const eligibility =
      until === null ? "" : ` Eligible for cleanup since ${until}${basis}, but kept while in use.`;
    return `${prefix}Kept — ${entry.detail ?? "in use right now"}.${eligibility}`;
  }
  if (entry.reason === "age-unknown") {
    return `${prefix}Kept — Volli can't tell when this was last used.`;
  }
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
  const project = item.projectName ?? "Unknown project";
  // An outcome a later launch established is NOT timestamped as the moment the
  // change happened (VC-284 re-review C3/C6): nobody watched that instant. What
  // is known is the window — the cleanup started, the app stopped, and this is
  // when somebody looked — so the row says that rather than printing the launch
  // clock as a removal time.
  if (item.reconciledAt !== null) {
    const started = moment(item.startedAt ?? run.startedAt);
    const confirmed = moment(item.reconciledAt);
    const subject = item.kind === "metadata" ? "Stale git record pruned" : "Folder removed";
    const branchPart =
      item.kind === "metadata" || item.branch === null
        ? ""
        : ` Branch ${item.branch} is still in git.`;
    return `${project} — ${subject} by the cleanup that began at ${started}; Volli stopped before recording it and confirmed it at ${confirmed}.${branchPart}`;
  }
  const when = moment(item.settledAt ?? run.finishedAt ?? run.startedAt);
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
 * The truthful label for one SETTLED item, whatever it settled as (VC-284
 * review C6/S2). A skip is the preservation policy working and says which rule
 * spared the path; a failure and an unresolvable outcome say what went wrong,
 * in the same place and with the same timestamp discipline as a removal — a
 * destructive act whose refusals are invisible is one nobody can audit.
 */
export function describeSettled(run: OrphanCleanupRun, item: OrphanCleanupItem): string {
  if (item.state === "completed") return describeCompleted(run, item);
  const project = item.projectName ?? "Unknown project";
  const subject = item.kind === "metadata" ? "stale git record" : "folder";
  const reason = item.detail ?? "no reason recorded";
  // Same rule as a completed one: an outcome a later launch established is
  // stamped when somebody LOOKED, so the row says "recorded at", never that
  // this is when the act failed (VC-284 re-review C3/C6).
  if (item.reconciledAt !== null) {
    const confirmed = moment(item.reconciledAt);
    const verdict =
      item.state === "failed"
        ? `this ${subject} was not changed`
        : `Volli can't say what happened to this ${subject}`;
    return `${project} — ${verdict}; recorded at ${confirmed} by the launch after Volli stopped: ${reason}`;
  }
  const when = moment(item.settledAt ?? run.finishedAt ?? run.startedAt);
  if (item.state === "skipped") return `${project} — ${subject} kept at ${when}: ${reason}`;
  if (item.state === "failed") {
    return `${project} — cleanup of this ${subject} failed at ${when}: ${reason}`;
  }
  return `${project} — Volli can't say what happened to this ${subject} at ${when}: ${reason}`;
}

/**
 * Every SETTLED item across the recorded runs, in the order the runs arrived —
 * one row per item, never folded away.
 *
 * Two of the audit's findings meet here. Metadata items (a pruned record) are
 * included, not skipped: a pruned record is a completed act just as much as a
 * removed folder is. And every outcome is shown, not only the successful ones
 * — the previous version listed completed removals alone, so a path a cleanup
 * refused, failed on, or could not resolve left no trace at all (review C6/S2).
 * `pending` and `executing` are the two states that are NOT history: one is
 * work nobody attempted, the other is described by its run's own row.
 */
export function historyRows(runs: readonly OrphanCleanupRun[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const run of runs) {
    for (const item of run.items) {
      if (item.state === "pending" || item.state === "executing") continue;
      rows.push({
        key: `${run.id}:${item.id}`,
        path: item.path,
        meta: describeSettled(run, item),
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

/**
 * Runs that stopped mid-flight and still owe somebody an account.
 *
 * Two facts qualify a run, not one (VC-284 re-review S2). `interruptedAt` is
 * the interruption itself, recorded by the launch that found the run open — so
 * a run whose every item settled `failed` before the app died still surfaces,
 * with its Scan-again. The older rule only looked for unsettled items, which
 * meant the all-failed interruption was the one failure shape with no callout
 * and no recovery anywhere on the pane.
 */
export function unfinishedRuns(runs: readonly OrphanCleanupRun[]): OrphanCleanupRun[] {
  return runs.filter(
    (run) =>
      run.finishedAt === null &&
      (run.interruptedAt !== null ||
        run.items.some((item) => item.state !== "completed" && item.state !== "skipped")),
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
 * The one actionable line for a run that finished owing someone an explanation
 * (VC-284 review S2). It counts rather than repeats: every failed path and its
 * reason is already a row of its own in {@link historyRows}, and this row's job
 * is to be the thing a person notices and the place the recovery hangs off.
 */
export function describeRunFailures(run: OrphanCleanupRun): string {
  const failed = run.items.filter((item) => item.state === "failed").length;
  const uncertain = run.items.filter((item) => item.state === "indeterminate").length;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (uncertain > 0) parts.push(`${uncertain} with an unknown outcome`);
  return `${runHeading(run)} — ${parts.join(", ")}. Each one is listed below with its reason. Scan again to review what is left.`;
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
