import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetSnapshot, Ticket } from "@volli/shared";

import {
  buildTicketEnvironmentInspector,
  hasChangeSetRow,
  readTicketEnvironmentChangeSet,
  shouldRevalidateTicketEnvironment,
} from "./ticket-environment-inspector-model";

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
          label: "Worktree",
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
        { relPath: "docs/plan.md", label: "plan.md" },
        { relPath: "src/inspector.tsx", label: "inspector.tsx" },
      ],
    });
  });

  it("keeps loading, empty, and no-worktree states distinct without inventing attachment data", () => {
    expect(buildTicketEnvironmentInspector({ ticket: ticket() }).environment[0]).toMatchObject({
      id: "changes",
      detail: "Loading changes…",
    });
    expect(
      buildTicketEnvironmentInspector({ ticket: ticket(), changeSet: changeSet({ totalCount: 0 }) })
        .environment[0],
    ).toMatchObject({ id: "changes", detail: "No changes vs base" });
    expect(
      buildTicketEnvironmentInspector({ ticket: ticket(), changeSet: changeSet({ totalCount: 1 }) })
        .environment[0],
    ).toMatchObject({ detail: "1 file · +8 −2" });
    expect(
      buildTicketEnvironmentInspector({
        ticket: ticket({ body: "", worktreePath: null, branch: null, baseBranch: null }),
      }),
    ).toEqual({ environment: [], sources: [] });
  });

  it("keeps the last good counts when a re-read fails, and drops the row when nothing was ever read", () => {
    const stale = buildTicketEnvironmentInspector({
      ticket: ticket(),
      changeSet: changeSet(),
      changeSetError: "offline",
    });
    expect(stale.environment[0]).toMatchObject({ id: "changes", detail: "3 files · +8 −2" });
    expect(hasChangeSetRow(stale)).toBe(true);

    const neverRead = buildTicketEnvironmentInspector({
      ticket: ticket(),
      changeSetError: "offline",
    });
    expect(neverRead.environment.map((row) => row.id)).toEqual(["worktree", "branch"]);
    expect(hasChangeSetRow(neverRead)).toBe(false);
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

  it("names the branch alone when the ticket has no recorded base", () => {
    expect(
      buildTicketEnvironmentInspector({
        ticket: ticket({ baseBranch: null }),
        changeSet: changeSet(),
      }).environment,
    ).toContainEqual({
      id: "branch",
      label: "Branch",
      detail: "volli/VC-6-inspector",
      destination: "properties",
    });
  });
});

describe("shouldRevalidateTicketEnvironment", () => {
  it("revalidates a consulted inspector without turning it into a live dashboard", () => {
    expect(
      shouldRevalidateTicketEnvironment({ lastReadAt: null, now: 10_000, loading: false }),
    ).toBe(true);
    expect(
      shouldRevalidateTicketEnvironment({ lastReadAt: 8_000, now: 10_000, loading: false }),
    ).toBe(false);
    expect(shouldRevalidateTicketEnvironment({ lastReadAt: 0, now: 10_000, loading: true })).toBe(
      false,
    );
    expect(shouldRevalidateTicketEnvironment({ lastReadAt: 0, now: 10_000, loading: false })).toBe(
      true,
    );
  });
});

describe("readTicketEnvironmentChangeSet", () => {
  it("turns a failed Change Set read into a retryable success without retaining the failure", async () => {
    const first = await readTicketEnvironmentChangeSet(async () => ({
      ok: false as const,
      error: "offline",
    }));
    const second = await readTicketEnvironmentChangeSet(async () => ({
      ok: true as const,
      changeSet: changeSet(),
    }));

    expect(first).toEqual({ error: "offline" });
    expect(second).toEqual({ changeSet: changeSet() });
  });

  it("reports a thrown transport failure as a recoverable error rather than propagating it", async () => {
    expect(
      await readTicketEnvironmentChangeSet(() => Promise.reject(new Error("ipc closed"))),
    ).toEqual({ error: "ipc closed" });
  });
});
