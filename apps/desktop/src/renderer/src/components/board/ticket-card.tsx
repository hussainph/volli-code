import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayTicketId, type Ticket } from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { TicketContextMenu } from "@renderer/components/board/ticket-context-menu";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useTicketRetention } from "@renderer/hooks/use-ticket-retention";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

/**
 * A minimal archive-ready dot on the card (issue #76): shown only when the
 * ticket's retention state says its worktree is ready to archive (a merged PR,
 * or Done past the TTL). Subtle by design — an ember archive glyph with a
 * native tooltip, never a banner (decision #45's "no dashboard" spirit). The
 * retention read is gated on the ticket having a branch, so the vast majority
 * of cards issue no IPC at all.
 */
function ArchiveReadyBadge({ ticket }: { ticket: Ticket }) {
  const { state } = useTicketRetention(ticket.id, ticket.branch !== null);
  if (!state?.archiveReady) return null;
  return (
    <span
      className="flex items-center text-primary"
      title="Ready to archive"
      aria-label="Ready to archive"
    >
      <ArchiveIcon weight="fill" className="size-3" />
    </span>
  );
}

/**
 * Pure presentational card body — also rendered inside the drag overlay
 * (always unselected there). `ticketPrefix` comes from the board (a board
 * only ever shows one project, so it's constant for the whole tree) rather
 * than a per-card projects-store subscription — see `displayTicketId`.
 */
export function TicketCardContent({
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
    <article
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 cursor-default select-none transition-[border-color] duration-150 ease-out",
        // Selection colors the card's own border: a ring draws OUTSIDE the box
        // and the column scroller clips its top edge on the first card.
        selected ? "border-primary/70" : "border-border hover:border-border-hover",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-label text-muted-foreground">{displayId}</span>
        <div className="flex items-center gap-1.5">
          <ArchiveReadyBadge ticket={ticket} />
          <PriorityIndicator priority={ticket.priority} />
        </div>
      </div>
      <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
        {ticket.title}
      </p>
      {ticket.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {ticket.labels.map((label) => (
            <TagChip key={label} tag={label} color={resolveLabelColor(projectLabels, label)} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

// Sibling shift while a drag reorders the column: Linear-crisp, a strong
// ease-out well under 300ms (dnd-kit's 250ms default reads floaty). Shared by
// the board card and the list row so the two views' drag feel stays one value.
export const SORT_TRANSITION = { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" };

/**
 * Sortable + context-menu wrapper shared by the board card and the list row:
 * one useSortable wiring, one reduced-motion gate, one dimmed-while-dragging
 * treatment. Consumers supply only the presentational body (and, for the list
 * row, its data-* e2e hooks via `dataAttributes`).
 */
export function SortableTicketShell({
  ticket,
  projectId,
  onSelect,
  onOpen,
  dataAttributes,
  children,
}: {
  ticket: Ticket;
  projectId: string;
  onSelect(ticketId: string): void;
  /**
   * Double-click opens the ticket's full-page detail view (ticket-detail-mvp
   * step 3). Safe alongside dnd-kit: the board's `distance: 4` activation
   * constraint (board.tsx) already keeps a near-zero-travel gesture — a plain
   * click OR a double-click — from engaging the drag, the same guard that lets
   * `onSelect` below coexist with dragging today.
   */
  onOpen?(ticketId: string): void;
  dataAttributes?: Record<string, string>;
  children: React.ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    transition: reducedMotion ? null : SORT_TRANSITION,
  });

  // Keyboard-open path (a11y): dnd-kit already makes the card focusable
  // (role="button", tabIndex 0 via `attributes`), but its KeyboardSensor claims
  // BOTH Space and Enter to start a drag, leaving no key to open the ticket. We
  // compose over dnd-kit's own onKeyDown (in `listeners`): intercept Enter →
  // open, and delegate everything else — so Space still starts a keyboard drag.
  // Guarded by `isDragging` so Enter-to-drop during an active drag falls through
  // to dnd-kit's document-level end handler unchanged. This lives on the card,
  // not the sensor's `keyboardCodes`, because board.tsx (where the sensor is
  // configured) is out of scope here; the outcome (Space drags, Enter opens) is
  // the same. The `onKeyDown` prop sits AFTER `{...listeners}` so it wins.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDragging && onOpen && event.key === "Enter") {
      event.preventDefault();
      onOpen(ticket.id);
      return;
    }
    listeners?.onKeyDown?.(event);
  };

  return (
    <TicketContextMenu ticket={ticket} projectId={projectId}>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={cn(isDragging && "opacity-40")}
        onClick={() => onSelect(ticket.id)}
        onDoubleClick={onOpen ? () => onOpen(ticket.id) : undefined}
        {...dataAttributes}
        {...attributes}
        {...listeners}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </TicketContextMenu>
  );
}

interface TicketCardProps {
  ticket: Ticket;
  projectId: string;
  ticketPrefix: string;
  selected: boolean;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
}

/**
 * Sortable wrapper: the in-column card. Dims while its drag overlay is out.
 * Memoized — every card in every column would otherwise re-render on each
 * board render (drag-over events, selection changes, filter keystrokes);
 * `onSelect`/`onOpen` are stable id-taking callbacks from the board for that
 * reason, and `ticketPrefix` is a plain string from the board for the same
 * reason.
 */
export const TicketCard = React.memo(function TicketCard({
  ticket,
  projectId,
  ticketPrefix,
  selected,
  onSelect,
  onOpen,
}: TicketCardProps) {
  return (
    <SortableTicketShell ticket={ticket} projectId={projectId} onSelect={onSelect} onOpen={onOpen}>
      <TicketCardContent ticket={ticket} ticketPrefix={ticketPrefix} selected={selected} />
    </SortableTicketShell>
  );
});
