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
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { resolveDrop, ticketPosition } from "@renderer/components/board/board-dnd";
import { BoardColumn } from "@renderer/components/board/board-column";
import { BoardHeader } from "@renderer/components/board/board-header";
import { BoardListView, TicketRowContent } from "@renderer/components/board/board-list-view";
import { CollapsedColumnRail } from "@renderer/components/board/collapsed-column-rail";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
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

// Stable fallback for projects with no ticket record yet — an inline `?? []`
// would mint a fresh array identity every render and defeat the memos below.
// Never mutated (every board op is pure); typed mutable to match the store.
const EMPTY_TICKETS: Ticket[] = [];

/** The kanban board: columns scroll vertically, the canvas scrolls horizontally. */
export function Board({ projectId, ticketPrefix }: { projectId: string; ticketPrefix: string }) {
  const storeTickets = useBoardStore((state) => state.ticketsByProject[projectId]) ?? EMPTY_TICKETS;
  const filter = useBoardStore((state) => state.filterByProject[projectId]) ?? EMPTY_TICKET_FILTER;
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
      // search pill, an open context menu — is that control's dismissal, not a
      // board deselect; it still bubbles to window, so filter it out here.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, [contenteditable], [role=menu], [role=dialog]") !== null
      ) {
        return;
      }
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
  // previously each re-sorted per render).
  const sortedGroups = React.useMemo(() => {
    const sorted = {} as Record<TicketStatus, Ticket[]>;
    for (const status of TICKET_STATUSES) {
      sorted[status] = sortTickets(groups[status], boardSort);
    }
    return sorted;
  }, [groups, boardSort]);
  const hidden =
    drag?.hiddenAtStart ??
    // Derived straight from `groups` — the shared `emptyStatuses` helper would
    // group (and sort) the same array a second time.
    TICKET_STATUSES.filter(
      (status) => groups[status].length === 0 && status !== expandedEmptyStatus,
    );
  const shown = TICKET_STATUSES.filter((status) => !hidden.includes(status));

  const handleSelect = React.useCallback(
    (ticketId: string | null) => selectTicket(projectId, ticketId),
    [selectTicket, projectId],
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
            groups={sortedGroups}
            shownStatuses={shown}
            emptyDropStatuses={drag ? hidden : []}
            dragActive={drag !== null}
            selectedId={selectedId}
            onSelect={handleSelect}
            onOpen={handleOpen}
          />
        ) : (
          <div
            className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-4"
            onClick={(event) => {
              if (event.target === event.currentTarget) handleSelect(null);
            }}
          >
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
                selectedId={selectedId}
                onSelect={handleSelect}
                onOpen={handleOpen}
                composerInitiallyOpen={expandedEmptyStatus === status}
                onComposerClose={handleComposerClose}
                animateEnter={boardMounted.current}
              />
            ))}
            <CollapsedColumnRail
              statuses={hidden}
              dragActive={drag !== null}
              onExpand={setExpandedEmptyStatus}
              animateEnter={boardMounted.current}
            />
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
              <div className="cursor-grabbing overflow-hidden rounded-md bg-card shadow-lg shadow-black/40">
                <TicketRowContent ticket={drag.ticket} ticketPrefix={ticketPrefix} />
              </div>
            ) : (
              <div className="scale-[1.03] cursor-grabbing rounded-lg shadow-lg shadow-black/40">
                <TicketCardContent ticket={drag.ticket} ticketPrefix={ticketPrefix} />
              </div>
            )
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
