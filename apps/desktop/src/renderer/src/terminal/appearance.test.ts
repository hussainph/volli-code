import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { getBuiltinTheme } from "restty";
import { DEFAULT_THEME, generateThemeTokens, type ThemeDefinition } from "@volli/shared";
import type { GhosttyAppearancePayload, GhosttyConfigResult } from "@volli/shared";

import { applyThemeTokens } from "@renderer/theme/apply";

import { DEFAULT_TERMINAL_FONT_SIZE } from "./appearance-model";

import {
  getCurrentAppearance,
  onTerminalAppearanceChanged,
  previewTerminalTheme,
  refreshTerminalTokenTheme,
} from "./appearance";

/**
 * The token-derived terminal fallback is the one piece of terminal appearance
 * that follows the APP theme, so it is also the one that can silently go stale:
 * `tokenTheme()` caches the first complete read forever. These tests stand a
 * minimal DOM in (the renderer test project runs under vitest's default `node`
 * environment) whose computed styles are backed by the very map
 * `applyThemeTokens` writes into — so "the app theme changed" and "the terminal
 * re-read its tokens" are the same event here that they are in the browser.
 */
const tokenValues = new Map<string, string>();

/** The mode class the paint path stamps on `<html>`; drives the literal fallbacks. */
const rootClasses = new Set<string>();

const fakeRoot = {
  style: {
    setProperty(name: string, value: string) {
      tokenValues.set(name, value);
    },
  },
  classList: {
    contains(name: string) {
      return rootClasses.has(name);
    },
  },
} as unknown as HTMLElement;

const MIDNIGHT: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Midnight",
  slug: "midnight",
  seed: "#4c6ef5",
};

type Globals = { document?: unknown; getComputedStyle?: unknown };
let originalDocument: unknown;
let originalGetComputedStyle: unknown;

beforeAll(() => {
  const globals = globalThis as Globals;
  originalDocument = globals.document;
  originalGetComputedStyle = globals.getComputedStyle;
  globals.document = { documentElement: fakeRoot };
  globals.getComputedStyle = () => ({
    getPropertyValue: (name: string) => tokenValues.get(name) ?? "",
  });
});

afterAll(() => {
  const globals = globalThis as Globals;
  globals.document = originalDocument;
  globals.getComputedStyle = originalGetComputedStyle;
});

beforeEach(() => {
  rootClasses.clear();
  applyThemeTokens(generateThemeTokens(DEFAULT_THEME), fakeRoot);
});

/**
 * A light token set. The generator is dark-only today, so the four tokens the
 * terminal fallback reads are written straight in — which is also the honest
 * fixture, since what this module consumes is `getComputedStyle`, not a theme.
 */
