import type {
  BootstrapResult,
  ProjectCreateResult,
  Result,
  SessionRenameResult,
  SessionsResult,
  Ticket,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketResult,
  TicketsResult,
  VolliIpcChannel,
  WorktreeBranchesResult,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansResult,
  WorktreeRemoveResult,
} from "@volli/shared";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like ipc.test.ts, so the electron mock
// factory can capture into them. `dataChangedSends` collects every
// volli:data-changed fan-out so the broadcast-on-mutation assertions can see it.
const { handlers, dataChangedSends } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  dataChangedSends: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  // The worktree remove/orphan-delete broadcasts fan out over BrowserWindow;
  // one fake window records each send so tests can assert the re-hydrate fired.
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => {
            dataChangedSends.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// The worktree module runs real git — mocked so these handler tests never
// shell out; `worktree-runtime`'s `worktreeDeps` stays real (it just builds a
// plain deps object and never touches BrowserWindow unless `onPhase` fires,
// which the mocked functions below never call).
vi.mock("./worktree", () => ({
  remove: vi.fn(),
  listBranches: vi.fn(),
  sweepOrphans: vi.fn(),
  // Referenced (not called) by `worktree-runtime`'s `worktreeDeps` — needs a
  // stub export so that value import doesn't throw under strict ESM mocking.
  runGitCapturing: vi.fn(),
}));

import { registerDataIpcHandlers } from "./data-ipc";
import { insertSession } from "./db/sessions-repo";
import { openTestDb, testSession } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { resetOrphanSweepForTest } from "./orphan-sweep";
import { worktreesHome } from "./worktree-runtime";
import { listBranches, remove as removeWorktree, sweepOrphans } from "./worktree";

/** Fake IPC event; unused by any data-ipc handler, but every handler signature expects one. */
const fakeEvent = { sender: {} };

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

let ctx: TestDb;

beforeEach(() => {
  handlers.clear();
  vi.resetAllMocks();
  dataChangedSends.length = 0;
  // The orphan sweep is cached once per launch (module state) — drop it so each
  // test starts from a clean launch and its own mocked sweep runs.
  resetOrphanSweepForTest();
  ctx = openTestDb();
  registerDataIpcHandlers({ ok: true, db: ctx.db });
});

afterEach(() => {
  ctx.cleanup();
});

function createProject(): string {
  const result = invoke<{ ok: true; project: { id: string } }>("volli:project-create", {
    path: "/repo/proj",
    name: "Proj",
  });
  return result.project.id;
}

function createTicket(projectId: string): Ticket {
  const result = invoke<TicketResult>("volli:ticket-create", {
    projectId,
    status: "backlog",
    title: "A ticket",
  });
  if (!result.ok) throw new Error(result.error);
  return result.ticket;
}

function archiveTicket(ticketId: string): void {
  const result = invoke<Result>("volli:ticket-archive", { ticketId });
  if (!result.ok) throw new Error(result.error);
}

describe("volli:project-create — workspace-unique ticket prefixes", () => {
  it("pins the repository's detected base branch when a project is added", () => {
    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { detectBaseBranch: (path) => (path === "/repo/volli" ? "trunk" : null) },
    );

    const result = invoke<ProjectCreateResult>("volli:project-create", {
      path: "/repo/volli",
      name: "Volli Code",
    });

    expect(result).toMatchObject({ ok: true, project: { baseBranch: "trunk" } });
  });

  it("surfaces the colliding project instead of creating an ambiguous display-id namespace", () => {
    const first = invoke<{ ok: boolean; error?: string }>("volli:project-create", {
      path: "/repo/volli",
      name: "Volli Code",
    });
    const second = invoke<{ ok: boolean; error?: string }>("volli:project-create", {
      path: "/repo/compiler",
      name: "Visual Compiler",
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: false,
      error: 'Ticket prefix "VC" is already used by Volli Code.',
    });
  });
});

