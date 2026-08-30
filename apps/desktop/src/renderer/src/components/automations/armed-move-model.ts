/**
 * The armed-column delay window, as arithmetic (VC-128).
 *
 * A Deliberate move into an armed column does not start its Run: it opens a
 * 3500 ms window with visible progress and exactly one control — Cancel, which
 * keeps the move and starts nothing. This module is that window's whole
 * decision surface, kept pure so every rule below is a test rather than a
 * stopwatch held against the UI. The timers, the toast and the IPC live in
 * `armed-run.ts` beside it.
 *
 * The rule the rest of the file exists to serve: **a slipped pointer cannot
 * start a Run without passing the delay undisturbed.** That is three separate
 * guarantees, and each has its own function here.
 *
 *  1. A slip that lands in the same column is not an arrival at all
 *     ({@link armedMoveDecision} via the shared `isColumnArrival`).
 *  2. A window that has not actually elapsed cannot fire, whatever a timer
 *     believes — {@link armedRunVerdict} re-reads the clock and asks to be
 *     rescheduled rather than trusting the callback that woke it.
 *  3. A Ticket dragged out again, an Automation deleted, or a column disarmed
 *     inside the window abandons it, because the arrival the window was opened
 *     for is no longer true at the moment it would fire.
 *
 * And one rule that is not about slips at all: **a switched-off Automation
 * fires nothing** (VC-127, VC-112 — "a new machine sees the Skills and fires
 * nothing until someone turns something on there"). Enablement is asked here,
 * at both the arrival and the deadline, because it governs what starts an
 * Automation BESIDES a person. Running one by hand is universal and is
 * deliberately unaffected: the palette and the rail never consult this file.
 *
 * VC-132 adds one more way a window opens and does not add a second kind of
 * window. A release on a named target in the ⌥ drag picker carries the
 * Automation it named ({@link DeliberateMoveChoice}), and that Automation gets
 * **the same 3500 ms window, with the same one Cancel**. It does not fire
 * immediately, and the AC settles that on its own terms: `1` in the picker is
 * specified to reproduce a plain drop, so a picked target that fired at once
 * would make `1` strictly MORE dangerous than the drop it claims to reproduce,
 * and ⌥-drag the only unguarded door on the board to spending tokens.
 *
 * What a pick does bypass is the two switches, because neither is what it
 * depended on: an ⌥-pick is a PERSON, and VC-112 rules that enablement (and,
 * beside it, arming) governs what starts an Automation *besides* a person. What
 * it does NOT bypass is the arrival rule above — a release back into the column
 * a card came from is not an arrival for a pick any more than for a plain drop,
 * which is also the only reading under which "`1` reproduces a plain drop"
 * stays true in every column.
 */
import {
  ARMED_RUN_DELAY_MS,
  armedAutomationFor,
  isColumnArrival,
  type Automation,
  type ColumnArming,
  type TicketStatus,
} from "@volli/shared";

/**
 * What a Deliberate move carries from the ⌥ picker (VC-132): the Automation the
 * person named, or the named Move only target.
 *
 * It comes from ONE door — the board's own drop commit. A `volli ticket move`
 * never carries one, and neither does the card's context menu or the ticket
 * rail's status pill: those are moves, not aimed releases, and an absent choice
 * is exactly today's path.
 */
export type DeliberateMoveChoice =
  | { kind: "automation"; automationId: string }
  | { kind: "move-only" };

/** Which door opened a window: the column's own arming, or a person's pick. */
export type PendingArmedRunOrigin = "armed" | "chosen";

