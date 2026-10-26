/**
 * What a tab surface needs to know about its Chat Drafts (VC-358).
 *
 * Home and a Ticket workspace are different surfaces with different owners,
 * different stores for their layout and different tab vocabularies — but the
 * rule about a Chat Draft is the same on both, and it was written out twice:
 * the same four readings, the same commit-on-first-content effect, and the same
 * four guards wrapped around the four layout writers. One logical change had to
 * be made in ten places, which is the shape of a bug waiting for the eleventh.
 *
 * The rule itself, stated once:
 *
 * An EMPTY Draft is entirely renderer-local. Its `chat:<uuid>` tab may be on
 * screen and focused, but the id must not reach the workspace record — not the
 * active tab, not the tab order, not a pane assignment — because a person who
 * presses `+ Chat` and changes their mind must leave nothing behind, including
 * nothing to restore at the next relaunch. `activeOverride` is how such a tab
 * comes forward without being written down.
 *
 * The first typed character or staged file ends that. The id was always the
 * one the Session will take, so nothing is renamed or moved: the same tab id
 * simply joins the persisted layout where it already is, and the overlay is
 * handed back. The resident provisional-pane commit subscription owns that
 * boundary, including imports that finish after this surface unmounts.
 *
 * Promotion changes only what the tab IS, never where it is. It can also land
 * a pending claim without changing the pane's focus.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  groupedPanes,
  groupForTab,
  paneForTab,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewEdge,
  type SplitViewGroup,
  type SplitViewNode,
  type SplitViewState,
} from "@volli/shared";

import type { SplitSurfaceWrites } from "@renderer/components/split/split-surface-drop";
import { chatTabId, parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { isEmptyProvisionalChatDraft, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

import {
  EMPTY_PROVISIONAL_PANE_PLACEMENTS,
  useProvisionalPaneLayoutStore,
  type ProvisionalPanePlacements,
} from "@renderer/stores/provisional-pane-layout";

import {
  placementPaneId,
  deactivateProvisionalPane,
  registerProvisionalPaneHost,
  type ProvisionalPaneLayoutHost,
} from "@renderer/lib/provisional-pane-commit";

/** The edge on the far side of `edge`'s axis. */
function mirroredEdge(edge: SplitViewEdge): SplitViewEdge {
  if (edge === "left") return "right";
  if (edge === "right") return "left";
  return edge === "up" ? "down" : "up";
}

/**
 * The renderer-only placements laid over the saved groups: an untouched Draft
 * placed in a group pane joins that pane's stack (in front when it is), in the
 * group's entry AND in `root` when that group is shown, so the projection sees
 * one consistent state. Durable tabs, focus and selection are left alone.
 */
