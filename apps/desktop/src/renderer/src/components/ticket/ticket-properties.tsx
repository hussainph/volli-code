import * as React from "react";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import {
  errorMessage,
  harnessLabel,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";
import { toast } from "sonner";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { TicketLabelEditor } from "@renderer/components/ticket/ticket-label-editor";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Input } from "@renderer/components/ui/input";
import { useBoardStore } from "@renderer/stores/board";

/** "Jul 14, 2026, 3:04 PM" — a compact created/updated stamp. */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PropertyLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/** Status picker: same chip/dropdown idiom as the new-ticket dialog's `StatusPicker`, wired to the
 * board store's `moveTicket` instead of local field state. Picking a status appends the ticket to
 * the end of that column — the same "Move to" semantics as the card's context menu. */
function StatusField({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 w-fit gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
        >
          {TICKET_STATUS_LABELS[ticket.status]}
        </Button>
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

/** Priority picker: the new-ticket dialog's `PriorityPicker` idiom (same trigger classes, same
 * `PriorityIndicator` bars), wired to the board store's `setTicketPriority`. */
function PriorityField({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 w-fit gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
        >
          <PriorityIndicator priority={ticket.priority} />
          {TICKET_PRIORITY_LABELS[ticket.priority]}
        </Button>
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

/**
 * A click-to-edit text field for a single worktree-identity string (branch/baseBranch): click to
 * focus an input seeded with the current value; Enter or blur commits via `onCommit` (a no-op if
 * unchanged); Escape reverts without writing. An empty commit passes `null` — clearing the field —
 * rather than `""`, matching the domain's null-until-a-worktree-exists convention. Displays an
 * em-dash when `value` is null and not being edited.
 */
function InlineTextField({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit(next: string | null): void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value ?? "");

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === value) return;
    onCommit(next);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
        className="h-7 font-mono text-xs"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value ?? "");
        setEditing(true);
      }}
      className="w-full truncate rounded-md px-2 py-1 text-left font-mono text-xs text-foreground hover:bg-accent"
    >
      {value ?? <span className="text-muted-foreground">—</span>}
    </button>
  );
}

/** Read-only `worktreePath` display + a reveal-in-Finder affordance (same `api.fs.revealInFinder`
 * call as the project rail's tile — rail/project-tile.tsx). */
function WorktreePathField({ path }: { path: string | null }) {
  async function reveal() {
    if (!path) return;
    try {
      const result = await window.api.fs.revealInFinder(path);
      if (!result.ok) toast.error(`Could not reveal in Finder: ${result.error}`);
    } catch (error) {
      toast.error(`Could not reveal in Finder: ${errorMessage(error)}`);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 truncate px-2 py-1 font-mono text-xs text-foreground">
        {path ?? <span className="text-muted-foreground">—</span>}
      </span>
      {path ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reveal in Finder"
          onClick={() => void reveal()}
        >
          <FolderOpenIcon />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The right rail's Properties block: status, priority, labels, a read-only harness display, and
 * worktree identity (branch/baseBranch inline-editable, worktreePath read-only), then
 * created/updated timestamps.
 */
export function TicketProperties({ projectId, ticket }: { projectId: string; ticket: Ticket }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Status</PropertyLabel>
        <StatusField projectId={projectId} ticket={ticket} />
      </div>
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Priority</PropertyLabel>
        <PriorityField projectId={projectId} ticket={ticket} />
      </div>
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Labels</PropertyLabel>
        <TicketLabelEditor projectId={projectId} ticket={ticket} />
      </div>
      <div className="flex flex-col gap-1.5">
        <PropertyLabel>Harness</PropertyLabel>
        <p className="px-2 py-1 text-xs text-foreground">{harnessLabel(ticket.harnessId)}</p>
      </div>
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Branch</PropertyLabel>
          <InlineTextField
            value={ticket.branch}
            onCommit={(next) =>
              void useBoardStore.getState().updateTicket({ ticketId: ticket.id, branch: next })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Base branch</PropertyLabel>
          <InlineTextField
            value={ticket.baseBranch}
            onCommit={(next) =>
              void useBoardStore.getState().updateTicket({ ticketId: ticket.id, baseBranch: next })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <PropertyLabel>Worktree</PropertyLabel>
          <WorktreePathField path={ticket.worktreePath} />
        </div>
      </div>
      <div className="flex flex-col gap-0.5 border-t border-border pt-3 text-[11px] text-muted-foreground">
        <span>Created {formatTimestamp(ticket.createdAt)}</span>
        <span>Updated {formatTimestamp(ticket.updatedAt)}</span>
      </div>
    </section>
  );
}
