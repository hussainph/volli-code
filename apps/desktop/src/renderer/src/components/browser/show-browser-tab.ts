import type { BrowserApi } from "./browser-api";
import { browserTabId } from "@renderer/components/home/home-tabs";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useWorkspaceStore } from "@renderer/stores/workspace";

/** Reveal the existing tab, pairing it with its owning chat when not already grouped. */
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
  const workspace = useWorkspaceStore.getState();
  const id = browserTabId(tabId);
  const ui = workspace.byProject[tab.projectId];
  const split = tab.ticketId === null ? ui?.homeSplitView : ui?.ticketTabs[tab.ticketId]?.splitView;
  const grouped =
    split?.pairs?.some(
      (pair) => pair.first.activeTabId === id || pair.second.activeTabId === id,
    ) === true;
  const owner = tab.ownerSessionId;
  if ((!grouped || mode === "beside-owner") && owner !== null) {
    const chats = useChatSessionsStore.getState();
    chats.adoptChatSession(owner);
    chats.openChatTab(tab.ticketId ?? tab.projectId, owner);
    if (tab.ticketId === null) workspace.pairHomeTabs(tab.projectId, chatTabId(owner), id);
    else workspace.pairTicketTabs(tab.projectId, tab.ticketId, chatTabId(owner), id);
  }
  if (tab.ticketId === null) {
    workspace.setNav(tab.projectId, "home");
    workspace.setHomeActiveTab(tab.projectId, id);
  } else {
    workspace.openTicketWorkspace(tab.projectId, tab.ticketId, { tabId: id });
  }
}