/** One open delay window: an arrival that has not yet become a Run. */
export interface PendingArmedRun {
  /**
   * Keyed per Ticket. A Ticket cannot be arriving in two columns at once, so a
   * second arrival for the same Ticket replaces the first rather than queueing
   * behind it — and the replaced window fires nothing, which is what a person
   * dragging a card twice in three seconds means.
   */
  ticketId: string;
  projectId: string;
  /** The Ticket's display id, for a sentence a person can check against the board. */
  ticketDisplayId: string;
  automationId: string;
  /** Snapshotted so the window keeps naming what it will start, even mid-rename. */
  automationName: string;
  /** The column arrived in. Re-checked at the deadline — see {@link armedRunVerdict}. */
  status: TicketStatus;
  /**
   * Which door opened this window (VC-132). Read at the deadline and nowhere
   * else: a `chosen` window is not abandoned by disarming or by the
   * machine-local switch, because the pick never depended on either.
   */
  origin: PendingArmedRunOrigin;
  /** Epoch ms the window opened. */
  openedAt: number;
  /** Epoch ms the Run may start at, and never before. */
  startAt: number;
}

/**
 * What a committed Deliberate move means for Automations: nothing at all, or a
 * window to open.
 *
 * Called only after a move has actually committed, never on a drag preview: an
 * arrival that the board later reverts must not have started anything, and the
 * cheapest way to guarantee that is to never look at a position nobody has
 * written yet.
 */
export type ArmedMoveDecision =
  | { kind: "nothing" }
  | { kind: "open-window"; automation: Automation; origin: PendingArmedRunOrigin };

export function armedMoveDecision(input: {
  automations: readonly Automation[];
  armings: readonly ColumnArming[];
  /** Which Automations are switched on ON THIS MACHINE — absent means off. */
  enabledAutomationIds: readonly string[];
  from: TicketStatus;
  to: TicketStatus;
  /** What the ⌥ picker named on release, when the move came from the board's drop. */
  choice?: DeliberateMoveChoice;
}): ArmedMoveDecision {
  // A reorder inside one column is not an arrival. This is why a card dragged
  // up its own armed column — the most common slip on the board — can never
  // start anything, before any delay is even considered. It is asked first for
  // a PICK too: see the module doc.
  if (!isColumnArrival(input.from, input.to)) return { kind: "nothing" };
  // The named Move only target: land the card, start nothing. It is the whole
  // point of the target, so it answers before anything about arming is asked.
  if (input.choice?.kind === "move-only") return { kind: "nothing" };
  const choice = input.choice;
  if (choice?.kind === "automation") {
    const picked = input.automations.find((automation) => automation.id === choice.automationId);
    // Deleted between the release and this classification. Falling back to the
    // column's own armed Automation would run something the person did not
    // name, which is the one substitution this whole layer exists to prevent.
    if (picked === undefined) return { kind: "nothing" };
    // Neither switch is consulted: an ⌥-pick is a person, and both switches
    // govern what starts an Automation *besides* a person (VC-112).
    return { kind: "open-window", automation: picked, origin: "chosen" };
  }
  const automation = armedAutomationFor(input.automations, input.armings, input.to);
  // An unarmed column is a pure status change, exactly as it is today.
  if (automation === null) return { kind: "nothing" };
  // An armed column whose Automation is switched off here is the same pure
  // status change. The column keeps its arming and the bolt keeps saying so:
  // the switch is about this MACHINE, and a person who turns it back on wants
  // the column they armed still armed.
  if (!input.enabledAutomationIds.includes(automation.id)) return { kind: "nothing" };
  return { kind: "open-window", automation, origin: "armed" };
}

/** Opens a window for `automation`, at `now`. `startAt` is the only deadline anything reads. */
export function openArmedRun(input: {
  ticketId: string;
  ticketDisplayId: string;
  projectId: string;
  automation: Automation;
  status: TicketStatus;
  origin: PendingArmedRunOrigin;
  now: number;
}): PendingArmedRun {
  return {
    ticketId: input.ticketId,
    ticketDisplayId: input.ticketDisplayId,
    projectId: input.projectId,
    automationId: input.automation.id,
    automationName: input.automation.name,
    status: input.status,
    origin: input.origin,
    openedAt: input.now,
    startAt: input.now + ARMED_RUN_DELAY_MS,
  };
}

