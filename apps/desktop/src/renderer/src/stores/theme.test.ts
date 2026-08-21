import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import {
  APPEARANCE_APP_STATE_KEY,
  DEFAULT_CANVAS,
  THEME_APP_STATE_KEY,
  windowBackground,
  type Appearance,
  type Canvas,
  type GhosttyAppearancePayload,
  type ResolvedAppearance,
} from "@volli/shared";
import type { ThemeStatePayload } from "../../../ipc/contract";

import {
  activeTheme,
  appliedCanvas,
  createThemeStore,
  effectiveAppearance,
  effectiveCanvas,
  setProjectRowSink,
  type ThemeGateway,
  type ThemeProjectScope,
} from "./theme";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/** A canvas nothing else in these tests can be confused with. */
const TEAL: Canvas = {
  stops: [{ hex: "#2ba39c", x: 0.2, y: 0.7 }],
  primaryIndex: 0,
  vibrancy: 0.9,
  grain: 0,
};

/** A third, so "the workspace's" and "the preview's" are never the same object. */
const PLUM: Canvas = {
  stops: [{ hex: "#7a4fa3", x: 0.5, y: 0.5 }],
  primaryIndex: 0,
  vibrancy: 0.4,
  grain: 0.2,
};

const TERMINAL: GhosttyAppearancePayload = {
  prefs: {
    themeName: null,
    fontFamilies: [],
    fontSize: null,
    ligatures: null,
    mouseReporting: null,
    macosOptionAsAlt: null,
    scrollbackLimitBytes: null,
  },
  configText: null,
  themeSource: null,
  provenance: {},
  overlayPaths: { global: "/data/volli/ghostty/config", project: null },
  ghosttyConfigPath: "/home/u/.config/ghostty/config",
};

/**
 * `volli:theme-state`'s payload — the resolved terminal chain and the
 * migration-013 row. The canvas is deliberately absent: it arrives through the
 * bootstrap rows instead, and this channel has no second answer for it. The
 * editor is absent for a different reason: since VC-123 it is DERIVED from the
 * appearance, so there is nothing to send.
 */
function statePayload(over: Partial<ThemeStatePayload> = {}): ThemeStatePayload {
  return {
    projectOverride: null,
    projectId: null,
    terminal: TERMINAL,
    ...over,
  };
}

/** One paint, as the DOM would have received it. */
interface Paint {
  canvas: Canvas;
  resolved: ResolvedAppearance;
  /** True for one frame of a running gesture — the terminals are not told. */
  transient: boolean;
}

/** Records what the DOM would have been repainted with, in order. */
function recorder() {
  const painted: Paint[] = [];
  const editorThemes: string[] = [];
  // Records the EASED repaints specifically: what each one was armed for, so a
  // test can assert both that the crossfade ran and what it ran into.
  const eased: Paint[] = [];
  let arming = false;
  let prefersDark = true;
  /**
   * The swap a "view transition" is holding back, if a test asked it to.
   *
   * Chromium runs the update callback at the next rendering opportunity rather
   * than inline, and the store is written for that: the eased swap re-reads the
   * store when it fires. Held here so a test can move the state underneath one
   * and see which canvas actually lands.
   */
  let heldSwap: (() => void) | null = null;
  let holding = false;
  const runSwap = (applyTokens: () => void) => {
    arming = true;
    applyTokens();
    arming = false;
  };
  return {
    painted,
    editorThemes,
    eased,
    setSystemPrefersDark: (value: boolean) => {
      prefersDark = value;
    },
    /** Stop running eased swaps inline; {@link releaseSwap} runs them instead. */
    holdSwaps: () => {
      holding = true;
    },
    /** Run the swap the engine was holding, as the frame after it would. */
    releaseSwap: () => {
      const swap = heldSwap;
      heldSwap = null;
      if (swap !== null) runSwap(swap);
    },
    paintCanvas: (
      canvas: Canvas,
      resolved: ResolvedAppearance,
      options?: { transient?: boolean },
    ) => {
      const paint = { canvas, resolved, transient: options?.transient === true };
      painted.push(paint);
      if (arming) eased.push(paint);
    },
    refreshEditorTheme: (themeId: string) => void editorThemes.push(themeId),
    // The fallback shape the real module takes where there is no view
    // transition to run: the swap happens, synchronously, inside the call.
    beginScopeRepaint: (applyTokens: () => void) => {
      if (holding) {
        heldSwap = applyTokens;
        return;
      }
      runSwap(applyTokens);
    },
    systemPrefersDark: () => prefersDark,
  };
}

