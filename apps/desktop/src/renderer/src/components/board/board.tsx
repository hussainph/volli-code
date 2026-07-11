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
  emptyStatuses,
  EMPTY_TICKET_FILTER,
  filterTickets,
  groupTicketsByStatus,
  moveTicket,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { resolveDrop, ticketPosition } from "@renderer/components/board/board-dnd";
import { BoardColumn } from "@renderer/components/board/board-column";
import { BoardHeader } from "@renderer/components/board/board-header";
import { CollapsedColumnRail } from "@renderer/components/board/collapsed-column-rail";
import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useBoardStore } from "@renderer/stores/board";

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

/** The kanban board: columns scroll vertically, the canvas scrolls horizontally. */
export function Board({ projectId, ticketPrefix }: { projectId: string; ticketPrefix: string }) {
  const storeTickets = useBoardStore((state) => state.ticketsByProject[projectId]) ?? [];
  const filter = useBoardStore((state) => state.filterByProject[projectId]) ?? EMPTY_TICKET_FILTER;
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
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
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

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
  const visible = filterTickets(tickets, filter);

  const groups = groupTicketsByStatus(visible);
  const hidden =
    drag?.hiddenAtStart ??
    emptyStatuses(visible).filter((status) => status !== expandedEmptyStatus);
  const shown = TICKET_STATUSES.filter((status) => !hidden.includes(status));

  function handleDragStart({ active }: DragStartEvent) {
    const ticket = storeTickets.find((candidate) => candidate.id === String(active.id));
    if (!ticket) return;
    setSelectedId(null);
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

  function handleDragEnd({ active }: DragEndEvent) {
    if (drag) {
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
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollision}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelectedId(null);
          }}
        >
          {shown.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tickets={groups[status]}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              selectedId={selectedId}
              onSelect={setSelectedId}
              composerInitiallyOpen={expandedEmptyStatus === status}
              onComposerClose={() =>
                setExpandedEmptyStatus((current) => (current === status ? null : current))
              }
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
        <DragOverlay
          dropAnimation={
            reducedMotion ? null : { duration: 200, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
          }
        >
          {drag ? (
            <div className="scale-[1.03] cursor-grabbing rounded-lg shadow-lg shadow-black/40">
              <TicketCardContent ticket={drag.ticket} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
