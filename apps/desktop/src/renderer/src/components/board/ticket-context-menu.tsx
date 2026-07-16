import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
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
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
} from "@volli/shared";

import { ConfirmCloseDialog } from "@renderer/components/sessions/confirm-close-dialog";
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
import { useBoardStore } from "@renderer/stores/board";
import { sessionPanes, useSessionsStore } from "@renderer/stores/sessions";
import { useCloseGuard } from "@renderer/terminal/close-guard";

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

  return (
    <>
      <ContextMenu>
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
    </>
  );
}