describe("volli:project-update — pinned base branch", () => {
  it("persists an editable base branch and returns the updated project", () => {
    const projectId = createProject();

    const result = invoke<{ ok: boolean; project?: { baseBranch: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "release/next" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ baseBranch: "release/next" }),
      }),
    );
    const bootstrap = invoke<BootstrapResult>("volli:data-bootstrap");
    expect(bootstrap).toMatchObject({
      ok: true,
      data: { projects: [{ id: projectId, baseBranch: "release/next" }] },
    });
  });

  it("trims a setup command and clears it to null on an empty string, leaving it untouched when omitted", () => {
    const projectId = createProject();

    const set = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: null, setupCommand: "  pnpm install  " },
    );
    expect(set).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ setupCommand: "pnpm install" }),
      }),
    );

    const untouched = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "main" },
    );
    expect(untouched.project?.setupCommand).toBe("pnpm install");

    const cleared = invoke<{ ok: boolean; project?: { setupCommand: string | null } }>(
      "volli:project-update",
      { id: projectId, baseBranch: "main", setupCommand: "   " },
    );
    expect(cleared).toEqual(
      expect.objectContaining({
        ok: true,
        project: expect.objectContaining({ setupCommand: null }),
      }),
    );
  });
});

describe("volli:ticket-create — ticket numbers never recycle across a hard delete (#35)", () => {
  it("skips a hard-deleted ticket's number instead of reusing it", () => {
    const projectId = createProject();

    const one = createTicket(projectId);
    const two = createTicket(projectId);
    const three = createTicket(projectId);
    expect([one.ticketNumber, two.ticketNumber, three.ticketNumber]).toEqual([1, 2, 3]);

    // Archive then hard-delete the highest-numbered ticket — the real
    // delete-from-archive path (`volli:ticket-delete` only permits deleting an
    // already-archived ticket).
    const archived = invoke<Result>("volli:ticket-archive", { ticketId: three.id });
    expect(archived.ok).toBe(true);
    const deleted = invoke<Result>("volli:ticket-delete", { ticketId: three.id });
    expect(deleted.ok).toBe(true);

    // Before the fix, MAX(ticket_number)+1 over the remaining rows would
    // reissue 3 here, colliding with the deleted ticket's retained worktree
    // branch. The counter must instead keep moving forward.
    const four = createTicket(projectId);
    expect(four.ticketNumber).toBe(4);
  });
});

describe("volli:ticket-create — body, labels, usesWorktree", () => {
  it("persists and hydrates body, labels, and usesWorktree", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "With extras",
      body: "# Heading\n\nDo the thing.",
      labels: ["bug", "ui"],
      usesWorktree: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ticket.body).toBe("# Heading\n\nDo the thing.");
    expect(result.ticket.labels).toEqual(["bug", "ui"]);
    expect(result.ticket.usesWorktree).toBe(false);

    // Hydrates identically through the boot bootstrap snapshot.
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const hydrated = boot.data.ticketsByProject[projectId]?.find((t) => t.id === result.ticket.id);
    expect(hydrated?.body).toBe("# Heading\n\nDo the thing.");
    expect(hydrated?.labels).toEqual(["bug", "ui"]);
    expect(hydrated?.usesWorktree).toBe(false);
  });

  it("defaults body/labels/usesWorktree when omitted (backward-compatible)", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "backlog",
      title: "Minimal",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.body).toBe("");
    expect(result.ticket.labels).toEqual([]);
    expect(result.ticket.usesWorktree).toBe(true);
    // No labels ⇒ no labels_changed event, only `created`.
    const events = invoke<TicketEventsResult>("volli:ticket-events", {
      ticketId: result.ticket.id,
    });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created"]);
  });

  it("persists and hydrates a kickoff-chosen preferredHarnessId, defaulting to claude-code when omitted", () => {
    const projectId = createProject();
    const chosen = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "doing",
      title: "Kicked off with codex",
      preferredHarnessId: "codex",
    });
    if (!chosen.ok) throw new Error(chosen.error);
    expect(chosen.ticket.preferredHarnessId).toBe("codex");

    const defaulted = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "backlog",
      title: "No kickoff",
    });
    if (!defaulted.ok) throw new Error(defaulted.error);
    expect(defaulted.ticket.preferredHarnessId).toBe("claude-code");

    // Both survive the boot bootstrap snapshot identically.
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const tickets = boot.data.ticketsByProject[projectId] ?? [];
    expect(tickets.find((t) => t.id === chosen.ticket.id)?.preferredHarnessId).toBe("codex");
    expect(tickets.find((t) => t.id === defaulted.ticket.id)?.preferredHarnessId).toBe(
      "claude-code",
    );
  });

  it("produces the same shared, name-deduped label rows the setLabels path would", () => {
    const projectId = createProject();
    // One ticket gets labels at creation; another gets the same labels via setLabels.
    invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Created with labels",
      labels: ["bug", "ui"],
    });
    const other = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-set-labels", { ticketId: other.id, labels: ["bug", "ui"] });

    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const labels = boot.data.labelsByProject[projectId] ?? [];
    // Exactly two rows (bug, ui), color null, shared across both tickets — no dupes.
    expect(labels.map((l) => l.name).toSorted()).toEqual(["bug", "ui"]);
    expect(labels.every((l) => l.color === null)).toBe(true);
  });

  it("records a labels_changed event after created when labels are supplied", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      labels: ["bug"],
    });
    if (!result.ok) throw new Error(result.error);
    const events = invoke<TicketEventsResult>("volli:ticket-events", {
      ticketId: result.ticket.id,
    });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created", "labels_changed"]);
    expect(events.events[1]?.payload).toEqual({
      kind: "labels_changed",
      added: ["bug"],
      removed: [],
    });
  });

  it("dedupes repeated label names into a single junction row like setLabels", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      labels: ["bug", "bug"],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.labels).toEqual(["bug"]);
    const boot = invoke<BootstrapResult>("volli:data-bootstrap");
    if (!boot.ok) throw new Error(boot.error);
    const labels = boot.data.labelsByProject[projectId] ?? [];
    expect(labels.map((l) => l.name)).toEqual(["bug"]);
  });

  it.each([
    ["a non-string body", { body: 5 }],
    ["a labels array with a non-string element", { labels: ["ok", 3] }],
    ["a non-array labels", { labels: "bug" }],
    ["a non-boolean usesWorktree", { usesWorktree: "yes" }],
    ["an unknown preferredHarnessId", { preferredHarnessId: "not-a-harness" }],
  ])("rejects %s", (_label, extra) => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A",
      ...extra,
    });
    expect(result).toEqual({ ok: false, error: "Invalid ticket" });
  });
});

