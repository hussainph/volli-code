import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The registry's membership surface — get-or-create, the live list, and the
 * change event — which is what gpu-pressure reads the whole engine set through.
 *
 * Everything the registry touches on import is stubbed: the real engine builds a
 * restty renderer against a GPU (there is no DOM at all under the renderer test
 * project's node environment), and DPR is a module-lifetime subscription whose
 * only job here would be to drag restty in. The gpu-session and appearance
 * subscriptions are stubbed but CAPTURED, because the registry's second job is
 * fanning those two app-wide events out over every engine it holds.
 *
 * The registry keeps module-level state, so every case imports a fresh copy
 * rather than sharing (and having to unwind) one map and one listener set.
 */
const hooks = vi.hoisted(() => ({
  /** The registry's module-lifetime subscriptions, captured so a case can fire
   *  the app-wide event and watch what the registry does to every engine. */
  rotateGpuSession: () => undefined as void,
  reloadAppearance: () => undefined as void,
  /** Per-engine hook the fan-out cases arm to make one engine throw. */
  onRebuild: (_engine: { id: string }) => undefined as void,
  onAppearance: (_engine: { id: string }) => undefined as void,
  /** Every engine the registry built this run, in creation order. */
  built: [] as { id: string; rebuilt: number; rethemed: number }[],
  /** The app's one error-toast surface, so a case can read what the user was
   *  actually told rather than only what the console was. */
  toastError: (_message: string) => undefined as void,
}));

// Sonner draws React components into a DOM this project has none of; the
// registry only ever hands it a string, so the wrapper is the right seam.
vi.mock("@renderer/lib/toast", () => ({
  toastError: (message: string) => hooks.toastError(message),
}));
vi.mock("./appearance", () => ({
  getCurrentAppearance: () => ({}),
  onTerminalAppearanceChanged: (listener: () => void) => {
    hooks.reloadAppearance = listener;
    return () => undefined;
  },
}));
vi.mock("./gpu-session", () => ({
  onGpuSessionRotated: (listener: () => void) => {
    hooks.rotateGpuSession = listener;
    return () => undefined;
  },
}));
vi.mock("./device-pixel-ratio", () => ({ watchDevicePixelRatio: () => () => undefined }));
vi.mock("./restty-engine", () => ({
  // Enough TerminalEngine for the registry, which only ever fits, rebuilds,
  // re-themes and disposes what it holds. `hasRenderer` doubles as the
  // observable "did this actually get disposed?" — it is the seam's own field,
  // so the assertion never reaches past the interface.
  ResttyEngine: class {
    hasRenderer = true;
    backend = null;
    readonly id = `e${hooks.built.length + 1}`;
    rebuilt = 0;
    rethemed = 0;
    constructor() {
      hooks.built.push(this);
    }
    attach = () => undefined;
    write = () => undefined;
    onData = () => () => undefined;
    onResize = () => () => undefined;
    onGpuStateChanged = () => () => undefined;
    setPaused = () => undefined;
    fit = () => undefined;
    focus = () => undefined;
    adjustFontSize = () => undefined;
    resetFontSize = () => undefined;
    rebuildRenderer = () => {
      this.rebuilt += 1;
      hooks.onRebuild(this);
    };
    applyAppearance = () => {
      this.rethemed += 1;
      hooks.onAppearance(this);
    };
    dispose = () => {
      this.hasRenderer = false;
    };
  },
}));

async function freshRegistry() {
  vi.resetModules();
  hooks.built = [];
  hooks.onRebuild = () => undefined;
  hooks.onAppearance = () => undefined;
  hooks.toastError = () => undefined;
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

  // A Map iterator escaping the module would read as empty the second time a
  // caller walked it, and a live view would rewrite itself under a caller
  // holding it. Membership has to move — both ways — between the capture and
  // the assertion, or the case passes against exactly the shapes it forbids.
  it("keeps the live list a snapshot that survives the engine set changing under it", async () => {
    const { disposeEngine, getOrCreateEngine, liveEngines } = await freshRegistry();
    const first = getOrCreateEngine("s1");
    const second = getOrCreateEngine("s2");

    const captured = liveEngines();
    expect(captured).toEqual([first, second]);

    getOrCreateEngine("s3");
    disposeEngine("s1");

    expect(captured).toEqual([first, second]);
    expect([...captured]).toEqual([first, second]);
    // The registry itself did move — the captured list is stale, not merely
    // equal to a set that never changed.
    expect(liveEngines()).not.toEqual(captured);
  });

  // A rotation fires because a GPU device just died, which is the one moment
  // `createRestty` is most likely to throw — so the loop that recovers every
  // terminal is the last place that can afford to stop at the first failure.
  // Unguarded, engine #1's throw left #2..N permanently blank AND escaped
  // `rotate()` into gpu-session's `.catch()`, which swallows it: no rebuild,
  // no error, no clue.
  it("rebuilds every renderer after a device loss even when one engine throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getOrCreateEngine } = await freshRegistry();
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");
    getOrCreateEngine("s3");
    const failure = new Error("no GPU adapter");
    hooks.onRebuild = (engine) => {
      if (engine.id === "e1") throw failure;
    };

    expect(() => hooks.rotateGpuSession()).not.toThrow();

    expect(hooks.built.map((engine) => engine.rebuilt)).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledWith("terminal renderer rebuild failed:", failure);
  });

  // Isolating the failure kept the OTHER panes alive; it did nothing for the
  // one that died. Nothing retries a rebuild, so that pane is blank until the
  // user closes and reopens it — and gpu-session has already told them
  // "Terminals recovered". A console.warn is not a way to tell somebody their
  // terminal is gone (CLAUDE.md: surface every failed mutation).
  it("tells the user which terminals the device loss took with it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toasted = vi.fn();
    const { getOrCreateEngine } = await freshRegistry();
    hooks.toastError = toasted;
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");
    getOrCreateEngine("s3");
    hooks.onRebuild = (engine) => {
      if (engine.id !== "e2") throw new Error("no GPU adapter");
    };

    hooks.rotateGpuSession();

    // One toast for the rotation, not one per dead pane, and it counts them.
    expect(toasted).toHaveBeenCalledOnce();
    expect(toasted.mock.calls[0]?.[0]).toContain("2 terminals");
    expect(toasted.mock.calls[0]?.[0]).toContain("Close and reopen them");
  });

  it("speaks of a single dead pane in the singular", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toasted = vi.fn();
    const { getOrCreateEngine } = await freshRegistry();
    hooks.toastError = toasted;
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");
    hooks.onRebuild = (engine) => {
      if (engine.id === "e1") throw new Error("no GPU adapter");
    };

    hooks.rotateGpuSession();

    expect(toasted.mock.calls[0]?.[0]).toContain("1 terminal couldn't");
    expect(toasted.mock.calls[0]?.[0]).toContain("Close and reopen it");
  });

  // The common case: the rotation worked. gpu-session's own "terminals
  // recovered" toast is the whole story, and an error on top of it would make
  // every GPU hiccup look like data loss.
  it("stays quiet when every renderer came back", async () => {
    const toasted = vi.fn();
    const { getOrCreateEngine } = await freshRegistry();
    hooks.toastError = toasted;
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");

    hooks.rotateGpuSession();

    expect(hooks.built.map((engine) => engine.rebuilt)).toEqual([1, 1]);
    expect(toasted).not.toHaveBeenCalled();
  });

  // Logged, deliberately NOT toasted — the one place this file departs from the
  // rebuild above. A pane that missed a re-theme keeps its previous appearance,
  // stays fully usable, and picks the new one up on the next config edit or
  // renderer creation. There is no action for the user to take, and spending a
  // red toast here is spending the attention a dead pane needs.
  it("re-themes every terminal on a config edit even when one engine throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toasted = vi.fn();
    const { getOrCreateEngine } = await freshRegistry();
    hooks.toastError = toasted;
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");
    getOrCreateEngine("s3");
    const failure = new Error("font family will not resolve");
    hooks.onAppearance = (engine) => {
      if (engine.id === "e1") throw failure;
    };

    expect(() => hooks.reloadAppearance()).not.toThrow();

    expect(hooks.built.map((engine) => engine.rethemed)).toEqual([1, 1, 1]);
    expect(warnSpy).toHaveBeenCalledWith("terminal appearance reload failed:", failure);
    expect(toasted).not.toHaveBeenCalled();
  });
});