/** Why a window ended without starting anything — each one a fact about the board, not a guess. */
export type ArmedRunAbandonReason =
  /** The Ticket is no longer on the board this renderer holds. */
  | "gone"
  /** It left the column it arrived in before the window closed. */
  | "left-column"
  /** The column stopped arming this Automation (disarmed, deleted, or its Trigger changed). */
  | "disarmed"
  /** The Automation was switched off on this machine while the countdown ran. */
  | "switched-off";

export type ArmedRunVerdict =
  | { kind: "start" }
  /** The deadline has not passed. `remainingMs` is what is genuinely left. */
  | { kind: "wait"; remainingMs: number }
  | { kind: "abandon"; reason: ArmedRunAbandonReason };

/**
 * Whether an open window may become a Run, judged at the moment it would fire.
 *
 * Everything here is re-read rather than remembered. A timer is a request to
 * reconsider, not a decision: it can wake late (a busy main thread, a laptop
 * that slept) and the board underneath it can have changed completely. The one
 * thing this function will not do is start a Run early — a callback that
 * arrives before `startAt` is answered with the real remaining time and asked
 * to come back, which is what "passing the delay undisturbed" means when the
 * only clock anyone trusts is the wall.
 */
export function armedRunVerdict(input: {
  pending: PendingArmedRun;
  now: number;
  /** The Ticket's current column, or `null` when the board no longer holds it. */
  currentStatus: TicketStatus | null;
  /** What the column arms NOW, resolved through the shared rule. */
  armedNow: Automation | null;
  /** Which Automations are switched on here NOW — re-read like everything else. */
  enabledAutomationIds: readonly string[];
}): ArmedRunVerdict {
  const remainingMs = input.pending.startAt - input.now;
  if (remainingMs > 0) return { kind: "wait", remainingMs };
  if (input.currentStatus === null) return { kind: "abandon", reason: "gone" };
  if (input.currentStatus !== input.pending.status) {
    return { kind: "abandon", reason: "left-column" };
  }
  // The two switch re-checks below are skipped for a window a person opened by
  // NAMING this Automation on a landing target (VC-132). The pick never
  // depended on either switch — both govern what starts an Automation besides a
  // person — so abandoning it because the column was disarmed mid-countdown
  // would cancel a Run nobody asked to cancel. The two facts that remain are
  // the ones about the arrival itself, and they are checked above for every
  // window: the Ticket is still on the board, and still where it landed.
  if (input.pending.origin === "chosen") return { kind: "start" };
  if (input.armedNow === null || input.armedNow.id !== input.pending.automationId) {
    return { kind: "abandon", reason: "disarmed" };
  }
  // Switched off inside the window. Abandoned like a disarm but named apart
  // from it: the column still arms this Automation, and telling someone their
  // column was disarmed when they turned the Automation off on the Automations
  // page would send them to the wrong control to undo it.
  if (!input.enabledAutomationIds.includes(input.pending.automationId)) {
    return { kind: "abandon", reason: "switched-off" };
  }
  return { kind: "start" };
}

/**
 * How far the window has run, from 0 at `openedAt` to 1 at `startAt`.
 *
 * Clamped at both ends so a clock that jumps (a resumed laptop) shows a full
 * bar rather than a negative one, and so a progress read before the window
 * opened is 0 rather than an error.
 */
export function armedRunProgress(pending: PendingArmedRun, now: number): number {
  const span = pending.startAt - pending.openedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - pending.openedAt) / span));
}

/**
 * Whole seconds left, rounded UP and floored at zero — the number the window
 * says out loud.
 *
 * Rounded up because rounding down would spend the last whole second saying
 * "0s" while Cancel is still live — a control that reads as already spent is
 * worse than one that overstates by a fraction. A 3500 ms window therefore
 * opens at 4 and ticks 3, 2, 1 before the Run starts.
 */
export function armedRunSecondsLeft(pending: PendingArmedRun, now: number): number {
  return Math.max(0, Math.ceil((pending.startAt - now) / 1000));
}