function fakeGateway(over: Partial<ThemeGateway> = {}): ThemeGateway {
  return {
    state: vi.fn(async () => ({ ok: true as const, value: statePayload() })),
    setGlobalCanvas: vi.fn(async () => ({ ok: true as const })),
    setGlobalAppearance: vi.fn(async () => ({ ok: true as const })),
    // Both echo the authoritative row back, exactly as main does — the columns
    // the write just moved, on the project it moved them for.
    setProjectCanvas: vi.fn(async (projectId: string, canvas: Canvas | null) => ({
      ok: true as const,
      project: { id: projectId, themeCanvas: canvas } as never,
    })),
    setProjectAppearance: vi.fn(async (projectId: string, appearance: Appearance | null) => ({
      ok: true as const,
      project: { id: projectId, themeAppearance: appearance } as never,
    })),
    setFirstPaint: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function freshStore(over: Partial<ThemeGateway> = {}) {
  const gateway = fakeGateway(over);
  const paint = recorder();
  const store = createThemeStore({
    deps: {
      gateway,
      paintCanvas: paint.paintCanvas,
      refreshEditorTheme: paint.refreshEditorTheme,
      beginScopeRepaint: paint.beginScopeRepaint,
      systemPrefersDark: paint.systemPrefersDark,
    },
  });
  return { store, gateway, paint };
}

/** The bootstrap payload's raw `app_state` rows, as main writes them. */
function appState(canvas?: Canvas, appearance?: Appearance): Record<string, string> {
  const rows: Record<string, string> = {};
  if (canvas !== undefined) rows[THEME_APP_STATE_KEY] = JSON.stringify(canvas);
  if (appearance !== undefined) rows[APPEARANCE_APP_STATE_KEY] = appearance;
  return rows;
}

function projectScope(over: Partial<ThemeProjectScope> = {}): ThemeProjectScope {
  return { projectId: "p1", canvas: null, appearance: null, ...over };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** Lets a fire-and-forget `.then()` chain (the first-paint write) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A hand-driven animation-frame clock.
 *
 * These tests run under vitest's `node` environment, where there is no
 * `requestAnimationFrame` at all — so the store takes the immediate-paint
 * branch and the preview coalescing is never reached unless the frames are
 * installed and fired by hand. `afterEach`'s `unstubAllGlobals` removes them
 * again, so no other case sees a window that suddenly has frames.
 */
function frameClock() {
  let nextHandle = 0;
  const queued = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextHandle += 1;
    queued.set(nextHandle, callback);
    return nextHandle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    queued.delete(handle);
  });
  return {
    /** Runs every queued frame, as the display would. */
    flush() {
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback(0);
    },
  };
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydrateGlobal", () => {
  it("adopts the stored canvas and appearance off the bootstrap rows", () => {
    // No IPC read: the rows already arrived with the bootstrap payload, and a
    // second read path would be a second answer to "what is the theme?".
    const { store, paint, gateway } = freshStore();

    store.getState().hydrateGlobal(appState(TEAL, "light"));

    expect(store.getState().globalCanvas).toEqual(TEAL);
    expect(store.getState().globalAppearance).toBe("light");
    expect(paint.painted).toEqual([
      { canvas: store.getState().globalCanvas, resolved: "light", transient: false },
    ]);
    expect(gateway.state).not.toHaveBeenCalled();
  });

  it("falls back to the shipped canvas when nothing is stored", () => {
    const { store } = freshStore();

    store.getState().hydrateGlobal({});

    expect(store.getState().globalCanvas).toEqual(DEFAULT_CANVAS);
    expect(store.getState().globalAppearance).toBe("auto");
  });

  it("resets to the shipped canvas when the row still holds a seed-system theme", () => {
    // Decision 7 — reset to the default, no seed→canvas conversion — falling
    // out of the guard rather than needing a migration to do it. A
    // `ThemeDefinition` is not a canvas, so it parses to null and reads exactly
    // like an absent row.
    const { store } = freshStore();

    store.getState().hydrateGlobal({
      [THEME_APP_STATE_KEY]: JSON.stringify({ name: "Ember", slug: "ember", seed: "#e8652a" }),
    });

    expect(store.getState().globalCanvas).toEqual(DEFAULT_CANVAS);
  });

  it("survives an unparseable row rather than failing the boot it runs inside", () => {
    const { store } = freshStore();

    store.getState().hydrateGlobal({ [THEME_APP_STATE_KEY]: "{ not json" });

    expect(store.getState().globalCanvas).toEqual(DEFAULT_CANVAS);
  });

  it("ignores an appearance row that is not one of the three words", () => {
    const { store } = freshStore();

    store.getState().hydrateGlobal({ [APPEARANCE_APP_STATE_KEY]: "sepia" });

    expect(store.getState().globalAppearance).toBe("auto");
  });
});

