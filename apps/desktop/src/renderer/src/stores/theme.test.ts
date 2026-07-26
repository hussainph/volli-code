import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import {
  DEFAULT_THEME,
  EMPTY_PROJECT_THEME_OVERRIDE,
  PROJECT_COLORS,
  generateThemeTokens,
  type GhosttyAppearancePayload,
  type ProjectThemeOverride,
  type ShippedEditorThemeId,
  type ThemeDefinition,
  type ThemeStatePayload,
  type ThemeStateResult,
} from "@volli/shared";

import { autoTintChoice } from "@renderer/components/theme/project-appearance-model";
import { PROJECT_TINT_SLUG } from "@renderer/theme/apply";
import {
  SCOPE_TRANSITION_ATTRIBUTE,
  SCOPE_TRANSITION_VALUE,
} from "@renderer/theme/scope-transition";

import { appliedTheme, createThemeStore, effectiveTheme, type ThemeGateway } from "./theme";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const MIDNIGHT: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Midnight",
  slug: "midnight",
  seed: "#4c6ef5",
};

/** A theme of the user's own — one with a file behind it. */
const SUNSET: ThemeDefinition = {
  ...DEFAULT_THEME,
  name: "Sunset",
  slug: "sunset",
  seed: "#ff8a3d",
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
    editorThemeId: null,
    projectOverride: null,
    projectId: null,
    terminal: TERMINAL,
    ...over,
  };
}

/** Records what the DOM would have been repainted with, in order. */
function recorder() {
  const applied: ThemeDefinition[] = [];
  const editorThemes: string[] = [];
  // Records the EASED repaints specifically: the theme each one was armed for,
  // so a test can assert both that the crossfade ran and what it ran into.
  const eased: (ThemeDefinition | undefined)[] = [];
  let arming = false;
  return {
    applied,
    editorThemes,
    eased,
    applyTheme: (theme: ThemeDefinition) => {
      applied.push(theme);
      if (arming) eased.push(theme);
      arming = false;
    },
    refreshEditorTheme: (themeId: string) => void editorThemes.push(themeId),
    beginScopeRepaint: () => {
      arming = true;
    },
  };
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
    setGlobalEditor: vi.fn(async (editorThemeId: ShippedEditorThemeId | null) => ({
      ok: true as const,
      value: statePayload({ editorThemeId }),
    })),
    setProject: vi.fn(async (projectId: string, override: ProjectThemeOverride | null) => ({
      ok: true as const,
      project: { id: projectId } as never,
      value: statePayload({ projectId, projectOverride: override }),
    })),
    listCustomThemes: vi.fn(async () => ({ ok: true as const, themes: [SUNSET] })),
    saveCustomTheme: vi.fn(async (theme: ThemeDefinition) => ({
      ok: true as const,
      path: `/data/volli/themes/${theme.slug}.json`,
      themes: [theme],
    })),
    deleteCustomTheme: vi.fn(async () => ({ ok: true as const, themes: [] })),
    openCustomTheme: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

function freshStore(over: Partial<ThemeGateway> = {}) {
  const gateway = fakeGateway(over);
  const paint = recorder();
  const memory = memoryStorage();
  const store = createThemeStore({
    deps: {
      gateway,
      applyTheme: paint.applyTheme,
      refreshEditorTheme: paint.refreshEditorTheme,
      beginScopeRepaint: paint.beginScopeRepaint,
    },
    storage: memory.storage,
  });
  return { store, gateway, paint, memory };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    expect(store.getState().editorThemeId).toBeNull();
    expect(store.getState().terminal).toEqual(TERMINAL);
    expect(store.getState().hydrated).toBe(true);
    expect(paint.applied).toEqual([MIDNIGHT]);
    // null editorThemeId → derive from midnight → tokyo-night
    expect(paint.editorThemes).toEqual(["tokyo-night"]);
  });

  it("adopts a persisted global editor theme id and refreshes Monaco with it", async () => {
    const { store, paint } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({ editorThemeId: "nord" }),
      })),
    });

    await store.getState().hydrate();

    expect(store.getState().editorThemeId).toBe("nord");
    expect(paint.editorThemes).toEqual(["nord"]);
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

  // Boot's two reads overlap by design: main.tsx fires the global one the
  // moment the renderer starts, and boot() fires the project-scoped one as
  // soon as it has resolved the persisted selection. Whichever is issued LAST
  // is the scope the app is in — arrival order is a network fact, not intent.
  it("drops a stale read that lands after a newer one was issued", async () => {
    const override: ProjectThemeOverride = {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "midnight",
    };
    const globalRead = deferred<ThemeStateResult>();
    const projectRead = deferred<ThemeStateResult>();
    const pending = [globalRead.promise, projectRead.promise];
    const { store } = freshStore({ state: vi.fn(() => pending.shift()!) });

    const stale = store.getState().hydrate(); // main.tsx, global scope
    const fresh = store.getState().hydrate("p1"); // boot, restored selection

    projectRead.resolve({
      ok: true,
      value: statePayload({ projectId: "p1", projectOverride: override }),
    });
    await fresh;
    globalRead.resolve({ ok: true, value: statePayload() });
    await stale;

    expect(store.getState().projectId).toBe("p1");
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
      "Couldn't load the theme: db closed",
      expect.anything(),
    );
  });

  it("toasts a rejected bridge call", async () => {
    const { store } = freshStore({
      state: vi.fn(() => Promise.reject(new Error("ipc gone"))),
    });

    await store.getState().hydrate();

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't load the theme: ipc gone",
      expect.anything(),
    );
  });
});

