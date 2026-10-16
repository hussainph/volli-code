import { describe, expect, it } from "vite-plus/test";

import {
  groupedSplitView,
  pairTabs,
  pairForTab,
  projectSplitView,
  unpairTab,
  activateTab,
  activeTabInSplitView,
  claimTabInPane,
  closePane,
  focusAdjacentPane,
  focusPane,
  isSinglePane,
  moveTabToPane,
  paneForTab,
  primaryPaneId,
  removeTab,
  renamedTabInSplitView,
  reorderPaneTabs,
  resolveSplitView,
  sanitizeSplitView,
  setSplitRatio,
  singlePaneSplitView,
  splitPane,
  splitViewPanes,
  SPLIT_VIEW_MAX_RATIO,
  SPLIT_VIEW_MIN_RATIO,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewBranch,
  type SplitViewDirection,
  type SplitViewNode,
  type SplitViewPane,
  type SplitViewState,
} from "./split-view";

/** A pane; its front tab defaults to its first, which is what a split leaves behind. */
function pane(
  id: string,
  tabIds: readonly string[] = [],
  activeTabId: string | null = tabIds[0] ?? null,
): SplitViewPane {
  return { kind: "pane", id, tabIds, activeTabId };
}

function branch(
  id: string,
  direction: SplitViewDirection,
  first: SplitViewNode,
  second: SplitViewNode,
  ratio = 0.5,
): SplitViewBranch {
  return { kind: "split", id, direction, ratio, first, second };
}

function view(root: SplitViewNode, focusedPaneId: string): SplitViewState {
  return { root, focusedPaneId };
}

/** Deterministic id minter: "m1", "m2", … in call order. */
function minter(): () => string {
  let minted = 0;
  return () => {
    minted += 1;
    return `m${minted}`;
  };
}

/** The shape most tests start from: two panes side by side, the right one focused. */
function twoPanes(): SplitViewState {
  return view(branch("s1", "row", pane("p1", ["a", "b"]), pane("p2", ["c"])), "p2");
}

const drawn = (state: SplitViewState): readonly (readonly string[])[] =>
  splitViewPanes(state).map((leaf) => leaf.tabIds);

describe("singlePaneSplitView", () => {
  it("is one pane under the root id a surface splits from", () => {
    const state = singlePaneSplitView(["a", "b"], "b");

    expect(state).toEqual({
      root: { kind: "pane", id: SPLIT_VIEW_ROOT_PANE_ID, tabIds: ["a", "b"], activeTabId: "b" },
      focusedPaneId: SPLIT_VIEW_ROOT_PANE_ID,
    });
    expect(isSinglePane(state)).toBe(true);
  });

  it("copies the ids it was handed, and takes a caller's pane id", () => {
    const tabIds = ["a"];
    const state = singlePaneSplitView(tabIds, null, "given");

    expect(state.root.kind === "pane" && state.root.tabIds).not.toBe(tabIds);
    expect(primaryPaneId(state)).toBe("given");
  });
});

describe("splitPane", () => {
  it("opens an empty pane to the right and focuses it", () => {
    const state = singlePaneSplitView(["a"], "a");
    const next = splitPane(state, SPLIT_VIEW_ROOT_PANE_ID, "right", {}, minter());

    expect(next.root).toEqual({
      kind: "split",
      // The pane's id is minted first, then the branch's.
      id: "m2",
      direction: "row",
      ratio: 0.5,
      first: { kind: "pane", id: "root", tabIds: ["a"], activeTabId: "a" },
      second: { kind: "pane", id: "m1", tabIds: [], activeTabId: null },
    });
    expect(next.focusedPaneId).toBe("m1");
    // An empty pane has no context of its own — it draws the surface menu.
    expect(activeTabInSplitView(next)).toBeNull();
  });

  it("stacks the new pane below for a down split", () => {
    const next = splitPane(singlePaneSplitView([], null), "root", "down", {}, minter());

    expect(next.root.kind === "split" && next.root.direction).toBe("column");
  });

  it("moves the dragged tab into the new pane and fronts it there", () => {
    const next = splitPane(twoPanes(), "p1", "right", { tabId: "b" }, minter());

    expect(drawn(next)).toEqual([["a"], ["b"], ["c"]]);
    expect(next.focusedPaneId).toBe("m1");
    expect(activeTabInSplitView(next)).toBe("b");
  });

  it("collapses the pane the dragged tab left behind", () => {
    // p2's only tab dropped on p1's edge: p2 is now a hole in the layout.
    const next = splitPane(twoPanes(), "p1", "down", { tabId: "c" }, minter());

    expect(splitViewPanes(next).map((leaf) => leaf.id)).toEqual(["p1", "m1"]);
    expect(drawn(next)).toEqual([["a", "b"], ["c"]]);
  });

  it("claims a tab no pane held", () => {
    const next = splitPane(twoPanes(), "p2", "right", { tabId: "fresh" }, minter());

    expect(drawn(next)).toEqual([["a", "b"], ["c"], ["fresh"]]);
  });

  it("returns by identity for a pane's only tab dropped on its own edge", () => {
    // The drop zone draws this as the centre preview: it would trade one pane
    // of one tab for an empty pane beside a pane of one tab.
    const state = twoPanes();
    expect(splitPane(state, "p2", "right", { tabId: "c" }, minter())).toBe(state);
  });

  it("returns by identity for a pane that does not exist", () => {
    const state = twoPanes();
    expect(splitPane(state, "gone", "right", {}, minter())).toBe(state);
  });
});

describe("activateTab", () => {
  it("focuses the pane holding the tab and puts it in front", () => {
    const next = activateTab(twoPanes(), "b");

    expect(next.focusedPaneId).toBe("p1");
    expect(activeTabInSplitView(next)).toBe("b");
  });

  it("moves focus alone when the tab is already its pane's front tab", () => {
    const state = twoPanes();
    const next = activateTab(state, "a");

    expect(next.focusedPaneId).toBe("p1");
    // Nothing about the panes changed, so nothing about them is redrawn.
    expect(next.root).toBe(state.root);
  });

  it("returns by identity when that tab is already in front of the focused pane", () => {
    const state = twoPanes();
    expect(activateTab(state, "c")).toBe(state);
  });

  it("assigns a tab no pane holds to the focused pane — where the work is", () => {
    // The empty pane's menu works on this alone: ⌘P opens a file, the surface
    // activates it, and it lands in the pane that has the focus.
    const next = activateTab(twoPanes(), "fresh");

    expect(drawn(next)).toEqual([
      ["a", "b"],
      ["c", "fresh"],
    ]);
    expect(activeTabInSplitView(next)).toBe("fresh");
  });

  it("leaves a state whose focus names no pane alone", () => {
    const state = view(branch("s1", "row", pane("p1", ["a"]), pane("p2", ["c"])), "gone");
    expect(activateTab(state, "fresh")).toBe(state);
  });
});

