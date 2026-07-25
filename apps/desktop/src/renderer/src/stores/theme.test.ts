import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import {
  DEFAULT_THEME,
  EMPTY_PROJECT_THEME_OVERRIDE,
  generateThemeTokens,
  type GhosttyAppearancePayload,
  type ProjectThemeOverride,
  type ThemeDefinition,
  type ThemeStatePayload,
} from "@volli/shared";

import { appliedTheme, createThemeStore, effectiveTheme, type ThemeGateway } from "./theme";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const MIDNIGHT: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Midnight",
  slug: "midnight",
  seed: "#4c6ef5",
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

function statePayload(over: Partial<ThemeStatePayload> = {}): ThemeStatePayload {
  return {
    theme: DEFAULT_THEME,
    projectOverride: null,
    projectId: null,
    terminal: TERMINAL,
    ...over,
  };
}

/** Records what the DOM would have been repainted with, in order. */
function recorder() {
  const applied: ThemeDefinition[] = [];
  return { applied, applyTheme: (theme: ThemeDefinition) => void applied.push(theme) };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    read: (key: string) => data.get(key) ?? null,
    storage: {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => void data.set(name, value),
      removeItem: (name: string) => void data.delete(name),
    },
  };
}

function fakeGateway(over: Partial<ThemeGateway> = {}): ThemeGateway {
  return {
    state: vi.fn(async () => ({ ok: true as const, value: statePayload() })),
    setGlobal: vi.fn(async (theme: ThemeDefinition) => ({
      ok: true as const,
      value: statePayload({ theme }),
    })),
    setProject: vi.fn(async (projectId: string, override: ProjectThemeOverride | null) => ({
      ok: true as const,
      project: { id: projectId } as never,
      value: statePayload({ projectId, projectOverride: override }),
    })),
    ...over,
  };
}

function freshStore(over: Partial<ThemeGateway> = {}) {
  const gateway = fakeGateway(over);
  const paint = recorder();
  const memory = memoryStorage();
  const store = createThemeStore({
    deps: { gateway, applyTheme: paint.applyTheme },
    storage: memory.storage,
  });
  return { store, gateway, paint, memory };
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hydrate", () => {
  it("adopts the authored state and paints it", async () => {
    const { store, paint } = freshStore({
      state: vi.fn(async () => ({ ok: true as const, value: statePayload({ theme: MIDNIGHT }) })),
    });

    await store.getState().hydrate();

    expect(store.getState().global).toEqual(MIDNIGHT);
    expect(store.getState().terminal).toEqual(TERMINAL);
    expect(store.getState().hydrated).toBe(true);
    expect(paint.applied).toEqual([MIDNIGHT]);
  });

  it("scopes the read to a project when asked (#69)", async () => {
    const override: ProjectThemeOverride = {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "midnight",
    };
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({ projectId: "p1", projectOverride: override }),
      })),
    });

    await store.getState().hydrate("p1");

    expect(gateway.state).toHaveBeenCalledWith({ projectId: "p1" });
    expect(store.getState().projectOverride).toEqual(override);
  });

  it("toasts a typed read failure and keeps the shipped default", async () => {
    const { store } = freshStore({
      state: vi.fn(async () => ({ ok: false as const, error: "db closed" })),
    });

    await store.getState().hydrate();

    expect(store.getState().global).toEqual(DEFAULT_THEME);
    expect(store.getState().hydrated).toBe(false);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not load the theme: db closed",
      expect.anything(),
    );
  });

  it("toasts a rejected bridge call", async () => {
    const { store } = freshStore({
      state: vi.fn(() => Promise.reject(new Error("ipc gone"))),
    });

    await store.getState().hydrate();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not load the theme: ipc gone",
      expect.anything(),
    );
  });
});

