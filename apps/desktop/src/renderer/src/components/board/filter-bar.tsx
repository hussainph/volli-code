import * as React from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  distinctTags,
  HARNESS_IDS,
  HARNESS_LABELS,
  isFilterActive,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  type Ticket,
  type TicketFilter,
  type TicketPriority,
} from "@volli/shared";

import { FilterChip } from "@renderer/components/board/filter-chip";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

const PRIORITY_OPTIONS = TICKET_PRIORITIES.map((priority) => ({
  value: priority,
  label: TICKET_PRIORITY_LABELS[priority],
}));

const HARNESS_OPTIONS = HARNESS_IDS.map((harnessId) => ({
  value: harnessId,
  label: HARNESS_LABELS[harnessId],
}));

interface FilterBarProps {
  projectId: string;
  /** Unfiltered — facet options (tags) are derived from the full ticket set. */
  tickets: readonly Ticket[];
  filter: TicketFilter;
  className?: string;
}

/** Search + facet chips for the board header. Session-only, store-backed. */
export function FilterBar({ projectId, tickets, filter, className }: FilterBarProps) {
  const tagOptions = React.useMemo(
    () => distinctTags(tickets).map((tag) => ({ value: tag, label: tag })),
    [tickets],
  );

  return (
    <div className={cn("flex flex-none items-center gap-2", className)}>
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filter.search}
          onChange={(event) => useBoardStore.getState().setSearch(projectId, event.target.value)}
          placeholder="Search tickets…"
          className="h-7 w-52 pl-7 pr-7 text-xs"
        />
        {filter.search !== "" ? (
          <button
            type="button"
            onClick={() => useBoardStore.getState().setSearch(projectId, "")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      <FilterChip
        label="Priority"
        options={PRIORITY_OPTIONS}
        selected={filter.priorities}
        onToggle={(value) =>
          useBoardStore.getState().togglePriority(projectId, value as TicketPriority)
        }
      />
      {tagOptions.length > 0 ? (
        <FilterChip
          label="Label"
          options={tagOptions}
          selected={filter.tags}
          onToggle={(value) => useBoardStore.getState().toggleTag(projectId, value)}
        />
      ) : null}
      <FilterChip
        label="Harness"
        options={HARNESS_OPTIONS}
        selected={filter.harnessIds}
        onToggle={(value) => useBoardStore.getState().toggleHarness(projectId, value)}
      />
      {isFilterActive(filter) ? (
        <Button
          variant="ghost"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => useBoardStore.getState().clearFilter(projectId)}
        >
          <XIcon className="size-3" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
