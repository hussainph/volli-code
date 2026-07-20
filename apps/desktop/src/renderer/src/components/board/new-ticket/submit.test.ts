import type { Ticket } from "@volli/shared";
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
    ...overrides,
  };
}

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
    startSession: vi.fn<SubmitDeps["startSession"]>(async () => "s1"),
    openTicket: vi.fn<SubmitDeps["openTicket"]>(),
    focusSession: vi.fn<SubmitDeps["focusSession"]>(),
    persistHarness: vi.fn<SubmitDeps["persistHarness"]>(),
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
    });
    expect(deps.toastSuccess).toHaveBeenCalledWith("VC-12 created");
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  it("reports not-created and skips the toast when the create fails", async () => {
    const deps = fakeDeps({ addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => null) });

    const result = await runPlainCreate(fields(), deps);

    expect(result).toEqual({ created: false });
    expect(deps.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("runKickoff", () => {
  it("forces Doing, persists the harness, and (foreground) navigates + boots the session with the composed prompt", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () =>
        madeTicket({ id: "tk", ticketNumber: 42, status: "doing" }),
      ),
    });

    const result = await runKickoff(fields({ status: "backlog", body: "the body" }), deps, {
      createMore: false,
      harnessId: "codex",
    });

    expect(result).toEqual({ created: true });
    expect(deps.persistHarness).toHaveBeenCalledWith("codex");
    // Status forced to doing regardless of the chip (backlog).
    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "doing",
      "A ticket",
      expect.objectContaining({ body: "the body" }),
    );
    expect(deps.openTicket).toHaveBeenCalledWith("p1", "tk");
    expect(deps.startSession).toHaveBeenCalledWith("p1", "tk", {
      harnessId: "codex",
      prompt: "VC-42: A ticket\n\nthe body",
    });
    // Landing surface is the terminal itself: the booted session's tab is focused.
    expect(deps.focusSession).toHaveBeenCalledWith("p1", "tk", "s1");
  });

  it("persists the chosen harness as the ticket's preferredHarnessId so later resume sessions match", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields(), deps, { createMore: false, harnessId: "codex" });

    expect(deps.addTicket).toHaveBeenCalledWith(
      "p1",
      "doing",
      "A ticket",
      expect.objectContaining({ preferredHarnessId: "codex" }),
    );
  });

  it("boots in the background without navigating when Create-more is on", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
    });

    await runKickoff(fields(), deps, { createMore: true, harnessId: "claude-code" });

    expect(deps.startSession).toHaveBeenCalledWith("p1", "tk", expect.anything());
    expect(deps.openTicket).not.toHaveBeenCalled();
    expect(deps.focusSession).not.toHaveBeenCalled();
  });

  it("still navigates (foreground) when the session boot fails, so the user can retry from the detail view", async () => {
    const deps = fakeDeps({
      addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => madeTicket({ id: "tk" })),
      startSession: vi.fn<SubmitDeps["startSession"]>(async () => null),
    });

    const result = await runKickoff(fields(), deps, {
      createMore: false,
      harnessId: "claude-code",
    });

    expect(result).toEqual({ created: true });
    expect(deps.openTicket).toHaveBeenCalledWith("p1", "tk");
    // No session to focus — Doc stays active as the retry surface.
    expect(deps.focusSession).not.toHaveBeenCalled();
  });

  it("does nothing further when the ticket create fails", async () => {
    const deps = fakeDeps({ addTicket: vi.fn<SubmitDeps["addTicket"]>(async () => null) });

    const result = await runKickoff(fields(), deps, {
      createMore: false,
      harnessId: "claude-code",
    });

    expect(result).toEqual({ created: false });
    expect(deps.startSession).not.toHaveBeenCalled();
    expect(deps.openTicket).not.toHaveBeenCalled();
    expect(deps.toastSuccess).not.toHaveBeenCalled();
  });
});
