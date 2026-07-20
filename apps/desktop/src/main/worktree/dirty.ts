/**
 * Dirty detection (worktree-support §7). The removal-safety predicate, and it
 * ERRS DIRTY on any ambiguity — a clean worktree dir is disposable cache, but
 * anything that might be unsaved work must be preserved (#16's no-destruction
 * law). A worktree is dirty when ANY of these hold:
 *
 *  1. `git status --porcelain` is non-empty (includes untracked files).
 *  2. Sequencer state exists — a mid-flight merge / rebase / cherry-pick /
 *     revert / bisect (detected via files in the worktree's PRIVATE gitdir,
 *     resolved with `git rev-parse --git-dir`).
 *  3. The branch has commits reachable from neither the base nor any remote:
 *     `git log <branch> --not <base> --not --remotes --max-count=1` is
 *     non-empty. Rule: unpushed local commits are unsaved work → dirty.
 *  4. `git worktree list --porcelain` marks the entry `locked` — respected
 *     absolutely.
 *  5. Submodule drift — `git submodule status` reports a `+` (different SHA) or
 *     `U` (conflict) line. `-` (uninitialized) is clean: `git worktree add`
 *     never inits submodules, so it holds no local work.
 *  6. ANY git invocation fails — an unreadable worktree is treated as dirty
 *     rather than assumed clean.
 *
 * The first matching rule short-circuits and its reason is returned.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { canonicalize } from "./paths";
import type { RunGit } from "./types";

export interface DirtyResult {
  dirty: boolean;
  /** Human-readable reason when `dirty`, else `null`. */
  reason: string | null;
}

const CLEAN: DirtyResult = { dirty: false, reason: null };

function dirty(reason: string): DirtyResult {
  return { dirty: true, reason };
}

export interface DirtyInput {
  worktreePath: string;
  /** The worktree's branch (for the unreachable-commits check); `HEAD` when unknown. */
  branch: string | null;
  /** The base branch to measure unpushed commits against; skipped when unknown. */
  baseBranch: string | null;
  /**
   * A pre-parsed `git worktree list --porcelain` for the project. When supplied,
   * the lock check reuses it instead of re-spawning git — the sweep passes one
   * listing per project rather than one per orphan in its loop.
   */
  worktreeEntries?: readonly WorktreeListEntry[];
}

/** Filenames/dirs whose presence in the private gitdir signals in-progress sequencer state. */
const SEQUENCER_ENTRIES = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
];

function checkStatus(git: RunGit, cwd: string): DirtyResult {
  try {
    const status = git(["status", "--porcelain"], cwd);
    return status.trim().length > 0 ? dirty("uncommitted or untracked changes") : CLEAN;
  } catch {
    return dirty("could not read git status");
  }
}

function checkSequencer(git: RunGit, cwd: string): DirtyResult {
  let gitDir: string;
  try {
    gitDir = git(["rev-parse", "--git-dir"], cwd).trim();
  } catch {
    return dirty("could not resolve the worktree's git directory");
  }
  const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
  for (const entry of SEQUENCER_ENTRIES) {
    if (existsSync(resolve(absoluteGitDir, entry))) {
      return dirty("an in-progress merge, rebase, cherry-pick, revert, or bisect");
    }
  }
  return CLEAN;
}

function checkUnreachableCommits(git: RunGit, input: DirtyInput): DirtyResult {
  // ONE `--not`: its negation persists over both the base and `--remotes`
  // (`--not` TOGGLES, so a second one would flip `--remotes` back to positive
  // and count every remote-only commit as "unpushed work" — verified against
  // real git).
  const args = ["log", input.branch ?? "HEAD", "--not"];
  if (input.baseBranch) args.push(input.baseBranch);
  args.push("--remotes", "--max-count=1", "--format=%H");
  try {
    const out = git(args, input.worktreePath);
    return out.trim().length > 0
      ? dirty("commits not reachable from the base or any remote")
      : CLEAN;
  } catch {
    return dirty("could not compare the branch against its base and remotes");
  }
}

function checkLock(git: RunGit, input: DirtyInput): DirtyResult {
  const target = canonicalize(input.worktreePath);
  const findLocked = (entries: readonly WorktreeListEntry[]): DirtyResult => {
    const entry = entries.find((e) => canonicalize(e.path) === target);
    return entry?.locked ? dirty("the worktree is locked (git worktree lock)") : CLEAN;
  };
  // Reuse the caller's listing when given (sweep hot path); else spawn our own.
  if (input.worktreeEntries) return findLocked(input.worktreeEntries);
  try {
    return findLocked(
      parseWorktreeList(git(["worktree", "list", "--porcelain"], input.worktreePath)),
    );
  } catch {
    return dirty("could not read the worktree lock state");
  }
}

function checkSubmodules(git: RunGit, cwd: string): DirtyResult {
  try {
    const out = git(["submodule", "status"], cwd);
    // Only `+` (a different SHA checked out — real local drift) and `U` (merge
    // conflicts) count. `-` (uninitialized) is NOT dirt: it holds no local work
    // and `git worktree add` never inits submodules, so EVERY worktree of a
    // submodule repo starts `-` — counting it would make non-forced remove and
    // the auto-sweep permanently refuse.
    const drifted = out.split("\n").some((line) => /^[+U]/.test(line));
    return drifted ? dirty("submodule drift") : CLEAN;
  } catch {
    return dirty("could not read submodule status");
  }
}

/** Runs every §7 rule in order, returning the first that fires (errs dirty on any ambiguity). */
export function isWorktreeDirty(git: RunGit, input: DirtyInput): DirtyResult {
  const checks = [
    () => checkStatus(git, input.worktreePath),
    () => checkSequencer(git, input.worktreePath),
    () => checkUnreachableCommits(git, input),
    () => checkLock(git, input),
    () => checkSubmodules(git, input.worktreePath),
  ];
  for (const check of checks) {
    const result = check();
    if (result.dirty) return result;
  }
  return CLEAN;
}
