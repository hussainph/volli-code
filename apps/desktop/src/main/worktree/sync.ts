/**
 * Worktree sync: merge the base branch into a ticket's branch, report what
 * happened, and return (VC-185, split from VC-89 slice 2).
 *
 * The shallow half, in the shape `status.ts` and `diff.ts` already have — it
 * takes an assembled `{ worktreePath, baseBranch }` and runs git, leaving the
 * ticket→identity resolution to the composed verb in `read.ts`. What it exists
 * to delete is the per-kickoff prose: "if your branch is stale, merge main in
 * and resolve the conflicts" was written into every orchestration brief, and
 * every session interpreted it slightly differently.
 *
 * ## It must not block. Ever.
 *
 * VC-92's amendment on VC-89 pinned exactly one hard constraint on this verb:
 * it merges, reports conflicts, and returns. If it waits on anything, it has
 * become a watch/wake tool (VC-85) and belongs on the Agent Tool Surface where
 * a runtime can suspend the turn — not on a socket with a ten-second request
 * deadline. The `gh pr checks --watch` wedge that killed two merge sessions is
 * the failure class this verb was invented to remove, so reintroducing it here
 * would be an unusually complete own goal.
 *
 * That constraint is why nothing here touches a REMOTE. No fetch, no pull, no
 * push, no ls-remote: every one of those can block on a credential prompt (the
 * osxkeychain hang that froze all pushes for ~2h is the same failure class),
 * and credential custody is control tier anyway — VC-92 moved it off the CLI
 * door entirely. Sync merges the base ref this checkout already has, which is
 * `origin/<base>` when a fetch has landed one and the local base branch when it
 * has not — the same {@link resolveComparisonRef} choice the diff and the
 * ahead/behind counts already measure against, so "behind by 3" and "sync
 * brought 3 commits" agree by construction. `sync.test.ts` pins the absence of
 * every network subcommand in every outcome.
 *
 * ## A conflict is an outcome, not a failure
 *
 * `git merge` exiting non-zero means one of two very different things, and the
 * caller's next move differs completely: a conflict leaves per-path work to do
 * IN THIS WORKTREE, and anything else (a dirty tree, unrelated history, a base
 * that does not resolve) leaves nothing merged at all. So the non-zero exit is
 * discriminated by asking git which paths are unmerged, and only the first case
 * becomes a `conflicted` outcome carrying its paths. The second stays an error
 * carrying git's own stderr, because a session told "conflicted" would go
 * hunting for conflict markers that were never written.
 *
 * Nothing here tidies up after a conflict. The worktree is left conflicted, on
 * purpose: the session resolving it is the one with the context to resolve it,
 * and an automatic abort would throw that away. `--abort` is the documented way
 * back out, and it is the same verb with a different mode rather than a second
 * one, so the way out is discoverable from the way in.
 */
import type { DiffStat } from "@volli/shared";

import { resolveComparisonRef } from "./comparison-ref";
import { parseNumstat, total } from "./diff";
import { stderrOf } from "./git";
import { resolveWorktreeTarget, type WorktreeReadDeps, type WorktreeReadFailure } from "./read";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface SyncInput {
  worktreePath: string;
  /** The branch merged IN. Sync fails fast when it is unknown. */
  baseBranch: string | null;
}

/** What a caller asked for: the merge itself, or the way back out of one. */
export type SyncMode = "merge" | "abort";

/**
 * How the sync ended.
 *
 * - `merged` — the base moved into the branch and HEAD moved with it.
 * - `already-up-to-date` — nothing to bring in. Git exits 0 for this, so it is
 *   read off HEAD rather than off the exit code.
 * - `conflicted` — the merge stopped with unmerged paths, which are named and
 *   left in place.
 * - `aborted` — `--abort` undid a merge that was in flight.
 */
export type SyncStatus = "merged" | "already-up-to-date" | "conflicted" | "aborted";

export interface SyncReport {
  readonly status: SyncStatus;
  /** The ref that was merged in: `origin/<base>` when known locally, else `<base>`. */
  readonly mergedRef: string;
  /**
   * Commits the merge brought in; 0 for every outcome that moved nothing, and
   * `null` when the merge landed but measuring it failed. Null degrades to
   * "unknown" exactly as `status.ts` nulls a stale ahead/behind count — a `0`
   * there would be a measurement claiming nothing moved.
   */
  readonly commits: number | null;
  /** What moved, as a `--stat` summary; `null` when it could not be measured. */
  readonly diff: DiffStat | null;
  /** Unmerged paths, in git's own order. Empty unless `conflicted`. */
  readonly conflicts: readonly string[];
}

/**
 * The measured-and-empty diff every outcome that moved no files reports.
 *
 * Built fresh per call rather than shared, so a caller that appends to `files`
 * cannot edit the next sync's answer. Distinct from a `null` diff, which means
 * the merge landed and could not be measured.
 */
function emptyDiff(): DiffStat {
  return { files: [], insertions: 0, deletions: 0 };
}

/** The discriminated result of {@link syncTicketWorktree}. */
export type WorktreeSyncRead =
  | WorktreeReadFailure
  | { kind: "sync-error"; displayId: string; error: string }
  | {
      kind: "ok";
      displayId: string;
      worktreePath: string;
      branch: string | null;
      baseBranch: string | null;
      report: SyncReport;
    };

