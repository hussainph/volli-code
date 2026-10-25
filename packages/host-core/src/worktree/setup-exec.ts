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
 *
 * With environment recipes on (the `cloud` flag, VC-584) the same run serves
 * the working copy's recipe (`recipe.ts`): `.agents/setup` when the working
 * copy has one, otherwise the stored command, run as before. Each run is
 * recorded as a fact of the working copy (`environment-runs.ts`), and a setup
 * that did not succeed is a GATE: every later structured start of that
 * working copy is refused with the same reason until a person answers it —
 * Retry (`retryWorktreeSetup`), or Start anyway
 * (`startWorktreeSetupAnyway`). A repository script's leftover processes are
 * stopped when it exits: setup prepares, it does not start services.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  clearEnvironmentRun,
  isBlockingSetupRun,
  readEnvironmentRun,
  setupReasonAfter,
  recordEnvironmentRun,
  type EnvironmentRunFact,
  type EnvironmentRunOutcome,
  type EnvironmentRunStart,
} from "./environment-runs";
import { claimFirstRunSetup } from "./first-run";
import { canonicalize } from "./paths";
import { setPhase } from "./phase";
import {
  localRunnerKind,
  recipeEnvironment,
  recipeInvocation,
  resolveRecipe,
  type ResolvedRecipe,
  type RunnerKind,
  type SetupReason,
} from "./recipe";
import { recordSetupFailure, SETUP_TAIL_MAX_CHARS } from "./setup-run";
import type { WorktreePorts } from "./types";
import { hostLogger } from "../log/root";

const log = hostLogger("worktree-setup");

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
  /**
   * Present when environment recipes are on (VC-584): what the recipe's
   * variables name. Absent, the run is exactly the VC-835 setup command.
   */
  recipe?: WorktreeRecipeContext;
  /** Overrides {@link SETUP_DEADLINE_MS}; tests only. */
  deadlineMs?: number;
  /** Clock for run facts; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Store-specific failure reporting, including the `failed` phase. Omitted,
   * the local runner records its existing SQLite ticket event. Cloud supplies
   * a machine-only reporter; environment run facts and the setup gate are
   * recorded independently, whichever reporter is used.
   */
  reportFailure?: (ticketId: string, stderr: string) => void;
}

/** What a recipe run tells its script, beyond the working copy itself. */
export interface WorktreeRecipeContext {
  projectId: string;
  /** The ticket's display id (`VC-12`). */
  ticketDisplayId: string;
  /** Defaults to this machine's kind. */
  runnerKind?: RunnerKind;
}

/**
 * `skipped`: nothing was owed, another door claimed it, or no command is
 * configured (the claim consumed it). `succeeded`: the command exited 0.
 * `failed`: it exited non-zero, died on a signal, ran out of time or never
 * started — already reported through the failure reporter (on the ticket by
 * default); `message` is the one-line reason.
 * With recipes on, `failed` is also the answer for a working copy whose
 * earlier setup failed and is still unanswered; `run` is that fact.
 */
export type WorktreeSetupExecOutcome =
  | { kind: "skipped" }
  | { kind: "succeeded" }
  | { kind: "failed"; message: string; run?: EnvironmentRunFact };

/**
 * Runs in flight, by canonical worktree path. A second structured start for the
 * same new worktree waits on the first one's run rather than starting its
 * agent in a checkout that is still being set up.
 */
const inflight = new Map<string, Promise<WorktreeSetupExecOutcome>>();

/** Whether a setup run is in flight for the working copy right now. */
export function isWorktreeSetupRunning(worktreePath: string): boolean {
  return inflight.has(canonicalize(worktreePath));
}

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
    return Promise.resolve(
      fail(deps, params, null, `could not be claimed (${errorText(error)})`, ""),
    );
  }
  if (!claimed) {
    return Promise.resolve(
      params.recipe === undefined ? { kind: "skipped" } : gateOutcome(deps, params),
    );
  }
  let recipe: ResolvedRecipe | null;
  if (params.recipe === undefined) {
    const command = params.setupCommand?.trim() ?? "";
    recipe =
      command.length === 0 ? null : { source: "legacyCommand", script: "setup", command, sha: "" };
  } else {
    try {
      recipe = resolveRecipe(params.worktreePath, "setup", params.setupCommand);
    } catch (error) {
      // The claim is spent, so this failure is a fact like any other: the
      // next start is refused with it rather than starting unset-up.
      const start = runStart(deps, params, params.recipe, { source: "repo", sha: "" });
      return Promise.resolve(
        fail(deps, params, start, `could not be read (${errorText(error)})`, "", {
          source: "repo",
        }),
      );
    }
    if (recipe === null) {
      // Nothing to run any more: whatever an earlier run recorded no longer
      // describes this working copy.
      try {
        clearEnvironmentRun(deps, params.worktreePath, "setup");
      } catch (error) {
        log.error("failed to clear the setup run record", { ticketId: params.ticketId, error });
      }
    }
  }
  if (recipe === null) return Promise.resolve({ kind: "skipped" });
  const run = execSetup(deps, params, recipe).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/**
 * The answer for a start that did not claim a run: the working copy's last
 * setup, when it failed and nobody answered it, still blocks — the start is
 * refused with that run's reason and nothing is recorded again.
 */
