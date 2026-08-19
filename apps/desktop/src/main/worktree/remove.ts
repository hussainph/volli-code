/**
 * `remove` (worktree-support §2/§9) — the manual escape hatch, and the only
 * route that can clear EVERY shape of stamped checkout: registered, already
 * gone from disk, or (VC-113) still on disk but forgotten by git. It NEVER
 * force-removes a dirty worktree unless the caller has explicitly confirmed
 * (`force: true` from the "Remove worktree…" dialog that states the dirtiness);
 * and it RE-VERIFIES cleanliness immediately before a non-forced delete, so a
 * stale confirmation can't discard work that appeared since. Afterward it clears
 * `worktree_path` ONLY and records `worktree_changed`: the branch is retained in
 * git, so `ticket.branch`/`base_branch` stay stamped — a later re-ensure reuses
 * the same branch (never a silently-new one after a title edit) at a fresh
 * checkout. The dir is cache; the branch is identity.
 *
 * It also ends what is bound to the checkout before removing it. That is a
 * separate act from the busy gate the IPC layer runs first: the gate asks
 * whether an agent is WORKING here and refuses if so, while this ends the
 * bindings that are merely still pointed here — which is every chat ever opened
 * on the ticket, because a binding outlives its tab. Doing it in the same beat
 * as the delete is also what narrows the gate's own check-to-destroy window:
 * anything that started a turn since the gate ran is stopped here rather than
 * having its directory pulled out from under it.
 */
import { existsSync, rmSync } from "node:fs";

import { WORKTREE_DIRTY_REFUSAL_PREFIX, type TicketEventActor } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { updateTicketFieldsCommand } from "../ticket-commands";
import type { AgentSiteReleaseReport } from "./agent-sites";
import { isOwnedWorktreePath, ownedContainers } from "./containers";
import { isWorktreeDirty } from "./dirty";
import { GitError, parseWorktreeList } from "./git";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import { clearPhase } from "./phase";
import { err, ok, type WorktreeDeps, type WorktreeResult } from "./types";

// System-driven, no session: these mutations are attributed to automation.
const SYSTEM_ACTOR: TicketEventActor = { kind: "automation" };

export interface WorktreeRemoveOptions {
  force: boolean;
  /**
   * Ends every structured binding rooted at the checkout, immediately before it
   * is deleted (see {@link import("./agent-sites").releaseAgentSites}).
   *
   * BEST-EFFORT, and that is a decision rather than an oversight: a release
   * that cannot be made to succeed would otherwise leave a worktree no route
   * can remove, which is the failure the busy gate was rewritten to end. The
   * report names what survived so the caller can say so; the delete proceeds.
   * Absent (tests, a degraded boot with no runtime) means there is nothing
   * structured attached to end.
   */
  releaseAgentSites?: (directory: string) => Promise<AgentSiteReleaseReport>;
}

/**
 * Removes a ticket's worktree. With `force: false`, refuses when the worktree
 * is dirty (re-checked here, right before deletion). With `force: true`, the
 * caller has confirmed and `git worktree remove --force` is used.
 */
export async function remove(
  deps: WorktreeDeps,
  ticketId: string,
  opts: WorktreeRemoveOptions,
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
  // A binding may still be pointed at it, which is the very state this path
  // exists to clean up, so it is released here too.
  if (!existsSync(worktreePath)) {
    await opts.releaseAgentSites?.(worktreePath);
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
      // The stable shared prefix is the remove dialog's escalation contract:
      // ONLY this refusal may offer the destructive force step.
      return err(
        `${WORKTREE_DIRTY_REFUSAL_PREFIX} (${dirty.reason ?? "dirty"}). ` +
          `Confirm removal to discard it.`,
      );
    }
  }

  // A directory git has FORGOTTEN (VC-113): the admin entry under
  // `.git/worktrees/` is gone while the checkout is still on disk, which is
  // what a half-finished removal or a second install's `git worktree remove`
  // leaves behind. `git worktree remove` refuses such a path in BOTH modes
  // ("fatal: '…' is not a working tree"), `ensure` refuses to recreate over it,
  // and Settings skips it for being DB-known — so the ticket had no route out of
  // the state at all, in or out of the app, short of a terminal.
  //
  // Deciding this is a READ, so it happens here: after the dirty gate, before
  // anything is released or deleted.
  const registered = isRegisteredWorktree(deps, project.path, worktreePath);
  // The plain delete is the one destructive act in this module git itself does
  // not perform, so it is never reached without an explicit confirmation — not
  // even when the dirty predicate happened to read the folder as clean. The
  // shared prefix is what lets the dialog offer that confirmation at all.
  if (!registered && !opts.force) {
    return err(
      `${WORKTREE_DIRTY_REFUSAL_PREFIX} (git no longer tracks this folder, so its contents can't be checked). ` +
        `Confirm removal to delete it.`,
    );
  }

  // Last thing before the checkout stops existing, and after the dirty gate on
  // purpose: a non-forced remove that is about to refuse must not have closed
  // the user's chat on the way to refusing. The order does put the executor's
  // own shutdown after the cleanliness read, so anything it writes on the way
  // out lands unseen — the same pre-existing window as any write between that
  // read and the delete, and narrower than leaving the executor running.
  await opts.releaseAgentSites?.(worktreePath);

  if (!registered) {
    // Fenced twice: confirmed above, and contained here. The path must sit
    // inside a container this database owns — the same ownership question the
    // sweep and the orphan-delete channel ask (containers.ts), because an
    // rm -rf is exactly where guessing is unaffordable.
    if (!isOwnedWorktreePath(ownedContainers(deps.db, homeDir(deps)), worktreePath)) {
      return err(
        `Git no longer tracks ${worktreePath}, and it is outside this workspace's worktree folder. ` +
          `Remove the folder yourself, then retry.`,
      );
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (caught) {
      return err(
        `Couldn't remove the worktree folder: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    try {
      deps.git(["worktree", "prune"], project.path);
    } catch {
      // Metadata cleanup is best-effort; the identity clear below still runs.
    }
    clearIdentity(deps, ticketId);
    return ok(undefined);
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
    return err(`Couldn't remove the worktree: ${message}`);
  }

  // Clear the checkout pointer (emits `worktree_changed`) after the git work succeeds.
  clearIdentity(deps, ticketId);
  return ok(undefined);
}

/**
 * Whether git still registers `worktreePath` as a worktree of the project. An
 * unreadable listing answers TRUE — the plain-delete fallback above is the
 * destructive branch, so ambiguity has to route back to git's own refusal
 * rather than to an rm -rf.
 */
function isRegisteredWorktree(
  deps: WorktreeDeps,
  projectPath: string,
  worktreePath: string,
): boolean {
  let listing: string;
  try {
    listing = deps.git(["worktree", "list", "--porcelain"], projectPath);
  } catch {
    return true;
  }
  const target = canonicalize(worktreePath);
  return parseWorktreeList(listing).some((entry) => canonicalize(entry.path) === target);
}

/**
 * Nulls `worktree_path` only (emits `worktree_changed`) and drops the phase.
 * `branch`/`base_branch` stay stamped — the branch still exists in git.
 */
function clearIdentity(deps: WorktreeDeps, ticketId: string): void {
  // `allowArchived`: the worktree dir is already deleted by the time we get
  // here, so the pointer must be nulled even on an archived ticket — otherwise
  // the row dead-ends at a path that no longer exists.
  updateTicketFieldsCommand(
    deps.db,
    { ticketId, worktreePath: null },
    { now: Date.now(), actor: SYSTEM_ACTOR },
    { allowArchived: true },
  );
  clearPhase(ticketId);
}
