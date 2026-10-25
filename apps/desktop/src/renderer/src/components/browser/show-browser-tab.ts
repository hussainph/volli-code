import { groupForTab } from "@volli/shared";

import type { BrowserApi } from "./browser-api";
import { browserTabId } from "@renderer/components/home/home-tabs";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectUiStore } from "@renderer/stores/project-ui";

/**
 * Reveal an existing Browser Tab, promoting an agent's preview to a strip tab
 * first.
 *
 * `show` SELECTS it (VC-614): in its group if it has one, else full width — a
 * selection never pulls a tab into a group. `beside-owner` ("Open beside chat")
 * also groups it with the chat that owns it: beside that chat in the chat's
 * group (its pane split, the browser on the right), or as a new group of two —
 * unless the two already share a group, where it is simply shown.
 */
export async function showBrowserTab(
  api: Pick<BrowserApi, "setPresentation">,
  tabId: string,
  mode: "show" | "beside-owner" = "show",
): Promise<void> {
  const known = useBrowserTabsStore.getState().byId[tabId];
  const result =
    known?.createdBy === "user"
      ? { ok: true as const, tab: known }
      : await api.setPresentation({ tabId, presentation: "tab" });
  if (!result.ok) throw new Error(result.error);
  const tab = result.tab;
  useBrowserTabsStore.getState().receive(tab);
  const workspace = useProjectUiStore.getState();
  const id = browserTabId(tabId);
  const owner = tab.ownerSessionId;
  if (mode === "beside-owner" && owner !== null) {
    const chats = useChatSessionsStore.getState();
    chats.adoptChatSession(owner);
    chats.openChatTab(tab.ticketId ?? tab.projectId, owner);
    const ui = workspace.byProject[tab.projectId];
    const split =
      (tab.ticketId === null ? ui?.homeSplitView : ui?.ticketTabs[tab.ticketId]?.splitView) ?? null;
    const group = groupForTab(split, chatTabId(owner));
    if (group === null || groupForTab(split, id) !== group) {
      if (tab.ticketId === null) {
        workspace.groupHomeTabs(tab.projectId, chatTabId(owner), id, "right");
      } else {
        workspace.groupTicketTabs(tab.projectId, tab.ticketId, chatTabId(owner), id, "right");
      }
    }
  }
  if (tab.ticketId === null) {
    workspace.setNav(tab.projectId, "home");
    workspace.setHomeActiveTab(tab.projectId, id);
  } else {
    workspace.openTicketView(tab.projectId, tab.ticketId, { tabId: id });
  }
}
