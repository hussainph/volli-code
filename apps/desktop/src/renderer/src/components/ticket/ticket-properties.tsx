/**
 * The Now page's Properties fold — status, priority and labels as one wrapping
 * run of pills (lab/scratches/ticket-right-sidebar.tsx `PropertiesSection`).
 *
 * Properties used to be a page of its own behind a fourth icon mode, with each
 * field under an uppercase caption. It is three editable values; a page was
 * more room than they need, and a caption over a control that already names
 * itself is a caption twice. The pills carry their own glyph and value, so the
 * fold reads at a glance and still edits in place.
 *
 * Worktree identity (branch, base branch, path) and the done flow are NOT here:
 * they are repository facts, and they live in the card above this one
 * (`ticket-repository-summary.tsx`).
 */
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TicketLabelEditor } from "@renderer/components/ticket/ticket-label-editor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useBoardStore } from "@renderer/stores/board";

/** The fold's one control shape: a 24px chip carrying its glyph and its value. */
const PILL =
  "flex h-6 shrink-0 items-center gap-2 rounded-full border border-sidebar-border bg-background/40 px-2 text-xs text-foreground transition-colors duration-150 ease-out hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 focus-visible:outline-none motion-reduce:transition-none";

/**
 * Status picker: the fold's pill wired to the board store's `moveTicket`.
 * Picking a status appends the ticket to the end of that column — the same
 * "Move to" semantics as the card's context menu.
 */
function StatusPill({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={PILL}
        aria-label={`Status: ${TICKET_STATUS_LABELS[ticket.status]}`}
      >
        <CircleIcon className="size-4 text-muted-foreground" />
        {TICKET_STATUS_LABELS[ticket.status]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={ticket.status}
          onValueChange={(value) =>
            void useBoardStore
              .getState()
              .moveTicket(projectId, ticket.id, value as TicketStatus, Number.MAX_SAFE_INTEGER)
          }
        >
          {TICKET_STATUSES.map((status) => (
            <DropdownMenuRadioItem key={status} value={status}>
              {TICKET_STATUS_LABELS[status]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Priority picker: the same pill, wired to `setTicketPriority`. It keeps the
 * board's `PriorityIndicator` bars rather than the scratch's generic flag — the
 * bars are the app's priority mark on cards, in the composer and in this menu's
 * own items, and one value must not wear two glyphs on adjacent surfaces.
 */
function PriorityPill({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={PILL}
        aria-label={`Priority: ${TICKET_PRIORITY_LABELS[ticket.priority]}`}
      >
        <PriorityIndicator priority={ticket.priority} />
        {TICKET_PRIORITY_LABELS[ticket.priority]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={ticket.priority}
          onValueChange={(value) =>
            void useBoardStore
              .getState()
              .setTicketPriority(projectId, ticket.id, value as TicketPriority)
          }
        >
          {TICKET_PRIORITIES.map((priority) => (
            <DropdownMenuRadioItem key={priority} value={priority}>
              <PriorityIndicator priority={priority} />
              {TICKET_PRIORITY_LABELS[priority]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TicketProperties({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <section
      aria-label="Properties"
      data-testid="ticket-rail-properties"
      className="flex flex-col gap-1.5 px-4 pt-5 group-data-[narrow=true]/rail:px-3"
    >
      <div aria-label="Status and priority" className="flex min-h-6 flex-wrap items-center gap-1.5">
        <StatusPill projectId={projectId} ticket={ticket} />
        <PriorityPill projectId={projectId} ticket={ticket} />
      </div>
      <div aria-label="Labels" className="flex min-h-6 flex-wrap items-center gap-1.5">
        <TicketLabelEditor projectId={projectId} ticket={ticket} />
      </div>
    </section>
  );
}
