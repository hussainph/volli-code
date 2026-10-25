import { describe, expect, it } from "vite-plus/test";

import {
  activeTabInSplitView,
  claimTabInPane,
  closePane,
  emptySplitView,
  focusAdjacentPane,
  focusPane,
  groupedPanes,
  groupForTab,
  groupTabIds,
  groupTabs,
  moveTabToPane,
  openTab,
  paneForTab,
  projectSplitView,
  removeTab,
  renamedTabInSplitView,
  reorderPaneTabs,
  sanitizeSplitView,
  selectTab,
  setSplitRatio,
  splitEdgeDirection,
  splitEdgeLeads,
  splitPane,
  splitViewPanes,
  ungroup,
  ungroupTab,
  SPLIT_VIEW_MAX_DEPTH,
  SPLIT_VIEW_MAX_PANES,
  SPLIT_VIEW_MAX_RATIO,
  SPLIT_VIEW_MIN_RATIO,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewBranch,
  type SplitViewDirection,
  type SplitViewGroup,
  type SplitViewNode,
  type SplitViewPane,
  type SplitViewState,
} from "./split-view";

const ROOT = SPLIT_VIEW_ROOT_PANE_ID;

/** A pane; its front tab defaults to its first. */
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

/** Deterministic id minter: "m1", "m2", … in call order. */
function minter(): () => string {
  let minted = 0;
  return () => {
    minted += 1;
    return `m${minted}`;
  };
}

/** g1 = [a b] | [c], side by side; g2 = [d] over [e]. */
function groups(): SplitViewGroup[] {
  return [
    branch("g1", "row", pane("p1", ["a", "b"]), pane("p2", ["c"])),
    branch("g2", "column", pane("p3", ["d"]), pane("p4", ["e"])),
  ];
}

/** A balanced group of the most panes a group may have, its first pane shown. */
function widest(): SplitViewState {
  const quad = (id: string, tabs: readonly string[]): SplitViewBranch =>
    branch(
      id,
      "column",
      branch(`${id}r1`, "row", pane(`${tabs[0]}p`, [tabs[0]!]), pane(`${tabs[1]}p`, [tabs[1]!])),
      branch(`${id}r2`, "row", pane(`${tabs[2]}p`, [tabs[2]!]), pane(`${tabs[3]}p`, [tabs[3]!])),
    );
  const group = branch(
    "wide",
    "row",
    quad("left", ["A", "B", "C", "D"]),
    quad("right", ["E", "F", "G", "H"]),
  );
  return selectTab({ ...emptySplitView(null), pairs: [group] }, "A");
}

/** Both groups saved, ordinary `x` shown full width. */
function surface(): SplitViewState {
  return { ...emptySplitView("x"), pairs: groups() };
}

/** g1 on screen, its right pane (c) focused. */
function showingG1(): SplitViewState {
  return selectTab(surface(), "c");
}

const stacks = (node: SplitViewNode): readonly (readonly string[])[] =>
  splitViewPanes({ ...emptySplitView(null), root: node }).map((leaf) => leaf.tabIds);

const fronts = (node: SplitViewNode): readonly (string | null)[] =>
  splitViewPanes({ ...emptySplitView(null), root: node }).map((leaf) => leaf.activeTabId);

const paneIds = (state: SplitViewState): readonly string[] =>
  groupedPanes(state).map((leaf) => leaf.id);

/** The invariants every operation must leave behind. */
function expectInvariants(state: SplitViewState): void {
  const seenPanes = new Set<string>();
  const seenTabs = new Set<string>();
  for (const group of state.pairs) {
    const leaves = splitViewPanes({ ...state, root: group });
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    expect(leaves.some((leaf) => leaf.tabIds.length > 0)).toBe(true);
    for (const leaf of leaves) {
      expect(leaf.id).not.toBe(ROOT);
      expect(seenPanes.has(leaf.id)).toBe(false);
      seenPanes.add(leaf.id);
      if (leaf.tabIds.length > 0) expect(leaf.tabIds).toContain(leaf.activeTabId);
      else expect(leaf.activeTabId).toBeNull();
      for (const tab of leaf.tabIds) {
        expect(seenTabs.has(tab)).toBe(false);
        seenTabs.add(tab);
      }
    }
  }
  if (state.root.kind === "split") {
    expect(state.pairs).toContain(state.root);
    expect(splitViewPanes(state).map((leaf) => leaf.id)).toContain(state.focusedPaneId);
  } else {
    expect(state.root.id).toBe(ROOT);
    expect(state.focusedPaneId).toBe(ROOT);
    expect(state.root.activeTabId).toBe(state.selectedTabId);
  }
}

