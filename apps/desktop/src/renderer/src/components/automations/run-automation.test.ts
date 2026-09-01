import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  adoptChatSession: vi.fn(),
  openChatTab: vi.fn(),
  openTicketWorkspace: vi.fn(),
  refresh: vi.fn(),
  setSettingsOpen: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toastError }));
vi.mock("@renderer/stores/chat-sessions", () => ({
  useChatSessionsStore: {
    getState: () => ({
      adoptChatSession: mocks.adoptChatSession,
      openChatTab: mocks.openChatTab,
    }),
  },
}));
vi.mock("@renderer/stores/ticket-session-records", () => ({
  useTicketSessionRecordsStore: { getState: () => ({ refresh: mocks.refresh }) },
}));
vi.mock("@renderer/stores/ui", () => ({
  useUiStore: { getState: () => ({ setSettingsOpen: mocks.setSettingsOpen }) },
}));
vi.mock("@renderer/stores/workspace", () => ({
  useWorkspaceStore: { getState: () => ({ openTicketWorkspace: mocks.openTicketWorkspace }) },
}));

import { runAutomationOnTicketDrop } from "./run-automation";

function success(ticketId: string, sessionId: string) {
  return {
    ok: true as const,
    run: {
      id: `run-${ticketId}`,
      automationId: "automation-1",
      automationName: "Review",
      ticketId,
      sessionId,
      model: { providerId: "openai", modelId: "gpt-5", reasoningLevel: "medium" as const },
      createdAt: 1,
    },
    projectId: "p1",
    receipt: {
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      status: "completed" as const,
      recordedAt: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { api: { automations: { run: mocks.run } } });
});

describe("runAutomationOnTicketDrop", () => {
  it("starts every selected Ticket concurrently and opens only the first Session", async () => {
    const resolvers = new Map<string, (result: ReturnType<typeof success>) => void>();
    mocks.run.mockImplementation(
      (input: { ticketId: string }) =>
        new Promise((resolve) => {
          resolvers.set(input.ticketId, resolve);
        }),
    );

    const pending = runAutomationOnTicketDrop({
      automationId: "automation-1",
      dragData: { kind: "tickets", projectId: "p1", ticketIds: ["ticket-a", "ticket-b"] },
    });

    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
    resolvers.get("ticket-b")?.(success("ticket-b", "session-b"));
    resolvers.get("ticket-a")?.(success("ticket-a", "session-a"));

    await expect(pending).resolves.toBe(true);
    expect(mocks.adoptChatSession.mock.calls).toEqual([["session-a"], ["session-b"]]);
    expect(mocks.openChatTab.mock.calls).toEqual([
      ["ticket-a", "session-a"],
      ["ticket-b", "session-b"],
    ]);
    expect(mocks.openTicketWorkspace).toHaveBeenCalledExactlyOnceWith("p1", "ticket-a", {
      tabId: "chat:session-a",
    });
    expect(mocks.refresh.mock.calls).toEqual([["ticket-a"], ["ticket-b"]]);
  });

  it("ignores unrelated drag payloads", async () => {
    await expect(
      runAutomationOnTicketDrop({ automationId: "automation-1", dragData: { kind: "file" } }),
    ).resolves.toBe(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
