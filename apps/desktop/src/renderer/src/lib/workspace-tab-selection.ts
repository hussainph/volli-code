import { paneForTab, SPLIT_VIEW_ROOT_PANE_ID, type SplitViewState } from "@volli/shared";

// Selection is intent, not a change in the saved active ID: the same durable
// tab may currently be covered by an empty Draft. Keep this resident event seam
// outside persisted workspace state and emit only from user activation doors.
const listeners = new Map<string, Set<(paneId: string) => void>>();

export function subscribeWorkspaceTabSelection(
  ownerId: string,
  listener: (paneId: string) => void,
): () => void {
  const ownerListeners = listeners.get(ownerId) ?? new Set();
  ownerListeners.add(listener);
  listeners.set(ownerId, ownerListeners);
  return () => {
    ownerListeners.delete(listener);
    if (ownerListeners.size === 0) listeners.delete(ownerId);
  };
}

export function publishWorkspaceTabSelection(
  ownerId: string,
  tabId: string,
  split: SplitViewState | null,
): void {
  const paneId =
    split === null ? SPLIT_VIEW_ROOT_PANE_ID : (paneForTab(split, tabId) ?? split.focusedPaneId);
  for (const listener of listeners.get(ownerId) ?? []) listener(paneId);
}