describe("hydrate", () => {
  it("adopts the terminal chain and paints, editor included", async () => {
    const { store, paint } = freshStore();

    await store.getState().hydrate();

    expect(store.getState().terminal).toEqual(TERMINAL);
    expect(store.getState().hydrated).toBe(true);
    expect(paint.painted).toHaveLength(1);
    // Derived from the appearance this paint resolved, not from the payload.
    expect(paint.editorThemes).toEqual(["vitesse-dark"]);
  });

  it("takes the workspace's canvas columns from the caller, not from a second read", async () => {
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });

    await store.getState().hydrate(projectScope({ canvas: TEAL, appearance: "light" }));

    expect(gateway.state).toHaveBeenCalledWith({ projectId: "p1" });
    expect(store.getState().projectOverride).toEqual({
      canvas: TEAL,
      appearance: "light",
      terminalThemeName: null,
    });
    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
    expect(effectiveAppearance(store.getState())).toBe("light");
  });

  it("merges the 013 row's surfaces with the 014 canvas columns", async () => {
    // The two halves genuinely arrive from different places — the terminal name
    // off `volli:theme-state`, the canvas and appearance off the project row —
    // and the resolution has to see them as one override.
    const { store } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({
          projectId: "p1",
          projectOverride: { terminalThemeName: "Nord" },
        }),
      })),
    });

    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(store.getState().projectOverride).toEqual({
      canvas: TEAL,
      appearance: null,
      terminalThemeName: "Nord",
    });
  });

  it("stores no override at all for a workspace that inherits everything", () => {
    // A workspace that was reset must read exactly like one that was never
    // touched, or "does this workspace override anything?" has two answers.
    return freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    })
      .store.getState()
      .hydrate(projectScope())
      .then(() => {
        expect(freshStore().store.getState().projectOverride).toBeNull();
      });
  });

  it("lets the LAST hydrate win, whatever order the payloads come back in", async () => {
    // Scope reads overlap at boot and at every workspace switch; a slow global
    // read landing after a project read would otherwise put the app back on the
    // global scope silently.
    const slow = deferred<{ ok: true; value: ThemeStatePayload }>();
    const state = vi
      .fn<ThemeGateway["state"]>()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementation(async () => ({
        ok: true as const,
        value: statePayload({ projectId: "p1" }),
      }));
    const { store } = freshStore({ state });

    const first = store.getState().hydrate();
    const second = store.getState().hydrate(projectScope({ canvas: TEAL }));
    slow.resolve({ ok: true, value: statePayload() });
    await Promise.all([first, second]);

    expect(store.getState().projectId).toBe("p1");
    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
  });

  it("surfaces a failed read instead of silently keeping the default", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: false as const, error: "database is locked" })),
    });

    await store.getState().hydrate();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("database is locked"),
      expect.anything(),
    );
    expect(store.getState().hydrated).toBe(false);
  });

  it("surfaces a rejected read the same way", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => {
        throw new Error("bridge gone");
      }),
    });

    await store.getState().hydrate();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("bridge gone"),
      expect.anything(),
    );
  });
});

describe("the eased repaint", () => {
  it("crossfades a workspace switch", async () => {
    const { store, paint } = freshStore({
      state: vi.fn(async (input: { projectId?: string }) => ({
        ok: true as const,
        value: statePayload({ projectId: input.projectId ?? null }),
      })),
    });

    await store.getState().hydrate();
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(paint.eased).toEqual([
      { canvas: TEAL, resolved: expect.anything() as never, transient: false },
    ]);
  });

  it("crossfades a light↔dark flip inside one scope", async () => {
    // The case the projectId-only trigger missed while dark was pinned: same
    // scope, same canvas, every surface inverted.
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    await store.getState().setGlobalAppearance("light");

    expect(paint.eased).toEqual([{ canvas: DEFAULT_CANVAS, resolved: "light", transient: false }]);
  });

  it("never eases the first paint", () => {
    const { store, paint } = freshStore();

    store.getState().hydrateGlobal(appState(TEAL, "light"));

    expect(paint.painted).toHaveLength(1);
    expect(paint.eased).toEqual([]);
  });

  it("never eases the authored rows arriving, even after a placeholder paint", async () => {
    // `volli:theme-state` can beat the bootstrap payload back, and its `accept`
    // repaints a store that has never seen an authored row — the shipped canvas
    // at `auto`, which on a dark machine is a dark window. Easing out of that
    // is a 300ms fade from a theme nobody chose, on every launch that loses the
    // race; measured as a real dark frame at boot once the crossfade became a
    // view transition and the swap stopped landing in the same task.
    const { store, paint } = freshStore();
    paint.setSystemPrefersDark(true);

    await store.getState().hydrate();
    store.getState().hydrateGlobal(appState(TEAL, "light"));

    expect(paint.painted).toEqual([
      { canvas: DEFAULT_CANVAS, resolved: "dark", transient: false },
      { canvas: TEAL, resolved: "light", transient: false },
    ]);
    expect(paint.eased).toEqual([]);
  });

  it("cuts straight to a canvas edit within one scope", async () => {
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    await store.getState().setGlobalCanvas(TEAL);

    expect(paint.eased).toEqual([]);
    expect(paint.painted).toHaveLength(2);
  });

  it("paints what the store says when the swap actually runs, not when it was decided", async () => {
    // The eased swap is a CALLBACK the view transition runs a frame later, so
    // the state can move under it. Painting the resolution captured at decision
    // time would put the window on one canvas while the first-paint hint —
    // always written from the newest state — recorded another.
    const { store, paint } = freshStore({
      state: vi.fn(async (input: { projectId?: string }) => ({
        ok: true as const,
        value: statePayload({ projectId: input.projectId ?? null }),
      })),
    });
    await store.getState().hydrate();
    paint.holdSwaps();

    await store.getState().hydrate(projectScope({ canvas: TEAL }));
    // Nothing has reached the DOM yet: the engine is still holding the swap.
    expect(paint.eased).toEqual([]);
    store.getState().startPreview(PLUM);
    paint.releaseSwap();

    expect(paint.eased).toEqual([
      { canvas: PLUM, resolved: expect.anything() as never, transient: false },
    ]);
  });
});

