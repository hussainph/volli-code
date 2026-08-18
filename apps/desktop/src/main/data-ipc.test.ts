import { DATA_CHANNELS } from "./ipc-descriptors";
import type { SessionListingRow, Ticket } from "@volli/shared";
import type {
  AppStateSetResult,
  BootstrapResult,
  ProjectCreateResult,
  ProjectMutationResult,
  Result,
  RetentionTtlResult,
  SessionRenameResult,
  SessionsResult,
  TicketCommentResult,
  TicketCommentsResult,
  TicketEventsResult,
  TicketLatestSignalsResult,
  TicketResult,
  TicketStatusEntriesResult,
  TicketsResult,
  VolliIpcChannel,
  WorktreeBranchesResult,
  WorktreeCommitResult,
  WorktreeOrphanDeleteResult,
  WorktreeOrphansResult,
  WorktreeRemoveResult,
} from "../ipc/contract";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  // `worktree-runtime`'s real `worktreeDeps` resolves `attachmentsRoot` off
  // this — a stable stand-in path is enough since none of the mocked worktree
  // functions below actually read it.
  app: {
    getPath: () => "/volli-test-userdata",
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
  // The scope-switch materialize path (VC-98). Mocked like every other git
  // verb here; the ensure pipeline itself is covered by `worktree/ensure.test.ts`.
  ensure: vi.fn(),
  // Referenced (not called) by `worktree-runtime`'s `worktreeDeps` — needs a
  // stub export so that value import doesn't throw under strict ESM mocking.
  runGitCapturing: vi.fn(),
  runGitCapturingAsync: vi.fn(),
  // Constructed at registration time; these tests exercise no watch channel, so
  // a no-op stand-in keeps real `fs.watch` handles out of the suite.
  WorktreeChangeWatchManager: class {
    watch = vi.fn(() => ({ ok: true as const }));
    unwatch = vi.fn();
    unwatchTicket = vi.fn();
  },
}));

import { registerDataIpcHandlers } from "./data-ipc";
import { createDesktopSessionEngine } from "./session-control";
import { insertSession } from "./session-control/test-support";
import { openTestDb, testSession } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { resetOrphanSweepForTest } from "./orphan-sweep";
import { worktreesHome } from "./worktree-runtime";
import { ensure, listBranches, remove as removeWorktree, sweepOrphans } from "./worktree";
import { updateTicketFieldsCommand } from "./ticket-commands";

/** Fake IPC event; unused by any data-ipc handler, but every handler signature expects one. */
const fakeEvent = { sender: {} };

/** Invokes a captured handler the way `ipcMain.handle` dispatch would. */
function invoke<T>(channel: VolliIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)(fakeEvent, ...args);
}

let ctx: TestDb;

// `volli:project-create` now requires an existing directory (main-side path
// validation, see data-ipc.ts) — every fixture project needs a real temp dir
// rather than a fabricated path like the old "/repo/proj". Tracked here so
// `afterEach` can remove them all regardless of which test created them.
const createdProjectDirs: string[] = [];

