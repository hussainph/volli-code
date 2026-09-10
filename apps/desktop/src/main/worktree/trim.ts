/**
 * Worktree TRIM (VC-340): removing the dead weight a finished checkout carries,
 * without removing the checkout.
 *
 * The cost this answers is not disk. pnpm hardlinks into its store, so 131
 * worktrees with a full `node_modules` cost almost no bytes — they cost every
 * recursive watcher that lands on one (~100k files walked), Spotlight indexing
 * them, and any tool that has to walk the set at all. `sweepOrphans` never
 * touches them: it removes clean ORPHAN directories, and a finished ticket whose
 * folder is deliberately kept is not an orphan.
 *
 * **Trim is defined the way git defines it: content git ignores.** `node_modules`
 * was the example, never the rule — a finished worktree in another language
 * carries `target/`, `.venv/`, `__pycache__/`, `build/`, `.gradle/`,
 * `DerivedData/`, `.terraform/`. Enumerating through `git ls-files -o -i
 * --exclude-standard --directory` gives every one of them for free, in whatever
 * language the repo turns out to be, and it never sees a tracked file or an
 * untracked-but-not-ignored one — the two things that could be someone's work.
 * We enumerate rather than shell out to `git clean -fdX` so Volli holds the list
 * and can size it, report it, and refuse parts of it.
 *
 * **Ignored is not the same as disposable**, which is the second half of the
 * rule: `.env`, `.envrc`, `*.local`, keys and certificates are ignored *because*
 * they are local configuration, and a trim that took them would cost the user
 * more than the walk ever cost the machine. They are preserved by an allowlist
 * (a user setting, {@link DEFAULT_TRIM_KEEP_PATTERNS} its defaults), and the
 * report NAMES what it kept — a preservation nobody can see is indistinguishable
 * from a deletion nobody can see.
 *
 * The allowlist is matched at EVERY depth, and the first shape of this code got
 * that wrong in a way worth recording: it matched patterns only against the paths
 * git enumerates, on the theory that config never hides inside an artifact
 * directory. But `git ls-files --directory` COLLAPSES a wholly-ignored directory
 * into one entry, so a `certs/` holding nothing but `*.pem` arrives as a single
 * candidate that matches no pattern — and the trim would have taken the user's
 * keys. One rule survives that: everything git ignores goes, except a path
 * matching the keep list, wherever it sits. The cost is that a preserved file
 * deep inside a dependency tree (certifi's `cacert.pem` in a `.venv`) keeps its
 * ancestor directories, so that tree is trimmed to a skeleton rather than
 * removed outright. That is the right trade twice over: the skeleton is still
 * restored by one install, and a rule a person can predict in one sentence is
 * worth more than the last few files.
 *
 * Every refusal is a refusal of the WHOLE worktree, and it happens before
 * anything is measured: a live Session or an open terminal in the checkout, or
 * any change to a TRACKED file (`git status --porcelain`, untracked lines
 * excluded — untracked-unignored work is preserved by construction, so it is not
 * grounds to refuse). Inside the tree, a symlink pointing out of it and a
 * directory sitting on another filesystem are kept rather than followed: an
 * `rm -rf` across a mount point is not a trim.
 */
import { existsSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative as relativePath, resolve } from "node:path";

import type { WorktreeTrimKeep, WorktreeTrimRemoval, WorktreeTrimReport } from "../../ipc/contract";

import { busyRefusal, busySiteWithin, type BusyWorktreeSites } from "./activity";
import { isInside } from "./paths";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

export type { WorktreeTrimKeep, WorktreeTrimRemoval, WorktreeTrimReport };

/**
 * The preserved-configuration defaults (VC-340). Ignored, but not artifacts:
 * every one of them is something a person put there and cannot get back from a
 * package manager. Extensible as a user setting; `.git/` is enforced separately
 * because it is not a preference (see {@link keepReasonFor}).
 */
export const DEFAULT_TRIM_KEEP_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "*.local",
  ".envrc",
  "*.pem",
  "*.key",
  ".claude/settings.local.json",
];

/** The trim's inputs. `keepPatterns` defaults to {@link DEFAULT_TRIM_KEEP_PATTERNS}. */
export interface TrimInput {
  worktreePath: string;
  keepPatterns?: readonly string[];
  /** Measure and report, delete nothing — what the UI previews with. */
  dryRun?: boolean;
  /** Absent means nothing structured can be asked, so nothing structured blocks. */
  busySites?: BusyWorktreeSites;
}

