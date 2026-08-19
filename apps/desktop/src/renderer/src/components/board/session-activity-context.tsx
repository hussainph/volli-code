/**
 * The board's session-activity read, held BELOW the drag machinery.
 *
 * ── WHY THIS IS A CONTEXT AND NOT A PROP ──────────────────────────────────
 * `useBoardSessionActivity` subscribes to the sessions store, and that store is
 * the loudest one in the app: a busy terminal bumps its output stamp about once
 * a second, per session, for as long as an agent is producing. When the board
 * itself held that subscription, every one of those bumps re-rendered `Board`
 * — and `Board` renders `<DndContext>`, whose four drag handlers are fresh
 * closures on every render, so the context could never bail out. The result was
 * that dragging a card while ANY agent on that board was working re-rendered
 * dnd-kit's drag machinery from outside the drag, roughly once a second.
 *
 * dnd-kit does not survive that. Its `useRects` measures the dragged node's
 * scrollable ancestors in a synchronous layout effect and unconditionally sets
 * a fresh array of fresh `Rect` objects, so the effect firing is always another
 * render; the only brake is `useScrollableAncestors` handing back the same
 * array identity, guarded by comparing the over-node's `parentNode` against a
 * ref written in a PASSIVE effect. Under renders that arrive from outside the
 * drag, that guard loses the race, the array churns, and the layout effect
 * re-arms itself until React throws error #185 (`Maximum update depth
 * exceeded`) and takes the window with it. Each column body being its own
 * scroll container is what makes the churn real rather than theoretical: two
 * cards in different columns genuinely have different scrollable ancestors.
 *
 * So the subscription moves below the component that renders `DndContext`.
 * Everything that needs the answer — the columns, the list sections, the
 * header's summary, the drag overlay's own body — reads it from here instead.
 * `DndContext` is not a consumer, so an output bump cannot reach it, and the
 * board subtree arrives as this provider's `children` prop (built during
 * `Board`'s render, not during this one) so React bails it out wholesale while
 * still routing the new value to the consumers inside it. That is the same
 * shape, and the same reason, as `TicketDialogHost`.
 *
 * ── WHAT THIS DOES NOT CHANGE ─────────────────────────────────────────────
 * Still ONE subscription and ONE derivation for the whole board — the property
 * `hooks/use-board-session-activity.ts` was written for, and the reason a card
 * must never ask this question for itself. This only moves where that single
 * read is anchored. Cards still receive their own word as a plain string prop
 * from the column, so `TicketCard`'s `React.memo` keeps holding for every card
 * whose word did not change.
 */
import * as React from "react";

import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";
import { useBoardSessionActivity } from "@renderer/hooks/use-board-session-activity";

/**
 * The frozen answer for a board that has no provider above it — the drag
 * overlay's body rendered in a test, a card in a storybook scratch. A stable
 * identity rather than a literal, so a consumer's memo is not defeated by the
 * default either.
 */
const NO_ACTIVITY: Readonly<Record<string, TicketSessionActivity>> = {};

const BoardSessionActivityContext =
  React.createContext<Readonly<Record<string, TicketSessionActivity>>>(NO_ACTIVITY);

/** ticketId → its loudest running state; absent means nothing is running there. */
export function useBoardSessionActivityMap(): Readonly<Record<string, TicketSessionActivity>> {
  return React.useContext(BoardSessionActivityContext);
}

/**
 * One ticket's word, for the surfaces that only ever ask about one — the drag
 * overlay's body. Reading the map and indexing it here keeps those call sites
 * from having to know the map is how this is stored.
 */
export function useTicketActivity(ticketId: string): TicketSessionActivity | null {
  return useBoardSessionActivityMap()[ticketId] ?? null;
}

export function BoardSessionActivityProvider({
  projectId,
  ticketIds,
  children,
}: {
  projectId: string;
  /** The ticket ids on this board — the container keys worth walking. */
  ticketIds: ReadonlySet<string>;
  children: React.ReactNode;
}) {
  const activity = useBoardSessionActivity(projectId, ticketIds);
  return (
    <BoardSessionActivityContext.Provider value={activity}>
      {children}
    </BoardSessionActivityContext.Provider>
  );
}
