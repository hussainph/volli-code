/**
 * Orphaned worktrees: what a scan may say, and what a cleanup durably records
 * (VC-284).
 *
 * Domain vocabulary, not transport (docs/BOUNDARIES.md). The review's S1 asked
 * for a host-neutral projection behind the destructive act, and this is the
 * half that has to be host-neutral for that to mean anything: a scan proposal,
 * a cleanup command's plan, and the immutable outcome of every item it touched.
 * Electron's channel catalog re-exports these for its own transport; the core
 * that mints and folds them (`apps/desktop/src/main/worktree/cleanup-engine.ts`)
 * knows nothing about IPC, SQLite or a renderer.
 *
 * Worktrees remain machine-bound resources — nothing here proposes syncing a
 * path between machines. What it buys is that the same words describe the act
 * whether the caller is this renderer, a future daemon client, or a recovery
 * pass at launch reading facts nobody is waiting on.
 *
 * Every id here is durable and therefore frozen: item ids are scoped by the
 * scan revision UUID that minted them, and a run's id is the caller's command
 * UUID.
 */

/**
 * Which clock decided a worktree's last use: the directory's own modification
 * time, or its branch tip's commit date. The retention deadline takes the newer
 * of the two, and a person has to be able to see WHICH — a deadline whose basis
 * is invisible cannot be argued with.
 */
export type OrphanAgeBasis = "directory" | "commit";

/** Whether a value is an age basis this build knows. */
export function isOrphanAgeBasis(value: unknown): value is OrphanAgeBasis {
  return value === "directory" || value === "commit";
}

/**
 * Why a scan keeps a clean orphan out of the cleanup plan. Typed rather than
 * prose, so main enforces exactly what a client renders.
 */
export type OrphanKeptReason = "recently-used" | "age-unknown" | "active";

/** Whether a value is a kept reason this build knows. */
export function isOrphanKeptReason(value: unknown): value is OrphanKeptReason {
  return value === "recently-used" || value === "age-unknown" || value === "active";
}

/**
 * Why a stale git record is NOT a cleanup's to prune. The eligibility rule for
 * metadata is the directory rule: only a record pointing inside a container
 * this database owns, that no ticket still claims, may be pruned by this flow.
 */
export type OrphanMetadataKeptReason = "not-owned" | "ticket-linked";

/** Whether a value is a metadata-kept reason this build knows. */
export function isOrphanMetadataKeptReason(value: unknown): value is OrphanMetadataKeptReason {
  return value === "not-owned" || value === "ticket-linked";
}

/** Who asked for a cleanup. `startup` exists so a launch-time act can never be mislabelled as a person's. */
export type OrphanCleanupSource = "settings" | "startup";

/** Whether a value is a cleanup source this build knows. */
export function isOrphanCleanupSource(value: unknown): value is OrphanCleanupSource {
  return value === "settings" || value === "startup";
}

/** A worktree directory, or one exact stale git record. */
export type OrphanCleanupItemKind = "worktree" | "metadata";

/** Whether a value is an item kind this build knows. */
export function isOrphanCleanupItemKind(value: unknown): value is OrphanCleanupItemKind {
  return value === "worktree" || value === "metadata";
}

/**
 * One thing a scan proposes and a cleanup command may select.
 *
 * The plan travels WITH the command (it is the command's intent), so a run
 * recorded today still says exactly what was confirmed, including the project
 * names and the git reason a person read, long after the scan that minted it is
 * gone.
 */
export interface OrphanCleanupPlanItem {
  /** Scoped by the scan revision that minted it; unique within one plan. */
  id: string;
  kind: OrphanCleanupItemKind;
  /** The worktree directory, or the stale record's registered path. */
  path: string;
  projectId: string;
  projectName: string;
  /** The project checkout the git command runs in. */
  projectPath: string;
  /** The branch a worktree is on at scan time; `null` for a metadata record. */
  branch: string | null;
  /** Git's own `prunable` reason for a metadata record; `null` for a worktree. */
  gitReason: string | null;
}

/**
 * Where one item of a cleanup got to.
 *
 * `pending` and `executing` are DERIVED from the facts recorded for the item,
 * never stored as an outcome: `pending` is an item with no fact at all, and
 * `executing` is one whose mutation was announced but whose outcome never
 * landed — the power-loss window. The other four are immutable outcomes; once
 * one is recorded for an item it can never be relabelled, which is what makes a
 * completed removal impossible to re-offer as work nobody attempted.
 */
export type OrphanCleanupItemState =
  | "pending"
  | "executing"
  | "completed"
  | "skipped"
  | "failed"
  /** The app stopped mid-mutation and the world can no longer say whether it took. */
  | "indeterminate";

