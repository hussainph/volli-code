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

/**
 * The hard deadline for one local git child. Git still runs hooks, signing
 * helpers, and filters for local commands; each can wait forever unless the
 * process that launched it owns a deadline. Accepted socket requests disable
 * their transport timeout, so this runner is the local bound that lets sync
 * answer instead of leaving the client to infer a wedged child.
 */
export const GIT_COMMAND_TIMEOUT_MS = 8_000;

/** A git invocation that exited non-zero, carrying its captured `stderr`. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly args: readonly string[],
    /** Whether this runner's deadline, rather than git, ended the child. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** The error shape Node gives both sync and async execFile calls. */
interface CapturedGitFailure {
  stderr?: Buffer | string;
  message?: string;
  killed?: unknown;
  code?: unknown;
}

/** Turns a child-process failure into the one git error every caller understands. */
function gitFailure(caught: unknown, args: readonly string[], timeoutMs: number): GitError {
  const failure = caught as CapturedGitFailure;
  const stderr = failure.stderr ? failure.stderr.toString() : "";
  // Async execFile marks its own timeout with `killed`; execFileSync uses
  // ETIMEDOUT. Treat both as the same bounded-runner outcome.
  const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
  const message = timedOut
    ? `Git command timed out after ${timeoutMs}ms.`
    : (failure.message ?? "git command failed");
  return new GitError(message, stderr, args, timedOut);
}

/**
 * Default synchronous worktree git runner. It remains for small legacy reads,
 * but every child has the same deadline as the async runner: a malformed local
 * hook must never freeze Electron indefinitely.
 */
export const runGitCapturing: RunGit = (args, cwd) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_COMMAND_TIMEOUT_MS,
      // A hook may ignore SIGTERM. SIGKILL makes the deadline mechanical for
      // the direct git child rather than a polite request it can decline.
      killSignal: "SIGKILL",
    });
  } catch (caught) {
    throw gitFailure(caught, args, GIT_COMMAND_TIMEOUT_MS);
  }
};

/** Configuration for a bounded async git runner; the override is test-only useful. */
export interface GitCapturingAsyncRunnerOptions {
  /** Executable to run; production uses git and tests can supply a hung child. */
  readonly file?: string;
  /** Positive deadline for one child process. */
  readonly timeoutMs?: number;
}

/**
 * Builds the async git runner that operations with arbitrary local hooks use.
 *
 * `worktree.sync` deliberately goes through this runner rather than
 * `execFileSync`: while a hook waits, Electron main remains free to process
 * other work, and the deadline kills the child so the command eventually
 * answers. The factory lets the suite prove that behavior against a real hung
 * spawn at a short deadline without weakening production's bound.
 */
export function createGitCapturingAsyncRunner(
  options: GitCapturingAsyncRunnerOptions = {},
): RunGitAsync {
  const file = options.file ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Git command timeout must be a positive finite number.");
  }
  return async (args, cwd) => {
    try {
      const { stdout } = await execFileAsync(file, [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: timeoutMs,
        // See the synchronous runner: a deadline that only sends a signal a
        // hook can ignore is not a deadline.
        killSignal: "SIGKILL",
      });
      return stdout;
    } catch (caught) {
      throw gitFailure(caught, args, timeoutMs);
    }
  };
}

/**
 * The async twin of {@link runGitCapturing}, for reads and local mutations
 * that must not block the main process. Failures carry captured stderr in a
 * {@link GitError}, exactly as the sync runner does.
 */
export const runGitCapturingAsync: RunGitAsync = createGitCapturingAsyncRunner();

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
