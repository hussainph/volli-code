/**
 * Worktree TRIM (VC-340): removing the dead weight a finished checkout carries,
 * without removing the checkout.
 *
 * The cost this answers is not disk. pnpm hardlinks into its store, so 131
 * worktrees with a full `node_modules` cost almost no bytes — they cost every
 * recursive watcher that lands on one (~100k files walked), Spotlight indexing
 * them, and any tool that has to walk the set at all. `sweepOrphans` never
 * touches them: it removes clean ORPHAN directories, and a finished ticket whose
 * folder is deliberately kept is not an orphan.
 *
 * **Trim is defined the way git defines it: content git ignores.** `node_modules`
 * was the example, never the rule — a finished worktree in another language
 * carries `target/`, `.venv/`, `__pycache__/`, `build/`, `.gradle/`,
 * `DerivedData/`, `.terraform/`. Enumerating through `git ls-files -o -i
 * --exclude-standard --directory` gives every one of them for free, in whatever
 * language the repo turns out to be, and it never sees a tracked file or an
 * untracked-but-not-ignored one — the two things that could be someone's work.
 * We enumerate rather than shell out to `git clean -fdX` so Volli holds the list
 * and can size it, report it, and refuse parts of it.
 *
 * **Ignored is not the same as disposable**, which is the second half of the
 * rule: `.env`, `.envrc`, `*.local`, keys and certificates are ignored *because*
 * they are local configuration, and a trim that took them would cost the user
 * more than the walk ever cost the machine. They are preserved by an allowlist
 * (a user setting, {@link DEFAULT_TRIM_KEEP_PATTERNS} its defaults), and the
 * report NAMES what it kept — a preservation nobody can see is indistinguishable
 * from a deletion nobody can see.
 *
 * The allowlist is matched at EVERY depth, and the first shape of this code got
 * that wrong in a way worth recording: it matched patterns only against the paths
 * git enumerates, on the theory that config never hides inside an artifact
 * directory. But `git ls-files --directory` COLLAPSES a wholly-ignored directory
 * into one entry, so a `certs/` holding nothing but `*.pem` arrives as a single
 * candidate that matches no pattern — and the trim would have taken the user's
 * keys. One rule survives that: everything git ignores goes, except a path
 * matching the keep list, wherever it sits. The cost is that a preserved file
 * deep inside a dependency tree (certifi's `cacert.pem` in a `.venv`) keeps its
 * ancestor directories, so that tree is trimmed to a skeleton rather than
 * removed outright. That is the right trade twice over: the skeleton is still
 * restored by one install, and a rule a person can predict in one sentence is
 * worth more than the last few files.
 *
 * Every refusal is a refusal of the WHOLE worktree, and it happens before
 * anything is measured: a live Session or an open terminal in the checkout, or
 * any change to a TRACKED file (`git status --porcelain`, untracked lines
 * excluded — untracked-unignored work is preserved by construction, so it is not
 * grounds to refuse). Inside the tree, a symlink pointing out of it and a
 * directory sitting on another filesystem are kept rather than followed: an
 * `rm -rf` across a mount point is not a trim.
 *
 * A directory below the root that holds a `.git` entry — a clone's `.git/`
 * directory or a linked worktree's `.git` file — is a nested git repository: it
 * is kept whole and not walked, wherever it sits, including inside a directory
 * git collapsed into one ignored entry (`vendor/`, `.claude/worktrees/`). Its
 * commits, stashes and uncommitted work exist nowhere else. This is
 * `git clean -fdX` with a single `-f`, and the nested repository's own ignore
 * rules are not applied: keeping it whole is the rule a person can predict.
 */
import { existsSync } from "node:fs";

import type { WorktreeTrimKeep, WorktreeTrimRemoval, WorktreeTrimReport } from "@volli/shared";

import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import { keepReasonFor, runTrimWalk } from "./trim-walk";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

export type { WorktreeTrimKeep, WorktreeTrimRemoval, WorktreeTrimReport };
export { keepReasonFor };

/**
 * The preserved-configuration defaults (VC-340). Ignored, but not artifacts:
 * every one of them is something a person put there and cannot get back from a
 * package manager. Extensible as a user setting; `.git/` is enforced separately
 * because it is not a preference (see {@link keepReasonFor}).
 */
export const DEFAULT_TRIM_KEEP_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.local",
  ".envrc",
  "*.pem",
  "*.key",
  ".claude/settings.local.json",
];

/** The trim's inputs. `keepPatterns` defaults to {@link DEFAULT_TRIM_KEEP_PATTERNS}. */
export interface TrimInput {
  worktreePath: string;
  keepPatterns?: readonly string[];
  /** Measure and report, delete nothing — what the UI previews with. */
  dryRun?: boolean;
  /** Absent means activity cannot be checked: trim fails closed. */
  busySites?: BusyWorktreeSites;
}

// ---- enumeration -----------------------------------------------------------

