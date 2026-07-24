import { describe, expect, it } from "vite-plus/test";
import {
  clampRailWidth,
  clampSidebarWidth,
  createUiStore,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
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

describe("clampRailWidth", () => {
  it("clamps to the min/max range and rounds fractional widths", () => {
    expect(clampRailWidth(RAIL_MIN_WIDTH - 100)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(RAIL_MAX_WIDTH + 100)).toBe(RAIL_MAX_WIDTH);
    expect(clampRailWidth(360.4)).toBe(360);
    expect(clampRailWidth(360.6)).toBe(361);
  });

  it("keeps the default width inside its own bounds", () => {
    expect(clampRailWidth(RAIL_DEFAULT_WIDTH)).toBe(RAIL_DEFAULT_WIDTH);
    expect(RAIL_DEFAULT_WIDTH).toBeGreaterThanOrEqual(RAIL_MIN_WIDTH);
    expect(RAIL_DEFAULT_WIDTH).toBeLessThanOrEqual(RAIL_MAX_WIDTH);
  });
});

describe("setRailWidth", () => {
  it("stores clamped widths", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().railWidth).toBe(RAIL_DEFAULT_WIDTH);

    store.getState().setRailWidth(RAIL_MAX_WIDTH + 500);
    expect(store.getState().railWidth).toBe(RAIL_MAX_WIDTH);

    store.getState().setRailWidth(RAIL_MIN_WIDTH - 500);
    expect(store.getState().railWidth).toBe(RAIL_MIN_WIDTH);

    store.getState().setRailWidth(360);
    expect(store.getState().railWidth).toBe(360);
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

describe("setNewTicketOpen", () => {
  it("toggles the app-wide New-ticket dialog", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().newTicketOpen).toBe(false);

    store.getState().setNewTicketOpen(true);
    expect(store.getState().newTicketOpen).toBe(true);

    store.getState().setNewTicketOpen(false);
    expect(store.getState().newTicketOpen).toBe(false);
  });
});

describe("terminal focus", () => {
  const target = { projectId: "p1", ticketId: "t1", sessionId: "s1" };

  it("tracks and clears the focused terminal target", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().terminalFocusTarget).toBeNull();

    store.getState().setTerminalFocusTarget(target);
    expect(store.getState().terminalFocusTarget).toEqual(target);

    store.getState().setTerminalFocusTarget(null);
    expect(store.getState().terminalFocusTarget).toBeNull();
  });

  it("clearTerminalFocusForTicket clears only a target owned by the given ticket", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setTerminalFocusTarget(target); // ticketId t1

    // A different ticket's teardown must not clear this ticket's focus.
    store.getState().clearTerminalFocusForTicket("other");
    expect(store.getState().terminalFocusTarget).toEqual(target);

    store.getState().clearTerminalFocusForTicket("t1");
    expect(store.getState().terminalFocusTarget).toBeNull();
  });

  it("clearTerminalFocusUnlessTicket drops a target that belongs to a different ticket", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setTerminalFocusTarget(target); // ticketId t1

    // Open ticket is still t1: the target is kept.
    store.getState().clearTerminalFocusUnlessTicket("t1");
    expect(store.getState().terminalFocusTarget).toEqual(target);

    // Open ticket changed to t2: the stale foreign target is cleared at the store.
    store.getState().clearTerminalFocusUnlessTicket("t2");
    expect(store.getState().terminalFocusTarget).toBeNull();

    // A null target is a no-op regardless of the ticket asked about.
    store.getState().clearTerminalFocusUnlessTicket("t3");
    expect(store.getState().terminalFocusTarget).toBeNull();
  });

  it("is session-only and never enters persisted UI state", () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setTerminalFocusTarget(target);

    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).not.toHaveProperty("terminalFocusTarget");

    const reloaded = createUiStore(storage);
    expect(reloaded.getState().terminalFocusTarget).toBeNull();
  });
});

