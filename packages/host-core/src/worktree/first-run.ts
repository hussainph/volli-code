/**
 * A worktree's FIRST-RUN steps as a durable fact of the worktree (VC-835).
 *
 * Two steps belong to a worktree's creation and to nothing after it: the copy
 * of git-uncarried local files (`include.ts`) and the project's setup command
 * (Configure → Worktrees → Then run). Neither can hang off whether one `ensure`
 * call ran `git worktree add`. A start that fails after the add (the copy
 * throws, the attachments stage throws, the add outlives its deadline) leaves a
 * registered worktree, so its Retry reconciles to `already-present` and still
 * owes both. And whichever door starts work first — a terminal or a Chat
 * Session, which may be the call that created the worktree or a later one —
 * has to be the one that runs the setup.
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
 * marker outliving its worktree stays inert: a later creation at the same path
 * rewrites the whole record, and nothing reads one for a path that is not a
 * worktree.
 *
 * Every operation here is synchronous, on purpose, although `ensure` runs on
 * Electron main and keeps its real work async (VC-16): each is a path
 * canonicalization plus a stat, unlink or small write — the order of the
 * `existsSync` a turn already pays before it starts — it adds no event-loop
 * turns to a Session start, and the terminal's claim must not await at all
 * (see {@link claimFirstRunSetup}). Failures other than "no such marker" throw,
 * so a caller can say so instead of silently skipping a step.
 */
import { createHash } from "node:crypto";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { homeDir } from "./home";
import { canonicalize } from "./paths";
import type { WorktreePorts } from "./types";

/** The creation-only steps a worktree can still owe. */
export type FirstRunStep = "copy" | "setup";

const STEPS: readonly FirstRunStep[] = ["copy", "setup"];

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
  return workingCopyRecordPath(deps, worktreePath, step);
}

/**
 * A file of this machine's record about one working copy, beside its first-run
 * markers: `<home>/.volli/worktree-first-run/<key>.<suffix>`. The environment
 * recipe's run facts (`environment-runs.ts`) live here too, so one record
 * outlives and is keyed exactly like the markers.
 */
export function workingCopyRecordPath(
  deps: HomePorts,
  worktreePath: string,
  suffix: string,
): string {
  const key = createHash("sha256").update(canonicalize(worktreePath)).digest("hex").slice(0, 32);
  return join(markerDir(deps), `${key}.${suffix}`);
}

/** Creates the record directory; idempotent. */
export function ensureWorkingCopyRecordDir(deps: HomePorts): void {
  mkdirSync(markerDir(deps), { recursive: true });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Records exactly `steps` as pending for the worktree about to be created at
 * `worktreePath`, clearing any other step a record left by an earlier creation
 * attempt at the same path still names. Written before the add, so a start
 * that dies anywhere after it — including inside the add — still owes them on
 * the next start.
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
  for (const step of STEPS) {
    if (steps.includes(step)) writeFileSync(markerPath(deps, worktreePath, step), body, "utf8");
    else unlinkMarker(markerPath(deps, worktreePath, step));
  }
  // A new working copy at this path owes nothing an earlier one's recipe runs
  // recorded (`environment-runs.ts`): neither its outcome nor its failure.
  for (const record of RUN_RECORDS) unlinkMarker(workingCopyRecordPath(deps, worktreePath, record));
}

/** The environment recipe's run records (`environment-runs.ts`, `resume-exec.ts`), by suffix. */
const RUN_RECORDS = ["setup-run.json", "resume-run.json", "resume.log"] as const;

/** Removes one marker; `true` when this call removed it, `false` when it was already gone. */
function unlinkMarker(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Whether the worktree at `worktreePath` still owes `step`. */
export function isFirstRunPending(
  deps: HomePorts,
  worktreePath: string,
  step: FirstRunStep,
): boolean {
  // `statSync` rather than `existsSync`: a marker that cannot be read is an
  // error to report, never a step silently not owed.
  return statSync(markerPath(deps, worktreePath, step), { throwIfNoEntry: false }) !== undefined;
}

/** Records the copy step done. Idempotent: a marker already gone is the same answer. */
export function completeFirstRunCopy(deps: HomePorts, worktreePath: string): void {
  unlinkMarker(markerPath(deps, worktreePath, "copy"));
}

/**
 * Claims the worktree's pending setup run: `true` for exactly one caller, which
 * must then run the command (or, with no command configured, simply consume
 * it); `false` when nothing is pending or another door claimed it first.
 *
 * The terminal claims it after its shell is registered, where an await would
 * open a window for the shell to die between the claim and the line that runs
 * it. A claim that fails for any reason but "already gone" throws: the run is
 * still owed, and the caller reports why it could not take it.
 */
export function claimFirstRunSetup(deps: HomePorts, worktreePath: string): boolean {
  return unlinkMarker(markerPath(deps, worktreePath, "setup"));
}

/**
 * Owes the worktree's setup run again: a person's explicit Retry after a
 * failed run (VC-584). The next door to start work claims it exactly as it
 * claims a new worktree's — this is intent, never an automatic retry.
 */
export function rearmFirstRunSetup(deps: HomePorts, worktreePath: string, ticketId: string): void {
  mkdirSync(markerDir(deps), { recursive: true });
  writeFileSync(
    markerPath(deps, worktreePath, "setup"),
    `${JSON.stringify({ worktreePath, ticketId })}\n`,
    "utf8",
  );
}