describe("claimTabInPane", () => {
  it("claims and fronts an unclaimed tab without moving unrelated focus", () => {
    const state = twoPanes();
    const next = claimTabInPane(state, "fresh", "p1", true);

    expect(drawn(next)).toEqual([["a", "b", "fresh"], ["c"]]);
    expect(splitViewPanes(next)[0]?.activeTabId).toBe("fresh");
    expect(next.focusedPaneId).toBe("p2");
    expect(activeTabInSplitView(next)).toBe("c");
    expect(splitViewPanes(next)[1]).toBe(splitViewPanes(state)[1]);
    expect(drawn(state)).toEqual([["a", "b"], ["c"]]);
  });

  it("claims an inactive tab without replacing its pane's front", () => {
    const next = claimTabInPane(twoPanes(), "fresh", "p2", false);

    expect(drawn(next)).toEqual([
      ["a", "b"],
      ["c", "fresh"],
    ]);
    expect(next.focusedPaneId).toBe("p2");
    expect(activeTabInSplitView(next)).toBe("c");
  });

  it("keeps an empty pane's front null for an inactive claim", () => {
    const state = view(branch("s1", "row", pane("p1", ["a"]), pane("p2")), "p1");
    const next = claimTabInPane(state, "fresh", "p2", false);

    expect(splitViewPanes(next)[1]).toEqual(pane("p2", ["fresh"], null));
    expect(next.focusedPaneId).toBe("p1");
  });

  it("fronts a claim in the focused pane when requested", () => {
    const next = claimTabInPane(twoPanes(), "fresh", "p2", true);
    expect(activeTabInSplitView(next)).toBe("fresh");
    expect(next.focusedPaneId).toBe("p2");
  });

  it("returns by identity for a tab already claimed here or elsewhere", () => {
    const state = twoPanes();
    expect(claimTabInPane(state, "b", "p1", true)).toBe(state);
    expect(claimTabInPane(state, "b", "p2", true)).toBe(state);
    expect(claimTabInPane(state, "c", "p2", false)).toBe(state);
  });

  it("returns by identity for a target pane that does not exist", () => {
    const state = twoPanes();
    expect(claimTabInPane(state, "fresh", "gone", true)).toBe(state);
  });
});

describe("moveTabToPane", () => {
  it("appends the tab, focuses the target and fronts what was dropped", () => {
    const next = moveTabToPane(twoPanes(), "a", "p2");

    expect(drawn(next)).toEqual([["b"], ["c", "a"]]);
    expect(next.focusedPaneId).toBe("p2");
    expect(activeTabInSplitView(next)).toBe("a");
  });

  it("collapses the source pane the move emptied", () => {
    const next = moveTabToPane(twoPanes(), "c", "p1");

    expect(splitViewPanes(next).map((leaf) => leaf.id)).toEqual(["p1"]);
    expect(isSinglePane(next)).toBe(true);
    expect(drawn(next)).toEqual([["a", "b", "c"]]);
  });

  it("sends a tab to the end of its own pane", () => {
    const next = moveTabToPane(twoPanes(), "a", "p1");

    expect(drawn(next)).toEqual([["b", "a"], ["c"]]);
  });

  it("claims a tab no pane held", () => {
    const next = moveTabToPane(twoPanes(), "fresh", "p1");

    expect(drawn(next)).toEqual([["a", "b", "fresh"], ["c"]]);
  });

  it("returns by identity when the tab is already that pane's last and in front", () => {
    const state = twoPanes();
    expect(moveTabToPane(state, "c", "p2")).toBe(state);
  });

  it("still focuses and fronts a tab already sitting last in another pane", () => {
    const state = view(branch("s1", "row", pane("p1", ["a", "b"], "a"), pane("p2", ["c"])), "p1");
    const next = moveTabToPane(state, "b", "p1");

    expect(drawn(next)).toEqual([["a", "b"], ["c"]]);
    expect(activeTabInSplitView(next)).toBe("b");
  });

  it("returns by identity for a pane that does not exist", () => {
    const state = twoPanes();
    expect(moveTabToPane(state, "a", "gone")).toBe(state);
  });
});

describe("removeTab", () => {
  it("hands the front tab to the next one in the pane", () => {
    const state = view(
      branch("s1", "row", pane("p1", ["a", "b", "c"], "b"), pane("p2", ["d"])),
      "p1",
    );
    const next = removeTab(state, "b");

    expect(drawn(next)).toEqual([["a", "c"], ["d"]]);
    expect(activeTabInSplitView(next)).toBe("c");
  });

  it("falls back to the previous tab when the last one closed", () => {
    const state = view(branch("s1", "row", pane("p1", ["a", "b"], "b"), pane("p2", ["d"])), "p1");

    expect(activeTabInSplitView(removeTab(state, "b"))).toBe("a");
  });

  it("leaves the front tab alone when some other tab closed", () => {
    const state = view(branch("s1", "row", pane("p1", ["a", "b"], "a"), pane("p2", ["d"])), "p1");
    const next = removeTab(state, "b");

    expect(activeTabInSplitView(next)).toBe("a");
  });

  it("collapses a non-primary pane it emptied, and moves focus into the survivor", () => {
    const next = removeTab(twoPanes(), "c");

    expect(next).toEqual(view(pane("p1", ["a", "b"]), "p1"));
  });

  it("keeps the primary pane when it empties, with nothing in front", () => {
    const state = view(branch("s1", "row", pane("p1", ["a"]), pane("p2", ["c"])), "p1");
    const next = removeTab(state, "a");

    expect(splitViewPanes(next).map((leaf) => leaf.id)).toEqual(["p1", "p2"]);
    expect(activeTabInSplitView(next)).toBeNull();
  });

  it("returns by identity for a tab no pane holds", () => {
    const state = twoPanes();
    expect(removeTab(state, "gone")).toBe(state);
  });
});

describe("closePane", () => {
  it("collapses the pane and gives its space — and the focus — to the sibling", () => {
    const state = view(
      branch(
        "s1",
        "row",
        pane("p1", ["a"]),
        branch("s2", "column", pane("p2", []), pane("p3", ["d"])),
      ),
      "p2",
    );
    const next = closePane(state, "p2");

    expect(next).toEqual(view(branch("s1", "row", pane("p1", ["a"]), pane("p3", ["d"])), "p3"));
  });

  it("leaves the focus where it was when some other pane closed", () => {
    const state = view(
      branch(
        "s1",
        "row",
        pane("p1", ["a"]),
        branch("s2", "column", pane("p2", []), pane("p3", [])),
      ),
      "p1",
    );

    expect(closePane(state, "p3").focusedPaneId).toBe("p1");
  });

  it("relinquishes the tabs it still held to the primary pane", () => {
    // Closing a pane is a layout act: nothing here may close a tab, and the
    // primary pane is already where an unclaimed id renders.
    const next = closePane(twoPanes(), "p2");

    expect(drawn(next)).toEqual([["a", "b", "c"]]);
  });

  it("never closes the primary pane, which is where the permanent tab lives", () => {
    const state = twoPanes();
    expect(closePane(state, "p1")).toBe(state);
  });

  it("returns by identity for a pane that does not exist", () => {
    const state = twoPanes();
    expect(closePane(state, "gone")).toBe(state);
  });

  it("leaves the half of the tree it never found the pane in by identity", () => {
    const state = view(
      branch(
        "s1",
        "row",
        branch("s2", "column", pane("p1", ["a"]), pane("p2", ["b"])),
        branch("s3", "column", pane("p3", ["c"]), pane("p4", [])),
      ),
      "p4",
    );
    const next = closePane(state, "p4");

    expect(next.root.kind === "split" && next.root.first).toBe(
      state.root.kind === "split" && state.root.first,
    );
    expect(splitViewPanes(next).map((leaf) => leaf.id)).toEqual(["p1", "p2", "p3"]);
    expect(next.focusedPaneId).toBe("p3");
  });

  it("reaches a pane nested in the first half of the tree", () => {
    const state = view(
      branch(
        "s1",
        "column",
        branch(
          "s2",
          "row",
          pane("p1", ["a"]),
          branch("s3", "row", pane("p2", ["b"]), pane("p3", ["c"])),
        ),
        pane("p4", ["d"]),
      ),
      "p3",
    );
    const next = closePane(state, "p3");

    expect(next).toEqual(
      view(
        branch(
          "s1",
          "column",
          branch("s2", "row", pane("p1", ["a", "c"]), pane("p2", ["b"])),
          pane("p4", ["d"]),
        ),
        "p2",
      ),
    );
  });

  it("reaches a pane nested below the branch it walks into", () => {
    const state = view(
      branch(
        "s1",
        "row",
        pane("p1", ["a"]),
        branch(
          "s2",
          "column",
          pane("p2", ["b"]),
          branch("s3", "row", pane("p3", ["c"]), pane("p4", ["d"])),
        ),
      ),
      "p1",
    );
    const next = closePane(state, "p4");

    expect(splitViewPanes(next).map((leaf) => leaf.id)).toEqual(["p1", "p2", "p3"]);
    expect(drawn(next)).toEqual([["a", "d"], ["b"], ["c"]]);
  });
});

