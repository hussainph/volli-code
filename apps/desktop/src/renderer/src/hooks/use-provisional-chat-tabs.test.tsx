// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  emptySplitView,
  groupForTab,
  paneForTab,
  projectSplitView,
  SPLIT_VIEW_ROOT_PANE_ID,
  type BlobLinkView,
  type SplitViewEdge,
  type SplitViewState,
} from "@volli/shared";
import { BROWSER_START_URL } from "../../../browser-start-page";
import type { BrowserTabState } from "../../../ipc/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { openBrowserTab } from "@renderer/components/browser/open-browser-tab";
import { browserTabId, resolveHomeTabs } from "@renderer/components/home/home-tabs";
import { useHomeTabReceipt } from "./use-home-tab-receipt";
import { PaneEmptyState } from "@renderer/components/split/pane-empty-state";
import { SplitViewGrid } from "@renderer/components/split/split-view-grid";
import type { SplitSurfaceWrites } from "@renderer/components/split/split-surface-drop";
import { appStateStorage } from "@renderer/lib/app-state-storage";
import { toastError } from "@renderer/lib/toast";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useProvisionalPaneLayoutStore } from "@renderer/stores/provisional-pane-layout";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { createProjectUiStore } from "@renderer/stores/project-ui";
import { useProvisionalChatTabs, type ProvisionalChatTabs } from "./use-provisional-chat-tabs";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const NO_CHATS: readonly string[] = [];
const DRAFT_TAB = "chat:draft-1";
/**
 * The setup is a group of two made by ⌘\ on the full-width Board/Body: `n1` is
 * the empty pane it opened (focused, where the Draft opens), `n2` the group
 * and `n3` the pane the Board/Body moved into — never `root`, which names the
 * full-width pane (VC-614).
 */
