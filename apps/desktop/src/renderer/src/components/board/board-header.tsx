import type { Ticket, TicketFilter } from "@volli/shared";

import { FilterBar } from "@renderer/components/board/filter-bar";

interface BoardHeaderProps {
  projectId: string;
  ticketCount: number;
  /** Unfiltered — passed through to the filter bar for facet options. */
  tickets: readonly Ticket[];
  filter: TicketFilter;
}

/** Compact board page header: title + total ticket count + filter bar. */
export function BoardHeader({ projectId, ticketCount, tickets, filter }: BoardHeaderProps) {
  return (
    <div className="flex items-center gap-3 overflow-x-auto px-4 pt-3 pb-3">
      <h2 className="shrink-0 text-sm font-semibold">Board</h2>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{ticketCount}</span>
      <FilterBar projectId={projectId} tickets={tickets} filter={filter} className="ml-4" />
    </div>
  );
}