describe("renamedTabInSplitView", () => {
  const strip = (): SplitViewState =>
    view(
      branch("s1", "row", pane("p1", ["file:a.ts", "chat:c1"]), pane("p2", ["file:b.ts"])),
      "p1",
    );

  it("follows a tab to its new id without moving it between panes", () => {
    const next = renamedTabInSplitView(strip(), "file:a.ts", "file:renamed.ts");

    expect(drawn(next)).toEqual([["file:renamed.ts", "chat:c1"], ["file:b.ts"]]);
    expect(activeTabInSplitView(next)).toBe("file:renamed.ts");
  });

  it("leaves a front tab that was not the renamed one alone", () => {
    const state = view(pane("p1", ["file:a.ts", "chat:c1"], "chat:c1"), "p1");
    const next = renamedTabInSplitView(state, "file:a.ts", "file:renamed.ts");

    expect(activeTabInSplitView(next)).toBe("chat:c1");
  });

  it("absorbs a stale mention of the destination id sitting in another pane", () => {
    const next = renamedTabInSplitView(strip(), "file:a.ts", "file:b.ts");

    expect(drawn(next)).toEqual([["file:b.ts", "chat:c1"]]);
  });

  it("puts the renamed tab in front when the stale one it absorbed was", () => {
    // The tab that took the name is the tab that was on screen under it.
    const state = view(
      branch(
        "s1",
        "row",
        pane("p1", ["file:a.ts", "chat:c1"], "chat:c1"),
        pane("p2", ["x", "file:b.ts"], "file:b.ts"),
      ),
      "p2",
    );
    const next = renamedTabInSplitView(state, "file:a.ts", "file:b.ts");

    expect(drawn(next)).toEqual([["file:b.ts", "chat:c1"], ["x"]]);
    expect(next.focusedPaneId).toBe("p1");
    expect(activeTabInSplitView(next)).toBe("file:b.ts");
  });

  it("absorbs a stale mention sitting in the same pane", () => {
    const state = view(pane("p1", ["file:a.ts", "file:b.ts", "chat:c1"]), "p1");
    const next = renamedTabInSplitView(state, "file:a.ts", "file:b.ts");

    expect(drawn(next)).toEqual([["file:b.ts", "chat:c1"]]);
  });

  it("returns by identity when no pane names the old id, or nothing changed", () => {
    const state = strip();
    expect(renamedTabInSplitView(state, "file:gone.ts", "file:new.ts")).toBe(state);
    expect(renamedTabInSplitView(state, "file:a.ts", "file:a.ts")).toBe(state);
  });
});

describe("reorderPaneTabs", () => {
  it("rewrites the pane's strip wholesale from what the drop drew", () => {
    const next = reorderPaneTabs(twoPanes(), "p1", ["b", "a"]);

    expect(drawn(next)).toEqual([["b", "a"], ["c"]]);
  });

  it("takes ids only, first mention winning", () => {
    const next = reorderPaneTabs(twoPanes(), "p1", ["b", "", "b", "a"]);

    expect(drawn(next)).toEqual([["b", "a"], ["c"]]);
  });

  it("gives up a front tab the strip no longer draws", () => {
    const next = reorderPaneTabs(twoPanes(), "p1", ["b"]);

    expect(splitViewPanes(next)[0]).toEqual(pane("p1", ["b"], null));
  });

  it("returns by identity when the drop changed nothing, and for an unknown pane", () => {
    const state = twoPanes();
    expect(reorderPaneTabs(state, "p1", ["a", "b"])).toBe(state);
    expect(reorderPaneTabs(state, "gone", ["a"])).toBe(state);
  });

  it("still writes when the order held but the front tab did not", () => {
    // A pane materialized from a surface can front a tab its own claim never
    // named (the arrangement names some tabs, the active tab need not be one);
    // the first drop inside it settles that.
    const state = view(branch("s1", "row", pane("p1", ["a", "b"], "z"), pane("p2", ["c"])), "p1");
    const next = reorderPaneTabs(state, "p1", ["a", "b"]);

    expect(next).not.toBe(state);
    expect(activeTabInSplitView(next)).toBeNull();
  });
});

describe("setSplitRatio", () => {
  it("resizes the branch it names", () => {
    const next = setSplitRatio(twoPanes(), "s1", 0.3);

    expect(next.root.kind === "split" && next.root.ratio).toBe(0.3);
  });

  it("clamps a pane that would be squeezed out of existence", () => {
    expect(
      setSplitRatio(twoPanes(), "s1", 0).root.kind === "split" &&
        (setSplitRatio(twoPanes(), "s1", 0).root as SplitViewBranch).ratio,
    ).toBe(SPLIT_VIEW_MIN_RATIO);
    expect((setSplitRatio(twoPanes(), "s1", 9).root as SplitViewBranch).ratio).toBe(
      SPLIT_VIEW_MAX_RATIO,
    );
  });

  it("refuses a ratio that is not a number at all", () => {
    // A divider dragged inside a box that has not been measured computes NaN,
    // and a NaN share renders a pane with no size.
    const state = twoPanes();
    expect(setSplitRatio(state, "s1", Number.NaN)).toBe(state);
  });

  it("returns by identity for the ratio it already has, and an unknown branch", () => {
    const state = twoPanes();
    expect(setSplitRatio(state, "s1", 0.5)).toBe(state);
    expect(setSplitRatio(state, "gone", 0.3)).toBe(state);
  });

  it("resizes a nested branch without rebuilding its neighbour", () => {
    const state = view(
      branch(
        "s1",
        "row",
        pane("p1", ["a"]),
        branch("s2", "column", pane("p2", []), pane("p3", [])),
      ),
      "p1",
    );
    const next = setSplitRatio(state, "s2", 0.25);

    expect(next.root.kind === "split" && next.root.first).toBe(
      state.root.kind === "split" && state.root.first,
    );
    expect(((next.root as SplitViewBranch).second as SplitViewBranch).ratio).toBe(0.25);
  });
});

describe("focusPane", () => {
  it("moves the focus", () => {
    expect(focusPane(twoPanes(), "p1").focusedPaneId).toBe("p1");
  });

  it("returns by identity for the focused pane and for one that does not exist", () => {
    const state = twoPanes();
    expect(focusPane(state, "p2")).toBe(state);
    expect(focusPane(state, "gone")).toBe(state);
  });
});