describe("preview", () => {
  it("repaints the live DOM and writes NOTHING", () => {
    const { store, gateway, paint, memory } = freshStore();

    store.getState().startPreview(MIDNIGHT);

    expect(paint.applied).toEqual([MIDNIGHT]);
    expect(effectiveTheme(store.getState())).toEqual(MIDNIGHT);
    expect(gateway.setGlobal).not.toHaveBeenCalled();
    expect(gateway.setProject).not.toHaveBeenCalled();
    // The persisted slice is favorites/recents only — a previewed theme must
    // leave no trace in it, even though `persist` writes on every state change.
    expect(memory.read("volli:theme") ?? "").not.toContain("midnight");
  });

  it("restores the pre-preview theme on cancel, still touching no persistence", () => {
    const { store, gateway, paint, memory } = freshStore();

    store.getState().startPreview(MIDNIGHT);
    store.getState().cancelPreview();

    expect(paint.applied).toEqual([MIDNIGHT, DEFAULT_THEME]);
    expect(store.getState().global).toEqual(DEFAULT_THEME);
    expect(gateway.setGlobal).not.toHaveBeenCalled();
    expect(memory.read("volli:theme") ?? "").not.toContain("midnight");
  });

  it("cancelling without a preview is a no-op", () => {
    const { store, paint } = freshStore();

    store.getState().cancelPreview();

    expect(paint.applied).toEqual([]);
  });

  it("follows the selection as it moves, without repainting the same theme twice", () => {
    const { store, paint } = freshStore();

    store.getState().startPreview(MIDNIGHT);
    store.getState().startPreview(DEFAULT_THEME);
    // Cancelling back onto the theme already on screen costs nothing — a paint
    // re-themes every live terminal, so redundant ones are suppressed.
    store.getState().cancelPreview();

    expect(paint.applied).toEqual([MIDNIGHT, DEFAULT_THEME]);
  });
});

describe("commit", () => {
  it("persists the previewed theme once, and remembers it as recent", async () => {
    const { store, gateway } = freshStore();
    store.getState().startPreview(MIDNIGHT);

    await expect(store.getState().commitPreview({ kind: "global" })).resolves.toBe(true);

    expect(gateway.setGlobal).toHaveBeenCalledTimes(1);
    expect(gateway.setGlobal).toHaveBeenCalledWith(MIDNIGHT);
    expect(store.getState().preview).toBeNull();
    expect(store.getState().global).toEqual(MIDNIGHT);
    expect(store.getState().recents).toEqual(["midnight"]);
  });

  it("commits with nothing previewed by doing nothing", async () => {
    const { store, gateway } = freshStore();

    await expect(store.getState().commitPreview({ kind: "global" })).resolves.toBe(false);

    expect(gateway.setGlobal).not.toHaveBeenCalled();
  });

  it("repaints back to the previous theme when the write fails", async () => {
    const { store, paint } = freshStore({
      setGlobal: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.getState().startPreview(MIDNIGHT);

    await expect(store.getState().commitPreview({ kind: "global" })).resolves.toBe(false);

    expect(store.getState().global).toEqual(DEFAULT_THEME);
    expect(paint.applied).toEqual([MIDNIGHT, DEFAULT_THEME]);
    // The optimistic Recent entry rolls back with the theme: Recent means
    // "applied", and this one never made it to disk.
    expect(store.getState().recents).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Could not save the theme: disk full",
      expect.anything(),
    );
  });

  it("rolls the optimistic Recent entry back when a project write fails too", async () => {
    const { store } = freshStore({
      setProject: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.setState({ recents: ["ember"] });
    store.getState().startPreview(MIDNIGHT);

    await expect(
      store.getState().commitPreview({ kind: "project", projectId: "p1" }),
    ).resolves.toBe(false);

    expect(store.getState().recents).toEqual(["ember"]);
  });

  it("writes a project's app-surface override for a project scope", async () => {
    const { store, gateway } = freshStore();
    store.getState().startPreview(MIDNIGHT);

    await expect(
      store.getState().commitPreview({ kind: "project", projectId: "p1" }),
    ).resolves.toBe(true);

    expect(gateway.setProject).toHaveBeenCalledWith("p1", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "midnight",
    });
    expect(gateway.setGlobal).not.toHaveBeenCalled();
  });

  it("keeps a project's other surfaces untouched — resolution is per surface", async () => {
    const { store, gateway } = freshStore();
    store.setState({
      projectId: "p1",
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, terminalThemeName: "Nord" },
    });
    store.getState().startPreview(MIDNIGHT);

    await store.getState().commitPreview({ kind: "project", projectId: "p1" });

    expect(gateway.setProject).toHaveBeenCalledWith("p1", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "midnight",
      terminalThemeName: "Nord",
    });
  });

  it("setGlobalTheme commits directly, without a preview round trip", async () => {
    const { store, gateway, paint } = freshStore();

    await expect(store.getState().setGlobalTheme(MIDNIGHT)).resolves.toBe(true);

    expect(gateway.setGlobal).toHaveBeenCalledWith(MIDNIGHT);
    expect(paint.applied).toEqual([MIDNIGHT]);
  });
});

