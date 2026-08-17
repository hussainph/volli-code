import type { ModelSelection, Ticket } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { type ComposerFields, runKickoff, runPlainCreate, type SubmitDeps } from "./submit";

function fields(overrides: Partial<ComposerFields> = {}): ComposerFields {
  return {
    projectId: "p1",
    ticketPrefix: "VC",
    status: "backlog",
    priority: "medium",
    title: "A ticket",
    body: "",
    labels: [],
    usesWorktree: true,
    baseBranch: "main",
    ...overrides,
  };
}

const MODEL: ModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
};

function madeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    projectId: "p1",
    ticketNumber: 7,
    title: "A ticket",
    body: "",
    status: "backlog",
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
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<SubmitDeps> = {}): SubmitDeps {
  return {
    addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket()),
    startChat: vi.fn<SubmitDeps["startChat"]>(async () => "s1"),
    openTicketWorkspace: vi.fn<SubmitDeps["openTicketWorkspace"]>(),
    toastSuccess: vi.fn<SubmitDeps["toastSuccess"]>(),
    ...overrides,
  };
}

describe("runPlainCreate", () => {
  it("creates in the chip's status with all fields and toasts the display id", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ ticketNumber: 12 })),
    });

    const result = await runPlainCreate(
      fields({ status: "todo", priority: "high", body: "## Body", labels: ["bug"] }),
      deps,
    );

    expect(result).toEqual({ created: true });
    expect(deps.addTicket).toHaveBeenCalledWith("p1", "todo", "A ticket", {
      priority: "high",
      body: "## Body",
      labels: ["bug"],
      usesWorktree: true,
      baseBranch: "main",
    });
    expect(deps.toastSuccess).toHaveBeenCalledWith("VC-12 created");
    expect(deps.startChat).not.toHaveBeenCalled();
  });

  it("records no base branch for a ticket that works in the project checkout", async () => {
    const deps = fakeDeps();

    await runPlainCreate(fields({ usesWorktree: false, baseBranch: "develop" }), deps);

    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "backlog",
      "A ticket",
      expect.objectContaining({ usesWorktree: false, baseBranch: null }),
    );
  });

  it("reports not-created and skips the toast when the create fails", async () => {
    const deps = fakeDeps({ addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => null) });

    const result = await runPlainCreate(fields(), deps);

    expect(result).toEqual({ created: false });
    expect(deps.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("runKickoff", () => {
  it("forces Doing and (foreground) navigates, then starts the chat on the chosen model", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () =>
        madeTicket({ id: "tk", ticketNumber: 42, status: "doing" }),
      ),
    });

    const result = await runKickoff(fields({ status: "backlog", body: "the body" }), deps, {
      createMore: false,
      model: MODEL,
    });

    expect(result).toEqual({ created: true });
    // Status forced to doing regardless of the chip (backlog).
    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "doing",
      "A ticket",
      expect.objectContaining({ body: "the body" }),
    );
    expect(deps.openTicketWorkspace).toHaveBeenCalledWith("p1", "tk");
    // The ticket's own prose is NOT re-sent: the agent is handed the Ticket
    // Brief at attach, so the opening turn is only the instruction to begin.
    expect(deps.startChat).toHaveBeenCalledWith("p1", "tk", {
      title: "Work on VC-42",
      message: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
      model: MODEL,
    });
  });

  it("never starts a terminal harness — the ticket keeps the DB's terminal default", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields(), deps, { createMore: false, model: MODEL });

    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "doing",
      "A ticket",
      expect.not.objectContaining({ preferredHarnessId: expect.anything() }),
    );
  });

  it("carries the chosen base branch into the kickoff create", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields({ baseBranch: "origin/main" }), deps, {
      createMore: false,
      model: MODEL,
    });

    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "doing",
      "A ticket",
      expect.objectContaining({ baseBranch: "origin/main" }),
    );
  });

  it("omits the model entirely when the composer had none to offer", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields(), deps, { createMore: false });

    // Not `model: undefined`: the start reads "absent" as "take the Ticket
    // default", and an explicit undefined key would be a second way to say it.
    expect(deps.startChat).toHaveBeenCalledWith("p1", "tk", {
      title: "Work on VC-7",
      message: "Begin work on this ticket. Your assignment is the Ticket Brief above.",
    });
  });

  it("starts in the background without navigating when Create-more is on", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields(), deps, { createMore: true, model: MODEL });

    expect(deps.startChat).toHaveBeenCalledWith("p1", "tk", expect.anything());
    expect(deps.openTicketWorkspace).not.toHaveBeenCalled();
  });

  it("still navigates (foreground) when the Session start fails, so the user can retry there", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
      startChat: vi.fn<SubmitDeps["startChat"]>(async () => null),
    });

    const result = await runKickoff(fields(), deps, { createMore: false, model: MODEL });

    expect(result).toEqual({ created: true });
    expect(deps.openTicketWorkspace).toHaveBeenCalledWith("p1", "tk");
  });

  it("does nothing further when the ticket create fails", async () => {
    const deps = fakeDeps({ addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => null) });

    const result = await runKickoff(fields(), deps, { createMore: false, model: MODEL });

    expect(result).toEqual({ created: false });
    expect(deps.startChat).not.toHaveBeenCalled();
    expect(deps.openTicketWorkspace).not.toHaveBeenCalled();
    expect(deps.toastSuccess).not.toHaveBeenCalled();
  });
});
