import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The registry's membership surface — get-or-create, the live list, and the
 * change event — which is what gpu-pressure reads the whole engine set through.
 *
 * Everything the registry touches on import is stubbed: the real engine builds a
 * restty renderer against a GPU (there is no DOM at all under the renderer test
 * project's node environment), and appearance/gpu-session/DPR are module-lifetime
 * subscriptions whose only job here would be to drag restty in. What's left is
 * the part with consequences: which engine a session id maps to, and who hears
 * about it.
 *
 * The registry keeps module-level state, so every case imports a fresh copy
 * rather than sharing (and having to unwind) one map and one listener set.
 */
vi.mock("./appearance", () => ({
  getCurrentAppearance: () => ({}),
  onTerminalAppearanceChanged: () => () => undefined,
}));
vi.mock("./gpu-session", () => ({ onGpuSessionRotated: () => () => undefined }));
vi.mock("./device-pixel-ratio", () => ({ watchDevicePixelRatio: () => () => undefined }));
vi.mock("./restty-engine", () => ({
  // Enough TerminalEngine for the registry, which only ever fits, rebuilds,
  // re-themes and disposes what it holds. `hasRenderer` doubles as the
  // observable "did this actually get disposed?" — it is the seam's own field,
  // so the assertion never reaches past the interface.
  ResttyEngine: class {
    hasRenderer = true;
    backend = null;
    attach = () => undefined;
    write = () => undefined;
    onData = () => () => undefined;
    onResize = () => () => undefined;
    onBackendChanged = () => () => undefined;
    setPaused = () => undefined;
    fit = () => undefined;
    focus = () => undefined;
    adjustFontSize = () => undefined;
    resetFontSize = () => undefined;
    dispose = () => {
      this.hasRenderer = false;
    };
  },
}));

async function freshRegistry() {
  vi.resetModules();
  return import("./registry");
}

describe("engine registry", () => {
  it("hands the same engine back for a session it already holds", async () => {
    const { getEngine, getOrCreateEngine, liveEngines } = await freshRegistry();

    const first = getOrCreateEngine("s1");
    const second = getOrCreateEngine("s1");

    expect(second).toBe(first);
    expect(getEngine("s1")).toBe(first);
    expect(liveEngines()).toEqual([first]);
  });

  // Creation is a membership edge exactly once. A second announcement for an
  // engine that already existed would make every reader recompute — and, for a
  // reader that acts on the reading, act — on nothing having changed.
  it("announces a session's engine only the first time it is asked for", async () => {
    const { getOrCreateEngine, onLiveEnginesChanged } = await freshRegistry();
    const heard = vi.fn();
    onLiveEnginesChanged(heard);

    getOrCreateEngine("s1");
    expect(heard).toHaveBeenCalledOnce();

    getOrCreateEngine("s1");
    expect(heard).toHaveBeenCalledOnce();

    getOrCreateEngine("s2");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("forgets a disposed session so the id comes back as a genuinely new engine", async () => {
    const { disposeEngine, getEngine, getOrCreateEngine, liveEngines, onLiveEnginesChanged } =
      await freshRegistry();
    const heard = vi.fn();
    onLiveEnginesChanged(heard);
    const original = getOrCreateEngine("s1");

    disposeEngine("s1");

    expect(original.hasRenderer).toBe(false);
    expect(getEngine("s1")).toBeUndefined();
    expect(liveEngines()).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(2);

    const replacement = getOrCreateEngine("s1");
    expect(replacement).not.toBe(original);
    expect(replacement.hasRenderer).toBe(true);
    expect(liveEngines()).toEqual([replacement]);
  });

  it("stays quiet about a session it never held", async () => {
    const { disposeEngine, onLiveEnginesChanged } = await freshRegistry();
    const heard = vi.fn();
    onLiveEnginesChanged(heard);

    expect(() => disposeEngine("never-existed")).not.toThrow();
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops delivering to an unsubscribed watcher", async () => {
    const { getOrCreateEngine, onLiveEnginesChanged } = await freshRegistry();
    const heard = vi.fn();
    const unsubscribe = onLiveEnginesChanged(heard);

    getOrCreateEngine("s1");
    expect(heard).toHaveBeenCalledOnce();

    unsubscribe();
    getOrCreateEngine("s2");
    expect(heard).toHaveBeenCalledOnce();
  });

  // The registry is observed, not driven, by its watchers. A throwing watcher
  // used to ride the announcement out of disposeEngine and out of
  // closeTerminalSession's pane loop, so the engine kept its GPU context and
  // every PTY after it went unkilled.
  it("disposes and forgets the engine even when a watcher throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { disposeEngine, getEngine, getOrCreateEngine, liveEngines, onLiveEnginesChanged } =
      await freshRegistry();
    const failure = new Error("watcher is broken");
    const after = vi.fn();
    onLiveEnginesChanged(() => {
      throw failure;
    });
    onLiveEnginesChanged(after);

    const engine = getOrCreateEngine("s1");
    expect(() => disposeEngine("s1")).not.toThrow();

    expect(engine.hasRenderer).toBe(false);
    expect(getEngine("s1")).toBeUndefined();
    expect(liveEngines()).toEqual([]);
    // The watcher standing behind the broken one still heard both edges.
    expect(after).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith("terminal engine-set listener failed:", failure);
  });

  it("keeps the live list a snapshot a caller can walk more than once", async () => {
    const { getOrCreateEngine, liveEngines } = await freshRegistry();
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");

    const engines = liveEngines();

    expect([...engines]).toHaveLength(2);
    expect([...engines]).toHaveLength(2);
  });
});
