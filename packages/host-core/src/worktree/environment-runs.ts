/**
 * The environment recipe's run FACTS for one working copy (VC-584): what the
 * last setup and resume run on this machine did, kept beside the worktree's
 * first-run markers (`first-run.ts`), keyed the same way.
 *
 * Machine state, not board truth: a run fact is this runner's record of a
 * process it ran in its own working copy. It is what the setup gate reads — a
 * failed setup blocks a structured Session's start until a person answers
 * it — and what a later reader (the Environment tab's recent runs, the
 * backend's `environment_runs` once runners report there) is built from. Each
 * fact carries a UUID so a reporter can deliver it idempotently.
 *
 * One file per script, rewritten whole on each run (write, then rename), so a
 * reader never sees half a fact.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { ensureWorkingCopyRecordDir, workingCopyRecordPath } from "./first-run";
import { localRunnerKind } from "./recipe";
import type { RecipeScript, ResolvedRecipe, ResumeReason, RunnerKind, SetupReason } from "./recipe";
import type { WorktreePorts } from "./types";

type HomePorts = Pick<WorktreePorts, "home">;

/** How a run ended. A record a later build wrote may name another; see {@link isFact}. */
export type EnvironmentRunOutcome = "succeeded" | "failed" | "timed_out";

/** One run of one recipe script in one working copy. */
export interface EnvironmentRunFact {
  /** A UUID: one fact, however often it is delivered. */
  id: string;
  script: RecipeScript;
  source: ResolvedRecipe["source"];
  /** Digest of what ran, so a changed recipe can be told apart from the one that ran. */
  scriptSha: string;
  reason: SetupReason | ResumeReason;
  runnerKind: RunnerKind;
  ticketId: string;
  startedAt: number;
  endedAt: number;
  outcome: EnvironmentRunOutcome;
  /** The script's exit code; `null` when it died on a signal, was stopped or never started. */
  exitCode: number | null;
  /** The one-line reason a person reads ("exited with code 1: …"). */
  summary: string;
  /** The output's bounded tail. */
  tail: string;
  /**
   * A failed setup a person chose to start without (Start anyway): the
   * working copy is "set up with errors", and the run is not attempted again.
   */
  startedAnywayAt?: number;
}

/** The fields a runner knows when it starts a run. */
export type EnvironmentRunStart = Pick<
  EnvironmentRunFact,
  "script" | "source" | "scriptSha" | "reason" | "runnerKind" | "ticketId" | "startedAt"
>;

function factPath(deps: HomePorts, worktreePath: string, script: RecipeScript): string {
  return workingCopyRecordPath(deps, worktreePath, `${script}-run.json`);
}

/**
 * Tolerant on read: an outcome this build does not know (a later build's) is
 * kept as written, and only the outcomes this build knows to be failures
 * block ({@link isBlockingSetupRun}).
 */
function isFact(value: unknown): value is EnvironmentRunFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Partial<EnvironmentRunFact>;
  return (
    typeof fact.id === "string" &&
    (fact.script === "setup" || fact.script === "resume") &&
    typeof fact.outcome === "string" &&
    typeof fact.summary === "string" &&
    typeof fact.endedAt === "number"
  );
}

/**
 * The last recorded `script` run in the working copy, or `null` when none was
 * recorded. A record that exists but cannot be read or parsed throws: a gate
 * must not read "nothing failed" from a fact it could not read.
 */
export function readEnvironmentRun(
  deps: HomePorts,
  worktreePath: string,
  script: RecipeScript,
): EnvironmentRunFact | null {
  let text: string;
  try {
    text = readFileSync(factPath(deps, worktreePath, script), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isFact(parsed))
    throw new Error(`The ${script} run record for ${worktreePath} is malformed.`);
  return parsed;
}

function writeFact(deps: HomePorts, worktreePath: string, fact: EnvironmentRunFact): void {
  ensureWorkingCopyRecordDir(deps);
  const path = factPath(deps, worktreePath, fact.script);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(fact)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Records a finished run as the working copy's latest for its script, and returns the fact. */
export function recordEnvironmentRun(
  deps: HomePorts,
  worktreePath: string,
  start: EnvironmentRunStart,
  end: Pick<EnvironmentRunFact, "endedAt" | "outcome" | "exitCode" | "summary" | "tail">,
): EnvironmentRunFact {
  const fact: EnvironmentRunFact = { id: randomUUID(), ...start, ...end };
  writeFact(deps, worktreePath, fact);
  return fact;
}

/**
 * Whether the working copy's last setup run blocks a start: it did not
 * succeed, and nobody chose to start anyway.
 */
export function isBlockingSetupRun(fact: EnvironmentRunFact | null): boolean {
  return (
    fact !== null &&
    (fact.outcome === "failed" || fact.outcome === "timed_out") &&
    fact.startedAnywayAt === undefined
  );
}

/**
 * Why the working copy's next setup runs: its first, or a retry after an
 * earlier run (one whose record cannot be read counts as earlier).
 */
export function setupReasonAfter(deps: HomePorts, worktreePath: string): SetupReason {
  try {
    return readEnvironmentRun(deps, worktreePath, "setup") === null ? "new-working-copy" : "retry";
  } catch {
    return "retry";
  }
}

/** Forgets the working copy's last `script` run: the run it described no longer applies. */
export function clearEnvironmentRun(
  deps: HomePorts,
  worktreePath: string,
  script: RecipeScript,
): void {
  rmSync(factPath(deps, worktreePath, script), { force: true });
}

/**
 * The fact a setup record that cannot be read stands for: a failed setup, so
 * a start never reads "nothing failed" from it, and either answer replaces it.
 */
export function unreadableSetupRun(ticketId: string, now: number): EnvironmentRunFact {
  return {
    id: randomUUID(),
    script: "setup",
    source: "repo",
    scriptSha: "",
    reason: "new-working-copy",
    runnerKind: localRunnerKind(),
    ticketId,
    startedAt: now,
    endedAt: now,
    outcome: "failed",
    exitCode: null,
    summary: "The environment setup record could not be read.",
    tail: "",
  };
}

/**
 * Start anyway: records that a person chose to work in the working copy
 * despite its failed setup. A record that cannot be read is replaced by one
 * that says so. Returns the updated fact, or `null` when there is no blocking
 * run to answer.
 */
export function markSetupStartedAnyway(
  deps: HomePorts,
  worktreePath: string,
  ticketId: string,
  now: number,
): EnvironmentRunFact | null {
  let fact: EnvironmentRunFact | null;
  try {
    fact = readEnvironmentRun(deps, worktreePath, "setup");
  } catch {
    fact = unreadableSetupRun(ticketId, now);
  }
  if (fact === null || !isBlockingSetupRun(fact)) return null;
  const answered: EnvironmentRunFact = { ...fact, startedAnywayAt: now };
  writeFact(deps, worktreePath, answered);
  return answered;
}