describe("repaint deduplication", () => {
  it("does not repaint when nothing effective changed", async () => {
    // Every paint invalidates the terminals' token-derived palette, so a
    // redundant one makes every live terminal re-theme for nothing.
    const { store, paint } = freshStore();

    store.getState().hydrateGlobal(appState(TEAL, "dark"));
    await store.getState().hydrate();
    await store.getState().hydrate();

    expect(paint.painted).toHaveLength(1);
  });

  it("repaints when only the MODE moved under an unchanged canvas", () => {
    // The canvas is byte-identical across a flip; the window is not. Keying the
    // dedupe on the canvas alone would silently swallow the whole light path.
    const { store, paint } = freshStore();
    paint.setSystemPrefersDark(true);
    store.getState().hydrateGlobal(appState(TEAL, "auto"));

    store.getState().noteSystemAppearance(false);

    expect(paint.painted).toEqual([
      { canvas: TEAL, resolved: "dark", transient: false },
      { canvas: TEAL, resolved: "light", transient: false },
    ]);
  });
});

describe("the system appearance", () => {
  it("repaints a scope on `auto` when the system flips", () => {
    const { store, paint } = freshStore();
    paint.setSystemPrefersDark(true);
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "auto"));

    store.getState().noteSystemAppearance(false);

    expect(effectiveAppearance(store.getState())).toBe("light");
    expect(paint.painted).toHaveLength(2);
  });

  it("leaves an explicit choice alone when the system flips", () => {
    const { store, paint } = freshStore();
    paint.setSystemPrefersDark(true);
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    store.getState().noteSystemAppearance(false);

    expect(effectiveAppearance(store.getState())).toBe("dark");
    expect(paint.painted).toHaveLength(1);
  });

  it("ignores a flip to the value it already held", () => {
    const { store, paint } = freshStore();
    paint.setSystemPrefersDark(true);
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "auto"));

    store.getState().noteSystemAppearance(true);

    expect(paint.painted).toHaveLength(1);
  });
});

describe("preview", () => {
  it("paints without writing anywhere", () => {
    const { store, gateway, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    store.getState().startPreview(TEAL);

    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
    expect(paint.painted.at(-1)).toEqual({ canvas: TEAL, resolved: "dark", transient: true });
    expect(gateway.setGlobalCanvas).not.toHaveBeenCalled();
    expect(gateway.setProjectCanvas).not.toHaveBeenCalled();
  });

  it("marks an in-flight paint transient, and the paint that ends it committed", async () => {
    // The frame of a drag skips the terminal palette rebuild and the first-paint
    // hint (theme/apply.ts) — both are work about a value that has been chosen,
    // and mid-gesture nothing has been.
    const { store, gateway, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    // The hint is written from a microtask, so the boot paint's own is still in
    // flight here — let it land before counting the drag's.
    await settle();
    vi.mocked(gateway.setFirstPaint).mockClear();

    store.getState().startPreview(TEAL);
    store.getState().startPreview(PLUM);

    expect(paint.painted.map((entry) => entry.transient).slice(-2)).toEqual([true, true]);
    expect(gateway.setFirstPaint).not.toHaveBeenCalled();

    await store.getState().commitPreview({ kind: "global" });

    expect(paint.painted.at(-1)?.transient).toBe(false);
    await settle();
    expect(gateway.setFirstPaint).toHaveBeenCalledTimes(1);
  });

  it("still paints on commit when the last preview frame already showed that canvas", async () => {
    // The release commits exactly what the final frame previewed, so the key is
    // unchanged and the repaint's dedupe would swallow it — leaving every live
    // terminal on the palette it had before the drag, with nothing left to
    // correct it.
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);
    const duringDrag = paint.painted.length;

    await store.getState().commitPreview({ kind: "global" });

    expect(paint.painted.length).toBeGreaterThan(duringDrag);
    expect(paint.painted.at(-1)).toEqual({ canvas: TEAL, resolved: "dark", transient: false });
  });

  it("restores the stored look by simply forgetting the preview", () => {
    // Nothing to undo but the paint: a preview never wrote anywhere, which is
    // the whole reason cancel can be this cheap.
    const { store } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);

    store.getState().cancelPreview();

    expect(effectiveCanvas(store.getState())).toEqual(DEFAULT_CANVAS);
  });

  it("does not repaint when there was no preview to cancel", () => {
    // Escape reaches this whether or not a gesture is running, and every paint
    // invalidates the terminals' token-derived palette.
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    const before = paint.painted.length;

    store.getState().cancelPreview();

    expect(paint.painted).toHaveLength(before);
  });

  it("previews an appearance independently of a canvas", () => {
    const { store } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    store.getState().startAppearancePreview("light");

    expect(effectiveAppearance(store.getState())).toBe("light");
    expect(effectiveCanvas(store.getState())).toEqual(DEFAULT_CANVAS);
  });

  it("outranks a workspace override rather than replacing the global", async () => {
    // Previewing a canvas inside a workspace that overrides only the APPEARANCE
    // must keep that appearance — the two are scoped independently, and a
    // preview is a third scope layered on top, not a replacement for either.
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope({ appearance: "light" }));

    store.getState().startPreview(TEAL);

    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
    expect(effectiveAppearance(store.getState())).toBe("light");
  });

  it("commits to the global scope", async () => {
    const { store, gateway } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);

    expect(await store.getState().commitPreview({ kind: "global" })).toBe(true);

    expect(gateway.setGlobalCanvas).toHaveBeenCalledWith(TEAL);
    expect(store.getState().globalCanvas).toEqual(TEAL);
    expect(store.getState().preview).toBeNull();
  });

  it("commits to a workspace scope", async () => {
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());
    store.getState().startPreview(TEAL);

    expect(await store.getState().commitPreview({ kind: "project", projectId: "p1" })).toBe(true);

    expect(gateway.setProjectCanvas).toHaveBeenCalledWith("p1", TEAL);
    expect(gateway.setGlobalCanvas).not.toHaveBeenCalled();
    expect(store.getState().globalCanvas).toEqual(DEFAULT_CANVAS);
  });

  it("commits both halves when both are being previewed", async () => {
    const { store, gateway } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);
    store.getState().startAppearancePreview("light");

    expect(await store.getState().commitPreview({ kind: "global" })).toBe(true);

    expect(gateway.setGlobalCanvas).toHaveBeenCalledWith(TEAL);
    expect(gateway.setGlobalAppearance).toHaveBeenCalledWith("light");
  });

  it("commits an appearance on its own, to the workspace scope it was previewed in", async () => {
    // The two halves are scoped independently, so a workspace appearance
    // preview must reach the workspace's own write and leave its canvas — which
    // was never being previewed — untouched.
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());
    store.getState().startAppearancePreview("light");

    expect(await store.getState().commitPreview({ kind: "project", projectId: "p1" })).toBe(true);

    expect(gateway.setProjectAppearance).toHaveBeenCalledWith("p1", "light");
    expect(gateway.setProjectCanvas).not.toHaveBeenCalled();
    expect(gateway.setGlobalAppearance).not.toHaveBeenCalled();
  });

  it("commits nothing when there is no preview to commit", async () => {
    const { store, gateway } = freshStore();

    expect(await store.getState().commitPreview({ kind: "global" })).toBe(false);

    expect(gateway.setGlobalCanvas).not.toHaveBeenCalled();
  });
});

