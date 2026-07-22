import { describe, expect, it } from "vite-plus/test";
import type { Project, Ticket } from "@volli/shared";

import { interruptToastModel } from "./interrupt-toast";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    ticketNumber: 12,
    title: "Fix the flaky boot",
    body: "",
    status: "doing",
    priority: "medium",
    labelIds: [],
    usesWorktree: true,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Ticket;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Volli",
    path: "/repo/volli",
    ticketPrefix: "VC",
    colorIndex: 0,
    sortOrder: 0,
    updatedAt: 1,
    ...overrides,
  } as Project;
}

describe("interruptToastModel", () => {
  it("names the ticket by display id and targets it, singular wording for one session", () => {
    const model = interruptToastModel({ ticketId: "t1", sessionIds: ["s1"] }, { p1: [ticket()] }, [
      project(),
    ]);

    expect(model).toEqual({
      message: "VC-12: interrupted an agent session",
      target: { projectId: "p1", ticketId: "t1" },
    });
  });

  it("counts plural sessions", () => {
    const model = interruptToastModel(
      { ticketId: "t1", sessionIds: ["s1", "s2", "s3"] },
      { p1: [ticket()] },
      [project()],
    );

    expect(model.message).toBe("VC-12: interrupted 3 agent sessions");
  });

  it("finds the ticket across projects", () => {
    const model = interruptToastModel(
      { ticketId: "t2", sessionIds: ["s1"] },
      { p1: [ticket()], p2: [ticket({ id: "t2", ticketNumber: 7 })] },
      [project(), project({ id: "p2", ticketPrefix: "XY" })],
    );

    expect(model).toEqual({
      message: "XY-7: interrupted an agent session",
      target: { projectId: "p2", ticketId: "t2" },
    });
  });

  it("falls back to the ticket title when its project row is missing a prefix source", () => {
    const model = interruptToastModel(
      { ticketId: "t1", sessionIds: ["s1"] },
      { p1: [ticket()] },
      [],
    );

    expect(model.message).toBe("Fix the flaky boot: interrupted an agent session");
    expect(model.target).toEqual({ projectId: "p1", ticketId: "t1" });
  });

  it("still announces, without a target, when the ticket is unknown to the board", () => {
    const model = interruptToastModel({ ticketId: "ghost", sessionIds: ["s1", "s2"] }, {}, []);

    expect(model).toEqual({ message: "Interrupted 2 agent sessions", target: null });
  });
});
