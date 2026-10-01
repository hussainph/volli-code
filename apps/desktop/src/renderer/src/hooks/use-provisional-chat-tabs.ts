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
 * handed back. `commitActive` is that moment.
 *
 * Promotion changes only what the tab IS, never where it is, so it needs
 * nothing here at all.
 */
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import {
  activateTab,
  focusPane as focusSplitPane,
  primaryPaneId,
  SPLIT_VIEW_ROOT_PANE_ID,
  splitViewPanes,
  type SplitViewState,
} from "@volli/shared";

import type { SplitSurfaceWrites } from "@renderer/components/split/split-surface-drop";
import { chatTabId, parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  isEmptyProvisionalChatDraft,
  isVisibleProvisionalChatDraft,
  useChatDraftsStore,
} from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

// Like the active overlay itself, its destination outlives a mounted Ticket
// view but never reaches app_state. Keep at most one placement per owner and
// retire it with the overlay, including closes and owner teardown off-screen.
const provisionalPlacements = new Map<string, { sessionId: string; paneId: string }>();
useChatSessionsStore.subscribe((state, previous) => {
  if (state.provisionalActive === previous.provisionalActive) return;
  for (const [owner, placement] of provisionalPlacements) {
    if (state.provisionalActive[owner] !== placement.sessionId) {
      provisionalPlacements.delete(owner);
    }
  }
});

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
  /** Whether `activeOverride` has earned its place in the persisted layout. */
  shouldCommitActive: boolean;
  /** Hands the overlay back, once the caller has recorded the tab itself. */
  releaseActive: () => void;
  /** Takes the overlay for a Draft this surface is bringing forward. */
  takeActive: (sessionId: string) => void;
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
  /** Read at gesture time too: a split mints and focuses its pane synchronously. */
  readSplitView: () => SplitViewState | null,
): ProvisionalChatTabs {
  const overrideId = useChatSessionsStore((state) =>
    ownerId === null ? null : (state.provisionalActive[ownerId] ?? null),
  );
  const overrideDraft = useChatDraftsStore((state) =>
    overrideId === null ? undefined : state.drafts[overrideId],
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
  // An empty Draft has no durable pane claim. Remember its destination for the
  // lifetime of the focus overlay instead of activating it in whichever pane
  // happens to be focused on every render. In particular, pointer-down on an
  // empty pane must not replace its Close pane row before click can reach it.
  const [, refreshPlacement] = React.useReducer((version: number) => version + 1, 0);
  const split = readSplitView();
  let placement = ownerId === null ? undefined : provisionalPlacements.get(ownerId);
  if (ownerId !== null && visibleOverride !== null && placement?.sessionId !== visibleOverride) {
    placement = {
      sessionId: visibleOverride,
      paneId: split?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID,
    };
    provisionalPlacements.set(ownerId, placement);
  }
  const assignedPaneId = placement?.paneId ?? SPLIT_VIEW_ROOT_PANE_ID;
  // A pane that really closed relinquishes its tab to the primary, just like
  // durable layout does. Closing a different pane never changes this claim.
  const activeOverridePaneId =
    split === null
      ? SPLIT_VIEW_ROOT_PANE_ID
      : splitViewPanes(split).some((pane) => pane.id === assignedPaneId)
        ? assignedPaneId
        : primaryPaneId(split);
  const activeOverride =
    split === null || split.focusedPaneId === activeOverridePaneId ? visibleOverride : null;
  const overlaySplitView = (state: SplitViewState): SplitViewState => {
    if (visibleOverride === null) return state;
    const overlaid = activateTab(
      focusSplitPane(state, activeOverridePaneId),
      chatTabId(visibleOverride),
    );
    return { ...overlaid, focusedPaneId: state.focusedPaneId };
  };
  const emptyTabIds = React.useMemo(
    () => new Set(emptyChatIds.map((sessionId) => chatTabId(sessionId))),
    [emptyChatIds],
  );
  const releaseActive = React.useCallback(() => {
    if (ownerId !== null) useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
  }, [ownerId]);
  const takeActive = React.useCallback(
    (sessionId: string) => {
      if (ownerId === null) return;
      const previous = provisionalPlacements.get(ownerId);
      const paneId = readSplitView()?.focusedPaneId ?? SPLIT_VIEW_ROOT_PANE_ID;
      provisionalPlacements.set(ownerId, { sessionId, paneId });
      useChatSessionsStore.getState().setProvisionalActive(ownerId, sessionId);
      // Moving the same Draft to an already-focused pane changes neither
      // store's focus. Its renderer-only placement still needs a repaint.
      if (previous?.sessionId !== sessionId || previous.paneId !== paneId) refreshPlacement();
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
          if (sessionId !== null) takeActive(sessionId);
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
          if (sessionId !== null) takeActive(sessionId);
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
    [emptyTabIds, releaseActive, takeActive],
  );

  return {
    activeOverride,
    activeOverrideTabId: activeOverride === null ? null : chatTabId(activeOverride),
    activeOverridePaneId,
    overlaySplitView,
    emptyTabIds,
    guardLayoutWrites,
    // Two ways an overlaid Draft earns its place: it gained content, or it was
    // promoted outright (a first message can arrive before a render does). The
    // second is read as "there is a draft entry here, and it is no longer
    // provisional" — a Session's tab belongs in the layout like any other.
    shouldCommitActive:
      activeOverride !== null &&
      overrideDraft !== undefined &&
      (isVisibleProvisionalChatDraft(overrideDraft) || overrideDraft.provisional === undefined),
    releaseActive,
    takeActive,
    titles,
  };
}