describe("the preview frame", () => {
  it("paints once however many preview edits land inside one frame", () => {
    // A drag delivers pointer events faster than the display refreshes — a
    // trackpad runs well past 120Hz — and every one of them used to reach the
    // DOM, so all but the last were document-wide style recalculations nobody
    // could look at.
    const frames = frameClock();
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    const beforeDrag = paint.painted.length;

    store.getState().startPreview(TEAL);
    store.getState().startPreview(PLUM);
    store.getState().startPreview(TEAL);
    expect(paint.painted).toHaveLength(beforeDrag);

    frames.flush();

    // One paint, and it is the NEWEST canvas: the frame reads the store when it
    // fires, so the state is never what is deferred — only the paint is.
    expect(paint.painted).toHaveLength(beforeDrag + 1);
    expect(paint.painted.at(-1)).toEqual({ canvas: TEAL, resolved: "dark", transient: true });
    // Every edit is visible to the editor's own controls immediately; only the
    // document's ~50 properties wait for the frame.
    expect(effectiveCanvas(store.getState())).toBe(TEAL);
  });

  it("keeps following the pointer after a frame has fired", () => {
    // The coalescing keeps ONE frame in flight and lets later requests ride it,
    // so the in-flight marker has to be cleared by the frame that runs — a drag
    // that stopped scheduling after its first frame would simply freeze.
    const frames = frameClock();
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);
    frames.flush();

    store.getState().startPreview(PLUM);
    frames.flush();

    expect(paint.painted.at(-1)).toEqual({ canvas: PLUM, resolved: "dark", transient: true });
  });

  it("drops the queued frame on commit, so the release is the last thing painted", async () => {
    // A frame surviving into a commit repaints from state the commit has
    // already cleared: the window snapped back to the stored canvas for one
    // frame on every release, and the document was left showing a transient
    // paint after the committing one had already run.
    const frames = frameClock();
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    store.getState().startPreview(TEAL);

    await store.getState().commitPreview({ kind: "global" });
    const afterCommit = paint.painted.length;
    frames.flush();

    expect(paint.painted).toHaveLength(afterCommit);
    expect(paint.painted.at(-1)).toEqual({ canvas: TEAL, resolved: "dark", transient: false });
  });
});

