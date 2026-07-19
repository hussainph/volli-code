/**
 * `getState` and `listBranches` (worktree-support §2). `getState` is the SINGLE
 * COMPOSED ANSWER — persisted identity (DB) + transient phase (registry) + a
 * live disk/git check — so no caller ever hand-joins the DB, the event log, and
 * the stores. `listBranches` backs the Details-rail base-branch picker.
 */
import { existsSync } from "node:fs";

import type { WorktreeIdentity } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { parseWorktreeList } from "./git";
import { canonicalize } from "./paths";
import { getPhase } from "./phase";
import {
  err,
  ok,
  type WorktreeDeps,
  type WorktreeDiskState,
  type WorktreeResult,
  type WorktreeState,
} from "./types";

/** Registered-and-present, present-but-unregistered, or gone — the live half of the state. */
function diskState(
  deps: WorktreeDeps,
  projectPath: string,
  worktreePath: string,
): WorktreeDiskState {
  const present = existsSync(worktreePath);
  let registered = false;
  try {
    const entries = parseWorktreeList(deps.git(["worktree", "list", "--porcelain"], projectPath));
    const target = canonicalize(worktreePath);
    registered = entries.some((entry) => canonicalize(entry.path) === target);
  } catch {
    // An unreadable worktree list can't upgrade "present" to "registered".
    registered = false;
  }
  if (!present) return "missing";
  return registered ? "present" : "unregistered";
}

/**
 * The composed worktree state for a ticket. `identity` is `null` when the ticket
 * is unknown or has no persisted worktree path; `disk` is `"missing"` whenever
 * there's no path to check.
 */
export async function getState(deps: WorktreeDeps, ticketId: string): Promise<WorktreeState> {
  const phase = getPhase(ticketId);
  const ticket = getTicketRow(deps.db, ticketId);
  if (!ticket) return { identity: null, phase, disk: "missing" };

  const identity: WorktreeIdentity = {
    worktreePath: ticket.worktree_path,
    branch: ticket.branch,
    baseBranch: ticket.base_branch,
  };
  // A removed checkout keeps its branch/base stamped (`remove` clears only the
  // path), so identity survives as long as ANY field is set.
  const hasIdentity =
    ticket.worktree_path !== null || ticket.branch !== null || ticket.base_branch !== null;
  if (!identity.worktreePath) {
    return { identity: hasIdentity ? identity : null, phase, disk: "missing" };
  }

  const project = getProjectById(deps.db, ticket.project_id);
  const disk = project ? diskState(deps, project.path, identity.worktreePath) : "missing";
  return { identity, phase, disk };
}

/**
 * Local branch names for a project (`git for-each-ref refs/heads`), for the
 * base-branch picker. Synchronous — a cheap ref read, no network.
 */
export function listBranches(deps: WorktreeDeps, projectId: string): WorktreeResult<string[]> {
  const project = getProjectById(deps.db, projectId);
  if (!project) return err("Unknown project");
  try {
    const output = deps.git(
      ["for-each-ref", "refs/heads", "--format=%(refname:short)"],
      project.path,
    );
    const branches = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return ok(branches);
  } catch (caught) {
    return err(caught instanceof Error ? caught.message : String(caught));
  }
}
