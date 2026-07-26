/**
 * Git execution for the worktree module. Same args-as-arrays / no-shell
 * discipline as `project-base-branch.ts`'s `RunGit`, but the default runner
 * here CAPTURES stderr and rethrows it inside a {@link GitError} — worktree
 * failures surface the real git message in a `worktree_failed` event, which
 * the shared runner (stderr → `ignore`) throws away. Raw git CLI only, never
 * libgit2/native bindings (#40). The runner stays injectable so every pipeline
 * step is unit-testable with a scripted fake.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import type { RunGit } from "../project-base-branch";
import type { RunGitAsync } from "./types";

const execFileAsync = promisify(execFile);

/**
 * stdout ceiling for the async runner. Node's 1 MB default is far too small for
 * the reads that go through it: a `--name-status -z` listing of a few thousand
 * paths, or a `git show` of one large file, both blow past it — and execFile
 * signals that as a KILLED process, which would surface as a mysterious empty
 * failure rather than "your diff is big". 64 MB is generous enough that hitting
 * it means something genuinely pathological.
 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** A git invocation that exited non-zero, carrying its captured `stderr`. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly args: readonly string[],
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Default worktree git runner: pipes BOTH stdout and stderr, and on non-zero
 * exit throws a {@link GitError} carrying the captured stderr so callers can
 * record it. `execFileSync` populates `err.stderr` when stderr is piped.
 */
export const runGitCapturing: RunGit = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (caught) {
    const e = caught as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new GitError(e.message ?? "git command failed", stderr, args);
  }
};

/**
 * The async twin of {@link runGitCapturing}, for reads that must not block the
 * main process. `changeSetSnapshot` runs five git commands over a whole
 * worktree and is re-triggered by every debounced filesystem event, so running
 * it synchronously froze the UI for the duration on a busy agent worktree —
 * the same reasoning that put the network verbs behind `RunNet` (net.ts).
 * Failures carry the captured stderr in a {@link GitError}, exactly as the
 * sync runner does, so callers classify them identically.
 */
export const runGitCapturingAsync: RunGitAsync = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (caught) {
    const e = caught as { stderr?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new GitError(e.message ?? "git command failed", stderr, args);
  }
};

/** Pulls a captured stderr excerpt off any thrown error, for `worktree_failed` events. */
export function stderrOf(error: unknown): string {
  if (error instanceof GitError && error.stderr.trim().length > 0) return error.stderr;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  /** Absolute path git reports (NOT yet canonicalized — callers canonicalize). */
  path: string;
  /** The checked-out branch short name, or `null` when detached. */
  branch: string | null;
  /** `git worktree lock` state — respected absolutely by dirty detection (§7). */
  locked: boolean;
  /** The main working tree (the first, non-linked entry). */
  bare: boolean;
}

/**
 * Parses `git worktree list --porcelain` into entries. Blocks are separated by
 * blank lines; within a block, `worktree <path>` opens it, `branch
 * refs/heads/<name>` names the checkout (absent/`detached` → `null`), and a
 * bare `locked`/`locked <reason>` line marks a lock.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null, locked: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
