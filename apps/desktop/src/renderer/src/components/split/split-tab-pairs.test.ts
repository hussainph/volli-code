import { describe, expect, it } from "vite-plus/test";
import {
  activateTab,
  groupedSplitView,
  pairTabs,
  projectSplitView,
  type SplitViewBranch,
} from "@volli/shared";
import { groupedTabIds, stripTabPairs } from "./split-tab-pairs";

const ids = ["board", "a", "b", "draft", "c", "d"];
let n = 0;
const mint = () => `n${++n}`;

describe("stripTabPairs", () => {
  it("retains complete dormant pairs and never creates a chip for an empty menu", () => {
    let state = pairTabs(groupedSplitView([], "a"), "a", "b", "right", mint);
    state = pairTabs(state, "c", null, "right", mint);
    expect(stripTabPairs(state, projectSplitView(state, ids, "c", "board"))).toEqual([
      { id: state.pairs![0]!.id, tabIds: ["a", "b"] },
    ]);
    state = activateTab(state, "b");
    expect(stripTabPairs(state, projectSplitView(state, ids, "b", "board"))).toHaveLength(1);
  });
  it("joins a pending pair's local Draft without adding it to durable membership", () => {
    const state = pairTabs(groupedSplitView([], "a"), "a", null, "right", mint);
    const root = state.root as SplitViewBranch;
    const overlay = {
      ...state,
      root: {
        ...root,
        second: {
          kind: "pane" as const,
          id: state.pairs![0]!.second.id,
          tabIds: ["draft"],
          activeTabId: "draft",
        },
      },
    };
    const view = projectSplitView(overlay, ids, "draft", "board");
    expect(stripTabPairs(state, view)).toEqual([{ id: root.id, tabIds: ["a", "draft"] }]);
    expect(state.pairs![0]!.second.activeTabId).toBeNull();
  });
});

it("uses the displayed chip order for drag-out of formerly non-adjacent members", () => {
  expect(groupedTabIds(["board", "a", "b", "c"], [{ id: "pair", tabIds: ["a", "c"] }])).toEqual([
    "board",
    "a",
    "c",
    "b",
  ]);
});
