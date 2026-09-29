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

import type { SplitSurfaceWrites } from "@renderer/components/split/split-surface-drop";
import { chatTabId, parseChatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import {
  isEmptyProvisionalChatDraft,
  isVisibleProvisionalChatDraft,
  useChatDraftsStore,
} from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";

export interface ProvisionalChatTabs {
  /**
   * The Draft this surface is showing without having recorded it, or `null`.
   *
   * Already checked against the surface's open tabs, so a stale overlay left by
   * a closed tab never names something that is not on screen.
   */
  activeOverride: string | null;
  /** That id as a tab id, or `null` — the form every layout reader wants. */
  activeOverrideTabId: string | null;
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

  const activeOverride =
    overrideId !== null && openChatIds.includes(overrideId) ? overrideId : null;
  const emptyTabIds = React.useMemo(
    () => new Set(emptyChatIds.map((sessionId) => chatTabId(sessionId))),
    [emptyChatIds],
  );
  const releaseActive = React.useCallback(() => {
    if (ownerId !== null) useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
  }, [ownerId]);
  const takeActive = React.useCallback(
    (sessionId: string) => {
      if (ownerId !== null)
        useChatSessionsStore.getState().setProvisionalActive(ownerId, sessionId);
    },
    [ownerId],
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
