/**
 * What a deliberate move into an armed column carries, kept apart from
 * `automation.ts` so the cloud board rules can name it without importing the
 * whole Automation model.
 */

/**
 * How long an armed column waits before it starts its Run, in milliseconds
 * (VC-112, "Board interaction").
 *
 * 3500 ms is the whole safety story for an act nobody confirmed: long enough to
 * read the sentence and reach the one control, short enough that a deliberate
 * move does not feel held up. Exactly one control lives in this window —
 * Cancel, which keeps the move and starts nothing. Sending the Ticket back is
 * the board's ordinary undo and is deliberately not offered here: two buttons
 * inside 3.5 seconds is a choice nobody can make in time.
 */
export const ARMED_RUN_DELAY_MS = 3500;

/** What a Deliberate move carries when the Option-drag picker named a target. */
export type DeliberateMoveChoice =
  | { kind: "automation"; automationId: string }
  | { kind: "move-only" };
