import { useListWindow } from "./use-list-window";
import { TicketCardLabels } from "./ticket-card-labels";
import { EmptyState } from "@renderer/components/ui/empty-state";
import { useBoardStore } from "@renderer/stores/board";
import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { AddIcon } from "@renderer/components/ui/icon";

import {
  cardTicketKey,
  displayTicketId,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Label,
  type Ticket,
  type TicketStatus,
} from "@volli/shared";

import { BoardEmpty } from "@renderer/components/board/board-empty";
import { columnDroppableId } from "@renderer/components/board/board-dnd";
import type { TicketSelectionGesture } from "@renderer/components/board/board-selection";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { SortableTicketShell } from "@renderer/components/board/ticket-card";
import { readOnlyControl } from "@renderer/components/hosts/use-hosts";
import { useTicketComposer } from "@renderer/components/board/use-ticket-composer";
import { Badge } from "@renderer/components/ui/badge";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";
import { useBoardSessionActivityMap } from "@renderer/components/board/session-activity-context";
import { cn } from "@renderer/lib/utils";

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
  const displayId = cardTicketKey(ticketPrefix, ticket.ticketNumber);

  return (
    <div
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-4 border-b border-border/30 px-gutter",
        selected ? "bg-(--accent-selected)" : "hover:bg-(--accent-tint)",
      )}
    >
      <PriorityIndicator priority={ticket.priority} />
      {/* A compact ring around the key keeps live state in the same accent
          grammar as cards without rastering a full-width animated row. */}
      <span className="relative w-14 shrink-0 rounded-control-mini px-1 font-mono text-label text-muted-foreground">
        <span
          aria-hidden
          className="session-ring board-session-ring"
          data-activity={sessionActivity ?? undefined}
        />
        {displayId}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-foreground">{ticket.title}</span>
      </span>
      {ticket.labels.length > 0 ? (
        <div className="ml-auto hidden shrink-0 items-center gap-1 sm:flex">
          <TicketCardLabels labels={ticket.labels} projectLabels={projectLabels} />
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
  dragHidden,
  instantSort = false,
  dragTicketIds,
  sessionActivity,
  onSelect,
  onOpen,
}: {
  ticket: Ticket;
  projectId: string;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  selected: boolean;
  dragHidden: boolean;
  instantSort?: boolean;
  dragTicketIds?: readonly string[];
  sessionActivity: TicketSessionActivity | null;
  onSelect(ticketId: string, gesture: TicketSelectionGesture): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
}) {
  // The e2e-facing handle mirrors what's visible on screen — the DISPLAY id,
  // not the drag/sort identity (still the opaque `ticket.id` UUID, unchanged
  // below).
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);
  const ownDragIds = React.useMemo(() => [ticket.id], [ticket.id]);
  return (
    <SortableTicketShell
      ticket={ticket}
      projectId={projectId}
      selected={selected}
      dragHidden={dragHidden}
      instantSort={instantSort}
      dragTicketIds={dragTicketIds ?? ownDragIds}
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
  selectedIds,
  draggingIds,
  groupDragIds,
  onSelect,
  onOpen,
  dragActive,
  instantSort = false,
  aimed,
  scroller,
  revealTicketId,
}: {
  scroller: React.RefObject<HTMLDivElement | null>;
  revealTicketId: string | null;
  status: TicketStatus;
  tickets: Ticket[];
  projectId: string;
  ticketPrefix: string;
  projectLabels: readonly Label[];
  selectedIds: readonly string[];
  draggingIds: readonly string[];
  groupDragIds: readonly string[];
  onSelect(ticketId: string, gesture: TicketSelectionGesture): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
  dragActive: boolean;
  instantSort?: boolean;
  aimed: boolean;
}) {
  // ticketId → what is running on it; absent means nothing is (VC-100). Read
  // from context for the reason board-column.tsx gives — the derivation has to
  // hang below the `DndContext`, never above it.
  const sessionActivity = useBoardSessionActivityMap();
  const { setNodeRef } = useDroppable({ id: columnDroppableId(status) });
  // Memoized for the same reason as board-column.tsx's, and with the same
  // caveat about how far that invalidation actually travels — read the comment
  // there rather than keep a second account of it here.
  const sortableIds = React.useMemo(() => tickets.map((ticket) => ticket.id), [tickets]);
  const selectedSet = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const draggingSet = React.useMemo(() => new Set(draggingIds), [draggingIds]);
  const list = React.useRef<HTMLDivElement>(null);
  const range = useListWindow({
    scroller,
    list,
    count: tickets.length,
    revealIndex: tickets.findIndex((ticket) => ticket.id === revealTicketId),
    dragActive,
  });

  return (
    <section
      data-list-section
      data-status={status}
      data-drop-aimed={aimed || undefined}
      className={cn(aimed && "bg-(--accent-tint) ring-1 ring-inset ring-primary-text")}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-muted px-gutter py-1">
        <span className="text-ui font-medium text-foreground">{TICKET_STATUS_LABELS[status]}</span>
        <Badge variant="count">{tickets.length}</Badge>
      </div>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div
          data-list-row-body=""
          ref={(node) => {
            setNodeRef(node);
            list.current = node;
          }}
          className={cn(dragActive && "min-h-9")}
        >
          {range.first ? <div aria-hidden style={{ height: range.first * 36 }} /> : null}
          {tickets.slice(range.first, range.last).map((ticket) => (
            <SortableTicketRow
              key={ticket.id}
              ticket={ticket}
              projectId={projectId}
              ticketPrefix={ticketPrefix}
              projectLabels={projectLabels}
              selected={selectedSet.has(ticket.id)}
              dragHidden={draggingSet.has(ticket.id)}
              instantSort={instantSort}
              dragTicketIds={selectedSet.has(ticket.id) ? groupDragIds : undefined}
              sessionActivity={sessionActivity[ticket.id] ?? null}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          ))}
          {range.last < tickets.length ? (
            <div aria-hidden style={{ height: (tickets.length - range.last) * 36 }} />
          ) : null}
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
        {...readOnlyControl(composer.canWrite)}
        onClick={composer.openComposer}
        className="flex h-8 w-full items-center gap-1 px-gutter text-ui text-muted-foreground transition-colors duration-(--duration-menu-in) ease-out hover:text-foreground"
      >
        <AddIcon className="size-3.5" />
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
function EmptyDropRow({ status, aimed }: { status: TicketStatus; aimed: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDroppableId(status) });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-9 items-center gap-2 border-b border-border/30 px-gutter transition-colors duration-(--duration-menu-in) ease-out",
        isOver || aimed ? "bg-accent ring-1 ring-inset ring-primary/50" : "bg-muted/30",
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
  /** The project has no tickets at all — a different nothing from "no tickets match". */
  boardEmpty: boolean;
  dragActive: boolean;
  instantSort?: boolean;
  /** Status resolved from the board's frozen drag snapshot. */
  aimedStatus: TicketStatus | null;
  selectedIds: readonly string[];
  draggingIds: readonly string[];
  groupDragIds: readonly string[];
  onSelect(ticketId: string, gesture: TicketSelectionGesture): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
  revealTicketId?: string | null;
}

/**
 * Single-scroller list: a second projection of the board's data,
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
  boardEmpty,
  dragActive,
  instantSort = false,
  aimedStatus,
  selectedIds,
  draggingIds,
  groupDragIds,
  onSelect,
  onOpen,
  revealTicketId = null,
}: BoardListViewProps) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [keyboardTarget, setKeyboardTarget] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (keyboardTarget === null) return;
    const frame = requestAnimationFrame(() => {
      const target = [
        ...(scroller.current?.querySelectorAll<HTMLElement>("[data-ticket-focus-id]") ?? []),
      ].find((node) => node.dataset.ticketFocusId === keyboardTarget);
      target?.focus({ preventScroll: true });
      if (target) setKeyboardTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [keyboardTarget]);
  if (shownStatuses.length === 0 && emptyDropStatuses.length === 0) {
    // Two different nothings, and only one of them is the reader's fault: a
    // filter that matched nothing is a report, while a board with no tickets is
    // an invitation (VC-42 audit F6). The columns view draws the same pair.
    return boardEmpty ? (
      <BoardEmpty projectId={projectId} className="min-h-0 flex-1" />
    ) : (
      <div className={cn("min-h-0 flex-1", EMPTY_PAGE)}>
        <EmptyState
          tier="page"
          illustration="search"
          title="No matching tickets"
          action={{
            label: "Clear filters",
            onAction: () => useBoardStore.getState().clearFilter(projectId),
          }}
        />
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto"
      data-list-ticket-count={TICKET_STATUSES.reduce(
        (sum, status) => sum + groups[status].length,
        0,
      )}
      onKeyDownCapture={(event) => {
        if (dragActive || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const node = (event.target as HTMLElement).closest<HTMLElement>("[data-ticket-focus-id]");
        if (!node) return;
        const ids = TICKET_STATUSES.flatMap((status) =>
          shownStatuses.includes(status) ? groups[status].map((ticket) => ticket.id) : [],
        );
        const at = ids.indexOf(node.dataset.ticketFocusId!);
        if (at < 0) return;
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : Math.max(0, Math.min(ids.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
        event.preventDefault();
        event.stopPropagation();
        setKeyboardTarget(ids[index]!);
      }}
    >
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
              selectedIds={selectedIds}
              draggingIds={draggingIds}
              groupDragIds={groupDragIds}
              onSelect={onSelect}
              onOpen={onOpen}
              dragActive={dragActive}
              instantSort={instantSort}
              aimed={aimedStatus === status}
              scroller={scroller}
              revealTicketId={keyboardTarget ?? revealTicketId}
            />
          );
        }
        if (emptyDropStatuses.includes(status)) {
          return <EmptyDropRow key={status} status={status} aimed={aimedStatus === status} />;
        }
        return null;
      })}
    </div>
  );
}
