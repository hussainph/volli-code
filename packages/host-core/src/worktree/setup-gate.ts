/**
 * The setup GATE's state and a person's two answers to it (VC-584).
 *
 * A working copy whose environment setup failed does not quietly start agents
 * in a half-prepared checkout, and it does not run the setup again on its own
 * either: setup is at-most-once (VC-835). Every structured start is refused
 * with the failed run's reason (`setup-exec.ts`) until a person answers:
 *
 *  - **Retry setup** owes the run again. The next start claims and runs it,
 *    exactly like a new working copy's.
 *  - **Start anyway** records that the working copy is set up with errors.
 *    Starts proceed, and the run is not attempted again.
 *
 * The third answer, fixing the recipe with an agent, is a new ticket in the
 * project (the handler that serves these doors creates it); it changes
 * nothing here, and the person retries once the fix lands.
 */
import {
  isBlockingSetupRun,
  markSetupStartedAnyway,
  readEnvironmentRun,
  type EnvironmentRunFact,
} from "./environment-runs";
import { isFirstRunPending, rearmFirstRunSetup } from "./first-run";
import { isWorktreeSetupRunning } from "./setup-exec";
import type { WorktreePorts } from "./types";

type HomePorts = Pick<WorktreePorts, "home">;

/**
 * Where one working copy's environment setup stands on this machine.
 * `none`: nothing is owed and nothing ran (no recipe, or a working copy from
 * before run facts were kept). `failed` is the state that blocks starts.
 */
export type WorktreeSetupStatus =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "succeeded"; run: EnvironmentRunFact }
  | { kind: "failed"; run: EnvironmentRunFact }
  | { kind: "started-anyway"; run: EnvironmentRunFact };

/** Reads the working copy's setup status. Throws when its record cannot be read. */
export function worktreeSetupStatus(deps: HomePorts, worktreePath: string): WorktreeSetupStatus {
  if (isWorktreeSetupRunning(worktreePath)) return { kind: "running" };
  if (isFirstRunPending(deps, worktreePath, "setup")) return { kind: "pending" };
  const run = readEnvironmentRun(deps, worktreePath, "setup");
  if (run === null) return { kind: "none" };
  if (run.outcome === "succeeded") return { kind: "succeeded", run };
  return isBlockingSetupRun(run) ? { kind: "failed", run } : { kind: "started-anyway", run };
}

/**
 * Retry setup: owes the run again when the last one did not succeed. Any
 * other state is returned unchanged — a run already owed or in flight is not
 * owed twice, and one that succeeded has nothing to retry.
 */
export function retryWorktreeSetup(
  deps: HomePorts,
  worktreePath: string,
  ticketId: string,
): WorktreeSetupStatus {
  const status = worktreeSetupStatus(deps, worktreePath);
  if (status.kind !== "failed" && status.kind !== "started-anyway") return status;
  rearmFirstRunSetup(deps, worktreePath, ticketId);
  return { kind: "pending" };
}

/** Start anyway: answers a blocking failed setup. Any other state is returned unchanged. */
export function startWorktreeSetupAnyway(
  deps: HomePorts,
  worktreePath: string,
  now: number,
): WorktreeSetupStatus {
  const status = worktreeSetupStatus(deps, worktreePath);
  if (status.kind !== "failed") return status;
  const run = markSetupStartedAnyway(deps, worktreePath, now);
  return run === null ? worktreeSetupStatus(deps, worktreePath) : { kind: "started-anyway", run };
}
