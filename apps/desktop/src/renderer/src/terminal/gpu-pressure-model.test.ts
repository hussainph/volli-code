import { describe, expect, it, vi } from "vite-plus/test";

import { polledBackend, sameGpuState } from "./engine";
import { createGpuPressureTracker, gpuPressureOf } from "./gpu-pressure-model";
import type { TerminalBackend, TerminalGpuState } from "./engine";

/** An engine with a live renderer reporting `backend`. */
const live = (backend: TerminalBackend | null) => ({ hasRenderer: true, backend });
/** An engine that has never been attached — a headless session's, say. */
const headless = { hasRenderer: false, backend: null };

/**
 * Stands in for a live engine: renderer liveness, a backend that resolves, and
 * an event. Mirrors ResttyEngine's real lifecycle — an engine exists BEFORE its
 * renderer does (`getOrCreateEngine` only makes the host element; `attach`
 * creates the renderer), and `dispose` destroys the renderer before announcing
 * the released state.
 *
 * The dedupe is `sameGpuState`, the PRODUCTION rule, not a re-implementation of
 * it: an engine that announces every call unconditionally is a fake with a
 * guarantee the real one doesn't have, and it would pass the rebuild case below
 * no matter what the rule said.
 */
class FakeEngine {
  private readonly listeners = new Set<(state: TerminalGpuState) => void>();
  private announced: TerminalGpuState;

  /** `hasRenderer` defaults true: most cases are about an attached terminal. */
  constructor(
    public backend: TerminalBackend | null = null,
    public hasRenderer = true,
  ) {
    this.announced = { hasRenderer, backend };
  }

  onGpuStateChanged(listener: (state: TerminalGpuState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Create the renderer, as `attach` does for a never-attached engine — and
   *  as `rebuildRenderer` does for the second half of a device-loss recovery. */
  attach(): void {
    this.hasRenderer = true;
    this.announce();
  }

  /** Resolve (or, with null, un-resolve on a rebuild) and announce it. */
  resolve(backend: TerminalBackend | null): void {
    this.backend = backend;
    this.announce();
  }

  /** The device-loss rebuild's teardown half: the renderer is destroyed and the
   *  backend goes back to unresolved, both before anything is re-created. */
  tearDownRenderer(): void {
    this.hasRenderer = false;
    this.resolve(null);
  }

  /** Destroy the renderer, then announce the released state — the real
   *  engine's dispose order, so the announcement is already truthful. */
  dispose(): void {
    this.tearDownRenderer();
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private announce(): void {
    const state: TerminalGpuState = { hasRenderer: this.hasRenderer, backend: this.backend };
    if (sameGpuState(state, this.announced)) return;
    this.announced = state;
    const snapshot = [...this.listeners];
    for (const listener of snapshot) listener(state);
  }
}

/** Stands in for the engine registry's read seam. */
class FakeRegistry {
  private readonly engines: FakeEngine[] = [];
  private readonly listeners = new Set<() => void>();

  readonly liveEngines = (): readonly FakeEngine[] => this.engines;

  readonly onLiveEnginesChanged = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  add(engine: FakeEngine): void {
    this.engines.push(engine);
    this.announce();
  }

  membershipListenerCount(): number {
    return this.listeners.size;
  }

  /**
   * The real `disposeEngine` order: forget it, dispose it (which announces the
   * released backend), then announce membership. Splicing after the dispose —
   * or never disposing at all — would let this fake pass on guarantees
   * production doesn't have.
   */
  remove(engine: FakeEngine): void {
    this.engines.splice(this.engines.indexOf(engine), 1);
    engine.dispose();
    this.announce();
  }

  private announce(): void {
    const snapshot = [...this.listeners];
    for (const listener of snapshot) listener();
  }
}

describe("gpuPressureOf", () => {
  it("holds nothing when no terminal is alive", () => {
    expect(gpuPressureOf([])).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });
  });

  it("charges every WebGPU terminal to the one shared device", () => {
    expect(gpuPressureOf([live("webgpu")])).toEqual({
      liveContexts: 1,
      anyWebgl2: false,
      pending: 0,
    });
    expect(gpuPressureOf([live("webgpu"), live("webgpu"), live("webgpu"), live("webgpu")])).toEqual(
      {
        liveContexts: 1,
        anyWebgl2: false,
        pending: 0,
      },
    );
  });

  it("charges every WebGL2 terminal its own context and raises the block flag", () => {
    expect(gpuPressureOf([live("webgl2"), live("webgl2"), live("webgl2")])).toEqual({
      liveContexts: 3,
      anyWebgl2: true,
      pending: 0,
    });
  });

  it("adds the shared WebGPU device to the fallback terminals' own contexts", () => {
    expect(gpuPressureOf([live("webgpu"), live("webgl2"), live("webgpu"), live("webgl2")])).toEqual(
      {
        liveContexts: 3,
        anyWebgl2: true,
        pending: 0,
      },
    );
  });

  it("counts an unresolved terminal's context but never lets it claim the fallback", () => {
    expect(gpuPressureOf([live(null), live(null)])).toEqual({
      liveContexts: 2,
      anyWebgl2: false,
      pending: 2,
    });
    expect(gpuPressureOf([live("webgpu"), live(null)])).toEqual({
      liveContexts: 2,
      anyWebgl2: false,
      pending: 1,
    });
  });

  // An engine exists before its renderer does, and a headless session's engine
  // may never get one at all. It holds no context and is waiting for nothing —
  // charging it both would refuse a caller a context while everything is free,
  // AND leave `pending` at a number that never comes down.
  it("charges nothing to an engine whose renderer was never created", () => {
    expect(gpuPressureOf([headless, headless])).toEqual({
      liveContexts: 0,
      anyWebgl2: false,
      pending: 0,
    });
    expect(gpuPressureOf([live("webgl2"), headless])).toEqual({
      liveContexts: 1,
      anyWebgl2: true,
      pending: 0,
    });
  });

  // Both backends failed to initialise and the renderer ANNOUNCED it and went
  // ready anyway. It holds nothing, and — the point — it is DONE: `pending`
  // drains. Only an engine that heard the renderer's `backend` event ever
  // reaches this state; the case below is why that distinction is load-bearing.
  it("treats a renderer that announced no backend at all as resolved and holding nothing", () => {
    expect(gpuPressureOf([live("none")])).toEqual({
      liveContexts: 0,
      anyWebgl2: false,
      pending: 0,
    });
    expect(gpuPressureOf([live("webgpu"), live("none"), live(null)])).toEqual({
      liveContexts: 2,
      anyWebgl2: false,
      pending: 1,
    });
  });

  // REGRESSION. restty's runtime state is born holding backend "none" and is
  // only overwritten inside async init, so between `attach()` and the first
  // `backend` event every freshly-attached engine polls as "none" while it is
  // in fact racing for a GPU context. Read as resolved, four attaching
  // terminals report zero contexts held and nothing worth waiting for —
  // exactly the free-capacity lie that walks a caller into Chrome's context
  // eviction. `polledBackend` is what stands between the poll and this reading,
  // so compose the two rather than trusting the counting rule alone.
  it("counts a freshly-attached engine as pending, not as resolved-zero", () => {
    const justAttached = live(polledBackend("none"));

    expect(justAttached.backend).toBeNull();
    expect(gpuPressureOf([justAttached])).toEqual({
      liveContexts: 1,
      anyWebgl2: false,
      pending: 1,
    });
    expect(gpuPressureOf([justAttached, justAttached, justAttached, justAttached])).toEqual({
      liveContexts: 4,
      anyWebgl2: false,
      pending: 4,
    });
  });
});

describe("createGpuPressureTracker", () => {
  it("reads the pressure of whatever engines the registry currently holds", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);

    expect(tracker.current()).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });

