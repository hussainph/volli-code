/**
 * Worktree diff summary (Done-flow `diff.ts`, Codex's two-mode split). The
 * Details rail shows TWO numbers: "what would the PR contain" (the branch's
 * whole delta from its base) and "what the agent is doing right now" (the
 * uncommitted tree). These are different questions, hence two modes:
 *
 *  - `working-tree`: `git diff --numstat -z -M HEAD` (uncommitted TRACKED changes)
 *    plus untracked files — numstat NEVER lists an untracked file, so we scoop
 *    them from `git ls-files -o --exclude-standard -z` and append them with null
 *    counts. Without this the rail would under-report a brand-new file.
 *  - `merge-base`: `git diff --numstat -z -M <base>...HEAD` — the three-dot range is
 *    the merge-base diff (what the PR shows), NOT `<base>..HEAD`.
 *
 * Two numstat subtleties handled: BINARY files print `-\t-` (represented as null
 * counts, so a `0` never masquerades as "unchanged" and binaries never skew the
 * line totals), and RENAMES carry separate old/new NUL tokens — we keep the
 * NEW path, the thing that exists now.
 */
import { DiffFileStat, DiffStat } from "@volli/shared";
import type { WorktreeDiffMode } from "@volli/shared";

import { resolveComparisonRefAsync } from "./comparison-ref";
import { stderrOf } from "./git";
import { parseNumstatTokens, splitNul } from "./git-output";
import { readOnlyGitAsync } from "./scan";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

export interface DiffStatInput {
  worktreePath: string;
  /** Required for `merge-base`; unused (and may be null) for `working-tree`. */
  baseBranch: string | null;
}

/** Adapts the shared `git diff --numstat -z` parser to the worktree report schema. */
export function parseNumstat(out: string): DiffFileStat[] {
  return parseNumstatTokens(splitNul(out)).map(({ path, insertions, deletions }) => ({
    path,
    insertions,
    deletions,
    untracked: false,
  }));
}

/** Sums the non-null (text) insertions/deletions into repo-wide totals. */
export function total(files: readonly DiffFileStat[], key: "insertions" | "deletions"): number {
  return files.reduce((sum, f) => sum + (f[key] ?? 0), 0);
}

/**
 * Computes a {@link DiffStat} for the worktree in the requested mode. Any git
 * failure returns an `err` carrying the real stderr (never a silent empty diff);
 * `merge-base` with no known base fails fast before spawning git.
 *
 * Async for the reason `status.ts` is (VC-369): this backs the `worktree.diff`
 * IPC verb and the `volli worktree diff` CLI door, both of which run on the
 * Electron main process, where `execFileSync` froze every window for the length
 * of the spawn.
 *
 * Background reads retain {@link readOnlyGitAsync}'s no-optional-locks policy;
 * untracked files are listed without a `status` index refresh. Porcelain
 * `git diff` does not consult the switch — it may still refresh the
 * index at its end when it finds stat-dirty entries (`diff.autoRefreshIndex`).
 */
export async function diffStat(
  runGit: RunGitAsync,
  input: DiffStatInput,
  mode: WorktreeDiffMode,
): Promise<WorktreeResult<DiffStat>> {
  const git = readOnlyGitAsync(runGit);
  if (mode === "merge-base" && !input.baseBranch) {
    return err("No base branch is known for this worktree, so its PR diff cannot be computed.");
  }
  try {
    // Merge-base measures against `origin/<base>` when that ref exists — the
    // last-known remote state the PR will actually diff against (comparison-ref.ts).
    const base =
      mode === "merge-base"
        ? await resolveComparisonRefAsync(git, input.worktreePath, input.baseBranch)
        : null;
    const numstatArgs =
      mode === "working-tree"
        ? ["diff", "--numstat", "-z", "-M", "HEAD"]
        : ["diff", "--numstat", "-z", "-M", `${base}...HEAD`];
    const tracked = parseNumstat(await git(numstatArgs, input.worktreePath));
    const untracked =
      mode === "working-tree"
        ? splitNul(
            await git(["ls-files", "-o", "--exclude-standard", "-z"], input.worktreePath),
          ).map((path): DiffFileStat => ({
            path,
            insertions: null,
            deletions: null,
            untracked: true,
          }))
        : [];
    const files = [...tracked, ...untracked];
    return ok({
      files,
      insertions: total(files, "insertions"),
      deletions: total(files, "deletions"),
    });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}
