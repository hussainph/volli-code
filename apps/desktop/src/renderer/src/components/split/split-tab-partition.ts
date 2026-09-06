/**
 * WHICH TABS EACH PANE DRAWS — the surface's one strip, cut into per-pane
 * strips (VC-202, `docs/plans/split-view.md` §3).
 *
 * A split surface still composes and arranges ONE list of tabs: the same
 * descriptors, built the same way, whether or not anything is split. All the
 * split view adds is which pane each of them is drawn in, and
 * `resolveSplitView` has already answered that in ids. This module is the last
 * step — ids back to the descriptors the strip actually draws, in the order the
 * pane draws them.
 *
 * Pure and generic over the descriptor, because the two surfaces have different
 * ones (`HomeTabDescriptor`, `TicketTabDescriptor`) and the cut is the same
 * arithmetic for both. An id nothing answers to is DROPPED rather than drawn as
 * a blank tab: a resolved pane names only live ids, so a miss here means the
 * caller resolved against one list and drew another.
 */
import type { ResolvedSplitView, ResolvedSplitViewPane } from "@volli/shared";

/** One pane's strip: the pane, and the descriptors it draws in its own order. */
export interface PaneTabs<T> {
  readonly pane: ResolvedSplitViewPane;
  readonly tabs: readonly T[];
}

/** The descriptors `pane` draws, in the pane's order. */
export function paneTabs<T extends { id: string }>(
  pane: ResolvedSplitViewPane,
  tabs: readonly T[],
): readonly T[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return pane.tabIds.flatMap((id) => {
    const tab = byId.get(id);
    return tab === undefined ? [] : [tab];
  });
}

/** Every pane's strip, in reading order — `[0]` is the primary pane's. */
export function partitionPaneTabs<T extends { id: string }>(
  view: ResolvedSplitView,
  tabs: readonly T[],
): readonly PaneTabs<T>[] {
  return view.panes.map((pane) => ({ pane, tabs: paneTabs(pane, tabs) }));
}

/**
 * A pane strip's accessible name.
 *
 * `TabStrip` requires one because a surface can draw several tablists at once —
 * which a split surface now does by construction, so "Pane 2 tabs" is what
 * tells them apart for AT and for a `getByRole("tablist")` query alike. Counted
 * from 1: the primary pane is pane 1, the one the surface's own strip draws.
 */
export function paneStripLabel(pane: ResolvedSplitViewPane): string {
  return `Pane ${pane.index + 1} tabs`;
}

/** A pane cell's accessible name — "Pane 2 of 3", the position said out loud. */
export function paneCellLabel(pane: ResolvedSplitViewPane, paneCount: number): string {
  return `Pane ${pane.index + 1} of ${paneCount}`;
}
