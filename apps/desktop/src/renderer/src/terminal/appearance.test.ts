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
