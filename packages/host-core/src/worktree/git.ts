/**
 * Git execution for the worktree module. Same args-as-arrays / no-shell
 * discipline as `project-base-branch.ts`'s `RunGit`, but the default runner
 * here CAPTURES stderr and rethrows it inside a {@link GitError} — worktree
 * failures surface the real git message in a `worktree_failed` event, which
 * the shared runner (stderr → `ignore`) throws away. Raw git CLI only, never
 * libgit2/native bindings (#40). The runner stays injectable so every pipeline
 * step is unit-testable with a scripted fake.
 *
 * ## What the concurrency bound covers, and what it does not
 *
 * {@link GIT_MAX_CONCURRENT_CHILDREN} is a PROCESS-LOCAL bound on the ASYNC
 * git children this module admits. It is neither host-wide nor "every git
 * child this process starts", and both of those are worth writing down rather
 * than implying (VC-389). It covers:
 *
 *  - every caller of {@link runGitCapturingAsync} and of any runner built by
 *    {@link createGitCapturingAsyncRunner} — which is every worktree read and
 *    every local mutation in this module;
 *  - `change-set-watch.ts`'s `check-ignore --stdin -z`, which keeps its own
 *    `execFile` (it writes to the child's stdin and reads exit 1 as a
 *    successful classification) and takes a slot through
 *    {@link withGitChildSlot};
 *  - `volli-fs.ts`'s `gitListFiles` (`ls-files` for the file index), and
 *    `credential-helper-diagnostics.ts`'s `config --get-all
 *    credential.helper`, both of which now go through the async runner. The
 *    first of those had no deadline at all before, and keeps its OWN longer
 *    one through {@link createGitCapturingAsyncRunner}: it walks the whole
 *    working tree, so 8 s would be a kill rather than a diagnosis. It still
 *    takes a slot, which is what this bound is about.
 *
 * It does NOT cover:
 *
 *  - `net.ts`'s runner. Deliberately a separate pool, and it carries more than
 *    the network: `fetch`, `push` and the `gh` verbs, AND `commit.ts`'s local
 *    `git add -A` and `git commit`, which ride the same seam because the Done
 *    flow drives them together. All of them are bounded at 120 s, and one push
 *    holding a slot here would starve every 8 s local read queued behind it.
 *  - {@link runGitCapturing} and its callers — `harness-workspace.ts` most
 *    concretely, whose per-file `ls-files` and `rev-parse --git-common-dir`
 *    run on a Session start. So a Session start can hold one synchronous child
 *    BESIDE this bound's five, and the honest ceiling is five admitted async
 *    children plus whatever the synchronous runner is doing. That runner
 *    bounds itself by blocking the main thread — which is the whole reason the
 *    async runner exists, and why the ordering of worktree CHANGES is a
 *    separate concern handled in `repository-turn.ts` rather than here.
 *  - git children this process did not start: the user's own terminal, a
 *    second Volli install, and the agents Volli runs. Nothing in one process
 *    can bound those, and this bound does not pretend to.
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
 *
 * It is a deadline for one CHILD, not for one CALL. Since VC-389 a caller may
 * also wait for a slot (see {@link GIT_MAX_CONCURRENT_CHILDREN}), and that
 * wait is not counted here — the clock starts when the child spawns.
 */
export const GIT_COMMAND_TIMEOUT_MS = 8_000;

/**
 * How many git children this module may have in flight at once — the async
 * ones it admits, not every git child in the process. The module comment above
 * names what sits outside it, and `harness-workspace.ts`'s synchronous reads
 * are the one that runs on the same Session start.
 *
 * The bound exists because the old synchronous runner was quietly doing a
 * second job. Because it blocked the main thread, only one git command could
 * run at a time — nothing else could even start one. Moving the pipelines onto
 * the async runner (VC-383) was the right fix for the freeze, and it removed
 * that accidental ceiling with nothing in its place. Each workflow is still
 * serial on its own, so no single operation fans out; what fans out is a dozen
 * of them overlapping. One Session start alone holds a git child for
 * `worktree list`, `rev-parse`, `worktree add` (sometimes behind a `prune`),
 * and one `ls-files` per harness workspace file, and a launch-time orphan scan
 * and a retention reclaim can be running beside them.
 *
 * Five is argued from VS Code, which hit this exactly: its git extension wraps
 * the launch-time `repository.status()` fan-out in `new Limiter<void>(5)` "to
 * avoid starving the ext host" — the same shape as here, a single-threaded host
 * with many repositories opening at once and roughly eight git children each.
 * No operation in this module gets slower for it, because every one of them is
 * already serial; the bound only queues work ACROSS concurrent operations. What
 * it buys is that a dozen simultaneous Session starts hold five git children
 * rather than a dozen, on a laptop whose cores are already shared with the
 * agents those Sessions run.
 *
 * What it does NOT bound is the wait: {@link GIT_COMMAND_TIMEOUT_MS} is the
 * deadline for one CHILD, so a queued caller's worst case is roughly that
 * deadline times the queue ahead of it over the slot count. That is acceptable
 * here because everything in this pool is a bounded local read — and it is
 * precisely why `net.ts`'s 120 s network verbs are deliberately a separate
 * pool: one push holding a slot would starve every 8 s local read behind it.
 */
