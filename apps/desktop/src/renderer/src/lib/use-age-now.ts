import { useCallback, useEffect, useState } from "react";

import { delayUntil } from "./boundary-timer";
import { nextAgeChangeAt } from "./relative-time";

/** A list's clock stays behind the wall clock until its next visible boundary. */
export function useBoundaryClock(): readonly [now: number, wake: () => void] {
  const [now, setNow] = useState(() => Date.now());
  const wake = useCallback(() => setNow(Date.now()), []);
  return [now, wake];
}

/**
 * Schedule one timeout after deriving rows against the same clock. A roster's
 * status boundary shares that timeout with its visible age stamps. Callers
 * omit folded/filtered-out ages, but keep statuses that can affect filtering.
 */
export function useAgeBoundaryTimer(
  timestamps: readonly number[],
  [now, wake]: ReturnType<typeof useBoundaryClock>,
  statusBoundaryAt: number | null = null,
): void {
  let nextBoundaryAt = statusBoundaryAt;
  for (const timestamp of timestamps) {
    const at = nextAgeChangeAt(timestamp, now);
    nextBoundaryAt = nextBoundaryAt === null ? at : Math.min(nextBoundaryAt, at);
  }

  useEffect(() => {
    if (nextBoundaryAt === null) return;
    // A newly visible row may already be past this stale clock's boundary.
    // delayUntil clamps it to the next tick, where wake catches up once.
    const timer = window.setTimeout(wake, delayUntil(nextBoundaryAt));
    return () => window.clearTimeout(timer);
    // now also re-arms a clamped long wait when the boundary is unchanged.
  }, [nextBoundaryAt, now, wake]);
}

/** One clock and one boundary timeout for a list showing only relative ages. */
export function useAgeNow(timestamps: readonly number[]): number {
  const clock = useBoundaryClock();
  useAgeBoundaryTimer(timestamps, clock);
  return clock[0];
}
