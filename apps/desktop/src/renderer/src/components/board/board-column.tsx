import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TICKET_STATUS_LABELS, type Ticket, type TicketStatus } from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { TicketCard } from "@renderer/components/board/ticket-card";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

interface BoardColumnProps {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  ticketPrefix: string;
  selectedId: string | null;
  onSelect(ticketId: string): void;
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
  animateEnter,
}: BoardColumnProps) {
  // The body is the column's droppable so cards can be dropped onto the empty
  // space below the list (or into a column emptied mid-drag).
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (composerOpen) inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [composerOpen]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const trimmed = title.trim();
      if (trimmed === "") return;
      useBoardStore.getState().addTicket(projectId, ticketPrefix, status, trimmed);
      setTitle("");
    } else if (event.key === "Escape") {
      setTitle("");
      setComposerOpen(false);
    }
  }

  function handleBlur() {
    const trimmed = title.trim();
    if (trimmed !== "") {
      useBoardStore.getState().addTicket(projectId, ticketPrefix, status, trimmed);
    }
    setTitle("");
    setComposerOpen(false);
  }

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
              selected={ticket.id === selectedId}
              onSelect={() => onSelect(ticket.id)}
            />
          ))}
        </div>
      </SortableContext>
      {composerOpen ? (
        <div className="mx-2 mb-2 rounded-lg border border-border bg-card px-3 py-2.5">
          <input
            ref={inputRef}
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder="Ticket title…"
            className="w-full border-none bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          onClick={() => setComposerOpen(true)}
          className="mx-2 mb-2 h-7 justify-start gap-1.5 text-xs text-muted-foreground"
        >
          <PlusIcon className="size-3.5" />
          New
        </Button>
      )}
    </div>
  );
}
