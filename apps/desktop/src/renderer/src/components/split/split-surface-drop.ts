/**
 * THE STORE WRITES A DROP ASKS FOR, routed once for both surfaces (VC-202).
 *
 * `split-drop.ts` decides what a gesture MEANS; the project UI store's twin
 * actions do the writing. This seam is the routing between the two, which each
 * surface used to carry as its own copy — the same branches, spelled twice, one
 * strip-select bug away from the two surfaces answering the same drop
 * differently.
 *
 * The surfaces differ in exactly two ways, and {@link SplitSurfaceWrites} is
 * those two ways spelled out: WHICH twins write (Home's or a ticket's — the
 * store keeps them as pairs on purpose), and HOW a native payload's tab is
 * opened (`openPayload`, each surface's own doors: preview this checkout's
 * file, adopt this owner's chat, take this container's terminal tab). The
 * decisions themselves are one copy here, and they key on the PANE a gesture
 * names (VC-614):
 *
 *  • the full-width pane ({@link SPLIT_VIEW_ROOT_PANE_ID}) is the top strip's
 *    pane: a drop on its strip arranges the SURFACE, a tab moved to it leaves
 *    its group (an ordinary tab again), and a centre drop on it is the
 *    activation door a click on the row would have taken — "here" is the one
 *    tab on screen, and a zone that lit "Move here" never lands as nothing;
 *  • a group pane's strip rewrites that pane's own stack, and a tab moved to
 *    it joins that stack;
 *  • an edge splits the pane it names — a new group of two on the full-width
 *    pane, another pane inside a group.
 */
import { SPLIT_VIEW_ROOT_PANE_ID, type SplitViewEdge } from "@volli/shared";

import {
  splitDropEdge,
  type SplitDragPayload,
  type SplitDropOperation,
  type SplitDropZone,
} from "@renderer/components/split/split-drop";

/**
 * One surface's half of the bargain: its store twins, and its doors.
 *
 * Every write takes ids the router already resolved; none of them decides
 * anything. `activateTab` carries the payload because Home's terminal door is
 * two ledgers (`setHomeActiveTab` + the container's `setActiveSession` — the
 * pair `handleSelect` writes), and only the payload still says which kind
 * landed.
 */
export interface SplitSurfaceWrites {
  /** Arrange the surface's own top strip (VC-189's drop). */
  reorderSurface(movedId: string, ids: readonly string[]): void;
  /** Rewrite one group pane's own stack order. */
  reorderPane(paneId: string, movedId: string, ids: readonly string[]): void;
  /** Move a tab into a group pane's stack; the model fronts and focuses it. */
  moveTabToPane(tabId: string, paneId: string): void;
  /** Take a grouped tab back out to the top strip — ordinary again, and selected. */
  ungroupTab(tabId: string): void;
  /**
   * Split a pane open around `tabId`.
   *
   * `null` splits the pane open with NOTHING assigned to it. That is what a
   * Chat Draft nobody has typed into needs (VC-358): the pane is durable
   * layout and is recorded, but the Draft riding into it is not yet something
   * the workspace may name, so it arrives through the renderer-only overlay.
   */
  splitPane(paneId: string, edge: SplitViewEdge, tabId: string | null): void;
  /** Bring a tab to the front full width — the full-width centre drop's door. */
  activateTab(tabId: string, payload: SplitDragPayload): void;
  /**
   * Open what a native payload names, answering with the tab id it landed in —
   * or `null` when there is nothing to place (a terminal whose tab closed
   * mid-drag).
   */
  openPayload(payload: SplitDragPayload): string | null;
}

/**
 * A drop on one strip: the top strip arranges the SURFACE, exactly as it
 * always did; a group pane's strip rewrites that pane's own stack and leaves
 * the surface arrangement alone — where a pane's tabs sit is the pane's
 * business.
 */
export function reorderDropWrite(
  writes: SplitSurfaceWrites,
  paneId: string,
  movedId: string,
  ids: readonly string[],
): void {
  if (paneId === SPLIT_VIEW_ROOT_PANE_ID) writes.reorderSurface(movedId, ids);
  else writes.reorderPane(paneId, movedId, ids);
}

/**
 * What a dnd-kit tab drop writes — the three operations `split-drop.ts` can
 * answer with, each handed to the store twin that owns it. A move to the top
 * strip's pane is a tab leaving its group.
 */
export function tabDropWrite(writes: SplitSurfaceWrites, operation: SplitDropOperation): void {
  if (operation.kind === "reorder") {
    reorderDropWrite(writes, operation.paneId, operation.movedId, operation.ids);
    return;
  }
  if (operation.kind === "move") {
    if (operation.paneId === SPLIT_VIEW_ROOT_PANE_ID) writes.ungroupTab(operation.tabId);
    else writes.moveTabToPane(operation.tabId, operation.paneId);
    return;
  }
  writes.splitPane(operation.paneId, operation.edge, operation.tabId);
}

/**
 * What a Session or file row dropped on a pane writes (§4).
 *
 * The tab has to EXIST before a pane can hold it, so the payload is opened
 * first through the surface's own door (`openPayload`); the placement is then
 * the same split-or-move a tab drop makes — except the full-width centre,
 * where "here" is the one tab on screen and the drop answers by bringing the
 * new tab forward instead.
 */
export function nativeDropWrite(
  writes: SplitSurfaceWrites,
  payload: SplitDragPayload,
  paneId: string,
  zone: SplitDropZone,
): void {
  const tabId = writes.openPayload(payload);
  if (tabId === null) return;
  const edge = splitDropEdge(zone);
  if (edge !== null) {
    writes.splitPane(paneId, edge, tabId);
    return;
  }
  if (paneId === SPLIT_VIEW_ROOT_PANE_ID) writes.activateTab(tabId, payload);
  else writes.moveTabToPane(tabId, paneId);
}