describe("favorites and recents", () => {
  it("stars and unstars, persisting through app_state", () => {
    const { store, memory } = freshStore();

    store.getState().toggleFavorite("midnight");

    expect(store.getState().favorites).toEqual(["midnight"]);
    expect(memory.read("volli:theme")).toContain("midnight");

    store.getState().toggleFavorite("midnight");
    expect(store.getState().favorites).toEqual([]);
  });

  it("rehydrates favorites and recents, ignoring corrupt persisted shapes", () => {
    const memory = memoryStorage();
    memory.storage.setItem(
      "volli:theme",
      JSON.stringify({ state: { favorites: ["moss", 7], recents: "nope" }, version: 1 }),
    );
    const store = createThemeStore({
      deps: { gateway: fakeGateway(), applyTheme: () => {} },
      storage: memory.storage,
    });

    expect(store.getState().favorites).toEqual(["moss"]);
    expect(store.getState().recents).toEqual([]);
  });
});

describe("terminal appearance", () => {
  it("accepts a fresh payload after an overlay write, so rows relabel without a refetch", () => {
    const { store } = freshStore();
    const next: GhosttyAppearancePayload = {
      ...TERMINAL,
      provenance: { theme: "volli-global" },
    };

    store.getState().acceptTerminal(next);

    expect(store.getState().terminal).toEqual(next);
  });

  it("adopts the config-changed broadcast when the store is on the global scope", () => {
    const { store, gateway } = freshStore();
    const next: GhosttyAppearancePayload = { ...TERMINAL, provenance: { theme: "ghostty" } };

    store.getState().acceptGlobalTerminal(next);

    expect(store.getState().terminal).toEqual(next);
    expect(gateway.state).not.toHaveBeenCalled();
  });

  it("re-requests the scoped resolution instead, when a project scope is loaded", async () => {
    // The broadcast carries no project layer (main/ghostty-config.ts), so
    // adopting it would relabel a project's rows with global provenance.
    const projectPayload: GhosttyAppearancePayload = {
      ...TERMINAL,
      provenance: { theme: "volli-project" },
      overlayPaths: { global: TERMINAL.overlayPaths.global, project: "/data/volli/p1/config" },
    };
    const { store, gateway } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({ projectId: "p1", terminal: projectPayload }),
      })),
    });
    await store.getState().hydrate("p1");

    store.getState().acceptGlobalTerminal({ ...TERMINAL, provenance: { theme: "ghostty" } });
    await vi.waitFor(() => expect(gateway.state).toHaveBeenCalledTimes(2));

    expect(gateway.state).toHaveBeenLastCalledWith({ projectId: "p1" });
    expect(store.getState().terminal).toEqual(projectPayload);
  });
});

