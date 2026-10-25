/**
 * The environment recipe's setup, run by a TERMINAL (VC-584): what a terminal
 * that claimed a working copy's pending setup types into its shell, and the
 * run fact it records when the sentinel reports the exit.
 *
 * The terminal keeps VC-835's sentinel runner (`setup-run.ts`): the person
 * watches the setup in the shell they are about to use. A repository
 * `.agents/setup` runs as a line under the recipe's variables with nothing on
 * stdin (`recipeCommandLine`); the stored command is typed as it always was.
 * Either way the run is recorded as the working copy's setup fact, so a later
 * structured start reads the same gate whichever door ran it.
 */
import { basename } from "node:path";

import { recordEnvironmentRun, setupReasonAfter } from "./environment-runs";
import { localRunnerKind, recipeCommandLine, recipeEnvironment, resolveRecipe } from "./recipe";
import type { WorktreePorts } from "./types";
import { hostLogger } from "../log/root";

const log = hostLogger("worktree-setup");

/** A terminal's claimed setup run. */
export interface TerminalSetupParams {
  ticketId: string;
  /** The ticket's display id (`VC-12`). */
  displayId: string;
  projectId: string;
  worktreePath: string;
  /** The project's stored setup command, the fallback when the working copy has no recipe. */
  storedCommand: string | null;
  /** The shell the terminal runs: the recipe line is quoted for it. */
  shellPath: string;
  now?: () => number;
}

/**
 * The line to type for the claimed run, and the hook that records its fact;
 * `null` when the working copy has nothing to run. Throws when the
 * repository's recipe cannot be read.
 */
export function terminalSetupCommand(
  deps: Pick<WorktreePorts, "home">,
  params: TerminalSetupParams,
): { command: string; onSettled: (settled: { exitCode: number | null }) => void } | null {
  const recipe = resolveRecipe(params.worktreePath, "setup", params.storedCommand);
  if (recipe === null) return null;
  const now = params.now ?? Date.now;
  const reason = setupReasonAfter(deps, params.worktreePath);
  const runnerKind = localRunnerKind();
  const shell = basename(params.shellPath).replace(/^-/, "") === "fish" ? "fish" : "posix";
  const command =
    recipe.source === "legacyCommand"
      ? recipe.command
      : recipeCommandLine(
          recipe,
          recipeEnvironment({
            runnerKind,
            projectId: params.projectId,
            ticket: params.displayId,
            workingCopy: params.worktreePath,
            reason: { script: "setup", why: reason },
          }),
          shell,
        );
  const startedAt = now();
  const subject = recipe.source === "repo" ? ".agents/setup" : "The project's setup command";
  return {
    command,
    onSettled: ({ exitCode }) => {
      const summary =
        exitCode === 0
          ? `${subject} succeeded.`
          : exitCode === null
            ? `${subject} did not finish: the terminal's shell exited first.`
            : `${subject} exited with code ${exitCode}.`;
      try {
        recordEnvironmentRun(
          deps,
          params.worktreePath,
          {
            script: "setup",
            source: recipe.source,
            scriptSha: recipe.sha,
            reason,
            runnerKind,
            ticketId: params.ticketId,
            startedAt,
          },
          {
            endedAt: now(),
            outcome: exitCode === 0 ? "succeeded" : "failed",
            exitCode,
            summary,
            // The terminal's own scrollback is the log; its tail is the
            // person's whole shell, so the fact keeps only the summary.
            tail: "",
          },
        );
      } catch (error) {
        log.error("failed to record the terminal's setup run", {
          ticketId: params.ticketId,
          error,
        });
      }
    },
  };
}
