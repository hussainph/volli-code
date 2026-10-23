import { useEffect, useState } from "react";

import { delayUntil } from "./boundary-timer";
import { nextAgeChangeAt } from "./relative-time";

/**
 * One clock per visible list, waking only when a displayed age changes. An
 * optional status boundary lets a roster share this same timeout with its
 * working → idle transition. Callers omit folded/filtered-out stamps.
 */
export function useAgeNow(
  timestamps: readonly number[],
  statusBoundaryAt: number | null = null,
): number {
  const [wakeAt, setWakeAt] = useState(() => Date.now());
  // A new row or an opened fold must read the wall clock even if an empty list
  // has left the stored clock asleep for hours. No follow-up render is needed.
  const now = Date.now();
  let nextBoundaryAt = statusBoundaryAt;
  for (const timestamp of timestamps) {
    const at = nextAgeChangeAt(timestamp, now);
    nextBoundaryAt = nextBoundaryAt === null ? at : Math.min(nextBoundaryAt, at);
  }

  useEffect(() => {
    if (nextBoundaryAt === null) return;
    const timer = window.setTimeout(() => setWakeAt(Date.now()), delayUntil(nextBoundaryAt));
    return () => window.clearTimeout(timer);
    // wakeAt also re-arms a clamped long wait when the boundary is unchanged.
  }, [nextBoundaryAt, wakeAt]);

  return now;
}
