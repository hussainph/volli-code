import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AgentRequest } from "@volli/shared";

import { insertProject } from "./db/projects-repo";
import { getSession, insertSession } from "./db/sessions-repo";
import { openTestDb, testProject, testSession } from "./db/test-helpers";
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

  it("enumerates the harness vocabulary on raw create/update rejections", async () => {
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
      args: { project: "AL", title: "X", harness: "cursor" },
      ctx: base,
    });
    expect(create).toEqual({
      v: 1,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'Invalid harness "cursor" (valid: claude-code, codex, opencode)',
      },
    });

    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { project: "AL", title: "Seed" },
      ctx: base,
    });
    const update = await service.execute({
      v: 1,
      cmd: "ticket.update",
      args: { id: "AL-1", harness: "cursor" },
      ctx: base,
    });
    expect(update).toMatchObject({
      v: 1,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: 'Invalid harness "cursor" (valid: claude-code, codex, opencode)',
      },
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
