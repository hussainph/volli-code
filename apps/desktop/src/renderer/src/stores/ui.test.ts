import { describe, expect, it } from "vite-plus/test";
import {
  clampSidebarWidth,
  createUiStore,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  UI_SCALE_STEPS,
} from "./ui";

/** Simple in-memory `StateStorage` so each test gets its own isolated backing. */
function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, value: string) => {
      data.set(name, value);
    },
    removeItem: (name: string) => {
      data.delete(name);
    },
  };
}

describe("clampSidebarWidth", () => {
  it("clamps to the min/max range and rounds fractional widths", () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 100)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(400.6)).toBe(401);
  });

  it("keeps the default width inside its own bounds", () => {
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("setSidebarWidth", () => {
  it("stores clamped widths", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setSidebarWidth(SIDEBAR_MAX_WIDTH + 500);
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);

    store.getState().setSidebarWidth(420);
    expect(store.getState().sidebarWidth).toBe(420);
  });
});

describe("stepUiScale", () => {
  const MIN = UI_SCALE_STEPS[0];
  const MAX = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1];

  it("defaults to native scale (1)", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().uiScale).toBe(1);
  });

  it("steps up and down the ladder one rung at a time", () => {
    const store = createUiStore(createMemoryStorage());
    // 1 is index 2 in the ladder; one step up is index 3 (1.1).
    store.getState().stepUiScale(1);
    expect(store.getState().uiScale).toBe(UI_SCALE_STEPS[3]);
    store.getState().stepUiScale(-1);
    expect(store.getState().uiScale).toBe(1);
  });

  it("clamps at the top rung", () => {
    const store = createUiStore(createMemoryStorage());
    for (let i = 0; i < 10; i++) store.getState().stepUiScale(1);
    expect(store.getState().uiScale).toBe(MAX);
  });

  it("clamps at the bottom rung", () => {
    const store = createUiStore(createMemoryStorage());
    for (let i = 0; i < 10; i++) store.getState().stepUiScale(-1);
    expect(store.getState().uiScale).toBe(MIN);
  });

  it("snaps an off-ladder value to the nearest rung before stepping", () => {
    // Seed a stale, off-ladder scale via persisted storage.
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: SIDEBAR_DEFAULT_WIDTH, uiScale: 1.18 }, version: 1 }),
    );
    const store = createUiStore(storage);
    // 1.18 is nearest to 1.25 (index 4); a step up lands on 1.5 (index 5).
    store.getState().stepUiScale(1);
    expect(store.getState().uiScale).toBe(UI_SCALE_STEPS[5]);
  });
});

describe("resetUiScale", () => {
  it("returns scale to native (1)", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().stepUiScale(1);
    store.getState().stepUiScale(1);
    expect(store.getState().uiScale).not.toBe(1);
    store.getState().resetUiScale();
    expect(store.getState().uiScale).toBe(1);
  });
});

describe("setSettingsOpen", () => {
  it("toggles the app-wide Settings overlay", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().settingsOpen).toBe(false);

    store.getState().setSettingsOpen(true);
    expect(store.getState().settingsOpen).toBe(true);

    store.getState().setSettingsOpen(false);
    expect(store.getState().settingsOpen).toBe(false);
  });
});

describe("persistence", () => {
  it("persists sidebarWidth + uiScale — settingsOpen resets each launch", () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setSettingsOpen(true);
    store.getState().setSidebarWidth(500);
    store.getState().stepUiScale(1);

    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({ sidebarWidth: 500, uiScale: UI_SCALE_STEPS[3] });
  });

  it("rehydrates sidebarWidth from storage into a fresh store", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setSidebarWidth(444);

    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().sidebarWidth).toBe(444);
  });
});