const LS_IGNORED_ARGS = [
  "ls-files",
  "-o",
  "-i",
  "--exclude-standard",
  "--directory",
  "-z",
] as const;

/**
 * Every ignored path git reports for the worktree, as relative paths (a
 * directory keeps its trailing `/`). `--directory` stops at the top-most ignored
 * directory rather than listing what is under it, which is what keeps this one
 * read cheap on a tree with a hundred thousand ignored files in it.
 */
export async function listIgnoredPaths(
  git: RunGitAsync,
  worktreePath: string,
): Promise<WorktreeResult<string[]>> {
  let output: string;
  try {
    output = await git([...LS_IGNORED_ARGS], worktreePath);
  } catch (caught) {
    return err(
      `Volli couldn't list the ignored files: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  return ok(output.split("\0").filter((entry) => entry.length > 0));
}

/**
 * The ignored paths a trim WOULD take, without measuring or touching anything —
 * the cheap probe behind the Settings table's per-worktree artifact column.
 * Preserved paths are filtered out, so a worktree holding nothing but a `.env`
 * correctly reads as having nothing to trim.
 */
export async function countIgnoredArtifacts(
  git: RunGitAsync,
  worktreePath: string,
  keepPatterns: readonly string[] = DEFAULT_TRIM_KEEP_PATTERNS,
): Promise<WorktreeResult<number>> {
  const listed = await listIgnoredPaths(git, worktreePath);
  if (!listed.ok) return listed;
  const candidates = listed.value.filter(
    (candidate) => keepReasonFor(candidate, keepPatterns) === null,
  );
  return ok(candidates.length);
}

// ---- refusals --------------------------------------------------------------

/**
 * Changes to TRACKED files, from `git status --porcelain`. Untracked lines
 * (`??`) are deliberately not counted: untracked-but-not-ignored work is never
 * touched by a trim, so refusing on it would refuse in every worktree where
 * somebody left a scratch file — which is most of them. An unreadable status
 * refuses, exactly as the dirty predicate does.
 */
async function trackedChangeRefusal(
  git: RunGitAsync,
  worktreePath: string,
): Promise<string | null> {
  let output: string;
  try {
    output = await git(["status", "--porcelain"], worktreePath);
  } catch (caught) {
    return `Volli couldn't read git status here: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    if (code === "??" || code === "!!") continue;
    return "This worktree has uncommitted changes to tracked files.";
  }
  return null;
}

// ---- the trim --------------------------------------------------------------

/**
 * Trims one worktree: enumerate what git ignores, subtract the allowlist, refuse
 * what must not be followed, size what is left, remove it, and report both
 * halves. Removals are reported largest-first, so "the top offenders" is the head
 * of the list rather than something the caller has to work out.
 *
 * Refuses the whole worktree — never a partial pass — when work is live in it or
 * a tracked file has changed. A path that could not be removed stays in `kept`
 * with the failure as its reason: it IS still there, and saying otherwise would
 * make the report a guess.
 */
export async function trimIgnoredArtifacts(
  git: RunGitAsync,
  input: TrimInput,
): Promise<WorktreeResult<WorktreeTrimReport>> {
  const worktreePath = input.worktreePath;
  const patterns = input.keepPatterns ?? DEFAULT_TRIM_KEEP_PATTERNS;
  const dryRun = input.dryRun === true;

  if (!existsSync(worktreePath)) return err("That worktree folder is missing.");

  // The ONE busy question (`activity.ts`), asked the same way the manual remove,
  // the orphan delete, and the cleanup ask it. VC-284 wrote that module because
  // two copies of "is anything running in there?" is two answers; a trim with its
  // own copy would have been the third.
  if (typeof input.busySites !== "function")
    return err("Worktree activity is unavailable; refusing to trim.");
  const busy = busySiteWithin(worktreePath, await input.busySites(worktreePath));
  if (busy !== null) return err(busyRefusal(busy));

  const tracked = await trackedChangeRefusal(git, worktreePath);
  if (tracked !== null) return err(tracked);

  const listed = await listIgnoredPaths(git, worktreePath);
  if (!listed.ok) return listed;
  // An already-trimmed worktree (the common answer) costs no worker.
  if (listed.value.length === 0) {
    return ok({ worktreePath, removed: [], kept: [], totalBytes: 0, dryRun });
  }

  // Everything git listed is planned, sized and removed on a worker thread
  // (`trim-walk.ts`, VC-1077): a `node_modules` is a hundred thousand files,
  // and walking it here would be a hundred thousand callbacks on the thread
  // that serves the UI.
  const walked = await runTrimWalk({
    worktreePath,
    candidates: listed.value,
    patterns,
    dryRun,
  });
  if (!walked.ok) return err(walked.error);

  return ok({
    worktreePath,
    removed: walked.removed,
    kept: walked.kept,
    totalBytes: walked.removed.reduce((sum, entry) => sum + entry.bytes, 0),
    dryRun,
  });
}
