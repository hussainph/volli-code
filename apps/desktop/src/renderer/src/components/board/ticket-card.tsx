import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayTicketId, type Label, type Ticket } from "@volli/shared";

import type { TicketSessionActivity } from "@renderer/components/board/board-session-activity";
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TagChip } from "@renderer/components/board/tag-chip";
import { TicketContextMenu } from "@renderer/components/board/ticket-context-menu";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { useTicketRetention } from "@renderer/hooks/use-ticket-retention";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";

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
      {/* Filled, and one of the few that is: it marks the single card on a
          board of peers whose worktree is finished with. */}
      <ArchiveIcon weight="fill" className="size-3" />
    </span>
  );
}

/**
 * Pure presentational card body — also rendered inside the drag overlay
 * (always unselected there). `ticketPrefix` and `projectLabels` both come from
 * the board (a board only ever shows one project, so both are constant for the
 * whole tree) rather than per-card store subscriptions — see `displayTicketId`
 * and `resolveLabelColor`.
 */
export function TicketCardContent({
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
  /**
   * What is running on this ticket, or `null` for nothing (VC-100). Handed
   * down from the board's single derivation rather than read per card — see
   * `hooks/use-board-session-activity.ts`.
   */
  sessionActivity?: TicketSessionActivity | null;
}) {
  const displayId = displayTicketId(ticketPrefix, ticket.ticketNumber);

  return (
    <article
      className={cn(
        // `relative` for the session ring below, which lies on the card's own
        // border line rather than outside it.
        "relative",
        // `shadow-raised` and not `shadow-card`: the tier names an elevation,
        // not a component noun. A board card is a tile lying ON its column, the
        // same lift an active tab takes; `shadow-card` is the deeper halo the
        // detached drag preview wears while the tile is off the board
        // (`board.tsx`). This shadow used to be applied from a hand-maintained
        // `article.bg-card` selector in globals.css, which is exactly why the
        // three overlays that selector forgot were wearing stock black.
        // px-3, not the ladder's 4: a dense card trades air for content, and at
        // px-4 real titles truncate a word earlier. Recorded spacing exception.
        "flex flex-col gap-1 rounded-lg border bg-card px-3 py-2 shadow-raised cursor-default select-none transition-[border-color] duration-150 ease-out",
        // Selection colors the card's own border: a ring draws OUTSIDE the box
        // and the column scroller clips its top edge on the first card.
        selected ? "border-primary/70" : "border-border hover:border-border-strong",
      )}
    >
      {/* An agent is running on this ticket. Always rendered, never conditionally
          mounted: `display: none` makes an inactive one free (no boxes, no
          pseudo-element, no animation) and is what lets the ring fade OUT as
          well as in, which React cannot do for an unmount on its own.
          `aria-hidden` for the reason `StatusDot` gives — the card is not the
          only place this is said, and the sidebar's band says it in words. */}
      <span aria-hidden className="session-ring" data-activity={sessionActivity ?? undefined} />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-label text-muted-foreground">{displayId}</span>
        <div className="flex items-center gap-1">
          <ArchiveReadyBadge ticket={ticket} />
          <PriorityIndicator priority={ticket.priority} />
        </div>
      </div>
      <p className="text-sm font-medium leading-snug text-foreground line-clamp-2">
        {ticket.title}
      </p>
      {ticket.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {ticket.labels.map((label) => (
            <TagChip key={label} tag={label} color={resolveLabelColor(projectLabels, label)} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

// Sibling shift while a drag reorders the column: Linear-crisp, well under
// 300ms (dnd-kit's 250ms default reads floaty). Shared by the board card and
// the list row so the two views' drag feel stays one value. The curve is
// `--ease-out` by reference, not by re-typing it: this used to be the literal
// that the token was later minted from, and a second copy is how a token
// silently stops being one.
export const SORT_TRANSITION = { duration: 180, easing: "var(--ease-out)" };

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
  /** The board's owning project's label rows — constant for the whole board tree. */
  projectLabels: readonly Label[];
  selected: boolean;
  /** What is running on this ticket, or `null` for nothing (VC-100). */
  sessionActivity: TicketSessionActivity | null;
  onSelect(ticketId: string): void;
  /** Double-click opens the ticket's full-page detail view (ticket-detail-mvp step 3). */
  onOpen(ticketId: string): void;
}

/**
 * Sortable wrapper: the in-column card. Dims while its drag overlay is out.
 * Memoized — every card in every column would otherwise re-render on each
 * board render (drag-over events, selection changes, filter keystrokes);
 * `onSelect`/`onOpen` are stable id-taking callbacks from the board for that
 * reason, and `ticketPrefix`/`projectLabels` are board-wide values passed down
 * for the same reason.
 */
export const TicketCard = React.memo(function TicketCard({
  ticket,
  projectId,
  ticketPrefix,
  projectLabels,
  selected,
  sessionActivity,
  onSelect,
  onOpen,
}: TicketCardProps) {
  return (
    <SortableTicketShell ticket={ticket} projectId={projectId} onSelect={onSelect} onOpen={onOpen}>
      <TicketCardContent
        ticket={ticket}
        ticketPrefix={ticketPrefix}
        projectLabels={projectLabels}
        selected={selected}
        sessionActivity={sessionActivity}
      />
    </SortableTicketShell>
  );
});
