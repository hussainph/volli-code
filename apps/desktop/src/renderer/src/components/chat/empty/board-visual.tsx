/**
 * BOARD — the project's five columns, in proportion (VC-55).
 *
 * The other field only a Project Session can draw: a ticket chat has one
 * ticket, and one ticket in one column is not a distribution. Home's chat sits
 * one tab away from the board itself, so this is the same object seen from the
 * orchestrator's side — how much is waiting, how much is moving, how much is
 * finished.
 *
 * The hues are FANNED off the live primary rather than picked, so the chart is
 * themed rather than painted (CLAUDE.md: color tokens are generated). Peers,
 * not a scale: lightness and chroma are held, so no column outranks another by
 * being drawn heavier.
 */
import { TICKET_STATUS_LABELS, TICKET_STATUSES } from "@volli/shared";
import { useShallow } from "zustand/react/shallow";

import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useSeriesColors } from "@renderer/hooks/use-chart-palette";
import { useBoardStore } from "@renderer/stores/board";

/** Tallest bar, in pixels. Sized against the streak grid beside it in the same slot. */
const PEAK_HEIGHT = 68;

/**
 * The floor a non-empty column draws at, so "one ticket" is a mark rather than
 * a hairline nobody can hit with a pointer.
 */
const MIN_HEIGHT = 3;

export function BoardVisual({ projectId }: { projectId: string }) {
  const counts = useBoardStore(
    useShallow((state) => {
      const tickets = state.ticketsByProject[projectId] ?? [];
      return TICKET_STATUSES.map(
        (status) => tickets.filter((ticket) => ticket.status === status).length,
      );
    }),
  );
  const colors = useSeriesColors(TICKET_STATUSES.length);
  const peak = Math.max(...counts, 1);
  const total = counts.reduce((sum, count) => sum + count, 0);

  return (
    <div className="flex flex-col items-center gap-4" data-empty-visual="board">
      <div
        className="flex h-24 w-80 items-end gap-2"
        role="img"
        aria-label={`${total} tickets across the board`}
      >
        {TICKET_STATUSES.map((status, index) => {
          const count = counts[index] ?? 0;
          return (
            <Tooltip key={status}>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 cursor-default flex-col items-center gap-1">
                  <span className="text-ui text-muted-foreground tabular-nums">{count}</span>
                  <span
                    className="w-full rounded-md bg-muted"
                    style={
                      count === 0
                        ? { height: `${MIN_HEIGHT}px` }
                        : {
                            height: `${Math.max(MIN_HEIGHT, (count / peak) * PEAK_HEIGHT)}px`,
                            backgroundColor: colors[index],
                            opacity: 0.85,
                          }
                    }
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {count} in {TICKET_STATUS_LABELS[status]}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex w-80 gap-2">
        {TICKET_STATUSES.map((status) => (
          <span
            key={status}
            className="min-w-0 flex-1 truncate text-center text-label uppercase text-muted-foreground"
          >
            {TICKET_STATUS_LABELS[status]}
          </span>
        ))}
      </div>
    </div>
  );
}