// ---- pattern matching ------------------------------------------------------

/** One glob segment-wise: `*` and `?` never cross a `/`, everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const char of glob) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Drops a trailing `/` (git reports ignored DIRECTORIES with one) and any `./` prefix. */
function normalizeRelative(path: string): string {
  const withoutPrefix = path.startsWith("./") ? path.slice(2) : path;
  return withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
}

/**
 * Whether a candidate path stays inside the worktree by its NAME alone. The
 * canonicalizing {@link isInside} would resolve a symlink first and report an
 * out-of-tree link as an escaping path; a link is a real case with its own
 * reason (and its own handling), so this guard is kept lexical and answers only
 * the `../escape` question git output should never contain.
 */
function containsLexically(root: string, candidate: string): boolean {
  const rel = relativePath(resolve(root), resolve(candidate));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The last segment of a relative path — what a slash-less pattern matches. */
function basenameOf(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index === -1 ? relative : relative.slice(index + 1);
}

/**
 * Why `relative` must be kept, or `null` when it may go. `.git/` is not part of
 * the user's allowlist: git's own metadata is what makes the branch, the
 * commits, and the worktree registration survive a trim, so no setting may
 * expose it. (`git ls-files` never reports it either — this is the belt to that
 * suspenders, because the recursive descent below reads real directories.)
 */
export function keepReasonFor(relative: string, patterns: readonly string[]): string | null {
  const path = normalizeRelative(relative);
  if (path === ".git" || path.startsWith(".git/")) return "it is git's own metadata";
  const base = basenameOf(path);
  for (const raw of patterns) {
    const pattern = normalizeRelative(raw.trim());
    if (pattern === "") continue;
    const target = pattern.includes("/") ? path : base;
    if (globToRegExp(pattern).test(target)) return `it matches ${pattern}`;
  }
  return null;
}

// ---- planning --------------------------------------------------------------

interface PlanContext {
  root: string;
  /** The worktree root's device id: a subtree on another one is a mount, not an artifact. */
  device: number;
  patterns: readonly string[];
}

/** What one node in the tree earns: removal whole, preservation, or a split. */
type NodePlan =
  | { kind: "remove"; bytes: number; directory: boolean }
  | { kind: "keep"; reason: string }
  | { kind: "split"; removed: WorktreeTrimRemoval[]; kept: WorktreeTrimKeep[] };

/** The report path for a node: relative, with a trailing `/` when it is a directory. */
function reportPath(relative: string, directory: boolean): string {
  return directory ? `${relative}/` : relative;
}

/**
 * Plans one node, recursing into directories. A directory whose whole subtree is
 * removable comes back as a single `remove` — one `rm` for the 100k-file
 * `node_modules`, instead of 100k of them — and only a subtree holding something
 * preserved, cross-device, or pointing out of the worktree comes back `split`.
 *
 * Sizes are apparent bytes (`lstat`), summed as the plan is built because the
 * walk has to happen anyway. For a pnpm tree they overstate what the filesystem
 * gets back — the files are hardlinks into the store — and that is the honest
 * number for this ticket regardless: the cost being reclaimed is files walked.
 */
async function planNode(context: PlanContext, relative: string): Promise<NodePlan> {
  const absolute = join(context.root, relative);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return { kind: "keep", reason: "Volli couldn't read it" };
  }

  const keep = keepReasonFor(relative, context.patterns);
  if (keep !== null) return { kind: "keep", reason: keep };

  if (info.isSymbolicLink()) {
    // The link itself is one inode and unlinking it never touches its target,
    // but a link OUT of the worktree is how a Bazel-style output tree or a
    // shared cache is reached, and Volli does not answer for what is over there.
    let target: string;
    try {
      target = await realpath(absolute);
    } catch {
      return { kind: "keep", reason: "it is a symlink Volli couldn't resolve" };
    }
    if (!isInside(context.root, target)) {
      return { kind: "keep", reason: "it is a symlink out of the worktree" };
    }
    return { kind: "remove", bytes: info.size, directory: false };
  }

  if (!info.isDirectory()) return { kind: "remove", bytes: info.size, directory: false };
  // A directory on another device is a mount, not an artifact: an `rm -rf` across
  // one is not a trim. Untested on purpose rather than by omission — the branch
  // reads `lstat().dev` from the real filesystem and this module takes no seam
  // that could fake one, so pinning it would mean mounting a disk image inside
  // the suite. The line is one comparison with no state behind it; every path
  // around it is covered.
  if (info.dev !== context.device) {
    return { kind: "keep", reason: "it sits on another filesystem" };
  }

  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return { kind: "keep", reason: "Volli couldn't read it" };
  }

  // Directory inodes are not counted: the number in the report is the bytes of
  // the FILES a removal takes, which is the number a person can compare against
  // anything else they know about the folder.
  let bytes = 0;
  const removed: WorktreeTrimRemoval[] = [];
  const kept: WorktreeTrimKeep[] = [];
  let whole = true;
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    const plan = await planNode(context, childRelative);
    if (plan.kind === "remove") {
      bytes += plan.bytes;
      removed.push({ path: reportPath(childRelative, plan.directory), bytes: plan.bytes });
      continue;
    }
    whole = false;
    if (plan.kind === "keep") {
      kept.push({ path: reportPath(childRelative, entry.isDirectory()), reason: plan.reason });
    } else {
      removed.push(...plan.removed);
      kept.push(...plan.kept);
    }
  }
  if (whole) return { kind: "remove", bytes, directory: true };
  return { kind: "split", removed, kept };
}