function applyLightTokens(): void {
  tokenValues.set("--background", "#fdded2");
  tokenValues.set("--foreground", "#120906");
  tokenValues.set("--primary", "#d6744d");
  tokenValues.set("--destructive", "#e5484d");
  refreshTerminalTokenTheme();
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** One sRGB channel, linearized. */
function linearize(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio, 1–21. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The twelve chromatic slots — the greys (0, 7, 8, 15) are a ramp, not colors. */
const CHROMATIC = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];

/**
 * The background and full ANSI set the config-less terminal is painting with
 * right now. Both are optional on restty's theme type and neither is ever
 * absent here, so a missing one is a bug in the module rather than a case to
 * branch on — it fails loudly instead of quietly skipping the assertions.
 */
function currentPalette(): { background: Rgb; entry: (index: number) => Rgb } {
  const { colors } = getCurrentAppearance().theme;
  const background = colors.background;
  if (background === undefined) throw new Error("the token theme has no background");
  return {
    background,
    entry: (index) => {
      const color = colors.palette[index];
      if (color === undefined) throw new Error(`the token theme has no palette[${index}]`);
      return color;
    },
  };
}

/**
 * The floor every chromatic ANSI entry has to clear against the background it
 * is painted on. 2.5 rather than WCAG's 3.0 for one measured reason: on a
 * *tinted* light canvas (Ember's light background is a warm peach, not white)
 * the pale bright row of every established light set lands just under 3, and the
 * alternative to accepting that is inventing a palette instead of using one.
 */
const MIN_CHROMATIC_CONTRAST = 2.5;

describe("the token-derived terminal fallback", () => {
  it("paints a config-less terminal from the live app tokens", () => {
    const ember = generateThemeTokens(DEFAULT_THEME);

    const { colors } = getCurrentAppearance().theme;

    expect(colors.background).toEqual({ r: 0x15, g: 0x10, b: 0x0e });
    expect(ember["--background"]).toBe("#15100e");
    expect(colors.cursor).toEqual({ r: 0xe8, g: 0x65, b: 0x2a });
  });

  it("repaints when the app theme changes", () => {
    const midnight = generateThemeTokens(MIDNIGHT);

    applyThemeTokens(midnight, fakeRoot);

    // #0f1117 — the cached ember palette must not survive the theme change.
    expect(getCurrentAppearance().theme.colors.background).toEqual({
      r: 0x0f,
      g: 0x11,
      b: 0x17,
    });
    expect(getCurrentAppearance().theme.colors.cursor).toEqual({
      r: 0x65,
      g: 0x89,
      b: 0xff,
    });
  });

  it("notifies live terminals so they re-theme in place", () => {
    let notified = 0;
    const unsubscribe = onTerminalAppearanceChanged(() => {
      notified += 1;
    });

    applyThemeTokens(generateThemeTokens(MIDNIGHT), fakeRoot);

    expect(notified).toBe(1);
    unsubscribe();
  });

  it("swaps the palette for a preview and puts it back, notifying both ways", () => {
    const preview = getBuiltinTheme("Nord");
    expect(preview).not.toBeNull();
    const before = getCurrentAppearance().theme;
    let notified = 0;
    const unsubscribe = onTerminalAppearanceChanged(() => {
      notified += 1;
    });

    previewTerminalTheme(preview);
    expect(getCurrentAppearance().theme).toBe(preview);
    // Everything that is not the palette survives the swap.
    expect(getCurrentAppearance().fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);

    previewTerminalTheme(null);
    expect(getCurrentAppearance().theme).toEqual(before);
    expect(notified).toBe(2);
    unsubscribe();
  });

  // Preview is driven by hover/keyboard motion through a theme list, which
  // re-asserts the same theme constantly; re-notifying would repaint every live
  // terminal for a no-op.
  it("ignores a repeated preview of the theme already showing", () => {
    const preview = getBuiltinTheme("Nord");
    let notified = 0;
    const unsubscribe = onTerminalAppearanceChanged(() => {
      notified += 1;
    });

    previewTerminalTheme(preview);
    previewTerminalTheme(preview);

    expect(notified).toBe(1);
    previewTerminalTheme(null);
    unsubscribe();
  });

  it("is cached between reads while the theme holds still", () => {
    const first = getCurrentAppearance();
    expect(getCurrentAppearance()).toBe(first);

    refreshTerminalTokenTheme();

    expect(getCurrentAppearance()).not.toBe(first);
  });

  it("mirrors --destructive into normal red in both modes", () => {
    expect(getCurrentAppearance().theme.colors.palette[1]).toEqual({ r: 0xe5, g: 0x48, b: 0x4d });

    applyLightTokens();

    expect(getCurrentAppearance().theme.colors.palette[1]).toEqual({ r: 0xe5, g: 0x48, b: 0x4d });
  });

  it("swaps the whole ANSI set when the background crosses over", () => {
    // Dark's ANSI black is a near-background grey; light's is a near-foreground
    // one. If the palette ever stopped following the background, this is the
    // entry that would still look plausible while being exactly inverted.
    expect(getCurrentAppearance().theme.colors.palette[0]).toEqual({ r: 0x1c, g: 0x1c, b: 0x1c });
    expect(getCurrentAppearance().theme.name).toBe("Volli Dark");

    applyLightTokens();

    expect(getCurrentAppearance().theme.colors.palette[0]).toEqual({ r: 0x24, g: 0x29, b: 0x2f });
    expect(getCurrentAppearance().theme.name).toBe("Volli Light");
  });

  /**
   * The regression this whole mode split exists for. The app tokens are hex in
   * both modes, so `parseHexColor` keeps succeeding and a config-less terminal
   * under light used to get a light background with the dark ANSI palette on
   * top — no error, no warning, just unreadable output.
   */
  it("keeps every chromatic color legible on the background it sits on, in both modes", () => {
    for (const paint of [() => undefined, applyLightTokens]) {
      paint();
      const { background, entry } = currentPalette();

      for (const index of CHROMATIC) {
        expect(
          contrast(entry(index), background),
          `palette[${index}] on ${JSON.stringify(background)}`,
        ).toBeGreaterThanOrEqual(MIN_CHROMATIC_CONTRAST);
      }
    }
  });

  /**
   * The four greys are a RAMP, and programs read meaning off it: `bright black`
   * is the dim/comment color and `white` is ordinary output. The ramp runs the
   * same direction in both modes (black → bright white, increasing lightness);
   * which end sits nearest the background is what the mode decides.
   */
  it("keeps the grey ramp ordered and both of its working slots readable", () => {
    for (const paint of [() => undefined, applyLightTokens]) {
      paint();
      const { background, entry } = currentPalette();
      const [black, brightBlack, white, brightWhite] = [entry(0), entry(8), entry(7), entry(15)];

      expect(luminance(black)).toBeLessThan(luminance(brightBlack));
      expect(luminance(brightBlack)).toBeLessThan(luminance(white));
      expect(luminance(white)).toBeLessThan(luminance(brightWhite));

      // Dim text must still be text.
      expect(contrast(brightBlack, background)).toBeGreaterThanOrEqual(2);
      // Ordinary output must be comfortably legible.
      expect(contrast(white, background)).toBeGreaterThanOrEqual(3);
    }
  });

  it("takes the literal fallbacks for the mode stamped on the document", () => {
    rootClasses.add("light");
    tokenValues.clear();
    refreshTerminalTokenTheme();

    const { colors } = getCurrentAppearance().theme;
    expect(colors.background).toEqual({ r: 0xfd, g: 0xde, b: 0xd2 });
    // …and the palette follows that background rather than the stamped class,
    // so the two can never disagree.
    expect(colors.palette[0]).toEqual({ r: 0x24, g: 0x29, b: 0x2f });
  });

  // The stylesheet may not have applied when the module first reads tokens, so
  // an incomplete read is SERVED but never cached — otherwise a terminal that
  // happened to boot a frame early would keep the literal fallbacks forever.
  it("serves the literal fallbacks without caching them when a token is unreadable", () => {
    tokenValues.clear();
    refreshTerminalTokenTheme();

    // The globals.css literals — --background / --primary of the generated
    // Ember default, which is what the fallbacks mirror.
    expect(getCurrentAppearance().theme.colors.background).toEqual({ r: 0x15, g: 0x10, b: 0x0e });
    expect(getCurrentAppearance().theme.colors.cursor).toEqual({ r: 0xe8, g: 0x65, b: 0x2a });

    // Nothing was cached, so the very next theme read picks the tokens up.
    applyThemeTokens(generateThemeTokens(MIDNIGHT), fakeRoot);
    expect(getCurrentAppearance().theme.colors.background).toEqual({ r: 0x0f, g: 0x11, b: 0x17 });
  });
});

/** The stub preload bridge `initTerminalAppearance` boots against. */
interface TerminalApi {
  onGhosttyConfigChanged(listener: (payload: GhosttyAppearancePayload) => void): void;
  ghosttyConfig(): Promise<GhosttyConfigResult>;
}

/** A minimal resolved appearance payload — font size is the one field these cases read back. */
function payloadWithFontSize(fontSize: number): GhosttyAppearancePayload {
  return {
    prefs: {
      fontFamilies: [],
      fontSize,
      themeName: null,
      ligatures: null,
      scrollbackLimitBytes: null,
      mouseReporting: null,
      macosOptionAsAlt: null,
    },
    configText: null,
    themeSource: null,
    provenance: {},
    overlayPaths: { global: "/userData/volli/ghostty/config", project: null },
    ghosttyConfigPath: "/home/u/.config/ghostty/config",
  };
}

/**
 * `initTerminalAppearance` is the module's one stateful entry point — it
 * subscribes once and never again — so each case runs against a FRESH module
 * instance (`vi.resetModules()`), the only way to exercise both the first call
 * and the idempotent second one.
 */
describe("initTerminalAppearance", () => {
  type WindowGlobal = { window?: unknown };
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = (globalThis as WindowGlobal).window;
  });

  afterEach(() => {
    (globalThis as WindowGlobal).window = originalWindow;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** A fresh module instance bound to a stub preload bridge. */
  async function freshModule(terminal: TerminalApi): Promise<typeof import("./appearance")> {
    vi.resetModules();
    (globalThis as WindowGlobal).window = { api: { terminal } };
    return await import("./appearance");
  }

  it("adopts the config main answers with and republishes it to live terminals", async () => {
    const appearance = await freshModule({
      onGhosttyConfigChanged: () => undefined,
      ghosttyConfig: () => Promise.resolve({ ok: true, value: payloadWithFontSize(21) }),
    });
    let notified = 0;
    appearance.onTerminalAppearanceChanged(() => {
      notified += 1;
    });

    await appearance.initTerminalAppearance();

    expect(appearance.getCurrentAppearance().fontSize).toBe(21);
    expect(notified).toBe(1);
  });

  it("adopts a live config edit pushed from main's file watch", async () => {
    const pushes: Array<(payload: GhosttyAppearancePayload) => void> = [];
    const appearance = await freshModule({
      onGhosttyConfigChanged: (listener) => {
        pushes.push(listener);
      },
      ghosttyConfig: () => Promise.resolve({ ok: true, value: payloadWithFontSize(21) }),
    });
    await appearance.initTerminalAppearance();

    expect(pushes).toHaveLength(1);
    pushes[0]?.(payloadWithFontSize(9));

    expect(appearance.getCurrentAppearance().fontSize).toBe(9);
  });

  // A config READ is not a mutation, so it is logged rather than toasted — the
  // terminal simply keeps its token-derived defaults.
  it("keeps the token defaults and logs when main reports a read failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appearance = await freshModule({
      onGhosttyConfigChanged: () => undefined,
      ghosttyConfig: () => Promise.resolve({ ok: false, error: "EACCES" }),
    });

    await appearance.initTerminalAppearance();

    expect(appearance.getCurrentAppearance().fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(warnSpy).toHaveBeenCalledWith("ghostty config read failed:", "EACCES");
  });

  it("keeps the token defaults and logs when the invoke itself rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("bridge is gone");
    const appearance = await freshModule({
      onGhosttyConfigChanged: () => undefined,
      ghosttyConfig: () => Promise.reject(failure),
    });

    await appearance.initTerminalAppearance();

    expect(appearance.getCurrentAppearance().fontSize).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(warnSpy).toHaveBeenCalledWith("ghostty config read failed:", failure);
  });

  it("is idempotent, so a second boot path cannot double-subscribe", async () => {
    const ghosttyConfig = vi.fn(() =>
      Promise.resolve<GhosttyConfigResult>({ ok: true, value: payloadWithFontSize(21) }),
    );
    const onGhosttyConfigChanged = vi.fn();
    const appearance = await freshModule({ onGhosttyConfigChanged, ghosttyConfig });

    await appearance.initTerminalAppearance();
    await appearance.initTerminalAppearance();

    expect(ghosttyConfig).toHaveBeenCalledTimes(1);
    expect(onGhosttyConfigChanged).toHaveBeenCalledTimes(1);
  });
});
