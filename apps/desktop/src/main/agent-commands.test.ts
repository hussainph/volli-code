import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type {
  AgentRequest,
  AgentResponse,
  DoctorCheck,
  HarnessEventNotice,
  SessionHarnessNotice,
  HarnessId,
} from "@volli/shared";

import { createAttachment } from "./db/attachments-repo";
import { listHarnessChannels } from "./db/harness-channel-repo";
import { getRegisteredHarness, recordHarnessTrust } from "./db/harness-registry-repo";
import { insertProject } from "./db/projects-repo";
import { endSession, getSession, insertSession, setActiveHarnessId } from "./db/sessions-repo";
import { insertTicket } from "./db/tickets-repo";
import { openTestDb, testProject, testSession, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createAgentCommandService } from "./agent-commands";
import { updateTicketFieldsCommand } from "./ticket-commands";
import { scriptedGit } from "./worktree/scripted-git";

let ctx: TestDb;

afterEach(() => ctx.cleanup());

/** The `sessions_interrupted` event payload for VC-1, if the backward move recorded one. */
async function interruptedEventPayload(
  exec: (cmd: AgentRequest["cmd"], args: Record<string, unknown>) => Promise<unknown>,
): Promise<{ kind: string; sessionIds?: string[] } | undefined> {
  const events = (await exec("ticket.events", { id: "VC-1", limit: 10 })) as {
    ok: boolean;
    data: { events: { payload: { kind: string; sessionIds?: string[] } }[] };
  };
  return events.data.events
    .map((event) => event.payload)
    .find((p) => p.kind === "sessions_interrupted");
}