// ---- enumeration -----------------------------------------------------------

const LS_IGNORED_ARGS = [
  "ls-files",
  "-o",
  "-i",
  "--exclude-standard",
  "--directory",
  "-z",
] as const;

/**
 * Every ignored path git reports for the worktree, as relative paths (a
 * directory keeps its trailing `/`). `--directory` stops at the top-most ignored
 * directory rather than listing what is under it, which is what keeps this one
 * read cheap on a tree with a hundred thousand ignored files in it.
 */
export async function listIgnoredPaths(
  git: RunGitAsync,
  worktreePath: string,
): Promise<WorktreeResult<string[]>> {
  let output: string;
  try {
    output = await git([...LS_IGNORED_ARGS], worktreePath);
  } catch (caught) {
    return err(
      `Volli couldn't list the ignored files: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  return ok(output.split("\0").filter((entry) => entry.length > 0));
}

/**
 * The ignored paths a trim WOULD take, without measuring or touching anything —
 * the cheap probe behind the Settings table's per-worktree artifact column.
 * Preserved paths are filtered out, so a worktree holding nothing but a `.env`
 * correctly reads as having nothing to trim.
 */
export async function countIgnoredArtifacts(
  git: RunGitAsync,
  worktreePath: string,
  keepPatterns: readonly string[] = DEFAULT_TRIM_KEEP_PATTERNS,
): Promise<WorktreeResult<number>> {
  const listed = await listIgnoredPaths(git, worktreePath);
  if (!listed.ok) return listed;
  const candidates = listed.value.filter(
    (candidate) => keepReasonFor(candidate, keepPatterns) === null,
  );
  return ok(candidates.length);
}

// ---- refusals --------------------------------------------------------------

/**
 * Changes to TRACKED files, from `git status --porcelain`. Untracked lines
 * (`??`) are deliberately not counted: untracked-but-not-ignored work is never
 * touched by a trim, so refusing on it would refuse in every worktree where
 * somebody left a scratch file — which is most of them. An unreadable status
 * refuses, exactly as the dirty predicate does.
 */
async function trackedChangeRefusal(
  git: RunGitAsync,
  worktreePath: string,
): Promise<string | null> {
  let output: string;
  try {
    output = await git(["status", "--porcelain"], worktreePath);
  } catch (caught) {
    return `Volli couldn't read git status here: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 2);
    if (code === "??" || code === "!!") continue;
    return "This worktree has uncommitted changes to tracked files.";
  }
  return null;
}

// ---- the trim --------------------------------------------------------------

/**
 * Trims one worktree: enumerate what git ignores, subtract the allowlist, refuse
 * what must not be followed, size what is left, remove it, and report both
 * halves. Removals are reported largest-first, so "the top offenders" is the head
 * of the list rather than something the caller has to work out.
 *
 * Refuses the whole worktree — never a partial pass — when work is live in it or
 * a tracked file has changed. A path that could not be removed stays in `kept`
 * with the failure as its reason: it IS still there, and saying otherwise would
 * make the report a guess.
 */
export async function trimIgnoredArtifacts(
  git: RunGitAsync,
  input: TrimInput,
): Promise<WorktreeResult<WorktreeTrimReport>> {
  const worktreePath = input.worktreePath;
  const patterns = input.keepPatterns ?? DEFAULT_TRIM_KEEP_PATTERNS;
  const dryRun = input.dryRun === true;

  if (!existsSync(worktreePath)) return err("That worktree folder is missing.");

  // The ONE busy question (`activity.ts`), asked the same way the manual remove,
  // the orphan delete, and the cleanup ask it. VC-284 wrote that module because
  // two copies of "is anything running in there?" is two answers; a trim with its
  // own copy would have been the third.
  const busy = busySiteWithin(worktreePath, (await input.busySites?.(worktreePath)) ?? []);
  if (busy !== null) return err(busyRefusal(busy));

  const tracked = await trackedChangeRefusal(git, worktreePath);
  if (tracked !== null) return err(tracked);

  const listed = await listIgnoredPaths(git, worktreePath);
  if (!listed.ok) return listed;

  let device: number;
  try {
    device = (await lstat(worktreePath)).dev;
  } catch (caught) {
    return err(
      `Volli couldn't read the worktree folder: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  const context: PlanContext = { root: worktreePath, device, patterns };

  const removed: WorktreeTrimRemoval[] = [];
  const kept: WorktreeTrimKeep[] = [];
  for (const candidate of listed.value) {
    const relative = normalizeRelative(candidate);
    const isDirectoryCandidate = candidate.endsWith("/");
    if (
      relative === "" ||
      relative === "." ||
      !containsLexically(worktreePath, join(worktreePath, relative))
    ) {
      kept.push({ path: candidate, reason: "it points out of the worktree" });
      continue;
    }
    const plan = await planNode(context, relative);
    if (plan.kind === "remove") {
      removed.push({ path: reportPath(relative, plan.directory), bytes: plan.bytes });
    } else if (plan.kind === "keep") {
      kept.push({ path: reportPath(relative, isDirectoryCandidate), reason: plan.reason });
    } else {
      removed.push(...plan.removed);
      kept.push(...plan.kept);
    }
  }

  // git's listing OVERLAPS: with `--directory` it reports a wholly-ignored
  // `certs/` and, when a pattern matches the file directly, `certs/local.pem`
  // as well. Both would otherwise be planned, double-counting bytes and
  // reporting one path twice.
  const deduped = withoutNested(removed);
  deduped.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const keptUnique = dedupeByPath(kept);
  keptUnique.sort((a, b) => a.path.localeCompare(b.path));

  const confirmed: WorktreeTrimRemoval[] = [];
  for (const removal of deduped) {
    if (dryRun) {
      confirmed.push(removal);
      continue;
    }
    try {
      await rm(join(worktreePath, normalizeRelative(removal.path)), {
        recursive: true,
        force: true,
      });
      confirmed.push(removal);
    } catch (caught) {
      keptUnique.push({
        path: removal.path,
        reason: `Volli couldn't remove it: ${caught instanceof Error ? caught.message : String(caught)}`,
      });
    }
  }

  return ok({
    worktreePath,
    removed: confirmed,
    kept: keptUnique,
    totalBytes: confirmed.reduce((sum, entry) => sum + entry.bytes, 0),
    dryRun,
  });
}

/** Whether `inner` is `outer` itself or sits under it, on report paths. */
function covers(outer: string, inner: string): boolean {
  const a = normalizeRelative(outer);
  const b = normalizeRelative(inner);
  return a === b || b.startsWith(`${a}/`);
}

/** Drops removals already covered by a shallower one, so bytes are counted once. */
function withoutNested(removals: readonly WorktreeTrimRemoval[]): WorktreeTrimRemoval[] {
  const byDepth = removals.toSorted(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );
  const accepted: WorktreeTrimRemoval[] = [];
  for (const removal of byDepth) {
    if (accepted.some((kept) => covers(kept.path, removal.path))) continue;
    accepted.push(removal);
  }
  return accepted;
}

/** One line per kept path; the first reason recorded for it wins. */
function dedupeByPath(keeps: readonly WorktreeTrimKeep[]): WorktreeTrimKeep[] {
  const seen = new Set<string>();
  const unique: WorktreeTrimKeep[] = [];
  for (const keep of keeps) {
    const path = normalizeRelative(keep.path);
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(keep);
  }
  return unique;
}
