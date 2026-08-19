/**
 * The board's live read of which tickets have an agent running on them.
 *
 * One subscription for the whole board, not one per card — the same reasoning
 * that already made `ticketPrefix` and `projectLabels` props rather than
 * per-card store reads: a board shows one project, so this is one question with
 * one answer, and 150 cards each subscribing to the sessions store would make
 * every PTY byte a 150-component re-render.
 *
 * Nothing here polls. `buildBoardSessionActivity` names the one instant its own
 * answer can change without new input (a terminal's output window closing) and
 * this holds a single timer against it; chat words arrive pushed, so a board
 * with no live terminal on it never wakes at all.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";

import {
  buildBoardSessionActivity,
  type BoardSessionActivity,
  type TicketSessionActivity,
} from "@renderer/components/board/board-session-activity";
import { delayUntil } from "@renderer/lib/boundary-timer";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import type { SessionContainer } from "@renderer/stores/sessions";

const EMPTY_ACTIVITY: BoardSessionActivity = { byTicket: {}, nextBoundaryAt: null };

/**
 * Whether two derived maps say the same thing about the same tickets.
 *
 * The values are the two words, so this is a complete comparison rather than a
 * cheap approximation of one — there is nothing deeper for it to miss.
 *
 * It exists because `buildBoardSessionActivity` mints a fresh object every time
 * it runs, and it runs on every input bump — and a busy terminal bumps its
 * output stamp about once a second (`stores/sessions.ts`: "at most one
 * `lastOutputAt` write per session per second") for the whole ten seconds of
 * {@link WORKING_WINDOW_MS}. So a card that is simply STILL working produced
 * ~10 map identities that each said what the last one said, and every one of
 * them re-rendered the board. Holding the previous object when nothing moved
 * turns "an agent is producing" from a render per second into a render per
 * actual change of word.
 */
export function sameActivity(
  previous: Readonly<Record<string, TicketSessionActivity>>,
  next: Readonly<Record<string, TicketSessionActivity>>,
): boolean {
  const previousIds = Object.keys(previous);
  if (previousIds.length !== Object.keys(next).length) return false;
  return previousIds.every((ticketId) => previous[ticketId] === next[ticketId]);
}

/**
 * The output stamps THIS board's derivation can read, and no others.
 *
 * `state.lastOutputAt` is one flat map for every live session in the app,
 * replaced wholesale on each bump (about once a second per busy session), so
 * subscribing to the map itself would rebuild this board whenever any other
 * project's terminal printed a line. Projecting it down to the panes this board
 * can name, under `useShallow`, makes an irrelevant bump yield the same object.
 * The raw numbers ride through untouched — this narrows the SUBSCRIPTION, not
 * the input. `active-session-listing.ts`'s `listingOutputStamps` is the same
 * move for the sidebar; it is not reused because it also walks a project Session
 * container, which has no card on any board.
 */
function boardOutputStamps(
  lastOutputAt: Readonly<Record<string, number>>,
  containers: Readonly<Record<string, SessionContainer>>,
  ticketIds: ReadonlySet<string>,
): Record<string, number> {
  const stamps: Record<string, number> = {};
  for (const ticketId of ticketIds) {
    const container = containers[ticketId];
    if (container === undefined) continue;
    for (const tab of container.tabs) {
      for (const pane of sessionPanes(tab.layout)) {
        const at = lastOutputAt[pane.sessionId];
        if (at !== undefined) stamps[pane.sessionId] = at;
      }
    }
  }
  return stamps;
}

export function useBoardSessionActivity(
  projectId: string,
  ticketIds: ReadonlySet<string>,
): Readonly<Record<string, "working" | "waiting">> {
  const containers = useSessionsStore((state) => state.byOwner);
  const parkState = useSessionsStore((state) => state.parkState);
  const harness = useSessionsStore((state) => state.harness);
  const lastOutputAt = useSessionsStore(
    useShallow((state) => boardOutputStamps(state.lastOutputAt, state.byOwner, ticketIds)),
  );
  const chatSessions = (
    useProjectSessionsStore((state) => state.byProject[projectId]) ?? EMPTY_PROJECT_SESSION_ROWS
  ).chat;

  // The baseline the pushes are folded onto. `ensure` is at-most-once per
  // project across every surface, so the board asking for it costs nothing when
  // the sidebar has already asked — and the board is not left depending on the
  // sidebar being mounted, which is not a thing it can know.
  const ensureRows = useProjectSessionsStore((state) => state.ensure);
  React.useEffect(() => {
    void ensureRows(projectId);
  }, [projectId, ensureRows]);

  // The clock the derivation is read against. It advances only when the model
  // says its own answer moves, so between boundaries it is deliberately behind
  // the wall clock and the board is deliberately not rebuilt for the difference.
  const [now, setNow] = React.useState(() => Date.now());

  const activity = React.useMemo(
    () =>
      ticketIds.size === 0
        ? EMPTY_ACTIVITY
        : buildBoardSessionActivity({
            ticketIds,
            containers,
            lastOutputAt,
            parkState,
            harness,
            chatSessions,
            now,
          }),
    [ticketIds, containers, lastOutputAt, parkState, harness, chatSessions, now],
  );

  const nextBoundaryAt = activity.nextBoundaryAt;
  React.useEffect(() => {
    if (nextBoundaryAt === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delayUntil(nextBoundaryAt));
    return () => window.clearTimeout(timer);
  }, [nextBoundaryAt]);

  // The identity the board actually sees, held across every rebuild that
  // changed nothing. The ref is a memo cache, not state — the same shape, and
  // the same justification, as `previousSorted` in `board.tsx`: writing it
  // during render is idempotent, and a value cached by a render React later
  // discards is still key-for-key equal to what the next build would produce,
  // so reuse can only ever hand back a correct map, never a stale one.
  const stable = React.useRef(activity.byTicket);
  if (!sameActivity(stable.current, activity.byTicket)) {
    stable.current = activity.byTicket;
  }
  return stable.current;
}