describe("volli:ticket-update — worktree identity", () => {
  it("records one worktree_changed event when all three fields change together", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    expect(result.ok).toBe(true);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(1);
    expect(worktreeEvents[0]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: null, branch: null, baseBranch: null },
      to: {
        worktreePath: "/repo/.worktrees/VC-1",
        branch: "volli/VC-1-x",
        baseBranch: "main",
      },
    });
  });

  it("records a second worktree_changed event chaining from the prior identity", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: "/repo/.worktrees/VC-1",
      branch: "volli/VC-1-x",
      baseBranch: "main",
    });
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: "volli/VC-1-y" });

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents).toHaveLength(2);
    expect(worktreeEvents[1]?.payload).toEqual({
      kind: "worktree_changed",
      from: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-x", baseBranch: "main" },
      to: { worktreePath: "/repo/.worktrees/VC-1", branch: "volli/VC-1-y", baseBranch: "main" },
    });
  });

  it("an explicit null clears a previously-set worktree field, recorded in the event", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: "/repo/wt" });

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: null });

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "noop-touch",
    });
    expect(result.ok && result.ticket.worktreePath).toBeNull();

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    const worktreeEvents = events.events.filter((e) => e.payload.kind === "worktree_changed");
    expect(worktreeEvents[1]?.payload).toMatchObject({
      from: { worktreePath: "/repo/wt" },
      to: { worktreePath: null },
    });
  });

  it("keeps title/body behavior intact and does not fire worktree_changed for a plain title/body update", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
      body: "New body",
    });
    expect(result.ok && result.ticket.title).toBe("New title");
    expect(result.ok && result.ticket.body).toBe("New body");

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(
      expect.arrayContaining(["retitled", "body_edited"]),
    );
    expect(events.events.some((e) => e.payload.kind === "worktree_changed")).toBe(false);
  });

  it("rejects an invalid worktree field type", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, branch: 42 });
    expect(result).toEqual({ ok: false, error: "Invalid ticket update" });
  });

  it("rejects a syntactically-invalid branch name without persisting it", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: "bad..branch",
    });
    expect(result).toEqual({ ok: false, error: "Invalid branch name" });
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.branch).toBeNull();
  });

  it("rejects a syntactically-invalid base branch name", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      baseBranch: "-nope",
    });
    expect(result).toEqual({ ok: false, error: "Invalid base branch name" });
  });

  it("allows clearing the branch fields with an explicit null", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      branch: null,
      baseBranch: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe("archived-ticket guards — ticket-update/set-priority/set-labels/move", () => {
  it("volli:ticket-update rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
    });
    expect(result).toEqual({ ok: false, error: "Cannot update an archived ticket" });
  });

  it("volli:ticket-set-priority rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-set-priority", {
      ticketId: ticket.id,
      priority: "high",
    });
    expect(result).toEqual({
      ok: false,
      error: "Cannot change the priority of an archived ticket",
    });
  });

  it("volli:ticket-set-labels rejects a mutation against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketResult>("volli:ticket-set-labels", {
      ticketId: ticket.id,
      labels: ["bug"],
    });
    expect(result).toEqual({
      ok: false,
      error: "Cannot change the labels of an archived ticket",
    });
  });

  it("volli:ticket-move now errors instead of silently no-opping against an archived ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    archiveTicket(ticket.id);

    const result = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "todo",
      toIndex: 0,
    });
    expect(result).toEqual({ ok: false, error: "Cannot move an archived ticket" });
  });
});

