/**
 * The §4 reconciliation matrix — the proactive collision check run before any
 * `git worktree add`, on realpath-canonicalized paths throughout. It answers a
 * single question: is it safe to materialize the target worktree, and does the
 * add need a `git worktree prune` first?
 *
 * | DB says          | Disk says                         | Action                              |
 * |------------------|-----------------------------------|-------------------------------------|
 * | worktree at path | registered + dir present          | already-present (idempotent no-op)  |
 * | worktree at path | registered, dir missing           | prune, then recreate at same path   |
 * | no worktree      | empty dir exists, unregistered    | create (git accepts an empty dir)   |
 * | no worktree      | dir exists, looks like a worktree | friendly orphan error, never rm -rf |
 * | no worktree      | dir exists, NOT a worktree        | friendly error, never blind rm -rf  |
 * | —                | branch checked out elsewhere      | hard fail, no --force               |
 *
 * "Branch checked out elsewhere" is detected up front (T3's proactive check)
 * from `git worktree list --porcelain`, which includes the main checkout, so
 * the main repo having the branch active is caught too. `git` failures here are
 * surfaced as errors, not swallowed — a reconcile that can't see the truth must
 * not green-light a destructive add.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { GitError, parseWorktreeList } from "./git";
import { canonicalize, samePath } from "./paths";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

/** Whether the add may proceed, and whether git metadata must be pruned first. */
export type ReconcileDecision = { kind: "already-present" } | { kind: "create"; prune: boolean };

/**
 * A directory that exists on disk but isn't registered is treated as an
 * orphaned worktree ONLY when it carries a `.git` file (linked worktrees have a
 * `.git` FILE, not a dir) — that's git's own fingerprint, so pruning + recreate
 * is safe. Anything else is someone's real directory and we refuse to touch it.
 */
function looksLikeWorktree(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

export function reconcile(
  git: RunGit,
  input: { projectPath: string; worktreePath: string; branch: string },
): WorktreeResult<ReconcileDecision> {
  const targetCanonical = canonicalize(input.worktreePath);

  let listOutput: string;
  try {
    listOutput = git(["worktree", "list", "--porcelain"], input.projectPath);
  } catch (caught) {
    const detail = caught instanceof GitError ? caught.stderr || caught.message : String(caught);
    return err(`Could not read the project's worktrees: ${detail}`);
  }
  const entries = parseWorktreeList(listOutput);

  // Proactive: our branch checked out anywhere BUT our own target path is a
  // hard collision — never resolved with `--force`.
  const branchElsewhere = entries.find(
    (entry) => entry.branch === input.branch && !samePath(entry.path, input.worktreePath),
  );
  if (branchElsewhere) {
    return err(
      `Branch ${input.branch} is already checked out at ${branchElsewhere.path}. ` +
        `Close or move that checkout before reusing this ticket's worktree.`,
    );
  }

  const registered = entries.find((entry) => canonicalize(entry.path) === targetCanonical);
  const diskExists = existsSync(input.worktreePath);

  if (registered) {
    // Git knows this path. If a DIFFERENT branch is checked out here, the paths
    // collide — refuse rather than reset someone else's work.
    if (registered.branch !== null && registered.branch !== input.branch) {
      return err(
        `A worktree already exists at ${input.worktreePath} on branch ${registered.branch}, ` +
          `not ${input.branch}.`,
      );
    }
    if (diskExists) return ok({ kind: "already-present" });
    // Registered but the directory is gone — stale metadata; prune then recreate.
    return ok({ kind: "create", prune: true });
  }

  if (!diskExists) return ok({ kind: "create", prune: false });

  // Dir exists but git doesn't know it. `git worktree add` accepts an existing
  // EMPTY directory but hard-fails on a non-empty one (verified empirically),
  // so a leftover populated dir can never be silently recreated over — and we
  // never blind-rm -rf on the user's behalf. The orphan sweep (or the user) is
  // the sanctioned cleanup path; distinguish the orphaned-worktree fingerprint
  // (a `.git` FILE) so the message says what the thing actually is.
  if (readdirSync(input.worktreePath).length === 0) {
    return ok({ kind: "create", prune: false });
  }
  if (looksLikeWorktree(input.worktreePath)) {
    return err(
      `An orphaned worktree already exists at ${input.worktreePath} but git no longer tracks it. ` +
        `Remove it from Settings → Worktrees (or delete the folder), then retry.`,
    );
  }
  return err(
    `A directory already exists at ${input.worktreePath} and is not a Volli worktree. ` +
      `Move or remove it, then retry.`,
  );
}