describe("setGlobalCanvas", () => {
  it("paints optimistically, then persists", async () => {
    // The editor's whole point is that the window is already wearing the
    // gradient by the time you let go of the orb.
    const { store, gateway, paint } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    const pending = store.getState().setGlobalCanvas(TEAL);
    expect(paint.painted.at(-1)?.canvas).toEqual(TEAL);

    expect(await pending).toBe(true);
    expect(gateway.setGlobalCanvas).toHaveBeenCalledWith(TEAL);
  });

  it("puts the user back on what is actually stored when the write fails", async () => {
    const { store, paint } = freshStore({
      setGlobalCanvas: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    expect(await store.getState().setGlobalCanvas(TEAL)).toBe(false);

    expect(store.getState().globalCanvas).toEqual(DEFAULT_CANVAS);
    expect(paint.painted.at(-1)?.canvas).toEqual(DEFAULT_CANVAS);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
      expect.anything(),
    );
  });
});

describe("setGlobalAppearance", () => {
  it("persists and repaints", async () => {
    const { store, gateway } = freshStore();
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    expect(await store.getState().setGlobalAppearance("light")).toBe(true);

    expect(gateway.setGlobalAppearance).toHaveBeenCalledWith("light");
    expect(effectiveAppearance(store.getState())).toBe("light");
  });

  it("rolls back a failed write", async () => {
    const { store } = freshStore({
      setGlobalAppearance: vi.fn(async () => ({ ok: false as const, error: "database is locked" })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));

    expect(await store.getState().setGlobalAppearance("light")).toBe(false);

    expect(effectiveAppearance(store.getState())).toBe("dark");
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });
});

describe("the workspace scope", () => {
  it("writes and paints a canvas for the workspace it is showing", async () => {
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());

    expect(await store.getState().setProjectCanvas("p1", TEAL)).toBe(true);

    expect(gateway.setProjectCanvas).toHaveBeenCalledWith("p1", TEAL);
    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
  });

  /*
   * The bug this pins was invisible from inside this store and cost a real
   * boot: both writes persisted to SQLite and repainted correctly, so every
   * assertion above passed — while the authoritative row came back and was
   * dropped on the floor. The projects store holds the only copy of those
   * columns and rebuilds every scope from it, so the next workspace switch read
   * a stale `null` and reverted the workspace to the global canvas. Switching
   * away and back is what REVEALED it; the write was already gone.
   */
  it("hands the freshly-written row back, for BOTH workspace writes", async () => {
    const rows: { id: string }[] = [];
    setProjectRowSink((project) => rows.push(project));
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());

    await store.getState().setProjectCanvas("p1", TEAL);
    await store.getState().setProjectAppearance("p1", "light");

    expect(rows).toEqual([
      { id: "p1", themeCanvas: TEAL },
      { id: "p1", themeAppearance: "light" },
    ]);
  });

  it("does not hand a row back when the write failed", async () => {
    const rows: { id: string }[] = [];
    setProjectRowSink((project) => rows.push(project));
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
      setProjectCanvas: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());

    expect(await store.getState().setProjectCanvas("p1", TEAL)).toBe(false);
    expect(rows).toEqual([]);
  });

  it("persists without painting for a workspace it is NOT showing", async () => {
    // Adopting another workspace's canvas here would paint one project's window
    // with another's.
    const { store, gateway, paint } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(DEFAULT_CANVAS, "dark"));
    await store.getState().hydrate(projectScope());
    const before = paint.painted.length;

    expect(await store.getState().setProjectCanvas("p2", TEAL)).toBe(true);

    expect(gateway.setProjectCanvas).toHaveBeenCalledWith("p2", TEAL);
    expect(paint.painted).toHaveLength(before);
    expect(effectiveCanvas(store.getState())).toEqual(DEFAULT_CANVAS);
  });

  it("clears a workspace back to inheriting", async () => {
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(await store.getState().setProjectCanvas("p1", null)).toBe(true);

    expect(gateway.setProjectCanvas).toHaveBeenCalledWith("p1", null);
    expect(effectiveCanvas(store.getState())).toEqual(PLUM);
  });

  it("scopes the appearance separately from the canvas", async () => {
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(await store.getState().setProjectAppearance("p1", "light")).toBe(true);

    expect(gateway.setProjectAppearance).toHaveBeenCalledWith("p1", "light");
    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
    expect(effectiveAppearance(store.getState())).toBe("light");
  });

  it("rolls a failed workspace write back to the override that is stored", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
      setProjectCanvas: vi.fn(async () => ({ ok: false as const, error: "no such project" })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(await store.getState().setProjectCanvas("p1", DEFAULT_CANVAS)).toBe(false);

    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("no such project"),
      expect.anything(),
    );
  });
});

describe("the first-paint hint", () => {
  it("records what was painted, so the next launch builds the right window", async () => {
    const { store, gateway } = freshStore();

    store.getState().hydrateGlobal(appState(TEAL, "light"));
    await settle();

    expect(gateway.setFirstPaint).toHaveBeenCalledWith({
      appearance: "light",
      background: windowBackground(TEAL, "light"),
    });
  });

  it("surfaces a failed hint write rather than letting it stop silently", async () => {
    // A hint that quietly stopped updating shows up as a boot flash nobody can
    // explain, one launch later.
    const { store } = freshStore({
      setFirstPaint: vi.fn(async () => ({ ok: false as const, error: "database is locked" })),
    });

    store.getState().hydrateGlobal(appState(TEAL, "light"));
    await settle();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringContaining("window appearance"),
      expect.anything(),
    );
  });
});

