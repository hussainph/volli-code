/**
 * The pure half of the GPU-pressure seam (gpu-pressure.ts wires it to the
 * engine registry). Kept renderer-free so the counting rule — the part with
 * real consequences — is testable without a DOM.
 */
import type { TerminalBackend } from "./engine";

/** What the terminals collectively cost the GPU right now. */
export type GpuPressure = {
  /**
   * GPU contexts actually held right now. Counts only engines with a LIVE
   * renderer: an engine that has never been attached (or is mid-rebuild, or
   * disposed) has asked nothing of the GPU and contributes nothing, and one
   * whose renderer resolved to no backend at all holds nothing either.
   */
  liveContexts: number;
  /** Any terminal on the WebGL2 fallback. */
  anyWebgl2: boolean;
  /**
   * Live renderers still choosing a backend — the only engines a caller can
   * usefully wait on, and therefore guaranteed to drain. An engine with no
   * renderer isn't pending (nothing was asked), and one that resolved to
   * `"none"` isn't either (it answered: nothing).
   */
  pending: number;
};

/** One engine's GPU state, as the counting rule needs to see it. Structurally
 *  a `TerminalEngine` — the two fields together, never `backend` alone. */
export interface EngineGpuState {
  readonly hasRenderer: boolean;
  readonly backend: TerminalBackend | null;
}

/**
 * The counting rule. WebGPU engines all render through the one runtime
 * session (gpu-session.ts), so however many there are they cost ONE context
 * between them; on the WebGL2 fallback each engine owns its own canvas and
 * therefore its own context, so they cost one apiece.
 *
 * An engine with no live renderer is skipped entirely. `backend === null` on
 * such an engine is not a pending answer — nothing has been asked of the GPU
 * yet (a headless session's engine is created at boot and may never host a
 * view). Counting it would report contexts the GPU doesn't hold AND a
 * `pending` that never drains, stranding any caller told to wait on it.
 *
 * A live renderer that resolved to `"none"` also holds nothing, and is done
 * resolving: zero contexts, not pending.
 *
 * A live renderer still resolving will hold at least one context, so it counts
 * as one — but it must not set `anyWebgl2`. Overstating contexts only makes a
 * caller degrade early, which is cheap; asserting a fallback that may not
 * exist hard-blocks on a maybe, which isn't. Callers that can afford to wait
 * have `pending` to wait on.
 */
export function gpuPressureOf(engines: readonly EngineGpuState[]): GpuPressure {
  let webgpu = 0;
  let webgl2 = 0;
  let pending = 0;
  for (const engine of engines) {
    if (!engine.hasRenderer) continue;
    if (engine.backend === "webgpu") webgpu += 1;
    else if (engine.backend === "webgl2") webgl2 += 1;
    else if (engine.backend === null) pending += 1;
    // "none": resolved, and holds nothing.
  }
  return {
    liveContexts: (webgpu > 0 ? 1 : 0) + webgl2 + pending,
    anyWebgl2: webgl2 > 0,
    pending,
  };
}

/** The slice of an engine gpu pressure reads — see `TerminalEngine`. */
export interface BackendReporter extends EngineGpuState {
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

  /**
   * Detach from the registry and from every engine, and drop all readers. A
   * tracker subscribes for its whole life otherwise, which leaks twice: each
   * renderer-HMR re-evaluation of its owning module leaves the outgoing tracker
   * still folding the live engine set, and every test-constructed tracker
   * leaves a listener on the engines it watched.
   */
  dispose(): void;
}

/**
 * Fold a registry of engines into one observable pressure reading. Taking the
 * registry as an argument (rather than importing it) is what keeps the rule
 * above testable — gpu-pressure.ts supplies the real one.
 */
export function createGpuPressureTracker(registry: BackendReporterRegistry): GpuPressureTracker {
  const listeners = new Set<(pressure: GpuPressure) => void>();
  let engineSubscriptions: (() => void)[] = [];

  const current = (): GpuPressure => gpuPressureOf(registry.liveEngines());

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

  const unwatchMembership = registry.onLiveEnginesChanged(() => {
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
    dispose() {
      unwatchMembership();
      for (const unsubscribe of engineSubscriptions) unsubscribe();
      engineSubscriptions = [];
      listeners.clear();
    },
  };
}
