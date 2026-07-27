/**
 * How much GPU the terminals are holding, for callers deciding whether they
 * can afford one more context. Import THIS, never the engine registry: the
 * registry's shape is an implementation detail, and the counting rule (see
 * gpu-pressure-model.ts) is the only part a caller should have to agree with.
 *
 * Why anyone asks: Chrome caps live WebGL contexts at ~16 and evicts the
 * OLDEST on overflow. On the WebGL2 fallback each terminal holds its own
 * context, so the one Chrome kills is most likely the user's primary working
 * session — and the app's device-loss recovery would paper over it well
 * enough that nobody would trace the dead terminal back to whatever spent the
 * context. `anyWebgl2` is the flag that says "don't".
 */
import { createGpuPressureTracker, type GpuPressure } from "./gpu-pressure-model";
import { liveEngines, onLiveEnginesChanged } from "./registry";

export type { GpuPressure };

const tracker = createGpuPressureTracker({ liveEngines, onLiveEnginesChanged });

// The registry outlives this module: Vite re-evaluates it on every renderer HMR
// edit, and without a teardown each outgoing tracker keeps its registry
// subscription and one per engine forever — so every edit adds another stale
// reader recomputing over the live engine set on every gpu-state event.
import.meta.hot?.dispose(() => {
  tracker.dispose();
});

/** A reading taken right now. */
export function currentGpuPressure(): GpuPressure {
  return tracker.current();
}

/**
 * Subscribe to pressure changes — a terminal opening or closing, one resolving
 * its backend, or one losing and rebuilding its renderer after a GPU device
 * loss. Returns the unsubscribe function.
 */
export function subscribeGpuPressure(listener: (pressure: GpuPressure) => void): () => void {
  return tracker.subscribe(listener);
}
