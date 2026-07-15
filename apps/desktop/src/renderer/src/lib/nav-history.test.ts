import { describe, expect, it } from "vite-plus/test";

import {
  canGoBack,
  canGoForward,
  EMPTY_NAV_HISTORY,
  goBack,
  goForward,
  isEditingTarget,
  isNavBackKeyEvent,
  isNavForwardKeyEvent,
  isRailToggleKeyEvent,
  NAV_HISTORY_CAP,
  recordNav,
  sameSnapshot,
  ticketParentSnapshot,
  type NavHistory,
  type NavKeyEvent,
  type NavSnapshot,
} from "./nav-history";

function snap(
  projectId: string | null,
  nav: NavSnapshot["nav"] = "board",
  openTicketId: string | null = null,
): NavSnapshot {
  return { projectId, nav, openTicketId };
}

/** Feed a sequence of organic navigations through the reducer. */
function record(...locations: NavSnapshot[]): NavHistory {
  return locations.reduce<NavHistory>(recordNav, EMPTY_NAV_HISTORY);
}

describe("sameSnapshot", () => {
  it("compares all three fields", () => {
    expect(sameSnapshot(snap("a", "board", "t1"), snap("a", "board", "t1"))).toBe(true);
    expect(sameSnapshot(snap("a"), snap("b"))).toBe(false);
    expect(sameSnapshot(snap("a", "board"), snap("a", "sessions"))).toBe(false);
    expect(sameSnapshot(snap("a", "board", "t1"), snap("a", "board", null))).toBe(false);
  });

  it("treats null as a distinct value", () => {
    expect(sameSnapshot(null, null)).toBe(true);
    expect(sameSnapshot(null, snap("a"))).toBe(false);
    expect(sameSnapshot(snap("a"), null)).toBe(false);
  });
});

describe("ticketParentSnapshot", () => {
  it("maps a ticket detail location to its plain Board parent", () => {
    expect(ticketParentSnapshot(snap("a", "board", "t1"))).toEqual(snap("a"));
  });

  it("does not invent a parent for top-level or project-less locations", () => {
    expect(ticketParentSnapshot(snap("a"))).toBeNull();
    expect(ticketParentSnapshot(snap("a", "files", "t1"))).toBeNull();
    expect(ticketParentSnapshot(snap(null, "board", "t1"))).toBeNull();
  });
});

describe("recordNav", () => {
  it("seeds the first location without a back entry", () => {
    const h = recordNav(EMPTY_NAV_HISTORY, snap("a"));
    expect(h.current).toEqual(snap("a"));
    expect(h.back).toEqual([]);
    expect(h.forward).toEqual([]);
  });

  it("pushes the old current onto the back stack", () => {
    const h = record(snap("a"), snap("b"), snap("c"));
    expect(h.current).toEqual(snap("c"));
    expect(h.back).toEqual([snap("a"), snap("b")]);
  });

  it("dedupes a consecutive identical snapshot and returns the same reference", () => {
    const h1 = record(snap("a", "board", "t1"));
    const h2 = recordNav(h1, snap("a", "board", "t1"));
    expect(h2).toBe(h1);
  });

  it("clears the forward stack on organic navigation", () => {
    const back = goBack(record(snap("a"), snap("b")));
    expect(back).not.toBeNull();
    // At {current: a, forward: [b]} — navigating organically to c drops b.
    const h = recordNav(back!.history, snap("c"));
    expect(h.forward).toEqual([]);
    expect(h.current).toEqual(snap("c"));
    expect(h.back).toEqual([snap("a")]);
  });

  it("caps the back stack, dropping the oldest entries", () => {
    let h = EMPTY_NAV_HISTORY;
    // NAV_HISTORY_CAP + 5 distinct locations → back holds the cap, current is last.
    for (let i = 0; i < NAV_HISTORY_CAP + 6; i++) h = recordNav(h, snap(`p${i}`));
    expect(h.back).toHaveLength(NAV_HISTORY_CAP);
    // Oldest (p0) fell off; newest back entry is the one before current.
    expect(h.back[0]).toEqual(snap("p5"));
    expect(h.back.at(-1)).toEqual(snap(`p${NAV_HISTORY_CAP + 4}`));
    expect(h.current).toEqual(snap(`p${NAV_HISTORY_CAP + 5}`));
  });
});

