/**
 * What the next launch does with a cleanup the app did not live through
 * (VC-284 review C3).
 *
 * The window: an item's mutation is announced, `git worktree remove` runs, and
 * the power goes out before the outcome is recorded. The folder is gone; the
 * record says `executing`. Stamping the run "interrupted" and leaving it there
 * would be honest but useless — the person is looking at a row for a directory
 * that no longer exists, with no statement about whether it was removed.
 *
 * So every announced-but-unsettled item is ASKED, once, against the world — and
 * the answers are deliberately mean (re-review C3). This pass is not
 * re-deciding anything; it is a witness arriving after the fact, and a witness
 * that guesses is worse than one that says it does not know:
 *
 *  - a worktree directory git no longer registers AND that is provably absent
 *    from disk was removed — recorded `completed`, with the branch the plan says
 *    survived. Provably absent means `ENOENT`; a stat that fails any other way
 *    (permissions, an unreadable mount) is not absence and never counts as one;
 *  - one that is still there, still registered, was not — recorded `failed`,
 *    because nothing happened to it and it is a candidate again;
 *  - anything else is `indeterminate`: the truthful answer is that this host
 *    cannot say, and inventing either of the other two would be a claim about a
 *    deletion nobody witnessed.
 *
 * A stale git RECORD can never be recorded `completed` here at all. `git
 * worktree prune` leaves no trace of itself: a record that is gone may have been
 * pruned by this command, by a later `git worktree prune` from a shell, or by
 * git's own housekeeping, and a record that came back to life says nothing about
 * what happened in between. "Still stale" is real evidence that nothing
 * happened; everything else is `indeterminate`, which reads as "scan again" —
 * and pruning a record twice costs nothing, so the conservative answer is also
 * the cheap one.
 *
 * Every question is asked of the project path the COMMAND was accepted for, not
 * of wherever the database now says that project lives: the subject is the
 * repository the person confirmed.
 *
 * Everything here is read-only against git and defensive at launch: a
 * reconciliation that throws must not cost the app its start, so a failure
 * lands as `indeterminate` and is reported, never rethrown into boot.
 */
import { statSync } from "node:fs";

import type { OrphanCleanupRun } from "@volli/shared";

import type { OrphanCleanupEngine } from "./cleanup-engine";
import { parseWorktreeList } from "./git";
import { canonicalize } from "./paths";
import { readOnlyGit } from "./scan";
import type { WorktreeDeps } from "./types";

const REMOVED_AFTER_INTERRUPTION =
  "The folder is gone and git no longer lists it. Confirmed at the next launch, after Volli stopped mid-cleanup — the removal itself happened earlier.";
const NOT_REMOVED = "Volli stopped before this folder was removed; it is still here.";
const UNKNOWN_REMOVAL =
  "Volli stopped while removing this folder and can no longer tell whether it was removed. Scan again.";
const NOT_PRUNED = "Volli stopped before this record was pruned; it is still stale.";
const UNKNOWN_PRUNE =
  "Volli stopped while pruning this record and can no longer prove whether this cleanup is what pruned it. Scan again.";

interface Verdict {
  state: "completed" | "failed" | "indeterminate";
  detail: string;
}

/** Whether a path is there, provably gone, or unanswerable. */
function onDisk(path: string): boolean | null {
  try {
    statSync(path);
    return true;
  } catch (error) {
    // Only "no such file" is absence. A permission error, a dead mount or a
    // loop is a question this host cannot answer — and `existsSync` would have
    // called every one of them "gone".
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? false : null;
  }
}

/** Whether git still registers `path` as a live worktree of `projectPath`; `null` if unreadable. */
function registered(deps: WorktreeDeps, path: string, projectPath: string | null): boolean | null {
  if (projectPath === null) return null;
  try {
    const entries = parseWorktreeList(
      readOnlyGit(deps.git)(["worktree", "list", "--porcelain"], projectPath),
    );
    return entries.some(
      (entry) => canonicalize(entry.path) === canonicalize(path) && entry.prunable === null,
    );
  } catch {
    return null;
  }
}

/** What the world now says about a worktree directory whose removal was announced. */
function judgeWorktree(deps: WorktreeDeps, path: string, projectPath: string | null): Verdict {
  const isRegistered = registered(deps, path, projectPath);
  const present = onDisk(path);
  if (isRegistered === false && present === false) {
    return { state: "completed", detail: REMOVED_AFTER_INTERRUPTION };
  }
  if (isRegistered === true && present === true) return { state: "failed", detail: NOT_REMOVED };
  return { state: "indeterminate", detail: UNKNOWN_REMOVAL };
}

/**
 * What the world now says about a stale record whose prune was announced.
 *
 * `completed` is not among the answers, on purpose: see the module comment. A
 * record that is still stale proves the prune did not run; anything else is a
 * state this host cannot attribute to this command.
 */
function judgeMetadata(deps: WorktreeDeps, path: string, projectPath: string | null): Verdict {
  if (projectPath === null) return { state: "indeterminate", detail: UNKNOWN_PRUNE };
  try {
    const stillStale = parseWorktreeList(
      readOnlyGit(deps.git)(["worktree", "list", "--porcelain"], projectPath),
    ).some((entry) => entry.prunable !== null && canonicalize(entry.path) === canonicalize(path));
    return stillStale
      ? { state: "failed", detail: NOT_PRUNED }
      : { state: "indeterminate", detail: UNKNOWN_PRUNE };
  } catch {
    return { state: "indeterminate", detail: UNKNOWN_PRUNE };
  }
}

/**
 * Reconciles every run the app never closed, and answers with them as they read
 * afterwards. Run once per launch, before anything renders the history.
 *
 * "Every" is literal: `openRuns()` asks the store for accepted-and-never-closed
 * commands without a limit, so a run that stopped ten launches ago is still
 * reconciled rather than falling off the end of the display history
 * (re-review C3).
 */
export async function reconcileInterruptedCleanups(deps: {
  worktree: WorktreeDeps;
  engine: OrphanCleanupEngine;
}): Promise<OrphanCleanupRun[]> {
  const open = await deps.engine.openRuns();
  const reconciled: OrphanCleanupRun[] = [];
  for (const run of open) {
    for (const item of run.items) {
      // Only the announced-but-unsettled window is anyone's to resolve. A
      // settled item is a fact, and a pending one is work that never began.
      if (item.state !== "executing") continue;
      const verdict =
        item.kind === "worktree"
          ? judgeWorktree(deps.worktree, item.path, item.projectPath)
          : judgeMetadata(deps.worktree, item.path, item.projectPath);
      await deps.engine.settleItem({
        commandId: run.id,
        itemId: item.id,
        state: verdict.state,
        detail: verdict.detail,
        // Stamped as established-after-the-fact, so no surface prints this
        // launch's clock as the moment a folder was removed.
        reconciled: true,
      });
    }
    const stamped = await deps.engine.markInterrupted({ commandId: run.id });
    if (stamped !== null) reconciled.push(stamped);
  }
  return reconciled;
}
