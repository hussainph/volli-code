/**
 * The trim's tree walk and removal (VC-340), run on a worker thread (VC-1077).
 *
 * A trimmed worktree is typically a `node_modules` of a hundred thousand
 * files. Walked with async `fs` on the host's own thread, that is one
 * `lstat` and one completion callback per file, plus a recursive `rm` that
 * issues one request per entry — hundreds of thousands of callbacks on the
 * thread that also serves the UI and every Session, and a libuv thread pool
 * held saturated for seconds, so any other file read (a pane opening, a
 * transcript load) waits behind it. Measured on an 80k-file tree: ~255k
 * file-system callbacks on the host thread and a concurrent small read
 * stalled for ~11 s.
 *
 * So the walk runs in a worker thread with SYNCHRONOUS `fs` calls. A sync
 * call runs on the calling thread — the worker's — and never enters the
 * shared libuv pool, so the host thread pays for spawning the worker and
 * receiving one message, and nothing else.
 *
 * The worker is started from source text (`eval: true`) rather than a file a
 * host has to bundle as its own entry: the trim is reached from the board,
 * the retention watch, the sweep and the runner jobs, on desktop and on a
 * headless host, and none of them should have to know a worker path. The
 * source is the `toString()` of the self-contained functions below, so they
 * stay type-checked TypeScript: each one may reference only its parameters,
 * its own locals, and the other functions in {@link WORKER_FUNCTIONS} —
 * never an import, which would not exist on the other side. A worker that
 * fails to start or answer refuses the trim; it never falls back to walking
 * on the host thread.
 */
import { Worker } from "node:worker_threads";

import type { WorktreeTrimKeep, WorktreeTrimRemoval } from "@volli/shared";

/** What the worker walks: git's ignored listing for one worktree, and the keep list. */
export interface TrimWalkRequest {
  worktreePath: string;
  /** `git ls-files -o -i --directory` output, verbatim (directories keep their `/`). */
  candidates: readonly string[];
  patterns: readonly string[];
  dryRun: boolean;
}

/** The walk's answer: what went (largest first) and what stayed (by path). */
export type TrimWalkAnswer =
  | { ok: true; removed: WorktreeTrimRemoval[]; kept: WorktreeTrimKeep[] }
  | { ok: false; error: string };

/** The slice of `node:fs` the walk uses — synchronous on purpose (see the module doc). */
interface WalkFs {
  lstatSync(path: string): {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    size: number;
    dev: number;
  };
  readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  realpathSync: { native(path: string): string };
  rmSync(path: string, options: { recursive: true; force: true }): void;
}

/** The slice of `node:path` the walk uses. */
interface WalkPath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

// ---- pattern matching (the host thread uses keepReasonFor too) -------------

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
 * Why `relative` must be kept, or `null` when it may go. `.git/` is not part of
 * the user's allowlist: git's own metadata is what makes the branch, the
 * commits, and the worktree registration survive a trim, so no setting may
 * expose it. (`git ls-files` never reports it either — this is the belt to that
 * suspenders, because the recursive descent reads real directories.)
 */
export function keepReasonFor(relative: string, patterns: readonly string[]): string | null {
  const path = normalizeRelative(relative);
  if (path === ".git" || path.startsWith(".git/")) return "it is git's own metadata";
  const slash = path.lastIndexOf("/");
  const base = slash === -1 ? path : path.slice(slash + 1);
  for (const raw of patterns) {
    const pattern = normalizeRelative(raw.trim());
    if (pattern === "") continue;
    const target = pattern.includes("/") ? path : base;
    if (globToRegExp(pattern).test(target)) return `it matches ${pattern}`;
  }
  return null;
}

// ---- the walk (worker side) --------------------------------------------------

/** The report path for a node: relative, with a trailing `/` when it is a directory. */
function reportPath(relative: string, directory: boolean): string {
  return directory ? `${relative}/` : relative;
}

/**
 * Plans every candidate and, unless this is a dry run, removes what may go.
 * Runs on the worker thread; synchronous throughout.
 *
 * A directory whose whole subtree is removable comes back as a single removal —
 * one `rm` for the 100k-file `node_modules`, instead of 100k of them — and only
 * a subtree holding something preserved, cross-device, pointing out of the
 * worktree, or a nested git repository is split.
 *
 * Sizes are apparent bytes (`lstat`), summed as the plan is built because the
 * walk has to happen anyway, and it now happens off the host thread. For a pnpm
 * tree they overstate what the filesystem gets back — the files are hardlinks
 * into the store — and that is the honest number regardless: the cost being
 * reclaimed is files walked.
 */
