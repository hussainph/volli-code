import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetSnapshot, Ticket } from "@volli/shared";

import { buildTicketEnvironmentInspector } from "./ticket-environment-inspector-model";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-6",
    projectId: "project-1",
    ticketNumber: 6,
    title: "Inspector",
    body: "",
    status: "doing",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: "/worktrees/VC-6-inspector",
    branch: "volli/VC-6-inspector",
    baseBranch: "main",
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function changeSet(overrides: Partial<ChangeSetSnapshot> = {}): ChangeSetSnapshot {
  return {
    baseRevision: "base",
    headRevision: "head",
    files: [],
    insertions: 8,
    deletions: 2,
    revision: "revision",
    truncated: false,
    totalCount: 3,
    ...overrides,
  };
}

describe("buildTicketEnvironmentInspector", () => {
  it("projects a worktree Ticket's Change Set, branch, and body sources into existing rail destinations", () => {
    expect(
      buildTicketEnvironmentInspector({
        ticket: ticket({ body: "Read @docs/plan.md and @src/inspector.tsx." }),
        changeSet: changeSet(),
      }),
    ).toEqual({
      environment: [
        { id: "changes", label: "Changes", detail: "3 files · +8 −2", destination: "changes" },
        {
          id: "worktree",
          label: "Local",
          detail: "/worktrees/VC-6-inspector",
          destination: "properties",
        },
        {
          id: "branch",
          label: "Branch",
          detail: "volli/VC-6-inspector · main",
          destination: "properties",
        },
      ],
      sources: [
        { relPath: "docs/plan.md", label: "plan.md", destination: "files" },
        { relPath: "src/inspector.tsx", label: "inspector.tsx", destination: "files" },
      ],
    });
  });

  it("keeps loading, empty, failed, and no-worktree states distinct without inventing attachment data", () => {
    expect(buildTicketEnvironmentInspector({ ticket: ticket() }).environment[0]).toMatchObject({
      id: "changes",
      detail: "Loading changes…",
    });
    expect(
      buildTicketEnvironmentInspector({ ticket: ticket(), changeSet: changeSet({ totalCount: 0 }) })
        .environment[0],
    ).toMatchObject({ id: "changes", detail: "No changes vs base" });
    expect(
      buildTicketEnvironmentInspector({ ticket: ticket(), changeSetError: "offline" })
        .environment[0],
    ).toMatchObject({ id: "changes", detail: "Changes unavailable" });
    expect(
      buildTicketEnvironmentInspector({
        ticket: ticket({ body: "", worktreePath: null, branch: null, baseBranch: null }),
      }),
    ).toEqual({ environment: [], sources: [] });
  });

  it("surfaces the durable PR fact when the ticket already has one", () => {
    expect(
      buildTicketEnvironmentInspector({
        ticket: ticket({ prUrl: "https://github.com/volli/volli-code/pull/6" }),
        changeSet: changeSet(),
      }).environment,
    ).toContainEqual({
      id: "pull-request",
      label: "Pull request",
      detail: "https://github.com/volli/volli-code/pull/6",
      destination: "properties",
    });
  });
});