describe("the editor surface", () => {
  it("paints the dark theme in a dark app", async () => {
    const { store, paint } = freshStore();

    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate();

    expect(paint.editorThemes.at(-1)).toBe("vitesse-dark");
  });

  it("paints the light theme in a light app", async () => {
    // The bug VC-123 exists to fix: a dark rectangle inside a light app.
    const { store, paint } = freshStore();

    store.getState().hydrateGlobal(appState(PLUM, "light"));
    await store.getState().hydrate();

    expect(paint.editorThemes.at(-1)).toBe("vitesse-light");
  });

  it("repaints Monaco when the appearance flips, without any editor write", async () => {
    const { store, gateway, paint } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate();
    expect(paint.editorThemes.at(-1)).toBe("vitesse-dark");

    await store.getState().setGlobalAppearance("light");

    expect(paint.editorThemes.at(-1)).toBe("vitesse-light");
    // Nothing about the editor is persisted — the appearance row already is.
    expect(gateway).not.toHaveProperty("setGlobalEditor");
  });

  it("follows `auto` through a system light/dark flip", async () => {
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "auto"));
    await store.getState().hydrate();
    expect(paint.editorThemes.at(-1)).toBe("vitesse-dark");

    store.getState().noteSystemAppearance(false);
    expect(paint.editorThemes.at(-1)).toBe("vitesse-light");

    store.getState().noteSystemAppearance(true);
    expect(paint.editorThemes.at(-1)).toBe("vitesse-dark");
  });

  it("gives a project that overrides its appearance the matching editor theme", async () => {
    // Per-project editor theming, as it survives VC-123: override light/dark
    // and the editor follows.
    const { store, paint } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));

    await store.getState().hydrate(projectScope({ appearance: "light" }));

    expect(paint.editorThemes.at(-1)).toBe("vitesse-light");
  });

  it("does not repaint Monaco when the canvas moves but the mode does not", async () => {
    // The editor is keyed on appearance alone, so a gradient change must not
    // churn Monaco's theme.
    const { store, paint } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate();
    const painted = paint.editorThemes.length;

    store.getState().startPreview(TEAL);

    expect(paint.editorThemes.length).toBe(painted);
  });
});

describe("the terminal chain", () => {
  it("adopts a payload resolved for this store's scope", () => {
    const { store } = freshStore();

    store.getState().acceptTerminal(TERMINAL);

    expect(store.getState().terminal).toEqual(TERMINAL);
  });

  it("takes the global broadcast at the global scope", () => {
    const { store } = freshStore();

    store.getState().acceptGlobalTerminal(TERMINAL);

    expect(store.getState().terminal).toEqual(TERMINAL);
  });

  it("re-reads instead of swallowing the global broadcast inside a workspace", async () => {
    // The broadcast has no project context and fires at every window at once;
    // adopting it whole would overwrite this workspace's provenance and overlay
    // paths with global ones, and fail silently.
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    await store.getState().hydrate(projectScope({ canvas: TEAL }));
    vi.mocked(gateway.state).mockClear();

    store.getState().acceptGlobalTerminal(TERMINAL);
    await settle();

    expect(gateway.state).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("re-reads an inheriting workspace without inventing a canvas for it", async () => {
    // The re-read rebuilds its own scope from what this workspace overrides,
    // which for an inheriting one is nothing — handing a canvas back here would
    // pin the global gradient onto the workspace as if it had chosen it.
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope());

    store.getState().acceptGlobalTerminal(TERMINAL);
    await settle();

    expect(store.getState().projectOverride).toBeNull();
    expect(effectiveCanvas(store.getState())).toEqual(PLUM);
  });
});

describe("appliedCanvas", () => {
  it("ignores a running preview — it says what is STORED", () => {
    const { store } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    store.getState().startPreview(TEAL);

    expect(appliedCanvas(store.getState(), { kind: "global" })).toEqual(PLUM);
  });

  it("reads a workspace's own canvas when that workspace is the one loaded", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(appliedCanvas(store.getState(), { kind: "project", projectId: "p1" })).toEqual(TEAL);
  });

  it("reports the global canvas for a loaded workspace that inherits it", async () => {
    // What the editor tags as "Current" for a workspace with no canvas of its
    // own is the global one — it is what that workspace is actually wearing.
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope());

    expect(appliedCanvas(store.getState(), { kind: "project", projectId: "p1" })).toEqual(PLUM);
  });

  it("never borrows another workspace's override", async () => {
    // The store holds exactly one scope's override at a time, so an editor
    // scoped to a workspace it isn't showing has nothing of that workspace's to
    // read — the global canvas is the only honest answer.
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));

    expect(appliedCanvas(store.getState(), { kind: "project", projectId: "p2" })).toEqual(PLUM);
  });
});

describe("selector stability", () => {
  it("hands back the state's own canvas reference, not a copy", () => {
    // zustand v5 compares each render's snapshot with `Object.is`; a freshly
    // constructed object here is an infinite render loop ("The result of
    // getSnapshot should be cached"), not a wasted allocation. `activeTheme`
    // itself builds one, which is exactly why components read these two
    // narrow selectors instead of it.
    const { store } = freshStore();
    store.getState().hydrateGlobal(appState(TEAL, "dark"));

    expect(effectiveCanvas(store.getState())).toBe(store.getState().globalCanvas);
    expect(activeTheme(store.getState())).not.toBe(activeTheme(store.getState()));
  });

  it("returns a preview by reference too", () => {
    const { store } = freshStore();
    store.getState().hydrateGlobal(appState(PLUM, "dark"));

    store.getState().startPreview(TEAL);

    expect(effectiveCanvas(store.getState())).toBe(TEAL);
  });
});

