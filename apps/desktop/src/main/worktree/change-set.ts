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
import { isAbsolute, normalize, sep } from "node:path";

import type { ChangeSetFile, ChangeSetFileStatus, ChangeSetSnapshot } from "@volli/shared";

import { resolveComparisonRef } from "./comparison-ref";
import { stderrOf } from "./git";
import { err, ok, type RunGit, type WorktreeResult } from "./types";

export interface ChangeSetInput {
  worktreePath: string;
  /** The ticket's recorded base branch name; resolved live, never a stored SHA. */
  baseBranch: string | null;
}

export interface ChangeSetBaseFileInput {
  worktreePath: string;
  baseRevision: string;
  /** Worktree-relative path; absolute and `..` traversal are rejected. */
  path: string;
}

/** Present content at the base revision, or `missing` when the path was absent there. */
export type ChangeSetBaseFile =
  | { content: string; missing?: undefined }
  | { missing: true; content?: undefined };

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
    const statusOut = git(["status", "--porcelain=v2", "-z"], input.worktreePath);

    const tracked = composeFiles(parseNameStatus(nameStatusOut), parseNumstat(numstatOut));
    const trackedPaths = new Set(tracked.map((f) => f.path));
    const untracked = parseUntracked(statusOut).filter((f) => !trackedPaths.has(f.path));
    const files = [...tracked, ...untracked];
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

/**
 * Reads a file's contents at `baseRevision` without mutating the checkout
 * (`git show <rev>:<path>` — never `git checkout`). Path containment rejects
 * absolute paths and `..` traversal. A path absent at the base returns
 * `{ missing: true }` (added/untracked originals); other git failures surface
 * real stderr.
 */
export function readChangeSetBaseFile(
  git: RunGit,
  input: ChangeSetBaseFileInput,
): WorktreeResult<ChangeSetBaseFile> {
  if (!isSafeRepoRelativePath(input.path)) {
    return err("Path is outside the worktree.");
  }
  try {
    const content = git(["show", `${input.baseRevision}:${input.path}`], input.worktreePath);
    return ok({ content });
  } catch (caught) {
    const message = stderrOf(caught);
    if (isMissingAtRevision(message)) return ok({ missing: true });
    return err(message);
  }
}

/** Rejects absolute paths and any `..` segment after normalization. */
function isSafeRepoRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path);
  if (isAbsolute(normalized)) return false;
  const parts = normalized.split(sep);
  return !parts.some((part) => part === "..");
}

/** git show's "path does not exist in 'rev'" (and close cousins). */
function isMissingAtRevision(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("does not exist") ||
    lower.includes("exists on disk, but not in") ||
    lower.includes("path not in")
  );
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
    // statusFromCode never returns null — unrecognized codes become conflicted
    // so they cannot vanish from the snapshot (never silently swallow).
    entries.push({ status: statusFromCode(kind), path });
  }
  return entries;
}

/**
 * Parses `git diff --numstat -z -M` output.
 * Ordinary: `added\tdeleted\tpath\0`
 * Rename:   `added\tdeleted\t\0old\0new\0` (empty path field, then two path tokens).
 */
function parseNumstat(out: string): ParsedNumstat[] {
  const tokens = splitNul(out);
  const entries: ParsedNumstat[] = [];
  let i = 0;
  while (i < tokens.length) {
    const field = tokens[i++]!;
    if (field.length === 0) continue;
    const parts = field.split("\t");
    if (parts.length < 2) continue;
    const insertions = parseCount(parts[0]!);
    const deletions = parseCount(parts[1]!);
    const pathPart = parts[2] ?? "";
    const binary = insertions === null && deletions === null;
    if (pathPart.length > 0) {
      entries.push({ path: pathPart, insertions, deletions, binary });
      continue;
    }
    const previousPath = tokens[i++] ?? "";
    const path = tokens[i++] ?? "";
    if (path.length === 0) continue;
    entries.push({ path, previousPath, insertions, deletions, binary });
  }
  return entries;
}

/**
 * Parses untracked entries from `git status --porcelain=v2 -z`.
 * Format: `? <path>\0` (literal space after `?`).
 */
function parseUntracked(out: string): ChangeSetFile[] {
  const tokens = splitNul(out);
  const files: ChangeSetFile[] = [];
  for (const token of tokens) {
    if (!token.startsWith("? ")) continue;
    const path = token.slice(2);
    if (path.length === 0) continue;
    files.push({
      path,
      status: "untracked",
      insertions: null,
      deletions: null,
      binary: false,
    });
  }
  return files;
}

/**
 * Maps a git name-status letter to a Change Set status. Unmerged (`U`) and any
 * unrecognized future code become `"conflicted"` — never `null`, so a path can
 * never disappear from the snapshot without a trace.
 */
function statusFromCode(kind: string): ChangeSetFileStatus {
  switch (kind) {
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    case "D":
      return "deleted";
    case "U":
      return "conflicted";
    default:
      return "conflicted";
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
