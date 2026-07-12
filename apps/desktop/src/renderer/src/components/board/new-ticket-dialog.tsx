import * as React from "react";
import { toast } from "sonner";
import {
  displayTicketId,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type Project,
  type TicketPriority,
  type TicketStatus,
} from "@volli/shared";

import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useSelectedProject } from "@renderer/hooks/use-selected-project";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";

/** Status picker chip: filter-chip styling, options from `TICKET_STATUSES`. */
function StatusPicker({
  status,
  onChange,
}: {
  status: TicketStatus;
  onChange(status: TicketStatus): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
        >
          {TICKET_STATUS_LABELS[status]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={status}
          onValueChange={(value) => onChange(value as TicketStatus)}
        >
          {TICKET_STATUSES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {TICKET_STATUS_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Priority picker chip: filter-chip styling, options from `TICKET_PRIORITIES`.
 * Renders the same {@link PriorityIndicator} bar signal the cards use, both in
 * the trigger (next to the current label) and beside each option.
 */
function PriorityPicker({
  priority,
  onChange,
}: {
  priority: TicketPriority;
  onChange(priority: TicketPriority): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground"
        >
          <PriorityIndicator priority={priority} />
          {TICKET_PRIORITY_LABELS[priority]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={priority}
          onValueChange={(value) => onChange(value as TicketPriority)}
        >
          {TICKET_PRIORITIES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <PriorityIndicator priority={option} />
              {TICKET_PRIORITY_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The dialog body: title input, status/priority chips, and the Create action.
 * Its `useState` hooks are the "field state" the module doc below refers to —
 * they live here, in the component Radix conditionally mounts, rather than in
 * {@link NewTicketDialog} itself (which stays mounted app-wide), so every open
 * starts from a blank composer.
 */
function NewTicketForm({ project }: { project: Project }) {
  const [title, setTitle] = React.useState("");
  const [status, setStatus] = React.useState<TicketStatus>("backlog");
  const [priority, setPriority] = React.useState<TicketPriority>("medium");
  const [submitting, setSubmitting] = React.useState(false);
  const trimmedTitle = title.trim();

  async function submit() {
    // `submitting` guards against a second Enter (key auto-repeat) or an
    // Enter-then-click landing inside the pending create round-trip, which
    // would otherwise create two identical tickets.
    if (trimmedTitle === "" || submitting) return;
    setSubmitting(true);
    const ticket = await useBoardStore
      .getState()
      .addTicket(project.id, status, title, { priority });
    if (ticket === null) {
      // Creation failed (already toasted by the store) — keep the dialog open
      // with the composed title/status/priority so the user can retry without
      // retyping (Radix unmounts the form on close, discarding that state).
      setSubmitting(false);
      return;
    }
    // This dialog is reachable from pages (Files/Sessions) where the board
    // itself isn't on screen, so the toast is the only confirmation the user
    // gets that the ticket was created. Closing unmounts the form, so no need
    // to reset `submitting`.
    toast.success(`${displayTicketId(project.ticketPrefix, ticket.ticketNumber)} created`);
    useUiStore.getState().setNewTicketOpen(false);
  }

  function handleTitleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New ticket</DialogTitle>
        <DialogDescription>Creating in {project.name}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        <input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleTitleKeyDown}
          placeholder="Ticket title…"
          className="w-full border-none bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-2">
          <StatusPicker status={status} onChange={setStatus} />
          <PriorityPicker priority={priority} onChange={setPriority} />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={() => void submit()} disabled={trimmedTitle === "" || submitting}>
          Create
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The globally reachable create-ticket dialog: opened by the board header's
 * "New ticket" button or the plain "c" hotkey (see
 * hooks/use-new-ticket-shortcut.ts), from anywhere a project is selected —
 * not just the board page. Controlled entirely by the ui store's
 * `newTicketOpen` flag; `open` also requires a selected project, since there
 * is nowhere to create the ticket without one. Escape and overlay-click close
 * come free from Radix via `onOpenChange`.
 */
export function NewTicketDialog() {
  const project = useSelectedProject();
  const newTicketOpen = useUiStore((state) => state.newTicketOpen);
  const open = newTicketOpen && project !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) useUiStore.getState().setNewTicketOpen(false);
      }}
    >
      <DialogContent>{project !== null && <NewTicketForm project={project} />}</DialogContent>
    </Dialog>
  );
}
