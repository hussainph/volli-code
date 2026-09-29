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
 *
 * OFF THE MAIN THREAD (VC-383). This verb runs on the Electron main process,
 * and it is reached unattended: the retention watch's reclaim fires it from a
 * timer and from every window focus, not only from the "Remove worktree…"
 * click. On the sync runner it was five serial `execFileSync` children for the
 * dirty predicate, then `git worktree remove` — which deletes the whole
 * checkout, `node_modules` and all, inside one child — and for a forgotten
 * directory a recursive `rmSync` of the same. Every window froze for the length
 * of the delete, with nothing the person had clicked. The potentially long git
 * and destructive filesystem work is on the async runner and `fs/promises`;
 * `existsSync` deliberately remains the one synchronous existence look. Turning
 * that cheap check into another await would widen the check-to-delete span
 * VC-383 is narrowing, not make the removal safer.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import {
  WORKTREE_DIRTY_REFUSAL_PREFIX,
  WORKTREE_UNVERIFIABLE_REFUSAL_PREFIX,
  type TicketEventActor,
} from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { updateTicketFieldsCommand } from "../ticket-commands";
import type { AgentSiteReleaseReport } from "./agent-sites";
import { isOwnedWorktreePath, ownedContainers } from "./containers";
import { acquireDeletionLease, UNDER_DELETION_REFUSAL } from "./deletion-lease";
import { isWorktreeDirtyAsync } from "./dirty";
import { GitError, parseWorktreeList } from "./git";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import { clearPhase } from "./phase";
import { withRepositoryWorktreeTurn } from "./repository-turn";
import { err, ok, type RunGitAsync, type WorktreeDeps, type WorktreeResult } from "./types";

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

  // Every destructive preflight below can yield. Take the non-waiting lease
  // while this call still owns the synchronous turn, before its first await, so
  // a terminal or a binding cannot begin inside the directory midway through a
  // manual remove or the unattended VC-383 retention reclaim.
  const lease = acquireDeletionLease(worktreePath);
  if (lease === null) return err(UNDER_DELETION_REFUSAL);
  try {
    // The required async runner, never `deps.git`: a missing seam must fail at
    // bundle construction rather than putting the delete back on Electron main.
    const git = deps.gitAsync;

    // Dir already gone (deleted manually, or a stale row): there is no work left
    // to protect and `git worktree remove` would fail on the missing path — prune
    // the stale registration and clear identity so the ticket isn't dead-ended.
    // A binding may still be pointed at it, which is the very state this path
    // exists to clean up, so it is released here too.
    if (!existsSync(worktreePath)) {
      await opts.releaseAgentSites?.(worktreePath);
      await pruneBestEffort(git, project.path);
      clearIdentity(deps, ticketId);
      return ok(undefined);
    }

    if (!opts.force) {
      const dirty = await isWorktreeDirtyAsync(git, {
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
    const registered = await isRegisteredWorktree(git, project.path, worktreePath);
    // The plain delete is the one destructive act in this module git itself does
    // not perform, so it is never reached without an explicit confirmation, not
    // even when the dirty predicate happened to read the folder as clean. It
    // refuses under its OWN prefix rather than the dirty one: this is not a
    // worktree with uncommitted work in it, it is a folder nothing can read, and
    // the dialog escalates on either.
    if (!registered && !opts.force) {
      return err(
        `${WORKTREE_UNVERIFIABLE_REFUSAL_PREFIX} (git no longer tracks the folder). ` +
          `Confirm removal to delete it.`,
      );
    }

    // Last thing before the checkout stops existing, and after the dirty gate on
    // purpose: a non-forced remove that is about to refuse must not have closed
    // the user's chat on the way to refusing. The lease stays held while this
    // shutdown yields, so nothing new can become live in the directory between
    // the clean read and the delete.
    await opts.releaseAgentSites?.(worktreePath);

    if (!registered) {
      // Fenced twice: confirmed above, and contained here. The path must sit
      // inside a container this database owns — the same ownership question the
      // sweep and the orphan-delete channel ask (containers.ts), because an
      // rm -rf is exactly where guessing is unaffordable.
      if (!isOwnedWorktreePath(ownedContainers(deps.db, homeDir(deps)), worktreePath)) {
        return err(
          `Git no longer tracks ${worktreePath}, and it sits outside this project's worktree folder. ` +
            `Delete it yourself, then try again.`,
        );
      }
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch (caught) {
        return err(
          `Couldn't delete the folder: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
      await pruneBestEffort(git, project.path);
      clearIdentity(deps, ticketId);
      return ok(undefined);
    }

    try {
      const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath];
      // The repository's turn, not just the directory's lease (VC-389). The
      // lease above orders this against work starting in THIS directory; this
      // orders the git command against every other change to the same
      // REPOSITORY, which is a different hazard with a different key.
      await withRepositoryWorktreeTurn(project.path, () => git(args, project.path));
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
  } finally {
    // Every return above, plus a throwing release or identity write, crosses
    // here: a leaked deletion lease would permanently refuse future work.
    lease.release();
  }
}

/**
 * Metadata cleanup is best-effort; the identity clear that follows still runs.
 *
 * Takes the repository's turn like every other worktree change (VC-389):
 * `prune` drops admin records across the WHOLE repository, so it is the last
 * command that may run beside another ticket's `worktree add`.
 */
async function pruneBestEffort(git: RunGitAsync, projectPath: string): Promise<void> {
  try {
    await withRepositoryWorktreeTurn(projectPath, () => git(["worktree", "prune"], projectPath));
  } catch {
    // Best-effort by contract — see the caller.
  }
}

/**
 * Whether git still registers `worktreePath` as a worktree of the project. An
 * unreadable listing answers TRUE — the plain-delete fallback above is the
 * destructive branch, so ambiguity has to route back to git's own refusal
 * rather than to an rm -rf.
 */
async function isRegisteredWorktree(
  git: RunGitAsync,
  projectPath: string,
  worktreePath: string,
): Promise<boolean> {
  let listing: string;
  try {
    listing = await git(["worktree", "list", "--porcelain"], projectPath);
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
