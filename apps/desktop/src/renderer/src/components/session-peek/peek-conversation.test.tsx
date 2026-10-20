// @vitest-environment jsdom
/**
 * The shared conversation overlay a sidebar row opens (VC-30, S6).
 *
 * Three facts belong to this component rather than to the chrome it mounts:
 * a Session named by a row is ADOPTED when the conversation opens, closing
 * leaves that client resident for whatever else is reading it, and the
 * dialog's Escape stops at the dialog — the peek card behind it must survive.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  createTicket,
  PERSON_STARTED,
  SPLIT_VIEW_ROOT_PANE_ID,
  SESSION_HOST_NOTICE_METADATA_KIND,
  type ChatSessionRecord,
  type SessionPresentationProjection,
  type SessionListingRow,
} from "@volli/shared";
import { disposeChatClient, EMPTY_TRANSCRIPT } from "@volli/session-presentation";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useWorkspaceStore } from "@renderer/stores/workspace";
import { useProjectsStore } from "@renderer/stores/projects";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { PeekConversation } from "./peek-conversation";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const SESSION = "chat-peek-1";

const record: ChatSessionRecord = {
  sessionId: SESSION,
  title: "Trace the dropped decorations",
  projectId: "project-1",
  ticketId: "ticket-6",
  createdAt: 1,
  adapterId: "pi",
  live: true,
  activity: "waiting",
  waitingOn: "question",
  outcome: null,
  lastActivityAt: 2,
  bornTicketless: false,
  role: "ticket",
  parentSessionId: null,
  model: null,
};

const row: SessionListingRow = {
  kind: "chat",
  record,
  usage: EMPTY_SESSION_USAGE_SUMMARY,
  provenance: PERSON_STARTED,
};

/** Every bridge call refuses; nothing here depends on main answering. */
function bridgeNode(path: string[]): unknown {
  return new Proxy(() => {}, {
    get(_target, key) {
      return typeof key !== "string" || key === "then" ? undefined : bridgeNode([...path, key]);
    },
    apply() {
      if (path.at(-1)?.startsWith("on")) return () => {};
      if (path.join(".") === "appState.set") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", bridgeNode([]));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useChatSessionsStore.setState({ sessions: {}, openTabs: {}, rehomedTicketBySession: {} });
  useBoardStore.setState({
    ticketsByProject: Object.fromEntries(
      (
        [
          ["project-1", "ticket-6"],
          ["project-2", "ticket-current"],
        ] as const
      ).map(([projectId, id]) => [
        projectId,
        [
          createTicket({
            projectId,
            id,
            ticketNumber: 1,
            title: "Ticket",
            status: "doing",
            order: 0,
            now: 0,
          }),
        ],
      ]),
    ),
  });
  useWorkspaceStore.setState({ byProject: {} });
  vi.spyOn(useProjectsStore.getState(), "select").mockImplementation(() => {});
  useTicketSessionRecordsStore.setState({ byTicket: { "ticket-6": [row] } });
  useProjectSessionsStore.setState({ byProject: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  disposeChatClient(SESSION);
  disposeChatClient("child-1");
  useChatSessionsStore.setState({ sessions: {} });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(sessionId: string | null, onClose = () => {}): Promise<void> {
  await act(async () =>
    root?.render(
      <TooltipProvider delayDuration={0}>
        <PeekConversation sessionId={sessionId} onClose={onClose} />
      </TooltipProvider>,
    ),
  );
}

const dialog = () => document.body.querySelector<HTMLElement>("[data-session-peek-dialog]");

describe("PeekConversation", () => {
  it("draws nothing at all for no Session", async () => {
    await render(null);

    expect(dialog()).toBeNull();
    expect(container?.innerHTML).toBe("");
    expect(useChatSessionsStore.getState().sessions[SESSION]).toBeUndefined();
  });

  it("adopts the Session on open and leaves the client resident on close", async () => {
    await render(SESSION);

    expect(dialog()).not.toBeNull();
    expect(useChatSessionsStore.getState().sessions[SESSION]).toBeDefined();

    await render(null);

    expect(dialog()).toBeNull();
    // Disposal is not reference-counted: a tab reading the same Session must
    // not lose its client because a preview closed.
    expect(useChatSessionsStore.getState().sessions[SESSION]).toBeDefined();
  });

  it("names the Session and its state from the row cache before a stream answers", async () => {
    await render(SESSION);

    const node = dialog()!;
    expect(node.textContent).toContain(record.title);
    expect(node.querySelector("[data-session-peek-state]")?.textContent).toBe("Waiting for you");
    // The real plane, not a second transcript implementation.
    expect(node.querySelector("textarea")).not.toBeNull();
  });

  it("opens the cached ticket chat as a tab and dismisses the preview", async () => {
    const onClose = vi.fn();
    useWorkspaceStore.getState().openHome("project-1", "file:notes.md");
    await render(SESSION, onClose);

    const button = [...dialog()!.querySelectorAll("button")].find(
      (one) => one.textContent === "Open as tab",
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().select).toHaveBeenCalledWith("project-1");
    expect(useChatSessionsStore.getState().openTabs["ticket-6"]).toEqual([SESSION]);
    const workspace = useWorkspaceStore.getState().byProject["project-1"]!;
    expect(workspace.openTicketId).toBe("ticket-6");
    expect(workspace.ticketTabs["ticket-6"]?.active).toBe(chatTabId(SESSION));
    await render(null);
    expect(dialog()).toBeNull();
    expect(useChatSessionsStore.getState().sessions[SESSION]).toBeDefined();
  });

  it.each([false, true])(
    "opens a departed ticket's chat on Home (tab already open: %s)",
    async (alreadyOpen) => {
      const onClose = vi.fn();
      const chat = useChatSessionsStore.getState();
      if (alreadyOpen) chat.openChatTab("ticket-6", SESSION);
      await render(SESSION, onClose);
      // The cache still names the durable ticket, but it leaves the board
      // while the overlay is open. Existing tabs are rehomed by the board.
      useBoardStore.setState({ ticketsByProject: { "project-1": [] } });
      chat.reconcileTicketChatTabs("project-1", ["ticket-6"], []);
      await act(async () =>
        [...dialog()!.querySelectorAll("button")]
          .find((one) => one.textContent === "Open as tab")!
          .click(),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(useChatSessionsStore.getState().openTabs["project-1"]).toEqual([SESSION]);
      expect(useChatSessionsStore.getState().openTabs["ticket-6"]).toBeUndefined();
      const workspace = useWorkspaceStore.getState().byProject["project-1"]!;
      expect(workspace.homeActiveTab).toBe(chatTabId(SESSION));
      expect(workspace.openTicketId).toBeNull();
    },
  );

  it("opens a Board Session on Home without losing the remembered ticket", async () => {
    useTicketSessionRecordsStore.setState({ byTicket: {} });
    useProjectSessionsStore.setState({
      byProject: {
        "project-1": {
          chat: [{ ...record, ticketId: null, role: "project" }],
          terminal: [],
          provenance: {},
        },
      },
    });
    useWorkspaceStore.getState().openTicketWorkspace("project-1", "ticket-other");
    await render(SESSION);
    await act(async () =>
      [...dialog()!.querySelectorAll("button")]
        .find((one) => one.textContent === "Open as tab")!
        .click(),
    );

    expect(useChatSessionsStore.getState().openTabs["project-1"]).toEqual([SESSION]);
    const workspace = useWorkspaceStore.getState().byProject["project-1"]!;
    expect(workspace.homeActiveTab).toBe(chatTabId(SESSION));
    expect(workspace.openTicketId).toBe("ticket-other");
  });

  it("focuses an existing tab in its split pane without duplicating it", async () => {
    const workspace = useWorkspaceStore.getState();
    useChatSessionsStore.getState().openChatTab("ticket-6", SESSION);
    workspace.openTicketWorkspace("project-1", "ticket-6");
    workspace.splitTicketPane("project-1", "ticket-6", SPLIT_VIEW_ROOT_PANE_ID, "right", {
      tabId: chatTabId(SESSION),
    });
    const split =
      useWorkspaceStore.getState().byProject["project-1"]!.ticketTabs["ticket-6"]!.splitView!;
    const chatPaneId = split.focusedPaneId;
    workspace.focusTicketPane("project-1", "ticket-6", SPLIT_VIEW_ROOT_PANE_ID);
    await render(SESSION);
    await act(async () =>
      [...dialog()!.querySelectorAll("button")]
        .find((one) => one.textContent === "Open as tab")!
        .click(),
    );

    expect(useChatSessionsStore.getState().openTabs["ticket-6"]).toEqual([SESSION]);
    expect(
      useWorkspaceStore.getState().byProject["project-1"]?.ticketTabs["ticket-6"]?.splitView
        ?.focusedPaneId,
    ).toBe(chatPaneId);
  });

  it("uses the resident scope over a stale cache and opens linked Sessions from the preview", async () => {
    const projection: SessionPresentationProjection = {
      session: {
        id: SESSION,
        projectId: "project-2",
        ticketId: "ticket-current",
        role: "ticket",
        parentSessionId: null,
        title: record.title,
        createdAt: 0,
      },
      status: "open",
      liveExecutor: null,
      attention: { active: [], primary: null },
      interactions: { active: [], resolved: [] },
      signal: null,
      modelSelection: null,
      modelTier: null,
      turnActive: false,
      lastActivityAt: 0,
      bornTicketless: false,
      scheduledResume: null,
    };
    const messages = [
      {
        id: "child-notice",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Child finished" }],
        metadata: {
          kind: SESSION_HOST_NOTICE_METADATA_KIND,
          notice: {
            kind: "subagent",
            childSessionId: "child-1",
            title: "Check navigation",
            state: "completed",
            reason: null,
          },
        },
      },
    ];
    useChatSessionsStore.setState({
      sessions: {
        [SESSION]: {
          projection,
          transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages, messages },
          lifecycle: "ready",
          sessionError: null,
          queue: [],
        },
      },
    });
    const onClose = vi.fn();
    await render(SESSION, onClose);
    await act(async () =>
      [...dialog()!.querySelectorAll("button")].find((one) => one.textContent === "Open")!.click(),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useProjectsStore.getState().select).toHaveBeenCalledWith("project-2");
    expect(useChatSessionsStore.getState().openTabs["ticket-current"]).toEqual(["child-1"]);
    expect(
      useWorkspaceStore.getState().byProject["project-2"]?.ticketTabs["ticket-current"]?.active,
    ).toBe(chatTabId("child-1"));
    expect(useChatSessionsStore.getState().openTabs["ticket-6"]).toBeUndefined();
  });

  it("does not offer navigation until the Session's scope is known", async () => {
    useTicketSessionRecordsStore.setState({ byTicket: {} });
    await render(SESSION);

    expect(dialog()?.textContent).not.toContain("Open as tab");
  });

  it("closes on Escape without dismissing the peek behind it", async () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      await render(SESSION, onClose);
      await act(async () =>
        dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });
});
