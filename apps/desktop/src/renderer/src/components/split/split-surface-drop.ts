/**
 * THE STORE WRITES A DROP ASKS FOR, routed once for both surfaces (VC-202).
 *
 * `split-drop.ts` decides what a gesture MEANS; the workspace store's twin
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
 * decisions themselves are one copy here:
 *
 *  • a strip drop arranges the SURFACE while unsplit and one PANE's own order
 *    while split (§2 — the surface arrangement is untouched while split);
 *  • a centre drop while unsplit is not a pane move — there is no split for
 *    `moveTabToPane` to write to — so it answers with the activation door a
 *    click on the row would have taken, and a zone that lit "Move here" never
 *    lands as nothing;
 *  • a split records the strip as it stands (`orderedTabIds`) as the primary
 *    pane's claim, INCLUDING a tab the drop itself just opened, which this
 *    render's list predates.
 */
import type { SplitViewEdge } from "@volli/shared";

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
  /** Arrange the surface's own strip (VC-189's drop) — the unsplit half. */
  reorderSurface(movedId: string, ids: readonly string[]): void;
  /** Rewrite one pane's own order — the split half. */
  reorderPane(paneId: string, movedId: string, ids: readonly string[]): void;
  /** Move a tab into a pane; the model focuses and activates for it. */
  moveTabToPane(tabId: string, paneId: string): void;
  /** Split a pane open around `tabId`, claiming `surfaceTabIds` on a first split. */
  splitPane(
    paneId: string,
    edge: SplitViewEdge,
    tabId: string,
    surfaceTabIds: readonly string[],
  ): void;
  /** Bring a tab to the front of an UNSPLIT surface — the centre drop's door. */
  activateTab(tabId: string, payload: SplitDragPayload): void;
  /**
   * Open what a native payload names, answering with the tab id it landed in —
   * or `null` when there is nothing to place (a terminal whose tab closed
   * mid-drag).
   */
  openPayload(payload: SplitDragPayload): string | null;
}

/** The two live facts every routing decision reads. */
export interface SplitSurfaceDropState {
  /** Whether the surface currently has a split (`splitView !== null`). */
  isSplit: boolean;
  /** The surface's strip in drawn order — what a first split records. */
  orderedTabIds: readonly string[];
}

/**
 * A drop on one pane's strip. While unsplit it arranges the SURFACE, exactly
 * as it always did; while split it rewrites that pane's own order and leaves
 * the surface arrangement alone (§2) — where a pane's tabs sit is the pane's
 * business.
 */
export function reorderDropWrite(
  state: SplitSurfaceDropState,
  writes: SplitSurfaceWrites,
  paneId: string,
  movedId: string,
  ids: readonly string[],
): void {
  if (state.isSplit) writes.reorderPane(paneId, movedId, ids);
  else writes.reorderSurface(movedId, ids);
}

/**
 * What a dnd-kit tab drop writes — the three operations `split-drop.ts` can
 * answer with, each handed to the store twin that owns it. A `move` needs no
 * unsplit branch: one pane cannot produce one (its centre is the identity
 * no-op, decided upstream).
 */
export function tabDropWrite(
  state: SplitSurfaceDropState,
  writes: SplitSurfaceWrites,
  operation: SplitDropOperation,
): void {
  if (operation.kind === "reorder") {
    reorderDropWrite(state, writes, operation.paneId, operation.movedId, operation.ids);
    return;
  }
  if (operation.kind === "move") {
    writes.moveTabToPane(operation.tabId, operation.paneId);
    return;
  }
  writes.splitPane(operation.paneId, operation.edge, operation.tabId, state.orderedTabIds);
}

/**
 * What a Session or file row dropped on a pane writes (§4).
 *
 * The tab has to EXIST before a pane can hold it, so the payload is opened
 * first through the surface's own door (`openPayload`); the placement is then
 * the same split-or-move a tab drop makes — except the unsplit centre, where
 * "here" is the surface's only pane and the drop answers by bringing the tab
 * forward instead of writing to a split that does not exist.
 */
export function nativeDropWrite(
  state: SplitSurfaceDropState,
  writes: SplitSurfaceWrites,
  payload: SplitDragPayload,
  paneId: string,
  zone: SplitDropZone,
): void {
  const tabId = writes.openPayload(payload);
  if (tabId === null) return;
  const edge = splitDropEdge(zone);
  if (edge === null) {
    if (state.isSplit) writes.moveTabToPane(tabId, paneId);
    else writes.activateTab(tabId, payload);
    return;
  }
  // Including the tab just opened: the caller's list predates it.
  writes.splitPane(paneId, edge, tabId, [...state.orderedTabIds, tabId]);
}
