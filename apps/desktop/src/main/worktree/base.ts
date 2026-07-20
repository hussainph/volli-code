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

export interface BaseResolution {
  /** The base branch NAME, stamped into `ticket.baseBranch`, e.g. `"main"`. */
  name: string;
  /**
   * The ref `git worktree add -b <branch> <path> <startPoint>` branches from —
   * the local branch name when it exists, else `refs/remotes/origin/<name>`,
   * else the bare name (letting git surface a meaningful error).
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
  const remoteRef = `refs/remotes/origin/${name}`;
  if (refExists(git, input.projectPath, remoteRef)) {
    return { name, startPoint: remoteRef };
  }
  // Neither a local nor a remote-tracking ref — hand git the bare name and let
  // its own error be the one the user sees, rather than inventing one here.
  return { name, startPoint: name };
}
