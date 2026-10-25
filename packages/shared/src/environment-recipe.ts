/**
 * The environment recipe's vocabulary as clients read it (VC-584): where one
 * working copy's setup stands, a person's answers to a failed one, and the
 * ticket "Fix with an agent" files.
 *
 * The recipe itself (`.agents/setup`, `.agents/resume`) runs on the runner
 * (`@volli/host-core`'s worktree module). This is what crosses to a window:
 * JSON-safe, with no machine paths in it.
 */

/** Which script ran: the working copy's own `.agents/setup`, or the project's stored command. */
export type EnvironmentRecipeSource = "repo" | "legacyCommand";

/** The last setup run, as a window shows it. */
export interface WorktreeSetupRunView {
  source: EnvironmentRecipeSource;
  /** The one-line reason ("`.agents/setup` exited with code 1: …"). */
  summary: string;
  exitCode: number | null;
  endedAt: number;
  /** The output's bounded tail; empty when the run's log is a terminal's scrollback. */
  tail: string;
}

/**
 * Where a working copy's setup stands on its runner. `failed` blocks every
 * structured start until a person answers it; `started-anyway` is a failed
 * setup a person chose to work past.
 */
export type WorktreeSetupStatusView =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "succeeded"; run: WorktreeSetupRunView }
  | { kind: "failed"; run: WorktreeSetupRunView }
  | { kind: "started-anyway"; run: WorktreeSetupRunView };

/**
 * A person's answer to a failed setup. `retry` owes the run again, so the
 * next start runs it; `start-anyway` lets starts proceed without it.
 */
export type WorktreeSetupAnswer = "retry" | "start-anyway";

export const WORKTREE_SETUP_ANSWERS = [
  "retry",
  "start-anyway",
] as const satisfies readonly WorktreeSetupAnswer[];

/** The most of a failed run's output a fix ticket carries. */
const FIX_TICKET_TAIL_MAX_CHARS = 4_000;

/**
 * The ticket "Fix with an agent" files for a failed setup: an ordinary
 * ticket in the same project, whose Session repairs the recipe. Its body
 * names the failing ticket, the reason, the output's tail and the contract a
 * recipe keeps, so the agent starts from the failure rather than rediscovering
 * it.
 */
export function environmentFixTicket(
  failedTicket: string,
  run: WorktreeSetupRunView,
): { title: string; body: string; labels: string[] } {
  const where =
    run.source === "repo"
      ? "the repository's `.agents/setup`"
      : "the project's stored setup command (Configure → Worktrees → Then run)";
  const tail = run.tail.trim().slice(-FIX_TICKET_TAIL_MAX_CHARS);
  // Longer than any backtick run in the output, so the output cannot close it.
  const longestRun = Math.max(0, ...(tail.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return {
    title: "Fix the environment setup",
    labels: ["environment"],
    body: [
      `Setting up a new working copy for ${failedTicket} failed: ${run.summary}`,
      "",
      `Make ${where} succeed in a fresh working copy. It runs from the repository root with nothing on stdin, and must be safe to run twice.`,
      "",
      "- Non-interactive: no prompts.",
      "- Idempotent: check before installing.",
      "- Install from the lockfile; guard system tools with `command -v` and `VOLLI_RUNNER_KIND` (`mac`, `linux` or `cloud`).",
      "- Start no long-running processes: anything left running is stopped. Services belong in `.agents/resume`.",
      "",
      `When it passes, answer ${failedTicket}'s setup with Retry setup.`,
      ...(tail.length === 0 ? [] : ["", "Output:", "", `${fence}text`, tail, fence]),
    ].join("\n"),
  };
}
