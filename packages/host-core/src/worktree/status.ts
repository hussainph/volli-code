/**
 * Worktree status query (Done-flow §7 "dirty predicate split"). Where `dirty.ts`
 * answers the coarse removal-safety question ("would deleting this lose work?"),
 * the Details rail needs a FINER read so it never tells a fully-committed branch
 * to "commit remaining changes": is the tree uncommitted? is a sequencer op
 * mid-flight, or does the index hold unmerged paths (either blocks the one-click
 * commit)? and how far has the branch moved relative to its base (ahead/behind)?
 * Each field is independent — a git failure on the ahead/behind count nulls only
 * those two, never the whole report.
 *
 * The one non-silent rule (Done-flow, §16 no-destruction spirit): a FAILING
 * `git status` read is reported as `uncommitted: true`, not clean — mirroring
 * `dirty.ts`'s errs-dirty philosophy. An unreadable tree must never be presented
 * to the user as "nothing to commit".
 *
 * ## Why this is async (VC-369)
 *
 * The Details rail runs this on every mount and every watch event, and it used
 * the SYNCHRONOUS runner: five serial `execFileSync` children on the Electron
 * main process, each bounded at `GIT_COMMAND_TIMEOUT_MS` (8s). A probe measured
 * the main event loop starved for the read's entire duration — a 10ms timer
 * fired zero times across 1.6s against a slow git — which is the whole-app
 * rainbow wheel when a Ticket view opens. The reads stay SERIAL, exactly
 * as they were: the fix is that main keeps turning between them, not that the
 * read got faster, and spawning five git children at once is the wrong answer
 * on the loaded machine where this hurts most.
 */
import { resolveComparisonRefAsync } from "./comparison-ref";
import { readOnlyGitAsync } from "./scan";
import { detectSequencerStateAsync } from "./sequencer";
import type { RunGitAsync } from "./types";

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
  /**
   * Index entries still unmerged (`UU`, `AA`, …) — blocks one-click commit too.
   * Counted apart from {@link sequencerActive} because a conflicted `stash pop`,
   * `merge --squash` or `checkout -m` leaves these with NO sequencer marker
   * (VC-838). `0` when the status read failed: `uncommitted` already errs dirty
   * there, and the commit path re-reads status and refuses on its own.
   */
  unmergedPaths: number;
  /** Commits on the branch not on the base; `null` when the base is unknown or git failed. */
  aheadOfBase: number | null;
  /** Commits on the base not on the branch; `null` when the base is unknown or git failed. */
  behindBase: number | null;
  /**
   * Commits on the branch not yet on `origin/<branch>` — what a "Push updates"
   * would send. `null` when the branch is unknown or the remote-tracking ref
   * does not exist (never pushed / no remote), where the push-vs-create
   * distinction is meaningless anyway.
   */
  unpushed: number | null;
}

/**
 * The porcelain v1 XY pairs git documents as "unmerged" — both sides touched
 * the path and the index still holds its conflict stages.
 */
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * How many `git status --porcelain` (v1) entries are unmerged. Shared with the
 * one-click commit (`commit.ts`), which must refuse exactly what the rail
 * disables: `git add -A` would stage such a file, markers and all, and mark it
 * resolved — clearing the very refusal `git commit` would otherwise give.
 */
export function countUnmergedEntries(porcelain: string): number {
  return porcelain.split("\n").filter((line) => UNMERGED_XY.has(line.slice(0, 2))).length;
}

/**
 * One `git status --porcelain` read answers both the uncommitted and the
 * unmerged question. A READ FAILURE counts as uncommitted, never clean.
 */
async function readWorkingTree(
  git: RunGitAsync,
  cwd: string,
): Promise<{ uncommitted: boolean; unmergedPaths: number }> {
  try {
    const porcelain = await git(["status", "--porcelain"], cwd);
    return {
      uncommitted: porcelain.trim().length > 0,
      unmergedPaths: countUnmergedEntries(porcelain),
    };
  } catch {
    return { uncommitted: true, unmergedPaths: 0 };
  }
}

/**
 * `git rev-list --left-right --count <base>...<branch>` → `"<left>\t<right>"`,
 * where left = commits reachable from base but not branch (BEHIND) and right =
 * commits reachable from branch but not base (AHEAD). Any git failure or an
 * unparseable line yields nulls — a stale count must degrade to "unknown".
 */
async function readAheadBehind(
  git: RunGitAsync,
  input: WorktreeStatusInput,
): Promise<{ aheadOfBase: number | null; behindBase: number | null }> {
  // Measured against `origin/<base>` when that ref exists (what a fetch just
  // updated, and what the PR will actually diff against) — see comparison-ref.ts.
  const base = await resolveComparisonRefAsync(git, input.worktreePath, input.baseBranch);
  if (!base) return { aheadOfBase: null, behindBase: null };
  const branch = input.branch ?? "HEAD";
  try {
    const out = await git(
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

/**
 * `git rev-list --count refs/remotes/origin/<branch>..<branch>` — the commits a
 * "Push updates" would send. Any failure (no remote-tracking ref — never pushed
 * or no remote — or an unparseable count) degrades to `null`, never a guess.
 */
async function readUnpushed(git: RunGitAsync, input: WorktreeStatusInput): Promise<number | null> {
  if (!input.branch) return null;
  try {
    const out = await git(
      ["rev-list", "--count", `refs/remotes/origin/${input.branch}..${input.branch}`],
      input.worktreePath,
    );
    const count = Number.parseInt(out.trim(), 10);
    return Number.isInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Computes the Details-rail worktree status report (see {@link WorktreeStatusReport}).
 *
 * Every read carries `--no-optional-locks` ({@link readOnlyGitAsync}): this runs
 * in the background on every watch event, and a plain `git status` holds the
 * worktree's `index.lock` for its whole run — long enough for an agent's own
 * `git add`/`commit` in the same worktree to fail with "index.lock: File exists".
 */
export async function getWorktreeStatus(
  runGit: RunGitAsync,
  input: WorktreeStatusInput,
): Promise<WorktreeStatusReport> {
  const git = readOnlyGitAsync(runGit);
  const { uncommitted, unmergedPaths } = await readWorkingTree(git, input.worktreePath);
  return {
    uncommitted,
    sequencerActive: (await detectSequencerStateAsync(git, input.worktreePath)) === "active",
    unmergedPaths,
    ...(await readAheadBehind(git, input)),
    unpushed: await readUnpushed(git, input),
  };
}