describe("volli:ticket-move — backward-move interrupt (issue #78)", () => {
  /** Re-registers the data handlers with a stubbed interrupt seam returning `ids`. */
  function withInterrupt(ids: string[]) {
    const interruptTicketSessions = vi.fn((_ticketId: string) => ids);
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { interruptTicketSessions });
    return interruptTicketSessions;
  }

  function move(projectId: string, ticketId: string, toStatus: string): TicketsResult {
    return invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId,
      toStatus,
      toIndex: 0,
    });
  }

  function interruptedEvent(ticketId: string) {
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId });
    if (!events.ok) throw new Error("expected events");
    return events.events.find((event) => event.payload.kind === "sessions_interrupted");
  }

  it("interrupts the ticket's agent sessions and records sessions_interrupted on a doing→todo move", () => {
    const interrupt = withInterrupt(["s1", "s2"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    const result = move(projectId, ticket.id, "todo");

    expect(result.ok).toBe(true);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
    const event = interruptedEvent(ticket.id);
    expect(event?.payload).toEqual({ kind: "sessions_interrupted", sessionIds: ["s1", "s2"] });
    expect(event?.actor).toBe("user");
  });

  it("interrupts on a needs_review→done move (completion still exits the active columns)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    move(projectId, ticket.id, "needs_review");
    interrupt.mockClear();

    move(projectId, ticket.id, "done");

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
    expect(interruptedEvent(ticket.id)).toBeDefined();
  });

  it("does not interrupt a doing→needs_review move (still an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "needs_review");

    expect(interrupt).not.toHaveBeenCalled();
    expect(interruptedEvent(ticket.id)).toBeUndefined();
  });

  it("does not interrupt a todo→backlog move (never was an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "todo");
    interrupt.mockClear();

    move(projectId, ticket.id, "backlog");

    expect(interrupt).not.toHaveBeenCalled();
    expect(interruptedEvent(ticket.id)).toBeUndefined();
  });

  it("records nothing when the interrupt finds no live agent sessions", () => {
    const interrupt = withInterrupt([]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "todo");

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
    expect(interruptedEvent(ticket.id)).toBeUndefined();
  });
});

describe("volli:ticket-events", () => {
  it("rejects a non-object payload", () => {
    expect(invoke<TicketEventsResult>("volli:ticket-events", "nope")).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });

  it("returns the ticket's chronological event history", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created"]);
  });
});

