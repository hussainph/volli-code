import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  THEME_TOKEN_NAMES,
  canvasBackground,
  deriveCanvasTokens,
  type Canvas,
} from "@volli/shared";

import { onTerminalAppearanceChanged } from "@renderer/terminal/appearance";

import {
  CANVAS_TOKEN_NAMES,
  applyResolvedAppearanceClass,
  deriveCanvasPaint,
  paintCanvas,
  resetSystemAppearanceWatchForTests,
  systemPrefersDark,
  watchSystemAppearance,
} from "./canvas-paint";

afterEach(() => {
  vi.unstubAllGlobals();
  resetSystemAppearanceWatchForTests();
});

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no DOM. The paint path only ever touches `style.setProperty` and
 * `classList`, so a recording stand-in exercises the real contract without
 * pulling in jsdom — the same technique apply.test.ts uses.
 */
function fakeRoot() {
  const written = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: {
      setProperty(name: string, value: string) {
        written.set(name, value);
      },
    },
    classList: {
      toggle(name: string, force: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  return { root: root as unknown as HTMLElement, written, classes };
}

const TEAL: Canvas = {
  stops: [{ hex: "#2ba39c", x: 0.2, y: 0.7 }],
  primaryIndex: 0,
  vibrancy: 0.9,
  grain: 0,
};

describe("deriveCanvasPaint", () => {
  it("produces exactly the properties CANVAS_TOKEN_NAMES lists, and no others", () => {
    // The list is not documentation: `globals.css`'s generator writes from the
    // same set, and a property in one and not the other is a value that silently
    // keeps the stylesheet's fallback forever.
    const { canvasTokens } = deriveCanvasPaint(DEFAULT_CANVAS, "dark");

    expect(Object.keys(canvasTokens).toSorted()).toEqual([...CANVAS_TOKEN_NAMES].toSorted());
  });

  it("gives every property a value, even where the dial is at zero", () => {
    // The seam's rules in globals.css are unconditional, so an unset property
    // would fall back to its `var()` fallback on a repaint while the rule still
    // matched — a one-frame flicker with no error anywhere. Tier 1 takes a lift
    // share of zero by design, and that has to reach the DOM as `transparent`.
    const { canvasTokens } = deriveCanvasPaint(DEFAULT_CANVAS, "dark");

    for (const name of CANVAS_TOKEN_NAMES) expect(canvasTokens[name].length).toBeGreaterThan(0);
    expect(canvasTokens["--lift-1"]).toBe("transparent");
  });

  it("carries the gradient the shared pipeline paints, verbatim", () => {
    const { canvasTokens } = deriveCanvasPaint(TEAL, "light");

    expect(canvasTokens["--canvas"]).toBe(canvasBackground(TEAL, "light"));
  });

  it("returns the same token set the shared derivation does", () => {
    // Nothing here re-derives; a second opinion about the ladder is the one
    // thing this module must not have.
    const { tokens } = deriveCanvasPaint(TEAL, "dark");

    expect(tokens).toEqual(deriveCanvasTokens(TEAL, "dark"));
  });

  it("answers differently per mode — one canvas, two windows", () => {
    const dark = deriveCanvasPaint(DEFAULT_CANVAS, "dark").canvasTokens;
    const light = deriveCanvasPaint(DEFAULT_CANVAS, "light").canvasTokens;

    expect(light["--canvas"]).not.toBe(dark["--canvas"]);
    expect(light["--canvas-ink"]).not.toBe(dark["--canvas-ink"]);
  });
});

describe("paintCanvas", () => {
  it("writes the app tokens and the canvas properties in one pass", () => {
    const { root, written } = fakeRoot();

    paintCanvas(DEFAULT_CANVAS, "dark", { root });

    for (const name of THEME_TOKEN_NAMES) expect(written.has(name)).toBe(true);
    for (const name of CANVAS_TOKEN_NAMES) expect(written.has(name)).toBe(true);
  });

  it("tells the terminals on a committed paint and holds off on a transient one", () => {
    // The terminals rebuild their palette by reading tokens back off the
    // element with `getComputedStyle` — a forced style recalculation, per live
    // terminal, right after this function wrote ~50 properties. A drag frame
    // must not pay it, and everything else must.
    //
    // Asserted through `paintCanvas` rather than `applyThemeTokens` because the
    // bug this pins was in the FORWARDING: the flag reached `applyThemeTokens`
    // in tests and was dropped on the way there in the running app.
    const { root } = fakeRoot();
    let told = 0;
    const stop = onTerminalAppearanceChanged(() => (told += 1));

    try {
      paintCanvas(DEFAULT_CANVAS, "dark", { root, transient: true });
      expect(told).toBe(0);

      paintCanvas(DEFAULT_CANVAS, "dark", { root });
      expect(told).toBe(1);
    } finally {
      stop();
    }
  });

  it("moves the mode class, replacing whichever one was there", () => {
    const { root, classes } = fakeRoot();

    paintCanvas(DEFAULT_CANVAS, "light", { root });
    expect([...classes]).toEqual(["light"]);

    paintCanvas(DEFAULT_CANVAS, "dark", { root });
    expect([...classes]).toEqual(["dark"]);
  });
});

describe("applyResolvedAppearanceClass", () => {
  it("leaves exactly one mode class on the element", () => {
    // Both classes at once would let `:root.light` and `:root.dark` match the
    // same element, where source order — not the user's choice — would decide.
    const { root, classes } = fakeRoot();

    applyResolvedAppearanceClass("dark", root);
    applyResolvedAppearanceClass("light", root);

    expect([...classes]).toEqual(["light"]);
  });
});

/**
 * A stand-in for the preload bridge, so "what did main say?" and "the OS just
 * flipped" are both things this test can state.
 *
 * `matchMedia` is stubbed alongside it, always answering the OPPOSITE — it is
 * what the app used to read, and the point of these tests is that nothing goes
 * near it any more.
 */
function fakeBridge({ prefersDark }: { prefersDark: boolean | null }) {
  const listeners: ((prefersDark: boolean) => void)[] = [];
  let subscriptions = 0;
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: prefersDark !== true, addEventListener: () => {} }),
    api: {
      theme: {
        systemPrefersDark: () => prefersDark,
        onSystemAppearanceChanged: (listener: (prefersDark: boolean) => void) => {
          subscriptions += 1;
          listeners.push(listener);
          return () => {};
        },
      },
    },
  });
  return {
    flip: (next: boolean) => listeners.forEach((listener) => listener(next)),
    subscriptionCount: () => subscriptions,
  };
}

