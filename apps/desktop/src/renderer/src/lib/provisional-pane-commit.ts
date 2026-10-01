import {
  paneForTab,
  primaryPaneId,
  SPLIT_VIEW_ROOT_PANE_ID,
  splitViewPanes,
  type SplitViewState,
} from "@volli/shared";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { isVisibleProvisionalChatDraft, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProvisionalPaneLayoutStore } from "@renderer/stores/provisional-pane-layout";

export interface ProvisionalPaneLayoutHost {
  readSplitView(): SplitViewState | null;
  /** Save a first-content claim without moving pane focus. */
  claimTab(tabId: string, paneId: string, front: boolean): void;
}

export function placementPaneId(split: SplitViewState | null, paneId: string): string {
  if (split === null) return SPLIT_VIEW_ROOT_PANE_ID;
  return splitViewPanes(split).some((pane) => pane.id === paneId) ? paneId : primaryPaneId(split);
}

interface HostEntry {
  host: ProvisionalPaneLayoutHost;
  mounts: number;
}
const hosts = new Map<string, HostEntry>();
let committing = false;

// Content can arrive from an import callback after TicketDetail unmounts. The
// owner-bound store doors outlive that view until its last local claim is saved
// or its tabs close; a React effect is not the durability boundary.
function commitReadyPlacements(): void {
  if (committing) return;
  committing = true;
  try {
    const drafts = useChatDraftsStore.getState().drafts;
    for (const [ownerId, placements] of useProvisionalPaneLayoutStore.getState().byOwner) {
      const entry = hosts.get(ownerId);
      if (entry === undefined) continue;
      for (const [sessionId, placement] of placements) {
        const draft = drafts[sessionId];
        if (
          draft === undefined ||
          (!isVisibleProvisionalChatDraft(draft) && draft.provisional !== undefined)
        )
          continue;
        const latest = entry.host.readSplitView();
        const tabId = chatTabId(sessionId);
        entry.host.claimTab(tabId, placementPaneId(latest, placement.paneId), placement.front);
        const saved = entry.host.readSplitView();
        if (saved !== null && paneForTab(saved, tabId) === null) continue;
        useProvisionalPaneLayoutStore.getState().remove(ownerId, sessionId);
        const chat = useChatSessionsStore.getState();
        if (chat.provisionalActive[ownerId] === sessionId) chat.setProvisionalActive(ownerId, null);
      }
    }
  } finally {
    committing = false;
  }
}

export function registerProvisionalPaneHost(
  ownerId: string,
  host: ProvisionalPaneLayoutHost,
): () => void {
  const entry = hosts.get(ownerId) ?? { host, mounts: 0 };
  entry.host = host;
  entry.mounts += 1;
  hosts.set(ownerId, entry);
  commitReadyPlacements();
  return () => {
    entry.mounts -= 1;
    if (entry.mounts === 0 && !useProvisionalPaneLayoutStore.getState().byOwner.has(ownerId))
      hosts.delete(ownerId);
  };
}

useChatDraftsStore.subscribe((state, previous) => {
  if (state.drafts !== previous.drafts) commitReadyPlacements();
});
useProvisionalPaneLayoutStore.subscribe(() => {
  commitReadyPlacements();
  for (const [ownerId, entry] of hosts) {
    if (entry.mounts === 0 && !useProvisionalPaneLayoutStore.getState().byOwner.has(ownerId))
      hosts.delete(ownerId);
  }
});
