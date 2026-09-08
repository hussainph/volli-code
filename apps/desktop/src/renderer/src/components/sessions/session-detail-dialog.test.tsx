// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Project, SessionRecord, Ticket } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBoardStore } from "@renderer/stores/board";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkspaceStore } from "@renderer/stores/workspace";

const { resumeTicketSession, startProjectTerminal, startTicketTerminal } = vi.hoisted(() => ({
  resumeTicketSession: vi.fn(async () => "resumed-session"),
  startProjectTerminal: vi.fn(async () => "fresh-session"),
  startTicketTerminal: vi.fn(async () => undefined),
}));

vi.mock("./session-create", () => ({
  resumeTicketSession,
  startProjectTerminal,
  startTicketTerminal,
}));

const PROJECT: Project = {
  id: "p1",
  name: "Volli",
  path: "/repo",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  baseBranch: null,
  createdAt: 0,
  updatedAt: 0,
};

const TICKET: Ticket = {
  id: "t1",
  projectId: PROJECT.id,
  ticketNumber: 290,
  title: "Closed terminal history",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

const CLOSED_PROJECT_TERMINAL: SessionRecord = {
  id: "closed-session",
  projectId: PROJECT.id,
  ticketId: null,
  harnessId: "claude-code",
  activeHarnessId: null,
  harnessSessionId: null,
  launchKind: "shell",
  placement: "tab",
  title: "Closed shell",
  cwd: "/repo",
  createdAt: 1,
  endedAt: 2,
  exitCode: 0,
  lastActivityAt: 2,
  bornTicketless: true,
};

const { SessionDetailDialog } = await import("./session-detail-dialog");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  resumeTicketSession.mockClear();
  startProjectTerminal.mockClear();
  startTicketTerminal.mockClear();
  useProjectsStore.setState({ projects: [PROJECT] });
  useBoardStore.setState({ ticketsByProject: { [PROJECT.id]: [TICKET] } });
  useProjectSessionsStore.setState({
    byProject: {
      [PROJECT.id]: { terminal: [CLOSED_PROJECT_TERMINAL], chat: [], provenance: {} },
    },
    listingState: { [PROJECT.id]: "loaded" },
  });
  useUiStore.setState({
    sessionDetail: { projectId: PROJECT.id, sessionId: CLOSED_PROJECT_TERMINAL.id },
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  useUiStore.setState({ sessionDetail: null });
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "api");
  vi.unstubAllGlobals();
});

describe("SessionDetailDialog", () => {
  it("distinguishes a failed baseline read from both loading and a missing record", async () => {
    const list = vi.fn(async () => ({ ok: false as const, error: "db closed" }));
    Object.assign(window, { api: { sessions: { list } } });
    useProjectSessionsStore.setState({ byProject: {}, listingState: {} });

    await act(async () => {
      root?.render(<SessionDetailDialog />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("This session’s record could not be loaded.");
    expect(document.body.textContent).not.toContain("Loading this session’s record");
    expect(document.body.textContent).not.toContain("could not be found");
    expect(list).toHaveBeenCalledWith({ projectId: PROJECT.id });
  });

  it("starts a fresh ticket terminal in the record's scope without treating it as resume", async () => {
    const record: SessionRecord = {
      ...CLOSED_PROJECT_TERMINAL,
      ticketId: TICKET.id,
      bornTicketless: false,
    };
    useProjectSessionsStore.setState({
      byProject: { [PROJECT.id]: { terminal: [record], chat: [], provenance: {} } },
      listingState: { [PROJECT.id]: "loaded" },
    });
    const openTicketWorkspace = vi.fn();
    useWorkspaceStore.setState({ openTicketWorkspace });

    await act(async () => {
      root?.render(<SessionDetailDialog />);
    });
    const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("New terminal here"),
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openTicketWorkspace).toHaveBeenCalledWith(PROJECT.id, TICKET.id);
    expect(startTicketTerminal).toHaveBeenCalledWith(PROJECT.id, TICKET.id);
    expect(resumeTicketSession).not.toHaveBeenCalled();
  });

  it("keeps harness resume addressed to the old Session and opens the new tab it creates", async () => {
    const record: SessionRecord = {
      ...CLOSED_PROJECT_TERMINAL,
      ticketId: TICKET.id,
      bornTicketless: false,
      launchKind: "agent",
    };
    useProjectSessionsStore.setState({
      byProject: { [PROJECT.id]: { terminal: [record], chat: [], provenance: {} } },
      listingState: { [PROJECT.id]: "loaded" },
    });
    const openTicketWorkspace = vi.fn();
    const openTicketSession = vi.fn();
    useWorkspaceStore.setState({ openTicketWorkspace, openTicketSession });

    await act(async () => {
      root?.render(<SessionDetailDialog />);
    });
    const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Resume session"),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(resumeTicketSession).toHaveBeenCalledWith(
      { kind: "ticket", projectId: PROJECT.id, ticketId: TICKET.id },
      record.id,
    );
    expect(startTicketTerminal).not.toHaveBeenCalled();
    expect(openTicketSession).toHaveBeenCalledWith(PROJECT.id, TICKET.id, "resumed-session");
  });

  it("moves to Home before starting a new project terminal, so the fresh tab is visible", async () => {
    const openHome = vi.fn();
    useWorkspaceStore.setState({ openHome });

    await act(async () => {
      root?.render(<SessionDetailDialog />);
    });

    const button = Array.from(document.body.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("New terminal here"),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openHome).toHaveBeenCalledWith(PROJECT.id);
    expect(startProjectTerminal).toHaveBeenCalledWith(PROJECT.id);
    expect(openHome.mock.invocationCallOrder[0]).toBeLessThan(
      startProjectTerminal.mock.invocationCallOrder[0]!,
    );
    expect(useUiStore.getState().sessionDetail).toBeNull();
  });
});
