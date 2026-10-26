// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { emptySplitView, groupTabs, type SplitViewState } from "@volli/shared";
import type { BrowserTabState } from "../../../../ipc/contract";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { revealIslandBrowserTab, showBrowserTab } from "./show-browser-tab";

const stores = vi.hoisted(() => ({
  workspace: {
    byProject: {} as Record<
      string,
      {
        homeSplitView?: SplitViewState;
        ticketTabs: Record<string, { splitView?: SplitViewState }>;
      }
    >,
    groupHomeTabs: vi.fn(),
    groupTicketTabs: vi.fn(),
    setNav: vi.fn(),
    setHomeActiveTab: vi.fn(),
    openTicketView: vi.fn(),
  },
  chats: { adoptChatSession: vi.fn(), openChatTab: vi.fn() },
}));
vi.mock("@renderer/stores/project-ui", () => ({
  useProjectUiStore: { getState: () => stores.workspace },
}));
vi.mock("@renderer/stores/chat-sessions", () => ({
  useChatSessionsStore: { getState: () => stores.chats },
}));

const tab = (patch: Partial<BrowserTabState> = {}): BrowserTabState => ({
  tabId: "b",
  projectId: "p",
  ticketId: null,
  createdBy: "session",
  ownerSessionId: "s",
  presentation: "tab",
  url: "http://localhost:5173/settings",
  title: "Settings",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
  heldBy: null,
  ...patch,
});
beforeEach(() => {
  vi.clearAllMocks();
  stores.workspace.byProject = {};
  useBrowserTabsStore.setState({ byId: {} });
});

function api(value: BrowserTabState) {
  return { setPresentation: vi.fn(async () => ({ ok: true as const, tab: value })) };
}

/** A Home split view where `browser:b` is grouped beside `target`. */
function groupedWith(target: string): SplitViewState {
  let id = 0;
  return groupTabs(emptySplitView(target), target, "browser:b", "right", () => `id-${++id}`);
}

describe("showBrowserTab", () => {
  it("SELECTS a promoted Home browser without grouping it with anything", async () => {
    const bridge = api(tab());
    await showBrowserTab(bridge, "b");
    expect(bridge.setPresentation).toHaveBeenCalledWith({ tabId: "b", presentation: "tab" });
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
    expect(stores.chats.openChatTab).not.toHaveBeenCalled();
    expect(stores.workspace.setNav).toHaveBeenCalledWith("p", "home");
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
    expect(useBrowserTabsStore.getState().byId.b?.title).toBe("Settings");
  });

  it("opens beside its owning chat: the chat's pane splits, the browser on the right", async () => {
    await showBrowserTab(api(tab()), "b", "beside-owner");
    expect(stores.chats.adoptChatSession).toHaveBeenCalledWith("s");
    expect(stores.chats.openChatTab).toHaveBeenCalledWith("p", "s");
    expect(stores.workspace.groupHomeTabs).toHaveBeenCalledWith(
      "p",
      "chat:s",
      "browser:b",
      "right",
    );
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });

  it("keeps a Ticket group in its own area", async () => {
    await showBrowserTab(api(tab({ ticketId: "t" })), "b", "beside-owner");
    expect(stores.chats.openChatTab).toHaveBeenCalledWith("t", "s");
    expect(stores.workspace.groupTicketTabs).toHaveBeenCalledWith(
      "p",
      "t",
      "chat:s",
      "browser:b",
      "right",
    );
    expect(stores.workspace.openTicketView).toHaveBeenCalledWith("p", "t", {
      tabId: "browser:b",
    });
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
  });

  it("only shows a browser already grouped with its owning chat", async () => {
    stores.workspace.byProject.p = { ticketTabs: {}, homeSplitView: groupedWith("chat:s") };
    await showBrowserTab(api(tab()), "b", "beside-owner");
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });

  it("groups beside the owner even when the browser sits in another group", async () => {
    stores.workspace.byProject.p = { ticketTabs: {}, homeSplitView: groupedWith("board") };
    await showBrowserTab(api(tab()), "b", "beside-owner");
    expect(stores.workspace.groupHomeTabs).toHaveBeenCalledWith(
      "p",
      "chat:s",
      "browser:b",
      "right",
    );
  });

  it("shows a person's tab without requesting a Session-only presentation mutation", async () => {
    const own = tab({ createdBy: "user", ownerSessionId: null });
    useBrowserTabsStore.getState().receive(own);
    const bridge = api(own);
    await showBrowserTab(bridge, "b", "beside-owner");
    expect(bridge.setPresentation).not.toHaveBeenCalled();
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });

  it("does not change layout after a refused presentation mutation", async () => {
    await expect(
      showBrowserTab({ setPresentation: async () => ({ ok: false, error: "gone" }) }, "b"),
    ).rejects.toThrow("gone");
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).not.toHaveBeenCalled();
  });
});

describe("revealIslandBrowserTab", () => {
  it("opens a headless tab BESIDE its owning chat — the Island's Open beside chat", async () => {
    useBrowserTabsStore.getState().receive(tab({ presentation: "headless" }));
    await revealIslandBrowserTab(api(tab()), "b");
    expect(stores.workspace.groupHomeTabs).toHaveBeenCalledWith(
      "p",
      "chat:s",
      "browser:b",
      "right",
    );
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });

  it("opens a tab the store has not seen yet beside its chat too", async () => {
    await revealIslandBrowserTab(api(tab()), "b");
    expect(stores.workspace.groupHomeTabs).toHaveBeenCalledOnce();
  });

  it("only SELECTS a tab already in a strip — the Island's Show tab", async () => {
    useBrowserTabsStore.getState().receive(tab());
    const bridge = api(tab());
    await revealIslandBrowserTab(bridge, "b");
    expect(bridge.setPresentation).toHaveBeenCalledWith({ tabId: "b", presentation: "tab" });
    expect(stores.workspace.groupHomeTabs).not.toHaveBeenCalled();
    expect(stores.chats.openChatTab).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });
});
