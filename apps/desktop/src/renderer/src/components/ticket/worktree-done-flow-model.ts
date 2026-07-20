/**
 * Pure resolver for the Done-flow rail's single adaptive split button
 * (docs/plans/done-flow.md "UI", decision #45). Given the latest worktree
 * status, the ticket's durable `prUrl`, and the local busy stage, it returns the
 * one primary action (label + disabled reason) and the always-listed chevron
 * menu (each verb with its own disabled reason). Raw status is never surfaced as
 * standalone lines — it only drives labels and disabled reasons here. Kept
 * side-effect-free and separate from `ticket-properties.tsx` so the rules are
 * unit-testable without mounting React or faking `window.api`.
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

/**
 * The single mutating action in flight, or idle. Replaces the old pair of
 * booleans — a stacked commit→push flow is one control, so at most one stage
 * runs at a time and the primary label reflects it.
 */
export type DoneFlowStage = "idle" | "committing" | "pushing";

/**
 * What the primary button does when clicked. `commit-pr` / `commit-push-updates`
 * are the stacked flows (their "stack includes a commit", so the sequencer rule
 * disables them); `create-pr` is the inert placeholder shown while loading or
 * when there is nothing to do — the button never vanishes, it just disables.
 */
export type PrimaryActionKind =
  | "commit-pr"
  | "commit-push-updates"
  | "push-pr"
  | "push-updates"
  | "view-pr"
  | "create-pr";

/** Which chevron-menu verb an item runs. `push` covers both push variants. */
export type MenuActionKind = "commit" | "push-pr" | "push-updates" | "open-pr";

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
  disabled: boolean;
  /** Tooltip reason when disabled; null when enabled. */
  reason: string | null;
}

export interface MenuAction {
  kind: MenuActionKind;
  label: string;
  disabled: boolean;
  /** Why the item is disabled; null when enabled. */
  reason: string | null;
}

/** The three always-listed chevron-menu verbs (T3 Code's pattern — never hidden, disabled with reasons). */
export interface DoneFlowMenu {
  commit: MenuAction;
  /** "Push & create draft PR" (no PR) or "Push updates" (PR exists). */
  push: MenuAction;
  openPr: MenuAction;
}

export interface DoneFlowView {
  primary: PrimaryAction;
  menu: DoneFlowMenu;
}

// Disabled-reason copy — one source of truth so the view and tests agree.
const REASON_LOADING = "Loading…";
const REASON_NO_CHANGES = "No changes vs base yet";
const REASON_BASE_UNRESOLVED = "Base branch not resolved";
const REASON_SEQUENCER = "Merge/rebase in progress — resolve it in the terminal.";
const REASON_CLEAN_TREE = "Working tree clean";
const REASON_NOTHING_TO_PUSH = "Nothing to push";
const REASON_NO_PR_YET = "No PR yet";

const LABEL_COMMIT_PR = "Commit & create draft PR";
const LABEL_COMMIT_PUSH_UPDATES = "Commit & push updates";
const LABEL_PUSH_PR = "Push & create draft PR";
const LABEL_PUSH_UPDATES = "Push updates";
const LABEL_VIEW_PR = "View PR";
const LABEL_CREATE_PR = "Create draft PR";

function positive(count: number | null): boolean {
  return count !== null && count > 0;
}

/** A menu verb forced disabled (used to grey the whole menu while a stage runs). */
function disabledMenu(item: MenuAction): MenuAction {
  return { ...item, disabled: true, reason: null };
}

/**
 * Resolves the primary action from status + prUrl, ignoring the busy stage
 * (overlaid afterwards). Priority order is the done-flow.md contract; the
 * sequencer rule is applied last so it can disable a commit-stack action that
 * otherwise resolved.
 */