const DRAFT_PANE = "n1";
const OWNER_PANE = "n3";
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  useProvisionalPaneLayoutStore.setState({ byOwner: new Map() });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set() });
  vi.spyOn(appStateStorage, "setItem").mockImplementation(() => undefined);
  vi.mocked(toastError).mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function surface(ticket: boolean, { oldChat = false } = {}) {
  const data = new Map<string, string>();
  let paneSequence = 0;
  const store = createProjectUiStore(
    {
      getItem: (name) => data.get(name) ?? null,
      setItem: (name, value) => {
        data.set(name, value);
      },
      removeItem: (name) => {
        data.delete(name);
      },
    },
    () => `n${++paneSequence}`,
  );
  const ownerId = ticket ? "ticket-1" : "project-1";
  const claimTab = vi.fn((tabId: string, paneId: string, front: boolean) => {
    if (ticket) store.getState().claimTicketTabInPane("project-1", ownerId, tabId, paneId, front);
    else store.getState().claimHomeTabInPane("project-1", tabId, paneId, front);
  });
  const browser: BrowserTabState = {
    tabId: "browser-1",
    projectId: "project-1",
    ticketId: ticket ? ownerId : null,
    createdBy: "user",
    ownerSessionId: null,
    presentation: "tab",
    url: BROWSER_START_URL,
    title: "",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    heldBy: null,
  };
  const browserApi = { open: vi.fn<BrowserApi["open"]>(async () => ({ ok: true, tab: browser })) };
  const permanentTabId = ticket ? "doc" : "board";
  const recordedActive = () =>
    (ticket
      ? store.getState().byProject["project-1"]?.ticketTabs[ownerId]?.active
      : store.getState().byProject["project-1"]?.homeActiveTab) ?? permanentTabId;
  const readSplitView = (): SplitViewState | null => {
    const projectUi = store.getState().byProject["project-1"];
    return (ticket ? projectUi?.ticketTabs[ownerId]?.splitView : projectUi?.homeSplitView) ?? null;
  };
  const focusPane = (paneId: string) => {
    if (ticket) store.getState().focusTicketPane("project-1", ownerId, paneId);
    else store.getState().focusHomePane("project-1", paneId);
  };
  const closePane = (paneId: string) => {
    if (ticket) store.getState().closeTicketPane("project-1", ownerId, paneId);
    else store.getState().closeHomePane("project-1", paneId);
  };
  const writes: SplitSurfaceWrites = {
    splitPane: (paneId, edge, tabId) => {
      const opts = tabId === null ? {} : { tabId };
      if (ticket) store.getState().splitTicketPane("project-1", ownerId, paneId, edge, opts);
      else store.getState().splitHomePane("project-1", paneId, edge, opts);
    },
    moveTabToPane: (tabId, paneId) => {
      if (ticket) store.getState().moveTicketTabToPane("project-1", ownerId, tabId, paneId);
      else store.getState().moveHomeTabToPane("project-1", tabId, paneId);
    },
    activateTab: vi.fn((tabId: string) => {
      if (ticket) store.getState().setTicketActiveTab("project-1", ownerId, tabId);
      else store.getState().setHomeActiveTab("project-1", tabId);
    }),
    ungroupTab: vi.fn((tabId: string) => {
      if (ticket) store.getState().ungroupTicketTab("project-1", ownerId, tabId);
      else store.getState().ungroupHomeTab("project-1", tabId);
    }),
    openPayload: vi.fn(),
    reorderPane: vi.fn(),
    reorderSurface: vi.fn(),
  };
  const writeGroup = vi.fn((target: string, tabId: string | null, edge: SplitViewEdge) => {
    if (ticket) store.getState().groupTicketTabs("project-1", ownerId, target, tabId, edge);
    else store.getState().groupHomeTabs("project-1", target, tabId, edge);
  });
  const writeUngroup = vi.fn((tabId: string) => {
    if (ticket) store.getState().ungroupTicketTab("project-1", ownerId, tabId);
    else store.getState().ungroupHomeTab("project-1", tabId);
  });
  let provisional: ProvisionalChatTabs;
  let guarded: SplitSurfaceWrites;
  let browserFlight: Promise<void> | undefined;
  const createBrowser = () =>
    openBrowserTab(
      browserApi,
      {
        projectId: "project-1",
        ...(ticket ? { ticketId: ownerId } : {}),
      },
      // As the surfaces do: a new Browser Tab is OPENED.
      (tabId) => {
        provisional.releaseActive();
        if (ticket) store.getState().openTicketTab("project-1", ownerId, tabId);
        else store.getState().openHomeTab("project-1", tabId);
      },
    );
  const tabIds = () => [
    permanentTabId,
    ...(useChatSessionsStore.getState().openTabs[ownerId] ?? []).map((id) => `chat:${id}`),
    ...Object.keys(useBrowserTabsStore.getState().byId).map(browserTabId),
    ...(ticket
      ? (store.getState().byProject["project-1"]?.ticketTabs[ownerId]?.files ?? [])
      : (store.getState().byProject["project-1"]?.projectFiles.tabs ?? [])
    ).map((file) => `file:${file.relPath}`),
  ];
  function Harness() {
    store((state) => state.byProject);
    const chats = useChatSessionsStore((state) => state.openTabs[ownerId] ?? NO_CHATS);
    useBrowserTabsStore((state) => state.byId);
    provisional = useProvisionalChatTabs(ownerId, chats, {
      readSplitView,
      claimTab,
      focusPane,
      closePane,
      activateTab: (tabId) => {
        if (ticket) store.getState().setTicketActiveTab("project-1", ownerId, tabId);
        else store.getState().setHomeActiveTab("project-1", tabId);
      },
    });
    guarded = provisional.guardLayoutWrites(writes, focusPane);
    const recorded = recordedActive();
    const resolution = resolveHomeTabs({
      tabIds: tabIds().filter((id) => id !== permanentTabId),
      recorded: provisional.activeOverrideTabId ?? recorded,
      recordedOrder: [],
      containerActive: null,
      durableChatIds: [],
      browserTabsHydrated: true,
      hydrated: true,
    });
    useHomeTabReceipt({
      projectId: ticket ? null : "project-1",
      provisionalActive: provisional.activeOverride,
      emptyTabIds: provisional.emptyTabIds,
      restoreKind: resolution.restore.kind,
      activeTabId: resolution.active,
      recordedTab: recorded,
      recordResolvedTab: store.getState().recordResolvedHomeTab,
    });
    const split = readSplitView() ?? emptySplitView(recorded);
    const view = projectSplitView(
      provisional.overlaySplitView(split),
      tabIds(),
      provisional.activeOverrideTabId ?? recorded,
      permanentTabId,
    );
    return (
      <SplitViewGrid
        view={view}
        renderStrip={() => null}
        renderContent={(pane) =>
          pane.activeTabId === null ? (
            <PaneEmptyState
              onNewChat={vi.fn()}
              onNewTerminal={vi.fn()}
              onNewBrowser={() => {
                browserFlight = createBrowser();
              }}
              onOpenFile={vi.fn()}
              onClosePane={() => closePane(pane.id)}
            />
          ) : pane.activeTabId === DRAFT_TAB ? (
            <textarea
              aria-label="Draft composer"
              onInput={(event) =>
                useChatDraftsStore.getState().setDraft("draft-1", event.currentTarget.value)
              }
            />
          ) : (
            <span>{pane.activeTabId}</span>
          )
        }
        onFocusPane={focusPane}
        onResizeSplit={vi.fn()}
      />
    );
  }
  if (oldChat) {
    useChatSessionsStore.getState().openChatTab(ownerId, "old");
    if (ticket) store.getState().setTicketActiveTab("project-1", ownerId, "chat:old");
    else store.getState().setHomeActiveTab("project-1", "chat:old");
  }
  writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "right", null);
  useChatDraftsStore.getState().openProvisional("draft-1", {
    projectId: "project-1",
    ticketId: ticket ? ownerId : null,
    title: null,
    operationId: "op-1",
  });
  useChatSessionsStore.getState().openChatTab(ownerId, "draft-1");
  useChatSessionsStore.getState().setProvisionalActive(ownerId, "draft-1");
  act(() => root.render(<Harness />));
  return {
    data,
    store,
    browser,
    writes,
    writeGroup,
    writeUngroup,
    focusPane,
    focusDown: () => {
      if (ticket) store.getState().focusAdjacentTicketPane("project-1", ownerId, "down");
      else store.getState().focusAdjacentHomePane("project-1", "down");
    },
    closePane,
    readSplitView,
    ownerId,
    claimTab,
    browserApi,
    createBrowser,
    closeChat: (id: string) => {
      if (ticket) store.getState().removeTicketTabFromSplit("project-1", ownerId, `chat:${id}`);
      else store.getState().removeHomeTabFromSplit("project-1", `chat:${id}`);
      useChatSessionsStore.getState().closeChatTab(ownerId, id);
    },
    unmount: () => act(() => root.unmount()),
    browserFlight: () => browserFlight,
    recordedActive,
    restoredSplit: () => {
      const restored = createProjectUiStore({
        getItem: (name) => data.get(name) ?? null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });
      const projectUi = restored.getState().byProject["project-1"];
      return (
        (ticket ? projectUi?.ticketTabs[ownerId]?.splitView : projectUi?.homeSplitView) ?? null
      );
    },
    guarded: () => guarded,
    provisional: () => provisional,
    remount: () => {
      act(() => root.unmount());
      root = createRoot(container);
      act(() => root.render(<Harness />));
    },
    view: () =>
      projectSplitView(
        provisional.overlaySplitView(readSplitView() ?? emptySplitView(recordedActive())),
        tabIds(),
        provisional.activeOverrideTabId ?? recordedActive(),
        permanentTabId,
      ),
  };
}