describe("focusAdjacentPane", () => {
  /**
   * a │ c   — a left-top, b left-bottom, c right-top, d right-bottom, with the
   * b │ d     right column split high (c is the top quarter).
   */
  const quad = (focusedPaneId: string): SplitViewState =>
    view(
      branch(
        "s1",
        "row",
        branch("s2", "column", pane("a", ["a"]), pane("b", ["b"])),
        branch("s3", "column", pane("c", ["c"]), pane("d", ["d"]), 0.25),
      ),
      focusedPaneId,
    );

  it("walks by geometry in each direction", () => {
    expect(focusAdjacentPane(quad("a"), "right").focusedPaneId).toBe("c");
    expect(focusAdjacentPane(quad("a"), "down").focusedPaneId).toBe("b");
    expect(focusAdjacentPane(quad("d"), "left").focusedPaneId).toBe("b");
    expect(focusAdjacentPane(quad("d"), "up").focusedPaneId).toBe("c");
  });

  it("prefers the neighbour that overlaps the edge it is leaving", () => {
    // b spans the lower half; c is the top quarter of the right column and d
    // the rest, so d overlaps and c does not.
    expect(focusAdjacentPane(quad("b"), "right").focusedPaneId).toBe("d");
    // …and the same judgement seen from the other side.
    expect(focusAdjacentPane(quad("c"), "left").focusedPaneId).toBe("a");
  });

  it("breaks a tie on how far the centres are apart", () => {
    const top = (ratio: number): SplitViewState =>
      view(
        branch(
          "s1",
          "column",
          branch("s2", "row", pane("a", ["a"]), pane("b", ["b"]), ratio),
          pane("c", ["c"]),
        ),
        "c",
      );

    expect(focusAdjacentPane(top(0.8), "up").focusedPaneId).toBe("a");
    expect(focusAdjacentPane(top(0.2), "up").focusedPaneId).toBe("b");
  });

  it("stays put at an outer edge — focus never wraps", () => {
    const state = quad("a");
    expect(focusAdjacentPane(state, "left")).toBe(state);
    expect(focusAdjacentPane(state, "up")).toBe(state);
  });

  it("returns by identity when the focus names no pane", () => {
    const state = quad("gone");
    expect(focusAdjacentPane(state, "right")).toBe(state);
  });
});

describe("readers", () => {
  it("lists panes in reading order, primary first", () => {
    const state = quadState();

    expect(splitViewPanes(state).map((leaf) => leaf.id)).toEqual(["p1", "p2", "p3"]);
    expect(primaryPaneId(state)).toBe("p1");
  });

  it("answers which pane claims a tab, and that nothing claims the rest", () => {
    const state = quadState();

    expect(paneForTab(state, "b")).toBe("p1");
    expect(paneForTab(state, "d")).toBe("p3");
    expect(paneForTab(state, "gone")).toBeNull();
  });

  it("reports the focused pane's front tab, and nothing for a dangling focus", () => {
    expect(activeTabInSplitView(twoPanes())).toBe("c");
    expect(activeTabInSplitView(view(pane("p1", ["a"]), "gone"))).toBeNull();
  });

  it("knows a single pane from a split", () => {
    expect(isSinglePane(singlePaneSplitView([], null))).toBe(true);
    expect(isSinglePane(twoPanes())).toBe(false);
  });

  function quadState(): SplitViewState {
    return view(
      branch(
        "s1",
        "row",
        pane("p1", ["a", "b"]),
        branch("s2", "column", pane("p2", ["c"]), pane("p3", ["d"])),
      ),
      "p1",
    );
  }
});

/** A chain of `levels` nested branches; its panes sit at depth `levels + 1`. */
function nest(levels: number): unknown {
  let node: unknown = { kind: "pane", id: "leaf", tabIds: [], activeTabId: null };
  for (let level = 0; level < levels; level += 1) {
    node = {
      kind: "split",
      id: `s${level}`,
      direction: "row",
      ratio: 0.5,
      first: { kind: "pane", id: `p${level}`, tabIds: [], activeTabId: null },
      second: node,
    };
  }
  return { root: node, focusedPaneId: "leaf" };
}

/** A balanced tree of 2^`levels` panes. */
function balanced(levels: number): unknown {
  let id = 0;
  const build = (depth: number): unknown => {
    id += 1;
    if (depth === 0) return { kind: "pane", id: `p${id}`, tabIds: [], activeTabId: null };
    return {
      kind: "split",
      id: `s${id}`,
      direction: "row",
      ratio: 0.5,
      first: build(depth - 1),
      second: build(depth - 1),
    };
  };
  return { root: build(levels), focusedPaneId: "p2" };
}

