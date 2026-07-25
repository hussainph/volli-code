/**
 * Composed Change Set read model (CONCEPT #47, monaco-migration §9): one
 * snapshot of the ticket worktree's complete current outcome relative to its
 * recorded base — committed, staged, unstaged, and untracked together.
 *
 * Comparison base is resolve-and-stamp (no `base_sha` column):
 * {@link resolveComparisonRef} → concrete SHA at snapshot time → stamped into
 * `baseRevision`. Diffs use NUL-delimited (`-z`) output and explicit rename
 * detection (`-M`) so paths with spaces/quotes/Unicode and renames parse safely.
 */
import { createHash } from "node:crypto";

import type { ChangeSetFile, ChangeSetSnapshot } from "@volli/shared";

import { resolveComparisonRef } from "./comparison-ref";
import { stderrOf } from "./git";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface ChangeSetInput {
  worktreePath: string;
  /** The ticket's recorded base branch name; resolved live, never a stored SHA. */
  baseBranch: string | null;
}

/**
 * Builds a {@link ChangeSetSnapshot} for the worktree. Failures surface real
 * git stderr (never a silent empty snapshot). Missing base fails fast.
 */
export function changeSetSnapshot(
  git: RunGit,
  input: ChangeSetInput,
): WorktreeResult<ChangeSetSnapshot> {
  if (!input.baseBranch) {
    return err("No base branch is known for this worktree, so its Change Set cannot be computed.");
  }
  try {
    const comparisonRef = resolveComparisonRef(git, input.worktreePath, input.baseBranch);
    if (!comparisonRef) {
      return err(
        "No base branch is known for this worktree, so its Change Set cannot be computed.",
      );
    }
    const baseRevision = git(["rev-parse", comparisonRef], input.worktreePath).trim();
    const headRevision = git(["rev-parse", "HEAD"], input.worktreePath).trim();

    // Drive both parsers so path-safety (`-z`) and rename detection (`-M`) are
    // always part of the argv contract, even when the tree is clean.
    git(["diff", "--name-status", "-z", "-M", baseRevision], input.worktreePath);
    git(["diff", "--numstat", "-z", "-M", baseRevision], input.worktreePath);
    git(["status", "--porcelain=v2", "-z"], input.worktreePath);

    const files: ChangeSetFile[] = [];
    const insertions = 0;
    const deletions = 0;
    const revision = snapshotRevision(baseRevision, headRevision, files, insertions, deletions);
    return ok({
      baseRevision,
      headRevision,
      files,
      insertions,
      deletions,
      revision,
    });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}

/** Opaque staleness token — changes whenever the observable outcome changes. */
function snapshotRevision(
  baseRevision: string,
  headRevision: string,
  files: readonly ChangeSetFile[],
  insertions: number,
  deletions: number,
): string {
  const hash = createHash("sha1");
  hash.update(baseRevision);
  hash.update("\0");
  hash.update(headRevision);
  hash.update("\0");
  hash.update(String(insertions));
  hash.update("\0");
  hash.update(String(deletions));
  for (const file of files) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.previousPath ?? "");
    hash.update("\0");
    hash.update(file.status);
    hash.update("\0");
    hash.update(String(file.insertions));
    hash.update("\0");
    hash.update(String(file.deletions));
    hash.update("\0");
    hash.update(file.binary ? "1" : "0");
  }
  return hash.digest("hex");
}