function gateOutcome(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
): WorktreeSetupExecOutcome {
  let last: EnvironmentRunFact | null;
  try {
    last = readEnvironmentRun(deps, params.worktreePath, "setup");
  } catch (error) {
    return {
      kind: "failed",
      message: `The environment setup record could not be read (${errorText(error)}).`,
    };
  }
  if (last === null || !isBlockingSetupRun(last)) return { kind: "skipped" };
  return { kind: "failed", message: blockedMessage(last), run: last };
}

/** The one-line reason a start refused by a failed setup gives. */
function blockedMessage(run: EnvironmentRunFact): string {
  const summary = /[.!?]$/.test(run.summary) ? run.summary : `${run.summary}.`;
  return `Environment setup failed: ${summary} Retry setup, or start anyway.`;
}

/** What a finished child process did. */
type ExecResult =
  | { kind: "exited"; code: number }
  | { kind: "signalled"; signal: NodeJS.Signals | null }
  | { kind: "timed-out"; deadlineMs: number }
  | { kind: "not-started"; reason: string };

async function execSetup(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  recipe: ResolvedRecipe,
): Promise<WorktreeSetupExecOutcome> {
  setPhase(params.ticketId, "setting-up", deps.onPhase);
  const start = params.recipe === undefined ? null : runStart(deps, params, params.recipe, recipe);
  let environment: { shellPath: string; env: Record<string, string> };
  try {
    environment = await params.environment();
  } catch (error) {
    return fail(deps, params, start, `could not start (${errorText(error)})`, "", recipe);
  }
  if (!existsSync(params.worktreePath)) {
    return fail(
      deps,
      params,
      start,
      "could not start: the worktree directory is missing",
      "",
      recipe,
    );
  }
  const env =
    params.recipe === undefined
      ? environment.env
      : {
          ...environment.env,
          ...recipeEnvironment({
            runnerKind: start!.runnerKind,
            projectId: params.recipe.projectId,
            ticket: params.recipe.ticketDisplayId,
            workingCopy: params.worktreePath,
            reason: { script: "setup", why: start!.reason },
          }),
        };
  const { result, tail } = await spawnSetup(
    recipeInvocation(recipe, environment.shellPath),
    params.worktreePath,
    env,
    params.deadlineMs ?? SETUP_DEADLINE_MS,
    // A repository script prepares the working copy; anything it left running
    // is stopped with it. The stored command keeps its old behaviour.
    recipe.source === "repo",
  );
  if (result.kind === "exited" && result.code === 0) {
    if (start !== null) {
      recordFact(deps, params, start, {
        outcome: "succeeded",
        exitCode: 0,
        summary: `${subject(recipe)} succeeded.`,
        tail,
      });
    }
    setPhase(params.ticketId, "ready", deps.onPhase);
    return { kind: "succeeded" };
  }
  return fail(deps, params, start, describe(result), tail, recipe, result);
}

/** A setup run's opening facts. */
type SetupRunStart = EnvironmentRunStart & { script: "setup"; reason: SetupReason };

function runStart(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  context: WorktreeRecipeContext,
  recipe: Pick<ResolvedRecipe, "source" | "sha">,
): SetupRunStart {
  return {
    script: "setup",
    source: recipe.source,
    scriptSha: recipe.sha,
    reason: setupReasonAfter(deps, params.worktreePath),
    runnerKind: context.runnerKind ?? localRunnerKind(),
    ticketId: params.ticketId,
    startedAt: (params.now ?? Date.now)(),
  };
}

