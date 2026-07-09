import { describe, expect, it } from "vite-plus/test";
import {
  clampSidebarWidth,
  createUiStore,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
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

describe("persistence", () => {
  it("persists only sidebarWidth — activeNav resets each launch", () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setActiveNav("files");
    store.getState().setSidebarWidth(500);

    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({ sidebarWidth: 500 });
  });

  it("rehydrates sidebarWidth from storage into a fresh store", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setSidebarWidth(444);

    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().sidebarWidth).toBe(444);
    expect(reloaded.getState().activeNav).toBe("board");
  });
});
