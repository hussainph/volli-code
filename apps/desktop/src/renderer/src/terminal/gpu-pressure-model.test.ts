import { describe, expect, it, vi } from "vite-plus/test";

import { createGpuPressureTracker, gpuPressureOf } from "./gpu-pressure-model";
import type { TerminalBackend } from "./engine";

/** Stands in for a live engine: a backend that resolves, and an event. */
class FakeEngine {
  private readonly listeners = new Set<(backend: TerminalBackend | null) => void>();

  constructor(public backend: TerminalBackend | null = null) {}

  onBackendChanged(listener: (backend: TerminalBackend | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolve (or, with null, un-resolve on a rebuild) and announce it. */
  resolve(backend: TerminalBackend | null): void {
    this.backend = backend;
    for (const listener of this.listeners) listener(backend);
  }

  listenerCount(): number {
    return this.listeners.size;
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

  remove(engine: FakeEngine): void {
    this.engines.splice(this.engines.indexOf(engine), 1);
    this.announce();
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

describe("gpuPressureOf", () => {
  it("holds nothing when no terminal is alive", () => {
    expect(gpuPressureOf([])).toEqual({ liveContexts: 0, anyWebgl2: false, pending: 0 });
  });

  it("charges every WebGPU terminal to the one shared device", () => {
    expect(gpuPressureOf(["webgpu"])).toEqual({
      liveContexts: 1,
      anyWebgl2: false,
      pending: 0,
    });
    expect(gpuPressureOf(["webgpu", "webgpu", "webgpu", "webgpu"])).toEqual({
      liveContexts: 1,
      anyWebgl2: false,
      pending: 0,
    });
  });

  it("charges every WebGL2 terminal its own context and raises the block flag", () => {
    expect(gpuPressureOf(["webgl2", "webgl2", "webgl2"])).toEqual({
      liveContexts: 3,
      anyWebgl2: true,
      pending: 0,
    });
  });

  it("adds the shared WebGPU device to the fallback terminals' own contexts", () => {
    expect(gpuPressureOf(["webgpu", "webgl2", "webgpu", "webgl2"])).toEqual({
      liveContexts: 3,
      anyWebgl2: true,
      pending: 0,
    });
  });

  it("counts an unresolved terminal's context but never lets it claim the fallback", () => {
    expect(gpuPressureOf([null, null])).toEqual({
      liveContexts: 2,
      anyWebgl2: false,
      pending: 2,
    });
    expect(gpuPressureOf(["webgpu", null])).toEqual({
      liveContexts: 2,
      anyWebgl2: false,
      pending: 1,
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

    registry.remove(engine);
    expect(seen).toHaveBeenLastCalledWith({ liveContexts: 0, anyWebgl2: false, pending: 0 });
    expect(seen).toHaveBeenCalledTimes(3);
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