describe("the eased scope-change repaint (#69)", () => {
  it("cuts straight to the theme on the first paint", async () => {
    // Boot has no previous look to come from — a crossfade here would read as
    // the app slowly fading in something it had already rendered.
    const { store, paint } = freshStore();

    await store.getState().hydrate("p1");

    expect(paint.applied).toHaveLength(1);
    expect(paint.eased).toEqual([]);
  });

  it("eases the repaint when the scope moves to another project", async () => {
    const override: ProjectThemeOverride = {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: MIDNIGHT.slug,
    };
    const scopes: Record<string, ThemeStatePayload> = {
      p1: statePayload({ projectId: "p1" }),
      p2: statePayload({ projectId: "p2", projectOverride: override, theme: MIDNIGHT }),
    };
    const { store, paint } = freshStore({
      state: vi.fn(async (input: { projectId?: string }) => ({
        ok: true as const,
        value: scopes[input.projectId ?? "p1"]!,
      })),
    });

    await store.getState().hydrate("p1");
    await store.getState().hydrate("p2");

    // The transition IS the signal that the window now belongs to another
    // project, so it is armed for exactly that swap.
    expect(paint.eased).toEqual([MIDNIGHT]);
  });

  it("does not ease a theme change inside one scope", async () => {
    // A pick is a direct answer to a keystroke; 300ms of crossfade there is
    // latency on the input path, not polish.
    const { store, paint } = freshStore();
    await store.getState().hydrate();

    await store.getState().setGlobalTheme(MIDNIGHT);

    expect(paint.applied).toContainEqual(MIDNIGHT);
    expect(paint.eased).toEqual([]);
  });

  it("does not ease a preview, however far the seed moves", () => {
    const { store, paint } = freshStore();
    store.getState().startPreview(MIDNIGHT);
    store.getState().cancelPreview();

    expect(paint.eased).toEqual([]);
  });

  it("arms nothing when a scope change resolves to the same theme", async () => {
    // Both projects inherit, so nothing repaints — and a crossfade window with
    // no color change in it would only slow every hover for 300ms.
    const { store, paint } = freshStore({
      state: vi.fn(async (input: { projectId?: string }) => ({
        ok: true as const,
        value: statePayload({ projectId: input.projectId ?? null }),
      })),
    });

    await store.getState().hydrate("p1");
    await store.getState().hydrate("p2");

    expect(paint.applied).toHaveLength(1);
    expect(paint.eased).toEqual([]);
  });
});

