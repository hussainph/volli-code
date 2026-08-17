import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import {
  displayTicketId,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Label,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { columnDroppableId } from "@renderer/components/board/board-dnd";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { SortableTicketShell } from "@renderer/components/board/ticket-card";
import { useTicketComposer } from "@renderer/components/board/use-ticket-composer";
import { Badge } from "@renderer/components/ui/badge";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { ThinkingOrbs } from "@renderer/components/ui/thinking-orbs";
import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";

/**
 * What a list row wears while an agent is running on its ticket (VC-100).
 *
 * The board's cards get a travelling ring; a row deliberately does not. A 36px
 * full-width strip has ~1500px of perimeter for a highlight to crawl around,
 * and a dozen of them would be a page of moving outlines — the ring works on a
 * card because a card is a small closed shape, which is exactly what a row is
 * not.
 *
 * TWO MARKS, because the two states are two different claims and each already
 * has its drawing in this app. `working` is the transcript's own running mark
 * (`ui/thinking-orbs.tsx`): three orbs on a wave, the idiom for "still going",
 * carrying no urgency for something that may be on screen for ten minutes.
 * `waiting` is the one state asking for a person, and that is `StatusDot`'s
 * amber — orbs there would say the agent is thinking when it is in fact
 * stopped, waiting on you.
 *
 * The orbs take `--positive` rather than the transcript's ember: on this
 * surface the accent already means "selected" (`bg-primary/10` on the row it
 * sits in), and the card's ring beside it reads the same green for the same
 * state. One colour for `working` across the whole board.
 */
function RunningMark({ activity }: { activity: TicketSessionActivity | null }) {
  if (activity === null) return null;
  if (activity === "waiting") return <StatusDot state="waiting" />;
  return <ThinkingOrbs className="text-positive" />;
}

/**
 * Pure presentational row — also rendered inside the drag overlay (unselected
 * there), mirroring how `TicketCardContent` doubles as the card overlay body.
 * `ticketPrefix` and `projectLabels` come from the board (constant for the
 * whole board tree) — see `displayTicketId` and `resolveLabelColor`.
 */
export function TicketRowContent({
  ticket,
  ticketPrefix,
  projectLabels,
  selected = false,
  sessionActivity = null,
}: {
  ticket: Ticket;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  selected?: boolean;
  /** What is running on this ticket, or `null` for nothing (VC-100). */
  sessionActivity?: TicketSessionActivity | null;
}) {
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  return (
    <div
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-4 border-b border-border/30 px-gutter",
        selected ? "bg-primary/10" : "hover:bg-muted/30",
      )}
    >
      <PriorityIndicator priority={ticket.priority} />
      <span className="w-14 shrink-0 font-mono text-label text-muted-foreground">{displayId}</span>
      {/* The title and its running mark travel together, inside the row's own
          `gap-4` rather than beside it: the mark is about the ticket the title
          names, and 16px of air would read as a third column. */}
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-foreground">{ticket.title}</span>
        <RunningMark activity={sessionActivity} />
      </span>
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
  projectLabels,
  selected,
  sessionActivity,
  onSelect,
  onOpen,
}: {
  ticket: Ticket;
  projectId: string;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  selected: boolean;
  sessionActivity: TicketSessionActivity | null;
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
      <TicketRowContent
        ticket={ticket}
        ticketPrefix={ticketPrefix}
        projectLabels={projectLabels}
        selected={selected}
        sessionActivity={sessionActivity}
      />
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
  projectLabels,
  selectedId,
  sessionActivity,
  onSelect,
  onOpen,
  dragActive,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  selectedId: string | null;
  /** ticketId → what is running on it; absent means nothing is (VC-100). */
  sessionActivity: Readonly<Record<string, TicketSessionActivity>>;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
  dragActive: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  // Memoized for the same reason as board-column.tsx's, and with the same
  // caveat about how far that invalidation actually travels — read the comment
  // there rather than keep a second account of it here.
  const sortableIds = React.useMemo(() => tickets.map((ticket) => ticket.id), [tickets]);

  return (
    <section data-list-section data-status={status}>
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-muted/30 px-gutter py-1 backdrop-blur-sm">
        <span className="text-ui font-medium text-foreground">{TICKET_STATUS_LABELS[status]}</span>
        <Badge variant="count">{tickets.length}</Badge>
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className={cn(dragActive && "min-h-9")}>
          {tickets.map((ticket) => (
            <SortableTicketRow
              key={ticket.id}
              ticket={ticket}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              projectLabels={projectLabels}
              selected={ticket.id === selectedId}
              sessionActivity={sessionActivity[ticket.id] ?? null}
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
        className="flex h-8 w-full items-center gap-1 px-gutter text-ui text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
        New
      </button>
    );
  }

  return (
    <div className="flex h-9 items-center border-b border-border/30 bg-card px-gutter">
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
        "flex h-9 items-center gap-2 border-b border-border/30 px-gutter transition-colors duration-150 ease-out",
        isOver ? "bg-accent ring-1 ring-inset ring-primary/50" : "bg-muted/30",
      )}
    >
      <span className="text-ui font-medium text-muted-foreground">
        {TICKET_STATUS_LABELS[status]}
      </span>
      <Badge variant="count">0</Badge>
    </div>
  );
}

interface BoardListViewProps {
  projectId: string;
  /** The board's owning project's ticket prefix — constant for the whole board tree. */
  ticketPrefix: string;
  /** The board's owning project's label rows — constant for the whole board tree. */
  projectLabels: readonly Label[];
  /** Grouped AND per-column sorted by the board (one sort pass shared with the columns view). */
  groups: Record<TicketStatus, Ticket[]>;
  /** Statuses rendered as full sections — frozen during a drag (board's `shown`). */
  shownStatuses: readonly TicketStatus[];
  /** Empty-at-start statuses shown as slim drop rows — only during a drag (board's `hidden`). */
  emptyDropStatuses: readonly TicketStatus[];
  dragActive: boolean;
  selectedId: string | null;
  /**
   * ticketId → what is running on it; absent means nothing is (VC-100). One map
   * for the whole view, derived once by the board — see
   * `hooks/use-board-session-activity.ts`.
   */
  sessionActivity: Readonly<Record<string, TicketSessionActivity>>;
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
  projectLabels,
  groups,
  shownStatuses,
  emptyDropStatuses,
  dragActive,
  selectedId,
  sessionActivity,
  onSelect,
  onOpen,
}: BoardListViewProps) {
  if (shownStatuses.length === 0 && emptyDropStatuses.length === 0) {
    return (
      <div className={cn("min-h-0 flex-1", EMPTY_PAGE)}>
        <p className="text-sm text-muted-foreground">No tickets match</p>
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
              projectLabels={projectLabels}
              selectedId={selectedId}
              sessionActivity={sessionActivity}
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