/** A fresh, real, empty directory for a `volli:project-create` fixture path. */
function freshProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-project-"));
  createdProjectDirs.push(dir);
  return dir;
}

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
  for (const dir of createdProjectDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const result = invoke<{ ok: true; project: { id: string } }>("volli:project-create", {
    path: freshProjectDir(),
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
    const volliPath = freshProjectDir();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { detectBaseBranch: (path) => (path === volliPath ? "trunk" : null) },
    );

    const result = invoke<ProjectCreateResult>("volli:project-create", {
      path: volliPath,
      name: "Volli Code",
    });

    expect(result).toMatchObject({ ok: true, project: { baseBranch: "trunk" } });
  });

  it("surfaces the colliding project instead of creating an ambiguous display-id namespace", () => {
    const first = invoke<{ ok: boolean; error?: string }>("volli:project-create", {
      path: freshProjectDir(),
      name: "Volli Code",
    });
    const second = invoke<{ ok: boolean; error?: string }>("volli:project-create", {
      path: freshProjectDir(),
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

  it("persists the composer's chosen baseBranch, and rejects a name git could not take", () => {
    const projectId = createProject();
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Based on a release branch",
      baseBranch: "release/1.4",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.ticket.baseBranch).toBe("release/1.4");

    // The command layer's branch-name validation is the shared gate; a throw
    // there reaches the renderer as a failed Result, never as a silent create.
    const bad = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "Based on nonsense",
      baseBranch: "..",
    });
    expect(bad).toEqual({ ok: false, error: "Invalid base branch name" });
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
    // A slug no manifest could be registered under. A well-formed one is
    // accepted here on purpose — whether the user actually trusted it is
    // main's question, asked at the launch door where it can be answered.
    ["a preferredHarnessId no harness could be filed under", { preferredHarnessId: "../etc" }],
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

describe("volli:ticket-update — switching worktree scope on (VC-98)", () => {
  /** A ticket that starts out running in the project's main checkout. */
  function mainCheckoutTicket(projectId: string): Ticket {
    const result = invoke<TicketResult>("volli:ticket-create", {
      projectId,
      status: "todo",
      title: "A ticket",
      usesWorktree: false,
    });
    if (!result.ok) throw new Error(result.error);
    return result.ticket;
  }

  /** Stands in for the real pipeline: stamps identity the way `ensure` does on success. */
  function ensureStamps(worktreePath: string): void {
    vi.mocked(ensure).mockImplementation(async (_deps, ticketId: string) => {
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId, worktreePath, branch: "volli/VC-1-a-ticket", baseBranch: "main" },
        { now: Date.now(), actor: { kind: "automation" } },
      );
      return {
        ok: true as const,
        value: {
          identity: { worktreePath, branch: "volli/VC-1-a-ticket", baseBranch: "main" },
          created: true,
        },
      };
    });
  }

  it("materializes the worktree and answers with the stamped identity", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    ensureStamps("/wt/VC-1-a-ticket");

    const result = await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    expect(ensure).toHaveBeenCalledTimes(1);
    // The whole point of the ticket: scope is no longer an intention nothing
    // acts on, and the answer carries the identity `ensure` stamped AFTER the
    // scope write committed — so the caller never sees the stale null.
    expect(result).toMatchObject({
      ok: true,
      ticket: {
        usesWorktree: true,
        worktreePath: "/wt/VC-1-a-ticket",
        branch: "volli/VC-1-a-ticket",
        baseBranch: "main",
      },
    });
  });

  it("re-hydrates every window so the rail stops showing a worktree-less ticket", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    ensureStamps("/wt/VC-1-a-ticket");
    dataChangedSends.length = 0;

    await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    expect(dataChangedSends).toContainEqual({
      channel: "volli:data-changed",
      payload: { entity: "tickets", ticketId: ticket.id, projectId, kind: "worktree" },
    });
  });

  it("leaves scope on and surfaces the git reason when the worktree can't be created", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    vi.mocked(ensure).mockResolvedValue({
      ok: false as const,
      error: "fatal: not a git repository",
    });

    const result = await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // Reported as a failed mutation so it reaches a toast rather than dying in
    // the phase stream. The scope flag still stands: it is the user's recorded
    // intent, and a worktree-scoped ticket with no worktree refuses to bind a
    // Session to the main checkout instead of quietly falling back to it.
    expect(result).toEqual({
      ok: false,
      error: "worktree scope is on, but fatal: not a git repository",
    });
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.usesWorktree).toBe(true);
    expect(after.ok && after.ticket.worktreePath).toBeNull();
  });

  it("does not touch git for an update that leaves worktree scope alone", () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);

    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      title: "New title",
    });

    // Still the synchronous write it has always been — a title edit must not
    // become a promise, nor drag a worktree into being.
    expect(result).toMatchObject({ ok: true });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not materialize when scope is switched OFF", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId); // worktree-scoped by default

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: false });

    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not re-materialize when scope is re-asserted as already on", () => {
    const projectId = createProject();
    const ticket = createTicket(projectId); // already worktree-scoped

    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, usesWorktree: true });

    // No transition, no git: `ensure` is idempotent but not free, and a ticket
    // whose scope never moved has not asked for anything.
    expect(ensure).not.toHaveBeenCalled();
  });

  it("refuses a scope switch-off while the worktree is still being created", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    // `ensure` parked mid-flight, exactly where the real pipeline spends its
    // seconds: after the scope write committed, before the identity stamp.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ensure).mockImplementation(async (_deps, ticketId: string) => {
      await parked;
      updateTicketFieldsCommand(
        ctx.db,
        { ticketId, worktreePath: "/wt/VC-1-a-ticket", branch: "volli/VC-1", baseBranch: "main" },
        { now: Date.now(), actor: { kind: "automation" } },
      );
      return {
        ok: true as const,
        value: {
          identity: {
            worktreePath: "/wt/VC-1-a-ticket",
            branch: "volli/VC-1",
            baseBranch: "main",
          },
          created: true,
        },
      };
    });

    const inFlight = invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // The mis-click correction: the user reopens the destination picker and
    // switches back before the worktree finishes appearing. Permitting this
    // wrote `uses_worktree: 0` against a still-null path, and `ensure` then
    // stamped a worktree onto it — a contradiction the scope freeze made
    // permanent, leaving the ticket main-checkout-scoped with a worktree on
    // disk and no way back through the UI.
    const refused = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: false,
    });
    expect(refused).toEqual({
      ok: false,
      error:
        "The ticket's worktree is still being created, so its worktree scoping can't change yet. Try again once it's ready.",
    });

    release();
    await inFlight;

    // Scope and stamp agree, so the freeze locks in a coherent state.
    const after = invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, title: "t" });
    expect(after.ok && after.ticket.usesWorktree).toBe(true);
    expect(after.ok && after.ticket.worktreePath).toBe("/wt/VC-1-a-ticket");
  });

  it("lets scope change again once materialization has finished", async () => {
    const projectId = createProject();
    const ticket = mainCheckoutTicket(projectId);
    // Succeeds without stamping a path, so the scope freeze stays open and this
    // test measures the in-flight hold alone rather than the freeze.
    vi.mocked(ensure).mockResolvedValue({
      ok: true as const,
      value: {
        identity: { worktreePath: null, branch: "volli/VC-1", baseBranch: "main" },
        created: false,
      },
    });

    await invoke<Promise<TicketResult>>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: true,
    });

    // The hold is released in `finally`, so it never outlives the git work.
    const result = invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      usesWorktree: false,
    });
    expect(result.ok && result.ticket.usesWorktree).toBe(false);
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

  it("interrupts the ticket's agent attachments on a doing→todo move without planner history", () => {
    const interrupt = withInterrupt(["s1", "s2"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();
    const before = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!before.ok) throw new Error("expected events");

    const result = move(projectId, ticket.id, "todo");

    expect(result.ok).toBe(true);
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
    const events = invoke<TicketEventsResult>("volli:ticket-events", { ticketId: ticket.id });
    if (!events.ok) throw new Error("expected events");
    expect(events.events).toHaveLength(before.events.length + 1); // just the board move
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
  });

  it("does not interrupt a doing→needs_review move (still an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "needs_review");

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("does not interrupt a todo→backlog move (never was an active column)", () => {
    const interrupt = withInterrupt(["s1"]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "todo");
    interrupt.mockClear();

    move(projectId, ticket.id, "backlog");

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("records nothing when the interrupt finds no live agent sessions", () => {
    const interrupt = withInterrupt([]);
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");
    interrupt.mockClear();

    move(projectId, ticket.id, "todo");

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(ticket.id);
  });

  it("keeps the committed move successful when the asynchronous interrupt rejects", async () => {
    const interruptTicketSessions = vi.fn(async () => {
      throw new Error("terminal interrupt unavailable");
    });
    const logFailure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { interruptTicketSessions });
    const projectId = createProject();
    const ticket = createTicket(projectId);
    move(projectId, ticket.id, "doing");

    const result = await invoke<Promise<TicketsResult>>("volli:ticket-move", {
      projectId,
      ticketId: ticket.id,
      toStatus: "todo",
      toIndex: 0,
    });

    expect(result.ok && result.tickets[0]?.status).toBe("todo");
    expect(logFailure).toHaveBeenCalledWith(
      "[volli] failed to interrupt ticket sessions after committed move: terminal interrupt unavailable",
    );
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

/** A row's identity, whichever kind it is — `SessionRecord.id` and `ChatSessionRecord.sessionId` are the same session, spelled differently per the DTO. */
function rowId(row: SessionListingRow): string {
  return row.kind === "terminal" ? row.record.id : row.record.sessionId;
}

describe("volli:session-list / volli:session-list-for-ticket", () => {
  it("session-list returns every session in a project, newest first", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", createdAt: 100 }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "s2", createdAt: 200 }));

    const result = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(result.ok && result.sessions.map(rowId)).toEqual(["s2", "s1"]);
  });

  it("session-list-for-ticket scopes to just that ticket", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, null, { id: "scratch" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "scoped" }));

    const result = await invoke<Promise<SessionsResult>>("volli:session-list-for-ticket", {
      ticketId: ticket.id,
    });
    expect(result.ok && result.sessions.map(rowId)).toEqual(["scoped"]);
  });

  it("renders a structured-only Session as a chat row instead of dropping it", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "terminal-session" }));
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 500 });
    const structured = await sessionEngine.createSession({
      commandId: "structured-create",
      projectId,
      ticketId: ticket.id,
      title: "Structured OpenCode Session",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const projectSessions = await invoke<Promise<SessionsResult>>("volli:session-list", {
      projectId,
    });
    const ticketSessions = await invoke<Promise<SessionsResult>>("volli:session-list-for-ticket", {
      ticketId: ticket.id,
    });

    expect(projectSessions.ok && projectSessions.sessions.map(rowId)).toEqual([
      structured.session.id,
      "terminal-session",
    ]);
    expect(ticketSessions.ok && ticketSessions.sessions.map(rowId)).toEqual([
      structured.session.id,
      "terminal-session",
    ]);
    expect(
      projectSessions.ok &&
        projectSessions.sessions.find((row) => rowId(row) === structured.session.id),
    ).toEqual({
      kind: "chat",
      record: {
        sessionId: structured.session.id,
        title: "Structured OpenCode Session",
        projectId,
        ticketId: ticket.id,
        createdAt: 500,
        adapterId: null,
        live: false,
        activity: "idle",
        waitingOn: null,
        lastActivityAt: 500,
        bornTicketless: false,
      },
    });
    expect(
      projectSessions.ok &&
        projectSessions.sessions.find((row) => rowId(row) === "terminal-session"),
    ).toMatchObject({ kind: "terminal" });
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

describe("volli:ticket-latest-signals", () => {
  it("uses the SessionEngine's bounded latest-signal query with a deterministic session-id tie-break", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 500 });
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "session-a" }));
    insertSession(ctx.db, testSession(projectId, ticket.id, { id: "session-z" }));
    await sessionEngine.submit({
      commandId: "signal-a",
      sessionId: "session-a",
      intent: { kind: "session.signal", signal: "done", reason: "Earlier id" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    await sessionEngine.submit({
      commandId: "signal-z",
      sessionId: "session-z",
      intent: { kind: "session.signal", signal: "blocked", reason: "Later id" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const listSessions = vi
      .spyOn(sessionEngine, "listSessions")
      .mockRejectedValue(new Error("should not project every session"));
    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { sessionEngine });

    const result = await invoke<Promise<TicketLatestSignalsResult>>("volli:ticket-latest-signals", {
      projectId,
    });

    expect(result).toEqual({
      ok: true,
      signals: [
        {
          ticketId: ticket.id,
          sessionId: "session-z",
          signal: "blocked",
          reason: "Later id",
          createdAt: 500,
        },
      ],
    });
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe("volli:ticket-status-entries", () => {
  it("dates a moved ticket by its latest status_changed event and a never-moved ticket by its own createdAt", () => {
    const projectId = createProject();
    const moved = createTicket(projectId);
    const neverMoved = createTicket(projectId);

    const before = Date.now();
    const moveResult = invoke<TicketsResult>("volli:ticket-move", {
      projectId,
      ticketId: moved.id,
      toStatus: "doing",
      toIndex: 0,
    });
    const after = Date.now();
    expect(moveResult.ok).toBe(true);

    const result = invoke<TicketStatusEntriesResult>("volli:ticket-status-entries", { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const movedEntry = result.entries.find((e) => e.ticketId === moved.id);
    expect(movedEntry?.status).toBe("doing");
    expect(movedEntry?.enteredAt).toBeGreaterThanOrEqual(before);
    expect(movedEntry?.enteredAt).toBeLessThanOrEqual(after);

    const neverMovedEntry = result.entries.find((e) => e.ticketId === neverMoved.id);
    expect(neverMovedEntry).toEqual({
      ticketId: neverMoved.id,
      status: "backlog",
      enteredAt: neverMoved.createdAt,
    });
  });

  it("excludes archived tickets", () => {
    const projectId = createProject();
    const live = createTicket(projectId);
    const archived = createTicket(projectId);
    archiveTicket(archived.id);

    const result = invoke<TicketStatusEntriesResult>("volli:ticket-status-entries", { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.map((e) => e.ticketId)).toEqual([live.id]);
  });
});

describe("volli:session-rename", () => {
  it("renames a session and persists the trimmed title", async () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));

    const result = await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
      sessionId: "s1",
      title: "  Renamed  ",
    });
    expect(result).toEqual({ ok: true });

    const list = await invoke<Promise<SessionsResult>>("volli:session-list", { projectId });
    expect(list.ok && list.sessions[0]?.record.title).toBe("Renamed");
  });

  it("rejects a blank title", () => {
    expect(
      invoke<SessionRenameResult>("volli:session-rename", { sessionId: "s1", title: "   " }),
    ).toEqual({ ok: false, error: "Invalid session title" });
  });

  it("reports an unknown session", async () => {
    createProject();
    expect(
      await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
        sessionId: "ghost",
        title: "X",
      }),
    ).toEqual({ ok: false, error: "Unknown session" });
  });

  it("reports a durable rejection instead of acknowledging an archived session rename", async () => {
    const projectId = createProject();
    insertSession(ctx.db, testSession(projectId, null, { id: "s1", title: "Session 1" }));
    await createDesktopSessionEngine(ctx.db).submit({
      commandId: "archive-s1",
      sessionId: "s1",
      intent: { kind: "session.archive" },
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });

    expect(
      await invoke<Promise<SessionRenameResult>>("volli:session-rename", {
        sessionId: "s1",
        title: "Renamed",
      }),
    ).toEqual({ ok: false, error: "Session rename was not completed" });
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
    // Targeted at the ticket whose worktree path was cleared (projectId is
    // undefined here — no ticket row was seeded — and undefined keys are ignored).
    expect(dataChangedSends).toContainEqual({
      channel: "volli:data-changed",
      payload: { entity: "tickets", ticketId: "ticket-1", kind: "worktree" },
    });
  });

  it("refuses (main-side) when a terminal runs in the ticket's worktree, never calling remove", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-live`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });

    handlers.clear();
    // A session whose cwd is INSIDE the worktree must block the removal.
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        busyWorktreeSites: async () => [
          { directory: `${worktreePath}/packages`, surface: "terminal" },
        ],
      },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "A terminal is still running in this worktree. Close it first.",
    });
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
  });

  // The defect this guard used to have: an attached chat reported its worktree
  // busy for as long as the app ran, whether or not anything was in flight and
  // long after its tab was closed, and nothing the user could do cleared it.
  // A worktree nothing is working in is removed without a fight.
  it("removes a worktree no busy site names", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-quiet`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { busyWorktreeSites: async () => [] });

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({ ok: true });
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), ticket.id, {
      force: false,
    });
  });

  it("names stopping the agent when the busy surface is one, not closing a terminal", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-agent`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { busyWorktreeSites: async () => [{ directory: worktreePath, surface: "agent" }] },
    );

    const result = await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(result).toEqual({
      ok: false,
      error: "An agent is still running in this worktree. Stop it first.",
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

  // The busy read costs one durable projection per binding under the target, so
  // it is asked about ONE directory: whole-list answers made every destructive
  // action replay the ledger of every chat the launch had opened.
  it("asks the busy supplier about the ticket's own worktree, not the whole app", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    const worktreePath = `${worktreesHome()}/VC-9-scoped`;
    invoke<TicketResult>("volli:ticket-update", { ticketId: ticket.id, worktreePath });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });
    const asked: string[] = [];

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        busyWorktreeSites: async (target) => {
          asked.push(target);
          return [];
        },
      },
    );

    await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(asked).toEqual([worktreePath]);
  });

  // `remove` owns the ordering (after its dirty gate, before the delete); this
  // handler's job is only to hand it the seam.
  it("hands the release seam to remove so no Session is left pointed at the deleted path", async () => {
    const projectId = createProject();
    const ticket = createTicket(projectId);
    invoke<TicketResult>("volli:ticket-update", {
      ticketId: ticket.id,
      worktreePath: `${worktreesHome()}/VC-9-release`,
    });
    vi.mocked(removeWorktree).mockResolvedValue({ ok: true, value: undefined });
    const releaseAgentSites = vi.fn(async () => ({ released: [], stillOpen: [] }));

    handlers.clear();
    registerDataIpcHandlers({ ok: true, db: ctx.db }, { releaseAgentSites });

    await invoke<Promise<WorktreeRemoveResult>>("volli:worktree-remove", {
      ticketId: ticket.id,
      force: false,
    });

    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith(expect.anything(), ticket.id, {
      force: false,
      releaseAgentSites,
    });
  });
});

describe("volli:worktree-branches", () => {
  it("flattens the listing onto the result envelope", () => {
    vi.mocked(listBranches).mockReturnValue({
      ok: true,
      value: {
        branches: ["main", "dev"],
        current: "dev",
        remotes: ["origin/main"],
        fetchedAt: 1_700_000_000_000,
      },
    });

    const result = invoke<WorktreeBranchesResult>("volli:worktree-branches", {
      projectId: "project-1",
    });

    expect(result).toEqual({
      ok: true,
      branches: ["main", "dev"],
      current: "dev",
      remotes: ["origin/main"],
      fetchedAt: 1_700_000_000_000,
    });
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

  it("refuses when something is still working at or under the target", async () => {
    const target = join(worktreesHome(), "VC-2-live");
    mkdirSync(target, { recursive: true });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        busyWorktreeSites: async () => [{ directory: join(target, "src"), surface: "terminal" }],
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({
      ok: false,
      error: "A terminal is still running in this worktree. Close it first.",
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
    // An orphan is unlinked from any live ticket, so this broadcast is untargeted.
    expect(dataChangedSends).toContainEqual({
      channel: "volli:data-changed",
      payload: { entity: "tickets", kind: "worktree" },
    });
  });

  // Deleting a ticket only nulls `sessions.ticket_id`, so a Session can still be
  // bound to what became an orphan. Without this it kept dispatching into a path
  // the rm had already taken away.
  it("ends the bindings rooted in the orphan before the rm, and asks the busy read about it", async () => {
    const target = join(worktreesHome(), "VC-4-bound");
    mkdirSync(target, { recursive: true });
    // Both seams see the canonicalized target — the same path the containment
    // guard and the rm run on, `/private` aliasing already resolved.
    const canonical = realpathSync.native(target);
    const order: string[] = [];
    const asked: string[] = [];

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      {
        busyWorktreeSites: async (probed) => {
          asked.push(probed);
          return [];
        },
        releaseAgentSites: async (directory) => {
          order.push(`release:${directory}`);
          order.push(existsSync(target) ? "dir:present" : "dir:gone");
          return { released: ["chat-1"], stillOpen: [] };
        },
      },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    expect(asked).toEqual([canonical]);
    // Released while the directory still exists, so the executor stops in a cwd
    // that is still there.
    expect(order).toEqual([`release:${canonical}`, "dir:present"]);
    expect(existsSync(target)).toBe(false);
  });

  it("still deletes the orphan when a binding refuses to close", async () => {
    // The always-confirmed path: the Settings row printed the dirtiness reason
    // and the user said yes, and this is the only way to clear a dirty orphan.
    const target = join(worktreesHome(), "VC-5-stubborn");
    mkdirSync(target, { recursive: true });

    handlers.clear();
    registerDataIpcHandlers(
      { ok: true, db: ctx.db },
      { releaseAgentSites: async () => ({ released: [], stillOpen: ["chat-1"] }) },
    );

    const result = await invoke<Promise<WorktreeOrphanDeleteResult>>(
      "volli:worktree-orphan-delete",
      { path: target },
    );

    expect(result).toEqual({ ok: true });
    expect(existsSync(target)).toBe(false);
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

  it("answers EVERY DATA_CHANNELS member with the degraded error — the omitted-channel defect (issue #98)", () => {
    handlers.clear();
    registerDataIpcHandlers({ ok: false, error: "db is down" });

    for (const channel of DATA_CHANNELS) {
      expect(invoke(channel)).toEqual({ ok: false, error: "db is down" });
    }
  });
});

describe("registerDataIpcHandlers — registration completeness", () => {
  it("registers a handler for every DATA_CHANNELS member when the db opened successfully", () => {
    // `ctx`'s outer beforeEach already registered a healthy handle — assert
    // the resulting table (not a hand-picked subset) covers the whole contract.
    for (const channel of DATA_CHANNELS) {
      expect(handlers.has(channel)).toBe(true);
    }
  });
});

describe("descriptor guard rejections reach the caller through the envelope, one per argument shape", () => {
  it("zero-arg shape: rejects a stray argument", () => {
    expect(invoke<RetentionTtlResult>("volli:retention-ttl-get", "unexpected")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("single string-arg shape: rejects a non-string", () => {
    expect(invoke<ProjectMutationResult>("volli:project-remove", { not: "a string" })).toEqual({
      ok: false,
      error: "Invalid project id",
    });
  });

  it("single string-array-arg shape: rejects a non-array", () => {
    expect(invoke<ProjectMutationResult>("volli:project-reorder", "not-an-array")).toEqual({
      ok: false,
      error: "Invalid project order",
    });
  });

  it("single object-arg shape: rejects garbage — e.g. ticket-move", () => {
    expect(invoke<TicketsResult>("volli:ticket-move", "nope")).toEqual({
      ok: false,
      error: "Invalid ticket move",
    });
  });

  it("two-positional-string-arg shape: rejects the wrong types", () => {
    expect(invoke<AppStateSetResult>("volli:app-state-set", 1, 2)).toEqual({
      ok: false,
      error: "Invalid app state",
    });
  });

  it("optional-object-arg shape: rejects a non-object argument", () => {
    expect(invoke<WorktreeOrphansResult>("volli:worktree-orphans", "nope")).toEqual({
      ok: false,
      error: "Invalid request",
    });
  });

  it("object-with-optional-fields shape: a commit message carrying a control character never reaches git", () => {
    expect(
      invoke<WorktreeCommitResult>("volli:worktree-commit", {
        ticketId: "t1",
        message: "subject\u0000--amend",
      }),
    ).toEqual({ ok: false, error: "Invalid commit request" });
    expect(
      invoke<WorktreeCommitResult>("volli:worktree-commit", {
        ticketId: "t1",
        includeUnstaged: "yes",
      }),
    ).toEqual({ ok: false, error: "Invalid commit request" });
  });
});