describe("edges", () => {
  it("names each edge's direction and whether its new pane leads", () => {
    expect(splitEdgeDirection("left")).toBe("row");
    expect(splitEdgeDirection("right")).toBe("row");
    expect(splitEdgeDirection("up")).toBe("column");
    expect(splitEdgeDirection("down")).toBe("column");
    expect(["left", "right", "up", "down"].map((edge) => splitEdgeLeads(edge as never))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});

describe("readers", () => {
  it("starts with no groups, selecting one tab full width", () => {
    expect(emptySplitView("a")).toEqual({
      pairs: [],
      selectedTabId: "a",
      root: pane(ROOT, ["a"]),
      focusedPaneId: ROOT,
    });
    expect(emptySplitView(null).root).toEqual(pane(ROOT, [], null));
  });

  it("answers membership regardless of what is shown", () => {
    const state = surface();
    expect(groupForTab(null, "a")).toBeNull();
    expect(groupForTab(state, "x")).toBeNull();
    expect(groupForTab(state, "b")?.id).toBe("g1");
    expect(groupForTab(state, "e")?.id).toBe("g2");
    expect(paneForTab(state, "b")).toBe("p1");
    expect(paneForTab(state, "x")).toBeNull();
    expect(groupTabIds(state.pairs[0]!)).toEqual(["a", "b", "c"]);
    expect(paneIds(state)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("reads the shown panes and the focused front", () => {
    expect(splitViewPanes(surface()).map((leaf) => leaf.id)).toEqual([ROOT]);
    expect(activeTabInSplitView(surface())).toBe("x");
    const shown = showingG1();
    expect(splitViewPanes(shown).map((leaf) => leaf.id)).toEqual(["p1", "p2"]);
    expect(activeTabInSplitView(shown)).toBe("c");
    expect(activeTabInSplitView({ ...shown, focusedPaneId: "nowhere" })).toBeNull();
  });
});

describe("selectTab", () => {
  it("shows an ordinary tab full width and keeps every group saved", () => {
    const before = showingG1();
    const state = selectTab(before, "y");
    expect(state.root).toEqual(pane(ROOT, ["y"]));
    expect(state.focusedPaneId).toBe(ROOT);
    expect(state.selectedTabId).toBe("y");
    expect(state.pairs).toBe(before.pairs);
    expectInvariants(state);
  });

  it("shows a group tab's whole group, focused on its pane", () => {
    const state = selectTab(surface(), "e");
    expect(state.root).toBe(state.pairs[1]);
    expect(state.focusedPaneId).toBe("p4");
    expect(state.selectedTabId).toBe("e");
    expectInvariants(state);
  });

  it("brings a stacked tab to the front of its pane, leaving other groups by identity", () => {
    const before = surface();
    const state = selectTab(before, "b");
    expect(fronts(state.root)).toEqual(["b", "c"]);
    expect(state.focusedPaneId).toBe("p1");
    expect(state.pairs[1]).toBe(before.pairs[1]);
    expectInvariants(state);
  });

  it("returns by identity when the tab is already what is shown", () => {
    const full = surface();
    expect(selectTab(full, "x")).toBe(full);
    const shown = showingG1();
    expect(selectTab(shown, "c")).toBe(shown);
  });

  it("restores a group's exact layout after an ordinary tab was shown", () => {
    const shown = setSplitRatio(selectTab(surface(), "b"), "g1", 0.3);
    const away = selectTab(shown, "x");
    expect(away.root.kind).toBe("pane");
    const back = selectTab(away, "c");
    expect(back.root).toBe(shown.root);
    expect((back.root as SplitViewBranch).ratio).toBe(0.3);
    expect(fronts(back.root)).toEqual(["b", "c"]);
    expect(back.focusedPaneId).toBe("p2");
  });
});

describe("openTab", () => {
  it("is a selection while no group is shown", () => {
    const state = openTab(surface(), "new");
    expect(state.root).toEqual(pane(ROOT, ["new"]));
    expect(groupForTab(state, "new")).toBeNull();
  });

  it("joins the focused pane's stack, in front, while a group is shown", () => {
    const before = showingG1();
    const state = openTab(before, "new");
    expect(stacks(state.root)).toEqual([
      ["a", "b"],
      ["c", "new"],
    ]);
    expect(fronts(state.root)).toEqual(["a", "new"]);
    expect(state.selectedTabId).toBe("new");
    expect(state.focusedPaneId).toBe("p2");
    expect(state.pairs[1]).toBe(before.pairs[1]);
    expectInvariants(state);
  });

  it("selects a tab some group already holds instead of moving it", () => {
    const state = openTab(showingG1(), "d");
    expect(state.root).toBe(state.pairs[1]);
    expect(stacks(state.pairs[0]!)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("claimTabInPane", () => {
  it("claims into a hidden group without changing what is shown", () => {
    const before = surface();
    const fronted = claimTabInPane(before, "draft", "p3", true);
    expect(stacks(fronted.pairs[1]!)).toEqual([["d", "draft"], ["e"]]);
    expect(fronts(fronted.pairs[1]!)).toEqual(["draft", "e"]);
    expect(fronted.root).toBe(before.root);
    expect(fronted.selectedTabId).toBe("x");
    const background = claimTabInPane(before, "draft", "p3", false);
    expect(fronts(background.pairs[1]!)).toEqual(["d", "e"]);
    expectInvariants(background);
  });

  it("fronts a claim into an empty pane, since a pane holding tabs has a front", () => {
    const state = splitPane(showingG1(), "p2", "right", {}, minter());
    const claimed = claimTabInPane(selectTab(state, "x"), "draft", "m1", false);
    expect(fronts(claimed.pairs[0]!)).toEqual(["a", "c", "draft"]);
  });

  it("selects a fronted claim in the shown group's focused pane only", () => {
    const shown = showingG1();
    const focused = claimTabInPane(shown, "draft", "p2", true);
    expect(focused.selectedTabId).toBe("draft");
    expect(focused.root).toBe(focused.pairs[0]);
    const elsewhere = claimTabInPane(shown, "draft", "p1", false);
    expect(elsewhere.selectedTabId).toBe("c");
    expect(stacks(elsewhere.root)).toEqual([["a", "b", "draft"], ["c"]]);
    expectInvariants(elsewhere);
  });

  it("returns by identity for a grouped tab, the full-width pane, or a missing pane", () => {
    const state = surface();
    expect(claimTabInPane(state, "a", "p3", true)).toBe(state);
    expect(claimTabInPane(state, "draft", ROOT, true)).toBe(state);
    expect(claimTabInPane(state, "draft", "nowhere", true)).toBe(state);
  });
});

describe("ungroupTab, removeTab and ungroup", () => {
  it("hands a stacked pane's front to its successor — next, else previous", () => {
    const front = ungroupTab(selectTab(surface(), "a"), "a");
    expect(stacks(front.root)).toEqual([["b"], ["c"]]);
    expect(front.selectedTabId).toBe("b");
    const stacked = claimTabInPane(surface(), "z", "p1", true);
    const last = ungroupTab(stacked, "z");
    expect(fronts(last.pairs[0]!)).toEqual(["b", "c"]);
    const background = ungroupTab(surface(), "b");
    expect(fronts(background.pairs[0]!)).toEqual(["a", "c"]);
    expectInvariants(last);
  });

  it("collapses the pane it emptied and moves focus into the space", () => {
    const three = splitPane(showingG1(), "p2", "right", { tabId: "y" }, minter());
    expect(three.focusedPaneId).toBe("m1");
    const state = ungroupTab(three, "y");
    expect(stacks(state.root)).toEqual([["a", "b"], ["c"]]);
    expect(state.focusedPaneId).toBe("p2");
    expect(state.selectedTabId).toBe("c");
    expectInvariants(state);
  });

  it("dissolves a group left with one pane, showing what was left full width", () => {
    const state = ungroupTab(showingG1(), "c");
    expect(groupForTab(state, "a")).toBeNull();
    expect(state.pairs.map((group) => group.id)).toEqual(["g2"]);
    expect(state.root).toEqual(pane(ROOT, ["a"]));
    expectInvariants(state);
  });

  it("changes nothing on screen for a hidden group", () => {
    const before = surface();
    const state = ungroupTab(before, "d");
    expect(state.pairs.map((group) => group.id)).toEqual(["g1"]);
    expect(state.root).toBe(before.root);
    expect(state.selectedTabId).toBe("x");
  });

  it("dissolves a group whose last tab left, even with an empty pane standing", () => {
    const menu = splitPane(emptySplitView("x"), ROOT, "right", {}, minter());
    expect(menu.pairs).toHaveLength(1);
    const state = removeTab(menu, "x");
    expect(state.pairs).toEqual([]);
    expect(state.root).toEqual(pane(ROOT, [], null));
    expect(state.selectedTabId).toBeNull();
  });

  it("dissolves a group of empty menus once its only tab leaves", () => {
    const mint = minter();
    const menus = splitPane(
      splitPane(emptySplitView("x"), ROOT, "right", {}, mint),
      "m1",
      "down",
      {},
      mint,
    );
    expect(splitViewPanes(menus)).toHaveLength(3);
    const state = ungroupTab(menus, "x");
    expect(state.pairs).toEqual([]);
    expect(state.root).toEqual(pane(ROOT, [], null));
  });

  it("treats a root no group answers to as nothing shown", () => {
    const legacyShaped: SplitViewState = {
      pairs: [],
      selectedTabId: null,
      root: branch("s", "row", pane("p1", ["a"]), pane("p2", ["b"])),
      focusedPaneId: "p1",
    };
    expect(openTab(legacyShaped, "n").root).toEqual(pane(ROOT, ["n"]));
  });

  it("removes a grouped tab by ungrouping, and deselects a full-width one", () => {
    expect(removeTab(showingG1(), "c")).toEqual(ungroupTab(showingG1(), "c"));
    const full = removeTab(surface(), "x");
    expect(full.root).toEqual(pane(ROOT, [], null));
    expect(full.selectedTabId).toBeNull();
    const before = surface();
    expect(removeTab(before, "y")).toBe(before);
    expect(ungroupTab(before, "x")).toBe(before);
  });

  it("dissolves a whole group, its tabs staying open", () => {
    const shown = selectTab(surface(), "b");
    const state = ungroup(shown, "g1");
    expect(state.pairs.map((group) => group.id)).toEqual(["g2"]);
    expect(state.root).toEqual(pane(ROOT, ["b"]));
    const hidden = surface();
    const quiet = ungroup(hidden, "g2");
    expect(quiet.root).toBe(hidden.root);
    expect(quiet.pairs).toHaveLength(1);
    expect(ungroup(hidden, "nope")).toBe(hidden);
  });
});

describe("closePane", () => {
  it("relinquishes its stack to the sibling, which takes the focus", () => {
    const three = splitPane(selectTab(surface(), "a"), "p1", "down", { tabId: "y" }, minter());
    const state = closePane(three, "m1");
    expect(stacks(state.root)).toEqual([["a", "b", "y"], ["c"]]);
    expect(fronts(state.root)).toEqual(["a", "c"]);
    expect(state.focusedPaneId).toBe("p1");
    expectInvariants(state);
  });

  it("hands its stack to the first pane of a sibling subtree", () => {
    const three = splitPane(showingG1(), "p2", "down", { tabId: "y" }, minter());
    const state = closePane(focusPane(three, "p2"), "p1");
    expect(stacks(state.root)).toEqual([["c", "a", "b"], ["y"]]);
    expect(state.focusedPaneId).toBe("p2");
  });

  it("gives an empty heir the closed pane's front", () => {
    const menu = splitPane(showingG1(), "p2", "left", {}, minter());
    const three = focusPane(menu, "p2");
    const state = closePane(three, "p2");
    expect(stacks(state.root)).toEqual([["a", "b"], ["c"]]);
    expect(fronts(state.root)).toEqual(["a", "c"]);
  });

  it("drops an empty pane, keeping focus where it was", () => {
    const menu = splitPane(showingG1(), "p2", "right", {}, minter());
    const state = closePane(focusPane(menu, "p1"), "m1");
    expect(stacks(state.root)).toEqual([["a", "b"], ["c"]]);
    expect(state.focusedPaneId).toBe("p1");
  });

  it("dissolves the group it leaves with one pane, showing that pane's front", () => {
    const state = closePane(showingG1(), "p2");
    expect(state.pairs.map((group) => group.id)).toEqual(["g2"]);
    expect(state.root).toEqual(pane(ROOT, ["a"]));
  });

  it("changes nothing on screen for a hidden group, and nothing at all for no pane", () => {
    const before = surface();
    const state = closePane(before, "p4");
    expect(state.root).toBe(before.root);
    expect(state.pairs).toHaveLength(1);
    expect(closePane(before, ROOT)).toBe(before);
  });
});

describe("moveTabToPane", () => {
  it("moves an ordinary tab into a pane's stack, in front and focused", () => {
    const state = moveTabToPane(showingG1(), "x", "p1");
    expect(stacks(state.root)).toEqual([["a", "b", "x"], ["c"]]);
    expect(state.focusedPaneId).toBe("p1");
    expect(state.selectedTabId).toBe("x");
    expectInvariants(state);
  });

  it("moves between panes of one group, collapsing the pane it emptied", () => {
    const three = splitPane(showingG1(), "p2", "right", { tabId: "y" }, minter());
    const state = moveTabToPane(three, "y", "p1");
    expect(stacks(state.root)).toEqual([["a", "b", "y"], ["c"]]);
    const stacked = moveTabToPane(showingG1(), "b", "p2");
    expect(stacks(stacked.root)).toEqual([["a"], ["c", "b"]]);
    expectInvariants(stacked);
  });

  it("dissolves a group whose other pane it emptied, showing the moved tab", () => {
    const state = moveTabToPane(showingG1(), "c", "p1");
    expect(groupForTab(state, "a")).toBeNull();
    expect(state.root).toEqual(pane(ROOT, ["c"]));
    expect(state.pairs.map((group) => group.id)).toEqual(["g2"]);
  });

  it("takes a tab out of another group, dissolving what that left", () => {
    const state = moveTabToPane(showingG1(), "e", "p2");
    expect(state.pairs.map((group) => group.id)).toEqual(["g1"]);
    expect(stacks(state.root)).toEqual([
      ["a", "b"],
      ["c", "e"],
    ]);
    expectInvariants(state);
  });

  it("selects a tab already in that pane, and ignores a pane no group has", () => {
    const state = moveTabToPane(surface(), "b", "p1");
    expect(state.root).toBe(state.pairs[0]);
    expect(fronts(state.root)).toEqual(["b", "c"]);
    const before = surface();
    expect(moveTabToPane(before, "x", ROOT)).toBe(before);
  });
});

describe("reorderPaneTabs", () => {
  it("rewrites the stack from what the strip drew, keeping undrawn members", () => {
    const stacked = claimTabInPane(showingG1(), "z", "p1", false);
    const state = reorderPaneTabs(stacked, "p1", ["b", "a", "b", "elsewhere"]);
    expect(stacks(state.root)).toEqual([["b", "a", "z"], ["c"]]);
    expect(fronts(state.root)).toEqual(["a", "c"]);
    expect(state.root).toBe(state.pairs[0]);
  });

  it("leaves what is shown alone for a hidden group", () => {
    const before = surface();
    const state = reorderPaneTabs(before, "p1", ["b", "a"]);
    expect(state.root).toBe(before.root);
    expect(stacks(state.pairs[0]!)).toEqual([["b", "a"], ["c"]]);
  });

  it("returns by identity for an unchanged order and an unknown pane", () => {
    const before = surface();
    expect(reorderPaneTabs(before, "p1", ["a", "b"])).toBe(before);
    expect(reorderPaneTabs(before, "nowhere", ["a"])).toBe(before);
  });
});

describe("splitPane", () => {
  it("makes a new group of two from a full-width tab, focused on the new pane", () => {
    const state = splitPane(surface(), ROOT, "right", { tabId: "y" }, minter());
    const made = state.pairs[2]!;
    expect(made).toMatchObject({ id: "m2", direction: "row", ratio: 0.5 });
    expect(stacks(made)).toEqual([["x"], ["y"]]);
    expect(paneIds(state).slice(-2)).toEqual(["m3", "m1"]);
    expect(state.root).toBe(made);
    expect(state.focusedPaneId).toBe("m1");
    expect(state.selectedTabId).toBe("y");
    expectInvariants(state);
  });

  it("opens an empty menu pane for ⌘\\, the full-width tab staying selected", () => {
    const state = splitPane(emptySplitView("x"), ROOT, "down", {}, minter());
    expect(stacks(state.root)).toEqual([["x"], []]);
    expect((state.root as SplitViewBranch).direction).toBe("column");
    expect(state.focusedPaneId).toBe("m1");
    expect(state.selectedTabId).toBe("x");
    expect(activeTabInSplitView(state)).toBeNull();
    expectInvariants(state);
  });

  it("puts a left or top edge's new pane FIRST (VC-614)", () => {
    const left = splitPane(emptySplitView("x"), ROOT, "left", { tabId: "y" }, minter());
    expect(stacks(left.root)).toEqual([["y"], ["x"]]);
    expect(left.focusedPaneId).toBe("m1");
    const up = splitPane(showingG1(), "p2", "up", { tabId: "y" }, minter());
    expect(stacks(up.root)).toEqual([["a", "b"], ["y"], ["c"]]);
    expect(((up.root as SplitViewBranch).second as SplitViewBranch).direction).toBe("column");
  });

  it("takes the dragged tab out of the group it was in", () => {
    const state = splitPane(surface(), ROOT, "right", { tabId: "d" }, minter());
    expect(state.pairs.map((group) => group.id)).toEqual(["g1", "m2"]);
    expect(groupForTab(state, "e")).toBeNull();
    expectInvariants(state);
  });

  it("refuses a full-width split with nothing to split, or the tab beside itself", () => {
    const empty = emptySplitView(null);
    expect(splitPane(empty, ROOT, "right", { tabId: "y" }, minter())).toBe(empty);
    const full = surface();
    expect(splitPane(full, ROOT, "right", { tabId: "x" }, minter())).toBe(full);
    const shown = showingG1();
    expect(splitPane(shown, ROOT, "right", {}, minter())).toBe(shown);
  });

  it("adds a pane to a shown group, splitting a stack", () => {
    const state = splitPane(selectTab(surface(), "a"), "p1", "right", { tabId: "a" }, minter());
    expect(stacks(state.root)).toEqual([["b"], ["a"], ["c"]]);
    expect(state.focusedPaneId).toBe("m1");
    expect(state.selectedTabId).toBe("a");
    expectInvariants(state);
  });

  it("re-lays a group out when its own other pane's only tab moves", () => {
    const three = splitPane(showingG1(), "p2", "right", { tabId: "y" }, minter());
    const state = splitPane(three, "p1", "down", { tabId: "y" }, minter());
    expect(stacks(state.root)).toEqual([["a", "b"], ["y"], ["c"]]);
    expectInvariants(state);
  });

  it("opens an empty pane inside a group for ⌘\\, keeping the selection", () => {
    const state = splitPane(showingG1(), "p2", "right", {}, minter());
    expect(stacks(state.root)).toEqual([["a", "b"], ["c"], []]);
    expect(state.selectedTabId).toBe("c");
    expect(state.focusedPaneId).toBe("m1");
  });

  it("takes a tab out of another group into this one", () => {
    const state = splitPane(showingG1(), "p2", "right", { tabId: "e" }, minter());
    expect(state.pairs.map((group) => group.id)).toEqual(["g1"]);
    expect(stacks(state.root)).toEqual([["a", "b"], ["c"], ["e"]]);
  });

  it("refuses a pane's only tab on its own edge, an unknown pane, and an oversized group", () => {
    const shown = showingG1();
    expect(splitPane(shown, "p2", "right", { tabId: "c" }, minter())).toBe(shown);
    expect(splitPane(shown, "nowhere", "right", {}, minter())).toBe(shown);
    const wide = widest();
    expect(splitViewPanes(wide)).toHaveLength(SPLIT_VIEW_MAX_PANES);
    expect(splitPane(wide, wide.focusedPaneId, "down", {}, minter())).toBe(wide);
  });

  it("refuses a split deeper than a person could have arranged", () => {
    const mint = minter();
    let deep: SplitViewState = splitPane(emptySplitView("x"), ROOT, "right", {}, mint);
    for (let depth = 2; depth < SPLIT_VIEW_MAX_DEPTH; depth += 1) {
      deep = splitPane(deep, deep.focusedPaneId, depth % 2 === 0 ? "down" : "right", {}, mint);
    }
    expect(splitViewPanes(deep).length).toBeLessThan(SPLIT_VIEW_MAX_PANES);
    expect(splitPane(deep, deep.focusedPaneId, "right", {}, minter())).toBe(deep);
  });
});

describe("groupTabs", () => {
  it("makes a new group beside an ordinary target", () => {
    const state = groupTabs(surface(), "x", "y", "left", minter());
    expect(stacks(state.root)).toEqual([["y"], ["x"]]);
    expect(state.selectedTabId).toBe("y");
  });

  it("splits a grouped target's pane, growing its group", () => {
    const state = groupTabs(surface(), "e", "x", "right", minter());
    expect(state.root.id).toBe("g2");
    expect(stacks(state.root)).toEqual([["d"], ["e"], ["x"]]);
    expectInvariants(state);
  });

  it("opens an empty pane beside the target for a null tab", () => {
    const state = groupTabs(surface(), "x", null, "right", minter());
    expect(stacks(state.root)).toEqual([["x"], []]);
  });

  it("selects a tab already in the target's group, and refuses the impossible", () => {
    const before = surface();
    expect(groupTabs(before, "a", "c", "right", minter()).root.id).toBe("g1");
    expect(groupTabs(before, "x", "x", "right", minter())).toBe(before);
    expect(groupTabs(before, "c", "c", "right", minter())).toBe(before);
  });

  it("returns its input when the split is refused", () => {
    const away = selectTab(widest(), "x");
    expect(groupTabs(away, "A", "y", "right", minter())).toBe(away);
  });
});

describe("focusPane", () => {
  it("shows a hidden group, selecting the focused pane's front", () => {
    const state = focusPane(surface(), "p3");
    expect(state.root.id).toBe("g2");
    expect(state.selectedTabId).toBe("d");
  });

  it("keeps a group tab selected while an empty pane holds the focus", () => {
    const menu = splitPane(showingG1(), "p2", "right", {}, minter());
    const away = focusPane(menu, "p1");
    const back = focusPane(away, "m1");
    expect(back.selectedTabId).toBe("a");
    expect(activeTabInSplitView(back)).toBeNull();
    const hidden = selectTab(back, "x");
    expect(focusPane(hidden, "m1").selectedTabId).toBe("a");
  });

  it("returns by identity for the focused pane, the full-width pane and a missing one", () => {
    const shown = showingG1();
    expect(focusPane(shown, "p2")).toBe(shown);
    const full = surface();
    expect(focusPane(full, ROOT)).toBe(full);
    expect(focusPane(full, "nowhere")).toBe(full);
  });
});

describe("focusAdjacentPane", () => {
  // [ L | [ T / B ] ] — the right column split horizontally.
  const geometry = (): SplitViewState =>
    selectTab(
      {
        ...emptySplitView(null),
        pairs: [
          branch(
            "s1",
            "row",
            pane("L", ["l"]),
            branch("s2", "column", pane("T", ["t"]), pane("B", ["b"])),
          ),
        ],
      },
      "l",
    );

  it("walks by geometry in each direction", () => {
    const fromL = geometry();
    expect(focusAdjacentPane(fromL, "right").focusedPaneId).toBe("T");
    const fromT = focusPane(fromL, "T");
    expect(focusAdjacentPane(fromT, "down").focusedPaneId).toBe("B");
    expect(focusAdjacentPane(fromT, "left").focusedPaneId).toBe("L");
    expect(focusAdjacentPane(fromT, "right")).toBe(fromT);
    expect(focusAdjacentPane(focusPane(fromL, "B"), "up").focusedPaneId).toBe("T");
  });

  it("prefers the neighbour that overlaps the edge it is leaving", () => {
    const fromB = focusPane(geometry(), "B");
    expect(focusAdjacentPane(fromB, "left").focusedPaneId).toBe("L");
    const leftTall = selectTab(
      {
        ...emptySplitView(null),
        pairs: [
          branch(
            "s1",
            "row",
            branch("s2", "column", pane("A", ["a"]), pane("C", ["c"]), 0.2),
            pane("R", ["r"]),
          ),
        ],
      },
      "r",
    );
    expect(focusAdjacentPane(leftTall, "left").focusedPaneId).toBe("C");
  });

  it("ranks a neighbour that misses the edge by how far it misses", () => {
    const state = selectTab(
      {
        ...emptySplitView(null),
        pairs: [
          branch(
            "s1",
            "row",
            branch("s2", "column", pane("A", ["a"]), pane("C", ["c"]), 0.2),
            branch("s3", "column", pane("T", ["t"]), pane("B", ["b"]), 0.8),
          ),
        ],
      },
      "a",
    );
    expect(focusAdjacentPane(state, "right").focusedPaneId).toBe("T");
    expect(focusAdjacentPane(focusPane(state, "B"), "left").focusedPaneId).toBe("C");
  });

  it("breaks a tie on how far the centres are apart", () => {
    const state = selectTab(
      {
        ...emptySplitView(null),
        pairs: [
          branch(
            "s1",
            "column",
            branch("s2", "row", pane("A", ["a"]), pane("B", ["b"])),
            branch("s3", "row", pane("C", ["c"]), pane("D", ["d"]), 0.4),
          ),
        ],
      },
      "a",
    );
    expect(focusAdjacentPane(state, "down").focusedPaneId).toBe("C");
    expect(focusAdjacentPane(focusPane(state, "B"), "down").focusedPaneId).toBe("D");
  });

  it("stays put at an outer edge, full width, and with a dangling focus", () => {
    const fromL = geometry();
    expect(focusAdjacentPane(fromL, "left")).toBe(fromL);
    expect(focusAdjacentPane(fromL, "up")).toBe(fromL);
    const full = surface();
    expect(focusAdjacentPane(full, "right")).toBe(full);
    const dangling = { ...fromL, focusedPaneId: "nowhere" };
    expect(focusAdjacentPane(dangling, "right")).toBe(dangling);
  });
});

describe("setSplitRatio", () => {
  it("resizes a shown group, nested branches included, clamped", () => {
    const three = splitPane(showingG1(), "p2", "down", {}, minter());
    const state = setSplitRatio(three, "m2", 0.95);
    const nested = (state.root as SplitViewBranch).second as SplitViewBranch;
    expect(nested.ratio).toBe(SPLIT_VIEW_MAX_RATIO);
    expect((state.root as SplitViewBranch).first).toBe((three.root as SplitViewBranch).first);
    expect(state.root).toBe(state.pairs[0]);
    expect((setSplitRatio(state, "g1", -1).root as SplitViewBranch).ratio).toBe(
      SPLIT_VIEW_MIN_RATIO,
    );
  });

  it("resizes a hidden group without touching what is shown", () => {
    const before = surface();
    const state = setSplitRatio(before, "g2", 0.7);
    expect(state.root).toBe(before.root);
    expect(state.pairs[1]!.ratio).toBe(0.7);
    expect(state.pairs[0]).toBe(before.pairs[0]);
  });

  it("refuses a ratio that is not a number, and returns by identity for no change", () => {
    const before = surface();
    expect(setSplitRatio(before, "g1", Number.NaN)).toBe(before);
    expect(setSplitRatio(before, "g1", 0.5)).toBe(before);
    expect(setSplitRatio(before, "nowhere", 0.3)).toBe(before);
  });
});

describe("renamedTabInSplitView", () => {
  it("follows a group tab to its new id in place, selection and front included", () => {
    const state = renamedTabInSplitView(selectTab(surface(), "b"), "b", "b2");
    expect(stacks(state.root)).toEqual([["a", "b2"], ["c"]]);
    expect(fronts(state.root)).toEqual(["b2", "c"]);
    expect(state.selectedTabId).toBe("b2");
    const background = renamedTabInSplitView(showingG1(), "b", "b2");
    expect(background.selectedTabId).toBe("c");
    expect(fronts(background.root)).toEqual(["a", "c"]);
  });

  it("absorbs a stale tab already carrying the destination id", () => {
    const state = renamedTabInSplitView(showingG1(), "a", "e");
    expect(state.pairs.map((group) => group.id)).toEqual(["g1"]);
    expect(stacks(state.root)).toEqual([["e", "b"], ["c"]]);
    expectInvariants(state);
  });

  it("follows a full-width tab, and leaves an unrelated ordinary tab alone", () => {
    const state = renamedTabInSplitView(surface(), "x", "x2");
    expect(state.root).toEqual(pane(ROOT, ["x2"]));
    const before = surface();
    expect(renamedTabInSplitView(before, "y", "y2")).toBe(before);
    expect(renamedTabInSplitView(before, "a", "a")).toBe(before);
  });

  it("renames in a hidden group, selecting it when the stale selection carried the name", () => {
    const before = surface();
    const quiet = renamedTabInSplitView(before, "d", "d2");
    expect(quiet.root).toBe(before.root);
    expect(stacks(quiet.pairs[1]!)).toEqual([["d2"], ["e"]]);
    const stale = renamedTabInSplitView(before, "d", "x");
    expect(stale.root.id).toBe("g2");
    expect(stale.selectedTabId).toBe("x");
    expect(stacks(stale.root)).toEqual([["x"], ["e"]]);
  });
});

describe("sanitizeSplitView", () => {
  it("degrades anything that is not a split view to no groups", () => {
    for (const raw of [null, undefined, 3, "x", [], { pairs: "nope" }, { pairs: [] }]) {
      expect(sanitizeSplitView(raw)).toBeNull();
    }
    expect(sanitizeSplitView({ root: pane(ROOT, ["a"]) })).toBeNull();
    expect(sanitizeSplitView({ root: branch("s", "row", pane("p1"), pane("p2")) })).toBeNull();
  });

  it("converts a legacy split into ONE group, stacks kept and root renamed", () => {
    const legacy = {
      root: branch(
        "s1",
        "row",
        pane(ROOT, ["board", "a", "b"], "a"),
        branch("s2", "column", pane("p2", ["c"]), pane("p3")),
        0.4,
      ),
      focusedPaneId: ROOT,
    };
    const state = sanitizeSplitView(JSON.parse(JSON.stringify(legacy)))!;
    expect(state.pairs).toHaveLength(1);
    expect(stacks(state.root)).toEqual([["board", "a", "b"], ["c"], []]);
    expect(fronts(state.root)).toEqual(["a", "c", null]);
    expect(paneIds(state)).toEqual(["s1:root", "p2", "p3"]);
    expect(state.focusedPaneId).toBe("s1:root");
    expect(state.selectedTabId).toBe("a");
    expect((state.root as SplitViewBranch).ratio).toBe(0.4);
    expectInvariants(state);
    const elsewhere = sanitizeSplitView({ ...legacy, focusedPaneId: "p3" })!;
    expect(elsewhere.focusedPaneId).toBe("p3");
    expect(elsewhere.selectedTabId).toBe("a");
    const unfocused = sanitizeSplitView({ root: legacy.root })!;
    expect(unfocused.focusedPaneId).toBe("s1:root");
  });

  it("renames root around an id already taken", () => {
    const state = sanitizeSplitView({
      root: branch("s1", "row", pane(ROOT, ["a"]), pane("s1:root", ["b"])),
    })!;
    expect(paneIds(state)).toEqual(["s1:root'", "s1:root"]);
  });

  it("reads pairs an earlier build persisted as groups, as they stand", () => {
    const pairs = [
      branch("pair-1", "row", pane(ROOT, ["chat"]), pane("p2", ["browser"])),
      branch("pair-2", "column", pane(ROOT, ["a"]), pane("p4", ["b"])),
    ];
    const state = sanitizeSplitView({ pairs, selectedTabId: "browser", focusedPaneId: "p2" })!;
    expect(paneIds(state)).toEqual(["pair-1:root", "p2", "pair-2:root", "p4"]);
    expect(state.root.id).toBe("pair-1");
    expect(state.focusedPaneId).toBe("p2");
    expectInvariants(state);
  });

  it("drops malformed groups one at a time, never the rest", () => {
    const valid = branch("g1", "row", pane("p1", ["a"]), pane("p2", ["b"]));
    let deep: SplitViewNode = pane("deep", ["z"]);
    for (let level = 0; level < SPLIT_VIEW_MAX_DEPTH; level += 1) {
      deep = branch(`d${level}`, "row", deep, pane(`dp${level}`));
    }
    let wide: SplitViewNode = pane("w0", ["w"]);
    for (let index = 1; index <= SPLIT_VIEW_MAX_PANES; index += 1) {
      wide = branch(`ws${index}`, index % 2 === 0 ? "row" : "column", wide, pane(`w${index}`));
    }
    const invalid: unknown[] = [
      null,
      branch("strange", "row", { ...pane("t1"), tabIds: "nope" } as never, pane("t2")),
      pane("single", ["s"]),
      branch("noTabs", "row", pane("n1"), pane("n2")),
      { ...branch("bad", "row", pane("b1", ["q"]), pane("b2")), direction: "diagonal" },
      { ...branch("bad2", "row", pane("c1", ["q"]), pane("c2")), kind: "tree" },
      { ...branch("", "row", pane("e1", ["q"]), pane("e2")) },
      branch("missing", "row", pane("m1", ["q"]), null as unknown as SplitViewNode),
      branch("missing2", "row", null as unknown as SplitViewNode, pane("m2", ["q"])),
      branch("g1", "row", pane("dupe1", ["q"]), pane("dupe2")),
      deep,
      wide,
    ];
    const state = sanitizeSplitView({ pairs: [valid, ...invalid], selectedTabId: "a" })!;
    expect(state.pairs.map((group) => group.id)).toEqual(["g1"]);
    expect(state.root.id).toBe("g1");
  });

  it("keeps a tab in its first group only, and repairs fronts and ratios", () => {
    const state = sanitizeSplitView({
      pairs: [
        {
          ...branch("g1", "row", pane("p1", ["a", "a", 3, ""] as never, "gone"), pane("p2")),
          ratio: 9,
        },
        { ...branch("g2", "row", pane("p3", ["a", "b"], null), pane("p4", ["c"])), ratio: "x" },
      ],
      selectedTabId: 7,
    })!;
    expect(stacks(state.pairs[0]!)).toEqual([["a"], []]);
    expect(fronts(state.pairs[0]!)).toEqual(["a", null]);
    expect(state.pairs[0]!.ratio).toBe(SPLIT_VIEW_MAX_RATIO);
    expect(stacks(state.pairs[1]!)).toEqual([["b"], ["c"]]);
    expect(fronts(state.pairs[1]!)).toEqual(["b", "c"]);
    expect(state.pairs[1]!.ratio).toBe(0.5);
    expect(state.root).toEqual(pane(ROOT, [], null));
    expect(state.selectedTabId).toBeNull();
  });

  it("restores what was shown: a group with its focus, or a full-width tab", () => {
    const pairs = groups();
    const menu = sanitizeSplitView({
      pairs: [branch("g", "row", pane("q1", ["k"]), pane("q2")), ...pairs],
      selectedTabId: "k",
      focusedPaneId: "q2",
    })!;
    expect(menu.focusedPaneId).toBe("q2");
    expect(menu.selectedTabId).toBe("k");
    const byFocus = sanitizeSplitView({ pairs, selectedTabId: null, focusedPaneId: "p4" })!;
    expect(byFocus.root.id).toBe("g2");
    const full = sanitizeSplitView({ pairs, selectedTabId: "x", focusedPaneId: "p4" })!;
    expect(full.root).toEqual(pane(ROOT, ["x"]));
    const bySelection = sanitizeSplitView({ pairs, selectedTabId: "b", focusedPaneId: ROOT })!;
    expect(bySelection.root.id).toBe("g1");
    expect(fronts(bySelection.root)).toEqual(["b", "c"]);
  });

  it("is stable under a second pass and cannot be tricked by hostile keys", () => {
    const state = splitPane(openTab(showingG1(), "n"), "p1", "down", {}, minter());
    const once = sanitizeSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(once).toEqual(state);
    expect(sanitizeSplitView(JSON.parse(JSON.stringify(once)))).toEqual(once);
    const hostile = JSON.parse(
      '{"pairs":[{"kind":"split","id":"__proto__","direction":"row","ratio":0.5,' +
        '"first":{"kind":"pane","id":"constructor","tabIds":["a"],"activeTabId":"a"},' +
        '"second":{"kind":"pane","id":"toString","tabIds":[],"activeTabId":null}}],' +
        '"selectedTabId":"a","focusedPaneId":"constructor"}',
    );
    const read = sanitizeSplitView(hostile)!;
    expect(read.root.id).toBe("__proto__");
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });
});

describe("projectSplitView", () => {
  it("draws the selected tab full width, or the permanent tab when it is not live", () => {
    const view = projectSplitView(null, ["board", "x"], "x", "board");
    expect(view).toEqual({
      root: { kind: "pane", id: ROOT, tabIds: ["x"], activeTabId: "x", index: 0 },
      panes: [{ kind: "pane", id: ROOT, tabIds: ["x"], activeTabId: "x", index: 0 }],
      focusedPaneId: ROOT,
      activeTabId: "x",
      groupId: null,
    });
    expect(projectSplitView(null, ["board"], "gone", "board").activeTabId).toBe("board");
  });

  it("resolves a shown group onto live tabs, numbering panes in reading order", () => {
    const state = splitPane(openTab(showingG1(), "dead"), "p1", "down", {}, minter());
    const view = projectSplitView(state, ["a", "b", "c", "x"], "c", "board");
    expect(view.groupId).toBe("g1");
    expect(view.panes.map((leaf) => [leaf.id, leaf.tabIds, leaf.activeTabId, leaf.index])).toEqual([
      ["p1", ["a", "b"], "a", 0],
      ["m1", [], null, 1],
      ["p2", ["c"], "c", 2],
    ]);
    expect(view.focusedPaneId).toBe("p2");
    expect(view.activeTabId).toBe("c");
    expect(view.root).toMatchObject({
      kind: "split",
      id: "g1",
      direction: "row",
      first: { kind: "split", id: "m2", direction: "column" },
    });
  });

  it("shows what selecting the surface's own active tab would, without writing", () => {
    const state = surface();
    const view = projectSplitView(state, ["a", "b", "c", "d", "e", "x"], "b", "board");
    expect(view.groupId).toBe("g1");
    expect(view.panes[0]!.activeTabId).toBe("b");
    expect(state.root).toEqual(pane(ROOT, ["x"]));
    expect(projectSplitView(state, ["x", "y"], "y", "board").activeTabId).toBe("y");
  });

  it("degrades a group with no live tab to the permanent tab", () => {
    const view = projectSplitView(showingG1(), ["board"], "c", "board");
    expect(view.groupId).toBeNull();
    expect(view.activeTabId).toBe("board");
  });
});

describe("invariants under a long session", () => {
  it("never names a group pane root, never duplicates a tab, never closes one", () => {
    const mint = minter();
    let state = emptySplitView("board");
    const steps: ((current: SplitViewState) => SplitViewState)[] = [
      (current) => splitPane(current, ROOT, "right", { tabId: "chat" }, mint),
      (current) => openTab(current, "terminal"),
      (current) => splitPane(current, current.focusedPaneId, "down", { tabId: "browser" }, mint),
      (current) => moveTabToPane(current, "board", current.focusedPaneId),
      (current) => selectTab(current, "file"),
      (current) => splitPane(current, ROOT, "left", { tabId: "chat" }, mint),
      (current) => selectTab(current, "terminal"),
      (current) => closePane(current, current.focusedPaneId),
      (current) => groupTabs(current, "board", "file", "up", mint),
      (current) => ungroupTab(current, "browser"),
    ];
    const open = new Set(["board", "chat", "terminal", "browser", "file"]);
    for (const step of steps) {
      state = step(state);
      expectInvariants(state);
      const grouped = state.pairs.flatMap((group) => groupTabIds(group));
      for (const tab of grouped) expect(open.has(tab)).toBe(true);
    }
  });
});

// Frozen pre-group persisted-state codec, copied from the last shipping
// release. Keep this independent of the sanitizer above: an older reader must
// ignore `pairs`, read `root` as a legacy split, recover every live tab from
// the strip, and never crash.
function canary7CollectPanes(node: SplitViewNode, out: SplitViewPane[]): void {
  if (node.kind === "pane") {
    out.push(node);
    return;
  }
  canary7CollectPanes(node.first, out);
  canary7CollectPanes(node.second, out);
}

interface Canary7State {
  root: SplitViewNode;
  focusedPaneId: string;
}

function canary7ReadSplitView(raw: unknown): Canary7State | null {
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

/** The old resolve: unclaimed live tabs join the primary pane, permanent first. */
function canary7Resolve(
  state: Canary7State,
  orderedTabIds: readonly string[],
  permanentTabId: string,
): readonly (readonly string[])[] {
  const live = new Set(orderedTabIds);
  const claimed = new Set<string>([permanentTabId]);
  const panes: SplitViewPane[] = [];
  canary7CollectPanes(state.root, panes);
  const kept = panes.map((leaf) => {
    const ids = leaf.tabIds.filter((id) => live.has(id) && !claimed.has(id));
    for (const id of ids) claimed.add(id);
    return ids;
  });
  const unclaimed = orderedTabIds.filter((id) => !claimed.has(id));
  return [[permanentTabId, ...kept[0]!, ...unclaimed], ...kept.slice(1)];
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
  it("an older build reads the shown group as its split and recovers every live tab", () => {
    const mint = minter();
    let state = splitPane(emptySplitView("a"), ROOT, "right", { tabId: "b" }, mint);
    state = openTab(state, "stacked");
    state = splitPane(selectTab(state, "c"), ROOT, "down", { tabId: "board" }, mint);
    state = selectTab(state, "a");
    const readByOldBuild = canary7ReadSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(readByOldBuild.root.kind).toBe("split");
    expect(readByOldBuild.focusedPaneId).toBe(state.focusedPaneId);
    const drawn = canary7Resolve(readByOldBuild, ["board", "a", "b", "c", "stacked", "x"], "board");
    expect(drawn.flat().toSorted()).toEqual(["a", "b", "board", "c", "stacked", "x"]);
  });

  it("an older build reads a full-width selection as no split, losing no tab", () => {
    const state = selectTab(
      splitPane(emptySplitView("a"), ROOT, "right", { tabId: "b" }, minter()),
      "ordinary",
    );
    expect(canary7ReadSplitView(JSON.parse(JSON.stringify(state)))).toBeNull();
    const restored = sanitizeSplitView(JSON.parse(JSON.stringify(state)))!;
    expect(groupForTab(restored, "a")).not.toBeNull();
    expect(restored.selectedTabId).toBe("ordinary");
  });
});
