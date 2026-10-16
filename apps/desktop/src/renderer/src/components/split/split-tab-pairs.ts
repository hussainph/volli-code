import type { ResolvedSplitView, SplitViewState } from "@volli/shared";
import { groupTabItems, type TabPair } from "./grouped-tab-chip";

/** Drag arithmetic follows the strip's visual group order, not the dormant arrangement. */
export function groupedTabIds(
  ids: readonly string[],
  pairs: readonly TabPair[],
): readonly string[] {
  return groupTabItems(
    ids.map((id) => ({ id })),
    pairs,
  ).flatMap((group) => group.tabs.map((tab) => tab.id));
}

/** Strip membership includes a renderer-local Draft filling the selected pair's empty slot. */
export function stripTabPairs(
  state: SplitViewState | null,
  view: ResolvedSplitView,
): readonly TabPair[] {
  const pairs: TabPair[] = (state?.pairs ?? []).flatMap((pair) => {
    const first = pair.first.activeTabId;
    const second = pair.second.activeTabId;
    return first === null || second === null
      ? []
      : [{ id: pair.id, tabIds: [first, second] as const }];
  });
  const { root } = view;
  if (root.kind === "split" && root.first.kind === "pane" && root.second.kind === "pane") {
    const first = root.first.activeTabId;
    const second = root.second.activeTabId;
    if (first !== null && second !== null) {
      const current = { id: root.id, tabIds: [first, second] as const };
      const index = pairs.findIndex((pair) => pair.id === root.id);
      if (index === -1) pairs.push(current);
      else pairs[index] = current;
    }
  }
  return pairs;
}