/** The four states that are recorded as facts; the other two are derived. */
export type OrphanCleanupItemOutcome = Exclude<OrphanCleanupItemState, "pending" | "executing">;

/** Whether a value is an immutable outcome this build knows. */
export function isOrphanCleanupItemOutcome(value: unknown): value is OrphanCleanupItemOutcome {
  return (
    value === "completed" ||
    value === "skipped" ||
    value === "failed" ||
    value === "indeterminate"
  );
}

/** Whether an outcome means the world changed — the only state a person may read as "gone". */
export function isCompletedOrphanCleanupItem(state: OrphanCleanupItemState): boolean {
  return state === "completed";
}

/** One thing a cleanup was asked to change, as the projection reads it back. */
export interface OrphanCleanupItem {
  /** The plan item id this outcome belongs to; stable across the whole run. */
  id: string;
  kind: OrphanCleanupItemKind;
  path: string;
  projectId: string | null;
  projectName: string | null;
  branch: string | null;
  state: OrphanCleanupItemState;
  /** What happened, or the preservation rule that spared it. */
  detail: string | null;
  /** Epoch ms the mutation was announced, or `null` if it never began. */
  startedAt: number | null;
  /** Epoch ms the outcome was recorded, or `null` while it has none. */
  settledAt: number | null;
}

/**
 * The durable record of one cleanup, projected from immutable facts.
 *
 * An app that stops mid-run leaves a run whose completed items are still
 * completed, whose announced-but-unsettled item reads `executing` until the
 * next launch reconciles it against git and disk, and whose untouched items are
 * still `pending`.
 */
export interface OrphanCleanupRun {
  /** The run id, which is the caller's command id: one command, one run. */
  id: string;
  source: OrphanCleanupSource;
  /** The scan revision this run was confirmed against. */
  scanRevision: string;
  startedAt: number;
  /** `null` while the run is open — and forever, if it never finished. */
  finishedAt: number | null;
  /** Stamped by the first launch that finds an open run. */
  interruptedAt: number | null;
  /** The preservation rule ids in force for this run, recorded with it. */
  preservation: string[];
  /** The retention window those rules were measured against. */
  retentionDays: number;
  items: OrphanCleanupItem[];
}

/**
 * Why a cleanup command was refused. Each one has a different recovery, which
 * is why a caller gets a code and not only a sentence: a superseded scan is
 * fixed by scanning again, a conflict by not re-sending the command.
 */
export type OrphanCleanupRejectionCode =
  /** The revision named is not the one the host currently holds. */
  | "scan-superseded"
  /** The revision proposed no such item. */
  | "unknown-items"
  /** The same command id was already accepted with a different intent. */
  | "conflict";

/** Whether a value is a rejection code this build knows. */
export function isOrphanCleanupRejectionCode(
  value: unknown,
): value is OrphanCleanupRejectionCode {
  return value === "scan-superseded" || value === "unknown-items" || value === "conflict";
}

/**
 * Local acceptance of a cleanup command (docs/BOUNDARIES.md rule 4): it says
 * this host accepted, rejected, or completed the command — never that the
 * outcome is eternally final.
 */
export interface OrphanCleanupReceipt {
  id: string;
  commandId: string;
  status: "accepted" | "completed" | "rejected";
  /** A rejection's machine-readable reason; `null` on acceptance/completion. */
  code: OrphanCleanupRejectionCode | null;
  detail: string | null;
  recordedAt: number;
}

/** How many items of a run reached each kind of end — the summary every surface counts. */
export interface OrphanCleanupTally {
  completed: number;
  skipped: number;
  failed: number;
  indeterminate: number;
  /** Announced but never settled: the interrupted-mid-mutation window. */
  executing: number;
  /** Never attempted at all. */
  pending: number;
}

/** Counts one run's items by state, so no surface re-derives the arithmetic. */
export function tallyOrphanCleanup(run: Pick<OrphanCleanupRun, "items">): OrphanCleanupTally {
  const tally: OrphanCleanupTally = {
    completed: 0,
    skipped: 0,
    failed: 0,
    indeterminate: 0,
    executing: 0,
    pending: 0,
  };
  for (const item of run.items) tally[item.state] += 1;
  return tally;
}

/**
 * Whether a run ended with anything a person has to act on: an item that
 * failed, or one whose effect is unknown because the app stopped inside it.
 * A skip is not trouble — it is the preservation policy working.
 */
export function orphanCleanupNeedsAttention(run: Pick<OrphanCleanupRun, "items">): boolean {
  const tally = tallyOrphanCleanup(run);
  return tally.failed > 0 || tally.indeterminate > 0 || tally.executing > 0;
}
