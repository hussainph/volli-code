/**
 * Reversible Browser Tab close. The frozen renderer open API creates personal
 * tabs, so reopening a destroyed Session tab would lose its owner and page.
 * Hide it now; destroy it only once the Undo window expires. This queue lives
 * beyond a chat mount, so navigating away neither cancels a close nor loses Undo.
 */
import { create } from "zustand";
import { toast } from "sonner";

import { errorMessage } from "@volli/shared";
import type { BrowserTabState } from "../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { toastError } from "@renderer/lib/toast";
import { browserTabDisplayTitle, useBrowserTabsStore } from "@renderer/stores/browser-tabs";

const UNDO_CLOSE_MS = 5000;

export const useClosingBrowserTabIds = create<ReadonlySet<string>>(() => new Set());

function forget(tabId: string): void {
  useClosingBrowserTabIds.setState((ids) => {
    const next = new Set(ids);
    next.delete(tabId);
    return next;
  }, true);
}

export async function closeBrowserTabWithUndo(
  api: BrowserApi,
  tab: BrowserTabState,
  onRefusal: () => void,
): Promise<void> {
  if (useClosingBrowserTabIds.getState().has(tab.tabId)) return;
  useClosingBrowserTabIds.setState((ids) => new Set([...ids, tab.tabId]), true);
  const report = (reason: unknown) => {
    toastError(`Could not close Browser Tab: ${errorMessage(reason)}`);
    onRefusal();
  };
  const restore = async () => {
    try {
      if (tab.presentation !== "headless") {
        const result = await api.setPresentation({
          tabId: tab.tabId,
          presentation: tab.presentation,
        });
        if (!result.ok) throw new Error(result.error);
      }
    } catch (reason) {
      toastError(`Could not restore Browser Tab: ${errorMessage(reason)}`);
    } finally {
      forget(tab.tabId);
    }
  };
  try {
    if (tab.presentation !== "headless") {
      const result = await api.setPresentation({ tabId: tab.tabId, presentation: "headless" });
      if (!result.ok) throw new Error(result.error);
    }
  } catch (reason) {
    forget(tab.tabId);
    report(reason);
    return;
  }

  let undone = false;
  const timer = window.setTimeout(() => {
    undone = true;
    void (async () => {
      try {
        const result = await api.close({ tabId: tab.tabId });
        if (!result.ok) throw new Error(result.error);
        useBrowserTabsStore.getState().remove(tab.tabId);
        forget(tab.tabId);
      } catch (reason) {
        await restore();
        report(reason);
      }
    })();
  }, UNDO_CLOSE_MS);
  toast(`Closed ${browserTabDisplayTitle(tab)}`, {
    duration: UNDO_CLOSE_MS,
    action: {
      label: "Undo",
      onClick: () => {
        if (undone) return;
        undone = true;
        window.clearTimeout(timer);
        void restore();
      },
    },
  });
}
