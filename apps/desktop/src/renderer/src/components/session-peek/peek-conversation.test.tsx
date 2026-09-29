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
  PERSON_STARTED,
  type ChatSessionRecord,
  type SessionListingRow,
} from "@volli/shared";
import { disposeChatClient } from "@volli/session-presentation";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
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
  useChatSessionsStore.setState({ sessions: {} });
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
