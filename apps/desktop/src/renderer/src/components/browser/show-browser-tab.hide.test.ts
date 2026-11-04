// @vitest-environment jsdom
/**
 * The way back from a strip to the Activity Island (VC-1118), against the real
 * workspace and browser stores: the host hides the tab, Home's strip and group
 * let go of it exactly as a close does, and the Island lists it again with the
 * reveal it started from.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { groupForTab } from "@volli/shared";

import type { BrowserTabState } from "../../../../ipc/contract";
import { islandTabOf } from "@renderer/chat/use-island-tabs";
import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import {
  sessionBrowserTabs,
  stripBrowserTabs,
  useBrowserTabsStore,
} from "@renderer/stores/browser-tabs";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { hideBrowserTab, leaveHomeStrip, showBrowserTab } from "./show-browser-tab";

// A workspace store of its own over memory, so nothing writes through to the
// app_state bridge this test has no main process behind.
vi.mock("@renderer/stores/project-ui", async (importOriginal) => {
  const real = await importOriginal<typeof import("@renderer/stores/project-ui")>();
  const data = new Map<string, string>();
  return {
    ...real,
    useProjectUiStore: real.createProjectUiStore({
      getItem: (name) => data.get(name) ?? null,
      setItem: (name, value) => {
        data.set(name, value);
      },
      removeItem: (name) => {
        data.delete(name);
      },
    }),
  };
});

const PROJECT = "p";
const SESSION = "s";

const tab = (patch: Partial<BrowserTabState> = {}): BrowserTabState => ({
  tabId: "b",
  projectId: PROJECT,
  ticketId: null,
  createdBy: "session",
  ownerSessionId: SESSION,
  presentation: "tab",
  url: "http://localhost:5173/settings",
  title: "Settings",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 3,
  heldBy: null,
  ...patch,
});

/** A bridge that answers presentation changes the way main does. */
function bridge() {
  return {
    setPresentation: vi.fn(
      async (input: { tabId: string; presentation: BrowserTabState["presentation"] }) => ({
        ok: true as const,
        tab: tab({ tabId: input.tabId, presentation: input.presentation }),
      }),
    ),
  };
}

const home = () => useProjectUiStore.getState().byProject[PROJECT];
const homeStrip = () =>
  stripBrowserTabs(Object.values(useBrowserTabsStore.getState().byId)).map((one) => one.tabId);
/** What the owning chat's Island shows for the tab: its row, and the row's reveal. */
const islandRow = () => {
  const listed = sessionBrowserTabs(useBrowserTabsStore.getState().byId, SESSION);
  const row = listed.find((one) => one.tabId === "b");
  return row === undefined ? undefined : islandTabOf(row, SESSION, () => null);
};

const initialChats = useChatSessionsStore.getState();

beforeEach(() => {
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
  useProjectUiStore.setState({ byProject: {} });
  useChatSessionsStore.setState({ ...initialChats, openTabs: { [PROJECT]: [SESSION] } }, true);
  useBrowserTabsStore.getState().receive(tab());
});

describe("hideBrowserTab", () => {
  it("asks main for headless and lands the answer before anyone reads the strip", async () => {
    const api = bridge();
    await hideBrowserTab(api, "b");
    expect(api.setPresentation).toHaveBeenCalledWith({ tabId: "b", presentation: "headless" });
    expect(homeStrip()).toEqual([]);
    // The agent's tab is unchanged but for where it is drawn.
    expect(useBrowserTabsStore.getState().byId.b).toMatchObject({
      presentation: "headless",
      ownerSessionId: SESSION,
      generation: 3,
    });
    // The Island lists it again, offering the reveal it was first shown with.
    expect(islandRow()).toMatchObject({ promoted: false, surface: null });
  });

  it("throws a refusal for the surface to report, leaving the strip as it was", async () => {
    const api = {
      setPresentation: vi.fn(async () => ({
        ok: false as const,
        error: "Only a Session's Browser Tab can be hidden or previewed",
      })),
    };
    const leaveStrip = vi.fn();
    await expect(hideBrowserTab(api, "b", leaveStrip)).rejects.toThrow(
      "Only a Session's Browser Tab can be hidden or previewed",
    );
    expect(leaveStrip).not.toHaveBeenCalled();
    expect(homeStrip()).toEqual(["b"]);
    expect(islandRow()).toMatchObject({ promoted: true, surface: "tab" });
  });
});

describe("leaveHomeStrip after a hide", () => {
  it("dissolves a group of two beside the owning chat and brings the chat forward", async () => {
    const workspace = useProjectUiStore.getState();
    workspace.groupHomeTabs(PROJECT, "chat:s", "browser:b", "right");
    workspace.setHomeActiveTab(PROJECT, "browser:b");
    expect(groupForTab(home()?.homeSplitView ?? null, "browser:b")).not.toBeNull();

    await hideBrowserTab(bridge(), "b", () => leaveHomeStrip(PROJECT, "b"));

    expect(home()?.homeSplitView ?? null).toBeNull();
    expect(home()?.homeActiveTab).toBe("chat:s");
    expect(home()?.homeTabHistory).not.toContain("browser:b");
  });

  it("returns an ordinary tab's selection to the tab visited before it", async () => {
    const workspace = useProjectUiStore.getState();
    workspace.setHomeActiveTab(PROJECT, "chat:s");
    workspace.setHomeActiveTab(PROJECT, "browser:b");

    await hideBrowserTab(bridge(), "b", () => leaveHomeStrip(PROJECT, "b"));

    expect(home()?.homeActiveTab).toBe("chat:s");
    expect(home()?.homeSplitView ?? null).toBeNull();
  });

  it("falls back to the Board when nothing else was visited", async () => {
    useProjectUiStore.getState().setHomeActiveTab(PROJECT, "browser:b");

    await hideBrowserTab(bridge(), "b", () => leaveHomeStrip(PROJECT, "b"));

    expect(home()?.homeActiveTab).toBe(HOME_BOARD_TAB_ID);
  });

  it("can be opened beside its chat again from the Island", async () => {
    // Its chat is already open; attaching a live transport is not this test's.
    useChatSessionsStore.setState({ adoptChatSession: vi.fn(), openChatTab: vi.fn() });
    const api = bridge();
    const workspace = useProjectUiStore.getState();
    workspace.groupHomeTabs(PROJECT, "chat:s", "browser:b", "right");
    workspace.setHomeActiveTab(PROJECT, "browser:b");
    await hideBrowserTab(api, "b", () => leaveHomeStrip(PROJECT, "b"));

    await showBrowserTab(api, "b", "beside-owner");

    expect(homeStrip()).toEqual(["b"]);
    const group = groupForTab(home()?.homeSplitView ?? null, "browser:b");
    expect(group).not.toBeNull();
    expect(groupForTab(home()?.homeSplitView ?? null, "chat:s")).toBe(group);
    expect(home()?.homeActiveTab).toBe("browser:b");
  });
});
