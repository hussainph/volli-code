/**
 * TicketId-in worktree read verbs (worktree-support §2, CONCEPT #42). The
 * shallow `getWorktreeStatus`/`diffStat` (status.ts/diff.ts) take an already
 * assembled `{ worktreePath, branch, baseBranch }` and run git — leaving every
 * caller to do ticket→identity resolution, the no-worktree discrimination, and
 * the stamped-but-deleted disk check itself. That ceremony had drifted between
 * the two doors (Electron IPC + the `volli` CLI): only the CLI checked disk
 * existence, so the IPC door fed a deleted path straight into `getWorktreeStatus`
 * and — because status.ts errs-dirty on any git failure — told the renderer a
 * DELETED worktree had `uncommitted: true`.
 *
 * These verbs are the single composed answer (#42: "getState returns the single
 * composed answer so no one joins DB + events + stores to learn what happened").
 * Each takes `(deps, ticketId)` and returns a discriminated result BOTH doors map
 * to their own vocabulary (agent error codes vs. renderer toasts). The contract
 * unifies on the CLI's stance: a stamped-but-deleted worktree is its own
 * `missing-on-disk` state, NEVER the errs-dirty `uncommitted: true` lie.
 */
import { existsSync } from "node:fs";

import type Database from "better-sqlite3";
import { displayTicketId, type DiffStat } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { diffStat, type DiffMode } from "./diff";
import { getWorktreeStatus, type WorktreeStatusReport } from "./status";
import type { RunGit } from "./types";

/**
 * The narrow deps the read verbs need — a structural subset of {@link
 * import("./types").WorktreeDeps} (which satisfies it), so the IPC door passes
 * its full `worktreeDeps(db)` unchanged. `worktreeExists` is the disk-existence
 * seam (defaults to node's `existsSync`); the CLI door threads its own scripted
 * predicate through it so tests can stamp a fictional worktree path.
 */
export interface WorktreeReadDeps {
  db: Database.Database;
  git: RunGit;
  worktreeExists?: (path: string) => boolean;
}

/** The failure arms both read verbs share, discriminated by `kind`. */
type WorktreeReadFailure =
  | { kind: "missing-ticket" }
  | { kind: "no-worktree"; displayId: string }
  | { kind: "missing-on-disk"; displayId: string; worktreePath: string };

/** The discriminated result of {@link readWorktreeStatus}. */
export type WorktreeStatusRead =
  | WorktreeReadFailure
  | {
      kind: "ok";
      displayId: string;
      worktreePath: string;
      branch: string | null;
      baseBranch: string | null;
      status: WorktreeStatusReport;
    };

/** The discriminated result of {@link readWorktreeDiff}. */
export type WorktreeDiffRead =
  | WorktreeReadFailure
  | { kind: "diff-error"; displayId: string; error: string }
  | { kind: "ok"; displayId: string; baseBranch: string | null; diff: DiffStat };

/** The resolved, on-disk worktree identity a read verb git-queries against. */
interface ReadTarget {
  displayId: string;
  worktreePath: string;
  branch: string | null;
  baseBranch: string | null;
}

/**
 * The shared ticket→identity resolution both verbs run before touching git:
 * ticket row lookup → display id → no-worktree discrimination → the
 * stamped-but-deleted disk check. Returns the failure arm directly, or the
 * resolved {@link ReadTarget} to compose a git query from.
 */
function resolveReadTarget(
  deps: WorktreeReadDeps,
  ticketId: string,
): WorktreeReadFailure | { kind: "ok"; target: ReadTarget } {
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return { kind: "missing-ticket" };
  const project = getProjectById(deps.db, ticket.project_id);
  // A row with no project is as unresolvable as a missing ticket — the display
  // id can't be derived, so callers get the same "no such thing" failure.
  if (!project) return { kind: "missing-ticket" };
  const displayId = displayTicketId(project.ticketPrefix, ticket.ticket_number);

  if (ticket.worktree_path === null) return { kind: "no-worktree", displayId };
  const exists = deps.worktreeExists ?? existsSync;
  if (!exists(ticket.worktree_path)) {
    return { kind: "missing-on-disk", displayId, worktreePath: ticket.worktree_path };
  }
  return {
    kind: "ok",
    target: {
      displayId,
      worktreePath: ticket.worktree_path,
      branch: ticket.branch,
      baseBranch: ticket.base_branch,
    },
  };
}

/**
 * Composes the finer Details-rail worktree status for a ticket: resolves its
 * identity, discriminates the no-worktree / missing-on-disk cases, and (only for
 * a present worktree) runs `getWorktreeStatus`. A deleted worktree reports
 * `missing-on-disk`, never the errs-dirty `uncommitted: true`.
 */
export function readWorktreeStatus(deps: WorktreeReadDeps, ticketId: string): WorktreeStatusRead {
  const resolved = resolveReadTarget(deps, ticketId);
  if (resolved.kind !== "ok") return resolved;
  const { target } = resolved;
  const status = getWorktreeStatus(deps.git, {
    worktreePath: target.worktreePath,
    branch: target.branch,
    baseBranch: target.baseBranch,
  });
  return {
    kind: "ok",
    displayId: target.displayId,
    worktreePath: target.worktreePath,
    branch: target.branch,
    baseBranch: target.baseBranch,
    status,
  };
}

/**
 * Composes a worktree diff summary for a ticket in the requested mode: resolves
 * identity, discriminates the same no-worktree / missing-on-disk cases, then
 * runs `diffStat`. A `diffStat` failure (git error, or `merge-base` with no
 * known base) surfaces as `diff-error` carrying the real message.
 */
export function readWorktreeDiff(
  deps: WorktreeReadDeps,
  ticketId: string,
  mode: DiffMode,
): WorktreeDiffRead {
  const resolved = resolveReadTarget(deps, ticketId);
  if (resolved.kind !== "ok") return resolved;
  const { target } = resolved;
  const result = diffStat(
    deps.git,
    { worktreePath: target.worktreePath, baseBranch: target.baseBranch },
    mode,
  );
  if (!result.ok) {
    return { kind: "diff-error", displayId: target.displayId, error: result.error };
  }
  return {
    kind: "ok",
    displayId: target.displayId,
    baseBranch: target.baseBranch,
    diff: result.value,
  };
}
