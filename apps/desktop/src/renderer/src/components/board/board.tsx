import * as React from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  EMPTY_TICKET_FILTER,
  filterTickets,
  groupTicketsByStatus,
  moveTicket,
  sortTickets,
  TICKET_STATUSES,
  type Label,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { resolveDrop, ticketPosition } from "@renderer/components/board/board-dnd";
import { BoardColumn } from "@renderer/components/board/board-column";
import { BoardEmpty } from "@renderer/components/board/board-empty";
import { BoardHeader } from "@renderer/components/board/board-header";
import { BoardListView, TicketRowContent } from "@renderer/components/board/board-list-view";
import { CollapsedColumnRail } from "@renderer/components/board/collapsed-column-rail";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { TicketDialogHost } from "@renderer/components/board/ticket-dialog-host";
import { useBoardCanvasPan } from "@renderer/hooks/use-board-canvas-pan";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { isEscapeExempt } from "@renderer/lib/escape-guard";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

/**
 * Everything alive only while a card is mid-drag. The preview is a local
 * snapshot the drag mutates (via the shared moveTicket op) so the store —
 * and its localStorage persist — is written exactly once, on drop; cancel
 * simply discards the snapshot. The hidden set is frozen at drag start so
 * columns never collapse or expand under the pointer.
 */
interface DragState {
  ticket: Ticket;
  preview: Ticket[];
  hiddenAtStart: TicketStatus[];
}

// Precise pointer hits first (narrow collapsed pills, tall columns), corner
// proximity as the fallback for fast flicks where the pointer sits between
// rects — dnd-kit's own multi-container recipe.
const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCorners(args);
};

// Stable fallbacks for a project with no ticket/label record yet — an inline
// `?? []` would mint a fresh array identity every render and defeat the memos
// below. Never mutated (every board op is pure); `EMPTY_TICKETS` is typed
// mutable to match the store's slice type.
const EMPTY_TICKETS: Ticket[] = [];
const EMPTY_LABELS: readonly Label[] = [];
const NO_STATUSES: readonly TicketStatus[] = [];

/**
 * Whether two already-sorted columns hold exactly the same tickets in the same
 * order. Identity per element, never deep: every board op is pure and
 * `moveTicket` re-emits an untouched column's tickets BY REFERENCE, so an
 * unchanged ticket is the same object and a `!==` here is a real change.
 */
function sameColumn(previous: readonly Ticket[], next: readonly Ticket[]): boolean {
  return previous.length === next.length && previous.every((ticket, i) => ticket === next[i]);
}

/**
 * The kanban board: columns scroll vertically; the canvas pans horizontally.
 *
 * Memoized, and the two string props are why it can be: the board is the largest
 * subtree in the window and it hangs under `AppShell`, which re-renders on app
 * chrome state — including `sidebarWidth`, written on every pointermove of the
 * resize grip. Memo blocks parent-driven renders only, never a hook's own
 * update, so the board's store subscriptions behave exactly as before.
 *
 * Honest about what this does NOT buy: profiling a 150-ticket board during a
 * sidebar drag showed the per-card `React.memo`s were ALREADY holding — the
 * cards themselves did not re-render either way. What scaled with ticket count
 * was the Radix machinery under each card, and the dialog half of that is gone
 * (see `TicketDialogHost`); the context menu each card must keep is the rest.
 * This is a cheap correct boundary, not the fix for either.
 */