describe("volli:comment-* channels", () => {
  it("comment-create rejects an empty body", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const result = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "   ",
    });
    expect(result).toEqual({ ok: false, error: "Invalid comment" });
  });

  it("creates a comment as the user actor, listable, updatable, and removable", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);

    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.comment.actor).toBe("user");

    const listed = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(listed.ok && listed.comments.map((c) => c.body)).toEqual(["Looks good"]);

    const updated = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: created.comment.id,
      body: "Looks great",
    });
    expect(updated.ok && updated.comment.body).toBe("Looks great");

    const removed = invoke<Result>("volli:comment-remove", { commentId: created.comment.id });
    expect(removed).toEqual({ ok: true });

    const afterRemove = invoke<TicketCommentsResult>("volli:comment-list", { ticketId: ticket.id });
    expect(afterRemove.ok && afterRemove.comments).toEqual([]);
  });

  it("also records a commented event, discoverable from volli:ticket-events", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const created = invoke<TicketCommentResult>("volli:comment-create", {
      ticketId: ticket.id,
      body: "Looks good",
    });
    if (!created.ok) throw new Error(created.error);

    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error(events.error);
    expect(events.events.map((e) => e.payload.kind)).toEqual(["created", "commented"]);
    expect(events.events[1]?.payload).toEqual({ kind: "commented", commentId: created.comment.id });
  });

  it("comment-update returns a typed error for an unknown commentId", () => {
    const result = invoke<TicketCommentResult>("volli:comment-update", {
      commentId: "nope",
      body: "x",
    });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });

  it("comment-remove returns a typed error for an unknown commentId", () => {
    const result = invoke<Result>("volli:comment-remove", { commentId: "nope" });
    expect(result).toEqual({ ok: false, error: "Unknown comment" });
  });
});

describe("volli:session-list / volli:session-list-for-ticket", () => {
  it("session-list returns every session in a project, newest first", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", createdAt: 100 }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "s2", createdAt: 200 }));

    const result = invoke<SessionsResult>("volli:session-list", { projectId });
    expect(result.ok && result.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("session-list-for-ticket scopes to just that ticket", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "scratch" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "scoped" }));

    const result = invoke<SessionsResult>("volli:session-list-for-ticket", { ticketId: ticket.id });
    expect(result.ok && result.sessions.map((s) => s.id)).toEqual(["scoped"]);
  });

  it("rejects invalid input", () => {
    expect(invoke<SessionsResult>("volli:session-list", 42)).toEqual({
      ok: false,
      error: "Invalid project",
    });
    expect(invoke<SessionsResult>("volli:session-list-for-ticket", 42)).toEqual({
      ok: false,
      error: "Invalid ticket",
    });
  });
});

describe("volli:session-rename", () => {
  it("renames a session and persists the trimmed title", () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));

    const result = invoke<SessionRenameResult>("volli:session-rename", {
      sessionId: "s1",
      title: "  Renamed  ",
    });
    expect(result).toEqual({ ok: true });

    const list = invoke<SessionsResult>("volli:session-list", { projectId });
    expect(list.ok && list.sessions[0]?.title).toBe("Renamed");
  });

  it("rejects a blank title", () => {
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "s1", title: "   " }),
    ).toEqual({ ok: false, error: "Invalid session title" });
  });

  it("reports an unknown session", () => {
    createProject();
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "ghost", title: "X" }),
    ).toEqual({ ok: false, error: "Unknown session" });
  });
});

