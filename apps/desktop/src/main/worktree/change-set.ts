/**
 * Composed Change Set read model (CONCEPT #47, monaco-migration §9): one
 * snapshot of the ticket worktree's complete current outcome relative to its
 * recorded base — committed, staged, unstaged, and untracked together.
 *
 * Comparison base is resolve-and-stamp (no `base_sha` column):
 * {@link resolveChangeSetBaseRevision} → the MERGE BASE of the comparison ref
 * and HEAD at snapshot time → stamped into `baseRevision`, then diffed two-dot
 * against the working tree. Measuring from the ref's tip instead would fold
 * everything that landed on the base after the fork into the ticket's own
 * outcome. Diffs use NUL-delimited (`-z`) output and explicit rename detection
 * (`-M`) so paths with spaces/quotes/Unicode and renames parse safely.
 *
 * Every git call here goes through the ASYNC runner ({@link RunGitAsync}). A
 * snapshot is five commands over the whole worktree and re-runs on every
 * debounced filesystem event, so on `execFileSync` it froze the main process
 * — cursor, menus, and all other IPC — for its whole duration while an agent
 * was writing files.
 */
import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

import {
  CHANGE_SET_FILE_CAP,
  type ChangeSetFile,
  type ChangeSetFileStatus,
  type ChangeSetSnapshot,
} from "@volli/shared";

import { resolveChangeSetBaseRevision } from "./comparison-ref";
import { stderrOf } from "./git";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

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

/**
 * The blob at the base revision: decodable text, `missing` when the path was
 * absent there, or `binary` when it is not text at all.
 */
export type ChangeSetBaseFile =
  | { content: string; missing?: undefined; binary?: undefined }
  | { missing: true; content?: undefined; binary?: undefined }
  | { binary: true; content?: undefined; missing?: undefined };

/**
 * Prefix a base blob is NUL-sniffed over, matching volli-fs's
 * `BINARY_SNIFF_BYTES` so the same file is never text in one surface and
 * binary in another.
 */
