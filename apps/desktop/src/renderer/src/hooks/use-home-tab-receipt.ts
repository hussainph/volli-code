import * as React from "react";
import type { HomeTabRestore } from "@renderer/components/home/home-tabs";

interface HomeTabReceipt {
  projectId: string | null;
  provisionalActive: string | null;
  emptyTabIds: ReadonlySet<string>;
  restoreKind: HomeTabRestore["kind"];
  activeTabId: string;
  recordedTab: string;
  recordResolvedTab(projectId: string, tabId: string): void;
}

/** A fallback receipt may neither persist an empty Draft nor select its pane. */
export function useHomeTabReceipt({
  projectId,
  provisionalActive,
  emptyTabIds,
  restoreKind,
  activeTabId,
  recordedTab,
  recordResolvedTab,
}: HomeTabReceipt): void {
  React.useEffect(() => {
    if (
      projectId === null ||
      provisionalActive !== null ||
      emptyTabIds.has(activeTabId) ||
      restoreKind !== "settled" ||
      activeTabId === recordedTab
    )
      return;
    recordResolvedTab(projectId, activeTabId);
  }, [
    projectId,
    provisionalActive,
    emptyTabIds,
    restoreKind,
    activeTabId,
    recordedTab,
    recordResolvedTab,
  ]);
}
