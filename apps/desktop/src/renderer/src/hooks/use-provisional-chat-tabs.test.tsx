// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  paneForTab,
  resolveSplitView,
  singlePaneSplitView,
  splitViewPanes,
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
import { createWorkspaceStore } from "@renderer/stores/workspace";
import { useProvisionalChatTabs, type ProvisionalChatTabs } from "./use-provisional-chat-tabs";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const NO_CHATS: readonly string[] = [];
const DRAFT_TAB = "chat:draft-1";
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
  const store = createWorkspaceStore(
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
    const workspace = store.getState().byProject["project-1"];
    return (ticket ? workspace?.ticketTabs[ownerId]?.splitView : workspace?.homeSplitView) ?? null;
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
    const split = readSplitView() ?? singlePaneSplitView([], recorded, SPLIT_VIEW_ROOT_PANE_ID);
    const view = resolveSplitView(provisional.overlaySplitView(split), tabIds(), permanentTabId);
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
    store.getState().setHomeActiveTab("project-1", "chat:old");
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
      const restored = createWorkspaceStore({
        getItem: (name) => data.get(name) ?? null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      });
      const workspace = restored.getState().byProject["project-1"];
      return (
        (ticket ? workspace?.ticketTabs[ownerId]?.splitView : workspace?.homeSplitView) ?? null
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
      resolveSplitView(
        provisional.overlaySplitView(
          readSplitView() ?? singlePaneSplitView([], recordedActive(), SPLIT_VIEW_ROOT_PANE_ID),
        ),
        tabIds(),
        permanentTabId,
      ),
  };
}

it("Home's stale-tab receipt never persists an unfocused empty Draft or selects its pane when it gains content", () => {
  const s = surface(false, { oldChat: true });
  act(() => s.writes.splitPane("n1", "down", null, []));
  act(() => s.closeChat("old"));
  expect(s.provisional().activeOverride).toBeNull();
  expect(s.readSplitView()?.focusedPaneId).toBe("n3");
  expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
  act(() => useChatDraftsStore.getState().setDraft("draft-1", "earned content"));
  expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
  expect(s.readSplitView()?.focusedPaneId).toBe("n3");
});

it("Ticket's stale-tab receipt preserves a background Draft and focused empty pane", () => {
  const s = surface(true);
  act(() => s.guarded().moveTabToPane(DRAFT_TAB, SPLIT_VIEW_ROOT_PANE_ID));
  act(() => s.focusPane("n1"));
  act(() => s.store.getState().recordResolvedTicketTab("project-1", s.ownerId, "missing-terminal"));
  const split = s.readSplitView();
  act(() => s.store.getState().recordResolvedTicketTab("project-1", s.ownerId, "doc"));
  expect(s.recordedActive()).toBe("doc");
  expect(s.readSplitView()).toBe(split);
  expect(s.readSplitView()?.focusedPaneId).toBe("n1");
  expect(s.view().panes.find((pane) => pane.id === SPLIT_VIEW_ROOT_PANE_ID)?.activeTabId).toBe(
    DRAFT_TAB,
  );
  expect(
    useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)?.get("draft-1")?.front,
  ).toBe(true);
  expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
});

