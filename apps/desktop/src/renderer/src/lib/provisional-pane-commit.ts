import {
  groupedPanes,
  groupForTab,
  SPLIT_VIEW_ROOT_PANE_ID,
  type SplitViewState,
} from "@volli/shared";

import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { isVisibleProvisionalChatDraft, useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROVISIONAL_PANE_PLACEMENTS,
  useProvisionalPaneLayoutStore,
} from "@renderer/stores/provisional-pane-layout";
import { subscribeWorkspaceTabSelection } from "./workspace-tab-selection";

export interface ProvisionalPaneLayoutHost {
  readSplitView(): SplitViewState | null;
  /** Save a first-content claim into a group pane without moving pane focus. */
  claimTab(tabId: string, paneId: string, front: boolean): void;
  /** Select a Draft that earned content as an ordinary, full-width tab. */
  activateTab?(tabId: string): void;
}

/**
 * Where a Draft placed in `paneId` lives now: that group pane while some group
 * still has it, else the full-width pane — a Draft whose group dissolved is an
 * ordinary tab, never a pending claim into a pane that is gone.
 */
export function placementPaneId(split: SplitViewState | null, paneId: string): string {
  if (split === null) return SPLIT_VIEW_ROOT_PANE_ID;
  return groupedPanes(split).some((pane) => pane.id === paneId) ? paneId : SPLIT_VIEW_ROOT_PANE_ID;
}

interface HostEntry {
  host: ProvisionalPaneLayoutHost;
  mounts: number;
  unsubscribeSelection: () => void;
}
const hosts = new Map<string, HostEntry>();
let committing = false;

export function deactivateProvisionalPane(
  ownerId: string,
  paneId: string,
  split: SplitViewState | null,
): void {
  const layout = useProvisionalPaneLayoutStore.getState();
  const placements = layout.byOwner.get(ownerId) ?? EMPTY_PROVISIONAL_PANE_PLACEMENTS;
  const aliases = new Set(
    [...placements]
      .filter(([, placement]) => placementPaneId(split, placement.paneId) === paneId)
      .map(([, placement]) => placement.paneId),
  );
  const selected = useChatSessionsStore.getState().provisionalActive[ownerId];
  const selectedPlacement = selected === undefined ? undefined : placements.get(selected);
  layout.deactivatePanes(ownerId, aliases);
  if (selectedPlacement !== undefined && aliases.has(selectedPlacement.paneId))
    useChatSessionsStore.getState().setProvisionalActive(ownerId, null);
}

function deleteHost(ownerId: string, entry: HostEntry): void {
  entry.unsubscribeSelection();
  hosts.delete(ownerId);
}

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
        const paneId = placementPaneId(latest, placement.paneId);
        // Into its pane's stack, in front only if it still was there.
        entry.host.claimTab(tabId, paneId, placement.front);
        const saved = entry.host.readSplitView();
        if (saved !== null && groupForTab(saved, tabId) === null) {
          // A group pane that did not take the claim is retried on the next
          // change. A full-width Draft is an ordinary tab now, and it becomes
          // the selection only while it is still the tab in front.
          if (paneId !== SPLIT_VIEW_ROOT_PANE_ID) continue;
          if (placement.front && saved.focusedPaneId === SPLIT_VIEW_ROOT_PANE_ID) {
            entry.host.activateTab?.(tabId);
          }
        }
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
  const entry = hosts.get(ownerId) ?? {
    host,
    mounts: 0,
    unsubscribeSelection: subscribeWorkspaceTabSelection(ownerId, (paneId) => {
      deactivateProvisionalPane(ownerId, paneId, hosts.get(ownerId)!.host.readSplitView());
    }),
  };
  entry.host = host;
  entry.mounts += 1;
  hosts.set(ownerId, entry);
  commitReadyPlacements();
  return () => {
    entry.mounts -= 1;
    if (entry.mounts === 0 && !useProvisionalPaneLayoutStore.getState().byOwner.has(ownerId))
      deleteHost(ownerId, entry);
  };
}

useChatDraftsStore.subscribe((state, previous) => {
  if (state.drafts !== previous.drafts) commitReadyPlacements();
});
useProvisionalPaneLayoutStore.subscribe(() => {
  commitReadyPlacements();
  for (const [ownerId, entry] of hosts) {
    if (entry.mounts === 0 && !useProvisionalPaneLayoutStore.getState().byOwner.has(ownerId))
      deleteHost(ownerId, entry);
  }
});
