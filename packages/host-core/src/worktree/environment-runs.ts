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
import type { RecipeScript, ResolvedRecipe, ResumeReason, RunnerKind, SetupReason } from "./recipe";
import type { WorktreePorts } from "./types";

type HomePorts = Pick<WorktreePorts, "home">;

/** How a run ended. */
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

function isFact(value: unknown): value is EnvironmentRunFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Partial<EnvironmentRunFact>;
  return (
    typeof fact.id === "string" &&
    (fact.script === "setup" || fact.script === "resume") &&
    (fact.outcome === "succeeded" || fact.outcome === "failed" || fact.outcome === "timed_out") &&
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
export function isBlockingSetupRun(fact: EnvironmentRunFact | null): fact is EnvironmentRunFact {
  return fact !== null && fact.outcome !== "succeeded" && fact.startedAnywayAt === undefined;
}

/**
 * Start anyway: records that a person chose to work in the working copy
 * despite its failed setup. Returns the updated fact, or `null` when there is
 * no blocking run to answer.
 */
export function markSetupStartedAnyway(
  deps: HomePorts,
  worktreePath: string,
  now: number,
): EnvironmentRunFact | null {
  const fact = readEnvironmentRun(deps, worktreePath, "setup");
  if (!isBlockingSetupRun(fact)) return null;
  const answered: EnvironmentRunFact = { ...fact, startedAnywayAt: now };
  writeFact(deps, worktreePath, answered);
  return answered;
}
