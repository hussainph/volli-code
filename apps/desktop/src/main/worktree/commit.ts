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
 *  - The message is the CALLER'S when they wrote one and the generated
 *    `chore(<DISPLAY-ID>): commit remaining work` when they did not. Blank
 *    counts as "did not", so an untouched field still lands the greppable
 *    tool-authored line it always did, and a commit recorded before the field
 *    existed reads exactly like one recorded after.
 *  - So is the staging breadth. `includeUnstaged` (absent = `true`, the
 *    historical `add -A`) stages the whole worktree; `false` commits the INDEX
 *    AS IT STANDS — no `add` at all, because staging tracked modifications with
 *    `-a` is precisely what the checkbox turned off. That mode is the one that
 *    can find nothing to do on a DIRTY tree, and that is an ERROR rather than
 *    the clean-tree no-op above: the user asked for a commit and there are
 *    changes in front of them, so "nothing happened, and here is why" beats
 *    reporting a success that wrote nothing.
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
  /** The ticket's display id (e.g. `VC-12`) — the GENERATED message's scope. */
  displayId: string;
  /** The user's message; absent or blank means "generate one". Shape-validated at the IPC door. */
  message?: string;
  /** Absent means `true` — stage the whole worktree, as this command always did. */
  includeUnstaged?: boolean;
}

/**
 * The caller-supplied half of {@link CommitRemainingInput}: the two choices the
 * rail's confirm dialog collects, both omissible to mean what this command did
 * before either existed.
 */
export type CommitChoices = Pick<CommitRemainingInput, "message" | "includeUnstaged">;

/**
 * Whether `git status --porcelain` shows at least one entry the INDEX holds.
 * Porcelain v1 puts the index state in column 1 and the worktree state in
 * column 2, so a leading space (a worktree-only change) and `?` (untracked) are
 * exactly the two the index does not hold. Read off the status already run
 * rather than asking `git diff --cached`: one subprocess fewer, and it answers
 * on an unborn branch, where a cached diff has no HEAD to compare against.
 */
function hasStagedChange(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .some((line) => line.length > 1 && line[0] !== " " && line[0] !== "?");
}

/** The caller's message, or `null` when they left it blank (whitespace-only counts). */
function userMessage(message: string | undefined): string | null {
  const trimmed = (message ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The safety net's success shape: a commit landed, carrying the message it
 * landed with (the caller's or the generated one), or the tree was already
 * clean and nothing needed doing (`committed: false`).
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

  let porcelain: string;
  try {
    // `status --porcelain` covers staged + unstaged + untracked; empty means
    // `add -A` would stage nothing, so there is genuinely nothing to commit.
    porcelain = git(["status", "--porcelain"], input.worktreePath);
  } catch (caught) {
    return err(stderrOf(caught));
  }
  if (porcelain.trim().length === 0) return ok({ committed: false });

  const includeUnstaged = input.includeUnstaged ?? true;
  // Dirty tree, empty index, and the caller excluded everything unstaged: the
  // commit would be empty. Say so instead of running it (git would fail with
  // its own "no changes added to commit" wall of hints) or, worse, reporting
  // the clean-tree no-op for a tree that is visibly not clean.
  if (!includeUnstaged && !hasStagedChange(porcelain)) {
    return err("Nothing is staged. Include unstaged changes, or stage what you want to commit.");
  }

  const message = userMessage(input.message) ?? `chore(${input.displayId}): commit remaining work`;
  try {
    if (includeUnstaged) await net("git", ["add", "-A"], input.worktreePath);
    // Args array, never a shell string (net.ts), and the message is the VALUE
    // of `-m` — a leading `-` is not a word git can read as a flag.
    await net("git", ["commit", "-m", message], input.worktreePath);
    return ok({ committed: true, message });
  } catch (caught) {
    return err(extractFailure(caught).stderr);
  }
}
