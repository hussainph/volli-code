/**
 * Worktree diff summary (Done-flow `diff.ts`, Codex's two-mode split). The
 * Details rail shows TWO numbers: "what would the PR contain" (the branch's
 * whole delta from its base) and "what the agent is doing right now" (the
 * uncommitted tree). These are different questions, hence two modes:
 *
 *  - `working-tree`: `git diff --numstat HEAD` (uncommitted TRACKED changes)
 *    plus untracked files — numstat NEVER lists an untracked file, so we scoop
 *    them from `git status --porcelain` (`??` lines) and append them with null
 *    counts. Without this the rail would under-report a brand-new file.
 *  - `merge-base`: `git diff --numstat <base>...HEAD` — the three-dot range is
 *    the merge-base diff (what the PR shows), NOT `<base>..HEAD`.
 *
 * Two numstat subtleties handled: BINARY files print `-\t-` (represented as null
 * counts, so a `0` never masquerades as "unchanged" and binaries never skew the
 * line totals), and RENAMES print the path with `=>` markers (`old => new` or
 * `pre/{old => new}/suf`) — we keep the NEW path, the thing that exists now.
 */
import { DiffFileStat, DiffStat } from "@volli/shared";

import { stderrOf } from "./git";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export type DiffMode = "working-tree" | "merge-base";

export interface DiffStatInput {
  worktreePath: string;
  /** Required for `merge-base`; unused (and may be null) for `working-tree`. */
  baseBranch: string | null;
}

/**
 * Resolves the displayed path from a numstat path field, collapsing git's rename
 * markers to the NEW path. `pre/{old => new}/suf` → `pre/new/suf`; a whole-path
 * `old => new` (no braces) → `new`; a plain path is returned unchanged.
 */
function resolveNumstatPath(raw: string): string {
  if (raw.includes("{")) {
    // Non-greedy so multiple `{…}` segments each collapse to their new side.
    return raw.replace(/\{.*? => (.*?)\}/g, "$1");
  }
  const arrow = raw.indexOf(" => ");
  return arrow === -1 ? raw : raw.slice(arrow + " => ".length);
}

/** `"-"` (binary) → null; otherwise the parsed integer (NaN → null, defensive). */
function parseCount(field: string): number | null {
  if (field === "-") return null;
  const n = Number.parseInt(field, 10);
  return Number.isInteger(n) ? n : null;
}

/** Parses `git diff --numstat` output into per-file stats (untracked=false). */
function parseNumstat(out: string): DiffFileStat[] {
  const files: DiffFileStat[] = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^(\S+)\t(\S+)\t(.*)$/.exec(line);
    if (!match) continue;
    files.push({
      insertions: parseCount(match[1]!),
      deletions: parseCount(match[2]!),
      path: resolveNumstatPath(match[3]!),
      untracked: false,
    });
  }
  return files;
}

/** Pulls `??` (untracked) paths out of `git status --porcelain`, as null-count files. */
function parseUntracked(out: string): DiffFileStat[] {
  const files: DiffFileStat[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    files.push({
      path: line.slice("?? ".length),
      insertions: null,
      deletions: null,
      untracked: true,
    });
  }
  return files;
}

/** Sums the non-null (text) insertions/deletions into repo-wide totals. */
function total(files: readonly DiffFileStat[], key: "insertions" | "deletions"): number {
  return files.reduce((sum, f) => sum + (f[key] ?? 0), 0);
}

/**
 * Computes a {@link DiffStat} for the worktree in the requested mode. Any git
 * failure returns an `err` carrying the real stderr (never a silent empty diff);
 * `merge-base` with no known base fails fast before spawning git.
 */
export function diffStat(
  git: RunGit,
  input: DiffStatInput,
  mode: DiffMode,
): WorktreeResult<DiffStat> {
  if (mode === "merge-base" && !input.baseBranch) {
    return err("No base branch is known for this worktree, so its PR diff cannot be computed.");
  }
  try {
    const numstatArgs =
      mode === "working-tree"
        ? ["diff", "--numstat", "HEAD"]
        : ["diff", "--numstat", `${input.baseBranch}...HEAD`];
    const tracked = parseNumstat(git(numstatArgs, input.worktreePath));
    const untracked =
      mode === "working-tree"
        ? parseUntracked(git(["status", "--porcelain"], input.worktreePath))
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
