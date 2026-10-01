import { errorMessage } from "@volli/shared";
import { BROWSER_START_URL } from "../../../../browser-start-page";

import type { BrowserApi } from "./browser-api";
import { browserTabId } from "@renderer/components/home/home-tabs";
import { toastError } from "@renderer/lib/toast";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";

/** The same Browser door for strip and empty-pane actions at either scope. */
export async function openBrowserTab(
  api: Pick<BrowserApi, "open">,
  scope: { projectId: string; ticketId?: string },
  activate: (tabId: string) => void,
): Promise<void> {
  try {
    const result = await api.open({ ...scope, url: BROWSER_START_URL });
    if (!result.ok) {
      toastError(`Could not open Browser Tab: ${result.error}`);
      return;
    }
    useBrowserTabsStore.getState().receive(result.tab);
    activate(browserTabId(result.tab.tabId));
  } catch (reason) {
    toastError(`Could not open Browser Tab: ${errorMessage(reason)}`);
  }
}
