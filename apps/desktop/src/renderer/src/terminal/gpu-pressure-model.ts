/**
 * The pure half of the GPU-pressure seam (gpu-pressure.ts wires it to the
 * engine registry). Kept renderer-free so the counting rule — the part with
 * real consequences — is testable without a DOM.
 */
import type { TerminalBackend } from "./engine";

/** What the terminals collectively cost the GPU right now. */
export type GpuPressure = {
  /** GPU contexts actually held across every live terminal. */
  liveContexts: number;
  /** Any terminal on the WebGL2 fallback. */
  anyWebgl2: boolean;
  /** Engines whose backend hasn't resolved yet. */
  pending: number;
};

/**
 * The counting rule. WebGPU engines all render through the one runtime
 * session (gpu-session.ts), so however many there are they cost ONE context
 * between them; on the WebGL2 fallback each engine owns its own canvas and
 * therefore its own context, so they cost one apiece.
 *
 * An unresolved engine will hold at least one context, so it counts as one —
 * but it must not set `anyWebgl2`. Overstating contexts only makes a caller
 * degrade early, which is cheap; asserting a fallback that may not exist
 * hard-blocks on a maybe, which isn't. Callers that can afford to wait have
 * `pending` to wait on.
 */
export function gpuPressureOf(backends: readonly (TerminalBackend | null)[]): GpuPressure {
  let webgpu = 0;
  let webgl2 = 0;
  let pending = 0;
  for (const backend of backends) {
    if (backend === "webgpu") webgpu += 1;
    else if (backend === "webgl2") webgl2 += 1;
    else pending += 1;
  }
  return {
    liveContexts: (webgpu > 0 ? 1 : 0) + webgl2 + pending,
    anyWebgl2: webgl2 > 0,
    pending,
  };
}

/** The slice of an engine gpu pressure reads — see `TerminalEngine`. */
export interface BackendReporter {
  readonly backend: TerminalBackend | null;
  onBackendChanged(listener: (backend: TerminalBackend | null) => void): () => void;
}

/** The slice of the engine registry gpu pressure reads — see `registry.ts`. */
export interface BackendReporterRegistry {
  liveEngines(): readonly BackendReporter[];
  onLiveEnginesChanged(listener: () => void): () => void;
}

export interface GpuPressureTracker {
  current(): GpuPressure;
  subscribe(listener: (pressure: GpuPressure) => void): () => void;
}

/**
 * Fold a registry of engines into one observable pressure reading. Taking the
 * registry as an argument (rather than importing it) is what keeps the rule
 * above testable — gpu-pressure.ts supplies the real one.
 */
export function createGpuPressureTracker(registry: BackendReporterRegistry): GpuPressureTracker {
  const listeners = new Set<(pressure: GpuPressure) => void>();
  let engineSubscriptions: (() => void)[] = [];

  const current = (): GpuPressure =>
    gpuPressureOf(registry.liveEngines().map((engine) => engine.backend));

  // Snapshot + per-listener catch. Reading pressure must never perturb what it
  // observes: this fan-out runs INSIDE an engine's dispose (via its backend
  // event), so a throwing reader would abort that teardown — leaking the very
  // GPU context it was asking about. A reader that unsubscribes itself here
  // must likewise not cost its neighbour a reading.
  const notify = (): void => {
    const pressure = current();
    const readers = [...listeners];
    for (const listener of readers) {
      try {
        listener(pressure);
      } catch (error) {
        console.warn("gpu pressure listener failed:", error);
      }
    }
  };

  // Backend resolution is per-engine, so the membership event alone would miss
  // it. Re-attach from scratch on every membership change: a disposed engine
  // must not keep a subscription alive, and a new one must be heard from.
  const rewire = (): void => {
    for (const unsubscribe of engineSubscriptions) unsubscribe();
    engineSubscriptions = registry.liveEngines().map((engine) => engine.onBackendChanged(notify));
  };

  registry.onLiveEnginesChanged(() => {
    rewire();
    notify();
  });
  rewire();

  return {
    current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
