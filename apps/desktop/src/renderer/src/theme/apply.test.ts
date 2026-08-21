import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CANVAS,
  DEFAULT_THEME,
  deriveCanvasTokens,
  generateThemeTokens,
  generateVeilTokens,
  THEME_TOKEN_NAMES,
  THEME_VEIL_TOKEN_NAMES,
  type Canvas,
} from "@volli/shared";

import {
  applyThemeTokens,
  EMPTY_SURFACE_OVERRIDE,
  resolveActiveTheme,
  type ProjectSurfaceOverride,
} from "./apply";

/**
 * The renderer test project runs under vitest's default `node` environment, so
 * there is no DOM. `applyThemeTokens` only ever touches `root.style`, so a
 * recording stand-in exercises the real contract (which properties get written,
 * with which values) without pulling in jsdom.
 */
function fakeRoot() {
  const written = new Map<string, string>();
  const root = {
    style: {
      setProperty(name: string, value: string) {
        written.set(name, value);
      },
    },
  };
  return { root: root as unknown as HTMLElement, written };
}

/** A second canvas, far enough from the default that every rung moves. */
const TEAL: Canvas = {
  stops: [{ hex: "#2ba39c", x: 0.2, y: 0.7 }],
  primaryIndex: 0,
  vibrancy: 0.9,
  grain: 0,
};

describe("applyThemeTokens", () => {
  it("writes every themeable token as a custom property on the root", () => {
    const { root, written } = fakeRoot();
    const tokens = deriveCanvasTokens(DEFAULT_CANVAS, "dark");

    applyThemeTokens(tokens, root);

    for (const name of THEME_TOKEN_NAMES) expect(written.get(name)).toBe(tokens[name]);
  });

  it("writes the veils alongside the tokens they are solved from", () => {
    // A veil is generated from the token set, so it has to move WITH it. Left
    // behind, every veiled surface would keep compositing to the previous
    // canvas's rung — the sidebar frozen on the old palette while the rail under
    // it repaints, which is the most visible half of a canvas change.
    const { root, written } = fakeRoot();
    const tokens = deriveCanvasTokens(TEAL, "dark");

    applyThemeTokens(tokens, root);

    const veils = generateVeilTokens(tokens);
    for (const name of THEME_VEIL_TOKEN_NAMES) expect(written.get(name)).toBe(veils[name]);
  });

  it("writes the caller's extra properties too, under their own names", () => {
    // The canvas pipeline's ten properties are not `ThemeTokens` members and
    // must not become them — but they have to land in the SAME write, or the
    // gradient and the ladder it was solved against can be one frame apart.
    const { root, written } = fakeRoot();

    applyThemeTokens(deriveCanvasTokens(DEFAULT_CANVAS, "dark"), root, {
      "--canvas": "red",
      "--shadow-card": "none",
    });

    expect(written.get("--canvas")).toBe("red");
    expect(written.get("--shadow-card")).toBe("none");
  });

  it("writes nothing but color tokens when given no extras — geometry and type never follow a canvas", () => {
    const { root, written } = fakeRoot();
    applyThemeTokens(deriveCanvasTokens(DEFAULT_CANVAS, "dark"), root);
    const colorTokens: readonly string[] = [...THEME_TOKEN_NAMES, ...THEME_VEIL_TOKEN_NAMES];
    for (const name of written.keys()) expect(colorTokens).toContain(name);
  });

  it("re-applying a different token set overwrites every token", () => {
    const { root, written } = fakeRoot();
    applyThemeTokens(deriveCanvasTokens(DEFAULT_CANVAS, "dark"), root);
    const teal = deriveCanvasTokens(TEAL, "dark");

    applyThemeTokens(teal, root);

    expect(written.get("--primary")).toBe(teal["--primary"]);
    expect(written.get("--background")).toBe(teal["--background"]);
  });

  it("still accepts a plain generated token set — the generator is the ladder both paths share", () => {
    const { root, written } = fakeRoot();
    const tokens = generateThemeTokens(DEFAULT_THEME);

    applyThemeTokens(tokens, root);

    expect(written.get("--primary")).toBe(tokens["--primary"]);
  });
});

describe("the default root", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes to `<html>` when the caller names no root", () => {
    // The app never passes one — every write here is meant for the document
    // element, and only the tests need a stand-in.
    const { root, written } = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });

    applyThemeTokens(deriveCanvasTokens(DEFAULT_CANVAS, "dark"));

    expect(written.get("--background")).toBe(
      deriveCanvasTokens(DEFAULT_CANVAS, "dark")["--background"],
    );
  });
});