const attachment: BlobLinkView = {
  linkId: null,
  blobHash: "a".repeat(64),
  label: "shot.png",
  originalName: "shot.png",
  mime: "image/png",
  sizeBytes: 1,
};

const persisted = (s: ReturnType<typeof surface>) => [...s.data.values()].join();

for (const ticket of [false, true]) {
  const permanent = ticket ? "doc" : "board";
  describe(`provisional Drafts in tab groups — ${ticket ? "Ticket" : "Home"}`, () => {
    const preview = (s: ReturnType<typeof surface>) => {
      if (ticket) s.store.getState().previewTicketFile("project-1", s.ownerId, "readme.md");
      else s.store.getState().previewHomeFile("project-1", "readme.md");
    };
    const select = (s: ReturnType<typeof surface>, tabId: string) => {
      if (ticket) s.store.getState().setTicketActiveTab("project-1", s.ownerId, tabId);
      else s.store.getState().setHomeActiveTab("project-1", tabId);
    };
    /** A live Browser Tab no group holds, selected full width: the group hides. */
    const showOrdinary = (s: ReturnType<typeof surface>) => {
      useBrowserTabsStore.getState().receive(s.browser);
      select(s, "browser:browser-1");
    };
    const openSecond = (s: ReturnType<typeof surface>) => {
      useChatDraftsStore.getState().openProvisional("draft-2", {
        projectId: "project-1",
        ticketId: ticket ? s.ownerId : null,
        title: null,
        operationId: "op-2",
      });
      useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
      useChatSessionsStore.getState().setProvisionalActive(s.ownerId, "draft-2");
    };

    it("renders a new Draft in the focused pane without recording its identity", () => {
      const s = surface(ticket);
      expect(s.view().groupId).toBe("n2");
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([permanent, DRAFT_TAB]);
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      expect(paneForTab(s.readSplitView()!, DRAFT_TAB)).toBeNull();
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      s.remount();
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    });

    it("stacks a new Draft in front of a focused pane that already holds a tab", () => {
      const s = surface(ticket);
      act(() => s.focusPane(OWNER_PANE));
      act(() => openSecond(s));
      expect(s.view().focusedPaneId).toBe(OWNER_PANE);
      expect(s.view().panes[0]).toMatchObject({
        tabIds: [permanent, "chat:draft-2"],
        activeTabId: "chat:draft-2",
      });
      expect(persisted(s)).not.toContain("chat:draft-2");
      act(() => useChatDraftsStore.getState().setDraft("draft-2", "words"));
      expect(paneForTab(s.restoredSplit()!, "chat:draft-2")).toBe(OWNER_PANE);
      expect(s.recordedActive()).toBe("chat:draft-2");
    });

    it("commits first content into its pane's stack and hands back the overlay", () => {
      const s = surface(ticket);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "words"));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, DRAFT_PANE, true);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    for (const content of ["typing", "attachment", "promotion"] as const) {
      it(`saves unfocused ${content} in its pane without stealing focus`, () => {
        const s = surface(ticket);
        const composer = container.querySelector<HTMLTextAreaElement>(
          '[aria-label="Draft composer"]',
        )!;
        composer.focus();
        act(() => s.focusPane(OWNER_PANE));
        expect(document.activeElement).toBe(composer);
        expect(s.provisional().activeOverride).toBeNull();
        const recorded = s.recordedActive();
        act(() => {
          if (content === "typing") {
            composer.value = "background words";
            composer.dispatchEvent(new Event("input", { bubbles: true }));
          } else if (content === "attachment") {
            useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]);
          } else useChatDraftsStore.getState().completePromotion("draft-1");
        });
        expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
        expect(s.readSplitView()?.focusedPaneId).toBe(OWNER_PANE);
        expect(s.recordedActive()).toBe(recorded);
      });
    }

    it("rides a Draft dropped on a pane's edge into the new empty pane, recording only the pane", () => {
      const s = surface(ticket);
      act(() => s.guarded().splitPane(OWNER_PANE, "down", DRAFT_TAB));
      expect(s.view().panes.map((pane) => [pane.id, pane.activeTabId])).toEqual([
        [OWNER_PANE, permanent],
        ["n4", DRAFT_TAB],
        [DRAFT_PANE, null],
      ]);
      expect(s.view().focusedPaneId).toBe("n4");
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      // A refused split moves the renderer-only passenger nowhere.
      const before = s.readSplitView();
      act(() => s.guarded().splitPane("gone", "right", DRAFT_TAB));
      expect(s.readSplitView()).toBe(before);
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    });

    it("moves a Draft into another pane's stack by a centre drop, and refuses a non-pane", () => {
      const s = surface(ticket);
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, OWNER_PANE));
      expect(s.view().focusedPaneId).toBe(OWNER_PANE);
      expect(s.view().panes[0]).toMatchObject({
        tabIds: [permanent, DRAFT_TAB],
        activeTabId: DRAFT_TAB,
      });
      expect(s.view().panes[1]?.activeTabId).toBeNull();
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      const before = s.readSplitView();
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, SPLIT_VIEW_ROOT_PANE_ID));
      expect(s.readSplitView()).toBe(before);
      s.remount();
      expect(s.view().panes[0]?.activeTabId).toBe(DRAFT_TAB);
    });

    it("carries a Draft out of its group to the top strip, closing the empty pane it rode in", () => {
      const s = surface(ticket);
      act(() => s.guarded().ungroupTab(DRAFT_TAB));
      expect(s.writes.ungroupTab).not.toHaveBeenCalled();
      expect(s.readSplitView()).toBeNull();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      act(() => s.guarded().ungroupTab(`chat:real`));
      expect(s.writes.ungroupTab).toHaveBeenCalledExactlyOnceWith("chat:real");
    });

    it("opens a new browser into the focused pane, the Draft keeping its own pane", async () => {
      const s = surface(ticket);
      act(() => s.focusPane(OWNER_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([
        "browser:browser-1",
        DRAFT_TAB,
      ]);
      expect(s.view().panes[0]?.tabIds).toEqual([permanent, "browser:browser-1"]);
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("opens a browser from an empty pane's menu into that pane", async () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane(OWNER_PANE, "down", null));
      await act(async () => {
        container
          .querySelector('[data-pane-id="n4"] [aria-label="New browser"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await s.browserFlight();
      });
      expect(s.view().panes.map((pane) => [pane.id, pane.activeTabId])).toEqual([
        [OWNER_PANE, permanent],
        ["n4", "browser:browser-1"],
        [DRAFT_PANE, DRAFT_TAB],
      ]);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("retains a hidden group's Draft placement while an ordinary tab is shown", () => {
      const s = surface(ticket);
      act(() => showOrdinary(s));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
      expect(s.provisional().activeOverride).toBeNull();
      expect(
        useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)?.get("draft-1"),
      ).toEqual({ paneId: DRAFT_PANE, front: true });
      s.remount();
      expect(s.view().panes).toHaveLength(1);
      act(() => useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]));
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(s.view().panes).toHaveLength(1);
    });

    it("saves a late attachment into a hidden group after the surface unmounts", () => {
      const s = surface(ticket);
      act(() => showOrdinary(s));
      const finish = useChatDraftsStore.getState().beginAttachmentImport("draft-1");
      s.unmount();
      useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]);
      finish();
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("reselecting a hidden Draft reveals its group and focuses its pane", () => {
      const s = surface(ticket);
      act(() => showOrdinary(s));
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      expect(s.view().focusedPaneId).toBe(DRAFT_PANE);
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      act(() => s.focusPane(OWNER_PANE));
      expect(s.provisional().activeOverride).toBeNull();
    });

    it("reselects a typed-then-cleared Draft as the durable tab it became", () => {
      const s = surface(ticket);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "x"));
      act(() => useChatDraftsStore.getState().setDraft("draft-1", ""));
      act(() => showOrdinary(s));
      expect(s.provisional().emptyTabIds.has(DRAFT_TAB)).toBe(false);
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.readSplitView()?.focusedPaneId).toBe(DRAFT_PANE);
      expect(s.recordedActive()).toBe(DRAFT_TAB);
    });

    for (const sameUnderlying of [false, true]) {
      it(`a file opened in the Draft's pane stacks in front of it ${sameUnderlying ? "even if already open" : "on first open"}`, () => {
        const s = surface(ticket);
        if (sameUnderlying) {
          act(() => preview(s));
          act(() => s.provisional().takeActive("draft-1"));
        }
        act(() => preview(s));
        expect(s.provisional().activeOverride).toBeNull();
        expect(s.view().panes[1]).toMatchObject({
          tabIds: ["file:readme.md", DRAFT_TAB],
          activeTabId: "file:readme.md",
        });
        act(() => useChatDraftsStore.getState().setDraft("draft-1", "later"));
        expect(s.claimTab).toHaveBeenLastCalledWith(DRAFT_TAB, DRAFT_PANE, false);
        expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
        expect(s.recordedActive()).toBe("file:readme.md");
        expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      });
    }

    it("unmounted selection sends the Draft to the background before a late import", () => {
      const s = surface(ticket);
      s.unmount();
      preview(s);
      useChatDraftsStore.getState().setDraft("draft-1", "late import");
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, DRAFT_PANE, false);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
      expect(s.recordedActive()).toBe("file:readme.md");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("an explicit workspace open uncovers the same underlying tab", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      act(() => {
        if (ticket)
          s.store.getState().openTicketView("project-1", s.ownerId, { tabId: "browser:browser-1" });
        else s.store.getState().openHome("project-1", "browser:browser-1");
      });
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes[1]?.activeTabId).toBe("browser:browser-1");
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("closing the Draft's empty pane dissolves the group and leaves the Draft full width", () => {
      const s = surface(ticket);
      act(() => s.closePane(DRAFT_PANE));
      expect(s.readSplitView()).toBeNull();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "content"));
      expect(s.recordedActive()).toBe(DRAFT_TAB);
    });

    it("a closed destination does not cover a later browser selection", async () => {
      const s = surface(ticket);
      act(() => s.closePane(DRAFT_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
      expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toContain("draft-1");
    });

    it("stacks several empty Drafts in one pane, only the newest in front", () => {
      const s = surface(ticket);
      act(() => openSecond(s));
      expect(s.view().panes[1]).toMatchObject({
        tabIds: [DRAFT_TAB, "chat:draft-2"],
        activeTabId: "chat:draft-2",
      });
      expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toEqual(["draft-1", "draft-2"]);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "background"));
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(DRAFT_PANE);
      expect(s.view().panes[1]?.activeTabId).toBe("chat:draft-2");
      expect(persisted(s)).not.toContain("chat:draft-2");
      act(() => useChatSessionsStore.getState().dropChatTabs([s.ownerId]));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("reacquires one foreground Draft after its group dissolves", async () => {
      const s = surface(ticket);
      act(() => openSecond(s));
      act(() => s.closePane(DRAFT_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      for (const id of ["draft-1", "draft-2"]) {
        act(() => s.provisional().takeActive(id));
        expect(s.view().panes[0]?.activeTabId).toBe(`chat:${id}`);
      }
      expect(
        [...useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)!.values()].filter(
          (placement) => placement.front,
        ),
      ).toHaveLength(1);
    });

    for (const failure of ["refusal", "exception"] as const) {
      it(`surfaces browser ${failure} without changing a local Draft's placement`, async () => {
        const s = surface(ticket);
        act(() => s.provisional().releaseActive());
        if (failure === "refusal")
          s.browserApi.open.mockResolvedValueOnce({ ok: false, error: "offline" });
        else s.browserApi.open.mockRejectedValueOnce(new Error("offline"));
        const before = s.readSplitView();
        await act(async () => {
          await s.createBrowser();
        });
        expect(toastError).toHaveBeenCalledWith("Could not open Browser Tab: offline");
        expect(s.readSplitView()).toBe(before);
        expect(useBrowserTabsStore.getState().byId).toEqual({});
        expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toContain("draft-1");
      });
    }

    it("filters every layout write and cleans renderer-only placement when closed", () => {
      const s = surface(ticket);
      act(() => s.guarded().reorderSurface("other", [DRAFT_TAB, "other"]));
      act(() => s.guarded().reorderPane(DRAFT_PANE, "other", [DRAFT_TAB, "other"]));
      act(() => s.guarded().reorderSurface(DRAFT_TAB, [DRAFT_TAB, "other"]));
      act(() => s.guarded().reorderPane(DRAFT_PANE, DRAFT_TAB, [DRAFT_TAB, "other"]));
      expect(s.writes.reorderSurface).toHaveBeenCalledExactlyOnceWith("other", ["other"]);
      expect(s.writes.reorderPane).toHaveBeenCalledExactlyOnceWith(DRAFT_PANE, "other", ["other"]);
      act(() => s.guarded().activateTab(DRAFT_TAB, { type: "file" } as never));
      expect(s.writes.activateTab).not.toHaveBeenCalled();
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      act(() => s.provisional().releaseActive());
      expect(s.view().panes[1]?.tabIds).toEqual([DRAFT_TAB]);
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      act(() => s.closeChat("draft-1"));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      expect(s.view().panes.some((pane) => pane.tabIds.includes(DRAFT_TAB))).toBe(false);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("stale-tab receipt cannot persist a background empty Draft or change pane focus", () => {
      const s = surface(ticket, { oldChat: true });
      act(() => s.provisional().releaseActive());
      act(() => s.focusPane(OWNER_PANE));
      act(() => s.closeChat("old"));
      expect(s.provisional().activeOverride).toBeNull();
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "earned content"));
      expect(s.recordedActive()).not.toBe(DRAFT_TAB);
    });
  });
}

