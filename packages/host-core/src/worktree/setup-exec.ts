/**
 * The setup command for a door with no terminal (VC-835): a structured Session
 * runs the project's setup command (Configure → Worktrees → Then run) as a
 * plain child process in the new worktree, before its first turn.
 *
 * The terminal keeps its own runner (`setup-run.ts`): it types the command into
 * the shell the person is watching, where a prompt can be answered. Neither
 * runner decides WHETHER setup runs. That is the worktree's durable first-run
 * record (`first-run.ts`), and a runner starts only after it has claimed the
 * pending run, so one worktree runs its setup once whichever door — or how many
 * at once — asked first.
 *
 * What a person sees is the same as the terminal's, minus the scrollback: the
 * phase goes `setting-up` while the command runs, then `ready`, or `failed`
 * with the same `worktree_failed` (setup) ticket event carrying the output's
 * tail and the exit code. The caller reports a failure on the start itself and
 * does not run the command again: setup is at-most-once.
 */
import { spawn } from "node:child_process";

import { claimFirstRunSetup } from "./first-run";
import { canonicalize } from "./paths";
import { setPhase } from "./phase";
import { recordSetupFailure, SETUP_TAIL_MAX_CHARS } from "./setup-run";
import type { WorktreePorts } from "./types";

/** One structured start's setup request. */
export interface WorktreeSetupExecParams {
  ticketId: string;
  worktreePath: string;
  /** The project's setup command as configured now; empty or `null` consumes the pending run. */
  setupCommand: string | null;
  /** The shell the command runs in, as a login shell (`<shell> -l -c <command>`). */
  shellPath: string;
  /** The child's whole environment. */
  env: Record<string, string>;
}

/**
 * `skipped`: nothing was owed, another door claimed it, or no command is
 * configured (the claim consumed it). `succeeded`: the command exited 0.
 * `failed`: it exited non-zero, died on a signal, or never started — already
 * recorded on the ticket; `message` is the one-line reason for the start.
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

/**
 * Claims the worktree's pending setup run and, if this call won it, runs the
 * command to completion. Resolves; never rejects — every failure is an outcome
 * the caller reports.
 */
export function runPendingWorktreeSetup(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
): Promise<WorktreeSetupExecOutcome> {
  const key = canonicalize(params.worktreePath);
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  if (!claimFirstRunSetup(deps, params.worktreePath)) return Promise.resolve({ kind: "skipped" });
  const command = params.setupCommand?.trim() ?? "";
  if (command.length === 0) return Promise.resolve({ kind: "skipped" });
  const run = execSetup(deps, params, command).finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

function execSetup(
  deps: WorktreePorts,
  params: WorktreeSetupExecParams,
  command: string,
): Promise<WorktreeSetupExecOutcome> {
  setPhase(params.ticketId, "setting-up", deps.onPhase);
  return new Promise((resolve) => {
    let tail = "";
    let settled = false;
    const append = (chunk: Buffer | string): void => {
      tail = (tail + chunk.toString()).slice(-SETUP_TAIL_MAX_CHARS);
    };
    const settle = (exit: string, ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (ok) {
        setPhase(params.ticketId, "ready", deps.onPhase);
        resolve({ kind: "succeeded" });
        return;
      }
      recordSetupFailure(deps, params.ticketId, `${tail}\n[${exit}]`);
      const lastLine = lastOutputLine(tail);
      resolve({
        kind: "failed",
        message: `The project's setup command ${exit}${lastLine === null ? "." : `: ${lastLine}`}`,
      });
    };
    // No stdin: nobody can answer a prompt here, so one reads end-of-file and
    // fails instead of hanging the start.
    const child = spawn(params.shellPath, ["-l", "-c", command], {
      cwd: params.worktreePath,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => settle(`could not start (${error.message})`, false));
    child.once("close", (code, signal) => {
      if (code === 0) settle("exited 0", true);
      else if (code !== null) settle(`exited with code ${code}`, false);
      else settle(`was stopped by ${signal ?? "a signal"}`, false);
    });
  });
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
