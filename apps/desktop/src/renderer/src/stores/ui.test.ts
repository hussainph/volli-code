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

/**
 * The Model Access pane mounting, in the two lines that matter: it takes the
 * deep-linked sign-in request as this mount's OWN value and spends it on the
 * way past (model-access-settings.tsx keeps the taken value in mount state —
 * the return here stands in for that). Switching category unmounts the pane, so
 * every visit to it is one of these calls.
 */
function mountModelAccessPane(store: ReturnType<typeof createUiStore>): string | null {
  const taken = store.getState().settingsSignInProviderId;
  if (taken !== null) store.getState().consumeSettingsSignIn();
  return taken;
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

describe("diffPresentation", () => {
  it('defaults to "inline"', () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().diffPresentation).toBe("inline");
  });

  it('setDiffPresentation updates to "side-by-side" or "inline"', () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setDiffPresentation("side-by-side");
    expect(store.getState().diffPresentation).toBe("side-by-side");

    store.getState().setDiffPresentation("inline");
    expect(store.getState().diffPresentation).toBe("inline");
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

  it("opens on a named category when the opener already knows where it is sending you", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().settingsCategory).toBeNull();

    store.getState().setSettingsOpen(true, "model-access");
    expect(store.getState().settingsCategory).toBe("model-access");
  });

  it("carries the provider a blocker wants signed in to, one-shot like the category", () => {
    const store = createUiStore(createMemoryStorage());
    expect(store.getState().settingsSignInProviderId).toBeNull();

    store.getState().setSettingsOpen(true, "model-access", "anthropic");
    expect(store.getState().settingsSignInProviderId).toBe("anthropic");

    store.getState().setSettingsOpen(true, "model-access");
    expect(store.getState().settingsSignInProviderId).toBeNull();
  });

  it("forgets the category on the next opening that names none", () => {
    // Read once per opening and never written back by the shell, so a stale one
    // would send the NEXT visitor somewhere the surface that opened it never
    // asked for.
    const store = createUiStore(createMemoryStorage());
    store.getState().setSettingsOpen(true, "model-access", "anthropic");

    store.getState().setSettingsOpen(false);
    expect(store.getState().settingsCategory).toBeNull();
    expect(store.getState().settingsSignInProviderId).toBeNull();

    store.getState().setSettingsOpen(true);
    expect(store.getState().settingsCategory).toBeNull();
  });
});

