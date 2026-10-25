// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Project,
  SessionAttention,
  Ticket,
  WorktreeSetupAnswer,
  WorktreeSetupStatusView,
} from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The two doors this hook speaks through: the desktop-only tier's setup
// commands and the toasts. Sonner draws into a DOM this test has none of.
const rpc = vi.hoisted(() => ({
  status: vi.fn<(input: { ticketId: string }) => Promise<WorktreeSetupStatusView>>(),
  answer:
    vi.fn<
      (input: { ticketId: string; answer: WorktreeSetupAnswer }) => Promise<WorktreeSetupStatusView>
    >(),
}));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    worktree: {
      setupStatus: { query: rpc.status },
      answerSetup: { mutate: rpc.answer },
    },
  }),
}));
const toasted = vi.hoisted(() => ({ errors: [] as string[], successes: [] as string[] }));
vi.mock("@renderer/lib/toast", () => ({
  toastError: (message: string) => toasted.errors.push(message),
}));
vi.mock("sonner", () => ({
  toast: { success: (message: string) => toasted.successes.push(message) },
}));

import { useBoardStore } from "@renderer/stores/board";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorktreeSetupGate } from "./use-worktree-setup-gate";

type WorktreeSetupGateInput = Parameters<typeof useWorktreeSetupGate>[0];

const PROJECT = "project-1";
const TICKET = "ticket-1";
const RUN = {
  source: "repo" as const,
  summary: ".agents/setup exited with code 1: boom",
  exitCode: 1,
  endedAt: 1_000,
  tail: "boom",
};
const FAILED: WorktreeSetupStatusView = { kind: "failed", run: RUN };
const PREPARATION: SessionAttention = {
  id: "attention-1",
  attachmentId: null,
  kind: "configuration_invalid",
  detail: "Couldn't prepare the worktree at /w — .agents/setup exited with code 1: boom",
  diagnostic: null,
};

const originalBoard = useBoardStore.getState();
const originalProjects = useProjectsStore.getState();
const originalProjectUi = useProjectUiStore.getState();
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.status.mockReset().mockResolvedValue(FAILED);
  rpc.answer.mockReset().mockResolvedValue({ kind: "pending" });
  toasted.errors.length = 0;
  toasted.successes.length = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  useBoardStore.setState(originalBoard, true);
  useProjectsStore.setState(originalProjects, true);
  useProjectUiStore.setState(originalProjectUi, true);
  vi.unstubAllGlobals();
});

/** Mounts the hook; `rerender` draws it again with changed input. */
async function mount(overrides: Partial<WorktreeSetupGateInput> = {}) {
  const recover = vi.fn(async () => true);
  let input: WorktreeSetupGateInput = {
    enabled: true,
    projectId: PROJECT,
    ticketId: TICKET,
    attention: PREPARATION,
    recover,
    ...overrides,
  };
  const result = { current: undefined as unknown as ReturnType<typeof useWorktreeSetupGate> };
  function Probe(): null {
    result.current = useWorktreeSetupGate(input);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => root.render(React.createElement(Probe)));
  return {
    result,
    recover,
    rerender: async (next: Partial<WorktreeSetupGateInput>) => {
      input = { ...input, ...next };
      await act(async () => root.render(React.createElement(Probe)));
    },
  };
}

/** Lets the hook's fire-and-forget acts run to their end. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
}

describe("useWorktreeSetupGate", () => {
  it("reads nothing with the flag off, for a project Session, or for another failure", async () => {
    await mount({ enabled: false });
    await mount({ ticketId: null });
    await mount({ attention: { ...PREPARATION, detail: "Bad model" } });
    await mount({ attention: null });
    expect(rpc.status).not.toHaveBeenCalled();
  });

  it("reads the setup once for the failure shown, and offers only a failed one", async () => {
    const gate = await mount();
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith({ ticketId: TICKET });
    expect(gate.result.current.failedSetup).toEqual(RUN);
    await gate.rerender({});
    expect(rpc.status).toHaveBeenCalledOnce();
    // A different failure is no longer the setup's.
    await gate.rerender({ attention: { ...PREPARATION, kind: "auth_required" } });
    expect(gate.result.current.failedSetup).toBeNull();

    rpc.status.mockResolvedValue({ kind: "started-anyway", run: RUN });
    const answered = await mount();
    expect(answered.result.current.failedSetup).toBeNull();
  });

  it("keeps the plain row when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rpc.status.mockRejectedValue(new Error("Unknown ticket"));
    const gate = await mount();
    expect(gate.result.current.failedSetup).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("answers, starts again the row's way, then reads where the setup stands", async () => {
    const gate = await mount();
    act(() => gate.result.current.answerSetup("retry"));
    await settle();
    expect(rpc.answer).toHaveBeenCalledExactlyOnceWith({ ticketId: TICKET, answer: "retry" });
    expect(gate.recover).toHaveBeenCalledOnce();
    expect(rpc.status).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refused answer and does not start again", async () => {
    rpc.answer.mockRejectedValue(new Error("Unknown ticket"));
    const gate = await mount();
    act(() => gate.result.current.answerSetup("start-anyway"));
    await settle();
    expect(toasted.errors).toEqual(["Couldn't start without the setup: Unknown ticket"]);
    expect(gate.recover).not.toHaveBeenCalled();
  });

  it("files the fix in the same project through the board's create, then opens it", async () => {
    const addTicket = vi.fn(async () => ({ id: "ticket-9", ticketNumber: 9 }) as Ticket);
    const openTicketView = vi.fn();
    useBoardStore.setState({
      ticketsByProject: { [PROJECT]: [{ id: TICKET, ticketNumber: 4 } as Ticket] },
      addTicket,
    });
    useProjectsStore.setState({ projects: [{ id: PROJECT, ticketPrefix: "VC" } as Project] });
    useProjectUiStore.setState({ openTicketView });
    const gate = await mount();

    act(() => gate.result.current.fixSetup());
    await settle();

    const [projectId, status, title, options] = addTicket.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { body: string; labels: string[] },
    ];
    expect([projectId, status, title]).toEqual([PROJECT, "todo", "Fix the environment setup"]);
    expect(options.labels).toEqual(["environment"]);
    expect(options.body).toContain(`Setting up a new working copy for VC-4 failed: ${RUN.summary}`);
    expect(toasted.successes).toEqual(["VC-9 created"]);
    expect(openTicketView).toHaveBeenCalledExactlyOnceWith(PROJECT, "ticket-9");
  });

  it("opens nothing when the create was refused, and says so when the ticket is gone", async () => {
    const openTicketView = vi.fn();
    useBoardStore.setState({
      ticketsByProject: { [PROJECT]: [{ id: TICKET, ticketNumber: 4 } as Ticket] },
      addTicket: async () => null,
    });
    useProjectsStore.setState({ projects: [{ id: PROJECT, ticketPrefix: "VC" } as Project] });
    useProjectUiStore.setState({ openTicketView });
    const gate = await mount();
    act(() => gate.result.current.fixSetup());
    await settle();
    expect(openTicketView).not.toHaveBeenCalled();

    useBoardStore.setState({ ticketsByProject: { [PROJECT]: [] } });
    act(() => gate.result.current.fixSetup());
    expect(toasted.errors).toEqual([
      "Couldn't create the fix ticket: this ticket is no longer on the board",
    ]);
  });
});
