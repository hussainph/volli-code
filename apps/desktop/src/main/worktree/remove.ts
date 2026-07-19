/**
 * `remove` (worktree-support §2/§9) — the manual escape hatch. It NEVER
 * force-removes a dirty worktree unless the caller has explicitly confirmed
 * (`force: true` from the "Remove worktree…" dialog that states the dirtiness);
 * and it RE-VERIFIES cleanliness immediately before a non-forced delete, so a
 * stale confirmation can't discard work that appeared since. Afterward it clears
 * `worktree_path` ONLY and records `worktree_changed`: the branch is retained in
 * git, so `ticket.branch`/`base_branch` stay stamped — a later re-ensure reuses
 * the same branch (never a silently-new one after a title edit) at a fresh
 * checkout. The dir is cache; the branch is identity.
 */
import { existsSync } from "node:fs";

import { type TicketEventActor } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { updateTicketFieldsCommand } from "../ticket-commands";
import { isWorktreeDirty } from "./dirty";
import { GitError } from "./git";
import { clearPhase } from "./phase";
import { err, ok, type WorktreeDeps, type WorktreeResult } from "./types";

const SYSTEM_ACTOR: TicketEventActor = { kind: "user" };

/**
 * Removes a ticket's worktree. With `force: false`, refuses when the worktree
 * is dirty (re-checked here, right before deletion). With `force: true`, the
 * caller has confirmed and `git worktree remove --force` is used.
 */
export async function remove(
  deps: WorktreeDeps,
  ticketId: string,
  opts: { force: boolean },
): Promise<WorktreeResult<void>> {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return err("Unknown ticket");

  const worktreePath = ticket.worktree_path;
  if (!worktreePath) {
    // Nothing on disk to remove; identity is already clear.
    clearPhase(ticketId);
    return ok(undefined);
  }

  const project = getProjectById(deps.db, ticket.project_id);
  if (!project) return err("Unknown project");

  // Dir already gone (deleted manually, or a stale row): there is no work left
  // to protect and `git worktree remove` would fail on the missing path — prune
  // the stale registration and clear identity so the ticket isn't dead-ended.
  if (!existsSync(worktreePath)) {
    try {
      deps.git(["worktree", "prune"], project.path);
    } catch {
      // Metadata cleanup is best-effort; the identity clear below still runs.
    }
    clearIdentity(deps, ticketId);
    return ok(undefined);
  }

  if (!opts.force) {
    const dirty = isWorktreeDirty(deps.git, {
      worktreePath,
      branch: ticket.branch,
      baseBranch: ticket.base_branch,
    });
    if (dirty.dirty) {
      return err(
        `Worktree has uncommitted work (${dirty.reason ?? "dirty"}). ` +
          `Confirm removal to discard it.`,
      );
    }
  }

  try {
    const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath];
    deps.git(args, project.path);
  } catch (caught) {
    const message =
      caught instanceof GitError && caught.stderr.trim()
        ? caught.stderr.trim()
        : caught instanceof Error
          ? caught.message
          : String(caught);
    return err(`Could not remove the worktree: ${message}`);
  }

  // Clear the checkout pointer (emits `worktree_changed`) after the git work succeeds.
  clearIdentity(deps, ticketId);
  return ok(undefined);
}

/**
 * Nulls `worktree_path` only (emits `worktree_changed`) and drops the phase.
 * `branch`/`base_branch` stay stamped — the branch still exists in git.
 */
function clearIdentity(deps: WorktreeDeps, ticketId: string): void {
  updateTicketFieldsCommand(
    deps.db,
    { ticketId, worktreePath: null },
    { now: Date.now(), actor: SYSTEM_ACTOR },
  );
  clearPhase(ticketId);
}
