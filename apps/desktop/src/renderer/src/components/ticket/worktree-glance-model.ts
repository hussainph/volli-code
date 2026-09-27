/**
 * The worktree footer's one fact (VC-406): what the branch's row says at its
 * right edge while the body under it is folded.
 *
 * ONE FACT, chosen by priority, not a summary. The first cut of the row printed
 * two — `Uncommitted · 3 to push` — and at 300px the pair ate the branch name
 * down to `volli/VLT…`. A glance is the thing the reader would have to act on
 * NEXT, in the words the body's own rows already use, so unfolding the body
 * never contradicts the row above it:
 *
 *   checks failing  >  uncommitted  >  N to push / not pushed  >
 *   checks running  >  checks passed / skipped  >  up to date  >  no commits
 *
 * A red suite outranks local state because it is the one thing here that
 * somebody else is waiting on; uncommitted work outranks unpushed commits
 * because a commit is the act that turns one into the other.
 *
 * THE DOT IS QUIET FOR LOCAL STATE. Uncommitted work and unpushed commits are
 * the resting condition of a worktree an agent is working in — a tone lit for
 * them would be lit nearly always, and a dot that is always amber says
 * nothing. So they take the neutral `idle` dot, and the tones are spent only
 * where something OUTSIDE the worktree has an opinion: `error` for a red
 * suite, `working` for one still running, `ready` for a green one. (The
 * body's own state strip keeps its `text-attention` for the same local facts;
 * that is a working surface, and this is a glance.)
 *
 * Pure over the two snapshots the card already holds, so the row and the body
 * can never disagree about the branch they describe.
 */
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import type { PrChecksView } from "@renderer/components/ticket/pr-checks-model";
import type { WorktreeStatusSnapshot } from "@renderer/components/ticket/worktree-done-flow-model";

export interface WorktreeGlance {
  /** The one fact, in the body's own words. */
  phrase: string;
  tone: StatusDotState;
}

/**
 * `null` until the status has been read — the row then shows the branch alone,
 * which is true, rather than a placeholder fact, which would not be.
 */
export function worktreeGlance(
  status: WorktreeStatusSnapshot | null,
  checks: PrChecksView | null,
): WorktreeGlance | null {
  if (status === null) return null;
  if (checks !== null && checks.verdict === "failing") {
    return { phrase: checks.label, tone: "error" };
  }
  if (status.uncommitted) return { phrase: "Uncommitted", tone: "idle" };
  if (status.unpushed !== null && status.unpushed > 0) {
    return { phrase: `${status.unpushed} to push`, tone: "idle" };
  }
  if (status.unpushed === null && status.aheadOfBase !== null && status.aheadOfBase > 0) {
    return { phrase: "Not pushed", tone: "idle" };
  }
  if (checks !== null) {
    if (checks.verdict === "pending") return { phrase: checks.label, tone: "working" };
    if (checks.verdict === "passing") return { phrase: checks.label, tone: "ready" };
    return { phrase: checks.label, tone: "idle" };
  }
  if (status.aheadOfBase !== null && status.aheadOfBase > 0) {
    return { phrase: "Up to date", tone: "idle" };
  }
  return { phrase: status.aheadOfBase === 0 ? "No commits" : "Clean", tone: "idle" };
}
