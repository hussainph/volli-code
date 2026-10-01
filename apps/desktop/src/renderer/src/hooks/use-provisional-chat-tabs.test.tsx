// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resolveSplitView, SPLIT_VIEW_ROOT_PANE_ID, type SplitViewState } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PaneEmptyState } from "@renderer/components/split/pane-empty-state";
import { SplitViewGrid } from "@renderer/components/split/split-view-grid";
import type { SplitSurfaceWrites } from "@renderer/components/split/split-surface-drop";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { createWorkspaceStore } from "@renderer/stores/workspace";
import { useProvisionalChatTabs, type ProvisionalChatTabs } from "./use-provisional-chat-tabs";

const OPEN_CHATS = ["draft-1"];
const DRAFT_TAB = "chat:draft-1";
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {}, provisionalActive: {} });
  vi.unstubAllGlobals();
});

function surface(ticket: boolean) {
  const data = new Map<string, string>();
  let id = 0;
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
    () => `n${++id}`,
  );
  const ownerId = ticket ? "ticket-1" : "project-1";
  const permanentTabId = ticket ? "doc" : "board";
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
    activateTab: vi.fn(),
    openPayload: vi.fn(),
    reorderPane: vi.fn(),
    reorderSurface: vi.fn(),
  };
  let provisional: ProvisionalChatTabs;
  let guarded: SplitSurfaceWrites;
  function Harness() {
    store((state) => state.byProject);
    provisional = useProvisionalChatTabs(ownerId, OPEN_CHATS, readSplitView);
    guarded = provisional.guardLayoutWrites(writes, focusPane);
    const split = readSplitView()!;
    const view = resolveSplitView(
      provisional.overlaySplitView(split),
      [permanentTabId, DRAFT_TAB],
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
              onNewBrowser={vi.fn()}
              onOpenFile={vi.fn()}
              onClosePane={() => closePane(pane.id)}
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
  writes.splitPane(SPLIT_VIEW_ROOT_PANE_ID, "right", null, []);
  useChatDraftsStore.getState().openProvisional("draft-1", {
    projectId: "project-1",
    ticketId: ticket ? ownerId : null,
    title: null,
    operationId: "op-1",
  });
  useChatSessionsStore.getState().setProvisionalActive(ownerId, "draft-1");
  act(() => root.render(<Harness />));
  return {
    data,
    store,
    writes,
    focusPane,
    closePane,
    readSplitView,
    guarded: () => guarded,
    provisional: () => provisional,
    remount: () => {
      act(() => root.unmount());
      root = createRoot(container);
      act(() => root.render(<Harness />));
    },
    view: () =>
      resolveSplitView(
        provisional.overlaySplitView(readSplitView()!),
        [permanentTabId, DRAFT_TAB],
        permanentTabId,
      ),
  };
}

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
      expect(s.provisional().overlaySplitView(s.readSplitView()!)).toBe(s.readSplitView());
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
