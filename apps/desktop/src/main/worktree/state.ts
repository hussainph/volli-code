/**
 * `listBranches` backs the base-branch pickers — the Details rail's and the
 * composer's.
 *
 * It reports three things beyond the local branch names, and all three exist to
 * keep a picker from lying about how fresh a base is. `current` is what the
 * composer defaults to. `remotes` lets a user branch from `origin/main` rather
 * than from a local `main` that may be months behind it. `fetchedAt` is what
 * makes that choice honest: remote-tracking refs only move on a fetch, so they
 * are a snapshot, and nothing in the worktree pipeline fetches before branching
 * — a picker that showed `origin/main` with no age would be presenting a cached
 * ref as the remote's tip.
 *
 * FETCH_HEAD dates a fetch and nothing else, which is why it cannot be the only
 * source: `git clone` does not write one (verified, git 2.48), so a repo cloned
 * an hour ago and never fetched since had no timestamp at all and the picker
 * called its minutes-old refs "never fetched" — the exact lie this field exists
 * to prevent, told about the freshest possible repo. Absent FETCH_HEAD the
 * fallback is `packed-refs`, which the clone writes when it lays the refs down.
 * It is the clone's own answer to "when did these refs arrive", and it can only
 * be read once: the moment anything fetches, FETCH_HEAD exists and wins. A repo
 * that has genuinely never had remote refs still reports `null`.
 *
 * Only the local-branch read is load-bearing: a repo with no remote, or one
 * whose HEAD is detached, must still list its branches, so the other three
 * reads degrade to `[]`/`null` instead of failing the call.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { WorktreeBranchListing } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { err, ok, type StatMtimeMs, type WorktreeDeps, type WorktreeResult } from "./types";

export const statMtimeMs: StatMtimeMs = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/** Splits git's newline output into trimmed, non-empty lines. */
function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * A project's branch refs. Synchronous — every read is a cheap local ref or
 * stat, and none of them touch the network.
 */
export function listBranches(
  deps: WorktreeDeps,
  projectId: string,
): WorktreeResult<WorktreeBranchListing> {
  const stat = deps.statMtimeMs ?? statMtimeMs;
  const project = getProjectById(deps.db, projectId);
  if (!project) return err("Unknown project");

  let branches: string[];
  try {
    // Recency order, not alphabetical: the branch you want as a base is almost
    // always one you touched recently, and the picker shows the head of this
    // list before you type anything.
    branches = lines(
      deps.git(
        ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)"],
        project.path,
      ),
    );
  } catch (caught) {
    return err(caught instanceof Error ? caught.message : String(caught));
  }

  let current: string | null = null;
  try {
    // Empty on a detached HEAD, which `lines` turns into no entry at all.
    current = lines(deps.git(["branch", "--show-current"], project.path))[0] ?? null;
  } catch {
    // A repo we cannot read HEAD from still has usable branch names.
  }

  let remotes: string[] = [];
  try {
    remotes = lines(
      deps.git(
        ["for-each-ref", "refs/remotes", "--sort=-committerdate", "--format=%(refname:short)"],
        project.path,
      ),
      // `origin/HEAD` is a symbolic alias for whatever origin's default is; it
      // would sit in the list as a second name for a branch already in it.
    ).filter((name) => !name.endsWith("/HEAD"));
  } catch {
    // No remote configured — an ordinary local-only repo.
  }

  // `--git-path` resolves a file inside the git dir for us, so both reads below
  // are right for a repo whose git dir is elsewhere (a worktree, a `.git` file,
  // a custom GIT_DIR).
  const mtimeOfGitFile = (name: string): number | null => {
    try {
      const gitPath = lines(deps.git(["rev-parse", "--git-path", name], project.path))[0];
      return gitPath === undefined ? null : stat(resolve(project.path, gitPath));
    } catch {
      // Not a repo we can interrogate; the caller reads `null` as unknown.
      return null;
    }
  };

  // Never fetched AND no remote refs at all: `null` is the honest answer, and
  // the clone fallback would be answering about refs that do not exist.
  const fetchedAt =
    mtimeOfGitFile("FETCH_HEAD") ?? (remotes.length > 0 ? mtimeOfGitFile("packed-refs") : null);

  return ok({ branches, current, remotes, fetchedAt });
}
