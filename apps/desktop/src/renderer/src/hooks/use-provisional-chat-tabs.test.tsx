// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  projectSplitView,
  pairForTab,
  groupedSplitView,
  SPLIT_VIEW_ROOT_PANE_ID,
  type BlobLinkView,
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
 * The pair's first member — the Board/Body the pending partner opened beside.
 * Never `root`: that id names the full-width pane (VC-614), so the member is
 * named under its pair (`n2`, the second id minted after the partner `n1`).
 */
const OWNER_PANE = "n2:first";
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
    splitPane: (paneId, edge, tabId, surfaceTabIds) => {
      const opts = { ...(tabId === null ? {} : { tabId }), surfaceTabIds };
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
    openPayload: vi.fn(),
    reorderPane: vi.fn(),
    reorderSurface: vi.fn(),
  };
  const writePair = vi.fn((first: string | null, second: string | null) => {
    if (ticket) store.getState().pairTicketTabs("project-1", ownerId, first, second);
    else store.getState().pairHomeTabs("project-1", first, second);
  });
  const writeUnpair = vi.fn((tabId: string) => {
    if (ticket) store.getState().unpairTicketTab("project-1", ownerId, tabId);
    else store.getState().unpairHomeTab("project-1", tabId);
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
      (tabId) => {
        provisional.releaseActive();
        if (ticket) store.getState().setTicketActiveTab("project-1", ownerId, tabId);
        else store.getState().setHomeActiveTab("project-1", tabId);
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
    const split = readSplitView() ?? groupedSplitView([], recorded);
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
  writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "right", null, oldChat ? ["chat:old"] : []);
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
    writes,
    writePair,
    writeUnpair,
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
        provisional.overlaySplitView(readSplitView() ?? groupedSplitView([], recordedActive())),
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

for (const ticket of [false, true]) {
  describe(`provisional grouped layout — ${ticket ? "Ticket" : "Home"}`, () => {
    const preview = (s: ReturnType<typeof surface>) => {
      if (ticket) s.store.getState().previewTicketFile("project-1", s.ownerId, "readme.md");
      else s.store.getState().previewHomeFile("project-1", "readme.md");
    };
    const select = (s: ReturnType<typeof surface>, tabId: string) => {
      if (ticket) s.store.getState().setTicketActiveTab("project-1", s.ownerId, tabId);
      else s.store.getState().setHomeActiveTab("project-1", tabId);
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

    it("renders a local Draft in the pending partner without recording its identity", () => {
      const s = surface(ticket);
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([
        ticket ? "doc" : "board",
        DRAFT_TAB,
      ]);
      expect(s.provisional().activeOverridePaneId).toBe("n1");
      expect(s.readSplitView()?.pairs?.[0]?.second.activeTabId).toBeNull();
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      s.remount();
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    });

    it("commits first content into the pending member and hands back the overlay", () => {
      const s = surface(ticket);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "words"));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", true);
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)?.second.id).toBe("n1");
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    for (const content of ["typing", "attachment", "promotion"] as const) {
      it(`saves unfocused ${content} in its pending slot without stealing focus`, () => {
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
        expect(pairForTab(s.restoredSplit(), DRAFT_TAB)?.second.id).toBe("n1");
        expect(s.readSplitView()?.focusedPaneId).toBe(OWNER_PANE);
        expect(s.recordedActive()).toBe(recorded);
      });
    }

    it("does not split a pending pair into an arbitrary third pane or move its Draft on refusal", () => {
      const s = surface(ticket);
      const before = s.readSplitView();
      act(() => s.guarded().splitPane(OWNER_PANE, "down", DRAFT_TAB, [DRAFT_TAB]));
      act(() => s.writes.splitPane("n1", "down", null, []));
      expect(s.readSplitView()).toBe(before);
      expect(s.view().panes).toHaveLength(2);
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("refuses a centre move into an occupied member without moving the empty Draft", () => {
      const s = surface(ticket);
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, OWNER_PANE));
      expect(s.view().panes[0]?.activeTabId).toBe(ticket ? "doc" : "board");
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect(s.provisional().activeOverridePaneId).toBe("n1");
    });

    it("moves an ordinary local Draft into an explicitly focused empty partner", () => {
      const s = surface(ticket);
      act(() => s.closePane("n1"));
      act(() => s.provisional().releaseActive());
      act(() => s.writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "down", null, []));
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, "n3"));
      expect(s.view().focusedPaneId).toBe("n3");
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      s.remount();
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    });

    it("retains a hidden pending destination when an unrelated browser is selected", async () => {
      const s = surface(ticket);
      act(() => s.focusPane(OWNER_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
      expect(s.provisional().activeOverride).toBeNull();
      expect(
        useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)?.get("draft-1"),
      ).toEqual({ paneId: "n1", front: true });
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      s.remount();
      expect(s.view().panes).toHaveLength(1);
      act(() => useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]));
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)?.second.id).toBe("n1");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(s.view().panes).toHaveLength(1);
    });

    it("saves a late attachment to a hidden pending pair after the surface unmounts", async () => {
      const s = surface(ticket);
      act(() => s.focusPane(OWNER_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      const finish = useChatDraftsStore.getState().beginAttachmentImport("draft-1");
      s.unmount();
      await Promise.resolve().then(() => {
        useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]);
        finish();
      });
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)?.second.id).toBe("n1");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("a browser filling the pending slot leaves the inactive Draft ordinary, not in a hidden stack", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.view().panes[1]?.activeTabId).toBe("browser:browser-1");
      expect(s.view().panes[1]?.tabIds).toEqual(["browser:browser-1"]);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "background"));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", false);
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)).toBeNull();
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      act(() => select(s, DRAFT_TAB));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
    });

    it("fronting a Draft over a full member commits it as an ordinary tab, without replacing the pair", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "ordinary"));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      expect(pairForTab(s.restoredSplit(), "browser:browser-1")).not.toBeNull();
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)).toBeNull();
    });

    it("reselects a typed-then-cleared paired Draft as a durable member", async () => {
      const s = surface(ticket);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "x"));
      act(() => useChatDraftsStore.getState().setDraft("draft-1", ""));
      act(() => s.focusPane(OWNER_PANE));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.provisional().emptyTabIds.has(DRAFT_TAB)).toBe(false);
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.readSplitView()?.focusedPaneId).toBe("n1");
      expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    });

    for (const sameUnderlying of [false, true]) {
      it(`file preview dismisses the local Draft ${sameUnderlying ? "even if already active" : "on first open"}`, () => {
        const s = surface(ticket);
        if (sameUnderlying) {
          act(() => preview(s));
          act(() => s.provisional().takeActive("draft-1"));
        }
        act(() => preview(s));
        expect(s.provisional().activeOverride).toBeNull();
        expect(s.view().panes[1]?.activeTabId).toBe("file:readme.md");
        act(() => useChatDraftsStore.getState().setDraft("draft-1", "later"));
        expect(pairForTab(s.restoredSplit(), DRAFT_TAB)).toBeNull();
        expect(s.view().panes[1]?.tabIds).toEqual(["file:readme.md"]);
        expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      });
    }

    it("unmounted selection deactivates the Draft before a late import becomes ordinary", () => {
      const s = surface(ticket);
      s.unmount();
      preview(s);
      useChatDraftsStore.getState().setDraft("draft-1", "late import");
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", false);
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)).toBeNull();
      expect(s.recordedActive()).toBe("file:readme.md");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("an explicit workspace open uncovers the same underlying browser", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      act(() => s.provisional().takeActive("draft-1"));
      act(() => {
        if (ticket)
          s.store.getState().openTicketView("project-1", s.ownerId, { tabId: "browser:browser-1" });
        else s.store.getState().openHome("project-1", "browser:browser-1");
      });
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes[1]?.activeTabId).toBe("browser:browser-1");
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("closing the pending partner returns its local Draft to the ordinary surface", () => {
      const s = surface(ticket);
      act(() => s.closePane("n1"));
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual([DRAFT_TAB]);
      expect(s.provisional().activeOverridePaneId).toBe(SPLIT_VIEW_ROOT_PANE_ID);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "content"));
      expect(s.recordedActive()).toBe(DRAFT_TAB);
    });

    it("a closed destination does not cover a later browser selection", async () => {
      const s = surface(ticket);
      act(() => s.closePane("n1"));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes.map((pane) => pane.activeTabId)).toEqual(["browser:browser-1"]);
      expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toContain("draft-1");
    });

    it("owns multiple empty Drafts as ordinary tabs without making a per-pane stack", () => {
      const s = surface(ticket);
      act(() => openSecond(s));
      expect(s.view().panes[1]?.tabIds).toEqual(["chat:draft-2"]);
      expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toEqual(["draft-1", "draft-2"]);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "background"));
      expect(pairForTab(s.restoredSplit(), DRAFT_TAB)).toBeNull();
      expect(s.view().panes[1]?.activeTabId).toBe("chat:draft-2");
      act(() => useChatSessionsStore.getState().dropChatTabs([s.ownerId]));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
    });

    it("reacquires one foreground Draft after its pair dissolves", async () => {
      const s = surface(ticket);
      act(() => openSecond(s));
      act(() => s.closePane("n1"));
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
          container
            .querySelector('[data-pane-id="n1"] [aria-label="New browser"]')!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await s.browserFlight();
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
      act(() => s.guarded().reorderPane("n1", "other", [DRAFT_TAB, "other"]));
      act(() => s.guarded().reorderSurface(DRAFT_TAB, [DRAFT_TAB, "other"]));
      act(() => s.guarded().reorderPane("n1", DRAFT_TAB, [DRAFT_TAB, "other"]));
      expect(s.writes.reorderSurface).toHaveBeenCalledExactlyOnceWith("other", ["other"]);
      expect(s.writes.reorderPane).toHaveBeenCalledExactlyOnceWith("n1", "other", ["other"]);
      act(() => s.provisional().releaseActive());
      expect(s.view().panes[1]?.tabIds).toEqual([]);
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      act(() => s.closeChat("draft-1"));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      expect(s.view().panes.some((pane) => pane.tabIds.includes(DRAFT_TAB))).toBe(false);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("stale-tab receipt cannot persist a background empty Draft or change pane focus", () => {
      const s = surface(ticket, { oldChat: true });
      act(() => s.provisional().releaseActive());
      act(() => s.focusPane(OWNER_PANE));
      act(() => s.closeChat("old"));
      expect(s.provisional().activeOverride).toBeNull();
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "earned content"));
      expect(s.recordedActive()).not.toBe(DRAFT_TAB);
    });
  });
}

