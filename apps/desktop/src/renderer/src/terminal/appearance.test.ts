import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { getBuiltinTheme } from "restty";
import { DEFAULT_THEME, generateThemeTokens, type ThemeDefinition } from "@volli/shared";

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

const fakeRoot = {
  style: {
    setProperty(name: string, value: string) {
      tokenValues.set(name, value);
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
  applyThemeTokens(generateThemeTokens(DEFAULT_THEME), fakeRoot);
});

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

  it("is cached between reads while the theme holds still", () => {
    const first = getCurrentAppearance();
    expect(getCurrentAppearance()).toBe(first);

    refreshTerminalTokenTheme();

    expect(getCurrentAppearance()).not.toBe(first);
  });
});