describe("setEditorTheme", () => {
  it("persists the global editor id and refreshes Monaco without rewriting the app theme", async () => {
    const { store, gateway, paint } = freshStore();

    await expect(store.getState().setEditorTheme("nord")).resolves.toBe(true);

    expect(gateway.setGlobalEditor).toHaveBeenCalledWith("nord");
    expect(gateway.setGlobal).not.toHaveBeenCalled();
    expect(store.getState().editorThemeId).toBe("nord");
    expect(paint.editorThemes).toEqual(["nord"]);
  });

  it("clears back to derive-from-app and remaps Monaco from the active app slug", async () => {
    const { store, paint } = freshStore({
      state: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({ theme: MIDNIGHT, editorThemeId: "nord" }),
      })),
      setGlobalEditor: vi.fn(async () => ({
        ok: true as const,
        value: statePayload({ theme: MIDNIGHT, editorThemeId: null }),
      })),
    });
    await store.getState().hydrate();
    paint.editorThemes.length = 0;

    await expect(store.getState().setEditorTheme(null)).resolves.toBe(true);

    expect(store.getState().editorThemeId).toBeNull();
    expect(paint.editorThemes).toEqual(["tokyo-night"]);
  });

  it("rolls back the optimistic editor id when persistence fails", async () => {
    const { store, paint } = freshStore({
      setGlobalEditor: vi.fn(async () => ({ ok: false as const, error: "db closed" })),
    });

    await expect(store.getState().setEditorTheme("nord")).resolves.toBe(false);

    expect(store.getState().editorThemeId).toBeNull();
    // optimistic nord, then rollback to ember-derived one-dark-pro
    expect(paint.editorThemes).toEqual(["nord", "one-dark-pro"]);
  });

  it("serializes rapid writes and keeps the newest optimistic selection", async () => {
    const first = deferred<ThemeStateResult>();
    const second = deferred<ThemeStateResult>();
    const setGlobalEditor = vi
      .fn<(editorThemeId: ShippedEditorThemeId | null) => Promise<ThemeStateResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { store } = freshStore({ setGlobalEditor });

    const nordWrite = store.getState().setEditorTheme("nord");
    const draculaWrite = store.getState().setEditorTheme("dracula");

    expect(store.getState().editorThemeId).toBe("dracula");
    await vi.waitFor(() => expect(setGlobalEditor).toHaveBeenCalledTimes(1));
    first.resolve({
      ok: true,
      value: statePayload({ editorThemeId: "nord" }),
    });
    await nordWrite;
    await vi.waitFor(() => expect(setGlobalEditor).toHaveBeenCalledTimes(2));
    expect(store.getState().editorThemeId).toBe("dracula");

    second.resolve({
      ok: true,
      value: statePayload({ editorThemeId: "dracula" }),
    });
    await expect(draculaWrite).resolves.toBe(true);
    expect(store.getState().editorThemeId).toBe("dracula");
  });

  it("does not let a superseded failure roll back the newest selection", async () => {
    const first = deferred<ThemeStateResult>();
    const setGlobalEditor = vi
      .fn<(editorThemeId: ShippedEditorThemeId | null) => Promise<ThemeStateResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        ok: true,
        value: statePayload({ editorThemeId: "dracula" }),
      });
    const { store } = freshStore({ setGlobalEditor });

    const nordWrite = store.getState().setEditorTheme("nord");
    const draculaWrite = store.getState().setEditorTheme("dracula");
    first.resolve({ ok: false, error: "db closed" });

    await expect(nordWrite).resolves.toBe(false);
    await expect(draculaWrite).resolves.toBe(true);
    expect(store.getState().editorThemeId).toBe("dracula");
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

  it("keeps Monaco on the App-preview editor theme when ending an Editor preview", () => {
    // Regression: endEditorPreview used to restore from global.slug (ember →
    // one-dark-pro) while App preview was still Midnight, desyncing Monaco
    // from paintedEditor (tokyo-night).
    const { store, paint, gateway } = freshStore();
    store.getState().startPreview(MIDNIGHT);
    expect(paint.editorThemes.at(-1)).toBe("tokyo-night");
    paint.editorThemes.length = 0;

    store.getState().startEditorPreview("nord");
    expect(paint.editorThemes).toEqual(["nord"]);
    paint.editorThemes.length = 0;

    store.getState().endEditorPreview();

    expect(paint.editorThemes).toEqual(["tokyo-night"]);
    expect(store.getState().preview).toEqual(MIDNIGHT);
    expect(gateway.setGlobal).not.toHaveBeenCalled();
    expect(gateway.setGlobalEditor).not.toHaveBeenCalled();
  });

  it("re-previewing the same App theme refreshes Monaco after an editor desync", () => {
    // Stuck case: paintedEditor still tokyo-night after an out-of-band paint
    // left Monaco on one-dark-pro. Re-highlighting Midnight must refresh, not
    // skip because the tracker already says tokyo-night.
    const { store, paint } = freshStore();
    store.getState().startPreview(MIDNIGHT);
    expect(paint.editorThemes.at(-1)).toBe("tokyo-night");

    // Bypass the store the way the old Appearance Editor restore did.
    paint.refreshEditorTheme("one-dark-pro");
    paint.editorThemes.length = 0;

    store.getState().startPreview(MIDNIGHT);

    expect(paint.editorThemes).toEqual(["tokyo-night"]);
  });
});

