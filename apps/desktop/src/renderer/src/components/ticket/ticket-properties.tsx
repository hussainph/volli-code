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
 *
 * RETIRED, deliberately: the old page closed with a `Created …` / `Updated …`
 * pair under a rule (`formatTimestamp`, since deleted). The Calm Stack has no
 * such line, and the two facts are not lost — the Activity feed carries a
 * durable "created the ticket" event with its own stamp, and its most recent
 * entry is a truer answer to "when did this last move" than a derived
 * `updatedAt` that a label edit also bumps. `formatStamp` itself survives in
 * `lib/relative-time` for the Archive.
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
import { LabelEditorCore } from "@renderer/components/ticket/label-editor-core";
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
  "flex h-6 shrink-0 items-center gap-2 rounded-full border border-sidebar-border bg-background/30 px-2 text-ui text-foreground transition-colors duration-150 ease-out hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none motion-reduce:transition-none";

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
      className="flex flex-col gap-1 px-4 pt-4 group-data-[narrow=true]/rail:px-3"
    >
      <div aria-label="Status and priority" className="flex min-h-6 flex-wrap items-center gap-1">
        <StatusPill projectId={projectId} ticket={ticket} />
        <PriorityPill projectId={projectId} ticket={ticket} />
      </div>
      <div aria-label="Labels" className="flex min-h-6 flex-wrap items-center gap-1">
        <LabelEditorCore
          projectId={projectId}
          value={ticket.labels}
          onChange={(next) => void useBoardStore.getState().setLabels(ticket.id, next)}
        />
      </div>
    </section>
  );
}
