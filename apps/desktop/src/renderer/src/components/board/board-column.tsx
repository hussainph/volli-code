import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TICKET_STATUS_LABELS, type Ticket, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { TicketCard } from "@renderer/components/board/ticket-card";
import { useTicketComposer } from "@renderer/components/board/use-ticket-composer";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";

interface BoardColumnProps {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  /** The board's owning project's ticket prefix — constant for the whole board tree. */
  ticketPrefix: string;
  selectedId: string | null;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
  composerInitiallyOpen: boolean;
  onComposerClose(status: TicketStatus): void;
  /** Play the enter transition — true for columns appearing on an already-mounted board. */
  animateEnter: boolean;
}

/** A single status column: header, its own vertically-scrolling ticket list, and an add-card composer. */
export function BoardColumn({
  status,
  tickets,
  projectId,
  ticketPrefix,
  selectedId,
  onSelect,
  onOpen,
  composerInitiallyOpen,
  onComposerClose,
  animateEnter,
}: BoardColumnProps) {
  // The body is the column's droppable so cards can be dropped onto the empty
  // space below the list (or into a column emptied mid-drag).
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  const composer = useTicketComposer({
    projectId,
    status,
    initiallyOpen: composerInitiallyOpen,
    onClose: () => onComposerClose(status),
  });

  return (
    <div
      className={cn(
        "flex min-h-0 max-h-full w-72 flex-none flex-col rounded-lg bg-muted/40",
        // Layout snaps (no width tween — transform/opacity only); the newly
        // expanded column plays a short ease-out enter instead.
        animateEnter &&
          "transition-[opacity,transform] duration-200 ease-out starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100",
      )}
    >
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
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              selected={ticket.id === selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      </SortableContext>
      {composer.open ? (
        <div className="mx-2 mb-2 rounded-lg border border-border bg-card px-3 py-2.5">
          <input
            ref={composer.inputRef}
            autoFocus
            value={composer.title}
            onChange={(event) => composer.setTitle(event.target.value)}
            onKeyDown={composer.handleKeyDown}
            onBlur={composer.handleBlur}
            placeholder="Ticket title…"
            className="w-full border-none bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={composer.openComposer}
          className="mx-2 mb-2 h-7 justify-start gap-1.5 text-xs text-muted-foreground"
        >
          <PlusIcon className="size-3.5" />
          New
        </Button>
      )}
    </div>
  );
}
