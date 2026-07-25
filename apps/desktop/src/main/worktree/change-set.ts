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

import type { ChangeSetFile, ChangeSetFileStatus, ChangeSetSnapshot } from "@volli/shared";

import { resolveComparisonRef } from "./comparison-ref";
import { stderrOf } from "./git";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface ChangeSetInput {
  worktreePath: string;
  /** The ticket's recorded base branch name; resolved live, never a stored SHA. */
  baseBranch: string | null;
}

interface ParsedNameStatus {
  status: ChangeSetFileStatus;
  path: string;
  previousPath?: string;
}

interface ParsedNumstat {
  path: string;
  previousPath?: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
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

    const nameStatusOut = git(
      ["diff", "--name-status", "-z", "-M", baseRevision],
      input.worktreePath,
    );
    const numstatOut = git(["diff", "--numstat", "-z", "-M", baseRevision], input.worktreePath);
    // Untracked scoop — porcelain v2 is NUL-safe; wired in a later slice.
    git(["status", "--porcelain=v2", "-z"], input.worktreePath);

    const files = composeFiles(parseNameStatus(nameStatusOut), parseNumstat(numstatOut));
    const insertions = total(files, "insertions");
    const deletions = total(files, "deletions");
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

function composeFiles(
  nameStatuses: readonly ParsedNameStatus[],
  numstats: readonly ParsedNumstat[],
): ChangeSetFile[] {
  const byPath = new Map<string, ParsedNumstat>();
  for (const entry of numstats) {
    byPath.set(entry.path, entry);
  }
  return nameStatuses.map((entry) => {
    const counts = byPath.get(entry.path);
    const insertions = counts?.insertions ?? null;
    const deletions = counts?.deletions ?? null;
    const binary = counts?.binary ?? false;
    return {
      path: entry.path,
      ...(entry.previousPath !== undefined ? { previousPath: entry.previousPath } : {}),
      status: entry.status,
      insertions,
      deletions,
      binary,
    };
  });
}

/**
 * Parses `git diff --name-status -z -M` output.
 * Ordinary: `M\0path\0` · Rename: `R100\0old\0new\0`.
 */
function parseNameStatus(out: string): ParsedNameStatus[] {
  const tokens = splitNul(out);
  const entries: ParsedNameStatus[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i]!;
    i += 1;
    if (code.length === 0) continue;
    const kind = code[0]!;
    if (kind === "R" || kind === "C") {
      const previousPath = tokens[i++] ?? "";
      const path = tokens[i++] ?? "";
      if (path.length === 0) continue;
      entries.push({
        status: kind === "R" ? "renamed" : "added",
        path,
        previousPath,
      });
      continue;
    }
    const path = tokens[i++] ?? "";
    if (path.length === 0) continue;
    const status = statusFromCode(kind);
    if (status) entries.push({ status, path });
  }
  return entries;
}

/**
 * Parses `git diff --numstat -z -M` output.
 * Ordinary: `added\tdeleted\0path\0` · Rename: `added\tdeleted\0old\0new\0`.
 */
function parseNumstat(out: string): ParsedNumstat[] {
  const tokens = splitNul(out);
  const entries: ParsedNumstat[] = [];
  let i = 0;
  while (i < tokens.length) {
    const counts = tokens[i]!;
    i += 1;
    if (counts.length === 0) continue;
    const tab = counts.indexOf("\t");
    if (tab === -1) continue;
    const insertions = parseCount(counts.slice(0, tab));
    const deletions = parseCount(counts.slice(tab + 1));
    const firstPath = tokens[i++] ?? "";
    if (firstPath.length === 0) continue;
    // Rename/copy: two path tokens before the next counts field (or end).
    // Counts fields always contain a tab (`added\tdeleted`); paths never do.
    const next = tokens[i];
    const nextLooksLikeCounts = next !== undefined && next.includes("\t");
    if (next !== undefined && next.length > 0 && !nextLooksLikeCounts) {
      i += 1;
      entries.push({
        path: next,
        previousPath: firstPath,
        insertions,
        deletions,
        binary: insertions === null && deletions === null,
      });
    } else {
      entries.push({
        path: firstPath,
        insertions,
        deletions,
        binary: insertions === null && deletions === null,
      });
    }
  }
  return entries;
}

function statusFromCode(kind: string): ChangeSetFileStatus | null {
  switch (kind) {
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    case "D":
      return "deleted";
    default:
      return null;
  }
}

/** `"-"` (binary) → null; otherwise the parsed integer. */
function parseCount(field: string): number | null {
  if (field === "-") return null;
  const n = Number.parseInt(field, 10);
  return Number.isInteger(n) ? n : null;
}

function splitNul(out: string): string[] {
  if (out.length === 0) return [];
  const parts = out.split("\0");
  // git's trailing NUL leaves a final empty token — drop it.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function total(files: readonly ChangeSetFile[], key: "insertions" | "deletions"): number {
  return files.reduce((sum, f) => sum + (f[key] ?? 0), 0);
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
