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
 * ── THE THREE WORDS ───────────────────────────────────────────────────────
 * `working` is an agent producing right now; `waiting` is one blocked on a
 * person; `live` is a Run's Session with an executor bound between the two.
 * Nothing else lights a card: `parked`/`exited` are not running at all, and a
 * plain `idle` Session is one that merely EXISTS, which is true of most cards
 * in Doing and would make the signal mean nothing.
 *
 * WAITING OUTRANKS WORKING, which is main's own precedence for a single chat
 * (`chatActivity` in `session-control/chat-attachment.ts`) applied to a ticket:
 * an agent that has asked a question is still inside an open turn, and a card
 * that said "working" there would hide the one thing the user could act on. A
 * ticket with one Session blocked and another producing is a ticket that needs
 * a person, and that is what the card says. `live` ranks below both, so it can
 * only ever light a card nothing louder had already lit.
 *
 * ── WHY `live` EXISTS, AND WHY ONLY FOR A RUN ─────────────────────────────
 * VC-112 asks the board card for "a live ring while the Run's Session is
 * live", and the emphasis is the point: **the ring means live, not finishing.**
 * A Run is unattended by construction — nobody is sitting in that chat — so the
 * card is the only place its existence is visible, and it must hold the ring
 * for as long as this process still holds its EXECUTOR BINDING rather than
 * dropping it the moment the agent stops producing between turns. A person
 * watching a card go dark would read a Run whose executor is still holding a
 * worktree as one that had finished. The durable attachment may remain open
 * across relaunch for lazy rehydration; without a process binding it is not live.
 *
 * It is scoped to a Run's Session for exactly the reason the paragraph above
 * refuses `idle`: every card in Doing has an idle Session on it, and a ring on
 * all of them is a ring on none. Provenance (VC-131) is what makes the narrow
 * version expressible — before it, this module could not tell a Run's Session
 * apart from the one a person left open, so it had to refuse both.
 *
 * A Run's Session that has been STOPPED is deliberately not live: the stop fact
 * is main's newer truth about that Session (VC-86), and a ring over work
 * somebody ended is the "finishing" reading this word exists to refuse.
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
import { drawsSessionProvenanceMark, sessionProvenanceOf } from "@volli/shared";
import type {
  ChatSessionRecord,
  SessionActivityState,
  SessionHarnessState,
  SessionProvenance,
} from "@volli/shared";

/** What a card can say. A ticket with nothing running is simply absent from the map. */
export type TicketSessionActivity = "working" | "waiting" | "live";

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
  /**
   * Who started each Session, keyed by Session id and sparse — the same map the
   * sidebar reads (`stores/project-sessions.ts`). A miss is the resting case,
   * so a board built without it lights no `live` ring at all, which is the
   * board this module drew before the word existed.
   */
  provenance?: Readonly<Record<string, SessionProvenance>>;
  now: number;
}

const EMPTY: BoardSessionActivity = { byTicket: {}, nextBoundaryAt: null };
const NO_PROVENANCE: Readonly<Record<string, SessionProvenance>> = {};

/** `waiting` beats `working` beats `live` beats nothing — see the module doc. */
const LOUDNESS: Record<TicketSessionActivity, number> = { waiting: 0, working: 1, live: 2 };

function louder(
  current: TicketSessionActivity | undefined,
  next: TicketSessionActivity | undefined,
): TicketSessionActivity | undefined {
  if (next === undefined) return current;
  if (current === undefined) return next;
  return LOUDNESS[next] < LOUDNESS[current] ? next : current;
}

/** What one Session's own state says, or `undefined` when it says nothing. */
function cardWord(state: SessionActivityState): TicketSessionActivity | undefined {
  if (state === "waiting") return "waiting";
  if (state === "working") return "working";
  return undefined;
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

  const mark = (ticketId: string, word: TicketSessionActivity | undefined): void => {
    const next = louder(byTicket[ticketId], word);
    if (next !== undefined) byTicket[ticketId] = next;
  };
  const provenance = input.provenance ?? NO_PROVENANCE;

  for (const ticketId of input.ticketIds) {
    const container = input.containers[ticketId];
    if (container === undefined) continue;
    for (const tab of container.tabs) {
      for (const pane of sessionPanes(tab.layout)) {
        const lastOutput = input.lastOutputAt[pane.sessionId] ?? null;
        mark(
          ticketId,
          cardWord(
            sessionActivityState(
              lastOutput,
              pane.exitCode !== null,
              input.now,
              input.parkState[pane.sessionId]?.parked ?? false,
              input.harness[pane.sessionId]?.declared ?? null,
            ),
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
    const word = cardWord(record.activity);
    // A Run's Session whose executor is bound but between turns. `record.live`
    // is main's process-local answer about the BINDING rather than about the
    // turn, which makes this "live" instead of "still producing"; `activity`
    // is consulted only to keep a stopped Session out (see the module doc).
    mark(
      record.ticketId,
      word ??
        (record.live &&
        record.activity !== "stopped" &&
        drawsSessionProvenanceMark(sessionProvenanceOf(provenance, record.sessionId))
          ? "live"
          : undefined),
    );
  }

  return Object.keys(byTicket).length === 0 && nextBoundaryAt === null
    ? EMPTY
    : { byTicket, nextBoundaryAt };
}