describe("editor preview", () => {
  it("treats an empty editor preview id as restore", () => {
    const { store, paint } = freshStore();
    store.getState().startEditorPreview("nord");

    store.getState().startEditorPreview("");

    expect(paint.editorThemes).toEqual(["nord", "one-dark-pro"]);
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
      "Couldn't save the theme: disk full",
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
    // null editorThemeId remaps Monaco when the app slug changes
    expect(paint.editorThemes).toEqual(["tokyo-night"]);
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
      deps: {
        gateway: fakeGateway(),
        applyTheme: () => {},
        refreshEditorTheme: () => {},
        beginScopeRepaint: () => {},
      },
      storage: memory.storage,
    });

    expect(store.getState().favorites).toEqual(["moss"]);
    expect(store.getState().recents).toEqual([]);
  });
});

/** A store already scoped to project `p1`, carrying `override`. */
async function scopedToProject(override: ProjectThemeOverride) {
  const scoped = freshStore({
    state: vi.fn(async () => ({
      ok: true as const,
      value: statePayload({ projectId: "p1", projectOverride: override }),
    })),
  });
  await scoped.store.getState().hydrate("p1");
  scoped.paint.applied.length = 0;
  scoped.paint.editorThemes.length = 0;
  return scoped;
}

describe("setProjectAppChoice", () => {
  it("clears BOTH the named theme and the tint seed when a project goes back to inherit", async () => {
    // Dropping only the slug would leave the seed tinting the app — #72's
    // auto-tint is exactly "a seed and no slug", so Inherit has to clear both.
    const { store, gateway } = await scopedToProject({
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "sunset",
      seed: "#E8652A",
      editorThemeId: "nord",
    });

    await expect(store.getState().setProjectAppChoice("p1", { kind: "inherit" })).resolves.toBe(
      true,
    );

    expect(gateway.setProject).toHaveBeenCalledWith("p1", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      editorThemeId: "nord",
    });
  });

  // #72: Custom opens with "Auto-tint from this project's color" pre-selected.
  // The SEED is what's stored — the tinted theme itself is derived at paint
  // time (theme/apply.ts), never written anywhere.
  it("stores the project's color as the tint seed and paints the derived theme", async () => {
    const { store, gateway, paint } = await scopedToProject(EMPTY_PROJECT_THEME_OVERRIDE);

    await expect(store.getState().setProjectAppChoice("p1", autoTintChoice(0))).resolves.toBe(true);

    expect(gateway.setProject).toHaveBeenCalledWith("p1", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      seed: PROJECT_COLORS[0],
    });
    expect(paint.applied.at(-1)).toMatchObject({
      slug: PROJECT_TINT_SLUG,
      seed: PROJECT_COLORS[0],
    });
  });

  it("never merges onto an override belonging to a different project", async () => {
    // The store holds exactly ONE scope's override (see `appliedTheme`), so a
    // write aimed elsewhere must start from "inherits everything" rather than
    // copying the loaded project's look onto its neighbor.
    const { store, gateway } = await scopedToProject({
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "sunset",
    });

    await store.getState().setProjectAppChoice("p2", autoTintChoice(1));

    expect(gateway.setProject).toHaveBeenCalledWith("p2", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      seed: PROJECT_COLORS[1],
    });
  });

  it("reports a failed write instead of pretending the project changed", async () => {
    const { store } = freshStore({
      setProject: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });

    await expect(store.getState().setProjectAppChoice("p1", { kind: "inherit" })).resolves.toBe(
      false,
    );

    expect(store.getState().projectOverride).toBeNull();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't save the theme: disk full",
      expect.anything(),
    );
  });
});

