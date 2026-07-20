/**
 * The one-click "commit remaining work" safety net (Done-flow §6, decision #14's
 * explicit exception to "the app never commits"). It exists so a ticket that
 * reached Done with uncommitted changes can be squared away from the Details
 * rail without dropping to a terminal — but it is deliberately narrow:
 *
 *  - It REFUSES while a sequencer op (merge/rebase/cherry-pick/revert/bisect) is
 *    mid-flight — `git add -A && git commit` there would entomb a half-finished
 *    conflict resolution as a "chore" commit. The user finishes that first.
 *  - A clean tree is a structured NO-OP (`committed: false`), not an error: the
 *    rail's status snapshot can be stale (the agent may have committed since it
 *    loaded), and a stacked commit→push flow must keep going in that case
 *    rather than dead-ending the user's push on "nothing to commit".
 *  - The message is FIXED and greppable — `chore(<DISPLAY-ID>): commit remaining
 *    work` — honest about being tool-authored.
 *  - Hook failures (a real reason a commit should not land) surface the actual
 *    stderr, never a swallowed toast.
 *
 * The quick probes (sequencer marker, `status --porcelain`) stay on the sync
 * `RunGit`, but `add`/`commit` run through the ASYNC {@link RunNet} runner:
 * `git commit` executes arbitrary hook code (pre-commit, commit-msg) whose
 * duration is unbounded, and a sync subprocess there would freeze the main
 * process — every window, IPC channel, and PTY — for the hook's full run.
 */
import { stderrOf } from "./git";
import { extractFailure, type RunNet } from "./net";
import { detectSequencerState } from "./sequencer";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface CommitRemainingInput {
  worktreePath: string;
  /** The ticket's display id (e.g. `VC-12`) — the commit-message scope. */
  displayId: string;
}

/**
 * The safety net's success shape: a commit landed with the fixed message, or
 * the tree was already clean and nothing needed doing (`committed: false`).
 */
export type CommitOutcome = { committed: true; message: string } | { committed: false };

/** Runs the one-click commit safety net; see the module doc for its rules. */
export async function commitRemaining(
  git: RunGit,
  net: RunNet,
  input: CommitRemainingInput,
): Promise<WorktreeResult<CommitOutcome>> {
  // Only a CONFIRMED in-progress operation blocks; `unknown` (git-dir
  // unresolvable) falls through so the real breakage surfaces on `add`/`commit`.
  if (detectSequencerState(git, input.worktreePath) === "active") {
    return err(
      "This worktree has a merge, rebase, cherry-pick, revert, or bisect in progress. " +
        "Finish or abort that operation before committing.",
    );
  }

  try {
    // `status --porcelain` covers staged + unstaged + untracked; empty means
    // `add -A` would stage nothing, so there is genuinely nothing to commit.
    if (git(["status", "--porcelain"], input.worktreePath).trim().length === 0) {
      return ok({ committed: false });
    }
  } catch (caught) {
    return err(stderrOf(caught));
  }

  const message = `chore(${input.displayId}): commit remaining work`;
  try {
    await net("git", ["add", "-A"], input.worktreePath);
    await net("git", ["commit", "-m", message], input.worktreePath);
    return ok({ committed: true, message });
  } catch (caught) {
    return err(extractFailure(caught).stderr);
  }
}