const BINARY_SNIFF_CHARS = 64 * 1024;

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
export async function changeSetSnapshot(
  git: RunGitAsync,
  input: ChangeSetInput,
): Promise<WorktreeResult<ChangeSetSnapshot>> {
  if (!input.baseBranch) {
    return err("No base branch is known for this worktree, so its Change Set cannot be computed.");
  }
  try {
    const baseRevision = await resolveChangeSetBaseRevision(
      git,
      input.worktreePath,
      input.baseBranch,
    );
    if (!baseRevision) {
      return err(
        "No base branch is known for this worktree, so its Change Set cannot be computed.",
      );
    }
    const headRevision = (await git(["rev-parse", "HEAD"], input.worktreePath)).trim();

    // The three reads are independent of each other and each spawns git, so
    // they overlap rather than queue — the snapshot costs one round trip, not
    // three (and the working tree can't move between them any more than it
    // could between three sequential spawns).
    const [nameStatusOut, numstatOut, statusOut] = await Promise.all([
      git(["diff", "--name-status", "-z", "-M", baseRevision], input.worktreePath),
      git(["diff", "--numstat", "-z", "-M", baseRevision], input.worktreePath),
      git(["status", "--porcelain=v2", "-z", "-uall"], input.worktreePath),
    ]);

    const tracked = composeFiles(parseNameStatus(nameStatusOut), parseNumstat(numstatOut));
    // `git diff <base>` reports conflicted paths as M; porcelain v2 `u` lines
    // are the honest unmerged signal — upgrade/add those as conflicted.
    const withConflicts = applyUnmerged(tracked, parseUnmergedPaths(statusOut));
    const presentPaths = new Set(withConflicts.map((f) => f.path));
    const untracked = parseUntracked(statusOut).filter((f) => !presentPaths.has(f.path));
    const composed = [...withConflicts, ...untracked];
    // Totals are counted over the whole Change Set, then the list is cut — the
    // summary stays honest about a worktree whose file list we refuse to ship.
    const insertions = total(composed, "insertions");
    const deletions = total(composed, "deletions");
    const totalCount = composed.length;
    const truncated = totalCount > CHANGE_SET_FILE_CAP;
    const files = truncated ? composed.slice(0, CHANGE_SET_FILE_CAP) : composed;
    const revision = snapshotRevision(
      baseRevision,
      headRevision,
      files,
      insertions,
      deletions,
      totalCount,
    );
    return ok({
      baseRevision,
      headRevision,
      files,
      insertions,
      deletions,
      revision,
      truncated,
      totalCount,
    });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}

/**
 * Reads a file's contents at `baseRevision` without mutating the checkout
 * (`git show <rev>:<path>` — never `git checkout`). Path containment rejects
 * absolute paths and `..` traversal. Absence at the base is decided structurally
 * via `git cat-file -e <rev>:<path>` (exit status only — never English stderr
 * matching, which breaks under non-C locales). Other git failures surface real
 * stderr.
 */
export async function readChangeSetBaseFile(
  git: RunGitAsync,
  input: ChangeSetBaseFileInput,
): Promise<WorktreeResult<ChangeSetBaseFile>> {
  if (!isSafeRepoRelativePath(input.path)) {
    return err("Path is outside the worktree.");
  }
  const object = `${input.baseRevision}:${input.path}`;
  try {
    await git(["cat-file", "-e", object], input.worktreePath);
  } catch (probeError) {
    // Path probe failed — distinguish "rev ok, path absent" from "rev invalid".
    try {
      await git(["cat-file", "-e", input.baseRevision], input.worktreePath);
      return ok({ missing: true });
    } catch {
      return err(stderrOf(probeError));
    }
  }
  try {
    const content = await git(["show", object], input.worktreePath);
    if (isBinaryText(content)) return ok({ binary: true });
    return ok({ content });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}

/**
 * NUL-sniff over the leading window, the same verdict volli-fs reaches for the
 * working-tree side of the pair (`readContent`), so one half of a diff is never
 * text while the other is a binary stub.
 *
 * The blob arrives utf8-decoded rather than as bytes, which costs nothing for
 * this test: a 0x00 byte decodes to U+0000 and nothing else does, so a NUL in
 * the window survives the decode exactly. Only the bytes of a file we are about
 * to refuse to render are lossy.
 */
function isBinaryText(content: string): boolean {
  const window =
    content.length > BINARY_SNIFF_CHARS ? content.slice(0, BINARY_SNIFF_CHARS) : content;
  return window.includes("\0");
}

/** Rejects absolute paths and any `..` segment after normalization. */
function isSafeRepoRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false;
  const normalized = normalize(path);
  if (isAbsolute(normalized)) return false;
  const parts = normalized.split(sep);
  return !parts.some((part) => part === "..");
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
    // R and C are the two-token codes: `<code>\0<from>\0<to>\0`. `-M` on the
    // command line turns copy detection OFF whatever `diff.renames` says, so C
    // should never arrive — it is consumed anyway because the alternative is
    // reading its `<from>` as this entry's path and its `<to>` as the next
    // status code, desyncing the rest of the stream. A copy is an added file
    // that happens to know where its content came from.
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
 * Parses unmerged paths from `git status --porcelain=v2 -z`.
 * Format: `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>\0`.
 */
function parseUnmergedPaths(out: string): string[] {
  const tokens = splitNul(out);
  const paths: string[] = [];
  for (const token of tokens) {
    if (!token.startsWith("u ")) continue;
    const parts = token.split(" ");
    // u + 9 fixed fields + path (path may contain spaces — rejoin the tail).
    if (parts.length < 11) continue;
    const path = parts.slice(10).join(" ");
    if (path.length > 0) paths.push(path);
  }
  return paths;
}

/**
 * Upgrades existing entries to conflicted and appends any unmerged path that
 * name-status omitted entirely. Counts stay as composed (or null when new).
 */
function applyUnmerged(files: ChangeSetFile[], unmergedPaths: readonly string[]): ChangeSetFile[] {
  if (unmergedPaths.length === 0) return files;
  const unmerged = new Set(unmergedPaths);
  const next = files.map((file) =>
    unmerged.has(file.path) ? { ...file, status: "conflicted" as const } : file,
  );
  const present = new Set(next.map((f) => f.path));
  for (const path of unmergedPaths) {
    if (present.has(path)) continue;
    next.push({
      path,
      status: "conflicted",
      insertions: null,
      deletions: null,
      binary: false,
    });
  }
  return next;
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
  totalCount: number,
): string {
  const hash = createHash("sha1");
  hash.update(baseRevision);
  hash.update("\0");
  hash.update(headRevision);
  hash.update("\0");
  hash.update(String(insertions));
  hash.update("\0");
  hash.update(String(deletions));
  // Files past the cap are unobservable in `files`; without the count, growth
  // beyond it would look like no change at all.
  hash.update("\0");
  hash.update(String(totalCount));
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
