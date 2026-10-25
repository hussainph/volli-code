// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { groupedSplitView, pairTabs } from "@volli/shared";
import type { BrowserTabState } from "../../../../ipc/contract";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { showBrowserTab } from "./show-browser-tab";

const stores = vi.hoisted(() => ({
  workspace: {
    byProject: {} as Record<
      string,
      {
        homeSplitView?: ReturnType<typeof groupedSplitView>;
        ticketTabs: Record<string, { splitView?: ReturnType<typeof groupedSplitView> }>;
      }
    >,
    pairHomeTabs: vi.fn(),
    pairTicketTabs: vi.fn(),
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

describe("showBrowserTab", () => {
  it("pairs a Home browser with its owning chat and focuses it", async () => {
    const bridge = api(tab());
    await showBrowserTab(bridge, "b");
    expect(bridge.setPresentation).toHaveBeenCalledWith({ tabId: "b", presentation: "tab" });
    expect(stores.chats.openChatTab).toHaveBeenCalledWith("p", "s");
    expect(stores.workspace.pairHomeTabs).toHaveBeenCalledWith("p", "chat:s", "browser:b");
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
    expect(useBrowserTabsStore.getState().byId.b?.title).toBe("Settings");
  });
  it("keeps a Ticket pair in its own area", async () => {
    await showBrowserTab(api(tab({ ticketId: "t" })), "b");
    expect(stores.chats.openChatTab).toHaveBeenCalledWith("t", "s");
    expect(stores.workspace.pairTicketTabs).toHaveBeenCalledWith("p", "t", "chat:s", "browser:b");
    expect(stores.workspace.openTicketView).toHaveBeenCalledWith("p", "t", {
      tabId: "browser:b",
    });
    expect(stores.workspace.pairHomeTabs).not.toHaveBeenCalled();
  });
  it("focuses an existing pair without replacing its partner", async () => {
    let id = 0;
    stores.workspace.byProject.p = {
      ticketTabs: {},
      homeSplitView: pairTabs(
        groupedSplitView([], "board"),
        "board",
        "browser:b",
        "right",
        () => `id-${++id}`,
      ),
    };
    await showBrowserTab(api(tab()), "b");
    expect(stores.workspace.pairHomeTabs).not.toHaveBeenCalled();
    expect(stores.chats.openChatTab).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });
  it("explicit beside-owner intent replaces a Board partner with the owning chat", async () => {
    let id = 0;
    stores.workspace.byProject.p = {
      ticketTabs: {},
      homeSplitView: pairTabs(
        groupedSplitView([], "board"),
        "board",
        "browser:b",
        "right",
        () => `id-${++id}`,
      ),
    };
    await showBrowserTab(api(tab()), "b", "beside-owner");
    expect(stores.workspace.pairHomeTabs).toHaveBeenCalledWith("p", "chat:s", "browser:b");
    expect(stores.chats.openChatTab).toHaveBeenCalledWith("p", "s");
  });

  it("shows a person's tab without requesting a Session-only presentation mutation", async () => {
    const own = tab({ createdBy: "user", ownerSessionId: null });
    useBrowserTabsStore.getState().receive(own);
    const bridge = api(own);
    await showBrowserTab(bridge, "b");
    expect(bridge.setPresentation).not.toHaveBeenCalled();
    expect(stores.workspace.pairHomeTabs).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).toHaveBeenCalledWith("p", "browser:b");
  });
  it("does not change layout after a refused presentation mutation", async () => {
    await expect(
      showBrowserTab({ setPresentation: async () => ({ ok: false, error: "gone" }) }, "b"),
    ).rejects.toThrow("gone");
    expect(stores.workspace.pairHomeTabs).not.toHaveBeenCalled();
    expect(stores.workspace.setHomeActiveTab).not.toHaveBeenCalled();
  });
});
