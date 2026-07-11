import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import {
  sortTickets,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketSort,
  type TicketStatus,
} from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { TicketContextMenu } from "@renderer/components/board/ticket-context-menu";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

// Same sibling-shift feel as the board's cards — a crisp sub-200ms ease-out.
const ROW_TRANSITION = { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

/**
 * Pure presentational row — also rendered inside the drag overlay (unselected
 * there), mirroring how `TicketCardContent` doubles as the card overlay body.
 */
export function TicketRowContent({
  ticket,
  selected = false,
}: {
  ticket: Ticket;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-3 border-b border-border/40 px-4",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <PriorityIndicator priority={ticket.priority} />
      <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{ticket.id}</span>
      <span className="truncate text-sm text-foreground">{ticket.title}</span>
      {ticket.tags.length > 0 ? (
        <div className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
          {ticket.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Sortable list row: same id space as the board's cards, so `resolveDrop` works unchanged. */
function SortableTicketRow({
  ticket,
  projectId,
  selected,
  onSelect,
}: {
  ticket: Ticket;
  projectId: string;
  selected: boolean;
  onSelect(ticketId: string): void;
}) {
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    transition: reducedMotion ? null : ROW_TRANSITION,
  });

  return (
    <TicketContextMenu ticket={ticket} projectId={projectId}>
      <div
        ref={setNodeRef}
        data-ticket-row
        data-ticket-id={ticket.id}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={cn(isDragging && "opacity-40")}
        onClick={() => onSelect(ticket.id)}
        {...attributes}
        {...listeners}
      >
        <TicketRowContent ticket={ticket} selected={selected} />
      </div>
    </TicketContextMenu>
  );
}

/**
 * A full status section: sticky header + its sortable rows. The row container
 * is the column droppable (shared `column:<status>` id) with a
 * `verticalListSortingStrategy` SortableContext over the group's ids — exactly
 * mirroring `board-column.tsx`. During a drag it keeps a slim min-height even
 * when empty (a section can empty mid-drag) so it stays a drop target.
 */
function ListSection({
  status,
  tickets,
  projectId,
  ticketPrefix,
  selectedId,
  onSelect,
  dragActive,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  ticketPrefix: string;
  selectedId: string | null;
  onSelect(ticketId: string): void;
  dragActive: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });

  return (
    <section data-list-section data-status={status}>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-muted/40 px-4 py-1.5 backdrop-blur-sm">
        <span className="text-[13px] font-medium text-foreground">
          {TICKET_STATUS_LABELS[status]}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{tickets.length}</span>
      </div>
      <SortableContext
        items={tickets.map((ticket) => ticket.id)}
        strategy={verticalListSortingStrategy}
      >
        <div ref={setNodeRef} className={cn(dragActive && "min-h-9")}>
          {tickets.map((ticket) => (
            <SortableTicketRow
              key={ticket.id}
              ticket={ticket}
              projectId={projectId}
              selected={ticket.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </SortableContext>
      <SectionComposer projectId={projectId} ticketPrefix={ticketPrefix} status={status} />
    </section>
  );
}

/**
 * Inline add-card composer — the list-row twin of board-column.tsx's. Same
 * store call and the same contract (Enter submits and keeps composing, Escape
 * closes, a non-empty blur submits then closes), so switching views never
 * costs ticket creation.
 */
function SectionComposer({
  projectId,
  ticketPrefix,
  status,
}: {
  projectId: string;
  ticketPrefix: string;
  status: TicketStatus;
}) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) inputRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      const trimmed = title.trim();
      if (trimmed === "") return;
      useBoardStore.getState().addTicket(projectId, ticketPrefix, status, trimmed);
      setTitle("");
    } else if (event.key === "Escape") {
      setTitle("");
      setOpen(false);
    }
  }

  function handleBlur() {
    const trimmed = title.trim();
    if (trimmed !== "") {
      useBoardStore.getState().addTicket(projectId, ticketPrefix, status, trimmed);
    }
    setTitle("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full items-center gap-1.5 px-4 text-xs text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
        New
      </button>
    );
  }

  return (
    <div className="flex h-9 items-center border-b border-border/40 bg-card px-4">
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
  );
}

/**
 * A status that was empty at drag start: rendered as a slim drop-target header
 * (label + 0 count) so a row can be dropped into any status. Same affordance
 * language as the board's collapsed pills — brightened while dragging, ringed
 * when hovered. On drop it becomes a real section via the normal data flow.
 */
function EmptyDropRow({ status }: { status: TicketStatus }) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-9 items-center gap-2 border-b border-border/40 px-4 transition-colors duration-150 ease-out",
        isOver ? "bg-accent ring-1 ring-inset ring-primary/60" : "bg-muted/20",
      )}
    >
      <span className="text-[13px] font-medium text-muted-foreground">
        {TICKET_STATUS_LABELS[status]}
      </span>
      <span className="font-mono text-xs text-muted-foreground">0</span>
    </div>
  );
}

interface BoardListViewProps {
  projectId: string;
  ticketPrefix: string;
  /** Grouped from the already-filtered (and possibly drag-preview) ticket set. */
  groups: Record<TicketStatus, Ticket[]>;
  sort: TicketSort;
  /** Statuses rendered as full sections — frozen during a drag (board's `shown`). */
  shownStatuses: readonly TicketStatus[];
  /** Empty-at-start statuses shown as slim drop rows — only during a drag (board's `hidden`). */
  emptyDropStatuses: readonly TicketStatus[];
  dragActive: boolean;
  selectedId: string | null;
  onSelect(ticketId: string): void;
}

/**
 * Linear-style single-scroller list: a second projection of the board's data,
 * with the same filter, sort, selection, context menu, AND drag & drop. Renders
 * statuses in {@link TICKET_STATUSES} order — each a full section (shown) or a
 * slim drop row (empty-at-start, drag only); empty-and-not-dragging statuses
 * auto-hide (same philosophy as the board's columns).
 */
export function BoardListView({
  projectId,
  ticketPrefix,
  groups,
  sort,
  shownStatuses,
  emptyDropStatuses,
  dragActive,
  selectedId,
  onSelect,
}: BoardListViewProps) {
  if (shownStatuses.length === 0 && emptyDropStatuses.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        No tickets match
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {TICKET_STATUSES.map((status) => {
        if (shownStatuses.includes(status)) {
          return (
            <ListSection
              key={status}
              status={status}
              tickets={sortTickets(groups[status], sort)}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              selectedId={selectedId}
              onSelect={onSelect}
              dragActive={dragActive}
            />
          );
        }
        if (emptyDropStatuses.includes(status)) {
          return <EmptyDropRow key={status} status={status} />;
        }
        return null;
      })}
    </div>
  );
}