function resolvePrimary(
  status: WorktreeStatusSnapshot | null,
  prUrl: string | null,
): PrimaryAction {
  // 1. First fetch pending: View PR needs only prUrl; otherwise a disabled placeholder.
  if (status === null) {
    return prUrl !== null
      ? { kind: "view-pr", label: LABEL_VIEW_PR, disabled: false, reason: null }
      : { kind: "create-pr", label: LABEL_CREATE_PR, disabled: true, reason: REASON_LOADING };
  }

  let action: PrimaryAction;
  if (status.uncommitted && prUrl === null) {
    action = { kind: "commit-pr", label: LABEL_COMMIT_PR, disabled: false, reason: null };
  } else if (status.uncommitted && prUrl !== null) {
    action = {
      kind: "commit-push-updates",
      label: LABEL_COMMIT_PUSH_UPDATES,
      disabled: false,
      reason: null,
    };
  } else if (prUrl === null && positive(status.aheadOfBase)) {
    action = { kind: "push-pr", label: LABEL_PUSH_PR, disabled: false, reason: null };
  } else if (prUrl !== null && positive(status.unpushed)) {
    action = { kind: "push-updates", label: LABEL_PUSH_UPDATES, disabled: false, reason: null };
  } else if (prUrl !== null) {
    action = { kind: "view-pr", label: LABEL_VIEW_PR, disabled: false, reason: null };
  } else {
    action = {
      kind: "create-pr",
      label: LABEL_CREATE_PR,
      disabled: true,
      reason: status.aheadOfBase === null ? REASON_BASE_UNRESOLVED : REASON_NO_CHANGES,
    };
  }

  // Sequencer disables only commit-stack actions; push-only and View PR stay
  // enabled (pushing existing commits mid-rebase is safe).
  if (
    status.sequencerActive &&
    (action.kind === "commit-pr" || action.kind === "commit-push-updates")
  ) {
    return { ...action, disabled: true, reason: REASON_SEQUENCER };
  }
  return action;
}

/** The Commit menu verb: enabled iff there's something to commit and no sequencer op is mid-flight. */
function resolveCommitMenu(status: WorktreeStatusSnapshot | null): MenuAction {
  const base = { kind: "commit" as const, label: "Commit" };
  if (status === null) return { ...base, disabled: true, reason: REASON_LOADING };
  if (!status.uncommitted) return { ...base, disabled: true, reason: REASON_CLEAN_TREE };
  if (status.sequencerActive) return { ...base, disabled: true, reason: REASON_SEQUENCER };
  return { ...base, disabled: false, reason: null };
}

/** The Push menu verb: label + push variant follow prUrl; enabled iff commits exist to push. */
function resolvePushMenu(status: WorktreeStatusSnapshot | null, prUrl: string | null): MenuAction {
  const hasPr = prUrl !== null;
  const kind: MenuActionKind = hasPr ? "push-updates" : "push-pr";
  const label = hasPr ? LABEL_PUSH_UPDATES : LABEL_PUSH_PR;
  if (status === null) return { kind, label, disabled: true, reason: REASON_LOADING };
  const canPush = hasPr ? positive(status.unpushed) : positive(status.aheadOfBase);
  return canPush
    ? { kind, label, disabled: false, reason: null }
    : { kind, label, disabled: true, reason: REASON_NOTHING_TO_PUSH };
}

/**
 * Resolves the whole Done-flow view. While `stage` is not idle the primary is
 * disabled and relabelled to the running stage, and every menu verb is disabled
 * (one mutation at a time). Otherwise the primary follows {@link resolvePrimary}
 * and each menu verb carries its own disabled reason.
 */
export function resolveDoneFlow(
  status: WorktreeStatusSnapshot | null,
  prUrl: string | null,
  stage: DoneFlowStage,
): DoneFlowView {
  if (stage !== "idle") {
    const primaryBase = resolvePrimary(status, prUrl);
    const busyLabel = stage === "committing" ? "Committing…" : "Pushing…";
    return {
      primary: { ...primaryBase, label: busyLabel, disabled: true, reason: null },
      menu: {
        commit: disabledMenu(resolveCommitMenu(status)),
        push: disabledMenu(resolvePushMenu(status, prUrl)),
        openPr: disabledMenu({ kind: "open-pr", label: "Open PR", disabled: true, reason: null }),
      },
    };
  }

  return {
    primary: resolvePrimary(status, prUrl),
    menu: {
      commit: resolveCommitMenu(status),
      push: resolvePushMenu(status, prUrl),
      openPr:
        prUrl !== null
          ? { kind: "open-pr", label: "Open PR", disabled: false, reason: null }
          : { kind: "open-pr", label: "Open PR", disabled: true, reason: REASON_NO_PR_YET },
    },
  };
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
