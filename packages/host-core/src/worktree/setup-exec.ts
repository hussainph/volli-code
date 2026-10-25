/**
 * The setup command for a door with no terminal (VC-835): a structured Session
 * runs the project's setup command (Configure → Worktrees → Then run) as a
 * plain child process in the new worktree, before its first turn.
 *
 * The terminal keeps its own runner (`setup-run.ts`): it types the command into
 * the shell the person is watching, where a prompt can be answered. Neither
 * runner decides WHETHER setup runs. That is the worktree's durable first-run
 * record (`first-run.ts`), and a runner starts only after it has claimed the
 * pending run, so one worktree runs its setup once whichever door asked first.
 *
 * The run moves the ticket's worktree phase to `setting-up`, then `ready`, or
 * `failed` with the same `worktree_failed` (setup) ticket event the terminal
 * records, carrying the output's tail and the exit code. The caller fails the
 * start with the one-line reason and does not run the command again: setup is
 * at-most-once.
 *
 * Bounded: a start waits on it under a ceiling of its own, so a command that
 * never finishes is stopped — its whole process group — and reported as such
 * before that ceiling fails the start with no reason. The run is over when the
 * shell exits, not when every pipe closes, so a background process the command
 * left behind cannot hold the start open.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { claimFirstRunSetup } from "./first-run";
import { canonicalize } from "./paths";
import { setPhase } from "./phase";
import { recordSetupFailure, SETUP_TAIL_MAX_CHARS } from "./setup-run";
import type { WorktreePorts } from "./types";

/**
 * How long a structured start lets its setup command run: under the Session
 * runtime's ten-minute first-attach ceiling, so the start fails with this
 * reason rather than the ceiling's.
 */
const SETUP_DEADLINE_MS = 9 * 60_000;

/** How long output may keep draining after the shell exited. */
const DRAIN_GRACE_MS = 250;

/** How long a stopped setup's process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** One structured start's setup request. */
export interface WorktreeSetupExecParams {
  ticketId: string;
  worktreePath: string;
  /** The project's setup command as configured now; empty or `null` consumes the pending run. */
  setupCommand: string | null;
  /**
   * The shell (`<shellPath> -c <command>`) and the child's whole environment.
   * Asked only once this call has claimed the run.
   */
  environment: () => Promise<{ shellPath: string; env: Record<string, string> }>;
  /** Overrides {@link SETUP_DEADLINE_MS}; tests only. */
  deadlineMs?: number;
}

/**
 * `skipped`: nothing was owed, another door claimed it, or no command is
 * configured (the claim consumed it). `succeeded`: the command exited 0.
 * `failed`: it exited non-zero, died on a signal, ran out of time or never
 * started — already recorded on the ticket; `message` is the one-line reason.
 */
export type WorktreeSetupExecOutcome =
  | { kind: "skipped" }
  | { kind: "succeeded" }
  | { kind: "failed"; message: string };

/**
 * Runs in flight, by canonical worktree path. A second structured start for the
 * same new worktree waits on the first one's run rather than starting its
 * agent in a checkout that is still being set up.
 */
const inflight = new Map<string, Promise<WorktreeSetupExecOutcome>>();

/** Process groups of the setup commands running now, stopped if the host exits first. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function stopLiveGroupsOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
  });
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Claims the worktree's pending setup run and, if this call won it, runs the
 * command to completion; joins a run already in flight for the same worktree.
 * Resolves; never rejects — every failure is an outcome the caller reports.
 */
export function runPendingWorktreeSetup(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
): Promise<WorktreeSetupExecOutcome> {
  const key = canonicalize(params.worktreePath);
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  let claimed: boolean;
  try {
    claimed = claimFirstRunSetup(deps, params.worktreePath);
  } catch (error) {
    // Still owed: nothing ran. Say why this start could not take it.
    return Promise.resolve(fail(deps, params, `could not be claimed (${errorText(error)})`, ""));
  }
  if (!claimed) return Promise.resolve({ kind: "skipped" });
  const command = params.setupCommand?.trim() ?? "";
  if (command.length === 0) return Promise.resolve({ kind: "skipped" });
  const run = execSetup(deps, params, command).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

async function execSetup(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  command: string,
): Promise<WorktreeSetupExecOutcome> {
  setPhase(params.ticketId, "setting-up", deps.onPhase);
  let environment: { shellPath: string; env: Record<string, string> };
  try {
    environment = await params.environment();
  } catch (error) {
    return fail(deps, params, `could not start (${errorText(error)})`, "");
  }
  if (!existsSync(params.worktreePath)) {
    return fail(deps, params, "could not start: the worktree directory is missing", "");
  }
  return new Promise((resolve) => {
    let tail = "";
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // No stdin: nobody can answer a prompt here, so one reads end-of-file and
    // fails instead of hanging the start. Its own process group, so a stop
    // reaches everything the command started.
    const child = spawn(environment.shellPath, ["-c", command], {
      cwd: params.worktreePath,
      env: environment.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pgid = child.pid;
    if (pgid !== undefined) {
      liveGroups.add(pgid);
      stopLiveGroupsOnExit();
    }
    const settle = (outcome: WorktreeSetupExecOutcome | { reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (pgid !== undefined) liveGroups.delete(pgid);
      // A background process the command left behind may hold the pipes open;
      // the run is over, so stop reading them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve("reason" in outcome ? fail(deps, params, outcome.reason, tail) : outcome);
    };
    for (const stream of [child.stdout, child.stderr]) {
      // Decoded per stream, so a character split across chunks survives.
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-SETUP_TAIL_MAX_CHARS);
      });
    }
    child.once("error", (error) => settle({ reason: `could not start (${error.message})` }));
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      if (code === 0) {
        setPhase(params.ticketId, "ready", deps.onPhase);
        settle({ kind: "succeeded" });
      } else if (code !== null) settle({ reason: `exited with code ${code}` });
      else settle({ reason: `was stopped by ${signal ?? "a signal"}` });
    };
    // The shell's exit decides the outcome. Its last output can still be in
    // the pipes, so `close` settles it as soon as they drain — or, when
    // something the command left running keeps them open, a moment later.
    child.once("exit", (code, signal) => {
      child.once("close", () => finish(code, signal));
      setTimeout(() => finish(code, signal), DRAIN_GRACE_MS).unref?.();
    });
    const deadlineMs = params.deadlineMs ?? SETUP_DEADLINE_MS;
    deadline = setTimeout(() => {
      if (pgid === undefined) return;
      killGroup(pgid, "SIGTERM");
      // Whatever ignored the polite signal does not get to keep running.
      setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS).unref?.();
      settle({ reason: `did not finish within ${formatDuration(deadlineMs)} and was stopped` });
    }, deadlineMs);
  });
}

/** Records the failure on the ticket and phrases the start's one-line reason. */
function fail(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  reason: string,
  tail: string,
): WorktreeSetupExecOutcome {
  recordSetupFailure(deps, params.ticketId, `${tail}\n[setup command ${reason}]`);
  const lastLine = lastOutputLine(tail);
  return {
    kind: "failed",
    message: `The project's setup command ${reason}${lastLine === null ? "." : `: ${lastLine}`}`,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** The last non-blank line of the output, trimmed and bounded, for a one-line reason. */
function lastOutputLine(tail: string): string | null {
  const lines = tail
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) return null;
  return last.length > 200 ? `${last.slice(0, 199)}…` : last;
}
