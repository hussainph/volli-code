import type { ChatSessionRecord, SessionListingRow, SessionProjection } from "@volli/shared";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { EMPTY_CHAT_SELECTION, type ChatSessionSlice } from "@renderer/chat/client";
import { EMPTY_TRANSCRIPT } from "@renderer/chat/transcript";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import { renameChatSession } from "./rename";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SESSION = { id: "chat-1", projectId: "p1", ticketId: "t1", title: "Plan", createdAt: 0 };

const projection: SessionProjection = {
  session: SESSION,
  status: "open",
  commands: [],
  receipts: [],
  pendingExecutorStart: null,
  attachments: [],
  liveExecutor: null,
  attention: { active: [], primary: null },
  capabilities: [],
  interactions: { active: [], resolved: [] },
  signal: null,
  turnActive: false,
  lastActivityAt: 0,
};

const slice: ChatSessionSlice = {
  projection,
  transcript: EMPTY_TRANSCRIPT,
  lifecycle: "ready",
  sessionError: null,
  queue: [],
  selection: EMPTY_CHAT_SELECTION,
};

function chatRow(overrides: Partial<ChatSessionRecord> = {}): SessionListingRow {
  return {
    kind: "chat",
    record: {
      sessionId: "chat-1",
      title: "Plan",
      projectId: "p1",
      ticketId: "t1",
      createdAt: 1,
      adapterId: "opencode",
      live: true,
      activity: "idle",
      lastActivityAt: 1,
      ...overrides,
    },
  };
}

/** A terminal row in the same list — the kind the chat rename must step over. */
const terminalRow: SessionListingRow = {
  kind: "terminal",
  record: {
    id: "term-1",
    projectId: "p1",
    ticketId: "t1",
    harnessId: "claude-code",
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    title: "Session 1",
    cwd: "/repo",
    createdAt: 1,
    endedAt: null,
    exitCode: null,
  },
};

/** The cached chat row's title, for the ticket the fixtures use. */
function cachedTitle(sessionId: string, ticketId = "t1"): string | undefined {
  const row = useTicketSessionRecordsStore
    .getState()
    .byTicket[ticketId]?.find(
      (candidate) => candidate.kind === "chat" && candidate.record.sessionId === sessionId,
    );
  return row?.kind === "chat" ? row.record.title : undefined;
}

const renameMock =
  vi.fn<
    (input: { sessionId: string; title: string }) => Promise<{ ok: boolean; error?: string }>
  >();

beforeEach(() => {
  vi.clearAllMocks();
  renameMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { api: { sessions: { rename: renameMock } } });
  useChatSessionsStore.setState({ sessions: { "chat-1": slice } });
  useTicketSessionRecordsStore.setState({
    byTicket: {
      t1: [terminalRow, chatRow(), chatRow({ sessionId: "chat-2" })],
      // Another ticket's cached list, holding none of the Sessions renamed
      // here — the lists a by-id lookup has to walk past untouched.
      t2: [chatRow({ sessionId: "chat-3", ticketId: "t2" })],
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useChatSessionsStore.setState({ sessions: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
});

describe("renameChatSession", () => {
  it("retitles the resident Session and its cached rail row, then persists the trimmed title", async () => {
    const renamed = renameChatSession("chat-1", "  Migration plan  ");

    // Both writes land before the round-trip resolves: nothing else moves these
    // labels, since the durable rename never reaches a live chat subscriber.
    expect(useChatSessionsStore.getState().sessions["chat-1"]?.projection?.session.title).toBe(
      "Migration plan",
    );
    expect(cachedTitle("chat-1")).toBe("Migration plan");
    expect(await renamed).toBe(true);
    expect(renameMock).toHaveBeenCalledWith({ sessionId: "chat-1", title: "Migration plan" });
  });

  it("leaves every other row alone — the terminal row beside it, the other chat Session, the other ticket", async () => {
    await renameChatSession("chat-1", "Migration plan");

    expect(useTicketSessionRecordsStore.getState().byTicket["t1"]?.[0]).toEqual(terminalRow);
    expect(cachedTitle("chat-2")).toBe("Plan");
    expect(cachedTitle("chat-3", "t2")).toBe("Plan");
  });

  it("renames a Session held by no ticket list and no open surface", async () => {
    useChatSessionsStore.setState({ sessions: {} });
    useTicketSessionRecordsStore.setState({ byTicket: {} });

    expect(await renameChatSession("scratch-chat", "Scratch")).toBe(true);
    expect(renameMock).toHaveBeenCalledWith({ sessionId: "scratch-chat", title: "Scratch" });
  });

  it("is a no-op on a blank title, and never calls main", async () => {
    expect(await renameChatSession("chat-1", "   ")).toBe(false);

    expect(renameMock).not.toHaveBeenCalled();
    expect(cachedTitle("chat-1")).toBe("Plan");
  });

  it("toasts and resolves false when the write reports a failure", async () => {
    renameMock.mockResolvedValue({ ok: false, error: "Unknown session" });

    expect(await renameChatSession("chat-1", "Migration plan")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Rename failed: Unknown session", expect.anything());
  });

  it("toasts and resolves false when the write rejects", async () => {
    renameMock.mockRejectedValue(new Error("ipc down"));

    expect(await renameChatSession("chat-1", "Migration plan")).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Rename failed: ipc down", expect.anything());
  });
});
