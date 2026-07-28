import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  THEME_TOKEN_NAMES,
  canvasBackground,
  deriveCanvasTokens,
  type Canvas,
} from "@volli/shared";

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

    paintCanvas(DEFAULT_CANVAS, "dark", root);

    for (const name of THEME_TOKEN_NAMES) expect(written.has(name)).toBe(true);
    for (const name of CANVAS_TOKEN_NAMES) expect(written.has(name)).toBe(true);
  });

  it("moves the mode class, replacing whichever one was there", () => {
    const { root, classes } = fakeRoot();

    paintCanvas(DEFAULT_CANVAS, "light", root);
    expect([...classes]).toEqual(["light"]);

    paintCanvas(DEFAULT_CANVAS, "dark", root);
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

describe("systemPrefersDark", () => {
  it("reads the media query when there is a window to read it from", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: () => {} }) });

    expect(systemPrefersDark()).toBe(false);
  });

  it("answers dark with no window at all", () => {
    // The theme store's singleton is constructed at import time and reads this
    // for its initial state, so it has to survive a headless host. Dark is what
    // globals.css renders with no mode class stamped — the guard agrees with the
    // stylesheet rather than inventing a third default.
    expect(systemPrefersDark()).toBe(true);
  });
});

/** A stubbed `matchMedia`, so a "system flip" is a call this test can make. */
function fakeMedia() {
  const listeners: (() => void)[] = [];
  let queries = 0;
  return {
    listeners,
    queryCount: () => queries,
    install() {
      vi.stubGlobal("window", {
        matchMedia: () => {
          queries += 1;
          return {
            matches: true,
            addEventListener: (_event: string, listener: () => void) => {
              listeners.push(listener);
            },
          };
        },
      });
    },
  };
}

describe("watchSystemAppearance", () => {
  it("reports a flip to its caller rather than deciding what it means", () => {
    // "Is this scope on auto?" is the store's question and only the store can
    // answer it for the scope currently loaded.
    const media = fakeMedia();
    media.install();
    let flips = 0;

    watchSystemAppearance(() => {
      flips += 1;
    });
    media.listeners.forEach((listener) => listener());

    expect(flips).toBe(1);
  });

  it("installs exactly one listener however often it is called", () => {
    // A hot reload or a second caller must not stack listeners on one media
    // query — every flip would then repaint as many times as it was registered.
    const media = fakeMedia();
    media.install();

    watchSystemAppearance(() => {});
    watchSystemAppearance(() => {});

    expect(media.queryCount()).toBe(1);
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