/** Whether a merge is mid-flight, asked of git rather than of the filesystem. */
function mergeInFlight(git: RunGit, cwd: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], cwd);
    return true;
  } catch {
    return false;
  }
}

/** The unmerged paths git is holding, or none when the failure was something else. */
function unmergedPaths(git: RunGit, cwd: string): string[] {
  try {
    return git(["diff", "--name-only", "--diff-filter=U"], cwd)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** What one revision range moved, as a `--stat` summary. */
function movement(git: RunGit, cwd: string, from: string, to: string): DiffStat {
  const files = parseNumstat(git(["diff", "--numstat", `${from}..${to}`], cwd));
  return {
    files,
    insertions: total(files, "insertions"),
    deletions: total(files, "deletions"),
  };
}

function commitCount(git: RunGit, cwd: string, from: string, to: string): number {
  const parsed = Number.parseInt(git(["rev-list", "--count", `${from}..${to}`], cwd).trim(), 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

/**
 * Merges `baseBranch` into whatever the worktree has checked out — or aborts a
 * merge already in flight — and reports the outcome without waiting on
 * anything.
 */
export function syncWithBase(
  git: RunGit,
  input: SyncInput,
  mode: SyncMode,
): WorktreeResult<SyncReport> {
  if (!input.baseBranch) {
    return err("No base branch is known for this worktree, so there is nothing to sync from.");
  }
  const cwd = input.worktreePath;
  const inFlight = mergeInFlight(git, cwd);

  if (mode === "abort") {
    if (!inFlight) {
      return err("There is no merge in progress in this worktree, so there is nothing to abort.");
    }
    try {
      git(["merge", "--abort"], cwd);
    } catch (caught) {
      return err(stderrOf(caught));
    }
    return ok({
      status: "aborted",
      // The ref a sync WOULD merge, which is what the caller is being returned
      // to — git records nothing about what the abandoned merge was against, so
      // claiming to name that would be inventing evidence.
      mergedRef: resolveComparisonRef(git, cwd, input.baseBranch)!,
      commits: 0,
      diff: emptyDiff(),
      conflicts: [],
    });
  }

  // Refusing here rather than letting git refuse: a second merge on top of an
  // unresolved one is the one failure whose recovery is a different verb, and
  // naming `--abort` in the refusal is what makes the way out discoverable.
  if (inFlight) {
    return err(
      "A merge is already in progress in this worktree. Resolve the conflicted paths and commit, or abort it, before syncing again.",
    );
  }

  const mergedRef = resolveComparisonRef(git, cwd, input.baseBranch)!;
  let before: string;
  try {
    before = git(["rev-parse", "HEAD"], cwd).trim();
  } catch (caught) {
    return err(stderrOf(caught));
  }

  try {
    // `--no-edit` because an editor prompt on a merge commit is a wedge with a
    // different name: the socket would time out waiting for a session that is
    // waiting for a text editor nobody can see.
    git(["merge", "--no-edit", mergedRef], cwd);
  } catch (caught) {
    const conflicts = unmergedPaths(git, cwd);
    // Deliberately no cleanup — see the header. The conflicted worktree IS the
    // handoff to the session that will resolve it.
    if (conflicts.length === 0) return err(stderrOf(caught));
    return ok({ status: "conflicted", mergedRef, commits: 0, diff: emptyDiff(), conflicts });
  }

  let after: string;
  try {
    after = git(["rev-parse", "HEAD"], cwd).trim();
  } catch (caught) {
    return err(stderrOf(caught));
  }
  if (after === before) {
    return ok({
      status: "already-up-to-date",
      mergedRef,
      commits: 0,
      diff: emptyDiff(),
      conflicts: [],
    });
  }

  try {
    return ok({
      status: "merged",
      mergedRef,
      commits: commitCount(git, cwd, before, after),
      diff: movement(git, cwd, before, after),
      conflicts: [],
    });
  } catch {
    // The merge COMMITTED. A failure measuring it is a reporting failure, not a
    // sync failure, and saying "sync failed" would send a session to undo work
    // that actually landed — so the outcome stands and only the size goes
    // unknown.
    return ok({ status: "merged", mergedRef, commits: null, diff: null, conflicts: [] });
  }
}

/**
 * The ticketId-in composition, in the shape `read.ts`'s verbs have: resolve the
 * ticket's identity, discriminate the no-worktree / stamped-but-deleted cases,
 * then run {@link syncWithBase}. Both doors map the discriminated result to
 * their own vocabulary.
 *
 * It shares `read.ts`'s resolver deliberately. Sync is a write, but WHICH
 * worktree it writes to is exactly the question the read verbs answer, and the
 * three ways that question fails ("no such ticket", "no worktree yet", "stamped
 * but deleted") are the same three however the answer is going to be used.
 */
export function syncTicketWorktree(
  deps: WorktreeReadDeps,
  ticketId: string,
  mode: SyncMode,
): WorktreeSyncRead {
  const resolved = resolveWorktreeTarget(deps, ticketId);
  if (resolved.kind !== "ok") return resolved;
  const { target } = resolved;
  const result = syncWithBase(
    deps.git,
    { worktreePath: target.worktreePath, baseBranch: target.baseBranch },
    mode,
  );
  if (!result.ok) {
    return { kind: "sync-error", displayId: target.displayId, error: result.error };
  }
  return {
    kind: "ok",
    displayId: target.displayId,
    worktreePath: target.worktreePath,
    branch: target.branch,
    baseBranch: target.baseBranch,
    report: result.value,
  };
}
