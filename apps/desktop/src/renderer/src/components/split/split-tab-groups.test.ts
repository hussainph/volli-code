import { describe, expect, it } from "vite-plus/test";
import {
  emptySplitView,
  openTab,
  projectSplitView,
  selectTab,
  splitPane,
  SPLIT_VIEW_ROOT_PANE_ID,
} from "@volli/shared";
import {
  groupedTabIds,
  stripTabGroups,
  surfaceOrderAfterReorder,
  topStripTabIds,
} from "./split-tab-groups";

const live = ["board", "a", "b", "c", "d", "draft"];

function minter(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

/** [a] | [b c] with c in front, and a hidden second group [d] | ⌘\'s empty menu. */
function surface() {
  const mint = minter();
  let state = splitPane(
    emptySplitView("a"),
    SPLIT_VIEW_ROOT_PANE_ID,
    "right",
    { tabId: "b" },
    mint,
  );
  state = openTab(state, "c");
  state = splitPane(selectTab(state, "d"), SPLIT_VIEW_ROOT_PANE_ID, "right", {}, mint);
  return selectTab(state, "board");
}

describe("stripTabGroups", () => {
  it("draws every group, panes in reading order, stacks cut to live tabs", () => {
    const state = surface();
    const view = projectSplitView(
      state,
      live.filter((id) => id !== "b"),
      "board",
      "board",
    );
    expect(
      stripTabGroups(
        state,
        view,
        live.filter((id) => id !== "b"),
      ),
    ).toEqual([
      {
        id: "n2",
        panes: [
          { paneId: "n3", tabIds: ["a"], activeTabId: "a" },
          { paneId: "n1", tabIds: ["c"], activeTabId: "c" },
        ],
      },
      {
        id: "n5",
        panes: [
          { paneId: "n6", tabIds: ["d"], activeTabId: "d" },
          { paneId: "n4", tabIds: [], activeTabId: null },
        ],
      },
    ]);
  });

  it("falls back to a pane's first live tab when its front is not live", () => {
    const state = surface();
    const ids = ["board", "a", "b", "d"];
    const groups = stripTabGroups(state, projectSplitView(state, ids, "board", "board"), ids);
    expect(groups[0]!.panes[1]).toEqual({ paneId: "n1", tabIds: ["b"], activeTabId: "b" });
  });

  it("reads the group on screen off the view, Draft overlays included", () => {
    const state = surface();
    const overlaid = openTab(selectTab(state, "a"), "draft");
    const view = projectSplitView(overlaid, live, "draft", "board");
    expect(stripTabGroups(overlaid, view, live)[0]!.panes[0]).toEqual({
      paneId: "n3",
      tabIds: ["a", "draft"],
      activeTabId: "draft",
    });
  });

  it("draws no chip for a group with nothing live, and nothing at all without groups", () => {
    const state = surface();
    const ids = ["board", "d"];
    expect(stripTabGroups(state, projectSplitView(state, ids, "board", "board"), ids)).toEqual([
      expect.objectContaining({ id: "n5" }),
    ]);
    expect(stripTabGroups(null, projectSplitView(null, ids, "board", "board"), ids)).toEqual([]);
  });
});

describe("the top strip's order", () => {
  const groups = [
    {
      id: "g",
      panes: [
        { paneId: "p1", tabIds: ["a"], activeTabId: "a" },
        { paneId: "p2", tabIds: ["c", "e"], activeTabId: "c" },
      ],
    },
  ];

  it("draws a group's tabs together, where its earliest tab sits", () => {
    expect(groupedTabIds(["board", "b", "a", "d", "c", "e"], groups)).toEqual([
      "board",
      "b",
      "a",
      "c",
      "e",
      "d",
    ]);
  });

  it("drags only the ordinary tabs", () => {
    expect(topStripTabIds(["board", "b", "a", "d", "c"], groups)).toEqual(["board", "b", "d"]);
  });

  it("keeps a chip's slots, and the fixed tab, while ordinary tabs move round them", () => {
    expect(
      surfaceOrderAfterReorder(["board", "b", "a", "c", "e", "d"], ["b", "d"], ["d", "b"]),
    ).toEqual(["board", "d", "a", "c", "e", "b"]);
  });
});
