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
  type SessionListingRow,
  type Ticket,
} from "@volli/shared";

import { useTicketDialogs } from "@renderer/components/board/ticket-dialog-host";
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
import { latestResumableSession } from "@renderer/components/ticket/session-history";
import { useBoardStore } from "@renderer/stores/board";
import {
  launchAdapter,
  sessionPanes,
  ticketScope,
  useSessionsStore,
} from "@renderer/stores/sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Stable empty array so the per-card session-records selector never forces a
 *  re-render of every OTHER card's menu when one ticket's cache is touched. */
const NO_ROWS: readonly SessionListingRow[] = [];

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
  // Both confirms live once at board level, not once per card — see
  // ticket-dialog-host.tsx for why, and for how they still open after this menu
  // has unmounted (which every item select does immediately).
  const dialogs = useTicketDialogs();

  // Reactive so the item disables the instant a terminal boots/exits, not just
  // at click time. Terminals ONLY: this store holds PTY panes, and a chat
  // Session never enters it. That is not an omission — a live PTY has a shell
  // sitting in the worktree whatever it is doing, and deleting the directory
  // under it breaks it, which is the same rule main's own guard applies to the
  // terminal half. Whether a CHAT blocks the removal is a question about its
  // Session's open turn, not about a pane, and main answers it (data-ipc.ts's
  // `busyWorktreeSites`) rather than being second-guessed from here.
  const hasLiveTerminals = useSessionsStore((state) =>
    (state.byOwner[ticket.id]?.tabs ?? []).some((tab) =>
      sessionPanes(tab.layout).some((pane) => pane.exitCode === null),
    ),
  );

  // Resumability (interrupt/resume, issue #78) needs the ticket's durable
  // session records — the same shared cache the rail and the exited-pane
  // overlay read (stores/ticket-session-records.ts), fetched lazily on menu
  // open rather than eagerly for every card on the board.
  const rows = useTicketSessionRecordsStore((state) => state.byTicket[ticket.id] ?? NO_ROWS);
  const resumableSession = latestResumableSession(rows, launchAdapter);

  const resumeLastSession = () => {
    if (resumableSession === null) return;
    void resumeTicketSession(ticketScope(projectId, ticket.id), resumableSession.id).then(
      (sessionId) => {
        if (sessionId === null) return;
        // Route through the nav-intent seam so the resumed tab is made visible
        // from any nav — it switches to the Board, opens the ticket detail, and
        // syncs the sessions store's active session — inheriting the nav→board
        // fix instead of hand-rolling openTicket + setTicketActiveTab.
        useWorkspaceStore.getState().openTicketSession(projectId, ticket.id, sessionId);
      },
    );
  };

  return (
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
            disabled={hasLiveTerminals}
            onSelect={() => dialogs.requestRemoveWorktree(ticket.id)}
          >
            Remove worktree…
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem icon={ArchiveIcon} onSelect={() => dialogs.requestArchive(ticket.id)}>
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
