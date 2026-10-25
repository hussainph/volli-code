/**
 * The environment recipe's RESUME script (VC-584): `.agents/resume` in the
 * working copy, run when this runner first uses that working copy since the
 * runner started or the machine woke. Its job is what does not survive a
 * restart or a sleep — services (`docker compose up -d`, a dev database),
 * short-lived auth — never installs; those are setup's.
 *
 * A start waits for it a short while ({@link RESUME_WAIT_MS}), then lets it
 * run on in the background and starts anyway, so a slow resume never holds a
 * turn. Processes it starts survive it: starting them is the point. A resume
 * that fails is a warning, never a block — its fact is recorded and logged.
 *
 * Only the repository file runs: there is no stored resume command. Behind
 * the `cloud` flag, like the rest of the recipe.
 */
import { spawn } from "node:child_process";

import { recordEnvironmentRun } from "./environment-runs";
import { canonicalize } from "./paths";
import {
  localRunnerKind,
  recipeEnvironment,
  recipeInvocation,
  resolveRecipe,
  type ResumeReason,
} from "./recipe";
import { SETUP_TAIL_MAX_CHARS } from "./setup-run";
import type { WorktreeRecipeContext } from "./setup-exec";
import type { WorktreePorts } from "./types";
import type { PowerPort } from "../ports/power";
import { hostLogger } from "../log/root";

const log = hostLogger("worktree-resume");

/** How long a start waits for its resume before it lets it run on in the background. */
const RESUME_WAIT_MS = 10_000;

/** A resume still running after this long is stopped. */
const RESUME_HARD_LIMIT_MS = 10 * 60_000;

/** How long output may keep draining after the script exited. */
const DRAIN_GRACE_MS = 250;

/** One start's resume request. */
export interface WorktreeResumeParams {
  ticketId: string;
  worktreePath: string;
  recipe: WorktreeRecipeContext;
  /** The runner's environment for the script, like setup's. */
  environment: () => Promise<{ shellPath: string; env: Record<string, string> }>;
  /** Overrides {@link RESUME_WAIT_MS}; tests only. */
  waitMs?: number;
  now?: () => number;
}

/**
 * `skipped`: already resumed in this runner epoch, or no `.agents/resume`.
 * `finished`: it ended within the wait (`ok` says how). `background`: it is
 * still running and the start goes on without it.
 */
export type WorktreeResumeOutcome =
  | { kind: "skipped" }
  | { kind: "finished"; ok: boolean; summary: string }
  | { kind: "background" };

/**
 * Which working copies this runner has resumed since it started or last woke,
 * and why the next one resumes. A wake starts a new epoch.
 */
let epoch: { reason: ResumeReason; resumed: Map<string, Promise<WorktreeResumeOutcome>> } = {
  reason: "runner-start",
  resumed: new Map(),
};

/** The machine woke: every working copy resumes again on its next start. */
function noteRunnerWake(): void {
  epoch = { reason: "wake", resumed: new Map() };
}

const watchedPowerPorts = new WeakSet<PowerPort>();

/** Starts a new resume epoch on every wake `power` announces. Idempotent per port. */
export function watchRunnerWakes(power: PowerPort): void {
  if (watchedPowerPorts.has(power)) return;
  watchedPowerPorts.add(power);
  power.on("resume", noteRunnerWake);
}

/** Tests only. */
export function resetResumeEpochForTest(): void {
  epoch = { reason: "runner-start", resumed: new Map() };
}

/**
 * Runs the working copy's resume script when this epoch has not yet, waiting
 * at most the resume wait. Two starts in one epoch share one run. Resolves;
 * never rejects.
 */
export function runWorktreeResume(
  deps: WorktreePorts,
  params: WorktreeResumeParams,
): Promise<WorktreeResumeOutcome> {
  const key = canonicalize(params.worktreePath);
  const current = epoch;
  const existing = current.resumed.get(key);
  if (existing !== undefined) return existing.then(() => ({ kind: "skipped" }));
  const run = startResume(deps, params, current.reason);
  current.resumed.set(key, run);
  return run;
}

async function startResume(
  deps: WorktreePorts,
  params: WorktreeResumeParams,
  reason: ResumeReason,
): Promise<WorktreeResumeOutcome> {
  let recipe;
  try {
    recipe = resolveRecipe(params.worktreePath, "resume", null);
  } catch (error) {
    log.warn("could not read .agents/resume", { ticketId: params.ticketId, error });
    return { kind: "finished", ok: false, summary: "`.agents/resume` could not be read." };
  }
  if (recipe === null) return { kind: "skipped" };
  const now = params.now ?? Date.now;
  const runnerKind = params.recipe.runnerKind ?? localRunnerKind();
  const startedAt = now();
  let environment: { shellPath: string; env: Record<string, string> };
  try {
    environment = await params.environment();
  } catch (error) {
    log.warn("could not start .agents/resume", { ticketId: params.ticketId, error });
    return { kind: "finished", ok: false, summary: "`.agents/resume` could not start." };
  }
  const invocation = recipeInvocation(recipe, environment.shellPath);
  const finished = new Promise<{ ok: boolean; summary: string }>((resolve) => {
    let tail = "";
    let settled = false;
    // Its own process group, so what it starts outlives this host; stdin is
    // empty, as for setup.
    const child = spawn(invocation.file, invocation.args, {
      cwd: params.worktreePath,
      env: {
        ...environment.env,
        ...recipeEnvironment({
          runnerKind,
          projectId: params.recipe.projectId,
          ticket: params.recipe.ticketDisplayId,
          workingCopy: params.worktreePath,
          reason: { script: "resume", why: reason },
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.unref();
    const limit = setTimeout(() => {
      // Only the script itself: what it started is meant to keep running.
      child.kill("SIGKILL");
    }, RESUME_HARD_LIMIT_MS);
    limit.unref?.();
    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const ok = error === undefined && code === 0;
      const summary =
        error !== undefined
          ? `\`.agents/resume\` could not start (${error.message}).`
          : code !== null
            ? ok
              ? "`.agents/resume` succeeded."
              : `\`.agents/resume\` exited with code ${code}.`
            : `\`.agents/resume\` was stopped by ${signal ?? "a signal"}.`;
      try {
        recordEnvironmentRun(
          deps,
          params.worktreePath,
          {
            script: "resume",
            source: "repo",
            scriptSha: recipe.sha,
            reason,
            runnerKind,
            ticketId: params.ticketId,
            startedAt,
          },
          { endedAt: now(), outcome: ok ? "succeeded" : "failed", exitCode: code, summary, tail },
        );
      } catch (recordError) {
        log.error("failed to record the resume run", { ticketId: params.ticketId, recordError });
      }
      if (!ok) log.warn("resume failed", { ticketId: params.ticketId, summary });
      resolve({ ok, summary });
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-SETUP_TAIL_MAX_CHARS);
      });
    }
    child.once("error", (error) => settle(null, null, error));
    // The script's exit is the end of the run. Its last output can still be in
    // the pipes; services it started may keep them open, and are not waited on.
    child.once("exit", (code, signal) => {
      child.once("close", () => settle(code, signal));
      setTimeout(() => settle(code, signal), DRAIN_GRACE_MS).unref?.();
    });
  });
  let wait: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"background">((resolve) => {
    wait = setTimeout(() => resolve("background"), params.waitMs ?? RESUME_WAIT_MS);
    wait.unref?.();
  });
  const first = await Promise.race([finished, waited]);
  clearTimeout(wait);
  if (first === "background") return { kind: "background" };
  return { kind: "finished", ...first };
}