describe("resolveActiveTheme", () => {
  it("inherits every surface from the global scope when there is no override", () => {
    const active = resolveActiveTheme(DEFAULT_CANVAS, "dark", null, false);

    expect(active.canvas).toEqual({ value: DEFAULT_CANVAS, scope: "global" });
    expect(active.appearance).toEqual({ value: "dark", scope: "global" });
    expect(active.terminal).toEqual({ value: null, scope: "global" });
  });

  it("carries no editor surface — the editor is derived from `resolved`, not scoped", () => {
    // VC-123. An editor theme that could be overridden per scope would be a
    // second answer to "light or dark?", able to contradict `resolved`.
    const active = resolveActiveTheme(DEFAULT_CANVAS, "dark", null, false);

    expect(active).not.toHaveProperty("editor");
  });

  it("answers `auto` from the system preference, once, so nothing downstream re-derives it", () => {
    // Every consumer that re-derived this would need `matchMedia`, which makes
    // it impure and gives the app as many opinions about "is it dark right now"
    // as it has readers.
    expect(resolveActiveTheme(DEFAULT_CANVAS, "auto", null, true).resolved).toBe("dark");
    expect(resolveActiveTheme(DEFAULT_CANVAS, "auto", null, false).resolved).toBe("light");
  });

  it("lets an explicit appearance beat the system preference in both directions", () => {
    expect(resolveActiveTheme(DEFAULT_CANVAS, "light", null, true).resolved).toBe("light");
    expect(resolveActiveTheme(DEFAULT_CANVAS, "dark", null, false).resolved).toBe("dark");
  });

  it("takes a workspace's canvas without taking its appearance", () => {
    // The two are scoped independently on purpose: one canvas is built to
    // render correctly in BOTH modes, so overriding the gradient and overriding
    // the mode are different things to want.
    const override: ProjectSurfaceOverride = { ...EMPTY_SURFACE_OVERRIDE, canvas: TEAL };

    const active = resolveActiveTheme(DEFAULT_CANVAS, "light", override, true);

    expect(active.canvas).toEqual({ value: TEAL, scope: "project" });
    expect(active.appearance).toEqual({ value: "light", scope: "global" });
    expect(active.resolved).toBe("light");
  });

  it("takes a workspace's appearance without taking its canvas", () => {
    const override: ProjectSurfaceOverride = { ...EMPTY_SURFACE_OVERRIDE, appearance: "dark" };

    const active = resolveActiveTheme(DEFAULT_CANVAS, "light", override, false);

    expect(active.canvas).toEqual({ value: DEFAULT_CANVAS, scope: "global" });
    expect(active.appearance).toEqual({ value: "dark", scope: "project" });
    expect(active.resolved).toBe("dark");
  });

  it("resolves a workspace's own `auto` against the system, not against the global choice", () => {
    const override: ProjectSurfaceOverride = { ...EMPTY_SURFACE_OVERRIDE, appearance: "auto" };

    const active = resolveActiveTheme(DEFAULT_CANVAS, "dark", override, false);

    expect(active.appearance.scope).toBe("project");
    expect(active.resolved).toBe("light");
  });

  it("inherits per surface — an override of one surface leaves the others global", () => {
    const active = resolveActiveTheme(
      DEFAULT_CANVAS,
      "dark",
      { ...EMPTY_SURFACE_OVERRIDE, terminalThemeName: "Nord" },
      false,
    );

    expect(active.terminal).toEqual({ value: "Nord", scope: "project" });
    expect(active.canvas.scope).toBe("global");
    expect(active.appearance.scope).toBe("global");
  });

  it("gives a project that overrides only its appearance the matching editor mode", () => {
    // How per-project editor theming survives its own retirement: the project
    // overrides light/dark, and the editor follows that one answer.
    const active = resolveActiveTheme(
      DEFAULT_CANVAS,
      "dark",
      { ...EMPTY_SURFACE_OVERRIDE, appearance: "light" },
      true,
    );

    expect(active.resolved).toBe("light");
  });

  it("hands back the SAME canvas reference it was given, every time", () => {
    // Not a performance nicety, and the reason the seed system needed a WeakMap
    // here. This value is read through a zustand selector, and zustand v5
    // compares each render's snapshot with `Object.is` — a freshly constructed
    // object is an infinite render loop, not a wasted allocation. The resolution
    // PICKS rather than builds, which is what makes the hazard structural rather
    // than something a memo has to keep remembering.
    const override: ProjectSurfaceOverride = { ...EMPTY_SURFACE_OVERRIDE, canvas: TEAL };

    expect(resolveActiveTheme(DEFAULT_CANVAS, "dark", override, false).canvas.value).toBe(TEAL);
    expect(resolveActiveTheme(DEFAULT_CANVAS, "dark", null, false).canvas.value).toBe(
      DEFAULT_CANVAS,
    );
  });
});
