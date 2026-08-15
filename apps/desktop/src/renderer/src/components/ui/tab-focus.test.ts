import { describe, expect, it } from "vite-plus/test";

import { movedTabIndex, successorTabIndex, tabFocusMove, tabStopIndex } from "./tab-focus";

describe("tabFocusMove", () => {
  it("names the four keys a horizontal tablist owns", () => {
    expect(tabFocusMove("ArrowRight")).toBe("next");
    expect(tabFocusMove("ArrowLeft")).toBe("prev");
    expect(tabFocusMove("Home")).toBe("first");
    expect(tabFocusMove("End")).toBe("last");
  });

  it("lets every other key through — including the ones the tab itself handles", () => {
    // Enter/Space activate and are answered by the component, not by this map;
    // ArrowDown/Escape belong to whatever is listening above the strip.
    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "Escape", "Tab", "a"]) {
      expect(tabFocusMove(key)).toBeNull();
    }
  });
});

describe("movedTabIndex", () => {
  it("steps one tab at a time", () => {
    expect(movedTabIndex(4, 1, "next")).toBe(2);
    expect(movedTabIndex(4, 1, "prev")).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(movedTabIndex(4, 2, "first")).toBe(0);
    expect(movedTabIndex(4, 2, "last")).toBe(3);
  });

  it("wraps at both ends", () => {
    expect(movedTabIndex(3, 2, "next")).toBe(0);
    expect(movedTabIndex(3, 0, "prev")).toBe(2);
  });

  it("holds still on a strip of one", () => {
    for (const move of ["next", "prev", "first", "last"] as const) {
      expect(movedTabIndex(1, 0, move)).toBe(0);
    }
  });

  it("refuses to move from a tab that is not in the strip", () => {
    expect(movedTabIndex(3, -1, "next")).toBeNull();
    expect(movedTabIndex(3, 3, "next")).toBeNull();
    expect(movedTabIndex(0, 0, "next")).toBeNull();
  });
});

describe("successorTabIndex", () => {
  it("hands focus to the right-hand neighbour", () => {
    expect(successorTabIndex(3, 0)).toBe(1);
    expect(successorTabIndex(3, 1)).toBe(2);
  });

  it("falls back to the left when the closing tab was last", () => {
    expect(successorTabIndex(3, 2)).toBe(1);
  });

  it("has no successor for the only tab — the surface falls to its empty state", () => {
    expect(successorTabIndex(1, 0)).toBeNull();
  });

  it("refuses a tab that is not in the strip", () => {
    expect(successorTabIndex(3, -1)).toBeNull();
    expect(successorTabIndex(3, 3)).toBeNull();
  });
});

describe("tabStopIndex", () => {
  it("puts the tab order's entry point on the active tab", () => {
    expect(tabStopIndex(3, 2)).toBe(2);
    expect(tabStopIndex(3, 0)).toBe(0);
  });

  it("falls back to the first tab when nothing is active, so the strip stays reachable", () => {
    // The bug this exists to prevent: keyed solely off `active`, a strip with
    // no selection leaves every tab at tabindex -1 and drops out of the
    // document's tab order.
    expect(tabStopIndex(3, -1)).toBe(0);
    expect(tabStopIndex(3, 7)).toBe(0);
  });

  it("has no tab stop when there are no tabs", () => {
    expect(tabStopIndex(0, -1)).toBeNull();
    expect(tabStopIndex(0, 0)).toBeNull();
  });
});
