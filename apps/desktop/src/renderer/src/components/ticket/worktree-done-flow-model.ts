/**
 * Pure visibility/labeling rules for the Done-flow rail affordances
 * (docs/plans/done-flow.md "UI"): which of the diff/status lines and the
 * commit / push-PR / open-PR buttons render, given the latest worktree status,
 * the ticket's durable `prUrl`, and local busy flags. Kept side-effect-free and
 * separate from `ticket-properties.tsx` so the rules are unit-testable without
 * mounting React or faking `window.api`.
 */
import type { DiffStat } from "@volli/shared";

/** The finer Details-rail worktree status (mirrors `WorktreeStatusResult["status"]`, packages/shared/src/ipc.ts). */
export interface WorktreeStatusSnapshot {
  uncommitted: boolean;
  sequencerActive: boolean;
  aheadOfBase: number | null;
  behindBase: number | null;
  /** Commits not yet on `origin/<branch>`; null when never pushed / no remote. */
  unpushed: number | null;
}

/** Local busy state for the two mutating actions — never global (dialog-state-local convention). */
export interface DoneFlowBusyState {
  committing: boolean;
  pushingPr: boolean;
}

export interface DoneFlowActionsView {
  /** A merge/rebase is mid-flight: show a quiet note instead of a commit button that main would refuse anyway. */
  showSequencerNotice: boolean;
  /** "Commit remaining changes" — withheld entirely (not just disabled) while a sequencer op is active. */
  showCommit: boolean;
  commitDisabled: boolean;
  /** "Push & create draft PR" — branch is ahead of a known base and no PR exists yet. */
  showPushPr: boolean;
  pushPrDisabled: boolean;
  /** "Open PR" — a durable PR URL already exists; takes priority over the push affordance. */
  showOpenPr: boolean;
  /**
   * "Push updates" — a PR already exists AND local commits haven't reached
   * `origin/<branch>` yet (the review-feedback loop: agent commits more, the PR
   * needs the push). Drives the same push-pr flow, which re-discovers the
   * existing PR rather than opening a second one. Shares `pushPrDisabled`.
   */
  showPushUpdates: boolean;
}

/**
 * Computes which Done-flow actions render. `status` is `null` before the
 * first `worktree.status` fetch resolves — in that window only "Open PR" can
 * show (it depends solely on the ticket's already-known `prUrl`, not on a
 * fetch). Behind-base is never a blocker here (done-flow.md decision #2): it
 * has no bearing on commit/push visibility, only on the info line rendered
 * alongside (see {@link formatAheadBehind}).
 */
export function getDoneFlowActions(
  status: WorktreeStatusSnapshot | null,
  prUrl: string | null,
  busy: DoneFlowBusyState,
): DoneFlowActionsView {
  const showOpenPr = prUrl !== null;

  if (status === null) {
    return {
      showSequencerNotice: false,
      showCommit: false,
      commitDisabled: true,
      showPushPr: false,
      pushPrDisabled: true,
      showOpenPr,
      showPushUpdates: false,
    };
  }

  const showSequencerNotice = status.sequencerActive;
  const showCommit = status.uncommitted && !status.sequencerActive;
  const showPushPr = !showOpenPr && status.aheadOfBase !== null && status.aheadOfBase > 0;
  const showPushUpdates = showOpenPr && status.unpushed !== null && status.unpushed > 0;

  return {
    showSequencerNotice,
    showCommit,
    commitDisabled: busy.committing,
    showPushPr,
    pushPrDisabled: busy.pushingPr,
    showOpenPr,
    showPushUpdates,
  };
}

/** "Uncommitted changes present" / "Working tree clean" — the working-tree line (status.uncommitted only). */
export function formatWorkingTree(status: WorktreeStatusSnapshot): string {
  return status.uncommitted ? "Uncommitted changes present" : "Working tree clean";
}

/**
 * "3 ahead · 1 behind base" — info only, never a blocker (done-flow.md
 * decision #2: GitHub merges diverged-base PRs natively). `null` when the base
 * is unknown (either count null) rather than guessing; "Up to date with base"
 * when both counts are exactly zero so the line isn't silently dropped.
 */
export function formatAheadBehind(status: WorktreeStatusSnapshot): string | null {
  const { aheadOfBase, behindBase } = status;
  if (aheadOfBase === null || behindBase === null) return null;
  if (aheadOfBase === 0 && behindBase === 0) return "Up to date with base";
  const parts: string[] = [];
  if (aheadOfBase > 0) parts.push(`${aheadOfBase} ahead`);
  if (behindBase > 0) parts.push(`${behindBase} behind base`);
  return parts.join(" · ");
}

/**
 * "2 files · +11 −2", with a trailing "· +2 binary/untracked" clause when the
 * merge-base diff has files whose line counts are null (binary or untracked —
 * `DiffFileStat`'s convention, ticket-events.ts). `null` when there are no
 * changes vs base yet, so the caller can show its own "no changes" copy
 * instead of a hollow "0 files · +0 −0".
 */
export function formatMergeBaseSummary(diff: DiffStat): string | null {
  if (diff.files.length === 0) return null;
  const specialCount = diff.files.filter((file) => file.insertions === null).length;
  const fileCount = diff.files.length;
  const base = `${fileCount} file${fileCount === 1 ? "" : "s"} · +${diff.insertions} −${diff.deletions}`;
  return specialCount > 0 ? `${base} · +${specialCount} binary/untracked` : base;
}