describe("agent command service", () => {
  it("creates a ticket through display-id-only input and output", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-internal-uuid",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-internal-uuid",
    });
    const request: AgentRequest = {
      v: 1,
      cmd: "ticket.create",
      args: {
        project: "/repo/volli",
        title: "Ship CLI",
        status: "backlog",
        labels: [],
        harness: "codex",
      },
      ctx: { cwd: "/outside", env: {} },
    };

    const response = await service.execute(request);

    expect(response).toEqual({
      v: 1,
      ok: true,
      data: {
        ticket: {
          id: "VC-1",
          project: "Volli Code",
          title: "Ship CLI",
          body: "",
          status: "backlog",
          priority: "medium",
          labels: [],
          usesWorktree: true,
          harness: "codex",
          worktreePath: null,
          branch: null,
          baseBranch: null,
          badge: null,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("internal-uuid");
  });

  it("rejects an invalid --base and never inherits the project base branch on create", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        path: "/repo/volli",
        ticketPrefix: "VC",
        baseBranch: "develop",
      }),
    );
    let id = 0;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => `ticket-${++id}`,
    });
    const execute = (args: Record<string, unknown>) =>
      service.execute({
        v: 1,
        cmd: "ticket.create",
        args,
        ctx: { cwd: "/repo/volli", env: {} },
      });

    // A malformed branch name is an INVALID_REQUEST, not a generic MUTATION_FAILED.
    const invalid = await execute({ title: "Bad base", base: "no spaces allowed" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

    // No --base: baseBranch stays null (inherit the project setting at use time),
    // never stamped from the project's "develop".
    const inherited = await execute({ title: "Inherits later" });
    expect(inherited).toMatchObject({ ok: true, data: { ticket: { baseBranch: null } } });

    // An explicit valid --base is the per-ticket override.
    const explicit = await execute({ title: "Explicit base", base: "release/next" });
    expect(explicit).toMatchObject({ ok: true, data: { ticket: { baseBranch: "release/next" } } });
  });

  it("moves, comments on, and reads a created ticket through the board", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: { cwd: "/repo/volli", env: {} },
      });

    expect((await execute("ticket.create", { title: "Ship CLI" })).ok).toBe(true);
    const moved = await execute("ticket.move", { id: "VC-1", to: "doing" });
    const commented = await execute("ticket.comment", { id: "VC-1", message: "In progress" });
    const board = await execute("board", {});

    expect(moved).toMatchObject({
      ok: true,
      data: { ticket: { id: "VC-1", status: "doing" } },
    });
    expect(commented).toMatchObject({
      ok: true,
      data: { comment: { ticket: "VC-1", body: "In progress", actor: "user" } },
    });
    expect(board).toMatchObject({
      ok: true,
      data: {
        project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
        columns: {
          backlog: [],
          doing: [{ id: "VC-1", title: "Ship CLI", status: "doing" }],
          needs_review: [],
        },
      },
    });
    expect(JSON.stringify({ moved, commented, board })).not.toContain("ticket-one");
  });

  it("attributes socket mutations to the originating session through the public event feed", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
    });
    const request = (cmd: AgentRequest["cmd"], args: Record<string, unknown>, session?: string) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: {
          cwd: "/repo/volli",
          env: session ? { session, ticket: "VC-1" } : {},
        },
      });

    await request("ticket.create", { title: "Ship CLI" });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );
    await request("ticket.move", { id: "VC-1", to: "doing" }, sessionId);
    await request("ticket.comment", { id: "VC-1", message: "Working" }, sessionId);

    const events = await request("ticket.events", { id: "VC-1", limit: 10 });
    const board = await request("board", {}, sessionId);
    expect(events).toMatchObject({
      ok: true,
      data: {
        events: [
          { actor: "user", actorContext: null, payload: { kind: "created" } },
          {
            actor: "session",
            actorContext: { session: "abcdef12", ticket: "VC-1" },
            payload: { kind: "status_changed", to: "doing" },
          },
          {
            actor: "session",
            actorContext: { session: "abcdef12", ticket: "VC-1" },
            payload: { kind: "commented" },
          },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain(sessionId);
    expect(JSON.stringify(events)).not.toContain("ticket-one");
    expect(board).toMatchObject({
      ok: true,
      data: { project: { prefix: "VC" }, columns: { doing: [{ id: "VC-1" }] } },
    });
  });

  it("treats a same-column move as an idempotent no-op, preserving order", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let id = 0;
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => `ticket-${++id}`,
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", { title: "First", status: "todo" });
    await execute("ticket.create", { title: "Second", status: "todo" });

    // Re-moving VC-1 into the column it already occupies must NOT push it below VC-2.
    const removed = await execute("ticket.move", { id: "VC-1", to: "todo" });
    const board = await execute("board", {});
    const events = await execute("ticket.events", { id: "VC-1", limit: 10 });

    expect(removed).toMatchObject({ ok: true, data: { ticket: { id: "VC-1", status: "todo" } } });
    expect(board).toMatchObject({
      ok: true,
      data: { columns: { todo: [{ id: "VC-1" }, { id: "VC-2" }] } },
    });
    // No status_changed event was written for the no-op move.
    if (events.ok) {
      const data = events.data as { events: { payload: { kind: string } }[] };
      expect(data.events.some((event) => event.payload.kind === "status_changed")).toBe(false);
    }
  });

  it("fires a native notification when a session moves a ticket into Doing", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let id = 0;
    let timestamp = 100;
    const notifications: Array<{ title: string; message: string }> = [];
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => `ticket-${++id}`,
      notify: (title, message) => notifications.push({ title, message }),
    });
    const exec = (cmd: AgentRequest["cmd"], args: Record<string, unknown>, session?: string) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: { cwd: "/repo/volli", env: session ? { session, ticket: "VC-2" } : {} },
      });
    // VC-1 is the ticket being moved; VC-2 is the driving session's own ticket.
    await exec("ticket.create", { title: "Worked ticket", status: "todo" });
    await exec("ticket.create", { title: "Orchestrator ticket", status: "doing" });
    const orchestrator = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-2", { id: orchestrator, cwd: "/repo/volli" }),
    );

    // A user-attributed CLI move (no session env) is silent.
    await exec("ticket.move", { id: "VC-1", to: "backlog" });
    expect(notifications).toEqual([]);

    // The same move from a session fires "via VC-2's session".
    await exec("ticket.move", { id: "VC-1", to: "doing" }, orchestrator);

    expect(notifications).toEqual([{ title: "VC-1 → Doing", message: "Moved via VC-2's session" }]);
  });

  describe("ticket.move backward-move interrupt (issue #78)", () => {
    /** Builds a service whose interrupt seam records its calls and returns `ids`. */
    function serviceWithInterrupt(ids: string[]) {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
      );
      let id = 0;
      let timestamp = 100;
      const interruptedTickets: string[] = [];
      const service = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.2.3",
        now: () => timestamp++,
        newId: () => `ticket-${++id}`,
        interruptTicketSessions: (ticketId) => {
          interruptedTickets.push(ticketId);
          return ids;
        },
      });
      const exec = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
        service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
      return { exec, interruptedTickets };
    }

    it("interrupts and records sessions_interrupted on a doing→todo move", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1", "s2"]);
      await exec("ticket.create", { title: "T", status: "doing" });

      const moved = await exec("ticket.move", { id: "VC-1", to: "todo" });

      expect((moved as { ok: boolean }).ok).toBe(true);
      expect(interruptedTickets).toEqual(["ticket-1"]);
      expect(await interruptedEventPayload(exec)).toEqual({
        kind: "sessions_interrupted",
        sessionIds: ["s1", "s2"],
      });
    });

    it("interrupts on a needs_review→done move", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "needs_review" });

      await exec("ticket.move", { id: "VC-1", to: "done" });

      expect(interruptedTickets).toEqual(["ticket-1"]);
      expect(await interruptedEventPayload(exec)).toBeDefined();
    });

    it("does not interrupt a doing→needs_review move (still active)", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "doing" });

      await exec("ticket.move", { id: "VC-1", to: "needs_review" });

      expect(interruptedTickets).toEqual([]);
      expect(await interruptedEventPayload(exec)).toBeUndefined();
    });

    it("does not interrupt a todo→backlog move (never active)", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "todo" });

      await exec("ticket.move", { id: "VC-1", to: "backlog" });

      expect(interruptedTickets).toEqual([]);
      expect(await interruptedEventPayload(exec)).toBeUndefined();
    });

    it("records nothing when the interrupt finds no live agent sessions", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt([]);
      await exec("ticket.create", { title: "T", status: "doing" });

      await exec("ticket.move", { id: "VC-1", to: "todo" });

      expect(interruptedTickets).toEqual(["ticket-1"]);
      expect(await interruptedEventPayload(exec)).toBeUndefined();
    });
  });

  it("identifies the project, ticket, and short session from the injected environment", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", {
        id: sessionId,
        cwd: "/tmp/worktrees/VC-1",
      }),
    );

    const response = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: {
        cwd: "/tmp/worktrees/VC-1",
        env: { session: sessionId, ticket: "VC-1", socket: "/tmp/volli.sock" },
      },
    });

    expect(response).toEqual({
      v: 1,
      ok: true,
      data: {
        project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
        ticket: "VC-1",
        session: "abcdef12",
        worktreePath: "/tmp/worktrees/VC-1",
        socket: "/tmp/volli.sock",
        appVersion: "1.2.3",
      },
    });
    expect(JSON.stringify(response)).not.toContain("project-one");
    expect(JSON.stringify(response)).not.toContain(sessionId);

    expect(
      await service.execute({
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli/packages/shared", env: { socket: "/tmp/volli.sock" } },
      }),
    ).toEqual({
      v: 1,
      ok: true,
      data: {
        project: { name: "Volli Code", prefix: "VC", path: "/repo/volli" },
        ticket: null,
        session: null,
        worktreePath: "/repo/volli/packages/shared",
        socket: "/tmp/volli.sock",
        appVersion: "1.2.3",
      },
    });
  });

  it("lists filtered tickets and shows recent public history without internal ids", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    let id = 0;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100 + id,
      newId: () => `ticket-internal-${++id}`,
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });

    await execute("ticket.create", {
      title: "Ship CLI",
      status: "doing",
      priority: "high",
      labels: ["feature"],
    });
    await execute("ticket.create", { title: "Later", status: "backlog", labels: [] });
    await execute("ticket.comment", { id: "VC-1", message: "Public progress" });

    const list = await execute("ticket.list", {
      status: "doing",
      priority: "high",
      label: "feature",
      limit: 1,
    });
    const show = await execute("ticket.show", { id: "VC-1", events: 2, comments: 1 });

    expect(list).toMatchObject({
      ok: true,
      data: { tickets: [{ id: "VC-1", title: "Ship CLI", labels: ["feature"] }] },
    });
    expect(show).toMatchObject({
      ok: true,
      data: {
        ticket: { id: "VC-1", title: "Ship CLI" },
        events: [{ payload: { kind: "labels_changed" } }, { payload: { kind: "commented" } }],
        comments: [{ ticket: "VC-1", body: "Public progress", actor: "user", session: null }],
      },
    });
    expect(JSON.stringify({ list, show })).not.toMatch(
      /ticket-internal|[0-9a-f]{8}-[0-9a-f-]{27}/i,
    );
  });

  it("clamps non-positive ticket.show limits to their defaults instead of slicing the whole history", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", { title: "Ship CLI" });
    for (const priority of ["high", "low", "medium", "high", "low", "medium"] as const) {
      await execute("ticket.update", {
        id: "VC-1",
        priority,
        addLabels: [],
        removeLabels: [],
      });
    }

    // `--events 0` must fall back to the default of 5 (not `slice(-0)` = all).
    const shown = await execute("ticket.show", { id: "VC-1", events: 0, comments: -3 });

    expect(shown.ok).toBe(true);
    if (shown.ok) {
      const data = shown.data as { events: unknown[] };
      expect(data.events).toHaveLength(5);
    }
  });

  it("updates body fields and labels atomically with exact-match edit guards", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", {
      title: "Draft CLI",
      body: "Old section\n\nKeep this",
      labels: ["draft", "feature"],
    });

    const updated = await execute("ticket.update", {
      id: "VC-1",
      title: "Ship CLI",
      priority: "high",
      base: "release/next",
      harness: "opencode",
      bodyMutation: { mode: "edit", oldText: "Old section", newText: "New section" },
      addLabels: ["ready"],
      removeLabels: ["draft"],
    });
    const staleEdit = await execute("ticket.update", {
      id: "VC-1",
      title: "Must not persist",
      bodyMutation: { mode: "edit", oldText: "Old section", newText: "Clobber" },
      addLabels: [],
      removeLabels: [],
    });
    const shown = await execute("ticket.show", { id: "VC-1", events: 20, comments: 1 });

    expect(updated).toMatchObject({
      ok: true,
      data: {
        ticket: {
          id: "VC-1",
          title: "Ship CLI",
          body: "New section\n\nKeep this",
          priority: "high",
          labels: ["feature", "ready"],
          harness: "opencode",
          baseBranch: "release/next",
        },
      },
    });
    expect(staleEdit).toEqual({
      v: 1,
      ok: false,
      error: {
        code: "BODY_MATCH_FAILED",
        message: 'Body edit expected exactly one match for "Old section".',
      },
    });
    expect(shown).toMatchObject({ data: { ticket: { title: "Ship CLI" } } });
  });

  it("rejects an invalid base branch on update without persisting any partial fields", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", { title: "Original" });

    const rejected = await execute("ticket.update", {
      id: "VC-1",
      title: "Must not persist",
      base: "--upload-pack=malicious command",
      addLabels: [],
      removeLabels: [],
    });
    const shown = await execute("ticket.show", { id: "VC-1" });

    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(shown).toMatchObject({
      ok: true,
      data: { ticket: { title: "Original", baseBranch: null } },
    });
  });

  it("archives a ticket reversibly without exposing a delete command", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", { title: "Ship CLI" });

    const archived = await execute("ticket.archive", { id: "VC-1" });
    const board = await execute("board", {});

    expect(archived).toEqual({
      v: 1,
      ok: true,
      data: { ticket: { id: "VC-1", archived: true, archivedAt: 100 } },
    });
    expect(board).toMatchObject({ data: { columns: { backlog: [] } } });
    expect(await execute("ticket.archive", { id: "VC-1" })).toMatchObject({
      ok: false,
      error: { code: "ARCHIVED_TICKET" },
    });
  });

  it("composes a ticket brief that guarantees the bundled Volli skill is loaded", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI", body: "Follow the implementation contract." },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Coordinate the board through the bundled `volli` CLI: run `volli help` for the full reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI\n\nFollow the implementation contract.",
      },
    });
  });

  it("prepends the worktree orientation preamble to a brief once the ticket has an active worktree", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI", body: "Follow the implementation contract." },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    updateTicketFieldsCommand(
      ctx.db,
      {
        ticketId: "ticket-one",
        worktreePath: "/Users/x/.volli/worktrees/project-one/VC-1",
        branch: "volli/VC-1-ship-cli",
        baseBranch: "main",
      },
      { now: 100, actor: { kind: "user" } },
    );

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "You are working in an isolated git worktree at `/Users/x/.volli/worktrees/project-one/VC-1` " +
          "on branch `volli/VC-1-ship-cli` (branched from `main`). All work happens in the current " +
          "directory. The main checkout at `/repo/volli` is reference-only — never modify it.\n\n" +
          "Coordinate the board through the bundled `volli` CLI: run `volli help` for the full reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI\n\nFollow the implementation contract.",
      },
    });
  });

  it("appends an Attachments section to the brief when the ticket has attachments", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI", body: "Follow the implementation contract." },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    createAttachment(
      ctx.db,
      { ticketId: "ticket-one", kind: "file", fileName: "spec.png", label: "homepage mock" },
      100,
    );
    createAttachment(
      ctx.db,
      {
        ticketId: "ticket-one",
        kind: "url",
        url: "https://example.com/design",
        label: "design doc",
      },
      200,
    );

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Coordinate the board through the bundled `volli` CLI: run `volli help` for the full reference (and the volli skill, when installed, for norms).\n\n" +
          "VC-1: Ship CLI\n\nFollow the implementation contract.\n\n" +
          "## Attachments\n\n" +
          "Read each attached file before starting — they are part of the ticket's spec:\n" +
          "- `.volli/attachments/spec.png` — homepage mock\n" +
          "Reference URLs:\n" +
          "- https://example.com/design — design doc",
      },
    });
  });

  it("omits the Attachments section from the brief when the ticket has no attachments", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Coordinate the board through the bundled `volli` CLI: run `volli help` for the full reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI",
      },
    });
  });

  it("resolves an explicit identify --project through the context ladder", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "p1", name: "Alpha", path: "/repo/alpha", ticketPrefix: "AL" }),
    );
    insertProject(
      ctx.db,
      testProject({ id: "p2", name: "Beta", path: "/repo/beta", ticketPrefix: "BE" }),
    );
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.0.0" });

    // An explicit --project wins even when cwd sits outside every project.
    const response = await service.execute({
      v: 1,
      cmd: "identify",
      args: { project: "BE" },
      ctx: { cwd: "/somewhere/else", env: {} },
    });

    expect(response).toMatchObject({
      v: 1,
      ok: true,
      data: { project: { name: "Beta", prefix: "BE", path: "/repo/beta" } },
    });

    // An unknown --project is a resolution error, not a silent fallback.
    const missing = await service.execute({
      v: 1,
      cmd: "identify",
      args: { project: "NOPE" },
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(missing).toMatchObject({ v: 1, ok: false, error: { code: "PROJECT_NOT_FOUND" } });
  });

  it("enumerates the priority vocabulary on raw create/update/list rejections", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "p1", name: "Alpha", path: "/repo/alpha", ticketPrefix: "AL" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      newId: () => "t1",
    });
    const base = { cwd: "/repo/alpha", env: {} } as const;

    const create = await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { project: "AL", title: "X", priority: "urgent" },
      ctx: base,
    });
    expect(create).toEqual({
      v: 1,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'Invalid priority "urgent" (valid: low, medium, high)',
      },
    });

    const list = await service.execute({
      v: 1,
      cmd: "ticket.list",
      args: { project: "AL", priority: "urgent" },
      ctx: base,
    });
    expect(list).toMatchObject({
      v: 1,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'Invalid priority "urgent" (valid: low, medium, high)',
      },
    });

    // Seed a real ticket, then reject an invalid priority on update.
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { project: "AL", title: "Seed" },
      ctx: base,
    });
    const update = await service.execute({
      v: 1,
      cmd: "ticket.update",
      args: { id: "AL-1", priority: "urgent" },
      ctx: base,
    });
    expect(update).toMatchObject({
      v: 1,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'Invalid priority "urgent" (valid: low, medium, high)',
      },
    });
  });

  // The harness vocabulary is the one that grows: the parser can only vet a
  // slug's shape, so every question about whether a name means anything — and
  // whether a human ruled on it — is settled here, against the registry.
  describe("the harness a create/update may name", () => {
    function harnessService(): {
      create: (harness: unknown) => Promise<AgentResponse>;
      update: (harness: unknown) => Promise<AgentResponse>;
    } {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "p1", name: "Alpha", path: "/repo/alpha", ticketPrefix: "AL" }),
      );
      let seq = 0;
      const service = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.0.0",
        newId: () => `t${(seq += 1)}`,
      });
      const base = { cwd: "/repo/alpha", env: {} } as const;
      return {
        create: (harness) =>
          service.execute({
            v: 1,
            cmd: "ticket.create",
            args: { project: "AL", title: "X", harness },
            ctx: base,
          }),
        update: async (harness) => {
          await service.execute({
            v: 1,
            cmd: "ticket.create",
            args: { project: "AL", title: "Seed" },
            ctx: base,
          });
          return await service.execute({
            v: 1,
            cmd: "ticket.update",
            args: { id: "AL-1", harness },
            ctx: base,
          });
        },
      };
    }

    function register(slug: string, decision: "trusted" | "blocked"): void {
      recordHarnessTrust(
        ctx.db,
        {
          slug,
          manifestPath: `/home/dev/.agents/harnesses/${slug}/harness.json`,
          manifestSha256: "a1",
          decision,
          declaredEvents: [],
        },
        1000,
      );
    }

    it("refuses a name no slug could ever be, and enumerates what one could", async () => {
      const { create, update } = harnessService();
      const message =
        'Invalid harness "Not A Slug" (valid: claude-code, codex, cursor, opencode, or a registered, trusted harness)';
      expect(await create("Not A Slug")).toMatchObject({ error: { message } });
      expect(await update("Not A Slug")).toMatchObject({ error: { message } });
    });

    // Well-formed and meaningless are different failures with different fixes —
    // this one is "register it", not "spell it differently".
    it("refuses a well-formed slug nothing is registered under", async () => {
      const { create } = harnessService();
      expect(await create("aider")).toEqual({
        v: 1,
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message:
            'Unknown harness "aider" — no harness by that name is registered (built in: claude-code, codex, cursor, opencode)',
        },
      });
    });

    // Registration is not permission. A blocked manifest is one somebody looked
    // at and said no to; pinning a ticket to it would queue a launch that can
    // never run, and would say nothing about why.
    it("refuses a registered harness a human has not trusted", async () => {
      const { create, update } = harnessService();
      register("aider", "blocked");
      const message = 'Harness "aider" is registered but not trusted, so nothing can launch on it.';
      expect(await create("aider")).toMatchObject({ error: { message } });
      expect(await update("aider")).toMatchObject({ error: { message } });
    });

    it("stamps a registered, trusted harness on the ticket", async () => {
      const { create } = harnessService();
      register("aider", "trusted");

      expect(await create("aider")).toMatchObject({
        ok: true,
        data: { ticket: { harness: "aider" } },
      });
    });

    it("stamps one on an update too", async () => {
      const { update } = harnessService();
      register("aider", "trusted");

      expect(await update("aider")).toMatchObject({
        ok: true,
        data: { ticket: { harness: "aider" } },
      });
    });

    it("still takes the first-class ids without consulting the registry", async () => {
      const { create } = harnessService();
      expect(await create("codex")).toMatchObject({
        ok: true,
        data: { ticket: { harness: "codex" } },
      });
    });
  });

  it("lists public project, label, and session catalogs", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
      newId: () => "ticket-one",
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
    await execute("ticket.create", { title: "Ship CLI", labels: ["feature"] });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", {
        id: sessionId,
        title: "Codex session",
        createdAt: 900,
      }),
    );

    const projects = await execute("project.list", {});
    const labels = await execute("label.list", {});
    const sessions = await execute("session.list", { ticket: "VC-1" });

    expect(projects).toEqual({
      v: 1,
      ok: true,
      data: {
        projects: [
          { name: "Volli Code", prefix: "VC", path: "/repo/volli", tickets: 1, archived: 0 },
        ],
      },
    });
    expect(labels).toMatchObject({
      ok: true,
      data: { labels: [{ name: "feature", color: null, tickets: 1 }] },
    });
    expect(sessions).toEqual({
      v: 1,
      ok: true,
      data: {
        sessions: [
          {
            id: "abcdef12",
            kind: "ticket",
            status: "running",
            ticket: "VC-1",
            title: "Codex session",
            harness: "claude-code",
            ageMs: 100,
          },
        ],
      },
    });
    expect(JSON.stringify({ projects, labels, sessions })).not.toMatch(
      /project-one|ticket-one|abcdef12-3456/,
    );
  });

  // An agent reading this list is deciding where to look. The launch harness of
  // a terminal somebody has since re-used is the wrong answer.
  it("names the harness a session is RUNNING in session.list", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", null, { id: sessionId, harnessId: "opencode", createdAt: 900 }),
    );
    setActiveHarnessId(ctx.db, sessionId, "claude-code");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
    });

    const sessions = await service.execute({
      v: 1,
      cmd: "session.list",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(sessions).toMatchObject({ ok: true, data: { sessions: [{ harness: "claude-code" }] } });
  });

  it("refuses session.list when an explicit --project contradicts the --ticket", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-a", name: "Alpha", path: "/repo/alpha", ticketPrefix: "AL" }),
    );
    insertProject(
      ctx.db,
      testProject({ id: "project-b", name: "Beta", path: "/repo/beta", ticketPrefix: "BT" }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      newId: () => "ticket-a",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "In Alpha", project: "/repo/alpha" },
      ctx: { cwd: "/outside", env: {} },
    });

    const mismatch = await service.execute({
      v: 1,
      cmd: "session.list",
      args: { ticket: "AL-1", project: "/repo/beta" },
      ctx: { cwd: "/outside", env: {} },
    });

    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_MISMATCH" },
    });
    if (!mismatch.ok) {
      expect(mismatch.error.message).toContain("Alpha");
      expect(mismatch.error.message).toContain("Beta");
    }
  });

  it("observes sessions by short id and delegates native notifications", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", null, { id: sessionId, title: "Scratch" }));
    const observed: Array<{ sessionId: string; lines: number }> = [];
    const notifications: Array<{ title: string; message: string }> = [];
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      observeSession: (id, lines) => {
        observed.push({ sessionId: id, lines });
        return { status: "idle", output: "line one\nline two" };
      },
      notify: (title, message) => notifications.push({ title, message }),
    });

    const peek = await service.execute({
      v: 1,
      cmd: "session.peek",
      args: { id: "abcdef12", lines: 2 },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    const notified = await service.execute({
      v: 1,
      cmd: "notify",
      args: { title: "Agent", message: "Needs input" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    const byUuid = await service.execute({
      v: 1,
      cmd: "session.peek",
      args: { id: sessionId, lines: 2 },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(peek).toEqual({
      v: 1,
      ok: true,
      data: { session: "abcdef12", status: "idle", output: "line one\nline two" },
    });
    // Full UUIDs are not public session handles — only the short id resolves.
    expect(byUuid).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    expect(observed).toEqual([{ sessionId, lines: 2 }]);
    expect(notified).toEqual({ v: 1, ok: true, data: { notified: true } });
    expect(notifications).toEqual([{ title: "Agent", message: "Needs input" }]);
  });

  it("records lifecycle signals on the session's ticket as an automation actor", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );

    const blocked = await service.execute({
      v: 1,
      cmd: "session.blocked",
      args: { reason: "Waiting for credentials" },
      ctx: { cwd: "/repo/volli", env: { session: sessionId, ticket: "VC-1" } },
    });
    const events = await service.execute({
      v: 1,
      cmd: "ticket.events",
      args: { id: "VC-1", limit: 10 },
      ctx: { cwd: "/repo/volli", env: { session: sessionId, ticket: "VC-1" } },
    });

    expect(blocked).toEqual({
      v: 1,
      ok: true,
      data: {
        session: "abcdef12",
        signal: "blocked",
        reason: "Waiting for credentials",
        recorded: true,
      },
    });
    expect(events).toMatchObject({
      ok: true,
      data: {
        events: [
          { payload: { kind: "created" } },
          {
            actor: "automation",
            actorContext: { session: "abcdef12", ticket: "VC-1" },
            payload: {
              kind: "session_signal",
              signal: "blocked",
              reason: "Waiting for credentials",
            },
          },
        ],
      },
    });
    expect(JSON.stringify(events)).not.toContain(sessionId);
  });

  it("acknowledges a scratch-session signal without recording, and requires session context", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", null, { id: sessionId }));
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.2.3" });

    const done = await service.execute({
      v: 1,
      cmd: "session.done",
      args: {},
      ctx: { cwd: "/repo/volli", env: { session: sessionId } },
    });
    const missing = await service.execute({
      v: 1,
      cmd: "session.done",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(done).toEqual({
      v: 1,
      ok: true,
      data: { session: "abcdef12", signal: "done", reason: null, recorded: false },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  describe("session.link (issue #78)", () => {
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";

    function linkService() {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
      );
      insertSession(ctx.db, testSession("project-one", null, { id: sessionId }));
      const service = createAgentCommandService({ db: ctx.db, appVersion: "1.2.3" });
      const link = (id: unknown, session: string | null = sessionId) =>
        service.execute({
          v: 1,
          cmd: "session.link",
          args: { id },
          ctx: { cwd: "/repo/volli", env: session ? { session } : {} },
        });
      return { link };
    }

    it("persists the harness session id (trimmed) and lets a later link overwrite it", async () => {
      const { link } = linkService();

      const first = await link("  first-uuid  ");
      expect(first).toEqual({
        v: 1,
        ok: true,
        data: { session: "abcdef12", harnessSessionId: "first-uuid" },
      });
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBe("first-uuid");

      await link("second-uuid");
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBe("second-uuid");
    });

    it("requires VOLLI_SESSION context (same wording style as session.done)", async () => {
      const { link } = linkService();
      const noContext = await link("some-uuid", null);
      expect(noContext).toMatchObject({
        ok: false,
        error: {
          code: "CONTEXT_REQUIRED",
          message: "session link requires VOLLI_SESSION context.",
        },
      });
    });

    it("rejects an empty/whitespace id", async () => {
      const { link } = linkService();
      const empty = await link("   ");
      expect(empty).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBeNull();
    });
  });

  describe("session.harness (the wrapper announce)", () => {
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";

    function announceService(harnessId: HarnessId = "opencode") {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
      );
      insertSession(ctx.db, testSession("project-one", null, { id: sessionId, harnessId }));
      const notices: SessionHarnessNotice[] = [];
      const service = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.2.3",
        now: () => 4242,
        onSessionHarness: (notice) => notices.push(notice),
      });
      const announce = (id: unknown, session: string | null = sessionId) =>
        service.execute({
          v: 1,
          cmd: "session.harness",
          args: { id },
          ctx: { cwd: "/repo/volli", env: session ? { session } : {} },
        });
      const mint = (id: unknown, session: string | null = sessionId) =>
        service.execute({
          v: 1,
          cmd: "session.harness",
          args: { id, mint: true },
          ctx: { cwd: "/repo/volli", env: session ? { session } : {} },
        });
      return { announce, mint, notices };
    }

    // THE BUG. The terminal was opened by opencode; the user quit it and ran
    // claude. `harness_id` is the launch and must not move — everything about
    // what is RUNNING now reads the new column.
    it("records the running harness beside the launch one, and announces it", async () => {
      const { announce, notices } = announceService();

      const response = await announce("claude-code");

      expect(response).toEqual({
        v: 1,
        ok: true,
        data: {
          session: "abcdef12",
          harness: "claude-code",
          changed: true,
          harnessSessionId: null,
        },
      });
      const session = getSession(ctx.db, sessionId);
      expect(session?.harnessId).toBe("opencode");
      expect(session?.activeHarnessId).toBe("claude-code");
      expect(notices).toEqual([
        {
          sessionId,
          projectId: "project-one",
          ticketId: null,
          harnessId: "claude-code",
          changed: true,
          at: 4242,
        },
      ]);
    });

    // THE SECOND BUG, and the one the mint above exists to serve: quit claude,
    // run claude again in the same terminal. The slug did not change, but a
    // launch demonstrably happened, and the renderer's grace window is anchored
    // to hearing about it. Announcing nothing left the second launch wearing
    // the first one's already-delivered channel.
    it("announces every launch, including one that agrees with what is believed", async () => {
      const { announce, notices } = announceService("claude-code");

      const response = await announce("claude-code");

      expect(response).toMatchObject({ ok: true, data: { changed: false } });
      // The write is still gated: re-storing the value already there buys
      // nothing.
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBeNull();
      expect(notices).toEqual([
        {
          sessionId,
          projectId: "project-one",
          ticketId: null,
          harnessId: "claude-code",
          changed: false,
          at: 4242,
        },
      ]);

      await announce("claude-code");
      expect(notices).toHaveLength(2);
    });

    it("compares against what is RUNNING, not what launched", async () => {
      const { announce, notices } = announceService();
      setActiveHarnessId(ctx.db, sessionId, "claude-code");

      const again = await announce("claude-code");
      expect(again).toMatchObject({ ok: true, data: { changed: false } });
      expect(notices).toEqual([
        expect.objectContaining({ harnessId: "claude-code", changed: false }),
      ]);

      const back = await announce("opencode");
      expect(back).toMatchObject({ ok: true, data: { changed: true } });
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBe("opencode");
      expect(notices).toHaveLength(2);
    });

    it("requires VOLLI_SESSION context", async () => {
      const { announce } = announceService();
      expect(await announce("claude-code", null)).toMatchObject({
        ok: false,
        error: {
          code: "CONTEXT_REQUIRED",
          message: "session harness requires VOLLI_SESSION context.",
        },
      });
    });

    it("refuses a name outside the vocabulary Volli knows", async () => {
      const { announce } = announceService();
      expect(await announce("not-a-harness")).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(await announce(42)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBeNull();
    });

    // VOLLI_SESSION escapes its PTY — a tmux server, a disowned daemon — so an
    // announce can land long after the session ended. Accepting one would
    // rewrite the harness that dead session resumes with.
    it("refuses an announce for a session that has already ended", async () => {
      const { announce, mint, notices } = announceService();
      endSession(ctx.db, sessionId, 5000, 0);

      expect(await announce("claude-code")).toMatchObject({
        ok: false,
        error: { code: "SESSION_ENDED" },
      });
      // The mint is behind every guard the announce is: a tmux server that
      // outlived its session may not rewrite what that session resumes with.
      expect(await mint("claude-code")).toMatchObject({
        ok: false,
        error: { code: "SESSION_ENDED" },
      });
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBeNull();
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBeNull();
      expect(notices).toEqual([]);
    });

    // THE OTHER BUG. `VOLLI_SESSION` is stamped once per PTY, so a wrapper that
    // reused it handed the second launch in one terminal a byte-identical id —
    // which cursor, mkdir-ing a directory named after it, refuses with EEXIST.
    // Every launch asks, and every ask is answered with a new one.
    it("mints a fresh v4 id per launch, overwriting the previous launch's seed", async () => {
      const { mint } = announceService("cursor");
      const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      const first = await mint("cursor");
      const firstId = getSession(ctx.db, sessionId)?.harnessSessionId;
      const second = await mint("cursor");
      const secondId = getSession(ctx.db, sessionId)?.harnessSessionId;

      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      // Cursor validates exactly this shape and rejects a v7.
      expect(firstId).toMatch(v4);
      expect(secondId).toMatch(v4);
      expect(secondId).not.toBe(firstId);
      // What the wrapper reads back is what was recorded, or the harness would
      // launch under an id no future resume could find.
      expect(first).toMatchObject({ ok: true, data: { harnessSessionId: firstId } });
      expect(second).toMatchObject({ ok: true, data: { harnessSessionId: secondId } });
    });

    // The one honest launch count. A PTY spawn would also count a harness the
    // user started by absolute path, outside our wrapper and our config; this
    // call cannot happen unless the wrapper ran.
    it("stamps the launch the wrapper just proved, and nothing else", async () => {
      const { announce } = announceService();

      await announce("claude-code");

      expect(listHarnessChannels(ctx.db)).toEqual([
        { harnessId: "claude-code", lastLaunchAt: 4242, lastEventAt: null },
      ]);
    });

    // Unlike `active_harness_id`, which is gated on a change. A relaunch is a
    // new launch whose channel has proved nothing yet, and it is exactly the
    // case that makes a broken upgrade visible.
    it("stamps a relaunch of the harness already believed to be running", async () => {
      ctx = openTestDb();
      insertProject(ctx.db, testProject({ id: "project-one", path: "/repo/volli" }));
      insertSession(
        ctx.db,
        testSession("project-one", null, { id: sessionId, harnessId: "claude-code" }),
      );
      let clock = 1000;
      const service = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.2.3",
        now: () => clock,
      });
      const announce = () =>
        service.execute({
          v: 1,
          cmd: "session.harness",
          args: { id: "claude-code" },
          ctx: { cwd: "/repo/volli", env: { session: sessionId } },
        });

      await announce();
      clock = 9000;
      await announce();

      expect(listHarnessChannels(ctx.db)).toEqual([
        { harnessId: "claude-code", lastLaunchAt: 9000, lastEventAt: null },
      ]);
    });

    it("stamps nothing for an announce it refused", async () => {
      const { announce } = announceService();
      endSession(ctx.db, sessionId, 5000, 0);

      await announce("claude-code");
      await announce("not-a-harness");

      expect(listHarnessChannels(ctx.db)).toEqual([]);
    });

    // A `reported` or `none` harness names its own session, and its wrapper asks
    // for nothing. Minting for it would overwrite a real resume seed.
    it("mints nothing for a wrapper that did not ask", async () => {
      const { announce } = announceService();

      expect(await announce("opencode")).toMatchObject({
        ok: true,
        data: { harnessSessionId: null },
      });
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBeNull();
    });
  });

  describe("hook", () => {
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";

    function hookService(
      options: Partial<Parameters<typeof createAgentCommandService>[0]> = {},
      ticketId: string | null = null,
      harnessId: HarnessId = "claude-code",
    ) {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
      );
      if (ticketId !== null) {
        insertTicket(ctx.db, testTicket("project-one", { id: ticketId, ticketNumber: 12 }));
      }
      insertSession(ctx.db, testSession("project-one", ticketId, { id: sessionId, harnessId }));
      const service = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.2.3",
        now: () => 4242,
        ...options,
      });
      const hook = (args: Record<string, unknown>, session: string | null = sessionId) =>
        service.execute({
          v: 1,
          cmd: "hook",
          args,
          ctx: { cwd: "/repo/volli", env: session ? { session } : {} },
        });
      return { hook };
    }

    // VOLLI_SESSION outlives the PTY that exported it — a tmux server or
    // daemon started inside a session carries it forever — so an event can
    // arrive long after the session ended. Accepting one resurrects a dead
    // session: notification, sidebar row, rewritten resume seed.
    it("refuses an event for a session that has already ended", async () => {
      const notices: HarnessEventNotice[] = [];
      const notified: string[] = [];
      const { hook } = hookService({
        onHarnessEvent: (notice) => notices.push(notice),
        notify: (title: string) => notified.push(title),
      });
      endSession(ctx.db, sessionId, 5000, 0);

      const response = await hook({ harness: "claude-code", event: "input.needed" });

      expect(response).toMatchObject({ ok: false, error: { code: "SESSION_ENDED" } });
      expect(notices).toEqual([]);
      expect(notified).toEqual([]);
    });

    it("does not let a late event rewrite an ended session's resume seed", async () => {
      const { hook } = hookService();
      endSession(ctx.db, sessionId, 5000, 0);

      await hook({
        harness: "claude-code",
        event: "session.started",
        harnessSessionId: "from-a-leaked-environment",
      });

      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBeNull();
    });

    it("records the harness session id an event carries, so resume needs no separate link", async () => {
      const { hook } = hookService();

      const response = await hook({
        harness: "claude-code",
        event: "session.started",
        harnessSessionId: "  cc-session-uuid  ",
      });

      expect(response).toMatchObject({ ok: true });
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBe("cc-session-uuid");
    });

    it("pushes the canonical event to the renderer with the session it resolved", async () => {
      const notices: HarnessEventNotice[] = [];
      const { hook } = hookService({ onHarnessEvent: (notice) => notices.push(notice) });

      await hook({ harness: "claude-code", event: "input.needed" });

      expect(notices).toEqual([
        {
          sessionId,
          projectId: "project-one",
          ticketId: null,
          harnessId: "claude-code",
          event: "input.needed",
          harnessSessionId: null,
          at: 4242,
          firedAt: null,
        },
      ]);
    });

    // The channel's other integer, and it is written for a built-in exactly as
    // for a manifest — the four harnesses Volli ships are the ones that were
    // exempt from every durable record, and the ones caught reporting nothing.
    it("stamps a delivery against the harness that fired it", async () => {
      const { hook } = hookService();

      await hook({ harness: "claude-code", event: "session.started" });

      expect(listHarnessChannels(ctx.db)).toEqual([
        { harnessId: "claude-code", lastLaunchAt: null, lastEventAt: 4242 },
      ]);
    });

    // "Is anything coming down this pipe" is a different question from "should
    // this event be believed". An event that lost the ordering race still
    // proves the channel is alive.
    it("stamps a delivery the ordering rule refused to act on", async () => {
      const { hook } = hookService();

      await hook({ harness: "claude-code", event: "turn.started", firedAt: 200 });
      const late = await hook({ harness: "claude-code", event: "input.needed", firedAt: 100 });

      expect(late).toMatchObject({ ok: true, data: { superseded: true } });
      expect(listHarnessChannels(ctx.db)).toEqual([
        { harnessId: "claude-code", lastLaunchAt: null, lastEventAt: 4242 },
      ]);
    });

    it("stamps nothing for an event it refused", async () => {
      const { hook } = hookService();

      await hook({ harness: "claude-code", event: "SubagentStop" });
      await hook({ harness: "not-a-harness", event: "turn.started" });

      expect(listHarnessChannels(ctx.db)).toEqual([]);
    });

    it("refuses an event name outside the canonical union", async () => {
      const notices: HarnessEventNotice[] = [];
      const { hook } = hookService({ onHarnessEvent: (notice) => notices.push(notice) });

      const response = await hook({ harness: "claude-code", event: "SubagentStop" });

      expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      expect(notices).toEqual([]);
    });

    it("needs VOLLI_SESSION, and refuses a session that is not ours", async () => {
      const { hook } = hookService();

      await expect(
        hook({ harness: "claude-code", event: "turn.started" }, null),
      ).resolves.toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
      await expect(
        hook({ harness: "claude-code", event: "turn.started" }, "not-a-session"),
      ).resolves.toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    });

    it("notifies when a human is blocking the agent, naming the ticket", async () => {
      const notices: [string, string][] = [];
      const { hook } = hookService(
        { notify: (title, message) => notices.push([title, message]) },
        "ticket-blocked",
      );

      await hook({ harness: "claude-code", event: "input.needed" });

      expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
    });

    it("stays quiet for telemetry, and for the twin event riding the same native signal", async () => {
      const notices: [string, string][] = [];
      const { hook } = hookService(
        { notify: (title, message) => notices.push([title, message]) },
        "ticket-quiet",
      );

      // A subagent finishing is not the parent finishing. And a harness whose
      // one permission signal is bound to BOTH `input.needed` and
      // `permission.requested` (codex, opencode) fires two hooks per prompt —
      // notifying on both would double every notification it earns.
      for (const event of ["subagent.completed", "permission.requested", "tool.started"]) {
        await hook({ harness: "claude-code", event });
      }

      expect(notices).toEqual([]);
    });

    it("writes a delivery into the ledger of the registered harness that sent it", async () => {
      const registered = "my-harness" as HarnessId;
      const notices: [string, string][] = [];
      const { hook } = hookService(
        { notify: (title, message) => notices.push([title, message]) },
        "ticket-registered",
        registered,
      );
      recordHarnessTrust(
        ctx.db,
        {
          slug: registered,
          manifestPath: "/home/dev/.agents/harnesses/my-harness/harness.json",
          manifestSha256: "a1",
          decision: "trusted",
          // Claims nothing: the ledger is about deliveries, and this one has
          // promised none.
          declaredEvents: [],
        },
        1000,
      );

      await hook({ harness: registered, event: "input.needed" });

      expect(getRegisteredHarness(ctx.db, registered)?.verifiedEvents).toEqual(["input.needed"]);
      // The first one a harness ever sends is exactly the one a human is
      // waiting on — verifying it must not cost it its notification.
      expect(notices).toEqual([["VC-12 needs you", "my-harness is waiting on a human"]]);
    });

    // `recordHarnessDelivery` answers `verified` for every first-class harness
    // unconditionally — it is about delivery, not capability. Cursor's own
    // source maps both blocking signals to null, and the renderer refuses to
    // raise a `waiting` for it; main firing a native interrupt over a sidebar
    // reading plain Idle is the disagreement this channel exists to prevent.
    it("stays quiet for a harness whose adapter cannot report that a human is blocking it", async () => {
      const notices: [string, string][] = [];
      const pushed: HarnessEventNotice[] = [];
      const { hook } = hookService(
        {
          notify: (title, message) => notices.push([title, message]),
          onHarnessEvent: (notice) => pushed.push(notice),
        },
        "ticket-cursor",
        "cursor",
      );

      await hook({ harness: "cursor", event: "input.needed" });

      expect(notices).toEqual([]);
      // Still delivered, and still fanned out: the channel is demonstrably
      // alive, it just cannot vouch for this one claim.
      expect(pushed.map((notice) => notice.event)).toEqual(["input.needed"]);
    });

    // A user who types `codex` inside a claude-code session's terminal reaches
    // the codex wrapper, and codex's hooks then report from the same
    // VOLLI_SESSION. Read off the session row, every one of those events was
    // recorded and announced as Claude Code's.
    it("credits the harness that fired, not the one the session launched with", async () => {
      const registered = "my-harness" as HarnessId;
      const notices: [string, string][] = [];
      const pushed: HarnessEventNotice[] = [];
      const { hook } = hookService(
        {
          notify: (title, message) => notices.push([title, message]),
          onHarnessEvent: (notice) => pushed.push(notice),
        },
        "ticket-typed",
      );
      recordHarnessTrust(
        ctx.db,
        {
          slug: registered,
          manifestPath: "/home/dev/.agents/harnesses/my-harness/harness.json",
          manifestSha256: "a1",
          decision: "trusted",
          declaredEvents: ["input.needed"],
        },
        1000,
      );

      const response = await hook({ harness: registered, event: "input.needed" });

      expect(response).toMatchObject({ ok: true, data: { harness: registered } });
      expect(getRegisteredHarness(ctx.db, registered)?.verifiedEvents).toEqual(["input.needed"]);
      expect(pushed.map((notice) => notice.harnessId)).toEqual([registered]);
      // The disagreement rule: a notification is the one claim that interrupts
      // a human and names an agent, so it is made only where the session Volli
      // launched and the hook that fired agree. Anything in the session can
      // invoke `volli hook` under a name of its choosing.
      expect(notices).toEqual([]);
    });

    it("falls back to the session's harness when the hook named none", async () => {
      const pushed: HarnessEventNotice[] = [];
      const notices: [string, string][] = [];
      const { hook } = hookService(
        {
          notify: (title, message) => notices.push([title, message]),
          onHarnessEvent: (notice) => pushed.push(notice),
        },
        "ticket-nameless",
      );

      await hook({ event: "input.needed" });

      expect(pushed.map((notice) => notice.harnessId)).toEqual(["claude-code"]);
      expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
    });

    // THE SILENT NOTIFICATION. The session launched opencode, the user quit it
    // and started claude, and claude's `input.needed` was compared against the
    // LAUNCH harness — recorded in the ledger, announced to the renderer, and
    // never notified. That is the exact case the channel exists for.
    it("notifies for the harness that is running, not the one that launched", async () => {
      const notices: [string, string][] = [];
      const { hook } = hookService(
        { notify: (title, message) => notices.push([title, message]) },
        "ticket-replaced",
        "opencode",
      );

      // Before the announce, claude is a stranger to this session: cheap things
      // still follow the evidence, but a notification names an agent and cannot
      // be retracted, so it waits for the two accounts to agree.
      await hook({ harness: "claude-code", event: "input.needed" });
      expect(notices).toEqual([]);

      setActiveHarnessId(ctx.db, sessionId, "claude-code");
      await hook({ harness: "claude-code", event: "input.needed" });

      expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
    });

    it("falls back to the RUNNING harness when the hook named none", async () => {
      const pushed: HarnessEventNotice[] = [];
      const { hook } = hookService(
        { onHarnessEvent: (notice) => pushed.push(notice) },
        "ticket-nameless-2",
        "opencode",
      );
      setActiveHarnessId(ctx.db, sessionId, "claude-code");

      await hook({ event: "input.needed" });

      expect(pushed.map((notice) => notice.harnessId)).toEqual(["claude-code"]);
    });

    // The slug is baked into the hook argv by Volli's own launch machinery, so
    // a name from outside that vocabulary is not a harness reporting — and it
    // does not get to write to the capability ledger under a name it picked.
    it("refuses a harness argument naming nothing Volli knows", async () => {
      const pushed: HarnessEventNotice[] = [];
      const { hook } = hookService({ onHarnessEvent: (notice) => pushed.push(notice) });

      for (const harness of ["Not A Slug", "never-registered", 7]) {
        await expect(hook({ harness, event: "input.needed" })).resolves.toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(pushed).toEqual([]);
    });

    it("records an event from a harness it has no record of, and notifies nobody", async () => {
      const notices: [string, string][] = [];
      const pushed: HarnessEventNotice[] = [];
      const { hook } = hookService(
        {
          notify: (title, message) => notices.push([title, message]),
          onHarnessEvent: (notice) => pushed.push(notice),
        },
        "ticket-unknown",
        "ghost-harness" as HarnessId,
      );

      await hook({ harness: "ghost-harness", event: "input.needed" });

      expect(pushed.map((notice) => notice.event)).toEqual(["input.needed"]);
      expect(notices).toEqual([]);
    });

    // Each event reaches main on its own short-lived hook process over its own
    // connection, so two fired close together arrive in the order they won
    // their races in. Arrival order is main's clock's opinion, not the agent's.
    describe("ordering", () => {
      it("withholds the notification a stale input.needed would fire", async () => {
        const notices: [string, string][] = [];
        const { hook } = hookService(
          { notify: (title, message) => notices.push([title, message]) },
          "ticket-raced",
        );

        await hook({ harness: "claude-code", event: "turn.started", firedAt: 2000 });
        await hook({ harness: "claude-code", event: "input.needed", firedAt: 1000 });

        expect(notices).toEqual([]);
      });

      it("still notifies for a wait fired in the same millisecond as the newest event", async () => {
        const notices: [string, string][] = [];
        const { hook } = hookService(
          { notify: (title, message) => notices.push([title, message]) },
          "ticket-tied",
        );

        await hook({ harness: "claude-code", event: "turn.started", firedAt: 2000 });
        await hook({ harness: "claude-code", event: "input.needed", firedAt: 2000 });

        expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
      });

      // An older `volli` sends no stamp at all. Dropping its events for failing
      // to prove their own age would be a strictly worse bug than the one this
      // closes, and a much quieter one.
      it("keeps believing an unstamped delivery after a stamped one", async () => {
        const notices: [string, string][] = [];
        const { hook } = hookService(
          { notify: (title, message) => notices.push([title, message]) },
          "ticket-unstamped",
        );

        await hook({ harness: "claude-code", event: "turn.started", firedAt: 2000 });
        await hook({ harness: "claude-code", event: "input.needed" });

        expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
      });

      it("refuses a stale resume seed rather than overwriting the newest one", async () => {
        const { hook } = hookService();

        await hook({
          harness: "claude-code",
          event: "session.started",
          harnessSessionId: "current-run",
          firedAt: 2000,
        });
        await hook({
          harness: "claude-code",
          event: "session.started",
          harnessSessionId: "a-run-that-already-ended",
          firedAt: 1000,
        });

        expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBe("current-run");
      });

      // The renderer applies the same rule to the same key, so a superseded
      // event is still announced rather than filtered here: main's watermark is
      // in memory, evicted at a cap and empty after a relaunch, and the
      // renderer's correctness must not rest on it.
      it("announces a superseded event, carrying the stamp that makes it judgeable", async () => {
        const pushed: HarnessEventNotice[] = [];
        const { hook } = hookService({ onHarnessEvent: (notice) => pushed.push(notice) });

        await hook({ harness: "claude-code", event: "turn.started", firedAt: 2000 });
        const response = await hook({
          harness: "claude-code",
          event: "input.needed",
          firedAt: 1000,
        });

        expect(pushed.map((notice) => [notice.event, notice.firedAt])).toEqual([
          ["turn.started", 2000],
          ["input.needed", 1000],
        ]);
        expect(response).toMatchObject({ ok: true, data: { superseded: true } });
      });

      it("says so in the response, the one trace a rejected delivery leaves", async () => {
        const { hook } = hookService();

        await expect(
          hook({ harness: "claude-code", event: "turn.started", firedAt: 2000 }),
        ).resolves.toMatchObject({ ok: true, data: { superseded: false } });
        await expect(
          hook({ harness: "claude-code", event: "input.needed" }),
        ).resolves.toMatchObject({ ok: true, data: { superseded: false } });
      });

      it("ignores a stamp that cannot order anything, rather than refusing the event", async () => {
        const pushed: HarnessEventNotice[] = [];
        const { hook } = hookService({ onHarnessEvent: (notice) => pushed.push(notice) });

        for (const firedAt of ["2000", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
          await expect(
            hook({ harness: "claude-code", event: "turn.started", firedAt }),
          ).resolves.toMatchObject({ ok: true, data: { superseded: false } });
        }

        expect(pushed.map((notice) => notice.firedAt)).toEqual([null, null, null, null]);
      });

      // The watermark is per session: one session firing does not make another
      // session's older-but-perfectly-current event look stale.
      it("keeps one session's watermark out of another's", async () => {
        const notices: [string, string][] = [];
        const { hook } = hookService(
          { notify: (title, message) => notices.push([title, message]) },
          "ticket-two-sessions",
        );
        const other = "99999999-3456-7890-abcd-ef1234567890";
        insertSession(ctx.db, testSession("project-one", "ticket-two-sessions", { id: other }));

        await hook({ harness: "claude-code", event: "turn.started", firedAt: 5000 });
        await hook({ harness: "claude-code", event: "input.needed", firedAt: 1000 }, other);

        expect(notices).toEqual([["VC-12 needs you", "Claude Code is waiting on a human"]]);
      });
    });
  });

  // ---- worktree.status / worktree.diff (issue #80) ------------------------

  /** Seeds one VC-1 ticket (internal id `ticket-one`) with an active worktree. */
  const seedWorktreeTicket = async (
    service: ReturnType<typeof createAgentCommandService>,
    fields: Record<string, unknown> = {},
  ): Promise<void> => {
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    updateTicketFieldsCommand(
      ctx.db,
      {
        ticketId: "ticket-one",
        worktreePath: "/wt/VC-1",
        branch: "volli/VC-1-ship",
        baseBranch: "main",
        ...fields,
      },
      { now: 100, actor: { kind: "user" } },
    );
  };

  it("composes a worktree status report from the ticket owning the cwd", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit((args) => {
      if (args[0] === "status") return " M src/a.ts\n";
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no origin ref");
      if (args[0] === "rev-list" && args[1] === "--left-right") return "0\t3\n";
      if (args[0] === "rev-list") return "2\n";
      return "";
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      // The seeded worktreePath ("/wt/VC-1") is fictional; stub the disk-existence
      // seam (C3) so this scenario isn't about that check.
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);

    // No id, cwd inside the worktree → the report resolves via the cwd rung.
    // The exact object pins the stable, typed --json shape (behavior 2).
    const res = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/wt/VC-1", env: {} },
    });
    expect(res).toEqual({
      v: 1,
      ok: true,
      data: {
        ticket: "VC-1",
        project: "Volli Code",
        worktreePath: "/wt/VC-1",
        branch: "volli/VC-1-ship",
        baseBranch: "main",
        uncommitted: true,
        sequencerActive: false,
        aheadOfBase: 3,
        behindBase: 0,
        unpushed: 2,
      },
    });
    // A cwd nested BELOW the worktree resolves the same ticket.
    const nested = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/wt/VC-1/packages/shared", env: {} },
    });
    expect(nested).toMatchObject({ ok: true, data: { ticket: "VC-1" } });
  });

  it("matches the cwd rung across symlinks (physical cwd vs symlinked stamp)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
    });
    // A real on-disk worktree stamped through a SYMLINKED prefix, queried from
    // the PHYSICAL cwd the CLI's `process.cwd()` reports — the exact macOS
    // `/tmp` → `/private/tmp` split. Resolution must canonicalize both sides.
    const base = mkdtempSync(join(tmpdir(), "volli-cwd-"));
    try {
      const real = join(base, "real");
      mkdirSync(join(real, "VC-1"), { recursive: true });
      symlinkSync(real, join(base, "link"));
      const stamped = join(base, "link", "VC-1");
      await seedWorktreeTicket(service, { worktreePath: stamped });
      const physicalCwd = realpathSync(stamped);
      expect(physicalCwd).not.toBe(stamped); // the logical/physical divergence is real

      const res = await service.execute({
        v: 1,
        cmd: "worktree.status",
        args: {},
        ctx: { cwd: physicalCwd, env: {} },
      });
      expect(res).toMatchObject({ ok: true, data: { ticket: "VC-1" } });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("honors an explicit display-id override from outside any worktree", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);

    const res = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(res).toMatchObject({ ok: true, data: { ticket: "VC-1", worktreePath: "/wt/VC-1" } });
  });

  it("returns friendly errors for unknown ids, worktree-less tickets, and no context", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
    });
    // A ticket that never entered Doing has no worktree.
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Backlog item" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    const unknown = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-99" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });

    const noWorktree = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(noWorktree).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(noWorktree).toMatchObject({ ok: false });
    if (!noWorktree.ok) expect(noWorktree.error.message).toContain("no worktree");

    // Cwd sits in no worktree and no id was given → a teaching CONTEXT error.
    const noContext = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/elsewhere", env: {} },
    });
    expect(noContext).toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  it("summarizes the merge-base PR diff by default and the working tree on request", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no origin ref");
      if (args[0] === "diff" && args.includes("main...HEAD")) return "3\t1\tsrc/a.ts\n";
      if (args[0] === "diff" && args.includes("HEAD")) return "9\t0\tsrc/wip.ts\n";
      if (args[0] === "status") return "?? src/new.ts\n";
      return "";
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);

    // Default is the merge-base (PR) range.
    const pr = await service.execute({
      v: 1,
      cmd: "worktree.diff",
      args: {},
      ctx: { cwd: "/wt/VC-1", env: {} },
    });
    expect(pr).toEqual({
      v: 1,
      ok: true,
      data: {
        ticket: "VC-1",
        mode: "merge-base",
        baseBranch: "main",
        files: [{ path: "src/a.ts", insertions: 3, deletions: 1, untracked: false }],
        insertions: 3,
        deletions: 1,
        totalFiles: 1,
        omittedFiles: 0,
      },
    });

    // --working-tree switches to the uncommitted view (tracked + untracked).
    const wip = await service.execute({
      v: 1,
      cmd: "worktree.diff",
      args: { workingTree: true },
      ctx: { cwd: "/wt/VC-1", env: {} },
    });
    expect(wip).toMatchObject({
      ok: true,
      data: {
        mode: "working-tree",
        files: [
          { path: "src/wip.ts", insertions: 9, deletions: 0, untracked: false },
          { path: "src/new.ts", insertions: null, deletions: null, untracked: true },
        ],
      },
    });
  });

  it("caps diff file rows at 20 and reports the omitted remainder", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const numstat =
      Array.from({ length: 25 }, (_, i) => `1\t0\tsrc/file-${i}.ts`).join("\n") + "\n";
    const { git } = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no origin ref");
      if (args[0] === "diff") return numstat;
      return "";
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);

    const res = await service.execute({
      v: 1,
      cmd: "worktree.diff",
      args: {},
      ctx: { cwd: "/wt/VC-1", env: {} },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const data = res.data as { files: unknown[]; totalFiles: number; omittedFiles: number };
    expect(data.files.length).toBe(20);
    expect(data.totalFiles).toBe(25);
    expect(data.omittedFiles).toBe(5);
  });

  it("resolves an archived ticket by explicit id for worktree verbs, but other commands still refuse it (C2)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);
    await service.execute({
      v: 1,
      cmd: "ticket.archive",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    // Read-only worktree verbs serve an archived ticket by explicit id —
    // retention deliberately retains worktrees past archive (decision #76).
    const status = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(status).toMatchObject({ ok: true, data: { ticket: "VC-1", worktreePath: "/wt/VC-1" } });

    // Every other command still refuses the same archived ticket outright.
    const show = await service.execute({
      v: 1,
      cmd: "ticket.show",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(show).toMatchObject({ ok: false, error: { code: "ARCHIVED_TICKET" } });
  });

  it("refuses a stamped-but-deleted worktree directory with INVALID_REQUEST (C3)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    // No worktreeExists stub here — this exercises the REAL default (existsSync)
    // against a directory that genuinely never existed by the time it's checked.
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
    });
    const scratchBase = mkdtempSync(join(tmpdir(), "volli-missing-"));
    const missingPath = join(scratchBase, "worktree");
    rmSync(scratchBase, { recursive: true, force: true }); // stamped, then deleted
    await seedWorktreeTicket(service, { worktreePath: missingPath });

    const res = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(res).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (!res.ok) {
      expect(res.error.message).toContain("missing on disk");
      expect(res.error.message).toContain(missingPath);
    }
  });

  it("resolves the worktree target from VOLLI_TICKET context even when the cwd sits elsewhere (K2)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);

    // Cwd is the MAIN checkout, not the worktree — only the VOLLI_TICKET env
    // rung of the shared context ladder pins the ticket.
    const viaEnv = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/repo/volli", env: { ticket: "VC-1" } },
    });
    expect(viaEnv).toMatchObject({ ok: true, data: { ticket: "VC-1", worktreePath: "/wt/VC-1" } });

    // Sanity: the same cwd with no VOLLI_TICKET env can't resolve any ticket.
    const bare = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(bare).toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  it("exposes worktree identity through ticket.show fields and ticket.brief prose", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
    });
    await seedWorktreeTicket(service);

    const show = await service.execute({
      v: 1,
      cmd: "ticket.show",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(show).toMatchObject({
      ok: true,
      data: {
        ticket: { worktreePath: "/wt/VC-1", branch: "volli/VC-1-ship", baseBranch: "main" },
      },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    const prompt = (brief.data as { prompt: string }).prompt;
    expect(prompt).toContain("/wt/VC-1");
    expect(prompt).toContain("volli/VC-1-ship");
    expect(prompt).toContain("`main`");
  });
});

