/**
 * The states of one project move (`cloud_moves.state`): the last step it
 * completed. A move resumes by running the step after its state; every step
 * is idempotent, so a step a crash interrupted runs again from the start.
 *
 * ```
 * queued → frozen → exported → reserved → staged → objects → rows → history
 *        → verified → committed → handed_over → checked → confirmed
 * any state before committed → rolling_back → rolled_back
 * committed … checked → rolling_back → rolled_back      (Roll back, uncommit first)
 * committed … confirmed → returning → returned           (Go back to local)
 * queued → superseded                                    (moved again under a new move)
 * ```
 */

export const MOVE_STATES = [
  "queued",
  "frozen",
  "exported",
  "reserved",
  "staged",
  "objects",
  "rows",
  "history",
  "verified",
  "committed",
  "handed_over",
  "checked",
  "confirmed",
  "rolling_back",
  "rolled_back",
  "returning",
  "returned",
  "superseded",
] as const;

export type MoveState = (typeof MOVE_STATES)[number];

/**
 * The forward path, in order: a move's next step is the one after its state.
 * `checked` → `confirmed` is the person's Finish move, never the engine's.
 */
export const FORWARD_STATES = [
  "queued",
  "frozen",
  "exported",
  "reserved",
  "staged",
  "objects",
  "rows",
  "history",
  "verified",
  "committed",
  "handed_over",
  "checked",
  "confirmed",
] as const satisfies readonly MoveState[];

export type ForwardState = (typeof FORWARD_STATES)[number];

/**
 * States in which the local project is read-only: from the freeze until the
 * move is rolled back or the person goes back to local. `confirmed` is the
 * archived local copy, read-only for good.
 */
export const FROZEN_STATES: ReadonlySet<MoveState> = new Set<MoveState>([
  "frozen",
  "exported",
  "reserved",
  "staged",
  "objects",
  "rows",
  "history",
  "verified",
  "committed",
  "handed_over",
  "checked",
  "confirmed",
  "rolling_back",
  "returning",
]);

/** States a move never leaves. */
export const SETTLED_STATES: ReadonlySet<MoveState> = new Set<MoveState>([
  "rolled_back",
  "returned",
  "superseded",
]);

/** States after the backend showed the project: rolling back must uncommit first. */
export const COMMITTED_STATES: ReadonlySet<MoveState> = new Set<MoveState>([
  "committed",
  "handed_over",
  "checked",
  "confirmed",
]);

/** What the person sees a move doing: the plan's coarse phases (§2.1). */
export type MovePhase =
  | "queued"
  | "frozen"
  | "exported"
  | "uploading"
  | "importing"
  | "verifying"
  | "committed"
  | "confirmed"
  | "rolling_back"
  | "rolled_back"
  | "returning"
  | "returned"
  | "superseded";

export function movePhase(state: MoveState): MovePhase {
  switch (state) {
    case "reserved":
    case "staged":
      return "uploading";
    case "objects":
    case "rows":
      return "importing";
    case "history":
    case "verified":
      return "verifying";
    case "handed_over":
    case "checked":
      return "committed";
    default:
      return state;
  }
}

/** Whether `state` is at or past `step` on the forward path. */
export function reached(state: MoveState, step: ForwardState): boolean {
  const at = (FORWARD_STATES as readonly MoveState[]).indexOf(state);
  return at >= 0 && at >= FORWARD_STATES.indexOf(step);
}