describe("systemPrefersDark", () => {
  it("reads the boolean main stamped on this window, not the media query", () => {
    // Chromium resolves `(prefers-color-scheme: dark)` against the root
    // element's used `color-scheme`, which this app stamps itself — so in the
    // renderer that query reports the mode already painted. Measured on a
    // Dark-mode Mac with the root in light: main said `true`, the query said
    // `false`. The fake answers them in opposite directions for exactly that
    // reason: only one of the two can be the source.
    fakeBridge({ prefersDark: true });
    expect(systemPrefersDark()).toBe(true);

    fakeBridge({ prefersDark: false });
    expect(systemPrefersDark()).toBe(false);
  });

  it("answers dark with no bridge at all", () => {
    // The theme store's singleton is constructed at import time and reads this
    // for its initial state, so it has to survive a headless host — the
    // renderer's own test project runs under vitest's `node` environment. Dark
    // is what globals.css renders with no mode class stamped, so the guard
    // agrees with the stylesheet rather than inventing a third default.
    expect(systemPrefersDark()).toBe(true);
  });

  it("answers dark when the flag never arrived", () => {
    // `null` means no window built by `createWindow` is behind this preload.
    // Same reasoning, same answer — and it must come from here rather than from
    // the bridge, so the fallback is stated once.
    fakeBridge({ prefersDark: null });

    expect(systemPrefersDark()).toBe(true);
  });
});

describe("watchSystemAppearance", () => {
  it("hands the flip's own boolean to its caller rather than deciding what it means", () => {
    // The value has to RIDE the event: the argv snapshot behind
    // `systemPrefersDark` is fixed for the window's lifetime, so a callback that
    // re-read it would repaint to the mode that just stopped being true. What
    // the flip MEANS is the store's question — "is this scope on auto?" is
    // answerable only there.
    const bridge = fakeBridge({ prefersDark: true });
    const seen: boolean[] = [];

    watchSystemAppearance((prefersDark) => seen.push(prefersDark));
    bridge.flip(false);
    bridge.flip(true);

    expect(seen).toEqual([false, true]);
  });

  it("subscribes exactly once however often it is called", () => {
    // A hot reload or a second caller must not stack subscriptions — every flip
    // would then repaint as many times as it was registered.
    const bridge = fakeBridge({ prefersDark: true });

    watchSystemAppearance(() => {});
    watchSystemAppearance(() => {});

    expect(bridge.subscriptionCount()).toBe(1);
  });
});

describe("the default root", () => {
  it("paints `<html>` when no root is passed", () => {
    const { root, written, classes } = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });

    paintCanvas(DEFAULT_CANVAS, "light");
    applyResolvedAppearanceClass("light");

    expect(written.get("--canvas")).toBe(canvasBackground(DEFAULT_CANVAS, "light"));
    expect([...classes]).toEqual(["light"]);
  });

  it("no-ops rather than throwing where there is no document", () => {
    // Only reachable headlessly — `boot()` paints as part of adopting the
    // bootstrap rows, and that must not turn a test about boot into a
    // ReferenceError about the DOM.
    expect(() => paintCanvas(DEFAULT_CANVAS, "dark")).not.toThrow();
    expect(() => applyResolvedAppearanceClass("dark")).not.toThrow();
  });
});