describe("goBack / goForward", () => {
  it("returns null when the respective stack is empty", () => {
    expect(goBack(EMPTY_NAV_HISTORY)).toBeNull();
    expect(goForward(EMPTY_NAV_HISTORY)).toBeNull();
    const single = record(snap("a"));
    expect(goBack(single)).toBeNull();
    expect(goForward(single)).toBeNull();
  });

  it("steps back, moving current onto the forward stack", () => {
    const step = goBack(record(snap("a"), snap("b"), snap("c")));
    expect(step).not.toBeNull();
    expect(step!.snapshot).toEqual(snap("b"));
    expect(step!.history.current).toEqual(snap("b"));
    expect(step!.history.back).toEqual([snap("a")]);
    expect(step!.history.forward).toEqual([snap("c")]);
  });

  it("round-trips back then forward to the original location", () => {
    const start = record(snap("a"), snap("b"), snap("c"));
    const back = goBack(start)!;
    const fwd = goForward(back.history)!;
    expect(fwd.snapshot).toEqual(snap("c"));
    expect(fwd.history).toEqual(start);
  });

  it("walks multiple steps back and forward", () => {
    const start = record(snap("a"), snap("b"), snap("c"));
    const b1 = goBack(start)!; // -> b
    const b2 = goBack(b1.history)!; // -> a
    expect(b2.snapshot).toEqual(snap("a"));
    expect(canGoBack(b2.history)).toBe(false);
    expect(canGoForward(b2.history)).toBe(true);
    const f1 = goForward(b2.history)!; // -> b
    expect(f1.snapshot).toEqual(snap("b"));
    expect(f1.history.forward).toEqual([snap("c")]);
  });
});

describe("canGoBack / canGoForward", () => {
  it("reflect stack depth", () => {
    expect(canGoBack(EMPTY_NAV_HISTORY)).toBe(false);
    expect(canGoForward(EMPTY_NAV_HISTORY)).toBe(false);
    const two = record(snap("a"), snap("b"));
    expect(canGoBack(two)).toBe(true);
    expect(canGoForward(two)).toBe(false);
  });
});

function key(partial: Partial<NavKeyEvent>): NavKeyEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    key: "",
    code: "",
    repeat: false,
    ...partial,
  };
}

describe("isNavBackKeyEvent / isNavForwardKeyEvent", () => {
  it("match ⌘[ and ⌘] by key or code", () => {
    expect(isNavBackKeyEvent(key({ metaKey: true, key: "[" }))).toBe(true);
    expect(isNavBackKeyEvent(key({ metaKey: true, code: "BracketLeft" }))).toBe(true);
    expect(isNavForwardKeyEvent(key({ metaKey: true, key: "]" }))).toBe(true);
    expect(isNavForwardKeyEvent(key({ metaKey: true, code: "BracketRight" }))).toBe(true);
  });

  it("reject the wrong bracket and missing Cmd", () => {
    expect(isNavBackKeyEvent(key({ metaKey: true, key: "]" }))).toBe(false);
    expect(isNavBackKeyEvent(key({ key: "[" }))).toBe(false);
    expect(isNavForwardKeyEvent(key({ metaKey: true, key: "[" }))).toBe(false);
  });

  it("reject when Alt / Shift / Ctrl are also held", () => {
    expect(isNavBackKeyEvent(key({ metaKey: true, altKey: true, key: "[" }))).toBe(false);
    expect(isNavBackKeyEvent(key({ metaKey: true, shiftKey: true, key: "[" }))).toBe(false);
    expect(isNavBackKeyEvent(key({ metaKey: true, ctrlKey: true, key: "[" }))).toBe(false);
  });
});

describe("isRailToggleKeyEvent", () => {
  it("matches ⌥⌘B by physical code even when Option remaps the character", () => {
    expect(isRailToggleKeyEvent(key({ metaKey: true, altKey: true, code: "KeyB", key: "∫" }))).toBe(
      true,
    );
    expect(isRailToggleKeyEvent(key({ metaKey: true, altKey: true, key: "b" }))).toBe(true);
  });

  it("rejects plain ⌘B (no Alt) and other chords", () => {
    expect(isRailToggleKeyEvent(key({ metaKey: true, code: "KeyB", key: "b" }))).toBe(false);
    expect(isRailToggleKeyEvent(key({ altKey: true, code: "KeyB" }))).toBe(false);
    expect(
      isRailToggleKeyEvent(key({ metaKey: true, altKey: true, shiftKey: true, code: "KeyB" })),
    ).toBe(false);
  });
});

describe("isEditingTarget", () => {
  it("is safe on non-DOM targets", () => {
    expect(isEditingTarget(null)).toBe(false);
    expect(isEditingTarget(42)).toBe(false);
    expect(isEditingTarget({})).toBe(false);
  });

  it("matches when closest finds an editing ancestor", () => {
    const target = {
      closest: (selector: string) => (selector.includes(".cm-editor") ? {} : null),
    };
    expect(isEditingTarget(target)).toBe(true);
  });

  it("matches contenteditable exposed via the property", () => {
    const target = { closest: () => null, isContentEditable: true };
    expect(isEditingTarget(target)).toBe(true);
  });

  it("does not match plain elements", () => {
    const target = { closest: () => null, isContentEditable: false };
    expect(isEditingTarget(target)).toBe(false);
  });
});