describe("volli:worktree-remove", () => {
  it("acks on success and broadcasts data-changed", async () => {
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
      force: false,
    });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), "ticket-1", {
      force: false,
    });
    expect(dataChangedSends).toContainEqual({
      channel: "volli:data-changed",
      payload: { entity: "tickets" },
    });
  });

  it("refuses (main-side) when a live session runs in the ticket's worktree, never calling remove", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-live`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });

    handlers.clear();
    // A session whose cwd is INSIDE the worktree must block the removal.
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { liveSessionCwds: () => [`${worktreePath}/packages`] },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "Close the terminal sessions running in this worktree before removing it.",
    });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });

  it("surfaces a dirty-worktree refusal as a typed error", async () => {
    vi.mocked(removeWorktree).mockResolvedValue({
      ok: false,
      error: "Worktree has uncommitted work (dirty). Confirm removal to discard it.",
    });

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "Worktree has uncommitted work (dirty). Confirm removal to discard it.",
    });
  });

  it("rejects a missing force flag", async () => {
    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: "ticket-1",
    });
    expect(result).toEqual({ ok: false, error: "Invalid worktree removal" });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });
});

describe("volli:worktree-branches", () => {
  it("returns the project's local branch names", () => {
    vi.mocked(listBranches).mockReturnValue({ ok: true, value: ["main", "dev"] });

    const result = invoke<WorktreeBranchesResult>("volli:worktree-branches", {
      projectId: "project-1",
    });

    expect(result).toEqual({ ok: true, branches: ["main", "dev"] });
  });

  it("rejects a non-string projectId", () => {
    const result = invoke<WorktreeBranchesResult>("volli:worktree-branches", 42);
    expect(result).toEqual({ ok: false, error: "Invalid project" });
    expect(vi.mocked(listBranches)).not.toHaveBeenCalled();
  });
});

describe("volli:worktree-orphans", () => {
  const report = {
    pruned: ["project-1"],
    removedClean: ["/wt/orphan"],
    dirty: [{ path: "/wt/dirty", projectId: "project-1", reason: "uncommitted work" }],
  };

  it("wraps the sweep report in the ok result shape", async () => {
    vi.mocked(sweepOrphans).mockResolvedValue(report);

    const result = await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    expect(result).toEqual({ ok: true, ...report });
  });

  it("returns the cached report without re-sweeping on a second call within a launch", async () => {
    vi.mocked(sweepOrphans).mockResolvedValue(report);

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");

    // The destructive sweep must run exactly ONCE per launch (a renderer reload
    // re-invokes this channel, and it must not re-sweep or race the launch sweep).
    expect(vi.mocked(sweepOrphans)).toHaveBeenCalledTimes(1);
  });

  it("re-sweeps only on an explicit rescan", async () => {
    vi.mocked(sweepOrphans).mockResolvedValue(report);

    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans");
    await invoke<Promise<WorktreeOrphansResult>>("volli:worktree-orphans", { rescan: true });

    expect(vi.mocked(sweepOrphans)).toHaveBeenCalledTimes(2);
  });
});

describe("volli:worktree-orphan-delete", () => {
  let home: string;

  beforeEach(() => {
    // A throwaway worktree home so the sanctioned rm -rf never touches the real
    // ~/.volli/worktrees. Read fresh per call by resolveHome, so setting it here
    // is enough; handlers registered in the outer beforeEach see it too.
    home = mkdtempSync(join(tmpdir(), "volli-orphan-home-"));
    process.env["VOLLI_WORKTREE_HOME_DIR"] = home;
  });

  afterEach(() => {
    delete process.env["VOLLI_WORKTREE_HOME_DIR"];
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a path outside the worktree home without deleting", async () => {
    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: join(tmpdir(), "somewhere-else") },
    );
    expect(result).toEqual({ ok: false, error: "Path is outside the worktree home" });
  });

  it("refuses to delete a worktree the DB still tracks (linked to a ticket)", async () => {
    const target = join(worktreesHome(), "VC-1-tracked");
    mkdirSync(target, { recursive: true });
    // A ticket still points at this path — listWorktreePaths must veto the delete.
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath: target });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({
      ok: false,
      error: "This worktree is still linked to a ticket and can't be deleted here.",
    });
    expect(existsSync(target)).toBe(true);
  });

  it("refuses when a live session runs at or under the target", async () => {
    const target = join(worktreesHome(), "VC-2-live");
    mkdirSync(target, { recursive: true });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { liveSessionCwds: () => [join(target, "src")] },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({
      ok: false,
      error: "Close the terminal sessions running in this worktree before deleting it.",
    });
    expect(existsSync(target)).toBe(true);
  });

  it("deletes an untracked, session-free orphan and broadcasts data-changed", async () => {
    const target = join(worktreesHome(), "VC-3-orphan");
    mkdirSync(target, { recursive: true });

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    expect(existsSync(target)).toBe(false);
    expect(dataChangedSends).toContainEqual({
      channel: "volli:data-changed",
      payload: { entity: "tickets" },
    });
  });
});

describe("degraded db handle", () => {
  it("every new channel resolves with the degraded error instead of throwing", async () => {
    handlers.clear();
    registerDataIpcHandlers({ ok: false, error: "db is down" });

    expect(invoke<TicketEventsResult>("volli:ticket-events", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<TicketCommentsResult>("volli:comment-list", { ticketId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<SessionsResult>("volli:session-list", { projectId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "x", title: "Y" }),
    ).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(
      invoke<WorktreeRemoveResult>("volli:worktree-remove", { ticketId: "x", force: false }),
    ).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<WorktreeBranchesResult>("volli:worktree-branches", { projectId: "x" })).toEqual({
      ok: false,
      error: "db is down",
    });
    expect(invoke<WorktreeOrphansResult>("volli:worktree-orphans")).toEqual({
      ok: false,
      error: "db is down",
    });
  });
});
