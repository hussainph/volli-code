/**
 * What a worktree cleanup promises to leave alone — one typed vocabulary
 * (VC-284).
 *
 * The review's S3: the policy existed twice, as two independent lists of
 * English sentences — one recorded with each run in main, one shown in the
 * renderer's confirmation — and they had already drifted, the dialog quietly
 * dropping unpushed commits, in-progress git operations and submodule drift.
 * A preservation policy that is two lists is two policies wearing one name.
 *
 * So the RULES are ids, and the sentences are derived from them. Main records
 * the ids it ran under with every durable cleanup, the confirmation renders the
 * same ids, and a rule that gains, loses or rewords a sentence moves both at
 * once. Pure and shared for the same reason `model-access-policy.ts` beside it
 * is: a rule enforced in one process and described in another must have exactly
 * one definition. Transport stays out (docs/BOUNDARIES.md) — nothing here names
 * IPC or SQLite.
 *
 * Ids are durable: they are written into cleanup history, so a rule id is
 * frozen once it ships. {@link preservationRuleText} therefore never throws on
 * an id it does not know — a record written by a later version still reads.
 */

/**
 * Every safeguard a cleanup is held to, in the order a person should meet them:
 * what survives, what is out of scope, what counts as unsaved work, and when
 * the question is asked again.
 */
export const WORKTREE_PRESERVATION_RULES = [
  /** The directory is cache; the branch, its commits and its PR link are data. */
  "branches",
  /** Main checkouts, bare entries, folders outside Volli, another install's containers. */
  "ownership",
  /** A ticket's checkout belongs to the Done-retention flow, never to this one. */
  "ticket-linked",
  "uncommitted-changes",
  "untracked-files",
  "unpushed-commits",
  /** A merge, rebase, bisect or cherry-pick left in progress. */
  "git-operation",
  "submodule-drift",
  /** `git worktree lock`, which cleanup never overrides. */
  "locked",
  /** Any git read that fails: unreadable state is never assumed disposable. */
  "unreadable-git",
  /** An age Volli cannot read at all — kept, never guessed at. */
  "unknown-age",
  /** Used inside the retention window. */
  "recent-use",
  /** A live terminal or agent in the folder. */
  "active",
  /** Every target is asked again immediately before it is changed. */
  "recheck",
] as const;

/** One safeguard, by its durable id. */
export type WorktreePreservationRule = (typeof WORKTREE_PRESERVATION_RULES)[number];

/**
 * The policy a confirmed orphan cleanup runs under — recorded with the run and
 * shown in its confirmation. Every rule, because a cleanup is held to all of
 * them; it is a named subset rather than the tuple itself so a future flow
 * (retention reclaim) can promise a different set without renaming these.
 */
export const CLEANUP_PRESERVATION_RULES: readonly WorktreePreservationRule[] =
  WORKTREE_PRESERVATION_RULES;

/** Whether a stored or transported value is a rule id THIS build knows. */
export function isWorktreePreservationRule(value: unknown): value is WorktreePreservationRule {
  return (
    typeof value === "string" && (WORKTREE_PRESERVATION_RULES as readonly string[]).includes(value)
  );
}

const RULE_TEXT: Record<WorktreePreservationRule, (retentionDays: number) => string> = {
  branches: () =>
    "Branches, their commits, and pull-request links stay in git — only the folder goes.",
  ownership: () =>
    "Main checkouts, bare repos, folders outside Volli, and other installs' folders are never touched.",
  "ticket-linked": () =>
    "A worktree still linked to a ticket stays under the separate Done-retention flow.",
  "uncommitted-changes": () => "A worktree with uncommitted changes is kept.",
  "untracked-files": () => "A worktree with untracked files is kept.",
  "unpushed-commits": () => "A worktree with commits that are not pushed anywhere is kept.",
  "git-operation": () => "A worktree with a merge, rebase, or bisect in progress is kept.",
  "submodule-drift": () => "A worktree whose submodules have drifted is kept.",
  locked: () => "A locked worktree is kept; cleanup never unlocks one.",
  "unreadable-git": () => "A worktree whose git state can't be read is kept.",
  "unknown-age": () => "A worktree whose last use can't be read is kept.",
  "recent-use": (retentionDays) =>
    `A worktree used within the last ${retentionDays} day(s) is kept.`,
  active: () => "A worktree with a live terminal or agent in it is kept.",
  recheck: () =>
    "Every folder is checked again immediately before it is removed, and skipped if anything changed.",
};

/**
 * The sentence for one rule id, with the retention window filled in.
 *
 * An id this build does not recognise — a record written by a later version —
 * is rendered as itself rather than dropped or thrown on: cleanup history is
 * evidence about the past, and an unreadable line still has to say that a rule
 * was in force.
 */
export function preservationRuleText(
  rule: WorktreePreservationRule | string,
  options: { retentionDays: number },
): string {
  return isWorktreePreservationRule(rule)
    ? RULE_TEXT[rule](options.retentionDays)
    : `An additional rule recorded by a newer version of Volli (${rule}).`;
}