for (const ticket of [false, true]) {
  describe(`provisional pane layout — ${ticket ? "Ticket" : "Home"}`, () => {
    it("closes the empty source after moving and splitting a Draft elsewhere, without teleporting it", () => {
      const s = surface(ticket);
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, SPLIT_VIEW_ROOT_PANE_ID));
      act(() => s.guarded().splitPane(SPLIT_VIEW_ROOT_PANE_ID, "down", DRAFT_TAB, [DRAFT_TAB]));
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe(DRAFT_TAB);

      const emptyPane = container.querySelector('[data-pane-id="n1"]')!;
      const close = emptyPane.querySelector('[aria-label="Close pane"]')!;
      // The pointer-down that precedes a real click focuses the source. It must
      // not replace this row with the Draft and swallow the subsequent click.
      act(() => close.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      expect(s.view().focusedPaneId).toBe("n1");
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBeNull();
      expect(s.provisional().activeOverride).toBeNull();
      expect(emptyPane.contains(close)).toBe(true);
      act(() => close.dispatchEvent(new MouseEvent("click", { bubbles: true })));

      expect(s.view().panes.map((pane) => pane.id)).toEqual([SPLIT_VIEW_ROOT_PANE_ID, "n3"]);
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe(DRAFT_TAB);
      expect(JSON.stringify(s.readSplitView())).not.toContain(DRAFT_TAB);
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("saves typing in the still-DOM-focused composer after keyboard pane focus moves", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      act(() => s.focusPane("n1"));
      const composer = container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Draft composer"]',
      )!;
      composer.focus();
      act(() => s.focusDown());
      const recorded = s.recordedActive();
      expect(document.activeElement).toBe(composer);
      expect(s.provisional().activeOverride).toBeNull();
      act(() => {
        composer.value = "background words";
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", true);
      expect(paneForTab(s.readSplitView()!, DRAFT_TAB)).toBe("n1");
      expect(s.readSplitView()?.focusedPaneId).toBe("n3");
      expect(s.recordedActive()).toBe(recorded);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)).toBeUndefined();
    });

    it("opens a browser in a neighboring empty pane without moving or forgetting the empty Draft", async () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      const row = container.querySelector('[data-pane-id="n3"] [aria-label="New browser"]')!;
      await act(async () => {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await s.browserFlight();
      });
      expect(s.browserApi.open).toHaveBeenCalledWith({
        projectId: "project-1",
        ...(ticket ? { ticketId: "ticket-1" } : {}),
        url: BROWSER_START_URL,
      });
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe(
        "browser:browser-1",
      );
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.view().panes[0]?.tabIds).not.toContain(DRAFT_TAB);
      expect(s.readSplitView()?.focusedPaneId).toBe("n3");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(useChatSessionsStore.getState().openTabs[s.ownerId]).toContain("draft-1");
      expect(JSON.stringify(s.readSplitView())).not.toContain(DRAFT_TAB);
      s.remount();
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      act(() => s.focusPane("n1"));
      expect(s.provisional().activeOverride).toBe("draft-1");
    });

    it("saves an attachment that finishes after a neighboring browser took focus", async () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      await act(async () => {
        container
          .querySelector('[data-pane-id="n3"] [aria-label="New browser"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await s.browserFlight();
      });
      const attachment: BlobLinkView = {
        linkId: null,
        blobHash: "a".repeat(64),
        label: "shot.png",
        originalName: "shot.png",
        mime: "image/png",
        sizeBytes: 1,
      };
      act(() => useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", true);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
      expect(s.readSplitView()?.focusedPaneId).toBe("n3");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
    });

    it("reselects a typed-then-cleared Draft with a durable pane claim", async () => {
      const s = surface(ticket);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "x"));
      act(() => useChatDraftsStore.getState().setDraft("draft-1", ""));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.provisional().emptyTabIds.has(DRAFT_TAB)).toBe(false);
      act(() => s.focusPane(SPLIT_VIEW_ROOT_PANE_ID));
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.readSplitView()?.focusedPaneId).toBe("n1");
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "again"));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
    });

    it("a durable tab moved into a background Draft pane comes to front without relocating the Draft", () => {
      const s = surface(ticket, { oldChat: true });
      act(() => s.focusPane(SPLIT_VIEW_ROOT_PANE_ID));
      act(() => s.provisional().releaseActive());
      act(() => s.guarded().moveTabToPane("chat:old", "n1"));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe("chat:old");
      expect(s.view().panes.find((pane) => pane.id === "n1")?.tabIds).toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "background"));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe("chat:old");
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
    });

    for (const sameUnderlying of [false, true]) {
      it(`direct file preview dismisses the Draft ${sameUnderlying ? "even when the saved file is already active" : "when opening a new file"}`, () => {
        const s = surface(ticket);
        const preview = () => {
          if (ticket) s.store.getState().previewTicketFile("project-1", s.ownerId, "readme.md");
          else s.store.getState().previewHomeFile("project-1", "readme.md");
        };
        if (sameUnderlying) {
          act(preview);
          act(() => s.provisional().takeActive("draft-1"));
          expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
        }
        act(preview);
        expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe("file:readme.md");
        expect(s.provisional().activeOverride).toBeNull();
        act(() => useChatDraftsStore.getState().setDraft("draft-1", "later"));
        expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
        expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe("file:readme.md");
      });
    }

    it("direct workspace open dismisses a Draft covering the same already-active browser", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      act(() => {
        if (ticket)
          s.store
            .getState()
            .openTicketWorkspace("project-1", s.ownerId, { tabId: "browser:browser-1" });
        else s.store.getState().openHome("project-1", "browser:browser-1");
      });
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(
        "browser:browser-1",
      );
      expect(s.provisional().activeOverride).toBeNull();
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("unmounted selection deactivates foreground before a late import saves the claim", () => {
      const s = surface(ticket);
      s.unmount();
      if (ticket) s.store.getState().previewTicketFile("project-1", s.ownerId, "readme.md");
      else s.store.getState().previewHomeFile("project-1", "readme.md");
      useChatDraftsStore.getState().setDraft("draft-1", "finished import");
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", false);
      expect(splitViewPanes(s.readSplitView()!).find((pane) => pane.id === "n1")?.activeTabId).toBe(
        "file:readme.md",
      );
    });

    it("saves attachment completion after the surface unmounts, before revisiting or relaunch", async () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      await act(async () => {
        container
          .querySelector('[data-pane-id="n3"] [aria-label="New browser"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await s.browserFlight();
      });
      const finishImport = useChatDraftsStore.getState().beginAttachmentImport("draft-1");
      s.unmount();
      const attachment: BlobLinkView = {
        linkId: null,
        blobHash: "b".repeat(64),
        label: "late.png",
        originalName: "late.png",
        mime: "image/png",
        sizeBytes: 1,
      };
      await Promise.resolve().then(() => {
        useChatDraftsStore.getState().setDraftAttachments("draft-1", [attachment]);
        finishImport();
      });
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", true);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
      expect(s.readSplitView()?.focusedPaneId).toBe("n3");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)).toBeUndefined();
    });

    for (const keepSplit of [false, true]) {
      it(`releases a closed destination's Draft when selecting a browser ${keepSplit ? "while still split" : "after collapse to unsplit"}`, async () => {
        const s = surface(ticket);
        if (keepSplit) act(() => s.writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "down", null, []));
        act(() => s.closePane("n1"));
        if (keepSplit) act(() => s.focusPane(SPLIT_VIEW_ROOT_PANE_ID));
        await act(async () => {
          await s.createBrowser();
        });
        expect(s.provisional().activeOverride).toBeNull();
        expect(s.view().panes[0]?.activeTabId).toBe("browser:browser-1");
        expect(s.view().panes[0]?.tabIds).toContain(DRAFT_TAB);
        expect(s.recordedActive()).toBe("browser:browser-1");
      });
    }

    it("opening a new Draft deactivates an older Draft whose destination collapsed", () => {
      const s = surface(ticket);
      act(() => s.closePane("n1"));
      act(() => {
        useChatDraftsStore.getState().openProvisional("draft-2", {
          projectId: "project-1",
          ticketId: ticket ? s.ownerId : null,
          title: null,
          operationId: "op-2",
        });
        useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
        useChatSessionsStore.getState().setProvisionalActive(s.ownerId, "draft-2");
      });
      expect(s.view().panes[0]?.activeTabId).toBe("chat:draft-2");
      const placements = useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)!;
      expect(placements.get("draft-1")?.front).toBe(false);
      expect(placements.get("draft-2")?.front).toBe(true);
      act(() => useChatDraftsStore.getState().setDraft("draft-2", "content"));
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes[0]?.activeTabId).toBe("chat:draft-2");
    });

    it("reacquires one foreground Draft after multiple destinations collapse to primary", async () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      act(() => {
        useChatDraftsStore.getState().openProvisional("draft-2", {
          projectId: "project-1",
          ticketId: ticket ? s.ownerId : null,
          title: null,
          operationId: "op-2",
        });
        useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
        useChatSessionsStore.getState().setProvisionalActive(s.ownerId, "draft-2");
      });
      act(() => s.closePane("n1"));
      act(() => s.closePane("n3"));
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.provisional().activeOverride).toBeNull();
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.view().panes[0]?.activeTabId).toBe(DRAFT_TAB);
      act(() => s.provisional().takeActive("draft-2"));
      expect(s.view().panes[0]?.activeTabId).toBe("chat:draft-2");
      expect(
        [...useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)!.values()].filter(
          (placement) => placement.front,
        ),
      ).toHaveLength(1);
    });

    it("saves a background Draft without replacing the browser selected in that same pane", async () => {
      const s = surface(ticket);
      await act(async () => {
        await s.createBrowser();
      });
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(
        "browser:browser-1",
      );
      expect(s.view().panes.find((pane) => pane.id === "n1")?.tabIds).toContain(DRAFT_TAB);
      act(() => useChatDraftsStore.getState().setDraft("draft-1", "background content"));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", false);
      expect(paneForTab(s.restoredSplit()!, DRAFT_TAB)).toBe("n1");
      expect(s.recordedActive()).toBe("browser:browser-1");
      expect(s.readSplitView()?.focusedPaneId).toBe("n1");
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(
        "browser:browser-1",
      );
    });

    it("records an unfocused promoted Draft without stealing focus", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      act(() => useChatDraftsStore.getState().completePromotion("draft-1"));
      expect(s.claimTab).toHaveBeenCalledWith(DRAFT_TAB, "n1", true);
      expect(paneForTab(s.readSplitView()!, DRAFT_TAB)).toBe("n1");
      expect(s.readSplitView()?.focusedPaneId).toBe("n3");
    });

    for (const failure of ["refusal", "exception"] as const) {
      it(`surfaces browser ${failure} without changing a Draft or its placement`, async () => {
        const s = surface(ticket);
        act(() => s.writes.splitPane("n1", "down", null, []));
        const before = s.readSplitView();
        if (failure === "refusal")
          s.browserApi.open.mockResolvedValueOnce({ ok: false, error: "offline" });
        else s.browserApi.open.mockRejectedValueOnce(new Error("offline"));
        await act(async () => {
          container
            .querySelector('[data-pane-id="n3"] [aria-label="New browser"]')!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await s.browserFlight();
        });
        expect(toastError).toHaveBeenCalledWith("Could not open Browser Tab: offline");
        expect(useBrowserTabsStore.getState().byId).toEqual({});
        expect(s.readSplitView()).toBe(before);
        expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      });
    }

    it("retains placement on same-pane selection, reacquires it, and cleans it on close", () => {
      const s = surface(ticket);
      act(() => s.provisional().releaseActive());
      expect(s.view().panes.find((pane) => pane.id === "n1")?.tabIds).toContain(DRAFT_TAB);
      act(() => s.provisional().takeActive("draft-1"));
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
      expect(s.provisional().activeOverridePaneId).toBe("n1");
      act(() => useChatSessionsStore.getState().closeChatTab(s.ownerId, "draft-1"));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)).toBeUndefined();
      expect(s.view().panes.some((pane) => pane.tabIds.includes(DRAFT_TAB))).toBe(false);
    });

    it("owns multiple empty Drafts without losing the first pane's assignment", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      act(() => {
        useChatDraftsStore.getState().openProvisional("draft-2", {
          projectId: "project-1",
          ticketId: ticket ? s.ownerId : null,
          title: null,
          operationId: "op-2",
        });
        useChatSessionsStore.getState().openChatTab(s.ownerId, "draft-2");
        useChatSessionsStore.getState().setProvisionalActive(s.ownerId, "draft-2");
      });
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe("chat:draft-2");
      act(() => useChatSessionsStore.getState().dropChatTabs([s.ownerId]));
      expect(useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)).toBeUndefined();
    });

    it("moves the same Draft into an already focused empty pane", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      expect(s.view().focusedPaneId).toBe("n3");
      act(() => s.guarded().moveTabToPane(DRAFT_TAB, "n3"));
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBeNull();
    });

    it("retains the moved Draft's destination when the surface unmounts with an empty pane focused", () => {
      const s = surface(ticket);
      act(() => s.guarded().splitPane(SPLIT_VIEW_ROOT_PANE_ID, "down", DRAFT_TAB, [DRAFT_TAB]));
      act(() => s.focusPane("n1"));
      s.remount();
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBeNull();
      expect(s.provisional().activeOverride).toBeNull();
    });

    it("relinquishes the Draft to the primary only when its own pane closes", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "down", null, []));
      act(() => s.closePane("n1"));
      expect(s.view().panes.find((pane) => pane.id === SPLIT_VIEW_ROOT_PANE_ID)?.activeTabId).toBe(
        DRAFT_TAB,
      );
      expect(s.provisional().activeOverridePaneId).toBe(SPLIT_VIEW_ROOT_PANE_ID);
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBeNull();
    });

    it("hands the overlay back without recording an empty Draft", () => {
      const s = surface(ticket);
      act(() => s.provisional().releaseActive());
      expect(s.provisional().activeOverride).toBeNull();
      expect(s.view().panes.find((pane) => pane.id === "n1")?.tabIds).toContain(DRAFT_TAB);
      expect(
        useProvisionalPaneLayoutStore.getState().byOwner.get(s.ownerId)?.get("draft-1"),
      ).toEqual({ paneId: "n1", front: false });
      expect([...s.data.values()].join()).not.toContain(DRAFT_TAB);
    });

    it("keeps a Draft in its destination when a keyboard split changes pane focus", () => {
      const s = surface(ticket);
      act(() => s.writes.splitPane("n1", "down", null, []));
      expect(s.view().panes.find((pane) => pane.id === "n1")?.activeTabId).toBe(DRAFT_TAB);
      expect(s.view().panes.find((pane) => pane.id === "n3")?.activeTabId).toBeNull();
      expect(s.view().focusedPaneId).toBe("n3");
      act(() => s.closePane("n3"));
      expect(s.provisional().activeOverridePaneId).toBe("n1");
      expect(s.provisional().activeOverrideTabId).toBe(DRAFT_TAB);
    });
  });
}
