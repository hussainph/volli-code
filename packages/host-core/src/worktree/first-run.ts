/**
 * A worktree's FIRST-RUN steps as a durable fact of the worktree (VC-835).
 *
 * Two steps belong to a worktree's creation and to nothing after it: the copy
 * of git-uncarried local files (`include.ts`) and the project's setup command
 * (Configure → Worktrees → Then run). Both used to hang off one `ensure` call's
 * `created` — true only for the call that actually ran `git worktree add`. That
 * lost them in two ways. A start that failed after the add (the copy threw, the
 * attachments stage threw, the add outlived its deadline) left a registered
 * worktree behind, so the Retry reconciled to `already-present` and skipped
 * both for good. And the setup command had one runner, the terminal, so a
 * worktree a Chat Session created consumed `created` and never ran it at all.
 *
 * So the steps are recorded as PENDING on disk, one marker file per step,
 * BEFORE `git worktree add` runs, and each marker is removed only when its step
 * is done with:
 *
 *  - **copy** is completed by `ensure` once the copy succeeds. A failed copy
 *    leaves the marker, and the next `ensure` (reuse or not) runs it again.
 *    The copy never overwrites, so a second pass only fills what the first
 *    did not reach.
 *  - **setup** is CLAIMED by whichever door runs it — the terminal types it
 *    into its shell, a structured Session runs it before its first turn
 *    (`setup-exec.ts`). The claim is an `unlink`, so of two doors racing for
 *    one worktree exactly one wins. Claiming happens BEFORE the command runs:
 *    a setup command is at-most-once, never silently retried, and its outcome
 *    is reported where it ran.
 *
 * A worktree with no marker has nothing pending. That includes every worktree
 * created before this record existed, which keeps reuse boots exactly as they
 * were: setup runs for a new worktree and never again for an existing one.
 *
 * The markers live beside the worktree tree in Volli's own `~/.volli`, keyed by
 * the worktree's canonical path, rather than in the repository: the fact is
 * about this machine's working copy, and git's directories are the user's. A
 * marker outliving its worktree is harmless — a later creation at the same path
 * writes it afresh, and nothing reads one for a path that is not a worktree.
 *
 * Every operation here is ONE synchronous syscall on a tiny file, on purpose,
 * although `ensure` runs on Electron main and keeps its real work async
 * (VC-16): it is the cost of the `existsSync` a turn already pays before it
 * starts, it adds no event-loop turns to a Session start, and the terminal's
 * claim must not await at all (see {@link claimFirstRunSetup}).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hostLogger } from "../log/root";
import { homeDir } from "./home";
import { canonicalize } from "./paths";
import type { WorktreePorts } from "./types";

const log = hostLogger("worktree-first-run");

/** The creation-only steps a worktree can still owe. */
export type FirstRunStep = "copy" | "setup";

type HomePorts = Pick<WorktreePorts, "home">;

/** `<home>/.volli/worktree-first-run` — a sibling of the worktree tree, never inside it. */
function markerDir(deps: HomePorts): string {
  return join(homeDir(deps), ".volli", "worktree-first-run");
}

/**
 * The marker for one step of one worktree. The key is a digest of the
 * canonical path, so a worktree that does not exist yet (the marker is written
 * before the add) and the same worktree afterwards name one file.
 */
function markerPath(deps: HomePorts, worktreePath: string, step: FirstRunStep): string {
  const key = createHash("sha256").update(canonicalize(worktreePath)).digest("hex").slice(0, 32);
  return join(markerDir(deps), `${key}.${step}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Records `steps` as pending for the worktree about to be created at
 * `worktreePath`. Written before the add, so a start that dies anywhere after
 * it — including inside the add — still owes them on the next start.
 */
export function markFirstRunPending(
  deps: HomePorts,
  worktreePath: string,
  ticketId: string,
  steps: readonly FirstRunStep[],
): void {
  mkdirSync(markerDir(deps), { recursive: true });
  // The body is for a person reading the directory; only the file's existence
  // is ever read back.
  const body = `${JSON.stringify({ worktreePath, ticketId })}\n`;
  for (const step of steps) writeFileSync(markerPath(deps, worktreePath, step), body, "utf8");
}

/** Whether the worktree at `worktreePath` still owes `step`. */
export function isFirstRunPending(
  deps: HomePorts,
  worktreePath: string,
  step: FirstRunStep,
): boolean {
  return existsSync(markerPath(deps, worktreePath, step));
}

/** Records the copy step done. Idempotent: a marker already gone is the same answer. */
export function completeFirstRunCopy(deps: HomePorts, worktreePath: string): void {
  try {
    unlinkSync(markerPath(deps, worktreePath, "copy"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Claims the worktree's pending setup run: `true` for exactly one caller, which
 * must then run the command (or, with no command configured, simply consume
 * it); `false` when nothing is pending or another door claimed it first.
 *
 * The terminal claims it after its shell is registered, where an await would
 * open a window for the shell to die between the claim and the line that runs
 * it. A claim
 * that fails for any reason but "already gone" is logged and answers `false`:
 * running a setup command twice is worse than not running it, and the failure
 * is the operator's to see rather than a reason to stop a Session starting.
 */
export function claimFirstRunSetup(deps: HomePorts, worktreePath: string): boolean {
  try {
    unlinkSync(markerPath(deps, worktreePath, "setup"));
    return true;
  } catch (error) {
    if (!isMissing(error))
      log.error("could not claim a pending setup run", { worktreePath, error });
    return false;
  }
}
