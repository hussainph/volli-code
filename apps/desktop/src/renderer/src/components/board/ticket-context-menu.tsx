import * as React from "react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { CellSignalHighIcon } from "@phosphor-icons/react/dist/csr/CellSignalHigh";
import { CellSignalLowIcon } from "@phosphor-icons/react/dist/csr/CellSignalLow";
import { CellSignalMediumIcon } from "@phosphor-icons/react/dist/csr/CellSignalMedium";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { FlagIcon } from "@phosphor-icons/react/dist/csr/Flag";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { PlayCircleIcon } from "@phosphor-icons/react/dist/csr/PlayCircle";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type SessionRecord,
  type Ticket,
} from "@volli/shared";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
import { resumeTicketSession } from "@renderer/components/sessions/session-create";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { RemoveWorktreeDialog } from "@renderer/components/ticket/remove-worktree-dialog";
import { latestResumableSession } from "@renderer/components/ticket/session-history";
import { useBoardStore } from "@renderer/stores/board";
import { sessionPanes, ticketScope, useSessionsStore } from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useCloseGuard } from "@renderer/terminal/close-guard";

/** Stable empty array so the per-card session-records selector never forces a
 *  re-render of every OTHER card's menu when one ticket's cache is touched. */
const NO_RECORDS: readonly SessionRecord[] = [];

const STATUS_ICON = {
  backlog: TrayIcon,
  todo: ListChecksIcon,
  doing: PlayCircleIcon,
  needs_review: EyeIcon,
  done: CheckCircleIcon,
} as const;

const PRIORITY_ICON = {
  low: CellSignalLowIcon,
  medium: CellSignalMediumIcon,
  high: CellSignalHighIcon,
} as const;

/**
 * The non-destructive ticket context menu (Move to · Priority), shared by the
 * board's cards and the list view's rows so both surfaces stay in lockstep.
 * `children` is the trigger target rendered `asChild` — the card body or list
 * row supplies its own layout and this wraps it with the menu.
 *
 * "Move to" sends the ticket to the end of the target column
 * (`Number.MAX_SAFE_INTEGER`, clamped by the shared `moveTicket` op). Under a
 * non-manual sort the card still snaps to its sorted slot afterward — the same
 * displayed-position-is-sort-driven behavior as a drag drop.
 *
 * "Archive" is non-destructive (CONCEPT #16/#92): the card leaves the board but
 * the ticket, its labels, and its event log survive in the project's Archive,
 * from where it can be restored or — the only destructive act — deleted.
 */
export function TicketContextMenu({
  ticket,
  projectId,
  children,
}: {
  ticket: Ticket;
  projectId: string;
  children: React.ReactNode;
}) {
  // Archiving kills the ticket's live sessions (stores/board.ts), so gate it
  // behind a confirm when any is busy. The dialog is a SIBLING of the menu — the
  // menu unmounts on item select, but this component (and its guard state)
  // survives, so the confirm can open after the menu is gone.
  const closeGuard = useCloseGuard();
  const [removeWorktreeOpen, setRemoveWorktreeOpen] = React.useState(false);

  // Reactive so the item disables the instant a session boots/exits, not just
  // at click time — a live session means an agent may still be mid-edit in the
  // worktree, so removal (even the non-forced path) is refused here rather than
  // racing main's own dirty check.
  const hasLiveSessions = useSessionsStore((state) =>
    (state.byOwner[ticket.id]?.tabs ?? []).some((tab) =>
      sessionPanes(tab.layout).some((pane) => pane.exitCode === null),
    ),
  );

  const requestArchive = () => {
    const container = useSessionsStore.getState().byOwner[ticket.id];
    const liveIds = (container?.tabs ?? []).flatMap((tab) =>
      sessionPanes(tab.layout)
        .filter((pane) => pane.exitCode === null)
        .map((pane) => pane.sessionId),
    );
    closeGuard.guard(
      liveIds,
      () => void useBoardStore.getState().archiveTicket(projectId, ticket.id),
    );
  };

  // Resumability (interrupt/resume, issue #78) needs the ticket's durable
  // session records — the same shared cache the rail and the exited-pane
  // overlay read (stores/ticket-session-records.ts), fetched lazily on menu
  // open rather than eagerly for every card on the board.
  const records = useTicketSessionRecordsStore((state) => state.byTicket[ticket.id] ?? NO_RECORDS);
  const resumableSession = latestResumableSession(records);

  const resumeLastSession = () => {
    if (resumableSession === null) return;
    void resumeTicketSession(ticketScope(projectId, ticket.id), resumableSession.id).then(
      (sessionId) => {
        if (sessionId === null) return;
        useWorkspaceStore.getState().openTicket(projectId, ticket.id);
        useWorkspaceStore.getState().setTicketActiveTab(projectId, ticket.id, sessionId);
      },
    );
  };

  return (
    <>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) void useTicketSessionRecordsStore.getState().refresh(ticket.id);
        }}
      >
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={ArrowsLeftRightIcon}>Move to</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => (
                <ContextMenuItem
                  key={status}
                  icon={STATUS_ICON[status]}
                  onSelect={() =>
                    useBoardStore
                      .getState()
                      .moveTicket(projectId, ticket.id, status, Number.MAX_SAFE_INTEGER)
                  }
                >
                  {TICKET_STATUS_LABELS[status]}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger icon={FlagIcon}>Priority</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {TICKET_PRIORITIES.map((priority) => (
                <ContextMenuItem
                  key={priority}
                  icon={PRIORITY_ICON[priority]}
                  onSelect={() =>
                    useBoardStore.getState().setTicketPriority(projectId, ticket.id, priority)
                  }
                >
                  {TICKET_PRIORITY_LABELS[priority]}
                  {priority === ticket.priority ? (
                    <CheckIcon weight="bold" className="ml-auto size-3.5" />
                  ) : null}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          {resumableSession !== null ? (
            <ContextMenuItem icon={ArrowClockwiseIcon} onSelect={resumeLastSession}>
              Resume last session
            </ContextMenuItem>
          ) : null}
          {ticket.worktreePath !== null ? (
            <ContextMenuItem
              icon={TrashIcon}
              disabled={hasLiveSessions}
              onSelect={() => setRemoveWorktreeOpen(true)}
            >
              Remove worktree…
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem icon={ArchiveIcon} onSelect={requestArchive}>
            Archive
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmCloseDialog
        pending={closeGuard.pending}
        onConfirm={closeGuard.confirm}
        onCancel={closeGuard.cancel}
        title="Archive ticket?"
        confirmLabel="Archive Anyway"
        verb="Archiving"
      />
      {ticket.worktreePath !== null ? (
        <RemoveWorktreeDialog
          ticketId={ticket.id}
          open={removeWorktreeOpen}
          onOpenChange={setRemoveWorktreeOpen}
        />
      ) : null}
    </>
  );
}