export const GIT_MAX_CONCURRENT_CHILDREN = 5;

/** Children currently admitted — running, or between hand-off and resumption. */
let gitChildrenInFlight = 0;
/** Callers waiting for a slot, in the order they asked. */
let gitSlotWaiters: Array<() => void> = [];

/**
 * Test seam: empties the gate, so one test's leaked slot cannot wedge the next.
 *
 * Module state that only ever drains on a settled child is exactly the state a
 * failed assertion strands: a test that throws before opening its gates leaves
 * the count at the ceiling forever, and the next test in the file HANGS on a
 * slot rather than failing with its own message. Every sibling holding module
 * state ships the same seam (`resetDeletionLeasesForTest`,
 * `resetPhasesForTest`), and this one existing is what makes a red suite
 * readable.
 *
 * Waiters are resumed rather than dropped, so a caller parked on the old gate
 * finishes instead of hanging on a promise nothing will ever settle.
 */
export function resetGitChildSlotsForTest(): void {
  const stranded = gitSlotWaiters;
  gitSlotWaiters = [];
  gitChildrenInFlight = 0;
  for (const admit of stranded) admit();
}

/**
 * Gives up this caller's slot when its child settles.
 *
 * The slot is HANDED to the next waiter rather than released and re-taken: the
 * count stays as it is and the waiter inherits it. Decrementing first and then
 * resuming the waiter would leave the slot free for the length of a microtask,
 * which is long enough for a caller arriving in between to take it — and the
 * bound is then one over for as long as both run. Conversely, a hand-off that
 * ALSO counts a new slot leaks capacity on every hand-off, and the gate shrinks
 * until nothing in this process can run git at all.
 */
function releaseGitChildSlot(): void {
  const next = gitSlotWaiters.shift();
  if (next === undefined) {
    gitChildrenInFlight -= 1;
    return;
  }
  next();
}

/**
 * Runs one git child under the shared bound, FIFO, waiting rather than failing.
 *
 * Exported because one caller cannot use the runner below and must still take a
 * slot: `change-set-watch.ts` needs a child it can write NUL-delimited paths to
 * on stdin, and reads exit 1 as a successful classification rather than a
 * failure. Anything that spawns git in the main process outside these two doors
 * is outside the bound — see the module comment.
 */
export async function withGitChildSlot<T>(launch: () => Promise<T>): Promise<T> {
  if (gitChildrenInFlight >= GIT_MAX_CONCURRENT_CHILDREN) {
    await new Promise<void>((admit) => gitSlotWaiters.push(admit));
  } else {
    gitChildrenInFlight += 1;
  }
  try {
    return await launch();
  } finally {
    // Either way: a child that failed or timed out has stopped occupying the
    // machine, and a slot held by a rejected launch strands every caller behind
    // it for the life of the process.
    releaseGitChildSlot();
  }
}

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
 * Default synchronous worktree git runner. Since VC-383 it has ONE deliberate
 * consumer on a user path: the confirmed orphan cleanup's gate (`cleanup.ts`),
 * which may not yield between its last look and the delete. Everything else a
 * person or a timer reaches — the scan, remove, trim, commit, the harness
 * workspace, every rail read — runs on {@link runGitCapturingAsync}, because a
 * sync child on Electron main is the beachball. Reaching for this one for a new
 * read is the wrong default; every child still has the same deadline as the
 * async runner, so a malformed local hook cannot freeze Electron indefinitely.
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
  return (args, cwd) =>
    withGitChildSlot(async () => {
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
    });
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
  /**
   * Git's own reason this ADMIN RECORD is stale (`prunable <reason>`), or
   * `null`. It is what `git worktree prune` acts on, and reading it here is
   * what lets the scan name a pending metadata change without running prune at
   * all — `prune --dry-run` reports on stderr, which this runner only captures
   * on failure, so the listing is the only read-only source for it.
   */
  prunable: string | null;
}

/**
 * Parses `git worktree list --porcelain` into entries. Blocks are separated by
 * blank lines; within a block, `worktree <path>` opens it, `branch
 * refs/heads/<name>` names the checkout (absent/`detached` → `null`), a bare
 * `locked`/`locked <reason>` line marks a lock, and `prunable <reason>` marks a
 * record whose directory git can no longer find.
 */
export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        locked: false,
        bare: false,
        prunable: null,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = line.slice("prunable".length).trim() || "stale worktree record";
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}