describe("consumeSettingsSignIn", () => {
  it("spends the request, so revisiting the pane starts no sign-in", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setSettingsOpen(true, "model-access", "anthropic");

    // The blocker's press, honored.
    expect(mountModelAccessPane(store)).toBe("anthropic");

    // General, then Model Access again — ordinary navigation inside a Settings
    // overlay that never closed. A provider's browser auth relaunching here is
    // an external act nobody asked for the second time.
    expect(mountModelAccessPane(store)).toBeNull();
    expect(mountModelAccessPane(store)).toBeNull();
  });

  it("spends only itself: Settings stays open, on the category it was sent to", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setSettingsOpen(true, "model-access", "anthropic");

    store.getState().consumeSettingsSignIn();

    expect(store.getState().settingsOpen).toBe(true);
    expect(store.getState().settingsCategory).toBe("model-access");
  });

  it("is a no-op for a visit nobody deep-linked", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setSettingsOpen(true, "model-access");

    store.getState().consumeSettingsSignIn();

    expect(store.getState().settingsSignInProviderId).toBeNull();
  });

  it("re-arms on the next press — one launch per press, not one per profile", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().setSettingsOpen(true, "model-access", "anthropic");
    expect(mountModelAccessPane(store)).toBe("anthropic");

    // A second blocker, a second press, its own launch.
    store.getState().setSettingsOpen(true, "model-access", "openai-codex");
    expect(mountModelAccessPane(store)).toBe("openai-codex");
    expect(mountModelAccessPane(store)).toBeNull();
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
  it("persists every chrome preference — settingsOpen resets each launch", () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setSettingsOpen(true);
    store.getState().setSidebarWidth(500);
    store.getState().setRailWidth(360);
    store.getState().stepUiScale(1);
    store.getState().toggleWorkspaceRailHidden();
    store.getState().setSidebarPinned(false);
    store.getState().toggleRailCollapsed();
    store.getState().setRailMode("files");
    store.getState().setHomeRailMode("sessions");
    store.getState().setHomeEmptyVisual("board");
    store.getState().setDiffPresentation("side-by-side");
    store.getState().dismissEnvironmentFault("login-path-unreadable");

    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({
      sidebarWidth: 500,
      railWidth: 360,
      uiScale: UI_SCALE_STEPS[3],
      workspaceRailHidden: true,
      sidebarPinned: false,
      railCollapsed: true,
      railMode: "files",
      homeRailMode: "sessions",
      homeEmptyVisual: "board",
      diffPresentation: "side-by-side",
      dismissedEnvironmentFaults: ["login-path-unreadable"],
    });
    expect(persisted.state).not.toHaveProperty("detailsExpanded");
    // The New-ticket composer's terminal harness left with the terminal kickoff
    // it chose for (VC-15/VC-56); nothing reads a last-harness preference now,
    // so nothing writes one either.
    expect(persisted.state).not.toHaveProperty("lastHarnessId");
  });

  it("rehydrates Home's rail page and empty-chat visual; unknown values fall back", async () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().setHomeRailMode("sessions");
    store.getState().setHomeEmptyVisual("venue");
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().homeRailMode).toBe("sessions");
    expect(reloaded.getState().homeEmptyVisual).toBe("venue");

    // A page or a visual a past build wrote and this one no longer draws lands
    // on the one each surface opens with.
    const stale = createMemoryStorage();
    stale.setItem(
      "volli:ui",
      JSON.stringify({
        state: { homeRailMode: "mentioned", homeEmptyVisual: "greeter" },
        version: 1,
      }),
    );
    const recovered = createUiStore(stale);
    await recovered.persist.rehydrate();
    expect(recovered.getState().homeRailMode).toBe("now");
    expect(recovered.getState().homeEmptyVisual).toBe("streak");
  });

  it("rehydrates diffPresentation from storage; missing/unknown values default to inline", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setDiffPresentation("side-by-side");
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().diffPresentation).toBe("side-by-side");

    // Older state without the key defaults to inline.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().diffPresentation).toBe("inline");

    // Corrupt / unknown values fall back to the safe inline default.
    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, diffPresentation: "split" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().diffPresentation).toBe("inline");

    const nonString = createMemoryStorage();
    nonString.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, diffPresentation: true },
        version: 1,
      }),
    );
    expect(createUiStore(nonString).getState().diffPresentation).toBe("inline");
  });

  it("ignores a retired lastHarnessId left in older persisted state", () => {
    // Profiles updating from a build that had the composer's harness picker
    // still carry the key. It is read by nothing and re-written by nothing;
    // what matters is that its presence disturbs no neighbour on the way past.
    const stale = createMemoryStorage();
    stale.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, lastHarnessId: "gpt-5" },
        version: 1,
      }),
    );
    const store = createUiStore(stale);
    expect(store.getState()).not.toHaveProperty("lastHarnessId");
    expect(store.getState().sidebarWidth).toBe(320);
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

  it("rehydrates sidebarPinned from storage; corrupt/missing values keep the panel pinned", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setSidebarPinned(false);
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().sidebarPinned).toBe(false);

    // Older state has no key and opens with the panel standing.
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().sidebarPinned).toBe(true);

    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, sidebarPinned: "no" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().sidebarPinned).toBe(true);
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

  it("rehydrates a railMode this build still offers", async () => {
    const storage = createMemoryStorage();
    createUiStore(storage).getState().setRailMode("files");
    const reloaded = createUiStore(storage);
    await reloaded.persist.rehydrate();
    expect(reloaded.getState().railMode).toBe("files");
  });

  // A user upgrading into the Calm Stack has one of these sitting in app_state.
  // Every one has to open on a real page — never a crash, never a page this
  // build cannot draw — and the resolved page is what gets written back.
  it.each([
    // The icon-mode rail's own pages, both folded into Now.
    ["sessions", "now"],
    ["properties", "now"],
    // A contextual rail surface removed before the icon rail shipped.
    ["session", "now"],
    // Never written by any build: corrupt JSON, or a hand-edited app_state row.
    ["bogus", "now"],
  ])("lands the retired railMode %s on %s", (stored, expected) => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, railMode: stored },
        version: 1,
      }),
    );
    const store = createUiStore(storage);
    expect(store.getState().railMode).toBe(expected);

    // And the retired string is not written back: the next launch reads a page
    // name this build chose, not the one it inherited.
    store.getState().setRailWidth(300);
    const persisted = JSON.parse(storage.getItem("volli:ui")!) as {
      state: Record<string, unknown>;
    };
    expect(persisted.state.railMode).toBe(expected);
  });

  it("migrates the pre-icon-rail Details drawer onto the page that absorbed it", () => {
    const legacy = createMemoryStorage();
    legacy.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, detailsExpanded: true },
        version: 1,
      }),
    );
    expect(createUiStore(legacy).getState().railMode).toBe("now");
  });

  it("defaults a missing railMode to Now", () => {
    const missing = createMemoryStorage();
    missing.setItem(
      "volli:ui",
      JSON.stringify({ state: { sidebarWidth: 320, uiScale: 1 }, version: 1 }),
    );
    expect(createUiStore(missing).getState().railMode).toBe("now");
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

describe("environment fault dismissals", () => {
  it("survives a relaunch, because a banner that returns every launch is the defect", async () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    store.getState().dismissEnvironmentFault("login-path-unreadable");
    // Idempotent: pressing Dismiss twice is one dismissal, not two rows.
    store.getState().dismissEnvironmentFault("login-path-unreadable");
    expect(store.getState().dismissedEnvironmentFaults).toEqual(["login-path-unreadable"]);

    const relaunched = createUiStore(storage);
    await relaunched.persist.rehydrate();
    expect(relaunched.getState().dismissedEnvironmentFaults).toEqual(["login-path-unreadable"]);
  });

  it("drops a dismissal the moment its fault stops being measured", () => {
    const store = createUiStore(createMemoryStorage());
    store.getState().dismissEnvironmentFault("login-path-unreadable");

    // Still faulting: the dismissal stands, and the same array is kept so a
    // re-measurement on every window focus re-renders nothing.
    const kept = store.getState().dismissedEnvironmentFaults;
    store.getState().retainEnvironmentFaultDismissals(["login-path-unreadable"]);
    expect(store.getState().dismissedEnvironmentFaults).toBe(kept);

    // Repaired (or simply gone): the dismissal goes with it, so the same fault
    // happening again is heard rather than silently swallowed.
    store.getState().retainEnvironmentFaultDismissals([]);
    expect(store.getState().dismissedEnvironmentFaults).toEqual([]);
  });

  /**
   * A re-measurement that changes nothing must not TOUCH the store.
   *
   * zustand's persist middleware wraps `set` and writes the whole store to
   * `app_state` after every call, so even `set({})` costs a serialize, an IPC
   * hop and a SQLite UPSERT. This action runs on every window focus — so on a
   * healthy machine, which by contract sees no banner ever, a `set` here would
   * be a durable write per focus, forever, recording nothing.
   */
  it("writes nothing when a re-measurement changes no dismissal", () => {
    const storage = createMemoryStorage();
    let writes = 0;
    const counted = {
      ...storage,
      setItem: (name: string, value: string) => {
        writes += 1;
        storage.setItem(name, value);
      },
    };
    const store = createUiStore(counted);

    // The healthy case: nothing dismissed, nothing faulting, focus after focus.
    writes = 0;
    store.getState().retainEnvironmentFaultDismissals([]);
    store.getState().retainEnvironmentFaultDismissals([]);
    expect(writes).toBe(0);

    // A standing dismissal whose fault is still measured: also nothing to say.
    store.getState().dismissEnvironmentFault("login-path-unreadable");
    writes = 0;
    store.getState().retainEnvironmentFaultDismissals(["login-path-unreadable"]);
    expect(writes).toBe(0);
    // Dismissing the same kind twice is one dismissal, and one write.
    store.getState().dismissEnvironmentFault("login-path-unreadable");
    expect(writes).toBe(0);

    // Only a real change is durable.
    store.getState().retainEnvironmentFaultDismissals([]);
    expect(writes).toBe(1);
  });

  it("keeps only kinds this build still raises, whatever a past one wrote", async () => {
    const storage = createMemoryStorage();
    storage.setItem(
      "volli:ui",
      JSON.stringify({
        state: {
          sidebarWidth: 320,
          uiScale: 1,
          dismissedEnvironmentFaults: ["login-path-unreadable", "retired-fault"],
        },
        version: 1,
      }),
    );
    const store = createUiStore(storage);
    await store.persist.rehydrate();
    expect(store.getState().dismissedEnvironmentFaults).toEqual(["login-path-unreadable"]);

    // Corrupt or missing: nothing is dismissed, so no fault can be silenced by
    // a value nobody wrote on purpose.
    const corrupt = createMemoryStorage();
    corrupt.setItem(
      "volli:ui",
      JSON.stringify({
        state: { sidebarWidth: 320, uiScale: 1, dismissedEnvironmentFaults: "all" },
        version: 1,
      }),
    );
    expect(createUiStore(corrupt).getState().dismissedEnvironmentFaults).toEqual([]);
  });
});