describe("persistence", () => {
  it("persists sidebarWidth + railWidth + uiScale + workspaceRailHidden + railCollapsed + detailsExpanded — settingsOpen resets each launch", () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setSettingsOpen(true);
    store.getState().setSidebarWidth(500);
    store.getState().setRailWidth(360);
    store.getState().stepUiScale(1);
    store.getState().toggleWorkspaceRailHidden();
    store.getState().toggleRailCollapsed();
    store.getState().toggleDetailsExpanded();

    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({
      sidebarWidth: 500,
      railWidth: 360,
      uiScale: UI_SCALE_STEPS[3],
      workspaceRailHidden: true,
      railCollapsed: true,
      detailsExpanded: true,
      lastHarnessId: "claude-code",
    });
  });

  it("persists lastHarnessId and rehydrates it; missing/unknown ids default to claude-code", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setLastHarnessId("codex");
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().lastHarnessId).toBe("codex");

    // Older state without the key defaults to the first-class harness.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().lastHarnessId).toBe("claude-code");

    // A since-removed / bogus harness id falls back to the default.
    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, lastHarnessId: "gpt-5" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().lastHarnessId).toBe("claude-code");
  });

  it("rehydrates workspaceRailHidden from storage; corrupt/missing values default to visible", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setWorkspaceRailHidden(true);
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().workspaceRailHidden).toBe(true);

    // Older state has no key and keeps the workspace switcher visible.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().workspaceRailHidden).toBe(false);

    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, workspaceRailHidden: "yes" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().workspaceRailHidden).toBe(false);
  });

  it("rehydrates railCollapsed from storage; corrupt/missing values default to expanded", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setRailCollapsed(true);
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().railCollapsed).toBe(true);

    // A non-boolean persisted value falls back to the safe, visible default.
    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, railCollapsed: "yes" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().railCollapsed).toBe(false);
  });

  it("rehydrates detailsExpanded from storage; corrupt/missing values default to collapsed", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setDetailsExpanded(true);
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().detailsExpanded).toBe(true);

    // A missing key (older persisted state) folds to the collapsed default.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().detailsExpanded).toBe(false);

    // A non-boolean persisted value falls back to the safe, collapsed default.
    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, detailsExpanded: "yes" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().detailsExpanded).toBe(false);
  });

  it("rehydrates sidebarWidth from storage into a fresh store", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setSidebarWidth(444);

    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().sidebarWidth).toBe(444);
  });

  it("rehydrates railWidth from storage; missing key falls back to the default", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setRailWidth(420);

    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().railWidth).toBe(420);

    // Older persisted state without the key defaults to the rail's default width.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().railWidth).toBe(RAIL_DEFAULT_WIDTH);
  });
});

describe("rehydration sanitization (corrupt JSON)", () => {
  it("snaps a corrupt persisted uiScale back onto the ladder", () => {
    // uiScale is applied verbatim as CSS `zoom` — a persisted 0 would render
    // the whole app below the chrome band invisible on every launch.
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 0 }, version: 1 }),
    );
    expect(createUiStore(storage).getState().uiScale).toBe(UI_SCALE_STEPS[0]);

    const nonNumeric = createMemoryStorage();
    nonNumeric.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: "huge" }, version: 1 }),
    );
    expect(createUiStore(nonNumeric).getState().uiScale).toBe(1);
  });

  it("clamps a corrupt persisted sidebarWidth back into the resize bounds", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 10_000, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(storage).getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);

    const nonNumeric = createMemoryStorage();
    nonNumeric.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: null, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(nonNumeric).getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a corrupt persisted railWidth back into the resize bounds", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1, railWidth: 10_000 }, version: 1 }),
    );
    expect(createUiStore(storage).getState().railWidth).toBe(RAIL_MAX_WIDTH);

    const nonNumeric = createMemoryStorage();
    nonNumeric.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1, railWidth: null }, version: 1 }),
    );
    expect(createUiStore(nonNumeric).getState().railWidth).toBe(RAIL_DEFAULT_WIDTH);
  });

  it("falls back to defaults when the persisted state is not an object", () => {
    const storage = createMemoryStorage();
    storage.setItem("volli:ui", JSON.stringify({ state: null, version: 1 }));

    const store = createUiStore(storage);
    expect(store.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(store.getState().uiScale).toBe(1);
  });
});
