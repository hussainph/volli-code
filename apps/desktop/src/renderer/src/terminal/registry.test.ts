import { describe, expect, it, vi } from "vite-plus/test";

/**
 * The registry's two jobs: get-or-create-or-forget over one engine per session,
 * and fanning the app-wide ghostty-config edit out over every engine it holds.
 *
 * Everything the registry touches on import is stubbed: the real engine opens
 * an xterm.js terminal against a laid-out DOM (there is none at all under the
 * renderer test project's node environment), and DPR is a module-lifetime
 * subscription whose only job here would be to drag xterm in. The appearance
 * subscription is stubbed but CAPTURED, because firing it is how a case watches
 * what the registry does to every engine.
 *
 * The registry keeps module-level state, so every case imports a fresh copy
 * rather than sharing (and having to unwind) one map.
 */
const hooks = vi.hoisted(() => ({
  /** The registry's module-lifetime subscription, captured so a case can fire
   *  the app-wide event and watch what the registry does to every engine. */
  reloadAppearance: () => undefined as void,
  /** Per-engine hook the fan-out cases arm to make one engine throw. */
  onAppearance: (_engine: { id: string }) => undefined as void,
  /** Every engine the registry built this run, in creation order. */
  built: [] as { id: string; rethemed: number }[],
}));

vi.mock("./appearance", () => ({
  getCurrentAppearance: () => ({}),
  onTerminalAppearanceChanged: (listener: () => void) => {
    hooks.reloadAppearance = listener;
    return () => undefined;
  },
}));
vi.mock("./device-pixel-ratio", () => ({ watchDevicePixelRatio: () => () => undefined }));
vi.mock("./xterm-engine", () => ({
  // Enough TerminalEngine for the registry, which only ever fits, re-themes and
  // disposes what it holds. `alive` doubles as the observable "did this
  // actually get disposed?".
  XtermEngine: class {
    alive = true;
    readonly id = `e${hooks.built.length + 1}`;
    rethemed = 0;
    constructor() {
      hooks.built.push(this);
    }
    attach = () => undefined;
    write = () => undefined;
    onData = () => () => undefined;
    onResize = () => () => undefined;
    setPaused = () => undefined;
    fit = () => undefined;
    focus = () => undefined;
    adjustFontSize = () => undefined;
    resetFontSize = () => undefined;
    applyAppearance = () => {
      this.rethemed += 1;
      hooks.onAppearance(this);
    };
    dispose = () => {
      this.alive = false;
    };
  },
}));

async function freshRegistry() {
  vi.resetModules();
  hooks.built = [];
  hooks.onAppearance = () => undefined;
  return import("./registry");
}

/** The mock engine behind a seam-typed handle, for the one assertion the seam
 *  has no field for: whether dispose really ran. */
function asMock(engine: unknown): { id: string; alive: boolean; rethemed: number } {
  return engine as { id: string; alive: boolean; rethemed: number };
}

describe("engine registry", () => {
  it("hands the same engine back for a session it already holds", async () => {
    const { getEngine, getOrCreateEngine } = await freshRegistry();

    const first = getOrCreateEngine("s1");
    const second = getOrCreateEngine("s1");

    expect(second).toBe(first);
    expect(getEngine("s1")).toBe(first);
    expect(hooks.built).toHaveLength(1);
  });

  it("forgets a disposed session so the id comes back as a genuinely new engine", async () => {
    const { disposeEngine, getEngine, getOrCreateEngine } = await freshRegistry();
    const original = getOrCreateEngine("s1");

    disposeEngine("s1");

    expect(asMock(original).alive).toBe(false);
    expect(getEngine("s1")).toBeUndefined();

    const replacement = getOrCreateEngine("s1");
    expect(replacement).not.toBe(original);
    expect(asMock(replacement).alive).toBe(true);
  });

  it("stays quiet about a session it never held", async () => {
    const { disposeEngine } = await freshRegistry();

    expect(() => disposeEngine("never-existed")).not.toThrow();
    expect(hooks.built).toHaveLength(0);
  });

  // Logged, deliberately NOT toasted. A pane that missed a re-theme keeps its
  // previous appearance, stays fully usable, and picks the new one up on the
  // next config edit. There is no action for the user to take — but the panes
  // BEHIND the broken one still have to get the user's new config, which is
  // exactly what an unguarded loop would have cost them.
  it("re-themes every terminal on a config edit even when one engine throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getOrCreateEngine } = await freshRegistry();
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
  });

  // A disposed engine leaves the map before `dispose()` runs, so a config edit
  // that lands during teardown cannot reach it.
  it("stops re-theming an engine once its session is gone", async () => {
    const { disposeEngine, getOrCreateEngine } = await freshRegistry();
    getOrCreateEngine("s1");
    getOrCreateEngine("s2");

    disposeEngine("s1");
    hooks.reloadAppearance();

    expect(hooks.built.map((engine) => engine.rethemed)).toEqual([0, 1]);
  });
});
