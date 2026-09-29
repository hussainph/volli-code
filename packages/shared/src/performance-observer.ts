/**
 * The two rules every optional performance tap on the Session edge obeys
 * (VC-355).
 *
 * The renderer link and the main-side router each measure one half of the same
 * round trip with their own sample shapes. What they must NOT have their own
 * version of is what to do when measurement itself misbehaves, because a
 * disagreement there shows up as a difference in the published numbers rather
 * than as a failure:
 *
 * 1. A clock endpoint that throws yields no reading, and a sample missing an
 *    endpoint is dropped rather than reported with a plausible-looking zero. A
 *    zero-duration round trip is indistinguishable from a very fast one, so
 *    publishing it would quietly drag every percentile down.
 * 2. An observer that throws never changes the path it observes.
 */

/** An optional clock endpoint; absent means "use the ambient one". */
export interface OptionalPerformanceClock {
  now?(): number;
}

/**
 * Reads a tap's clock, or `null` when no trustworthy reading is available.
 * Callers pair two readings and skip the sample unless both are numbers.
 */
export function readOptionalPerformanceClock(
  observer: OptionalPerformanceClock | undefined,
): number | null {
  if (!observer) return null;
  try {
    return observer.now?.() ?? performance.now();
  } catch {
    return null;
  }
}

/** Runs a measurement side effect with its failure isolated from the caller. */
export function isolatePerformanceObserver(record: () => void): void {
  try {
    record();
  } catch {
    // Measurement is optional and must not change what it measures.
  }
}