describe("the default gateway", () => {
  /** Every `window.api.theme` verb the store's real deps reach for, recorded. */
  function stubBridge() {
    const calls: [string, unknown[]][] = [];
    const verb =
      (name: string) =>
      (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve({ ok: true as const, value: statePayload() });
      };
    // The real deps paint and arm the crossfade, so this needs a document as
    // well as a bridge — the point of the case is that the wiring runs, not
    // that it is bypassed.
    vi.stubGlobal("document", {
      documentElement: {
        // `getPropertyValue` is read as well as written: the crossfade captures
        // the outgoing gradient off this element before the paint replaces it.
        style: {
          setProperty: () => {},
          getPropertyValue: () => "",
          removeProperty: () => {},
        },
        classList: { toggle: () => {} },
        setAttribute: () => {},
        removeAttribute: () => {},
        offsetWidth: 0,
      },
    });
    vi.stubGlobal("window", {
      api: {
        theme: {
          // Not a verb: it is read synchronously off this window's process
          // arguments, and the default deps call it once for the initial state.
          systemPrefersDark: () => true,
          state: verb("state"),
          setGlobalCanvas: verb("setGlobalCanvas"),
          setGlobalAppearance: verb("setGlobalAppearance"),
          setProjectCanvas: verb("setProjectCanvas"),
          setProjectAppearance: verb("setProjectAppearance"),
          setFirstPaint: verb("setFirstPaint"),
          setProject: verb("setProject"),
        },
      },
    });
    return calls;
  }

  it("routes every write to the channel of the same name", async () => {
    // The default deps are the only untested seam between this store and the
    // preload bridge, and a verb wired to the wrong channel fails silently — the
    // write "succeeds" against something else.
    const calls = stubBridge();
    const store = createThemeStore();

    await store.getState().hydrate();
    await store.getState().setGlobalCanvas(TEAL);
    await store.getState().setGlobalAppearance("light");
    await store.getState().setProjectCanvas("p1", TEAL);
    await store.getState().setProjectAppearance("p1", "dark");
    await settle();

    const names = new Set(calls.map(([name]) => name));
    expect(names).toEqual(
      new Set([
        "state",
        "setGlobalCanvas",
        "setGlobalAppearance",
        "setProjectCanvas",
        "setProjectAppearance",
        "setFirstPaint",
      ]),
    );
    expect(calls.find(([name]) => name === "setProjectCanvas")?.[1]).toEqual(["p1", TEAL]);
  });
});

describe("carrying the 013 row through a canvas write", () => {
  it("keeps the workspace's terminal override when its canvas moves", async () => {
    // The two halves live in different places and only this store sees them as
    // one override — dropping the terminal name while rewriting the canvas
    // would silently un-pin that workspace's terminal.
    const { store } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({
          projectId: "p1",
          projectOverride: { terminalThemeName: "Nord" },
        }),
      })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope());

    await store.getState().setProjectCanvas("p1", TEAL);

    expect(store.getState().projectOverride).toEqual({
      canvas: TEAL,
      appearance: null,
      terminalThemeName: "Nord",
    });
  });

  it("rolls a failed appearance write back to the stored override", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
      setProjectAppearance: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ appearance: "light" }));

    expect(await store.getState().setProjectAppearance("p1", "dark")).toBe(false);

    expect(effectiveAppearance(store.getState())).toBe("light");
  });
});

describe("overlapping and out-of-scope writes", () => {
  it("reports a failed write for a workspace it is not showing, with nothing to roll back", async () => {
    // Both out-of-scope writes skipped the optimistic paint, so the failure
    // path has no override to restore — repainting here would put another
    // workspace's canvas on this window on the way out of an error.
    const { store, paint } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
      setProjectCanvas: vi.fn(async () => ({ ok: false as const, error: "no such project" })),
      setProjectAppearance: vi.fn(async () => ({ ok: false as const, error: "no such project" })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope({ canvas: TEAL }));
    const before = paint.painted.length;

    expect(await store.getState().setProjectCanvas("p2", DEFAULT_CANVAS)).toBe(false);
    expect(await store.getState().setProjectAppearance("p2", "light")).toBe(false);

    expect(paint.painted).toHaveLength(before);
    expect(effectiveCanvas(store.getState())).toEqual(TEAL);
  });

  it("persists an appearance for a workspace it is not showing, without repainting", async () => {
    const { store, gateway, paint } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ projectId: "p1" }) })),
    });
    store.getState().hydrateGlobal(appState(PLUM, "dark"));
    await store.getState().hydrate(projectScope());
    const before = paint.painted.length;

    expect(await store.getState().setProjectAppearance("p2", "light")).toBe(true);

    expect(gateway.setProjectAppearance).toHaveBeenCalledWith("p2", "light");
    expect(paint.painted).toHaveLength(before);
    expect(effectiveAppearance(store.getState())).toBe("dark");
  });
});