describe("sanitizeSplitView", () => {
  const stored = {
    root: {
      kind: "split",
      id: "s1",
      direction: "row",
      ratio: 0.4,
      first: { kind: "pane", id: "p1", tabIds: ["a", "b"], activeTabId: "b" },
      second: { kind: "pane", id: "p2", tabIds: ["c"], activeTabId: "c" },
    },
    focusedPaneId: "p2",
  };

  it("restores a tree it can draw", () => {
    expect(sanitizeSplitView(stored)).toEqual({
      ...view(branch("s1", "row", pane("p1", ["b"]), pane("p2", ["c"]), 0.4), "p2"),
      pairs: [branch("s1", "row", pane("p1", ["b"]), pane("p2", ["c"]), 0.4)],
      selectedTabId: "c",
    });
  });

  it("degrades anything that is not a split-view object", () => {
    expect(sanitizeSplitView(undefined)).toBeNull();
    expect(sanitizeSplitView(null)).toBeNull();
    expect(sanitizeSplitView("split")).toBeNull();
    expect(sanitizeSplitView({})).toBeNull();
    expect(sanitizeSplitView({ root: 7, focusedPaneId: "p1" })).toBeNull();
  });

  it("refuses a single pane, which is not a split at all", () => {
    // The store collapses to null the moment one pane is left, so a stored
    // single pane is a build that stopped between the collapse and its write.
    expect(sanitizeSplitView({ root: { kind: "pane", id: "root", tabIds: [] } })).toBeNull();
  });

  it("refuses a node whose kind, direction or children cannot be read", () => {
    expect(sanitizeSplitView({ ...stored, root: { ...stored.root, kind: "cell" } })).toBeNull();
    expect(
      sanitizeSplitView({ ...stored, root: { ...stored.root, direction: "diagonal" } }),
    ).toBeNull();
    expect(sanitizeSplitView({ ...stored, root: { ...stored.root, first: null } })).toBeNull();
    expect(
      sanitizeSplitView({ ...stored, root: { ...stored.root, second: undefined } }),
    ).toBeNull();
  });

  it("refuses a node with no id, and one whose id is already taken", () => {
    // Focus, resize and every drop name nodes by id: two nodes answering to one
    // name is a tree no operation can address.
    expect(sanitizeSplitView({ ...stored, root: { ...stored.root, id: 7 } })).toBeNull();
    expect(sanitizeSplitView({ ...stored, root: { ...stored.root, id: "" } })).toBeNull();
    expect(
      sanitizeSplitView({
        ...stored,
        root: { ...stored.root, second: { ...stored.root.second, id: "p1" } },
      }),
    ).toBeNull();
  });

  it("degrades legacy empty/invalid front tabs rather than claiming other tabs", () => {
    for (const second of [
      pane("p2", ["b", "c"], null),
      pane("p2", [], null),
      pane("p2", ["c"], "a"),
    ]) {
      expect(sanitizeSplitView({ ...stored, root: { ...stored.root, second } })).toBeNull();
    }
  });

  it("retains unhydrated front identities but releases background tabs", () => {
    const restored = sanitizeSplitView({
      ...stored,
      root: { ...stored.root, second: pane("p2", ["chat:late"], "chat:late") },
    });
    expect(pairForTab(restored, "chat:late")).not.toBeNull();
    expect(pairForTab(restored, "a")).toBeNull();
  });

  it("clamps a stored ratio, and replaces one that is not a number", () => {
    const ratioOf = (ratio: unknown): number | false => {
      const restored = sanitizeSplitView({ ...stored, root: { ...stored.root, ratio } });
      return restored?.root.kind === "split" && restored.root.ratio;
    };

    expect(ratioOf(0.01)).toBe(SPLIT_VIEW_MIN_RATIO);
    expect(ratioOf(12)).toBe(SPLIT_VIEW_MAX_RATIO);
    expect(ratioOf("half")).toBe(0.5);
    expect(ratioOf(Number.POSITIVE_INFINITY)).toBe(0.5);
  });

  it("falls back to the primary pane when the stored focus names none", () => {
    expect(sanitizeSplitView({ ...stored, focusedPaneId: "gone" })?.focusedPaneId).toBe("p1");
    expect(sanitizeSplitView({ ...stored, focusedPaneId: 7 })?.focusedPaneId).toBe("p1");
  });

  it("refuses a tree deeper than a person could have arranged", () => {
    expect(sanitizeSplitView(nest(5))).toBeNull(); // Valid legacy shape, but no front tabs to pair.
    expect(sanitizeSplitView(nest(6))).toBeNull();
  });

  it("refuses a tree with more panes than a surface could show", () => {
    expect(sanitizeSplitView(balanced(3))).toBeNull(); // 8 panes
    expect(sanitizeSplitView(balanced(4))).toBeNull(); // 16
  });

  it("cannot be tricked by hostile keys in the stored JSON", () => {
    const hostile = JSON.parse(
      `{"root":{"kind":"split","id":"s1","direction":"row","ratio":0.5,
        "first":{"kind":"pane","id":"p1","tabIds":["__proto__"],"activeTabId":"__proto__"},
        "second":{"kind":"pane","id":"__proto__","tabIds":[],"activeTabId":null}},
        "focusedPaneId":"__proto__"}`,
    ) as unknown;

    expect(sanitizeSplitView(hostile)).toBeNull();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("is stable under a second pass", () => {
    const once = sanitizeSplitView(stored);
    expect(sanitizeSplitView(once)).toEqual(once);
  });
});

describe("resolveSplitView", () => {
  const live = ["board", "terminal-1", "chat:c1", "file:a.ts"];

  it("draws an unsplit surface exactly as its own strip", () => {
    // The property the whole feature rests on: one grid renders both cases, and
    // the unsplit one is the strip it always was.
    const resolved = resolveSplitView(singlePaneSplitView([], "chat:c1"), live, "board");

    expect(resolved.panes).toHaveLength(1);
    expect(resolved.panes[0]?.tabIds).toEqual(live);
    expect(resolved.panes[0]?.isPrimary).toBe(true);
    expect(resolved.activeTabId).toBe("chat:c1");
  });

  it("keeps each pane's own order and drops ids nothing answers to", () => {
    const state = view(
      branch("s1", "row", pane("p1", ["file:a.ts"]), pane("p2", ["chat:gone", "chat:c1"])),
      "p2",
    );
    const resolved = resolveSplitView(state, live, "board");

    expect(resolved.panes.map((leaf) => leaf.tabIds)).toEqual([
      // The permanent tab first, then this pane's claim, then what nothing
      // claimed — in strip order.
      ["board", "file:a.ts", "terminal-1"],
      ["chat:c1"],
    ]);
    expect(resolved.activeTabId).toBe("chat:c1");
  });

  it("keeps the permanent tab in the primary pane wherever it was claimed", () => {
    const state = view(branch("s1", "row", pane("p1", []), pane("p2", ["board", "chat:c1"])), "p2");
    const resolved = resolveSplitView(state, live, "board");

    expect(resolved.panes[0]?.tabIds[0]).toBe("board");
    expect(resolved.panes[1]?.tabIds).toEqual(["chat:c1"]);
  });

  it("falls back to a pane's first live tab when its front tab is gone", () => {
    const state = view(
      branch("s1", "row", pane("p1", []), pane("p2", ["chat:c1", "file:a.ts"], "chat:gone")),
      "p2",
    );

    expect(resolveSplitView(state, live, "board").activeTabId).toBe("chat:c1");
  });

  it("resolves an empty pane to nothing in front — that is the pane's menu", () => {
    const state = view(branch("s1", "row", pane("p1", []), pane("p2", ["terminal-dead"])), "p2");
    const resolved = resolveSplitView(state, ["board"], "board");

    expect(resolved.panes[1]).toEqual({
      kind: "pane",
      id: "p2",
      tabIds: [],
      activeTabId: null,
      index: 1,
      isPrimary: false,
    });
    // Resolution never collapses: the pane is still there, waiting for the
    // Session behind those ids to come back.
    expect(resolved.panes).toHaveLength(2);
    expect(resolved.activeTabId).toBeNull();
  });

  it("numbers panes in reading order and reports the primary", () => {
    const state = view(
      branch(
        "s1",
        "column",
        pane("p1", []),
        branch("s2", "row", pane("p2", ["chat:c1"]), pane("p3", ["file:a.ts"])),
      ),
      "p3",
    );
    const resolved = resolveSplitView(state, live, "board");

    expect(resolved.panes.map((leaf) => [leaf.id, leaf.index, leaf.isPrimary])).toEqual([
      ["p1", 0, true],
      ["p2", 1, false],
      ["p3", 2, false],
    ]);
    expect(resolved.primaryPaneId).toBe("p1");
    expect(resolved.focusedPaneId).toBe("p3");
  });

  it("mirrors the tree, ratios and directions, for the grid to draw", () => {
    const state = view(
      branch(
        "s1",
        "column",
        pane("p1", []),
        branch("s2", "row", pane("p2", []), pane("p3", []), 0.3),
      ),
      "p1",
    );
    const resolved = resolveSplitView(state, ["board"], "board");

    expect(resolved.root).toMatchObject({
      kind: "split",
      id: "s1",
      direction: "column",
      ratio: 0.5,
      first: { kind: "pane", id: "p1" },
      second: { kind: "split", id: "s2", direction: "row", ratio: 0.3 },
    });
  });

  it("falls back to the primary pane when the focus names none", () => {
    const resolved = resolveSplitView(twoPanes(), ["board", "a", "b", "c"], "board");
    const dangling = resolveSplitView(
      view(twoPanes().root, "gone"),
      ["board", "a", "b", "c"],
      "board",
    );

    expect(resolved.focusedPaneId).toBe("p2");
    expect(dangling.focusedPaneId).toBe("p1");
    expect(dangling.activeTabId).toBe("a");
  });

  it("never writes anything back", () => {
    const state = twoPanes();
    const before = JSON.stringify(state);
    resolveSplitView(state, ["board"], "board");

    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("grouped tab pairs", () => {
  const make = () =>
    pairTabs(
      groupedSplitView(["board", "a", "b", "c", "d"], "a"),
      "a",
      "b",
      "right",
      minter(),
      "root",
    );
  const live = ["board", "a", "b", "c", "d"];

  it("selects unrelated tabs full width and restores the exact pair and ratio", () => {
    const pair = make();
    const sized = setSplitRatio(pair, pair.root.id, 0.35);
    const away = activateTab(sized, "c");
    expect(away.root.kind).toBe("pane");
    expect(isSinglePane(away)).toBe(false); // Hidden pair is still persisted.
    expect(projectSplitView(away, live, "c", "board").panes.map((p) => p.activeTabId)).toEqual([
      "c",
    ]);
    const back = activateTab(away, "a");
    expect(back.root).toBe(sized.root);
    expect(pairForTab(back, "b")).toBe(pairForTab(sized, "a"));
    expect(activateTab(back, "a")).toBe(back);
    expect(activateTab(away, "c")).toBe(away);
  });

  it("keeps multiple independent pairs and releases old partners on explicit re-pairing", () => {
    const mint = minter();
    let state = pairTabs(groupedSplitView([], "a"), "a", "b", "right", mint, "root");
    state = pairTabs(state, "c", "d", "down", mint);
    expect(state.pairs).toHaveLength(2);
    expect(state.root.kind === "split" && state.root.direction).toBe("column");
    state = pairTabs(state, "a", "d", "right", mint);
    expect(state.pairs).toHaveLength(1);
    expect(pairForTab(state, "b")).toBeNull();
    expect(pairForTab(state, "c")).toBeNull();
    expect(pairTabs(state, "a", "a", "right", mint)).toBe(state);
    expect(pairTabs(state, "", "b", "right", mint)).toBe(state);
    expect(pairTabs(state, "a", "", "right", mint)).toBe(state);
    expect(pairTabs(state, "a", "d", "right", mint)).toBe(state);
  });

  it("uses the first two legacy fronts only; all background and later-pane tabs are ordinary", () => {
    const old = view(
      branch(
        "s",
        "column",
        branch("nested", "row", pane("p1", ["bg", "a"], "a"), pane("p2", ["b", "bg2"], "b")),
        pane("p3", ["c"]),
      ),
      "p3",
    );
    const state = sanitizeSplitView(JSON.parse(JSON.stringify(old)))!;
    expect(state.pairs).toHaveLength(1);
    expect(state.selectedTabId).toBe("c");
    expect(state.root.kind).toBe("pane");
    for (const id of ["bg", "bg2", "c"]) expect(pairForTab(state, id)).toBeNull();
    expect(
      projectSplitView(state, ["board", "bg", "a", "b", "bg2", "c"], "a", "board").panes.map(
        (p) => p.activeTabId,
      ),
    ).toEqual(["a", "b"]);
  });

  it("fills only an explicitly empty partner and then never absorbs other selections", () => {
    const mint = minter();
    const empty = splitPane(groupedSplitView(live, "a"), "root", "down", {}, mint);
    expect(activeTabInSplitView(empty)).toBeNull();
    const filled = activateTab(empty, "b");
    expect(filled.pairs![0]!.second.activeTabId).toBe("b");
    expect(activateTab(filled, "c").root.kind).toBe("pane");
    expect(pairForTab(activateTab(filled, "c"), "b")).not.toBeNull();
    expect(splitPane(filled, "root", "right", { tabId: "c" }, mint)).toBe(filled);
    expect(splitPane(filled, "gone", "right", {}, mint)).toBe(filled);
    expect(splitPane(groupedSplitView([], null), "root", "right", {}, mint).root.kind).toBe("pane");
  });

  it("allows Board/Body as either member, without forcing them primary", () => {
    const state = pairTabs(groupedSplitView([], "a"), "a", "board", "right", minter());
    const resolved = resolveSplitView(state, ["a"], "board");
    expect(resolved.panes.map((p) => p.activeTabId)).toEqual(["a", "board"]);
    expect(resolved.activeTabId).toBe("board");
    expect(focusAdjacentPane(state, "left").selectedTabId).toBe("a");
    expect(focusAdjacentPane(state, "right")).toBe(state);
    expect(focusPane(state, "gone")).toBe(state);
  });

  it("unpairs on close of either member, including a background pair", () => {
    const state = make();
    expect(removeTab(state, "b").selectedTabId).toBe("a");
    expect(removeTab(state, "a").selectedTabId).toBe("b");
    expect(removeTab(state, "missing")).toBe(state);
    const away = activateTab(state, "c");
    expect(removeTab(away, "b").selectedTabId).toBe("c");
    expect(removeTab(away, "c").selectedTabId).toBeNull();
    expect(unpairTab(state, "missing")).toBe(state);
    expect(closePane(state, "root").pairs).toHaveLength(0);
    expect(closePane(state, "m1").selectedTabId).toBe("a");
    expect(closePane(state, "gone")).toBe(state);
  });

  it("focuses empty menus, refuses third members and can explicitly fill the menu by move", () => {
    const empty = splitPane(groupedSplitView(live, "a"), "root", "right", {}, minter());
    const first = focusPane(empty, "root");
    expect(focusPane(first, "m1").focusedPaneId).toBe("m1");
    const filled = moveTabToPane(first, "b", "m1");
    expect(filled.selectedTabId).toBe("b");
    expect(moveTabToPane(filled, "c", "m1")).toBe(filled);
    expect(moveTabToPane(filled, "b", "m1")).toBe(filled);
    expect(moveTabToPane(filled, "c", "gone")).toBe(filled);
    expect(reorderPaneTabs(filled, "root", ["c"])).toBe(filled);
    expect(setSplitRatio(filled, "gone", 0.3)).toBe(filled);
    expect(setSplitRatio(filled, filled.root.id, 0.5)).toBe(filled);
  });

  it("keeps background draft claims from stealing focus or introducing hidden pane stacks", () => {
    const state = splitPane(groupedSplitView(live, "a"), "root", "right", {}, minter());
    expect(claimTabInPane(state, "b", "m1", false)).toBe(state);
    expect(claimTabInPane(state, "a", "m1", true)).toBe(state);
    expect(claimTabInPane(state, "b", "gone", true)).toBe(state);
    expect(claimTabInPane(state, "b", "m1", true).selectedTabId).toBe("b");
    const unfocused = focusPane(state, "root");
    const claimed = claimTabInPane(unfocused, "b", "m1", true);
    expect(claimed.selectedTabId).toBe("a");
    expect(claimed.focusedPaneId).toBe("root");
    expect(claimed.pairs![0]!.second.activeTabId).toBe("b");
  });

  it("follows renamed members and absorbs existing destinations", () => {
    const state = make();
    expect(renamedTabInSplitView(state, "missing", "z")).toBe(state);
    const renamed = renamedTabInSplitView(state, "b", "z");
    expect(renamed.selectedTabId).toBe("z");
    expect(pairForTab(renamed, "z")?.second.tabIds).toEqual(["z"]);
    const background = renamedTabInSplitView(activateTab(state, "c"), "a", "z");
    expect(background.selectedTabId).toBe("c");
    const absorbed = renamedTabInSplitView(state, "a", "b");
    expect(absorbed.pairs).toHaveLength(0);
  });

  it("tolerates missing live members without destroying saved membership", () => {
    const state = make();
    expect(projectSplitView(state, ["a"], "a", "board").panes.map((p) => p.activeTabId)).toEqual([
      "a",
    ]);
    expect(projectSplitView(state, [], "b", "board").activeTabId).toBe("board");
    expect(projectSplitView(null, [], null, "board").activeTabId).toBe("board");
    expect(projectSplitView(twoPanes(), ["a", "c"], "a", "board").panes).toHaveLength(2);
    expect(state.pairs).toHaveLength(1);
  });

  it("round-trips multiple pairs, ordinary selections and empty partner focus through JSON", () => {
    const mint = minter();
    let state = pairTabs(groupedSplitView([], "a"), "a", "b", "right", mint);
    state = pairTabs(state, "c", null, "down", mint);
    expect(sanitizeSplitView(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const away = activateTab(focusPane(state, state.pairs![1]!.first.id), "d");
    expect(sanitizeSplitView(JSON.parse(JSON.stringify(away)))).toEqual(away);
    expect(sanitizeSplitView({ pairs: [] })).toBeNull();
    expect(sanitizeSplitView({ pairs: "wrong" })).toBeNull();
    expect(
      sanitizeSplitView({ pairs: [state.pairs![0], state.pairs![0]], selectedTabId: "a" })?.pairs,
    ).toHaveLength(1);
    expect(
      sanitizeSplitView({
        pairs: [null, pane("p"), branch("s", "row", pane("x", []), pane("y", []))],
      }),
    ).toBeNull();
  });
});

describe("grouped tolerant-read edges", () => {
  it("preserves other pairs during resize, rename, fill, and background unpair", () => {
    const mint = minter();
    let state = pairTabs(singlePaneSplitView([], "a"), "a", "b", "right", mint, "root");
    state = pairTabs(state, "c", null, "down", mint, "root");
    expect(state.pairs![1]!.first.id).not.toBe("root");
    const first = state.pairs![0]!;
    const pending = state.pairs![1]!;
    expect(pairTabs(state, "c", null, "down", mint)).toBe(state);
    const filled = activateTab(state, "d");
    expect(filled.pairs![0]).toBe(first);
    expect(setSplitRatio(filled, first.id, 0.3).pairs![1]).toBe(filled.pairs![1]);
    expect(renamedTabInSplitView(filled, "a", "z").pairs![1]).toBe(filled.pairs![1]);
    expect(closePane(filled, first.first.id).selectedTabId).toBe("d");
    expect(moveTabToPane(filled, "z", first.first.id)).toBe(filled);
    expect(moveTabToPane(filled, "a", first.first.id).selectedTabId).toBe("a");
    expect(pairTabs(filled, "b", "a", "right", mint).pairs).toHaveLength(2);
    const absentSelected = { ...state, selectedTabId: undefined };
    expect(claimTabInPane(absentSelected, "d", pending.second.id, true).selectedTabId).toBe("d");
    const background = { ...focusPane(state, first.first.id), selectedTabId: undefined };
    expect(claimTabInPane(background, "d", pending.second.id, true).selectedTabId).toBeNull();
    expect(closePane(absentSelected, first.first.id).selectedTabId).toBeNull();
    expect(unpairTab(absentSelected, "a").selectedTabId).toBeNull();
    expect(setSplitRatio(absentSelected, first.id, 0.3).selectedTabId).toBeNull();
    expect(renamedTabInSplitView(absentSelected, "a", "z").selectedTabId).toBeNull();
    expect(closePane(state, pending.first.id).selectedTabId).toBeNull();
    expect(closePane(filled, pending.first.id).selectedTabId).toBe("d");
  });

  it("falls back from empty legacy focused panes and malformed additive fields", () => {
    const old = view(
      branch("s", "row", branch("n", "row", pane("a", ["a"]), pane("b", ["b"])), pane("empty")),
      "empty",
    );
    expect(sanitizeSplitView(old)?.selectedTabId).toBe("a");
    const valid = branch("s", "row", pane("a", ["a"]), pane("b", ["b"]));
    expect(sanitizeSplitView({ pairs: [valid] })?.selectedTabId).toBe("a");
    expect(sanitizeSplitView({ pairs: [valid], selectedTabId: null })?.selectedTabId).toBeNull();
    expect(
      sanitizeSplitView({ pairs: [{ ...valid, first: { ...valid.first, tabIds: "bad" } }] })
        ?.pairs?.[0]?.first.activeTabId,
    ).toBeNull();
    const invalid = [
      { ...valid, first: pane("a", ["a"], null) },
      { ...valid, first: pane("a", ["a", "extra"]) },
      { ...valid, second: pane("b", ["b", "extra"]) },
      { ...valid, second: pane("b", ["b"], null) },
      { ...valid, first: branch("nested", "row", pane("p1"), pane("p2")) },
      { ...valid, second: branch("nested", "row", pane("p1"), pane("p2")) },
    ];
    for (const pair of invalid) expect(sanitizeSplitView({ pairs: [pair] })).toBeNull();
    const duplicateTab = branch("other", "row", pane("p3", ["a"]), pane("p4", ["other"]));
    expect(sanitizeSplitView({ pairs: [valid, duplicateTab] })?.pairs).toHaveLength(1);
  });
});

// Frozen pre-pair persisted-state codec, copied from the shipping implementation.
// Keep this independent of the new sanitizer: an old reader must ignore additive
// metadata, recover all tabs from the live strip, and never see a new node kind.
function canary7CollectPanes(node: SplitViewNode, out: SplitViewPane[]): void {
  if (node.kind === "pane") {
    out.push(node);
    return;
  }
  canary7CollectPanes(node.first, out);
  canary7CollectPanes(node.second, out);
}
function canary7ReadSplitView(raw: unknown): SplitViewState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { root, focusedPaneId } = raw as { root?: unknown; focusedPaneId?: unknown };
  const node = canary7SanitizeNode(root, new Set<string>(), new Set<string>(), 1);
  if (node === null || node.kind === "pane") return null;
  const panes: SplitViewPane[] = [];
  canary7CollectPanes(node, panes);
  if (panes.length > 8) return null;
  const focused = panes.find((leaf) => leaf.id === focusedPaneId);
  return { root: node, focusedPaneId: focused?.id ?? panes[0]!.id };
}

function canary7SanitizeNode(
  raw: unknown,
  nodeIds: Set<string>,
  tabIds: Set<string>,
  depth: number,
): SplitViewNode | null {
  if (depth > 6) return null;
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    kind?: unknown;
    id?: unknown;
    tabIds?: unknown;
    activeTabId?: unknown;
    direction?: unknown;
    ratio?: unknown;
    first?: unknown;
    second?: unknown;
  };
  // A repeated id is unaddressable — focus, resize and every drop name nodes by
  // id, so two nodes answering to one name is a tree we cannot operate on.
  if (typeof record.id !== "string" || record.id.length === 0 || nodeIds.has(record.id)) {
    return null;
  }
  nodeIds.add(record.id);
  if (record.kind === "pane") {
    const claimed: string[] = [];
    for (const tabId of Array.isArray(record.tabIds) ? record.tabIds : []) {
      if (typeof tabId !== "string" || tabId.length === 0 || tabIds.has(tabId)) continue;
      tabIds.add(tabId);
      claimed.push(tabId);
    }
    const active = record.activeTabId;
    return {
      kind: "pane",
      id: record.id,
      tabIds: claimed,
      activeTabId: typeof active === "string" && claimed.includes(active) ? active : null,
    };
  }
  if (record.kind !== "split") return null;
  if (record.direction !== "row" && record.direction !== "column") return null;
  const first = canary7SanitizeNode(record.first, nodeIds, tabIds, depth + 1);
  if (first === null) return null;
  const second = canary7SanitizeNode(record.second, nodeIds, tabIds, depth + 1);
  if (second === null) return null;
  return {
    kind: "split",
    id: record.id,
    direction: record.direction,
    ratio:
      typeof record.ratio === "number" && Number.isFinite(record.ratio)
        ? Math.min(0.85, Math.max(0.15, record.ratio))
        : 0.5,
    first,
    second,
  };
}

describe("N−1 persisted split compatibility", () => {
  it("the frozen old codec opens a selected pair and recovers every other live tab", () => {
    const mint = minter();
    let state = pairTabs(groupedSplitView([], "a"), "a", "b", "right", mint);
    state = pairTabs(state, "c", "board", "down", mint);
    const readByOldBuild = canary7ReadSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(readByOldBuild).not.toHaveProperty("pairs");
    const oldProjection = resolveSplitView(
      readByOldBuild,
      ["board", "a", "b", "c", "ordinary"],
      "board",
    );
    expect(oldProjection.panes.flatMap((leaf) => leaf.tabIds).toSorted()).toEqual([
      "a",
      "b",
      "board",
      "c",
      "ordinary",
    ]);
    expect(oldProjection.root.kind).toBe("split");
  });

  it("the frozen old codec degrades a full-width ordinary selection to no split", () => {
    const state = activateTab(
      pairTabs(groupedSplitView([], "a"), "a", "b", "right", minter()),
      "ordinary",
    );
    expect(canary7ReadSplitView(JSON.parse(JSON.stringify(state)))).toBeNull();
    const restored = sanitizeSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(pairForTab(restored, "a")).not.toBeNull();
    expect(restored.selectedTabId).toBe("ordinary");
  });
});

describe("renderer-local paired Draft projections", () => {
  it("honors root overlays without persisting Draft IDs into membership", () => {
    const state = splitPane(groupedSplitView(["a"], "a"), "root", "right", {}, minter());
    const root = state.root as SplitViewBranch;
    const overlay = {
      ...state,
      root: { ...root, second: pane("m1", ["chat:draft"], "chat:draft") },
    };
    expect(
      resolveSplitView(overlay, ["a", "chat:draft"], "board").panes.map((leaf) => leaf.activeTabId),
    ).toEqual(["a", "chat:draft"]);
    expect(
      projectSplitView(overlay, ["a", "chat:draft"], "chat:draft", "board").panes.map(
        (leaf) => leaf.activeTabId,
      ),
    ).toEqual(["a", "chat:draft"]);
    expect(
      projectSplitView(overlay, ["a", "chat:draft", "other"], "other", "board").panes.map(
        (leaf) => leaf.activeTabId,
      ),
    ).toEqual(["other"]);
    expect(state.pairs![0]!.second.activeTabId).toBeNull();
  });
});

describe("ordinary Draft selection beside saved pairs", () => {
  it.each(["first", "second"] as const)(
    "does not replace the occupied %s member with an unrelated empty Draft",
    (side) => {
      const state = pairTabs(groupedSplitView([], "a"), "a", "b", "right", minter());
      const root = state.root as SplitViewBranch;
      const overlay = {
        ...state,
        root: { ...root, [side]: pane(`${side}-local`, ["chat:draft"], "chat:draft") },
      };
      expect(
        projectSplitView(overlay, ["a", "b", "chat:draft"], "chat:draft", "board").panes.map(
          (leaf) => leaf.activeTabId,
        ),
      ).toEqual(["chat:draft"]);
      expect(
        projectSplitView(overlay, ["a", "b", "chat:draft"], "a", "board").panes.map(
          (leaf) => leaf.activeTabId,
        ),
      ).toEqual(["a", "b"]);
      expect(state.pairs![0]!.second.activeTabId).toBe("b");
    },
  );
});

describe.each(["first", "second"] as const)("pending %s pair member", (side) => {
  const make = (mint = minter()) =>
    pairTabs(
      groupedSplitView([], "ordinary"),
      side === "first" ? null : "browser:b",
      side === "second" ? null : "browser:b",
      "right",
      mint,
    );
  it("round-trips, focuses and fills either placeholder without changing the real member", () => {
    const state = make();
    const pair = state.pairs![0]!;
    expect(state.focusedPaneId).toBe(pair[side].id);
    expect(state.selectedTabId).toBe("browser:b");
    expect(
      pairTabs(state, pair.first.activeTabId, pair.second.activeTabId, "right", minter()),
    ).toBe(state);
    expect(sanitizeSplitView(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(sanitizeSplitView({ pairs: [pair] })?.selectedTabId).toBe("browser:b");
    expect(resolveSplitView(state, ["browser:b"], "board").panes.map((p) => p.activeTabId)).toEqual(
      [pair.first.activeTabId, pair.second.activeTabId],
    );
    const owner = side === "first" ? pair.second : pair.first;
    const away = focusPane(state, owner.id);
    const back = focusPane(away, pair[side].id);
    expect(back.focusedPaneId).toBe(pair[side].id);
    expect(back.selectedTabId).toBe("browser:b");
    for (const filled of [
      activateTab(state, "chat:earned"),
      moveTabToPane(state, "chat:earned", pair[side].id),
      claimTabInPane(state, "chat:earned", pair[side].id, true),
    ]) {
      expect(filled.pairs![0]![side].activeTabId).toBe("chat:earned");
      expect(filled.pairs![0]![side === "first" ? "second" : "first"]).toBe(owner);
      expect(splitViewPanes(filled)).toHaveLength(2);
    }
    const hidden = activateTab(away, "ordinary");
    const claimed = claimTabInPane(hidden, "chat:earned", pair[side].id, true);
    expect(claimed.selectedTabId).toBe("ordinary");
    expect(claimed.focusedPaneId).toBe("root");
    expect(claimed.pairs![0]![side].activeTabId).toBe("chat:earned");
    expect(closePane(state, pair[side].id).selectedTabId).toBe("browser:b");
  });
  it("projects a local passenger only in its empty slot, preserves ordering and waits for the live anchor", () => {
    const state = make();
    const pair = state.pairs![0]!;
    const overlay = { ...state, root: { ...pair, [side]: pane(pair[side].id, ["chat:local"]) } };
    expect(
      projectSplitView(overlay, ["browser:b", "chat:local"], "chat:local", "board").panes.map(
        (p) => p.activeTabId,
      ),
    ).toEqual(side === "first" ? ["chat:local", "browser:b"] : ["browser:b", "chat:local"]);
    expect(
      projectSplitView(overlay, ["chat:local"], "chat:local", "board").panes.map(
        (p) => p.activeTabId,
      ),
    ).toEqual(["chat:local"]);
    expect(state.pairs![0]![side].activeTabId).toBeNull();
    const old = canary7ReadSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(old.root.kind).toBe("split");
    expect(
      resolveSplitView(old, ["board", "browser:b", "ordinary"], "board")
        .panes.flatMap((p) => p.tabIds)
        .toSorted(),
    ).toEqual(["board", "browser:b", "ordinary"]);
  });
});

it("keeps unrelated pending slots when pairing a new nullable member and rejects two empty members", () => {
  const mint = minter();
  const first = pairTabs(groupedSplitView([], "a"), null, "a", "right", mint);
  const second = pairTabs(first, "b", null, "right", mint);
  expect(second.pairs).toHaveLength(2);
  expect(second.pairs![0]).toBe(first.pairs![0]);
  expect(pairTabs(second, null, null, "right", mint)).toBe(second);
  expect(pairTabs(first, null, "a", "down", mint).pairs![0]!.direction).toBe("column");
});
