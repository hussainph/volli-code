/**
 * The base ref that ahead/behind counts and the merge-base diff MEASURE against
 * (done-flow §3). The publish flow runs a targeted `git fetch origin <base>` so
 * divergence info is honest — but the fetch lands in the REMOTE-TRACKING ref
 * (`origin/<base>`), not the local base branch, so measuring against the local
 * branch would silently ignore everything the fetch just learned. And the PR
 * itself diffs against the REMOTE base, which `origin/<base>` is the last-known
 * state of — so when that ref exists it is the more honest comparison point in
 * both directions. When it does not (never-fetched repo, no remote, base is
 * itself a remote-tracking name), the local base branch is all there is.
 */
import type { RunGit } from "./types";

/**
 * `origin/<base>` when that remote-tracking ref exists, else `baseBranch`
 * unchanged (`null` passes through). Existence is probed with `git rev-parse
 * --verify --quiet` on the fully-qualified ref, so a base that is already a
 * remote-tracking name ("origin/main") simply fails the probe and falls back
 * to itself.
 */
export function resolveComparisonRef(
  git: RunGit,
  cwd: string,
  baseBranch: string | null,
): string | null {
  if (!baseBranch) return null;
  const remoteRef = `origin/${baseBranch}`;
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`], cwd);
    return remoteRef;
  } catch {
    return baseBranch;
  }
}