for (const ticket of [false, true]) {
  const permanent = ticket ? "doc" : "board";
  describe(`${ticket ? "Ticket" : "Home"} top-strip edge grouping with Drafts`, () => {
    /** The Draft full width, beside an ordinary Browser Tab and no group at all. */
    const setup = async () => {
      const s = surface(ticket);
      act(() => {
        s.closePane(DRAFT_PANE);
        s.provisional().releaseActive();
      });
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.readSplitView()).toBeNull();
      return s;
    };

    it("rides a dragged Draft into an empty pane opened on the target's edge", async () => {
      const s = await setup();
      act(() => s.provisional().groupTabs("browser:browser-1", DRAFT_TAB, "left", s.writeGroup));
      expect(s.writeGroup).toHaveBeenCalledExactlyOnceWith("browser:browser-1", null, "left");
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([
        DRAFT_TAB,
        "browser:browser-1",
      ]);
      expect(s.view().focusedPaneId).toBe(s.view().panes[0]!.id);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "earned"));
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe(s.view().panes[0]!.id);
    });

    it("mirrors round the incoming tab when the Draft is the target", async () => {
      const s = await setup();
      act(() => s.provisional().groupTabs(DRAFT_TAB, "browser:browser-1", "left", s.writeGroup));
      expect(s.writeGroup).toHaveBeenCalledExactlyOnceWith("browser:browser-1", null, "right");
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([
        "browser:browser-1",
        DRAFT_TAB,
      ]);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("re-groups a Draft without leaving its former empty pane behind", async () => {
      const s = await setup();
      act(() => s.provisional().groupTabs("browser:browser-1", DRAFT_TAB, "right", s.writeGroup));
      const first = s.readSplitView()!.pairs[0]!;
      act(() => s.provisional().groupTabs(permanent, DRAFT_TAB, "right", s.writeGroup));
      // The first group's empty pane closed with the Draft gone, dissolving it.
      expect(groupForTab(s.readSplitView(), "browser:browser-1")).toBeNull();
      expect(s.readSplitView()!.pairs.map((group) => group.id)).not.toContain(first.id);
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([permanent, DRAFT_TAB]);
      expect(persisted(s)).not.toContain(DRAFT_TAB);
    });

    it("leaves two Drafts local, and hands real tabs to the writers as they are", async () => {
      const s = await setup();
      act(() => {
        useChatDraftsStore.getState().openProvisional("draft-2", {
          projectId: "project-1",
          ticketId: ticket ? s.ownerId : null,
          title: null,
          operationId: "op-2",
        });
        useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
      });
      act(() => s.provisional().groupTabs(DRAFT_TAB, "chat:draft-2", "right", s.writeGroup));
      act(() => s.provisional().groupTabs(DRAFT_TAB, DRAFT_TAB, "right", s.writeGroup));
      expect(s.writeGroup).not.toHaveBeenCalled();
      act(() => s.provisional().groupTabs("chat:real", "browser:real", "down", s.writeGroup));
      expect(s.writeGroup).toHaveBeenCalledExactlyOnceWith("chat:real", "browser:real", "down");
      act(() => s.provisional().ungroupTab("chat:real", s.writeUngroup));
      expect(s.writeUngroup).toHaveBeenCalledExactlyOnceWith("chat:real");
    });

    it("moves no Draft when the write is refused", async () => {
      const s = await setup();
      const refuse = vi.fn();
      act(() => s.provisional().groupTabs("browser:browser-1", DRAFT_TAB, "right", refuse));
      expect(refuse).toHaveBeenCalledOnce();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
    });

    it("ungroups a Draft from its pane by closing the empty pane it rode in", async () => {
      const s = await setup();
      act(() => s.provisional().groupTabs("browser:browser-1", DRAFT_TAB, "right", s.writeGroup));
      act(() => s.provisional().ungroupTab(DRAFT_TAB, s.writeUngroup));
      expect(s.writeUngroup).not.toHaveBeenCalled();
      expect(s.readSplitView()).toBeNull();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      act(() => s.closeChat("draft-1"));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });
  });
}
