import { groupForTab } from "@volli/shared";

import type { BrowserApi } from "./browser-api";
import { HOME_BOARD_TAB_ID, browserTabId } from "@renderer/components/home/home-tabs";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { fileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { stripBrowserTabs, useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useSessionsStore } from "@renderer/stores/sessions";

/**
 * Reveal an existing Browser Tab, promoting an agent's preview to a strip tab
 * first. {@link hideBrowserTab} is the way back.
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

/**
 * The workspace half of a Browser Tab leaving Home's strip once main has
 * accepted it: closed, or hidden back to its Activity Island (VC-1118). Run
 * after the browser store has stopped listing the tab in the strip.
 *
 * The split-view half comes first, as it does for the chat and terminal closes
 * Home's surface makes: a grouped tab leaves its pane (a group of two
 * dissolves) and the surface lands on the pane's own successor, so the MRU
 * return inside `closeHomeBrowserTab` only ever runs unsplit.
 */
export function leaveHomeStrip(projectId: string, tabId: string): void {
  const workspace = useProjectUiStore.getState();
  const id = browserTabId(tabId);
  workspace.removeHomeTabFromSplit(projectId, id);
  const sessions = useSessionsStore.getState().byOwner[projectId]?.tabs ?? [];
  const chats = useChatSessionsStore.getState().openTabs[projectId] ?? [];
  const files = useProjectUiStore.getState().byProject[projectId]?.projectFiles.tabs ?? [];
  const browsers = stripBrowserTabs(
    Object.values(useBrowserTabsStore.getState().byId).filter(
      (tab) => tab.projectId === projectId && tab.ticketId === null,
    ),
  );
  workspace.closeHomeBrowserTab(projectId, id, [
    HOME_BOARD_TAB_ID,
    ...sessions.map((tab) => tab.sessionId),
    ...chats.map(chatTabId),
    ...files.map((tab) => fileTabId(tab.relPath)),
    ...browsers.map((tab) => browserTabId(tab.tabId)),
  ]);
}

/**
 * Send a Session's strip tab back to its Activity Island: headless again, off
 * screen, with its owner, page and hold untouched, so the agent keeps driving
 * it and the Island's row offers **Open beside chat** once more.
 *
 * The strip and any tab group the tab sat in are the calling surface's to
 * tidy, through the same step its close takes ({@link leaveHomeStrip} on
 * Home), because only that surface knows which tab its selection should fall
 * back to. Run that step in this continuation, so a stale-tab effect cannot
 * reset selection between the browser store update and the workspace cleanup.
 * Throws on a refusal (a person's own tab, or one that is gone), so the
 * surface can surface it.
 */
export async function hideBrowserTab(
  api: Pick<BrowserApi, "setPresentation">,
  tabId: string,
  leaveStrip?: () => void,
): Promise<void> {
  const result = await api.setPresentation({ tabId, presentation: "headless" });
  if (!result.ok) throw new Error(result.error);
  // Before the surface tidies up: its fallback selection reads the strip from
  // this store, which must no longer list the tab.
  useBrowserTabsStore.getState().receive(result.tab);
  leaveStrip?.();
}

/**
 * The Activity Island's one reveal door, which names its action by where the
 * tab already is: a tab already in a strip says **Show tab** and is selected
 * (`show`); a headless or legacy-preview tab says **Open beside chat** and is
 * grouped beside its owning chat (`beside-owner`). Read from the same
 * `presentation` the Island's row reads for its label, so the label and the
 * act cannot disagree.
 */
export function revealIslandBrowserTab(
  api: Pick<BrowserApi, "setPresentation">,
  tabId: string,
): Promise<void> {
  const shown = useBrowserTabsStore.getState().byId[tabId]?.presentation === "tab";
  return showBrowserTab(api, tabId, shown ? "show" : "beside-owner");
}
