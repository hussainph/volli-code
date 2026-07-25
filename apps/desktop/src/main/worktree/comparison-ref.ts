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

/**
 * The concrete SHA a Change Set is stamped against: the MERGE BASE of the
 * comparison ref and HEAD, never the ref's tip.
 *
 * The Change Set answers "what has this ticket done", so it must be measured
 * from where the branch forked. Stamping the tip instead makes every commit
 * that landed on the base AFTER the fork show up as the ticket's own inverted
 * work — a file someone else added reads as Deleted, one they deleted reads as
 * Added — and the counts silently include the whole rest of the team's day.
 * (Tip is still the right operand for behind-base, which asks the opposite
 * question: how far the base has moved past us.)
 *
 * `merge-base` needs two reachable commits, so it fails in a fresh repo with no
 * HEAD commit or when the base ref is unrelated history. There the ref's tip is
 * the only answer available and is strictly better than failing the whole
 * snapshot — diffs stay honest for the common case and degrade to the old
 * behaviour in the pathological one.
 */
export function resolveChangeSetBaseRevision(
  git: RunGit,
  cwd: string,
  baseBranch: string | null,
): string | null {
  const comparisonRef = resolveComparisonRef(git, cwd, baseBranch);
  if (!comparisonRef) return null;
  try {
    const mergeBase = git(["merge-base", comparisonRef, "HEAD"], cwd).trim();
    if (mergeBase.length > 0) return mergeBase;
  } catch {
    // Fall through to the tip — see the unrelated-history / no-HEAD cases above.
  }
  return git(["rev-parse", comparisonRef], cwd).trim();
}