describe("setProjectEditorTheme", () => {
  it("persists the project's editor id, leaving its other surfaces alone (#69)", async () => {
    const override: ProjectThemeOverride = {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "sunset",
    };
    const { store, gateway, paint } = await scopedToProject(override);

    await expect(store.getState().setProjectEditorTheme("p1", "nord")).resolves.toBe(true);

    expect(gateway.setProject).toHaveBeenCalledWith("p1", { ...override, editorThemeId: "nord" });
    expect(gateway.setGlobalEditor).not.toHaveBeenCalled();
    expect(store.getState().projectOverride).toEqual({ ...override, editorThemeId: "nord" });
    expect(paint.editorThemes).toEqual(["nord"]);
  });

  // "Inherit" is the absence of an override, not an override full of nulls —
  // the row is dropped, so a project that inherits everything reads the same
  // as a project that never set anything.
  it("clears the whole override when the last set surface goes back to inherit", async () => {
    const { store, gateway } = await scopedToProject({
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      editorThemeId: "nord",
    });

    await expect(store.getState().setProjectEditorTheme("p1", null)).resolves.toBe(true);

    expect(gateway.setProject).toHaveBeenCalledWith("p1", null);
    expect(store.getState().projectOverride).toBeNull();
  });

  it("keeps the override when another surface is still set", async () => {
    const { store, gateway } = await scopedToProject({
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "sunset",
      editorThemeId: "nord",
    });

    await store.getState().setProjectEditorTheme("p1", null);

    expect(gateway.setProject).toHaveBeenCalledWith("p1", {
      ...EMPTY_PROJECT_THEME_OVERRIDE,
      appThemeSlug: "sunset",
    });
  });

  it("reports a failed write rather than leaving the picker looking saved", async () => {
    const { store } = freshStore({
      setProject: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });

    await expect(store.getState().setProjectEditorTheme("p1", "nord")).resolves.toBe(false);

    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't save the editor theme: disk full",
      expect.anything(),
    );
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
      effectiveTheme({
        preview: MIDNIGHT,
        global: DEFAULT_THEME,
        projectOverride: null,
        customThemes: [],
      }),
    ).toEqual(MIDNIGHT);

    expect(
      effectiveTheme({ preview: null, global: MIDNIGHT, projectOverride: null, customThemes: [] }),
    ).toEqual(MIDNIGHT);

    const tinted = effectiveTheme({
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" },
      customThemes: [],
    });
    expect(tinted.seed).toBe("#3f9142");
  });

  it("resolves a project appThemeSlug against custom themes in the catalog", () => {
    const state = {
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "sunset" },
      customThemes: [SUNSET],
    };

    expect(effectiveTheme(state)).toBe(SUNSET);
    expect(effectiveTheme(state)).toBe(SUNSET);
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
      customThemes: [],
    };
    expect(effectiveTheme(tinting)).toBe(effectiveTheme(tinting));

    const previewing = {
      preview: MIDNIGHT,
      global: DEFAULT_THEME,
      projectOverride: null,
      customThemes: [],
    };
    expect(effectiveTheme(previewing)).toBe(effectiveTheme(previewing));

    const plain = { preview: null, global: MIDNIGHT, projectOverride: null, customThemes: [] };
    expect(effectiveTheme(plain)).toBe(effectiveTheme(plain));

    const named = {
      preview: null,
      global: DEFAULT_THEME,
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: DEFAULT_THEME.slug },
      customThemes: [],
    };
    expect(effectiveTheme(named)).toBe(effectiveTheme(named));
  });
});