function walkAndTrim(request: TrimWalkRequest, fs: WalkFs, path: WalkPath): TrimWalkAnswer {
  type NodePlan =
    | { kind: "remove"; bytes: number; directory: boolean }
    | { kind: "keep"; reason: string }
    | { kind: "split"; removed: WorktreeTrimRemoval[]; kept: WorktreeTrimKeep[] };

  const root = request.worktreePath;
  const patterns = request.patterns;
  let device: number;
  let canonicalRoot: string;
  try {
    device = fs.lstatSync(root).dev;
    canonicalRoot = fs.realpathSync.native(path.resolve(root));
  } catch (caught) {
    return {
      ok: false,
      error: `Volli couldn't read the worktree folder: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }

  /**
   * Whether a candidate stays inside the worktree by its NAME alone: a link is
   * a real case with its own reason (and its own handling), so this guard is
   * lexical and answers only the `../escape` question git output should never
   * contain.
   */
  const containsLexically = (candidate: string): boolean => {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  /** Whether a canonical `target` is the worktree itself or lives inside it. */
  const insideRoot = (target: string): boolean => {
    if (target === canonicalRoot) return true;
    const rel = path.relative(canonicalRoot, target);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  };

  /**
   * Whether a directory holds a `.git` entry of any type — a clone's directory,
   * a linked worktree's gitfile — which makes it a repository of its own. git
   * finds `.git` by opening that path, so on a case-insensitive disk (macOS's
   * default) a `.GIT` is one too; a name that differs only in case is confirmed
   * by asking the filesystem for `.git` itself. The exact name needs no second
   * read, so the common walk costs nothing extra.
   */
  const holdsGitEntry = (absolute: string, entries: readonly { name: string }[]): boolean => {
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.name.toLowerCase() !== ".git") continue;
      try {
        fs.lstatSync(path.join(absolute, ".git"));
        return true;
      } catch (caught) {
        // ENOENT is a case-sensitive disk, where `.GIT` is an ordinary name. Any
        // other failure is an unanswered question, and an unanswered question
        // about a repository keeps it.
        if ((caught as { code?: unknown }).code !== "ENOENT") return true;
      }
    }
    return false;
  };

  const planNode = (relative: string): NodePlan => {
    const absolute = path.join(root, relative);
    let info;
    try {
      info = fs.lstatSync(absolute);
    } catch {
      return { kind: "keep", reason: "Volli couldn't read it" };
    }

    const keep = keepReasonFor(relative, patterns);
    if (keep !== null) return { kind: "keep", reason: keep };

    if (info.isSymbolicLink()) {
      // The link itself is one inode and unlinking it never touches its target,
      // but a link OUT of the worktree is how a Bazel-style output tree or a
      // shared cache is reached, and Volli does not answer for what is over there.
      let target: string;
      try {
        target = fs.realpathSync.native(absolute);
      } catch {
        return { kind: "keep", reason: "it is a symlink Volli couldn't resolve" };
      }
      if (!insideRoot(target))
        return { kind: "keep", reason: "it is a symlink out of the worktree" };
      return { kind: "remove", bytes: info.size, directory: false };
    }

    if (!info.isDirectory()) return { kind: "remove", bytes: info.size, directory: false };
    // A directory on another device is a mount, not an artifact: an `rm -rf`
    // across one is not a trim. Untested on purpose rather than by omission —
    // pinning it would mean mounting a disk image inside the suite.
    if (info.dev !== device) return { kind: "keep", reason: "it sits on another filesystem" };

    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return { kind: "keep", reason: "Volli couldn't read it" };
    }
    if (holdsGitEntry(absolute, entries))
      return { kind: "keep", reason: "it is a nested git repository" };

    // Directory inodes are not counted: the number in the report is the bytes
    // of the FILES a removal takes.
    let bytes = 0;
    const removed: WorktreeTrimRemoval[] = [];
    const kept: WorktreeTrimKeep[] = [];
    let whole = true;
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`;
      const plan = planNode(childRelative);
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
  };

  const removed: WorktreeTrimRemoval[] = [];
  const kept: WorktreeTrimKeep[] = [];
  for (const candidate of request.candidates) {
    const relative = normalizeRelative(candidate);
    const isDirectoryCandidate = candidate.endsWith("/");
    if (relative === "" || relative === "." || !containsLexically(path.join(root, relative))) {
      kept.push({ path: candidate, reason: "it points out of the worktree" });
      continue;
    }
    const plan = planNode(relative);
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
  // reporting one path twice — so a removal a shallower one covers is dropped.
  const covers = (outer: string, inner: string): boolean => {
    const a = normalizeRelative(outer);
    const b = normalizeRelative(inner);
    return a === b || b.startsWith(`${a}/`);
  };
  const byDepth = removed.toSorted(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );
  const deduped: WorktreeTrimRemoval[] = [];
  for (const removal of byDepth) {
    if (deduped.some((accepted) => covers(accepted.path, removal.path))) continue;
    deduped.push(removal);
  }
  deduped.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));

  // One line per kept path; the first reason recorded for it wins.
  const seen = new Set<string>();
  const keptUnique: WorktreeTrimKeep[] = [];
  for (const keep of kept) {
    const normalized = normalizeRelative(keep.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    keptUnique.push(keep);
  }
  keptUnique.sort((a, b) => a.path.localeCompare(b.path));

  const confirmed: WorktreeTrimRemoval[] = [];
  for (const removal of deduped) {
    if (request.dryRun) {
      confirmed.push(removal);
      continue;
    }
    try {
      fs.rmSync(path.join(root, normalizeRelative(removal.path)), { recursive: true, force: true });
      confirmed.push(removal);
    } catch (caught) {
      keptUnique.push({
        path: removal.path,
        reason: `Volli couldn't remove it: ${caught instanceof Error ? caught.message : String(caught)}`,
      });
    }
  }
  return { ok: true, removed: confirmed, kept: keptUnique };
}

// ---- the worker --------------------------------------------------------------

/**
 * Every function the worker's source is built from. {@link walkAndTrim} is last
 * and is the one invoked; the others are declarations it (and each other) call
 * by name. A bundler that renames one renames its call sites too, and both
 * renames are what `toString()` returns, so the names agree on the far side.
 */
const WORKER_FUNCTIONS = [
  globToRegExp,
  normalizeRelative,
  keepReasonFor,
  reportPath,
  walkAndTrim,
] as const;

/** The worker's whole program: the functions above, then one call and one reply. */
function trimWalkWorkerSource(): string {
  const declarations = WORKER_FUNCTIONS.map((fn) => fn.toString()).join("\n");
  const entry = WORKER_FUNCTIONS[WORKER_FUNCTIONS.length - 1]!;
  return [
    `"use strict";`,
    `const { parentPort, workerData } = require("node:worker_threads");`,
    declarations,
    `let answer;`,
    `try {`,
    `  answer = ${entry.name}(workerData, require("node:fs"), require("node:path"));`,
    `} catch (caught) {`,
    `  answer = { ok: false, error: "Volli couldn't trim: " + (caught && caught.message ? caught.message : String(caught)) };`,
    `}`,
    `parentPort.postMessage(answer);`,
  ].join("\n");
}

/**
 * Walks and trims one worktree on a worker thread. Settles with the worker's
 * answer, or with a refusal when the worker could not start, threw outside the
 * walk, or exited without answering — a trim that cannot run off the host
 * thread does not run.
 */
export function runTrimWalk(request: TrimWalkRequest): Promise<TrimWalkAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: TrimWalkAnswer): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };
    let worker: Worker;
    try {
      worker = new Worker(trimWalkWorkerSource(), {
        eval: true,
        workerData: {
          ...request,
          candidates: [...request.candidates],
          patterns: [...request.patterns],
        },
      });
    } catch (caught) {
      settle({
        ok: false,
        error: `Volli couldn't start the trim: ${caught instanceof Error ? caught.message : String(caught)}`,
      });
      return;
    }
    worker.once("message", (answer: TrimWalkAnswer) => settle(answer));
    worker.once("error", (caught: unknown) =>
      settle({
        ok: false,
        error: `Volli couldn't trim: ${caught instanceof Error ? caught.message : String(caught)}`,
      }),
    );
    worker.once("exit", (code) =>
      settle({ ok: false, error: `The trim stopped before it answered (exit ${code}).` }),
    );
  });
}