export const Board = React.memo(function Board({
  projectId,
  ticketPrefix,
}: {
  projectId: string;
  ticketPrefix: string;
}) {
  const storeTickets = useBoardStore((state) => state.ticketsByProject[projectId]) ?? EMPTY_TICKETS;
  const filter = useBoardStore((state) => state.filterByProject[projectId]) ?? EMPTY_TICKET_FILTER;
  // One store subscription for the whole board rather than one per visible card
  // — the same reasoning that already made `ticketPrefix` a prop: a board only
  // ever shows one project, so its label rows are constant for the whole tree
  // and every card was subscribing to the identical slice.
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]) ?? EMPTY_LABELS;
  // View mode and sort are per-workspace, session-only (same pattern as
  // use-active-nav.ts): fall back to the shared default for never-visited projects.
  const boardView = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardView ?? DEFAULT_WORKSPACE_UI.boardView,
  );
  const boardSort = useWorkspaceStore(
    (state) => state.byProject[projectId]?.boardSort ?? DEFAULT_WORKSPACE_UI.boardSort,
  );
  const [drag, setDrag] = React.useState<DragState | null>(null);
  // Selection is store-backed (session-only), not component state, so other
  // surfaces — the sidebar's Active Sessions — can select a card and have the
  // board reflect it. Board behavior is unchanged from the useState version.
  const selectedId = useBoardStore((state) => state.selectedByProject[projectId] ?? null);
  const selectTicket = useBoardStore((state) => state.selectTicket);
  const [expandedEmptyStatus, setExpandedEmptyStatus] = React.useState<TicketStatus | null>(null);
  const reducedMotion = useReducedMotion();

  // Columns and pills only play their enter transition when they appear on an
  // ALREADY-mounted board (a drop expanded a column, a filter emptied one).
  // Opening the board page — a many-times-a-day action — stays instant.
  const boardMounted = React.useRef(false);
  React.useEffect(() => {
    boardMounted.current = true;
  }, []);

  React.useEffect(() => {
    if (selectedId === null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An Escape aimed at a focused control — the add-card composer, the ⌘K
      // search pill, an open context menu/dialog — is that control's dismissal,
      // not a board deselect; it still bubbles to window, so filter it out here.
      if (isEscapeExempt(event.target)) return;
      selectTicket(projectId, null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId, projectId, selectTicket]);

  // distance: 4 keeps plain clicks (selection, context menu) working — the
  // drag only activates after real pointer travel. Keyboard drags come free
  // with the sortable coordinate getter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tickets = drag?.preview ?? storeTickets;
  // `tickets` may be the drag preview snapshot — filtering it is correct and
  // expected here; `filterTickets` returns the same reference when inactive.
  // The whole derived pipeline is memoized: the board re-renders on every
  // drag-over event and on selection changes, and none of those should re-run
  // a filter pass plus five column sorts.
  const visible = React.useMemo(
    () => filterTickets(tickets, filter, ticketPrefix),
    [tickets, filter, ticketPrefix],
  );
  const groups = React.useMemo(() => groupTicketsByStatus(visible), [visible]);
  // One sort pass shared by BOTH views (the columns and the list sections
  // previously each re-sorted per render) — and one array identity per status
  // held across it. `sortTickets` calls `toSorted`, so it hands back a fresh
  // array every time even when nothing moved; a drag that only ever touches two
  // columns was re-sorting all five on every preview change. Reusing the
  // previous array whenever the sort produced the same tickets in the same
  // order takes that to only the columns that changed.
  //
  // Honest about what this does NOT buy, measured in the lab's board scratch
  // (13 cards, one cross-column mouse drag of 24 pointer steps, under
  // StrictMode so halve the raw counts): it removed 80% of the sorted arrays
  // (270 → 54) and 60% of the downstream
  // `sortableIds` recomputes (270 → 108), and moved the card re-render count by
  // exactly ZERO. `TicketCard`'s `React.memo` was already holding for every
  // untouched column, and the `SortableContext` invalidation this avoids never
  // reached the memo — it reaches `SortableTicketShell` inside it, which
  // re-renders on dnd-kit's own context (`over`, `droppableRects`) on every
  // pointermove regardless of what we do out here. This is a real CPU saving on
  // the sort, not a fix for the drag's re-render volume; that one lives in
  // dnd-kit.
  //
  // The ref is a memo cache, not state. Writing it during render is idempotent
  // (a StrictMode double-invoke compares against its own first pass and reuses
  // it), and a value cached by a render React later discards is still
  // element-wise identical to what the next sort would produce — reuse can only
  // ever hand back a correct array, never a stale one.
  const previousSorted = React.useRef<Record<TicketStatus, Ticket[]> | null>(null);
  const sortedGroups = React.useMemo(() => {
    const previous = previousSorted.current;
    const sorted = {} as Record<TicketStatus, Ticket[]>;
    for (const status of TICKET_STATUSES) {
      const next = sortTickets(groups[status], boardSort);
      const before = previous?.[status];
      sorted[status] = before !== undefined && sameColumn(before, next) ? before : next;
    }
    previousSorted.current = sorted;
    return sorted;
  }, [groups, boardSort]);
  // Memoized for the same reason the sorted groups are: both are props, and a
  // fresh array on every drag-over defeats the children's memos. `hidden`
  // keeps its identity ACROSS drag start too — the drag freezes the very array
  // this returned on the previous render.
  const hidden = React.useMemo(
    () =>
      drag?.hiddenAtStart ??
      // Derived straight from `groups` — a separate helper would group (and
      // sort) the same array a second time.
      TICKET_STATUSES.filter(
        (status) => groups[status].length === 0 && status !== expandedEmptyStatus,
      ),
    [drag, groups, expandedEmptyStatus],
  );
  const shown = React.useMemo(
    () => TICKET_STATUSES.filter((status) => !hidden.includes(status)),
    [hidden],
  );
  // The list view's slim drop rows exist only during a drag; outside one this
  // is the frozen empty array rather than a fresh `[]` per render.
  const emptyDropStatuses = drag ? hidden : NO_STATUSES;
  // A board with nothing on it, which is not the same as a filter matching
  // nothing: this reads the PROJECT's tickets, so a filter that hides them all
  // still leaves the columns (and the collapsed rail) standing. See BoardEmpty.
  const boardEmpty = storeTickets.length === 0;

  const handleSelect = React.useCallback(
    (ticketId: string | null) => selectTicket(projectId, ticketId),
    [selectTicket, projectId],
  );
  // Click empty canvas to clear selection — pan-aware (a drag past slop is not
  // a click). Lives next to handleSelect so the deselect closure stays stable.
  const handleCanvasBackgroundClick = React.useCallback(() => handleSelect(null), [handleSelect]);
  const { panning, canvasRef, canvasProps } = useBoardCanvasPan(
    handleCanvasBackgroundClick,
    boardView === "board",
  );
  // Double-click open (ticket-detail-mvp step 3): `openTicket` is a stable
  // zustand action reference, same stability contract as `selectTicket` above.
  const openTicket = useWorkspaceStore((state) => state.openTicket);
  const handleOpen = React.useCallback(
    (ticketId: string) => openTicket(projectId, ticketId),
    [openTicket, projectId],
  );
  // Stable (the column passes its own status back) so columns aren't handed a
  // fresh closure every board render.
  const handleComposerClose = React.useCallback(
    (status: TicketStatus) =>
      setExpandedEmptyStatus((current) => (current === status ? null : current)),
    [],
  );

  function handleDragStart({ active }: DragStartEvent) {
    const ticket = storeTickets.find((candidate) => candidate.id === String(active.id));
    if (!ticket) return;
    selectTicket(projectId, null);
    setExpandedEmptyStatus(null);
    setDrag({ ticket, preview: storeTickets, hiddenAtStart: hidden });
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    setDrag((current) => {
      if (!current) return current;
      const target = resolveDrop(current.preview, activeId, overId);
      if (!target) return current;
      const next = moveTicket(
        current.preview,
        activeId,
        target.toStatus,
        target.toIndex,
        Date.now(),
      );
      return next === current.preview ? current : { ...current, preview: next };
    });
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    // Released over no droppable at all → treat as a cancel, not a commit of
    // whatever the last hovered preview position happened to be. (Rare with
    // the closestCorners fallback, but a stray status change is consequential
    // once Doing boots an agent.)
    if (drag && over !== null) {
      const finalPosition = ticketPosition(drag.preview, String(active.id));
      if (finalPosition) {
        useBoardStore
          .getState()
          .moveTicket(projectId, String(active.id), finalPosition.toStatus, finalPosition.toIndex);
      }
    }
    setDrag(null);
  }

  function handleDragCancel() {
    setDrag(null);
  }

  return (
    // Every card's context menu asks this host — not itself — to open the
    // archive and remove-worktree confirms, so the board carries one of each
    // instead of one per card. The whole board is its `children` prop, which is
    // what lets an open dialog re-render the host alone.
    <TicketDialogHost projectId={projectId}>
      <div className="flex min-h-0 flex-1 flex-col">
        <BoardHeader
          projectId={projectId}
          ticketCount={visible.length}
          tickets={storeTickets}
          filter={filter}
        />
        {/* One DndContext drives BOTH views — same handlers, same preview/commit
            machinery, same ticket id space. The view branch lives inside it so the
            list view has full drag parity with the board; only the layout and the
            drag overlay's shape differ. Escape-clears-selection (above) is shared. */}
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {boardView === "list" ? (
            // Same grouped/filtered set, sort, and selection as the board. `shown`
            // and `hidden` are the board's own frozen-during-drag topology reused:
            // shown → full sections; hidden (empty-at-start) → slim drop rows,
            // rendered only while dragging so a row can land in any status.
            <BoardListView
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              projectLabels={projectLabels}
              groups={sortedGroups}
              shownStatuses={shown}
              emptyDropStatuses={emptyDropStatuses}
              boardEmpty={boardEmpty}
              dragActive={drag !== null}
              selectedId={selectedId}
              onSelect={handleSelect}
              onOpen={handleOpen}
            />
          ) : (
            <div
              ref={canvasRef}
              {...canvasProps}
              className={cn(
                // Columns cap below full height so a strip of canvas stays
                // grab-able under them (Trello-style mouse pan). Scrollbar is
                // hidden — drag / shift-wheel / trackpad replace it.
                "flex min-h-0 flex-1 items-start gap-4 overflow-x-auto px-gutter pb-4",
                "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                panning ? "cursor-grabbing select-none" : "cursor-grab",
              )}
            >
              {boardEmpty ? <BoardEmpty className="min-h-0 flex-1 self-stretch" /> : null}
              {shown.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  // Display order is sort-driven: `sortedGroups` reorders each
                  // column for rendering. Drag mechanics stay unchanged — a drop
                  // still writes the manual `order` (see handleDragEnd), but under
                  // a non-manual sort the displayed position is sort-driven, so the
                  // card snaps to its sorted slot after the drop (Linear behaves the
                  // same). "manual" remains the true drag-reorder mode.
                  tickets={sortedGroups[status]}
                  projectId={projectId}
                  ticketPrefix={ticketPrefix}
                  projectLabels={projectLabels}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                  onOpen={handleOpen}
                  composerInitiallyOpen={expandedEmptyStatus === status}
                  onComposerClose={handleComposerClose}
                  animateEnter={boardMounted.current}
                />
              ))}
              {boardEmpty ? null : (
                <CollapsedColumnRail
                  statuses={hidden}
                  dragActive={drag !== null}
                  onExpand={setExpandedEmptyStatus}
                  animateEnter={boardMounted.current}
                />
              )}
            </div>
          )}
          <DragOverlay
            dropAnimation={
              reducedMotion ? null : { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
            }
          >
            {drag ? (
              boardView === "list" ? (
                // Row-shaped overlay sized to the active row by dnd-kit; a lifted
                // surface (bg + shadow) instead of the card's scale-up.
                //
                // `--shadow-card` rather than a black alpha: the elevation set is
                // solved per mode (a near-black in dark, a warm brown against the
                // light canvas), and a card being dragged is a card — the same
                // tier the board's cards already sit at, one step further off.
                <div className="cursor-grabbing overflow-hidden rounded-md bg-card shadow-card">
                  <TicketRowContent
                    ticket={drag.ticket}
                    ticketPrefix={ticketPrefix}
                    projectLabels={projectLabels}
                  />
                </div>
              ) : (
                <div className="scale-[1.03] cursor-grabbing rounded-lg shadow-card">
                  <TicketCardContent
                    ticket={drag.ticket}
                    ticketPrefix={ticketPrefix}
                    projectLabels={projectLabels}
                  />
                </div>
              )
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </TicketDialogHost>
  );
});