describe("doctor", () => {
  const observation = {
    pathEntries: ["/ud/bin", "/usr/bin"],
    zdotDir: "/ud/shell/zsh",
    resolved: { claude: "/ud/bin/claude" },
    volliPath: "/ud/bin/volli",
  };

  function doctorService(options: Partial<Parameters<typeof createAgentCommandService>[0]> = {}) {
    ctx = openTestDb();
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 4242,
      doctorFacts: async () => ({
        binDir: "/ud/bin",
        wrappers: { claude: "/ud/bin/claude" },
        refused: [],
        shellInitDir: "/ud/shell/zsh",
        shellInitPresent: true,
        shimPath: "/ud/bin/volli",
        liveSessionIds: [],
        reporting: [],
        skillConflicts: [],
      }),
      ...options,
    });
    return (args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd: "doctor", args, ctx: { cwd: "/repo", env: {} } });
  }

  it("returns a check per finding, with a summary", async () => {
    const response = await doctorService()(observation);

    expect(response).toMatchObject({ ok: true });
    if (!response.ok) throw new Error("expected ok");
    const data = response.data as { checks: { id: string }[]; summary: string };
    expect(data.checks.map((check) => check.id)).toContain("path-position");
    expect(data.summary).toContain("checks");
  });

  // A diagnostic that silently substitutes a default for a missing measurement
  // is exactly the failure mode it exists to catch.
  it("refuses a request carrying no observation rather than assuming one", async () => {
    const doctor = doctorService();
    for (const args of [
      {},
      { pathEntries: "not-a-list" },
      { pathEntries: [1] },
      { pathEntries: [], resolved: [] },
    ]) {
      expect(await doctor(args)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  /** The check with this id, or a helpful failure. */
  async function checkFrom(args: Record<string, unknown>, id: string) {
    const response = await doctorService()(args);
    if (!response.ok) throw new Error("expected ok");
    const { checks } = response.data as { checks: DoctorCheck[] };
    const found = checks.find((check) => check.id === id);
    if (found === undefined) throw new Error(`no ${id} check in ${checks.map((c) => c.id).join()}`);
    return found;
  }

  // Measured-absent and never-measured are different facts, and collapsing the
  // second into the first is how a diagnostic states a plausible wrong answer
  // in the voice of an observation.
  it("keeps a measured absence apart from a field that never arrived", async () => {
    // The caller looked and found nothing — a measurement, and a real failure.
    const absent = await checkFrom({ ...observation, zdotDir: null }, "shell-init");
    expect(absent.status).toBe("fail");
    expect(absent.detail).toContain("unset");

    // Nobody reported it. Nothing is known, and the report says so.
    const { zdotDir: _omitted, ...silent } = observation;
    const unreported = await checkFrom(silent, "shell-init");
    expect(unreported.status).toBe("warn");
    expect(unreported.detail).toContain("not reported");
  });

  // A malformed field is a caller that disagrees with main about the wire —
  // one of the conditions doctor exists to name. It costs that one field its
  // measurement and nothing else: the report is not discarded to punish it,
  // and the field never poses as measured-absent.
  it("reports a malformed field as unmeasured, not as measured-absent", async () => {
    const malformed = { ...observation, zdotDir: 123, volliPath: {} };

    const shellInit = await checkFrom(malformed, "shell-init");
    expect(shellInit.status).toBe("warn");
    expect(shellInit.detail).toContain("not reported");
    expect(shellInit.remedy).toBeUndefined();

    const volli = await checkFrom(malformed, "volli-cli");
    expect(volli.status).toBe("warn");
    expect(volli.detail).toContain("nothing is known");
    // The rest of the report still ran, which is the reason this does not
    // refuse the request outright.
    expect((await checkFrom(malformed, "path-position")).status).toBe("ok");
  });

  it("gives a malformed resolution the same treatment as an unreported one", async () => {
    const claimed = await checkFrom(
      { ...observation, resolved: { claude: 42 } },
      "resolves-claude",
    );
    expect(claimed.status).toBe("warn");
    expect(claimed.detail).toContain("no resolution was reported");

    const measured = await checkFrom(
      { ...observation, resolved: { claude: null } },
      "resolves-claude",
    );
    expect(measured.status).toBe("warn");
    expect(measured.detail).toContain("resolves to nothing");
  });

  it("reports that it could not look when the harness runtime is unavailable", async () => {
    ctx = openTestDb();
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.2.3" });
    const response = await service.execute({
      v: 1,
      cmd: "doctor",
      args: observation,
      ctx: { cwd: "/repo", env: {} },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
  });

  it("repairs before re-checking, so --fix reports the state it produced", async () => {
    const order: string[] = [];
    const doctor = doctorService({
      doctorRepair: async () => {
        order.push("repair");
      },
      doctorFacts: async () => {
        order.push("facts");
        return {
          binDir: "/ud/bin",
          wrappers: {},
          refused: [],
          shellInitDir: null,
          shellInitPresent: false,
          shimPath: "/ud/bin/volli",
          liveSessionIds: [],
          reporting: [],
          skillConflicts: [],
        };
      },
    });

    await doctor({ ...observation, fix: true });
    expect(order).toEqual(["repair", "facts"]);
  });

  it("does not repair unless asked", async () => {
    let repaired = false;
    await doctorService({
      doctorRepair: async () => {
        repaired = true;
      },
    })(observation);
    expect(repaired).toBe(false);
  });

  it("surfaces a repair failure instead of reporting checks over a broken state", async () => {
    const response = await doctorService({
      doctorRepair: () => Promise.reject(new Error("disk full")),
    })({ ...observation, fix: true });

    expect(response).toMatchObject({ ok: false, error: { code: "MUTATION_FAILED" } });
    if (response.ok) throw new Error("expected failure");
    expect(response.error.message).toContain("disk full");
  });
});
