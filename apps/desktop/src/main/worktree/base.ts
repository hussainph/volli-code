/**
 * Base-branch resolution (worktree-support §5): deterministic and OFFLINE.
 * Precedence — `ticket.baseBranch` → `project.base_branch` →
 * `detectProjectBaseBranch()`. The resolved NAME is stamped back onto the
 * ticket row so the record is permanent; the resolved START POINT (what `git
 * worktree add -b` branches from) prefers the local ref and falls back to the
 * remote-tracking ref `refs/remotes/origin/<name>` only when no local branch
 * exists. NO implicit `git fetch`, EVER — kickoff never waits on the network; a
 * stale local base is the honest local-first semantic (fetch-first returns with
 * issue #82).
 */
import { detectProjectBaseBranch, type RunGit } from "../project-base-branch";

/** The one remote every downstream reader of a stamped base assumes — see below. */
const ORIGIN_PREFIX = "origin/";

export interface BaseResolution {
  /** The base branch NAME, stamped into `ticket.baseBranch`, e.g. `"main"`. */
  name: string;
  /**
   * The ref `git worktree add -b <branch> <path> <startPoint>` branches from —
   * the local branch name when it exists, else the remote-tracking ref, else
   * the bare name (letting git surface a meaningful error).
   */
  startPoint: string;
}

/** Whether `ref` resolves in `cwd` — `rev-parse --verify --quiet` exits non-zero (throws) when it doesn't. */
export function refExists(git: RunGit, cwd: string, ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "--quiet", ref], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the base branch for a new worktree. Returns `null` only when no base
 * name can be determined at all (e.g. an empty repo with no branches) — the
 * caller then fails the `create` stage. When a name resolves, the start point
 * is always chosen offline from existing refs.
 */
export function resolveBaseBranch(
  git: RunGit,
  input: {
    projectPath: string;
    ticketBaseBranch: string | null;
    projectBaseBranch: string | null;
  },
): BaseResolution | null {
  const name =
    input.ticketBaseBranch ??
    input.projectBaseBranch ??
    detectProjectBaseBranch(input.projectPath, git);
  if (!name) return null;

  if (refExists(git, input.projectPath, `refs/heads/${name}`)) {
    return { name, startPoint: name };
  }

  // A base picked from the remote-tracking list names a ref that only moves on a
  // fetch, so its prefix says "start from that snapshot" rather than "start from
  // the local head". WHICH remote it names decides what gets stamped, and the
  // asymmetry is not tidiness: every later reader of `ticket.baseBranch` speaks
  // to `origin` and only `origin` — `fetchBase` runs `git fetch origin <base>`,
  // `resolveComparisonRef` probes `refs/remotes/origin/<base>`, and the PR is
  // opened with `gh pr create --base <base>` against origin's repo.
  //
  // Only `origin/` is stripped. For `origin/main` the prefix is redundant and
  // actively harmful — `main` is the same BRANCH those readers want, and the
  // prefixed form would have them name `origin/origin/main`.
  //
  // A SECOND remote is a different branch, not a different spelling of the same
  // one. `upstream/main` is offered by the composer's picker on any fork checkout
  // (`state.ts` lists all of `refs/remotes`), and origin's `main` is nobody's
  // guarantee of upstream's: stripping there would fork the worktree from one
  // branch and then silently fetch, diff and PR against the other. So the full
  // name is kept. It stays a name git resolves, which is what the readers that
  // matter for correctness use — the comparison ref and the Change Set's merge
  // base measure against exactly what the branch forked from — while the two that
  // can only speak to origin fail LOUDLY on it: the fetch is best-effort and
  // degrades to stale-local info (publish.ts step (b)), and `gh` surfaces its own
  // stderr. "You based this on a remote we cannot publish to" is the honest
  // answer there, and far better than measuring the wrong branch without a word.
  //
  // Checked AFTER refs/heads so a local branch literally named `origin/main`
  // still wins as itself.
  const remoteTracking = `refs/remotes/${name}`;
  if (name.includes("/") && refExists(git, input.projectPath, remoteTracking)) {
    const stamped = name.startsWith(ORIGIN_PREFIX) ? name.slice(ORIGIN_PREFIX.length) : name;
    return { name: stamped, startPoint: remoteTracking };
  }

  const remoteRef = `refs/remotes/origin/${name}`;
  if (refExists(git, input.projectPath, remoteRef)) {
    return { name, startPoint: remoteRef };
  }
  // Neither a local nor a remote-tracking ref — hand git the bare name and let
  // its own error be the one the user sees, rather than inventing one here.
  return { name, startPoint: name };
}
