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
  paneForTab,
  SPLIT_VIEW_ROOT_PANE_ID,
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
  registerProvisionalPaneHost,
  type ProvisionalPaneLayoutHost,
} from "@renderer/lib/provisional-pane-commit";

/** Add only renderer-local claims, leaving durable tabs and pane focus alone. */
function overlayPlacements(
  state: SplitViewState,
  placements: ProvisionalPanePlacements,
): SplitViewState {
  const unclaimed = [...placements].filter(([id]) => paneForTab(state, chatTabId(id)) === null);
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
        activeTabId: front === undefined ? node.activeTabId : chatTabId(front[0]),
      };
    }
    const first = rewrite(node.first);
    const second = rewrite(node.second);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  const root = rewrite(state.root);
  return root === state.root ? state : { ...state, root };
}

function deactivateEffectivePane(
  ownerId: string,
  paneId: string,
  split: SplitViewState | null,
): void {
  const layout = useProvisionalPaneLayoutStore.getState();
  const aliases = new Set(
    [...(layout.byOwner.get(ownerId) ?? [])]
      .filter(([, placement]) => placementPaneId(split, placement.paneId) === paneId)
      .map(([, placement]) => placement.paneId),
  );
  layout.deactivatePanes(ownerId, aliases);
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
  /** The Draft's drop destination, independent of later pane focus. */
  activeOverridePaneId: string;
  /** Apply the renderer-only assignment without changing durable pane focus. */
  overlaySplitView: (split: SplitViewState) => SplitViewState;
  /** Tab ids no layout writer may persist: the Drafts nobody has typed into. */
  emptyTabIds: ReadonlySet<string>;
  /** Hands back focused context, retaining other panes' Draft locations. */
  releaseActive: () => void;
  /** Takes the overlay for a Draft this surface is bringing forward. */
  takeActive: (sessionId: string, paneId?: string) => void;
  /** The Draft title for each open chat id, `null` where the chat is a Session. */
  titles: readonly (string | null)[];
  /**
   * Wraps a surface's layout writers so an empty Draft's tab id cannot reach
   * the workspace record through any of them.
   *
   * A reorder or a split carrying that id drops it from the list rather than
   * refusing the whole gesture — the other tabs did nothing wrong. Moving the
   * Draft itself into a pane writes the FOCUS (durable, and about the pane) but
   * not the assignment (about the Draft), and takes the overlay instead, so the
   * tab follows the drag on screen and is recorded only once it has content.
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
  { readSplitView, claimTab }: ProvisionalPaneLayoutHost,
): ProvisionalChatTabs {
  const overrideId = useChatSessionsStore((state) =>
    ownerId === null ? null : (state.provisionalActive[ownerId] ?? null),
  );
  React.useEffect(() => {
    return ownerId === null
      ? undefined
      : registerProvisionalPaneHost(ownerId, { readSplitView, claimTab });
  }, [ownerId, readSplitView, claimTab]);
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
  const focusedPaneId = split?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
  const initialPaneId = focusedPaneId;
  const renderPlacements = new Map([...placements].filter(([id]) => openChatIds.includes(id)));
  if (visibleOverride !== null && !renderPlacements.has(visibleOverride)) {
    renderPlacements.set(visibleOverride, { paneId: initialPaneId, front: true });
  }
  // A newly opened Draft arrives through the selection overlay. Capture its
  // location once; later context changes are not a placement or lifetime act.
  React.useEffect(() => {
    if (ownerId !== null && visibleOverride !== null && !placements.has(visibleOverride)) {
      deactivateEffectivePane(ownerId, initialPaneId, readSplitView());
      useProvisionalPaneLayoutStore.getState().place(ownerId, visibleOverride, initialPaneId);
    }
  }, [ownerId, visibleOverride, placements, initialPaneId, readSplitView]);

  const focusedDraft = [...renderPlacements].findLast(
    ([id, placement]) =>
      placement.front &&
      placementPaneId(split, placement.paneId) === focusedPaneId &&
      (split === null || paneForTab(split, chatTabId(id)) === null),
  );
  const activeOverride = focusedDraft?.[0] ?? null;
  const selectedPlacement =
    visibleOverride === null ? focusedDraft?.[1] : renderPlacements.get(visibleOverride);
  const activeOverridePaneId = placementPaneId(
    split,
    selectedPlacement?.paneId ?? SPLIT_VIEW_ROOT_PANE_ID,
  );
  const overlaySplitView = (state: SplitViewState): SplitViewState =>
    overlayPlacements(state, renderPlacements);
  const emptyTabIds = React.useMemo(
    () => new Set(emptyChatIds.map((sessionId) => chatTabId(sessionId))),
    [emptyChatIds],
  );
  const releaseActive = React.useCallback(() => {
    if (ownerId === null) return;
    const latest = readSplitView();
    const paneId = latest?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
    deactivateEffectivePane(ownerId, paneId, latest);
    useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
  }, [ownerId, readSplitView]);
  const takeActive = React.useCallback(
    (sessionId: string, destination?: string) => {
      if (ownerId === null) return;
      const layout = useProvisionalPaneLayoutStore.getState();
      const latest = readSplitView();
      const previous = layout.byOwner.get(ownerId)?.get(sessionId);
      const paneId =
        destination ??
        (previous === undefined
          ? (latest?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID)
          : placementPaneId(latest, previous.paneId));
      deactivateEffectivePane(ownerId, paneId, latest);
      useProvisionalPaneLayoutStore.getState().place(ownerId, sessionId, paneId);
      useChatSessionsStore.getState().setProvisionalActive(ownerId, sessionId);
    },
    [ownerId, readSplitView],
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
          focusPane(paneId);
          const sessionId = parseChatTabId(tabId);
          if (sessionId !== null) takeActive(sessionId, paneId);
        },
        splitPane: (paneId, edge, tabId, surfaceTabIds) => {
          const ids = persistable(surfaceTabIds);
          if (tabId === null || !emptyTabIds.has(tabId)) {
            writes.splitPane(paneId, edge, tabId, ids);
            return;
          }
          // The pane is real and is recorded; only its passenger is not. The
          // newly focused empty pane shows the Draft through the overlay.
          writes.splitPane(paneId, edge, null, ids);
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
    [emptyTabIds, releaseActive, takeActive, readSplitView],
  );

  return {
    activeOverride,
    activeOverrideTabId: activeOverride === null ? null : chatTabId(activeOverride),
    activeOverridePaneId,
    overlaySplitView,
    emptyTabIds,
    guardLayoutWrites,
    releaseActive,
    takeActive,
    titles,
  };
}