for (const ticket of [false, true]) {
  it(`${ticket ? "Ticket" : "Home"} reselects a hidden empty Draft in its retained pending partner`, async () => {
    const s = surface(ticket);
    act(() => s.focusPane(OWNER_PANE));
    await act(async () => {
      await s.createBrowser();
    });
    act(() => s.provisional().takeActive("draft-1"));
    expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
    expect(s.view().focusedPaneId).toBe("n1");
    expect(s.view().panes[1]?.activeTabId).toBe(DRAFT_TAB);
    expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    act(() => s.focusPane(OWNER_PANE));
    expect(s.provisional().activeOverride).toBeNull();
  });
}

for (const ticket of [false, true]) {
  for (const draftFirst of [false, true]) {
    describe(`${ticket ? "Ticket" : "Home"} explicit empty Draft ${draftFirst ? "left" : "right"} pair`, () => {
      const setup = async () => {
        const s = surface(ticket);
        act(() => {
          s.closePane("n1");
          s.provisional().releaseActive();
        });
        await act(async () => {
          await s.createBrowser();
        });
        const ids = draftFirst
          ? [DRAFT_TAB, "browser:browser-1"]
          : ["browser:browser-1", DRAFT_TAB];
        act(() => s.provisional().pairTabs(ids[0]!, ids[1]!, s.writePair));
        return s;
      };
      it("writes only the real anchor, renders exact order, retains hidden placement and commits first content there", async () => {
        const s = await setup();
        expect(s.writePair).toHaveBeenCalledExactlyOnceWith(
          draftFirst ? null : "browser:browser-1",
          draftFirst ? "browser:browser-1" : null,
        );
        const pair = s.readSplitView()!.pairs![0]!;
        const slot = draftFirst ? pair.first : pair.second;
        const anchor = draftFirst ? pair.second : pair.first;
        expect(s.readSplitView()!.focusedPaneId).toBe(slot.id);
        expect(s.recordedActive()).toBe("browser:browser-1");
        expect(s.view().panes.map((p) => p.activeTabId)).toEqual(
          draftFirst ? [DRAFT_TAB, "browser:browser-1"] : ["browser:browser-1", DRAFT_TAB],
        );
        expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
        s.remount();
        expect(s.view().panes).toHaveLength(2);
        act(() => {
          s.focusPane(anchor.id);
          s.provisional().releaseActive();
        });
        act(() => {
          if (ticket) s.store.getState().setTicketActiveTab("project-1", s.ownerId, "doc");
          else s.store.getState().setHomeActiveTab("project-1", "board");
        });
        expect(s.view().panes).toHaveLength(1);
        act(() => s.provisional().takeActive("draft-1"));
        expect(s.view().focusedPaneId).toBe(slot.id);
        expect(s.view().panes).toHaveLength(2);
        act(() => s.focusPane(anchor.id));
        act(() => useChatDraftsStore.getState().setDraft("draft-1", "earned"));
        expect(pairForTab(s.restoredSplit(), DRAFT_TAB)?.[draftFirst ? "first" : "second"].id).toBe(
          slot.id,
        );
        expect(s.readSplitView()!.focusedPaneId).toBe(anchor.id);
        expect(s.recordedActive()).toBe("browser:browser-1");
      });
      it("re-pairs a local passenger without leaving its former anchor paired to a ghost menu", async () => {
        const s = await setup();
        const oldPair = s.readSplitView()!.pairs![0]!;
        const real = ticket ? "doc" : "board";
        act(() =>
          s
            .provisional()
            .pairTabs(draftFirst ? DRAFT_TAB : real, draftFirst ? real : DRAFT_TAB, s.writePair),
        );
        expect(s.readSplitView()!.pairs).toHaveLength(1);
        expect(s.readSplitView()!.pairs![0]!.id).not.toBe(oldPair.id);
        expect(pairForTab(s.readSplitView(), "browser:browser-1")).toBeNull();
        expect(s.view().panes.map((p) => p.activeTabId)).toEqual(
          draftFirst ? [DRAFT_TAB, real] : [real, DRAFT_TAB],
        );
        expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
      });
      it("dissolves by placeholder pane before drag-out or close, without writing an empty ID", async () => {
        const s = await setup();
        const slot = (
          draftFirst ? s.readSplitView()!.pairs![0]!.first : s.readSplitView()!.pairs![0]!.second
        ).id;
        const close = vi.fn(s.closePane);
        act(() => s.provisional().unpairTab(DRAFT_TAB, s.writeUnpair, close));
        expect(close).toHaveBeenCalledExactlyOnceWith(slot);
        expect(s.writeUnpair).not.toHaveBeenCalled();
        expect(s.readSplitView()).toBeNull();
        expect(s.view().panes.map((p) => p.activeTabId)).toEqual([DRAFT_TAB]);
        expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
        act(() => s.closeChat("draft-1"));
        expect(s.view().panes.map((p) => p.activeTabId)).toEqual(["browser:browser-1"]);
        expect(useProvisionalPaneLayoutStore.getState().byOwner.has(s.ownerId)).toBe(false);
      });
    });
  }
  it(`${ticket ? "Ticket" : "Home"} guards empty/empty and refused pairing, while real pairs/unpairs use their normal writers`, () => {
    const s = surface(ticket);
    const refuse = vi.fn();
    const before = s.provisional().activeOverridePaneId;
    act(() => s.provisional().pairTabs(DRAFT_TAB, DRAFT_TAB, refuse));
    act(() => s.provisional().pairTabs(DRAFT_TAB, "browser:missing", refuse));
    expect(s.provisional().activeOverridePaneId).toBe(before);
    act(() => {
      useChatDraftsStore.getState().openProvisional("draft-2", {
        projectId: "project-1",
        ticketId: ticket ? s.ownerId : null,
        title: null,
        operationId: "op-2",
      });
      useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
    });
    refuse.mockClear();
    act(() => s.provisional().pairTabs(DRAFT_TAB, "chat:draft-2", refuse));
    expect(refuse).not.toHaveBeenCalled();
    act(() => s.provisional().pairTabs("chat:real", "browser:real", s.writePair));
    expect(s.writePair).toHaveBeenCalledExactlyOnceWith("chat:real", "browser:real");
    act(() => s.provisional().unpairTab("chat:real", s.writeUnpair, s.closePane));
    expect(s.writeUnpair).toHaveBeenCalledExactlyOnceWith("chat:real");
  });
}
