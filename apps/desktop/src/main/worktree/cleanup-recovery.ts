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
 * So every announced-but-unsettled item is ASKED, once, against the world:
 *
 *  - a worktree directory git no longer registers and that is gone from disk
 *    was removed — recorded `completed`, with the branch the plan says survived;
 *  - one that is still there, still registered, was not — recorded `failed`,
 *    because nothing happened to it and it is a candidate again;
 *  - anything else (the directory is gone but git still lists it, or git cannot
 *    be read at all) is `indeterminate`: the truthful answer is that this host
 *    cannot say, and inventing either of the other two would be a claim about a
 *    deletion nobody witnessed.
 *
 * The same three questions for a metadata record, asked of the project's
 * current prunable set. Then the run is stamped interrupted.
 *
 * Everything here is read-only against git and defensive at launch: a
 * reconciliation that throws must not cost the app its start, so a failure
 * lands as `indeterminate` and is reported, never rethrown into boot.
 */
import { existsSync } from "node:fs";

import type { OrphanCleanupRun } from "@volli/shared";

import { listProjects } from "../db/projects-repo";
import type { OrphanCleanupEngine } from "./cleanup-engine";
import { parseWorktreeList } from "./git";
import { canonicalize } from "./paths";
import { readOnlyGit } from "./scan";
import type { WorktreeDeps } from "./types";

const REMOVED_AFTER_INTERRUPTION =
  "Removed the folder. Recorded at the next launch, after Volli stopped mid-cleanup.";
const NOT_REMOVED = "Volli stopped before this folder was removed; it is still here.";
const UNKNOWN_REMOVAL =
  "Volli stopped while removing this folder and can no longer tell whether it was removed. Scan again.";
const PRUNED_AFTER_INTERRUPTION =
  "Pruned this stale git record. Recorded at the next launch, after Volli stopped mid-cleanup.";
const NOT_PRUNED = "Volli stopped before this record was pruned; it is still stale.";
const UNKNOWN_PRUNE =
  "Volli stopped while pruning this record and can no longer tell whether it was pruned. Scan again.";

interface Verdict {
  state: "completed" | "failed" | "indeterminate";
  detail: string;
}

/** What the world now says about a worktree directory whose removal was announced. */
function judgeWorktree(deps: WorktreeDeps, path: string, projectPath: string | null): Verdict {
  const registered = ((): boolean | null => {
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
  })();
  const onDisk = existsSync(path);
  if (registered === false && !onDisk) {
    return { state: "completed", detail: REMOVED_AFTER_INTERRUPTION };
  }
  if (registered === true && onDisk) return { state: "failed", detail: NOT_REMOVED };
  return { state: "indeterminate", detail: UNKNOWN_REMOVAL };
}

/** What the world now says about a stale record whose prune was announced. */
function judgeMetadata(deps: WorktreeDeps, path: string, projectPath: string | null): Verdict {
  if (projectPath === null) return { state: "indeterminate", detail: UNKNOWN_PRUNE };
  try {
    const stillStale = parseWorktreeList(
      readOnlyGit(deps.git)(["worktree", "list", "--porcelain"], projectPath),
    ).some((entry) => entry.prunable !== null && canonicalize(entry.path) === canonicalize(path));
    return stillStale
      ? { state: "failed", detail: NOT_PRUNED }
      : { state: "completed", detail: PRUNED_AFTER_INTERRUPTION };
  } catch {
    return { state: "indeterminate", detail: UNKNOWN_PRUNE };
  }
}

/**
 * Reconciles every run the app never closed, and answers with them as they read
 * afterwards. Run once per launch, before anything renders the history.
 */
export async function reconcileInterruptedCleanups(deps: {
  worktree: WorktreeDeps;
  engine: OrphanCleanupEngine;
}): Promise<OrphanCleanupRun[]> {
  const open = await deps.engine.openRuns();
  const reconciled: OrphanCleanupRun[] = [];
  for (const run of open) {
    const projectPaths = new Map(
      listProjects(deps.worktree.db).map((project) => [project.id, project.path] as const),
    );
    for (const item of run.items) {
      // Only the announced-but-unsettled window is anyone's to resolve. A
      // settled item is a fact, and a pending one is work that never began.
      if (item.state !== "executing") continue;
      const projectPath =
        item.projectId === null ? null : (projectPaths.get(item.projectId) ?? null);
      const verdict =
        item.kind === "worktree"
          ? judgeWorktree(deps.worktree, item.path, projectPath)
          : judgeMetadata(deps.worktree, item.path, projectPath);
      await deps.engine.settleItem({
        commandId: run.id,
        itemId: item.id,
        state: verdict.state,
        detail: verdict.detail,
      });
    }
    const stamped = await deps.engine.markInterrupted({ commandId: run.id });
    if (stamped !== null) reconciled.push(stamped);
  }
  return reconciled;
}