describe("appliedTheme", () => {
  const TINTED = { ...EMPTY_PROJECT_THEME_OVERRIDE, seed: "#3f9142" };

  it("is the global theme for the global scope, whatever a project overrides", () => {
    const state = {
      global: MIDNIGHT,
      projectId: "p1",
      projectOverride: TINTED,
      customThemes: [],
    };

    expect(appliedTheme(state, { kind: "global" })).toBe(MIDNIGHT);
  });

  it("resolves the project's own override for its scope", () => {
    const state = {
      global: DEFAULT_THEME,
      projectId: "p1",
      projectOverride: TINTED,
      customThemes: [],
    };

    expect(appliedTheme(state, { kind: "project", projectId: "p1" }).seed).toBe("#3f9142");
  });

  it("resolves a project appThemeSlug against custom themes in the catalog", () => {
    const state = {
      global: DEFAULT_THEME,
      projectId: "p1",
      projectOverride: { ...EMPTY_PROJECT_THEME_OVERRIDE, appThemeSlug: "sunset" },
      customThemes: [SUNSET],
    };

    expect(appliedTheme(state, { kind: "project", projectId: "p1" })).toBe(SUNSET);
  });

  it("never borrows another project's override", () => {
    const state = {
      global: MIDNIGHT,
      projectId: "p1",
      projectOverride: TINTED,
      customThemes: [],
    };

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
    const attributes = new Map<string, string>();
    // Scope-aware, and each scope resolves to a DIFFERENT theme: the eased
    // repaint is armed inside the "did the paint actually change" guard, so a
    // scope switch that lands on the same theme would (correctly) never reach
    // the real `beginScopeRepaint`.
    const state = vi.fn(async (input: { projectId?: string }) => ({
      ok: true as const,
      value: statePayload(
        input.projectId === undefined
          ? { theme: MIDNIGHT }
          : { theme: DEFAULT_THEME, projectId: input.projectId },
      ),
    }));
    const setGlobal = vi.fn(async () => ({ ok: true as const, value: statePayload() }));
    const setGlobalEditor = vi.fn(async (editorThemeId: ShippedEditorThemeId | null) => ({
      ok: true as const,
      value: statePayload({ editorThemeId }),
    }));
    const setProject = vi.fn(async () => ({ ok: false as const, error: "unused" }));
    const listCustomThemes = vi.fn(async () => ({ ok: true as const, themes: [SUNSET] }));
    const saveCustomTheme = vi.fn(async () => ({
      ok: true as const,
      path: "/data/volli/themes/sunset.json",
      themes: [SUNSET],
    }));
    const deleteCustomTheme = vi.fn(async () => ({ ok: true as const, themes: [] }));
    const openCustomTheme = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      api: {
        theme: {
          state,
          setGlobal,
          setGlobalEditor,
          setProject,
          listCustomThemes,
          saveCustomTheme,
          deleteCustomTheme,
          openCustomTheme,
        },
      },
    });
    vi.stubGlobal("document", {
      documentElement: {
        style: { setProperty: (name: string, value: string) => void written.set(name, value) },
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        removeAttribute: (name: string) => void attributes.delete(name),
        offsetWidth: 0,
      },
    });
    const store = createThemeStore();

    await store.getState().hydrate();

    expect(state).toHaveBeenCalledWith({});
    // Exactly Midnight's generated --background — asserted against the
    // generator (as window-theme.test.ts does) so the two can't drift, and
    // still meaningful because nothing writes this key unless the store paints.
    expect(written.get("--background")).toBe(generateThemeTokens(MIDNIGHT)["--background"]);
    // Boot is not a transition: there is no previous look to ease from.
    expect(attributes.has(SCOPE_TRANSITION_ATTRIBUTE)).toBe(false);

    // Entering a project's scope IS one, and it arms the real DOM path (#69).
    await store.getState().hydrate("p1");
    expect(attributes.get(SCOPE_TRANSITION_ATTRIBUTE)).toBe(SCOPE_TRANSITION_VALUE);

    await store.getState().setGlobalTheme(DEFAULT_THEME);
    expect(setGlobal).toHaveBeenCalledWith(DEFAULT_THEME);

    await store.getState().setEditorTheme("nord");
    expect(setGlobalEditor).toHaveBeenCalledWith("nord");

    store.setState({ preview: MIDNIGHT });
    await store.getState().commitPreview({ kind: "project", projectId: "p1" });
    expect(setProject).toHaveBeenCalled();

    // The theme-file verbs go through the same bridge — each names a SLUG (or
    // the whole definition), never a path.
    expect(listCustomThemes).toHaveBeenCalled();
    expect(store.getState().customThemes).toEqual([SUNSET]);
    await store.getState().saveCustomTheme(SUNSET, { kind: "global" });
    expect(saveCustomTheme).toHaveBeenCalledWith(SUNSET);
    await store.getState().deleteCustomTheme(SUNSET.slug);
    expect(deleteCustomTheme).toHaveBeenCalledWith(SUNSET.slug);
    await store.getState().openCustomThemeFile(SUNSET.slug);
    expect(openCustomTheme).toHaveBeenCalledWith(SUNSET.slug);
  });
});