function describe(result: ExecResult): string {
  switch (result.kind) {
    case "exited":
      return `exited with code ${result.code}`;
    case "signalled":
      return `was stopped by ${result.signal ?? "a signal"}`;
    case "timed-out":
      return `did not finish within ${formatDuration(result.deadlineMs)} and was stopped`;
    case "not-started":
      return result.reason;
  }
}

/** What a reason's sentence is about. */
function subject(recipe: Pick<ResolvedRecipe, "source"> | undefined): string {
  return recipe?.source === "repo" ? ".agents/setup" : "The project's setup command";
}

function spawnSetup(
  invocation: { file: string; args: string[] },
  cwd: string,
  env: Record<string, string>,
  deadlineMs: number,
  stopLeftovers: boolean,
): Promise<{ result: ExecResult; tail: string }> {
  return new Promise((resolve) => {
    let tail = "";
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // No stdin: nobody can answer a prompt here, so one reads end-of-file and
    // fails instead of hanging the start. Its own process group, so a stop
    // reaches everything the command started.
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pgid = child.pid;
    if (pgid !== undefined) {
      liveGroups.add(pgid);
      stopLiveGroupsOnExit();
    }
    const settle = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (pgid !== undefined) {
        liveGroups.delete(pgid);
        if (stopLeftovers && result.kind !== "timed-out") killGroup(pgid, "SIGKILL");
      }
      // A background process the command left behind may hold the pipes open;
      // the run is over, so stop reading them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ result, tail });
    };
    for (const stream of [child.stdout, child.stderr]) {
      // Decoded per stream, so a character split across chunks survives.
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-SETUP_TAIL_MAX_CHARS);
      });
    }
    child.once("error", (error) =>
      settle({ kind: "not-started", reason: `could not start (${error.message})` }),
    );
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code !== null) settle({ kind: "exited", code });
      else settle({ kind: "signalled", signal });
    };
    // The shell's exit decides the outcome. Its last output can still be in
    // the pipes, so `close` settles it as soon as they drain — or, when
    // something the command left running keeps them open, a moment later.
    child.once("exit", (code, signal) => {
      child.once("close", () => finish(code, signal));
      setTimeout(() => finish(code, signal), DRAIN_GRACE_MS).unref?.();
    });
    deadline = setTimeout(() => {
      if (pgid === undefined) return;
      killGroup(pgid, "SIGTERM");
      // Whatever ignored the polite signal does not get to keep running.
      setTimeout(() => killGroup(pgid, "SIGKILL"), KILL_GRACE_MS).unref?.();
      settle({ kind: "timed-out", deadlineMs });
    }, deadlineMs);
  });
}

function recordFact(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  start: EnvironmentRunStart,
  end: { outcome: EnvironmentRunOutcome; exitCode: number | null; summary: string; tail: string },
): EnvironmentRunFact | null {
  try {
    return recordEnvironmentRun(deps, params.worktreePath, start, {
      endedAt: (params.now ?? Date.now)(),
      ...end,
    });
  } catch (error) {
    // The outcome is still reported where the run happened; only the record
    // the gate reads is missing, so a later start is not blocked by it.
    log.error("failed to record the setup run", { ticketId: params.ticketId, error });
    return null;
  }
}

/** Reports the failure and phrases the start's one-line reason. */
function fail(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  start: EnvironmentRunStart | null,
  reason: string,
  tail: string,
  recipe?: Pick<ResolvedRecipe, "source">,
  result?: ExecResult,
): WorktreeSetupExecOutcome {
  const what = subject(recipe);
  const stderr = `${tail}\n[${recipe?.source === "repo" ? ".agents/setup" : "setup command"} ${reason}]`;
  if (params.reportFailure === undefined) recordSetupFailure(deps, params.ticketId, stderr);
  else params.reportFailure(params.ticketId, stderr);
  const lastLine = lastOutputLine(tail);
  const message = `${what} ${reason}${lastLine === null ? "." : `: ${lastLine}`}`;
  if (start === null) return { kind: "failed", message };
  const run = recordFact(deps, params, start, {
    outcome: result?.kind === "timed-out" ? "timed_out" : "failed",
    exitCode: result?.kind === "exited" ? result.code : null,
    summary: message,
    tail,
  });
  return run === null ? { kind: "failed", message } : { kind: "failed", message, run };
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
