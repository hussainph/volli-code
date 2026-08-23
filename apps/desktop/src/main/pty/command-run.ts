/**
 * One command, typed into a Session terminal the user is watching, with an
 * answer when it finishes.
 *
 * The second occupant of the manager's sentinel slot. `worktree/setup-run.ts`
 * is the first: it runs a project's setup command after a fresh worktree and
 * drives that ticket's `setting-up → ready | failed` phase. This one drives
 * nothing durable — it exists so a surface that OFFERED to run something (the
 * dependency offer, VC-156) can say when the offer has been fulfilled, and
 * re-measure instead of leaving the user to guess.
 *
 * Everything about how the run is detected is shared with the setup step,
 * deliberately: the same `buildSetupSentinelLine` wrapper (shell-aware, so
 * fish is not handed a POSIX subshell), the same `parseSetupSentinel` tail
 * scan, the same "no sentinel yet is not an error" patience — an install is
 * slow and chatty, and its output belongs on screen the whole time.
 *
 * What it deliberately does NOT do is own the terminal. The command is typed
 * into a live interactive shell, never spawned as the pane's primary process
 * (cmux #5032), so the user can watch it, interrupt it, and keep the shell
 * afterwards whatever it exited with.
 */
import type { SetupFeedResult, SetupRun } from "../worktree";
import { buildSetupSentinelLine, parseSetupSentinel } from "../worktree";

/**
 * How a run ended: the command's own exit code, or `null` when the shell died
 * before the sentinel printed. `null` is not exit code 0 wearing a disguise —
 * nothing ran to completion, and a caller that treats it as success would
 * report an install that never happened.
 */
export type CommandRunOutcome = { exitCode: number | null };

export interface CommandRunParams {
  /** The command line to type, already trimmed and known non-empty by the caller. */
  command: string;
  /** The resolved shell the PTY spawned with — the wrapper is shell-aware. */
  shellPath: string;
  /** Called exactly once, when the run settles either way. */
  settle(outcome: CommandRunOutcome): void;
}

/**
 * The same cap the setup run keeps, for the same reason: only the trailing
 * window can carry the sentinel, which prints last.
 */
const TAIL_MAX_CHARS = 16_000;

/**
 * Arms a command run. The caller writes {@link SetupRun.commandLine} into the
 * terminal, then feeds it every output chunk and notifies it of a shell exit —
 * the identical protocol the setup run uses, so the manager drives one slot
 * and not two.
 *
 * `feed` reports `ready` with a null launch command on success and `failed`
 * otherwise, which is what keeps the manager from typing anything of its own
 * afterwards: nothing was being held back behind this run.
 */
export function createCommandRun(params: CommandRunParams): SetupRun {
  let tail = "";
  let settled = false;

  function finish(exitCode: number | null): void {
    settled = true;
    params.settle({ exitCode });
  }

  return {
    commandLine: buildSetupSentinelLine(params.command, params.shellPath),
    feed(chunk: string): SetupFeedResult {
      if (settled) return { status: "pending" };
      tail = (tail + chunk).slice(-TAIL_MAX_CHARS);
      const exitCode = parseSetupSentinel(tail);
      if (exitCode === null) return { status: "pending" };
      finish(exitCode);
      return exitCode === 0 ? { status: "ready", launchCommand: null } : { status: "failed" };
    },
    handleExit(): void {
      if (settled) return;
      finish(null);
    },
  };
}
