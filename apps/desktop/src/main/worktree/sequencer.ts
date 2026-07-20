/**
 * Sequencer-state detection — the shared "is a merge/rebase/cherry-pick/revert/
 * bisect mid-flight?" probe. Both dirty detection (`dirty.ts`, §7 rule 2, where
 * it means "unsafe to remove") and the Done-flow commit/status path (`commit.ts`
 * refuses, `status.ts` reports it) need the same answer, so it lives once here
 * rather than duplicated. It reads the worktree's PRIVATE gitdir (resolved with
 * `git rev-parse --git-dir` — a linked worktree's sequencer files live under its
 * own `.git/worktrees/<name>/`, not the main checkout's) and looks for the
 * marker files git writes while a sequencer operation is in progress.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { RunGit } from "./types";

/** Filenames/dirs whose presence in the private gitdir signals in-progress sequencer state. */
export const SEQUENCER_ENTRIES = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
];

/**
 * The three answers the probe can give: `active` (a marker file exists —
 * mid-flight operation), `clean` (gitdir resolved, no markers), and `unknown`
 * (`git rev-parse --git-dir` itself failed, so we could not even look). Callers
 * decide what `unknown` means for them — dirty detection errs dirty, the commit
 * path lets the subsequent git call surface the real breakage.
 */
export type SequencerState = "active" | "clean" | "unknown";

/**
 * Resolves the worktree's private gitdir and checks for any sequencer marker.
 * The first existing marker short-circuits to `active`.
 */
export function detectSequencerState(git: RunGit, cwd: string): SequencerState {
  let gitDir: string;
  try {
    gitDir = git(["rev-parse", "--git-dir"], cwd).trim();
  } catch {
    return "unknown";
  }
  const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir);
  for (const entry of SEQUENCER_ENTRIES) {
    if (existsSync(resolve(absoluteGitDir, entry))) return "active";
  }
  return "clean";
}
