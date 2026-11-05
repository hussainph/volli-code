/**
 * STREAK — every Session ever run in Volli, one cell per day (VC-55).
 *
 * A Home chat opens on a field of many, because that is what a Project
 * Session's scope is: the whole board, every project, all the work. A ticket
 * chat cannot draw this, and that asymmetry is what tells the two kinds apart
 * without a word naming either.
 *
 * ONE TOOLTIP FOR 182 CELLS, driven by event delegation off the grid. A Radix
 * tooltip per cell mounts 182 portal roots for a hint nobody reads twice, and a
 * handler per cell allocates 182 closures per render; the grid reads `data-day`
 * off whatever the pointer is over instead.
 */
import * as React from "react";
import { STREAK_WEEKS, streakGrid, streakStep, streakWindowStart } from "@volli/shared";
import type { StreakDay } from "@volli/shared";

import { useStreakRamp } from "@renderer/hooks/use-chart-palette";
import { useSessionStartsStore } from "@renderer/stores/session-starts";

/** The tooltip's line: how many, and when. */
function dayLabel(day: StreakDay): string {
  const sessions =
    day.count === 0 ? "No sessions" : `${day.count} session${day.count === 1 ? "" : "s"}`;
  const when =
    day.daysAgo === 0 ? "today" : day.daysAgo === 1 ? "yesterday" : `${day.daysAgo} days ago`;
  return `${sessions} · ${when}`;
}

export function StreakVisual() {
  const startedAt = useSessionStartsStore((state) => state.startedAt);
  const refresh = useSessionStartsStore((state) => state.refresh);
  const ramp = useStreakRamp();
  const [hover, setHover] = React.useState<{ day: StreakDay; x: number; y: number } | null>(null);

  // The window is a fact about now, so it is taken once per mount rather than
  // per render — a grid whose first cell slid while the pointer was over it
  // would be a different chart under the same tooltip.
  const [now] = React.useState(() => Date.now());
  React.useEffect(() => {
    void refresh(streakWindowStart(now));
  }, [now, refresh]);

  const grid = React.useMemo(() => streakGrid(startedAt ?? [], now), [startedAt, now]);
  // An unresolved read is not a zero and reserves no chart or skeleton.
  if (startedAt === undefined) return null;

  return (
    <div className="streak-summary" data-empty-visual="streak">
      <div
        className="relative"
        onPointerOver={(event) => {
          const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-day]");
          if (cell === null) return;
          const day = grid.days[Number(cell.dataset.day)];
          if (day === undefined) return;
          const box = cell.getBoundingClientRect();
          const bounds = event.currentTarget.getBoundingClientRect();
          setHover({
            day,
            x: box.left - bounds.left + box.width / 2,
            y: box.top - bounds.top,
          });
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="streak-axis text-label text-muted-foreground">
          <span>{STREAK_WEEKS} weeks</span>
          <span>Today</span>
        </div>
        <div
          className="streak-matrix"
          role="img"
          aria-label={`${grid.total} sessions over ${STREAK_WEEKS} weeks`}
        >
          {grid.days.map((day) => (
            <span
              key={day.index}
              data-day={day.index}
              className="streak-cell rounded-sm"
              style={{ backgroundColor: ramp[streakStep(day.count)] }}
            />
          ))}
        </div>
        {hover === null ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-ui text-popover-foreground shadow-overlay"
            style={{ left: hover.x, top: hover.y - 6 }}
          >
            {dayLabel(hover.day)}
          </div>
        )}
      </div>
      <div className="streak-stats">
        <div>
          <strong className="text-title font-medium tabular-nums">{grid.total}</strong>
          <span className="text-label text-muted-foreground">sessions</span>
        </div>
        <div>
          <strong className="text-title font-medium tabular-nums">{grid.activeDays}</strong>
          <span className="text-label text-muted-foreground">active days</span>
        </div>
        {grid.currentStreak > 0 ? (
          <div>
            <strong className="text-title font-medium tabular-nums">{grid.currentStreak}</strong>
            <span className="text-label text-muted-foreground">day streak</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
