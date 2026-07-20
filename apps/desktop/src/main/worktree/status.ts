/**
 * Worktree status query (Done-flow §7 "dirty predicate split"). Where `dirty.ts`
 * answers the coarse removal-safety question ("would deleting this lose work?"),
 * the Details rail needs a FINER read so it never tells a fully-committed branch
 * to "commit remaining changes": is the tree uncommitted? is a sequencer op
 * mid-flight (which would block the one-click commit)? and how far has the branch
 * moved relative to its base (ahead/behind)? Each field is independent — a git
 * failure on the ahead/behind count nulls only those two, never the whole report.
 *
 * The one non-silent rule (Done-flow, §16 no-destruction spirit): a FAILING
 * `git status` read is reported as `uncommitted: true`, not clean — mirroring
 * `dirty.ts`'s errs-dirty philosophy. An unreadable tree must never be presented
 * to the user as "nothing to commit".
 */
import { resolveComparisonRef } from "./comparison-ref";
import { detectSequencerState } from "./sequencer";
import type { RunGit } from "./types";

export interface WorktreeStatusInput {
  worktreePath: string;
  /** The worktree's branch; `HEAD` is used for the ahead/behind range when null. */
  branch: string | null;
  /** The base to measure ahead/behind against; ahead/behind are null when unknown. */
  baseBranch: string | null;
}

export interface WorktreeStatusReport {
  /** `git status --porcelain` non-empty — OR the read failed (never silently clean). */
  uncommitted: boolean;
  /** A merge/rebase/cherry-pick/revert/bisect is mid-flight (blocks one-click commit). */
  sequencerActive: boolean;
  /** Commits on the branch not on the base; `null` when the base is unknown or git failed. */
  aheadOfBase: number | null;
  /** Commits on the base not on the branch; `null` when the base is unknown or git failed. */
  behindBase: number | null;
}

/** `git status --porcelain` non-empty; a READ FAILURE counts as uncommitted, never clean. */
function readUncommitted(git: RunGit, cwd: string): boolean {
  try {
    return git(["status", "--porcelain"], cwd).trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * `git rev-list --left-right --count <base>...<branch>` → `"<left>\t<right>"`,
 * where left = commits reachable from base but not branch (BEHIND) and right =
 * commits reachable from branch but not base (AHEAD). Any git failure or an
 * unparseable line yields nulls — a stale count must degrade to "unknown".
 */
function readAheadBehind(
  git: RunGit,
  input: WorktreeStatusInput,
): { aheadOfBase: number | null; behindBase: number | null } {
  // Measured against `origin/<base>` when that ref exists (what a fetch just
  // updated, and what the PR will actually diff against) — see comparison-ref.ts.
  const base = resolveComparisonRef(git, input.worktreePath, input.baseBranch);
  if (!base) return { aheadOfBase: null, behindBase: null };
  const branch = input.branch ?? "HEAD";
  try {
    const out = git(
      ["rev-list", "--left-right", "--count", `${base}...${branch}`],
      input.worktreePath,
    );
    const [left, right] = out.trim().split(/\s+/);
    const behind = Number.parseInt(left ?? "", 10);
    const ahead = Number.parseInt(right ?? "", 10);
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
      return { aheadOfBase: null, behindBase: null };
    }
    return { aheadOfBase: ahead, behindBase: behind };
  } catch {
    return { aheadOfBase: null, behindBase: null };
  }
}

/** Computes the Details-rail worktree status report (see {@link WorktreeStatusReport}). */
export function getWorktreeStatus(git: RunGit, input: WorktreeStatusInput): WorktreeStatusReport {
  return {
    uncommitted: readUncommitted(git, input.worktreePath),
    sequencerActive: detectSequencerState(git, input.worktreePath) === "active",
    ...readAheadBehind(git, input),
  };
}
