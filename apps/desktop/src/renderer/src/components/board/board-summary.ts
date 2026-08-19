/**
 * What the board's header says about the board, now that it no longer says its
 * own name (VC-55).
 *
 * The permanent Board tab names the surface, so the `<h1>` under it went to the
 * outline and off the screen — which left a bare number holding the slot. A
 * count alone is the weakest thing that could stand there: it is already
 * visible as five column counts, and under a filter it quietly means something
 * different from what it says.
 *
 * So this decides two things, and both stay silent when they have nothing to
 * add:
 *
 *  • **The count qualifies itself.** `12` while the whole board is on screen,
 *    `3 of 12` the moment a filter or a search narrows it. The chips that did
 *    the narrowing sit in the same row, so the number states their effect
 *    rather than leaving the reader to notice it.
 *
 *  • **Live work is aggregated.** Per-card rings say "something is happening
 *    HERE"; nothing on the board said "two agents are producing and one is
 *    blocked on you". The sidebar's Active band does, and that panel can be
 *    unpinned or hidden — this is the orchestrator's own question on the
 *    orchestrator's own page.
 *
 * THE LIVE HALF IGNORES THE FILTER, deliberately. A filter is a lens on the
 * list, not on what the project is doing, and the one reading nobody can afford
 * to lose behind a chip is "an agent is waiting for you". Counting only what
 * survived the filter would hide exactly that, and hide it silently.
 */
import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";

export interface BoardSummary {
  /**
   * The count as it should read. `null` when there is nothing to count at all —
   * an empty board has its own empty state and needs no zero over it.
   */
  count: string | null;
  /** Tickets with an agent producing right now. `0` draws nothing. */
  working: number;
  /** Tickets with an agent blocked on a person. `0` draws nothing. */
  waiting: number;
}

export interface BoardSummaryInput {
  /** Tickets currently on screen — the filtered list. */
  visible: number;
  /** Tickets on the board before any filter or search. */
  total: number;
  /**
   * ticketId → its loudest running state, for the WHOLE board
   * (`board-session-activity.ts`). A ticket with nothing running is absent.
   */
  activityByTicket: Readonly<Record<string, TicketSessionActivity>>;
}

/** The header's reading of the board. Pure — the view only draws what this returns. */
export function boardSummary(input: BoardSummaryInput): BoardSummary {
  const states = Object.values(input.activityByTicket);
  return {
    count: countLabel(input.visible, input.total),
    working: states.filter((state) => state === "working").length,
    waiting: states.filter((state) => state === "waiting").length,
  };
}

/**
 * `12`, or `3 of 12` while a filter is narrowing the board.
 *
 * `0 of 12` is a real and useful reading — a filter that matched nothing — and
 * is why the empty case is decided on the TOTAL rather than on what is visible.
 */
function countLabel(visible: number, total: number): string | null {
  if (total === 0) return null;
  return visible === total ? String(total) : `${visible} of ${total}`;
}
