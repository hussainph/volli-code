import { isBrowserStartUrl } from "../../../browser-start-page";
import type { BrowserTabListResult, BrowserTabState } from "../../../ipc/contract";
import { create } from "zustand";

import type { BrowserApi } from "@renderer/components/browser/browser-api";

interface BrowserTabsState {
  byId: Record<string, BrowserTabState>;
  hydratedProjects: ReadonlySet<string>;
  receive(tab: BrowserTabState): void;
  receiveProject(projectId: string, tabs: readonly BrowserTabState[]): void;
  remove(tabId: string): void;
}

/** Live Browser Tab chrome state, projected from main's BrowserTabHost. */
export const useBrowserTabsStore = create<BrowserTabsState>((set) => ({
  byId: {},
  hydratedProjects: new Set(),
  receive(tab) {
    set((state) => ({ byId: { ...state.byId, [tab.tabId]: tab } }));
  },
  receiveProject(projectId, tabs) {
    set((state) => {
      const byId = Object.fromEntries(
        Object.entries(state.byId).filter(([, tab]) => tab.projectId !== projectId),
      );
      for (const tab of tabs) byId[tab.tabId] = tab;
      return {
        byId,
        hydratedProjects: new Set([...state.hydratedProjects, projectId]),
      };
    });
  },
  remove(tabId) {
    set((state) => {
      if (!(tabId in state.byId)) return state;
      const byId = { ...state.byId };
      delete byId[tabId];
      return { byId };
    });
  },
}));

/** Reconciles one project's whole main-owned registry into the renderer view. */
export async function hydrateBrowserTabs(
  api: BrowserApi,
  projectId: string,
): Promise<BrowserTabListResult> {
  const result = await api.list({ projectId });
  if (result.ok) useBrowserTabsStore.getState().receiveProject(projectId, result.tabs);
  return result;
}

/** The app-lifetime push subscription that keeps tab titles and chrome live. */
export function subscribeBrowserTabs(api: BrowserApi): () => void {
  return api.onTabState((event) => {
    if (event.tab !== undefined) useBrowserTabsStore.getState().receive(event.tab);
    else useBrowserTabsStore.getState().remove(event.closedTabId);
  });
}

/**
 * The tabs a workspace strip draws (VC-238): a person's own, and the agent
 * tabs a person promoted there. Headless and previewed agent tabs are
 * elsewhere — nowhere, and above the owning chat's composer — and both strips
 * read this one rule rather than each looking at `createdBy`.
 */
export function stripBrowserTabs(tabs: readonly BrowserTabState[]): BrowserTabState[] {
  return tabs.filter((tab) => tab.presentation === "tab");
}

/**
 * Every tab one chat can answer for: its Session's own and its children's, in
 * whatever presentation, in registry order. The chip counts these; the
 * inventory lists them; a headless tab is visible nowhere else.
 */
export function sessionBrowserTabs(
  byId: Readonly<Record<string, BrowserTabState>>,
  sessionId: string,
  childSessionIds: ReadonlySet<string> = new Set(),
): BrowserTabState[] {
  return Object.values(byId).filter(
    (tab) =>
      tab.ownerSessionId !== null &&
      (tab.ownerSessionId === sessionId || childSessionIds.has(tab.ownerSessionId)),
  );
}

/** The tab pinned above this chat's composer, or null. Main keeps it to one per Session. */
export function previewedBrowserTab(
  byId: Readonly<Record<string, BrowserTabState>>,
  sessionId: string,
): BrowserTabState | null {
  return (
    Object.values(byId).find(
      (tab) => tab.ownerSessionId === sessionId && tab.presentation === "preview",
    ) ?? null
  );
}

/**
 * Who is driving a tab, as the chat says it: `you`, `this Session`, a child
 * by its title, or `another Session` for an owner this chat cannot name.
 */
export function browserTabOwnerLabel(
  tab: Pick<BrowserTabState, "ownerSessionId">,
  sessionId: string,
  titleOf: (sessionId: string) => string | null,
): string {
  if (tab.ownerSessionId === null) return "you";
  if (tab.ownerSessionId === sessionId) return "this Session";
  return titleOf(tab.ownerSessionId) ?? "another Session";
}

/** What a blank tab is called before it has been sent anywhere. */
export const BROWSER_NEW_TAB_TITLE = "New Tab";

export function browserTabDisplayTitle(tab: BrowserTabState): string {
  // The start page first: `about:blank` reports no title and no hostname, so
  // without this the strip would label a brand-new tab with the raw scheme —
  // the one string the address bar is deliberately hiding.
  if (isBrowserStartUrl(tab.url)) return BROWSER_NEW_TAB_TITLE;
  const title = tab.title.trim();
  if (title.length > 0) return title;
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return tab.url || "Browser";
  }
}
