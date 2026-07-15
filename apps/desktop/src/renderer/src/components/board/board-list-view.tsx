import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { SortableTicketShell } from "@renderer/components/board/ticket-card";
import { useTicketComposer } from "@renderer/components/board/use-ticket-composer";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

/**
 * Pure presentational row — also rendered inside the drag overlay (unselected
 * there), mirroring how `TicketCardContent` doubles as the card overlay body.
 * `ticketPrefix` comes from the board (constant for the whole board tree) —
 * see `displayTicketId`.
 */
export function TicketRowContent({
  ticket,
  ticketPrefix,
  selected = false,
}: {
  ticket: Ticket;
  ticketPrefix: string;
  selected?: boolean;
}) {
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);
  const projectLabels = useBoardStore((state) => state.labelsByProject[ticket.projectId]);

  return (
    <div
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-3 border-b border-border/40 px-4",
        selected ? "bg-primary/10" : "hover:bg-muted/40",
      )}
    >
      <PriorityIndicator priority={ticket.priority} />
      <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{displayId}</span>
      <span className="truncate text-sm text-foreground">{ticket.title}</span>
      {ticket.labels.length > 0 ? (
        <div className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
          {ticket.labels.map((label) => (
            <TagChip key={label} tag={label} color={resolveLabelColor(projectLabels, label)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sortable list row: same id space as the board's cards, so `resolveDrop`
 * works unchanged. Memoized for the same reason as `TicketCard` — every row
 * would otherwise re-render on each board render.
 */
const SortableTicketRow = React.memo(function SortableTicketRow({
  ticket,
  projectId,
  ticketPrefix,
  selected,
  onSelect,
  onOpen,
}: {
  ticket: Ticket;
  projectId: string;
  ticketPrefix: string;
  selected: boolean;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
}) {
  // The e2e-facing handle mirrors what's visible on screen — the DISPLAY id,
  // not the drag/sort identity (still the opaque `ticket.id` UUID, unchanged
  // below).
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);
  return (
    <SortableTicketShell
      ticket={ticket}
      projectId={projectId}
      onSelect={onSelect}
      onOpen={onOpen}
      dataAttributes={{ "data-ticket-row": "true", "data-ticket-id": displayId }}
    >
      <TicketRowContent ticket={ticket} ticketPrefix={ticketPrefix} selected={selected} />
    </SortableTicketShell>
  );
});

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
  onOpen,
  dragActive,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  ticketPrefix: string;
  selectedId: string | null;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
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
              ticketPrefix={ticketPrefix}
              selected={ticket.id === selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
        </div>
      </SortableContext>
      <SectionComposer projectId={projectId} status={status} />
    </section>
  );
}

/**
 * Inline add-card composer — the list-row twin of board-column.tsx's, sharing
 * its whole contract via `useTicketComposer` (Enter submits and keeps
 * composing, Escape closes, a non-empty blur submits then closes), so
 * switching views never costs ticket creation. Only the wrapper markup is its
 * own.
 */
function SectionComposer({ projectId, status }: { projectId: string; status: TicketStatus }) {
  const composer = useTicketComposer({ projectId, status });

  if (!composer.open) {
    return (
      <button
        type="button"
        onClick={composer.openComposer}
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
  /** The board's owning project's ticket prefix — constant for the whole board tree. */
  ticketPrefix: string;
  /** Grouped AND per-column sorted by the board (one sort pass shared with the columns view). */
  groups: Record<TicketStatus, Ticket[]>;
  /** Statuses rendered as full sections — frozen during a drag (board's `shown`). */
  shownStatuses: readonly TicketStatus[];
  /** Empty-at-start statuses shown as slim drop rows — only during a drag (board's `hidden`). */
  emptyDropStatuses: readonly TicketStatus[];
  dragActive: boolean;
  selectedId: string | null;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
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
  shownStatuses,
  emptyDropStatuses,
  dragActive,
  selectedId,
  onSelect,
  onOpen,
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
              tickets={groups[status]}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              selectedId={selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
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
