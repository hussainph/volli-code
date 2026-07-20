/**
 * The one-click "commit remaining work" safety net (Done-flow §6, decision #14's
 * explicit exception to "the app never commits"). It exists so a ticket that
 * reached Done with uncommitted changes can be squared away from the Details
 * rail without dropping to a terminal — but it is deliberately narrow:
 *
 *  - It REFUSES while a sequencer op (merge/rebase/cherry-pick/revert/bisect) is
 *    mid-flight — `git add -A && git commit` there would entomb a half-finished
 *    conflict resolution as a "chore" commit. The user finishes that first.
 *  - It refuses when there is nothing to commit, rather than letting git's
 *    "nothing to commit" exit read as an opaque failure.
 *  - The message is FIXED and greppable — `chore(<DISPLAY-ID>): commit remaining
 *    work` — honest about being tool-authored.
 *  - Hook failures (a real reason a commit should not land) surface the actual
 *    stderr, never a swallowed toast.
 */
import { stderrOf } from "./git";
import { detectSequencerState } from "./sequencer";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface CommitRemainingInput {
  worktreePath: string;
  /** The ticket's display id (e.g. `VC-12`) — the commit-message scope. */
  displayId: string;
}

/** Runs the one-click commit safety net; see the module doc for its refusals. */
export function commitRemaining(
  git: RunGit,
  input: CommitRemainingInput,
): WorktreeResult<{ message: string }> {
  // Only a CONFIRMED in-progress operation blocks; `unknown` (git-dir
  // unresolvable) falls through so the real breakage surfaces on `add`/`commit`.
  if (detectSequencerState(git, input.worktreePath) === "active") {
    return err(
      "This worktree has a merge, rebase, cherry-pick, revert, or bisect in progress. " +
        "Finish or abort that operation before committing.",
    );
  }

  const message = `chore(${input.displayId}): commit remaining work`;
  try {
    // `status --porcelain` covers staged + unstaged + untracked; empty means
    // `add -A` would stage nothing, so there is genuinely nothing to commit.
    if (git(["status", "--porcelain"], input.worktreePath).trim().length === 0) {
      return err("There is nothing to commit — the worktree is already clean.");
    }
    git(["add", "-A"], input.worktreePath);
    git(["commit", "-m", message], input.worktreePath);
    return ok({ message });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}
