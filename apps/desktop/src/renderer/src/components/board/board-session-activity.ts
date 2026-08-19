/**
 * Which tickets on a board have an agent running on them, and when that answer
 * next changes on its own.
 *
 * The board's answer to the question the sidebar's Active band answers one row
 * at a time: a card should be able to say "something is happening here" without
 * the user going to the navigator and reading it Session by Session. So this is
 * deliberately COARSER than `active-session-listing.ts` — it does not order
 * anything, does not care which Session, and collapses a ticket's whole roster
 * into one word.
 *
 * ── THE TWO WORDS ─────────────────────────────────────────────────────────
 * `working` is an agent producing right now; `waiting` is one blocked on a
 * person. Nothing else lights a card: `idle` is a Session that exists, which is
 * true of most cards in Doing and would make the signal mean nothing, and
 * `parked`/`exited` are not running at all.
 *
 * WAITING OUTRANKS WORKING, which is main's own precedence for a single chat
 * (`chatActivity` in `session-control/chat-attachment.ts`) applied to a ticket:
 * an agent that has asked a question is still inside an open turn, and a card
 * that said "working" there would hide the one thing the user could act on. A
 * ticket with one Session blocked and another producing is a ticket that needs
 * a person, and that is what the card says.
 *
 * ── THE TWO SOURCES ───────────────────────────────────────────────────────
 * Terminal panes are read from the live sessions store, through the same
 * `sessionActivityState` every other surface derives a pane's word from — its
 * output-recency window, the harness's own declared state, and the park tier,
 * in that precedence. Chat Sessions are read from the pushed project listing,
 * which carries main's own `activity` and needs no derivation here at all.
 *
 * ── THE CLOCK ─────────────────────────────────────────────────────────────
 * A terminal's `working` decays on its own once its output window closes, so
 * {@link BoardSessionActivity.nextBoundaryAt} is the first instant this answer
 * could differ with no new input, exactly as the sidebar listing's is. Without
 * it a card would keep glowing until something unrelated happened to re-render
 * the board.
 */
import { WORKING_WINDOW_MS } from "@renderer/stores/sessions";
import { sessionActivityState, sessionPanes } from "@renderer/stores/sessions";
import type { SessionContainer } from "@renderer/stores/sessions";
import type { ChatSessionRecord, SessionActivityState, SessionHarnessState } from "@volli/shared";

/** What a card can say. A ticket with nothing running is simply absent from the map. */
export type TicketSessionActivity = "working" | "waiting";

export interface BoardSessionActivity {
  /** ticketId → its loudest running state. Absent means nothing is running there. */
  byTicket: Readonly<Record<string, TicketSessionActivity>>;
  /**
   * Epoch ms of the next instant this answer changes with no new input — a
   * terminal's output window closing. `null` when nothing here depends on the
   * clock, which is the common case: every chat word is pushed, and a board
   * with no live terminal on it never needs waking.
   */
  nextBoundaryAt: number | null;
}

export interface BuildBoardSessionActivityInput {
  /** The ticket ids on this board \u2014 the container keys worth walking. */
  ticketIds: Iterable<string>;
  /** The sessions store's containers, keyed by owner id. */
  containers: Readonly<Record<string, SessionContainer>>;
  lastOutputAt: Readonly<Record<string, number>>;
  parkState: Readonly<Record<string, { parked: boolean; keepAwake: boolean }>>;
  harness: Readonly<Record<string, SessionHarnessState>>;
  /** This project's chat Sessions, as the pushed listing holds them. */
  chatSessions: readonly ChatSessionRecord[];
  now: number;
}

const EMPTY: BoardSessionActivity = { byTicket: {}, nextBoundaryAt: null };

/** `waiting` beats `working` beats nothing — see the module doc. */
function louder(
  current: TicketSessionActivity | undefined,
  next: SessionActivityState,
): TicketSessionActivity | undefined {
  if (next === "waiting") return "waiting";
  if (next === "working") return current === "waiting" ? "waiting" : "working";
  return current;
}

export function buildBoardSessionActivity(
  input: BuildBoardSessionActivityInput,
): BoardSessionActivity {
  const byTicket: Record<string, TicketSessionActivity> = {};
  let nextBoundaryAt: number | null = null;
  const considerBoundary = (at: number): void => {
    if (at <= input.now) return;
    if (nextBoundaryAt === null || at < nextBoundaryAt) nextBoundaryAt = at;
  };

  const mark = (ticketId: string, state: SessionActivityState): void => {
    const next = louder(byTicket[ticketId], state);
    if (next !== undefined) byTicket[ticketId] = next;
  };

  for (const ticketId of input.ticketIds) {
    const container = input.containers[ticketId];
    if (container === undefined) continue;
    for (const tab of container.tabs) {
      for (const pane of sessionPanes(tab.layout)) {
        const lastOutput = input.lastOutputAt[pane.sessionId] ?? null;
        mark(
          ticketId,
          sessionActivityState(
            lastOutput,
            pane.exitCode !== null,
            input.now,
            input.parkState[pane.sessionId]?.parked ?? false,
            input.harness[pane.sessionId]?.declared ?? null,
          ),
        );
        // +1 because the window is inclusive (`<=`), so the first instant the
        // derivation differs is one millisecond past its end. Reported for
        // every dated pane rather than only for the ones currently `working`:
        // a pane whose park or declared state currently outranks recency can
        // lose that override without this board hearing about it, and a
        // boundary that changes nothing costs one recompute that finds nothing.
        if (lastOutput !== null) considerBoundary(lastOutput + WORKING_WINDOW_MS + 1);
      }
    }
  }

  for (const record of input.chatSessions) {
    // A ticketless chat is a project Project Session; it has no card to light.
    if (record.ticketId === null) continue;
    mark(record.ticketId, record.activity);
  }

  return Object.keys(byTicket).length === 0 && nextBoundaryAt === null
    ? EMPTY
    : { byTicket, nextBoundaryAt };
}