describe("the user's own themes", () => {
  const MINE = SUNSET;

  it("loads the catalog when the authored state is hydrated", async () => {
    const { store, gateway } = freshStore();

    await store.getState().hydrate();

    expect(gateway.listCustomThemes).toHaveBeenCalled();
    expect(store.getState().customThemes).toEqual([MINE]);
  });

  it("previews a draft without writing anything, however far the seed moves", () => {
    const { store, gateway, paint } = freshStore();

    for (const seed of ["#ff0000", "#00ff00", "#0000ff"]) {
      store.getState().startPreview({ ...MINE, seed });
    }

    expect(paint.applied.map((theme) => theme.seed)).toEqual(["#ff0000", "#00ff00", "#0000ff"]);
    expect(gateway.saveCustomTheme).not.toHaveBeenCalled();
    expect(gateway.setGlobal).not.toHaveBeenCalled();
  });

  it("restores the pre-edit theme when the edit is abandoned", () => {
    const { store, paint } = freshStore();

    store.getState().startPreview({ ...MINE, seed: "#ff0000" });
    store.getState().cancelPreview();

    expect(paint.applied.at(-1)).toEqual(DEFAULT_THEME);
    expect(store.getState().global).toEqual(DEFAULT_THEME);
  });

  it("saves a theme to its file AND applies it, adopting the catalog the write hands back", async () => {
    const { store, gateway } = freshStore();
    store.getState().startPreview(MINE);

    const saved = await store.getState().saveCustomTheme(MINE, { kind: "global" });

    expect(saved).toBe(true);
    expect(gateway.saveCustomTheme).toHaveBeenCalledWith(MINE);
    expect(gateway.setGlobal).toHaveBeenCalledWith(MINE);
    expect(store.getState().customThemes).toEqual([MINE]);
  });

  it("surfaces a failed save and leaves the theme unapplied", async () => {
    const { store, gateway } = freshStore({
      saveCustomTheme: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });
    store.getState().startPreview(MINE);

    const saved = await store.getState().saveCustomTheme(MINE, { kind: "global" });

    expect(saved).toBe(false);
    expect(gateway.setGlobal).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't save the theme: disk full",
      expect.anything(),
    );
  });

  it("keeps customThemes and restores preview when the file write succeeds but apply fails", async () => {
    const { store, gateway, paint } = freshStore({
      setGlobal: vi.fn(async () => ({ ok: false as const, error: "disk full" })),
    });

    const saved = await store.getState().saveCustomTheme(MINE, { kind: "global" });

    expect(saved).toBe(false);
    expect(gateway.saveCustomTheme).toHaveBeenCalledWith(MINE);
    expect(gateway.setGlobal).toHaveBeenCalledWith(MINE);
    expect(store.getState().customThemes).toEqual([MINE]);
    expect(store.getState().preview).toEqual(MINE);
    expect(store.getState().global).toEqual(DEFAULT_THEME);
    expect(effectiveTheme(store.getState())).toEqual(MINE);
    expect(paint.applied.at(-1)).toEqual(MINE);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't save the theme: disk full",
      expect.anything(),
    );
  });

  it("deletes through the slug and adopts the fresh catalog", async () => {
    const { store, gateway } = freshStore({
      deleteCustomTheme: vi.fn(async () => ({ ok: true as const, themes: [] })),
    });
    await store.getState().hydrate();

    const deleted = await store.getState().deleteCustomTheme("sunset");

    expect(deleted).toBe(true);
    expect(gateway.deleteCustomTheme).toHaveBeenCalledWith("sunset");
    expect(store.getState().customThemes).toEqual([]);
  });

  it("surfaces a failed delete and keeps the theme in the catalog", async () => {
    const { store } = freshStore({
      deleteCustomTheme: vi.fn(async () => ({ ok: false as const, error: "file locked" })),
    });
    await store.getState().hydrate();

    expect(await store.getState().deleteCustomTheme("sunset")).toBe(false);
    expect(store.getState().customThemes).toEqual([MINE]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't delete the theme: file locked",
      expect.anything(),
    );
  });

  it("opens a theme's file through its slug, surfacing a failure to open", async () => {
    const { store, gateway } = freshStore({
      openCustomTheme: vi.fn(async () => ({ ok: false as const, error: "no editor" })),
    });

    expect(await store.getState().openCustomThemeFile("sunset")).toBe(false);
    expect(gateway.openCustomTheme).toHaveBeenCalledWith("sunset");
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't open the theme file: no editor",
      expect.anything(),
    );
  });

  it("toasts a catalog read failure rather than quietly showing no themes", async () => {
    const { store } = freshStore({
      listCustomThemes: vi.fn(async () => ({ ok: false as const, error: "unreadable" })),
    });

    await store.getState().loadCustomThemes();

    expect(store.getState().customThemes).toEqual([]);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Couldn't load your themes: unreadable",
      expect.anything(),
    );
  });
});
