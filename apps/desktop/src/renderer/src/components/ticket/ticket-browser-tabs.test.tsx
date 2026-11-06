// @vitest-environment jsdom
/**
 * Ticket's close and Hide to Island share the same workspace cleanup. Drive
 * both through the real surface's registered browser viewport, with real tab,
 * chat and workspace stores; only the native bridge and unrelated content are
 * substituted.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { groupForTab, type Ticket } from "@volli/shared";

import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import { browserViewportSnapshot } from "@renderer/components/browser/browser-viewport-registry";
import { stripBrowserTabs, useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";
import { TicketDetail } from "./ticket-detail";

vi.mock("@renderer/lib/app-state-storage", () => {
  const data = new Map<string, string>();
  return {
    appStateStorage: {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => data.set(name, value),
      removeItem: (name: string) => data.delete(name),
    },
  };
});
vi.mock("@renderer/terminal/xterm-engine", () => ({ XtermEngine: vi.fn() }));
vi.mock("@renderer/components/chat/chat-plane", () => ({ ChatPlane: () => null }));
vi.mock("@renderer/components/ticket/file-view", () => ({ FileView: () => null }));
vi.mock("@renderer/components/ticket/diff-view", () => ({ DiffView: () => null }));
vi.mock("@renderer/components/ticket/ticket-body-panel", () => ({ TicketBodyPanel: () => null }));
vi.mock("@renderer/components/ticket/ticket-changes-panel", () => ({
  TicketChangesPanel: () => null,
}));
vi.mock("@renderer/components/ticket/ticket-files-panel", () => ({ TicketFilesPanel: () => null }));
vi.mock("@renderer/components/ticket/ticket-rail", () => ({ TicketRail: () => null }));
vi.mock("@renderer/components/files/search-panel", () => ({ FileSearchPanel: () => null }));
vi.mock("@renderer/components/sessions/session-create", () => ({
  bootChatSession: vi.fn(),
  createTerminalSession: vi.fn(),
}));

const PROJECT = "project-a";
const TICKET = "ticket-a";
const SESSION = "session-a";
const BROWSER = "browser-a";
const BROWSER_TAB = `browser:${BROWSER}`;
const CHAT_TAB = `chat:${SESSION}`;
const ticket: Ticket = {
  id: TICKET,
  projectId: PROJECT,
  ticketNumber: 1,
  title: "Browser workspace",
  body: "",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: false,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

const browserTab = (patch: Partial<BrowserTabState> = {}): BrowserTabState => ({
  tabId: BROWSER,
  projectId: PROJECT,
  ticketId: TICKET,
  createdBy: "session",
  ownerSessionId: SESSION,
  presentation: "tab",
  url: "https://example.com/settings",
  title: "Settings",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 3,
  heldBy: null,
  ...patch,
});

const original = {
  browsers: useBrowserTabsStore.getState(),
  board: useBoardStore.getState(),
  chats: useChatSessionsStore.getState(),
  projectSessions: useProjectSessionsStore.getState(),
  workspace: useProjectUiStore.getState(),
  records: useTicketSessionRecordsStore.getState(),
  ui: useUiStore.getState(),
};
let host: HTMLDivElement;
let root: Root;
let originalApi: PropertyDescriptor | undefined;
const setPresentation = vi.fn<BrowserApi["setPresentation"]>(async (input) => ({
  ok: true,
  tab: { ...useBrowserTabsStore.getState().byId[input.tabId]!, presentation: input.presentation },
}));
const close = vi.fn<BrowserApi["close"]>(async () => ({ ok: true }));
const workspace = () => useProjectUiStore.getState().byProject[PROJECT]?.ticketTabs[TICKET];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      browser: { setPresentation, close },
      tickets: { body: async () => ({ ok: true, body: "" }) },
      attachments: {
        list: async () => ({ ok: true, blobs: [] }),
        materialized: async () => ({ ok: true, links: [] }),
      },
      files: {
        index: async () => ({ ok: true, files: [] }),
        onChanged: () => () => {},
      },
    },
  });
  useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
  useBoardStore.setState({ ticketsByProject: { [PROJECT]: [ticket] } });
  useChatSessionsStore.setState({ sessions: {}, openTabs: { [TICKET]: [SESSION] } });
  useProjectSessionsStore.setState({
    byProject: { [PROJECT]: { terminal: [], chat: [], provenance: {} } },
  });
  useProjectUiStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: { [TICKET]: [] } });
  useUiStore.setState({ railCollapsed: true, terminalFocusTarget: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(browserViewportSnapshot().size).toBe(0);
  useBrowserTabsStore.setState(original.browsers, true);
  useBoardStore.setState(original.board, true);
  useChatSessionsStore.setState(original.chats, true);
  useProjectSessionsStore.setState(original.projectSessions, true);
  useProjectUiStore.setState(original.workspace, true);
  useTicketSessionRecordsStore.setState(original.records, true);
  useUiStore.setState(original.ui, true);
  if (originalApi) Object.defineProperty(window, "api", originalApi);
  else Reflect.deleteProperty(window, "api");
  vi.unstubAllGlobals();
});

async function mount(grouped: boolean, person = false): Promise<void> {
  useBrowserTabsStore
    .getState()
    .receive(browserTab(person ? { createdBy: "user", ownerSessionId: null } : {}));
  const ui = useProjectUiStore.getState();
  if (grouped) {
    ui.groupTicketTabs(PROJECT, TICKET, CHAT_TAB, BROWSER_TAB, "right");
    const group = groupForTab(workspace()?.splitView ?? null, BROWSER_TAB);
    expect(group).not.toBeNull();
    expect(groupForTab(workspace()?.splitView ?? null, CHAT_TAB)).toBe(group);
  }
  ui.setTicketActiveTab(PROJECT, TICKET, BROWSER_TAB);
  await act(async () => {
    root.render(
      <TicketDetail projectId={PROJECT} projectPath="/project" ticketPrefix="VC" ticket={ticket} />,
    );
  });
  expect(host.querySelector('[role="tab"][aria-label="Settings"]')).not.toBeNull();
  expect(workspace()?.active).toBe(BROWSER_TAB);
  expect(host.querySelectorAll('[data-slot="split-view-pane"]')).toHaveLength(grouped ? 2 : 1);
}

function expectLeftStrip(_grouped: boolean): void {
  expect(stripBrowserTabs(Object.values(useBrowserTabsStore.getState().byId))).toEqual([]);
  expect(host.querySelector('[role="tab"][aria-label="Settings"]')).toBeNull();
  expect(workspace()?.splitView ?? null).toBeNull();
  expect(browserViewportSnapshot().has(BROWSER)).toBe(false);
  expect(workspace()?.active).toBe(CHAT_TAB);
  expect(useChatSessionsStore.getState().openTabs[TICKET]).toEqual([SESSION]);
}

describe.each([true, false])("Ticket browser cleanup (grouped=%s)", (grouped) => {
  it("hides the Session's tab headless, removes its pane and selects the chat or Body", async () => {
    await mount(grouped);
    const viewport = browserViewportSnapshot().get(BROWSER)!;

    await act(async () => viewport.hide());

    expect(setPresentation).toHaveBeenCalledExactlyOnceWith({
      tabId: BROWSER,
      presentation: "headless",
    });
    expect(close).not.toHaveBeenCalled();
    expectLeftStrip(grouped);
    expect(useBrowserTabsStore.getState().byId[BROWSER]).toEqual(
      browserTab({ presentation: "headless" }),
    );
  });

  it("still closes a person's tab through the same workspace cleanup, never hiding it", async () => {
    await mount(grouped, true);
    const viewport = browserViewportSnapshot().get(BROWSER)!;

    await act(async () => viewport.close());

    expect(close).toHaveBeenCalledExactlyOnceWith({ tabId: BROWSER });
    expect(setPresentation).not.toHaveBeenCalled();
    expectLeftStrip(grouped);
    expect(useBrowserTabsStore.getState().byId[BROWSER]).toBeUndefined();
  });
});
