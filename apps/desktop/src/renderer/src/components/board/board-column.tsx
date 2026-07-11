import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TICKET_STATUS_LABELS, type Ticket, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { TicketCard } from "@renderer/components/board/ticket-card";

/** A single status column: header + its own vertically-scrolling ticket list. */
export function BoardColumn({ status, tickets }: { status: TicketStatus; tickets: Ticket[] }) {
  // The body is the column's droppable so cards can be dropped onto the empty
  // space below the list (or into a column emptied mid-drag).
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });

  return (
    <div className="flex min-h-0 max-h-full w-72 flex-none flex-col rounded-lg bg-muted/40">
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-[13px] font-medium text-foreground">
          {TICKET_STATUS_LABELS[status]}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{tickets.length}</span>
      </div>
      <SortableContext
        items={tickets.map((ticket) => ticket.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
        >
          {tickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
