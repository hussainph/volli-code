import { isValidBranchName } from "@volli/shared";

import { runGitCapturing, runGitCapturingAsync } from "./worktree/git";

export type RunGit = (args: readonly string[], cwd: string) => string;

/** Structural twin of `worktree/types.ts`'s `RunGitAsync` (kept structural to avoid an import cycle). */
type GitRunnerAsync = (args: readonly string[], cwd: string) => Promise<string>;

function validBranch(value: string): string | null {
  const branch = value.trim();
  return branch.length > 0 && isValidBranchName(branch) ? branch : null;
}

/** Detects the remote default branch, falling back to the current local branch. */
export function detectProjectBaseBranch(
  projectPath: string,
  git: RunGit = runGitCapturing,
): string | null {
  try {
    const remoteHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], projectPath);
    const branch = validBranch(remoteHead.replace(/^refs\/remotes\/origin\//, ""));
    if (branch) return branch;
  } catch {
    // Repositories without an origin are common; try the checked-out branch.
  }

  try {
    return validBranch(git(["branch", "--show-current"], projectPath));
  } catch {
    return null;
  }
}

/**
 * {@link detectProjectBaseBranch} over the async runner, for callers on the
 * main process that must not block its event loop (the worktree `ensure`
 * pipeline — VC-16). Same detection, same fallbacks.
 */
export async function detectProjectBaseBranchAsync(
  projectPath: string,
  git: GitRunnerAsync = runGitCapturingAsync,
): Promise<string | null> {
  try {
    const remoteHead = await git(
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      projectPath,
    );
    const branch = validBranch(remoteHead.replace(/^refs\/remotes\/origin\//, ""));
    if (branch) return branch;
  } catch {
    // Repositories without an origin are common; try the checked-out branch.
  }

  try {
    return validBranch(await git(["branch", "--show-current"], projectPath));
  } catch {
    return null;
  }
}
