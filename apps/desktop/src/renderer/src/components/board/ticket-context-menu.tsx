import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type Ticket,
} from "@volli/shared";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useBoardStore } from "@renderer/stores/board";

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
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {TICKET_STATUSES.filter((status) => status !== ticket.status).map((status) => (
              <ContextMenuItem
                key={status}
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
          <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {TICKET_PRIORITIES.map((priority) => (
              <ContextMenuItem
                key={priority}
                onSelect={() =>
                  useBoardStore.getState().setTicketPriority(projectId, ticket.id, priority)
                }
              >
                <span className="flex size-3.5 items-center justify-center">
                  {priority === ticket.priority ? (
                    <CheckIcon weight="bold" className="size-3.5" />
                  ) : null}
                </span>
                {TICKET_PRIORITY_LABELS[priority]}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
