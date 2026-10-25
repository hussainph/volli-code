/**
 * The top strip's view of a surface's TAB GROUPS (VC-614): which chips it
 * draws, in what order, and what a drag across them writes.
 *
 * Pure and generic over ids, because Home and a Ticket view draw different
 * descriptors and the arithmetic is the same for both.
 */
import type {
  ResolvedSplitView,
  SplitViewGroup,
  SplitViewNode,
  SplitViewPane,
  SplitViewState,
} from "@volli/shared";

import type { TabGroup } from "./grouped-tab-chip";

function panesOf(node: SplitViewNode): SplitViewPane[] {
  return node.kind === "pane" ? [node] : [...panesOf(node.first), ...panesOf(node.second)];
}

/**
 * Every group the top strip draws a chip for, panes in reading order, each
 * pane's stack cut to the tabs that are live and its front resolved onto them.
 *
 * `state` is the split view as the surface renders it — with any empty Chat
 * Draft overlaid, so a Draft in front of a pane is that pane's segment — and
 * the group on screen is read off `view`, which may show a front the stored
 * state does not (a re-projected selection). A group with no live tab draws no
 * chip.
 */
export function stripTabGroups(
  state: SplitViewState | null,
  view: ResolvedSplitView,
  liveIds: readonly string[],
): readonly TabGroup[] {
  if (state === null) return [];
  const live = new Set(liveIds);
  return state.pairs.flatMap((group: SplitViewGroup): TabGroup[] => {
    if (group.id === view.groupId) {
      return [
        {
          id: group.id,
          panes: view.panes.map((pane) => ({
            paneId: pane.id,
            tabIds: pane.tabIds,
            activeTabId: pane.activeTabId,
          })),
        },
      ];
    }
    const panes = panesOf(group).map((pane) => {
      const tabIds = pane.tabIds.filter((id) => live.has(id));
      const front =
        pane.activeTabId !== null && live.has(pane.activeTabId)
          ? pane.activeTabId
          : (tabIds[0] ?? null);
      return { paneId: pane.id, tabIds, activeTabId: front };
    });
    return panes.some((pane) => pane.tabIds.length > 0) ? [{ id: group.id, panes }] : [];
  });
}

/** Whether `id` sits in one of the strip's groups. */
function grouped(groups: readonly TabGroup[], id: string): boolean {
  return groups.some((group) => group.panes.some((pane) => pane.tabIds.includes(id)));
}

/**
 * The top strip's drawn order: an ordinary tab where it is, and each group's
 * tabs together where the earliest of them sits — which is where its chip is.
 */
export function groupedTabIds(
  ids: readonly string[],
  groups: readonly TabGroup[],
): readonly string[] {
  const placed = new Set<string>();
  return ids.flatMap((id) => {
    if (placed.has(id)) return [];
    const group = groups.find((candidate) =>
      candidate.panes.some((pane) => pane.tabIds.includes(id)),
    );
    if (group === undefined) return [id];
    const members = group.panes.flatMap((pane) => pane.tabIds);
    for (const member of members) placed.add(member);
    return members;
  });
}

/** The tabs the top strip drags: its ordinary ones — a chip is not a sortable. */
export function topStripTabIds(
  ids: readonly string[],
  groups: readonly TabGroup[],
): readonly string[] {
  return ids.filter((id) => !grouped(groups, id));
}

/**
 * The surface's whole arrangement after the top strip's draggable tabs were
 * re-dropped: `movableBefore` re-ordered as `movableAfter` into the same slots
 * of the drawn order, so a group chip — and the fixed permanent tab — stays
 * exactly where it was while tabs move around it.
 */
export function surfaceOrderAfterReorder(
  drawnIds: readonly string[],
  movableBefore: readonly string[],
  movableAfter: readonly string[],
): readonly string[] {
  const movable = new Set(movableBefore);
  const queue = [...movableAfter];
  return drawnIds.map((id) => (movable.has(id) ? queue.shift()! : id));
}
