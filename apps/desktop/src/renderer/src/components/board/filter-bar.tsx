import * as React from "react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  distinctLabels,
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
import { PriorityIndicator } from "@renderer/components/board/priority-indicator";
import { Button } from "@renderer/components/ui/button";
import { resolveLabelColor } from "@renderer/lib/labels";
import { cn } from "@renderer/lib/utils";
import { useBoardStore } from "@renderer/stores/board";

// Same 3-bar signal as the cards, so the dropdown reads as the same visual
// language as the board itself.
const PRIORITY_OPTIONS = TICKET_PRIORITIES.map((priority) => ({
  value: priority,
  label: TICKET_PRIORITY_LABELS[priority],
  icon: <PriorityIndicator priority={priority} />,
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

/**
 * Facet chips for the board header. Session-only, store-backed. Search lives
 * in the ChromeBar's universal search pill — this bar is facets only (the
 * filter prop still carries `search` because Clear resets it too, via
 * isFilterActive / clearFilter).
 */
export function FilterBar({ projectId, tickets, filter, className }: FilterBarProps) {
  const projectLabels = useBoardStore((state) => state.labelsByProject[projectId]);
  const labelOptions = React.useMemo(
    () =>
      distinctLabels(tickets).map((label) => ({
        value: label,
        label,
        icon: (
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: resolveLabelColor(projectLabels, label) }}
          />
        ),
      })),
    [tickets, projectLabels],
  );

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>
      <FilterChip
        label="Priority"
        options={PRIORITY_OPTIONS}
        selected={filter.priorities}
        onToggle={(value) =>
          useBoardStore.getState().togglePriority(projectId, value as TicketPriority)
        }
      />
      {labelOptions.length > 0 ? (
        <FilterChip
          label="Label"
          options={labelOptions}
          selected={filter.labels}
          onToggle={(value) => useBoardStore.getState().toggleLabel(projectId, value)}
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