    registry.add(new FakeEngine("webgl2"));
    expect(tracker.current()).toEqual({ liveContexts: 1, anyWebgl2: true, pending: 0 });
  });

  it("announces a terminal arriving, resolving its backend, and going away", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const seen = vi.fn();
    tracker.subscribe(seen);

    const engine = new FakeEngine();
    registry.add(engine);
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 1, anyWebgl2: false, pending: 1 });

    engine.resolve("webgl2");
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 1, anyWebgl2: true, pending: 0 });

    // Removal publishes twice — once from the dying engine's own backend
    // announcement, once from the membership change — but both readings agree,
    // and neither counts the terminal that just went away.
    registry.remove(engine);
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 0, anyWebgl2: false, pending: 0 });
    expect(seen.mock.calls.slice(2).flat()).toEqual([
      { liveContexts: 0, anyWebgl2: false, pending: 0 },
      { liveContexts: 0, anyWebgl2: false, pending: 0 },
    ]);
  });

  // The regression the old fake hid: `disposeEngine` disposes the engine — which
  // announces its released backend — and only THEN announces membership, so for
  // one event the reading is taken while a destroyed terminal is still listed.
  it("never publishes a phantom reading when a dying engine announces before the registry drops it", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const engine = new FakeEngine();
    registry.add(engine);
    engine.resolve("webgl2");
    const seen = vi.fn();
    tracker.subscribe(seen);

    engine.dispose();
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 0, anyWebgl2: false, pending: 0 });

    registry.remove(engine);
    for (const [pressure] of seen.mock.calls) {
      expect(pressure).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });
    }
  });

  // A headless session's engine is created at boot and may never host a view,
  // so its renderer is never created. It must cost nothing and — the part that
  // used to strand callers — must not sit in `pending` forever.
  it("charges nothing for a session whose view never mounted", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const engine = new FakeEngine(null, false);

    registry.add(engine);
    expect(tracker.current()).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });

    engine.attach();
    expect(tracker.current()).toEqual({ liveContexts: 1, anyWebgl2: false, pending: 1 });

    // Neither backend initialised, and the renderer went ready anyway: pending
    // drains rather than hanging on an answer that already came.
    engine.resolve("none");
    expect(tracker.current()).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });
  });

  it("goes quiet for an unsubscribed reader and for a terminal it no longer holds", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const seen = vi.fn();
    const unsubscribe = tracker.subscribe(seen);

    const kept = new FakeEngine();
    const dropped = new FakeEngine();
    registry.add(kept);
    registry.add(dropped);
    registry.remove(dropped);
    seen.mockClear();

    expect(dropped.listenerCount()).toBe(0);
    dropped.resolve("webgl2");
    expect(seen).not.toHaveBeenCalled();

    kept.resolve("webgpu");
    expect(seen).toHaveBeenCalledOnce();

    unsubscribe();
    kept.resolve("webgl2");
    expect(seen).toHaveBeenCalledOnce();
  });

  // Observation must never perturb what it observes: this fan-out runs inside a
  // dying engine's dispose, so an escaping throw would abort that teardown and
  // leak the context the reader was asking about.
  it("keeps serving every other reader when one of them throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const failure = new Error("reader is broken");
    const before = vi.fn();
    const after = vi.fn();
    tracker.subscribe(before);
    tracker.subscribe(() => {
      throw failure;
    });
    tracker.subscribe(after);

    const engine = new FakeEngine();
    expect(() => registry.add(engine)).not.toThrow();

    expect(before).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith("gpu pressure listener failed:", failure);
  });

  // A reader that drops out on the reading it just received mutates the live
  // listener set mid-walk; iterating it directly would skip its neighbour.
  it("still reaches the neighbour of a reader that unsubscribes mid-reading", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const neighbour = vi.fn();
    const unsubscribe = tracker.subscribe(() => {
      unsubscribe();
    });
    tracker.subscribe(neighbour);

    registry.add(new FakeEngine("webgpu"));

    expect(neighbour).toHaveBeenCalledOnce();
  });

  // A tracker subscribes for its whole life otherwise. Without a teardown every
  // renderer-HMR re-evaluation of gpu-pressure.ts leaves the previous tracker
  // still folding the live engine set, and every test leaves listeners behind on
  // the engines it watched.
  it("lets go of the registry and every engine when torn down", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const seen = vi.fn();
    tracker.subscribe(seen);
    const watched = new FakeEngine();
    registry.add(watched);
    seen.mockClear();

    tracker.dispose();

    expect(registry.membershipListenerCount()).toBe(0);
    expect(watched.listenerCount()).toBe(0);

    watched.resolve("webgl2");
    registry.add(new FakeEngine("webgl2"));
    expect(seen).not.toHaveBeenCalled();
  });

  // REGRESSION. The engine used to announce `backend` alone, and to dedupe on
  // `backend` alone — so a device-loss rebuild that starts and ends unresolved
  // was completely silent. That is not an exotic case: `polledBackend` folds
  // restty's birth-state "none" to null, so an engine rebuilt before (or
  // instead of) resolving reads null on both sides of the whole teardown and
  // re-creation. Renderer presence, meanwhile, went false→true→false→true. The
  // pushed reading stayed frozen at the pre-crash value until some unrelated
  // engine's event happened to jog the tracker; only a `current()` pull was
  // ever right, which is exactly the bug a pushed reading exists to prevent.
  it("still reports a device-loss rebuild that lands on the same backend it left", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const engine = new FakeEngine();
    registry.add(engine);
    const seen = vi.fn();
    tracker.subscribe(seen);

    engine.tearDownRenderer();
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 0, anyWebgl2: false, pending: 0 });

    engine.attach();
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 1, anyWebgl2: false, pending: 1 });

    // Both halves were heard, and `backend` never moved off null to carry them.
    expect(seen).toHaveBeenCalledTimes(2);
    expect(engine.backend).toBeNull();
  });

  it("shows a device-loss rebuild as every terminal going unresolved and back", () => {
    const registry = new FakeRegistry();
    const tracker = createGpuPressureTracker(registry);
    const engines = [new FakeEngine(), new FakeEngine()];
    for (const engine of engines) registry.add(engine);
    for (const engine of engines) engine.resolve("webgpu");
    expect(tracker.current()).toEqual({ liveContexts: 1, anyWebgl2: false, pending: 0 });

    // The registry rebuilds every renderer against the fresh session.
    for (const engine of engines) engine.resolve(null);
    expect(tracker.current()).toEqual({ liveContexts: 2, anyWebgl2: false, pending: 2 });

    for (const engine of engines) engine.resolve("webgpu");
    expect(tracker.current()).toEqual({ liveContexts: 1, anyWebgl2: false, pending: 0 });
  });
});