describe("effectiveTheme", () => {
  it("prefers the preview, then the project override, then the global theme", () => {
    expect(
      effectiveTheme({ preview: MIDNIGHT, global: DEFAULT_THEME, projectOverride: null }),
    ).toEqual(MIDNIGHT);

    expect(effectiveTheme({ preview: null, global: MIDNIGHT, projectOverride: null })).toEqual(
      MIDNIGHT,
    );

    const tinted = effectiveTheme({
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" },
    });
    expect(tinted.seed).toBe("#3f9142");
  });

  it("returns the IDENTICAL reference for unchanged state, on every path", () => {
    // The invariant, not the value: this is read as a zustand v5 selector,
    // i.e. through `useSyncExternalStore`, which compares snapshots with
    // `Object.is` on every render. Any path that builds a fresh object here is
    // an infinite render loop, not a wasted allocation. The auto-tint path is
    // the one that has to build one, so it is the one that must be pinned.
    const tinting = {
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" },
    };
    expect(effectiveTheme(tinting)).toBe(effectiveTheme(tinting));

    const previewing = { preview: MIDNIGHT, global: DEFAULT_THEME, projectOverride: null };
    expect(effectiveTheme(previewing)).toBe(effectiveTheme(previewing));

    const plain = { preview: null, global: MIDNIGHT, projectOverride: null };
    expect(effectiveTheme(plain)).toBe(effectiveTheme(plain));

    const named = {
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: DEFAULT_THEME.slug },
    };
    expect(effectiveTheme(named)).toBe(effectiveTheme(named));
  });
});

describe("appliedTheme", () => {
  const TINTED = { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" };

  it("is the global theme for the global scope, whatever a project overrides", () => {
    const state = { global: MIDNIGHT, projectId: "p1", projectOverride: TINTED };

    expect(appliedTheme(state, { kind: "global" })).toBe(MIDNIGHT);
  });

  it("resolves the project's own override for its scope", () => {
    const state = { global: DEFAULT_THEME, projectId: "p1", projectOverride: TINTED };

    expect(appliedTheme(state, { kind: "project", projectId: "p1" }).seed).toBe("#3f9142");
  });

  it("never borrows another project's override", () => {
    const state = { global: MIDNIGHT, projectId: "p1", projectOverride: TINTED };

    expect(appliedTheme(state, { kind: "project", projectId: "p2" })).toBe(MIDNIGHT);
  });

  it("ignores a running preview — it reports what is stored, not what is on screen", () => {
    const { store } = freshStore();
    store.getState().startPreview(MIDNIGHT);

    expect(appliedTheme(store.getState(), { kind: "global" })).toEqual(DEFAULT_THEME);
    expect(effectiveTheme(store.getState())).toEqual(MIDNIGHT);
  });
});

describe("createThemeStore() with the default deps", () => {
  // No fakes injected: these exercise the real window.api wrappers and the
  // real DOM apply path, which every other test in this file bypasses.
  it("routes through window.api.theme and paints the document element", async () => {
    const written = new Map<string, string>();
    const state = vi.fn(async () => ({
      ok: true as const,
      value: statePayload({ theme: MIDNIGHT }),
    }));
    const setGlobal = vi.fn(async () => ({ ok: true as const, value: statePayload() }));
    const setProject = vi.fn(async () => ({ ok: false as const, error: "unused" }));
    vi.stubGlobal("window", { api: { theme: { state, setGlobal, setProject } } });
    vi.stubGlobal("document", {
      documentElement: {
        style: { setProperty: (name: string, value: string) => void written.set(name, value) },
      },
    });
    const store = createThemeStore();

    await store.getState().hydrate();

    expect(state).toHaveBeenCalledWith({});
    // Exactly Midnight's generated --background — asserted against the
    // generator (as window-theme.test.ts does) so the two can't drift, and
    // still meaningful because nothing writes this key unless the store paints.
    expect(written.get("--background")).toBe(generateThemeTokens(MIDNIGHT)["--background"]);

    await store.getState().setGlobalTheme(DEFAULT_THEME);
    expect(setGlobal).toHaveBeenCalledWith(DEFAULT_THEME);

    store.setState({ preview: MIDNIGHT });
    await store.getState().commitPreview({ kind: "project", projectId: "p1" });
    expect(setProject).toHaveBeenCalled();
  });
});
