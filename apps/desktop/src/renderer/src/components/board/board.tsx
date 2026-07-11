import { emptyStatuses, groupTicketsByStatus, TICKET_STATUSES } from "@volli/shared";

import { BoardColumn } from "@renderer/components/board/board-column";
import { BoardHeader } from "@renderer/components/board/board-header";
import { CollapsedColumnRail } from "@renderer/components/board/collapsed-column-rail";
import { useBoardStore } from "@renderer/stores/board";

/** The static kanban board: columns scroll vertically, the canvas scrolls horizontally. */
export function Board({ projectId }: { projectId: string; ticketPrefix: string }) {
  const tickets = useBoardStore((state) => state.ticketsByProject[projectId]) ?? [];
  // No filter bar yet — every ticket is visible until that commit lands.
  const visible = tickets;

  const groups = groupTicketsByStatus(visible);
  const hidden = emptyStatuses(visible);
  const shown = TICKET_STATUSES.filter((status) => !hidden.includes(status));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardHeader ticketCount={visible.length} />
      <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pb-4">
        {shown.map((status) => (
          <BoardColumn key={status} status={status} tickets={groups[status]} />
        ))}
        <CollapsedColumnRail statuses={hidden} />
      </div>
    </div>
  );
}