function overlayPlacements(
  state: SplitViewState,
  placements: ProvisionalPanePlacements,
): SplitViewState {
  const unclaimed = [...placements].filter(([id]) => groupForTab(state, chatTabId(id)) === null);
  if (unclaimed.length === 0) return state;
  const rewrite = (node: SplitViewNode): SplitViewNode => {
    if (node.kind === "pane") {
      const here = unclaimed.filter(
        ([, placement]) => placementPaneId(state, placement.paneId) === node.id,
      );
      if (here.length === 0) return node;
      const front = here.findLast(([, placement]) => placement.front);
      return {
        ...node,
        tabIds: [...node.tabIds, ...here.map(([id]) => chatTabId(id))],
        activeTabId:
          front === undefined ? (node.activeTabId ?? chatTabId(here[0]![0])) : chatTabId(front[0]),
      };
    }
    const first = rewrite(node.first);
    const second = rewrite(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  const pairs = state.pairs.map((group) => rewrite(group) as SplitViewGroup);
  if (pairs.every((group, index) => group === state.pairs[index])) return state;
  const { root } = state;
  const shown = root.kind === "split" ? pairs.find((group) => group.id === root.id) : undefined;
  return { ...state, pairs, root: shown ?? root };
}

export interface ProvisionalChatTabs {
  /**
   * The focused pane's unrecorded Draft, or `null` when another pane is focused.
   *
   * Already checked against the surface's open tabs, so a stale overlay left by
   * a closed tab never names something that is not on screen.
   */
  activeOverride: string | null;
  /** That id as a tab id, or `null` — the form every layout reader wants. */
  activeOverrideTabId: string | null;
  /** Lay the renderer-only placements over a saved split view (never persisted). */
  overlaySplitView: (split: SplitViewState) => SplitViewState;
  /** Tab ids no layout writer may persist: the Drafts nobody has typed into. */
  emptyTabIds: ReadonlySet<string>;
  /** Hands back focused context, retaining other panes' Draft locations. */
  releaseActive: () => void;
  /** Takes the overlay for a Draft this surface is bringing forward. */
  takeActive: (sessionId: string, paneId?: string) => void;
  /**
   * Group `tabId` beside `targetId` (a top-strip edge drop). An untouched Draft
   * on either side rides into an EMPTY pane the write opens, so its id is never
   * recorded; two Drafts have no durable anchor and stay put.
   */
  groupTabs: (
    targetId: string,
    tabId: string,
    edge: SplitViewEdge,
    writeGroup: (targetId: string, tabId: string | null, edge: SplitViewEdge) => void,
  ) => void;
  /**
   * Take a tab out of its group (dragged to the top strip, or closing). An
   * untouched Draft only leaves its renderer-local placement — closing the
   * empty pane it rode into — and comes forward full width.
   */
  ungroupTab: (tabId: string, writeUngroup: (tabId: string) => void) => void;
  /** The Draft title for each open chat id, `null` where the chat is a Session. */
  titles: readonly (string | null)[];
  /**
   * Wraps a surface's layout writers so an empty Draft's tab id cannot reach
   * the workspace record through any of them.
   *
   * A reorder carrying that id drops it from the list rather than refusing the
   * whole gesture — the other tabs did nothing wrong. Moving the Draft itself
   * into a pane writes the FOCUS (durable, and about the pane) but not the
   * assignment (about the Draft), and takes the overlay instead, so the tab
   * follows the drag on screen and is recorded only once it has content.
   *
   * `focusPane` is the surface's own pane-focus writer: the one thing a pane
   * gesture should still record when its passenger cannot be.
   */
  guardLayoutWrites: (
    writes: SplitSurfaceWrites,
    focusPane: (paneId: string) => void,
  ) => SplitSurfaceWrites;
}

/**
 * @param ownerId  The surface's own owner key — a ticketId, or a projectId for
 *                 Home and for a chat whose Ticket has left the board. `null`
 *                 when the surface has no project selected yet.
 * @param openChatIds The chat ids this surface currently has tabs for.
 */
export function useProvisionalChatTabs(
  ownerId: string | null,
  openChatIds: readonly string[],
  {
    readSplitView,
    claimTab,
    activateTab,
    focusPane: focusDraftPane,
    closePane: closeDraftPane,
  }: ProvisionalPaneLayoutHost & {
    /** A Draft with an existing durable claim is a normal tab selection. */
    activateTab(tabId: string): void;
    /** Reveal/focus a Draft's group pane without ever recording an empty Draft ID. */
    focusPane(paneId: string): void;
    /** Close an empty pane a Draft rode into, once the Draft has left it. */
    closePane(paneId: string): void;
  },
): ProvisionalChatTabs {
  const overrideId = useChatSessionsStore((state) =>
    ownerId === null ? null : (state.provisionalActive[ownerId] ?? null),
  );
  React.useEffect(() => {
    return ownerId === null
      ? undefined
      : registerProvisionalPaneHost(ownerId, { readSplitView, claimTab, activateTab });
  }, [ownerId, readSplitView, claimTab, activateTab]);
  const placements = useProvisionalPaneLayoutStore((state) =>
    ownerId === null
      ? EMPTY_PROVISIONAL_PANE_PLACEMENTS
      : (state.byOwner.get(ownerId) ?? EMPTY_PROVISIONAL_PANE_PLACEMENTS),
  );
  const emptyChatIds = useChatDraftsStore(
    useShallow((state) =>
      openChatIds.filter((sessionId) => isEmptyProvisionalChatDraft(state.drafts[sessionId])),
    ),
  );
  const titles = useChatDraftsStore(
    useShallow((state) =>
      openChatIds.map((sessionId) => state.drafts[sessionId]?.provisional?.title ?? null),
    ),
  );

  const visibleOverride =
    overrideId !== null && openChatIds.includes(overrideId) ? overrideId : null;
  const split = readSplitView();
  // A new Draft opens where the person is working: the shown group's focused
  // pane, or full width.
  const focusedPaneId = split?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
  const renderPlacements = new Map([...placements].filter(([id]) => openChatIds.includes(id)));
  if (visibleOverride !== null && !renderPlacements.has(visibleOverride)) {
    renderPlacements.set(visibleOverride, { paneId: focusedPaneId, front: true });
  }
  // A newly opened Draft arrives through the selection overlay. Capture its
  // location once; later context changes are not a placement or lifetime act.
  React.useEffect(() => {
    if (ownerId !== null && visibleOverride !== null && !placements.has(visibleOverride)) {
      deactivateProvisionalPane(ownerId, focusedPaneId, readSplitView());
      useProvisionalPaneLayoutStore.getState().place(ownerId, visibleOverride, focusedPaneId);
    }
  }, [ownerId, visibleOverride, placements, focusedPaneId, readSplitView]);

  const unclaimed = (tabId: string) => split === null || groupForTab(split, tabId) === null;
  const focusedDraft = [...renderPlacements].findLast(
    ([id, placement]) =>
      placement.front &&
      placementPaneId(split, placement.paneId) === focusedPaneId &&
      unclaimed(chatTabId(id)),
  );
  const activeOverride = focusedDraft?.[0] ?? null;
  const overlaySplitView = (state: SplitViewState): SplitViewState =>
    overlayPlacements(state, renderPlacements);
  const emptyTabIds = React.useMemo(
    () =>
      new Set(
        emptyChatIds
          .map((sessionId) => chatTabId(sessionId))
          .filter((tabId) => split === null || groupForTab(split, tabId) === null),
      ),
    [emptyChatIds, split],
  );
  const releaseActive = React.useCallback(() => {
    if (ownerId === null) return;
    const latest = readSplitView();
    const paneId = latest?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
    deactivateProvisionalPane(ownerId, paneId, latest);
    useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
  }, [ownerId, readSplitView]);
  const takeActive = React.useCallback(
    (sessionId: string, destination?: string) => {
      if (ownerId === null) return;
      const layout = useProvisionalPaneLayoutStore.getState();
      const latest = readSplitView();
      const tabId = chatTabId(sessionId);
      const claimedPane = latest === null ? null : paneForTab(latest, tabId);
      if (claimedPane !== null) {
        deactivateProvisionalPane(ownerId, claimedPane, latest);
        layout.remove(ownerId, sessionId);
        useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
        activateTab(tabId);
        return;
      }
      const previous = layout.byOwner.get(ownerId)?.get(sessionId);
      const paneId =
        destination ??
        (previous === undefined
          ? (latest?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID)
          : placementPaneId(latest, previous.paneId));
      // A retained destination can belong to a group that is not shown.
      // Selection must reveal that group and focus its pane, not move the
      // Draft to whatever ordinary tab happened to be visible before the click.
      focusDraftPane(paneId);
      deactivateProvisionalPane(ownerId, paneId, readSplitView());
      useProvisionalPaneLayoutStore.getState().place(ownerId, sessionId, paneId);
      useChatSessionsStore.getState().setProvisionalActive(ownerId, sessionId);
    },
    [ownerId, readSplitView, activateTab, focusDraftPane],
  );

  /** The stored-empty group pane a Draft was placed in, if it still is one. */
  const placeholderPane = React.useCallback(
    (sessionId: string): string | null => {
      if (ownerId === null) return null;
      const paneId = useProvisionalPaneLayoutStore
        .getState()
        .byOwner.get(ownerId)
        ?.get(sessionId)?.paneId;
      const latest = readSplitView();
      const pane =
        latest === null ? undefined : groupedPanes(latest).find((one) => one.id === paneId);
      return pane !== undefined && pane.tabIds.length === 0 ? pane.id : null;
    },
    [ownerId, readSplitView],
  );

  const groupTabs = React.useCallback(
    (
      targetId: string,
      tabId: string,
      edge: SplitViewEdge,
      writeGroup: (targetId: string, tabId: string | null, edge: SplitViewEdge) => void,
    ) => {
      if (targetId === tabId) return;
      const targetEmpty = emptyTabIds.has(targetId);
      const movingEmpty = emptyTabIds.has(tabId);
      // Two untouched Drafts have no durable anchor. Leave that gesture local.
      if (targetEmpty && movingEmpty) return;
      if (!targetEmpty && !movingEmpty) {
        releaseActive();
        writeGroup(targetId, tabId, edge);
        return;
      }
      // The Draft rides into an empty pane opened beside the durable tab — on
      // the dropped edge, or mirrored round the incoming tab when the Draft was
      // the target — so the layout is recorded and the Draft is not.
      const draft = movingEmpty ? tabId : targetId;
      const sessionId = parseChatTabId(draft);
      if (sessionId === null) return;
      const previous = placeholderPane(sessionId);
      const before = readSplitView();
      if (movingEmpty) writeGroup(targetId, null, edge);
      else writeGroup(tabId, null, mirroredEdge(edge));
      const after = readSplitView();
      // A refused write cannot relocate the renderer-only passenger.
      if (after === null || after === before) return;
      if (previous !== null && previous !== after.focusedPaneId) closeDraftPane(previous);
      takeActive(sessionId, readSplitView()?.focusedPaneId);
    },
    [emptyTabIds, placeholderPane, readSplitView, releaseActive, takeActive, closeDraftPane],
  );
  /** An untouched Draft out of its pane: its empty pane closes, and it comes forward full width. */
  const releaseDraft = React.useCallback(
    (tabId: string) => {
      const sessionId = parseChatTabId(tabId);
      if (ownerId === null || sessionId === null) return;
      const placeholder = placeholderPane(sessionId);
      if (placeholder !== null) closeDraftPane(placeholder);
      useProvisionalPaneLayoutStore.getState().remove(ownerId, sessionId);
      takeActive(sessionId, SPLIT_VIEW_ROOT_PANE_ID);
    },
    [ownerId, placeholderPane, closeDraftPane, takeActive],
  );
  const ungroupTab = React.useCallback(
    (tabId: string, writeUngroup: (tabId: string) => void) => {
      if (emptyTabIds.has(tabId)) {
        releaseDraft(tabId);
        return;
      }
      releaseActive();
      writeUngroup(tabId);
    },
    [emptyTabIds, releaseDraft, releaseActive],
  );

  const guardLayoutWrites = React.useCallback(
    (writes: SplitSurfaceWrites, focusPane: (paneId: string) => void): SplitSurfaceWrites => {
      const persistable = (ids: readonly string[]) => ids.filter((id) => !emptyTabIds.has(id));
      return {
        ...writes,
        reorderSurface: (movedId, ids) => {
          if (emptyTabIds.has(movedId)) return;
          writes.reorderSurface(movedId, persistable(ids));
        },
        reorderPane: (paneId, movedId, ids) => {
          if (emptyTabIds.has(movedId)) return;
          writes.reorderPane(paneId, movedId, persistable(ids));
        },
        moveTabToPane: (tabId, paneId) => {
          if (!emptyTabIds.has(tabId)) {
            writes.moveTabToPane(tabId, paneId);
            return;
          }
          const latest = readSplitView();
          if (latest === null || !groupedPanes(latest).some((pane) => pane.id === paneId)) return;
          focusPane(paneId);
          const sessionId = parseChatTabId(tabId);
          if (sessionId !== null) takeActive(sessionId, paneId);
        },
        ungroupTab: (tabId) => {
          if (emptyTabIds.has(tabId)) releaseDraft(tabId);
          else writes.ungroupTab(tabId);
        },
        splitPane: (paneId, edge, tabId) => {
          if (tabId === null || !emptyTabIds.has(tabId)) {
            writes.splitPane(paneId, edge, tabId);
            return;
          }
          // The pane is real and is recorded; only its passenger is not. The
          // newly focused empty pane shows the Draft through the overlay.
          const before = readSplitView();
          writes.splitPane(paneId, edge, null);
          // A refused split must not move the renderer-only passenger either.
          if (readSplitView() === before) return;
          const sessionId = parseChatTabId(tabId);
          if (sessionId !== null) takeActive(sessionId, readSplitView()?.focusedPaneId);
        },
        activateTab: (tabId, payload) => {
          const sessionId = emptyTabIds.has(tabId) ? parseChatTabId(tabId) : null;
          if (sessionId !== null) {
            takeActive(sessionId);
            return;
          }
          releaseActive();
          writes.activateTab(tabId, payload);
        },
      };
    },
    [emptyTabIds, releaseActive, releaseDraft, takeActive, readSplitView],
  );

  return {
    activeOverride,
    activeOverrideTabId: activeOverride === null ? null : chatTabId(activeOverride),
    overlaySplitView,
    emptyTabIds,
    groupTabs,
    ungroupTab,
    guardLayoutWrites,
    releaseActive,
    takeActive,
    titles,
  };
}
