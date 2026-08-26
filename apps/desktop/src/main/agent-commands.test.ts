import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ACTIVITY_METADATA_KEY, makeAgentError, MUTATION_PLAN_CONTRACT } from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  DoctorCheck,
  HarnessId,
  ModelAccessSnapshot,
  SessionUsage,
} from "@volli/shared";
import type { UIMessage } from "ai";
import type { HarnessEventNotice, SessionHarnessNotice } from "../ipc/contract";

import { importBlob } from "./blob-import";
import { blobsRoot } from "./blob-store";
import { listHarnessChannels } from "./db/harness-channel-repo";
import { listComments } from "./db/comments-repo";
import { getRegisteredHarness, recordHarnessTrust } from "./db/harness-registry-repo";
import { insertProject, listProjects, updateProjectAuthorityPolicy } from "./db/projects-repo";
import { listLatestSignals } from "./db/signals-repo";
import { subscribeTicketWake, type TicketWake } from "./ticket-wake";
import {
  endSession,
  getSession,
  insertSession,
  setActiveHarnessId,
} from "./session-control/test-support";
import {
  getTicket,
  insertTicket,
  listArchivedTicketsByProject,
  listTicketsByProject,
} from "./db/tickets-repo";
import { recordTicketEvent } from "./db/events-repo";
import { openTestDb, testProject, testSession, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import {
  CHAT_PEEK_ENTRIES,
  composeProjectBrief,
  createAgentCommandService as createAgentCommandServiceBase,
  type AgentCommandServiceOptions,
} from "./agent-commands";
import { createDesktopSessionEngine } from "./session-control";
import { writeModelAccessDefault } from "./session-runtime/model-access-preferences";
import { archiveTicketCommand, updateTicketFieldsCommand } from "./ticket-commands";
import { createSessionTokenRegistry } from "./session-tokens";
import { scriptedGit } from "./worktree/scripted-git";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine";
import type { SessionEngine } from "@volli/session-engine";

/** The transcript store the chat-peek tests read through, as main's file store would. */
const artifacts = createInMemoryTranscriptArtifactStore();

/** When the Nth transcript message of a peeked chat session happened. */
const messageAt = (index: number): number => 10_000 + index * 1_000;

/**
 * The door's token registry, shared by every service these tests build.
 *
 * The REAL registry, not a permissive double. A test that presents the wrong
 * token, or none, is refused here exactly as a stranger's process would be —
 * which is what keeps `ACTING_ENV` below an authentication rather than a
 * bypass. `resolution.test.ts` and `socket-honesty.test.ts` own the refusal
 * cases; this file is about what the verbs do once a caller is admitted.
 */
const DOOR_TOKENS = createSessionTokenRegistry();

/** The Session almost every test here acts as. Seeded at service construction. */
const ACTING_SESSION = "5eeded00-0000-4000-8000-0000000000aa";
const ACTING_TOKEN = DOOR_TOKENS.mint({
  sessionId: ACTING_SESSION,
  attachmentId: "acting-attachment",
});

/**
 * A caller the door authenticates as {@link ACTING_SESSION}.
 *
 * Since VC-163 a socket caller is a Session or it is nobody: `env: {}` now means
 * the unauthenticated actor, which may read and may not write. Most tests in
 * this file are about a verb's behaviour rather than about admission, so they
 * act as an ordinary authenticated Session, and passing this is how they say so.
 */
const ACTING_ENV: AgentRequest["ctx"]["env"] = {
  session: ACTING_SESSION,
  token: ACTING_TOKEN,
};

/**
 * An env the door will authenticate as `sessionId`.
 *
 * Memoised per Session, because minting twice for one attachment retires the
 * first token — that is the registry doing its job, and a test that called this
 * twice would otherwise disarm its own earlier requests.
 */
const mintedFor = new Map<string, string>();
function asSession(
  sessionId: string,
  extra: { ticket?: string; socket?: string } = {},
): AgentRequest["ctx"]["env"] {
  let token = mintedFor.get(sessionId);
  if (token === undefined) {
    token = DOOR_TOKENS.mint({ sessionId, attachmentId: `attachment-of-${sessionId}` });
    mintedFor.set(sessionId, token);
  }
  return { session: sessionId, token, ...extra };
}

/** Main composes the service with its one Session Engine; tests do the same. */
function createAgentCommandService(
  options: Omit<AgentCommandServiceOptions, "sessionEngine"> & { sessionEngine?: SessionEngine },
) {
  // The acting Session has to EXIST for the door to resolve it: a valid token
  // naming a Session the Engine cannot find is an error, not an actor. Seeded
  // against whichever project the test inserted before building the service.
  const project = listProjects(options.db)[0];
  if (project !== undefined && getSession(options.db, ACTING_SESSION) === undefined) {
    insertSession(
      options.db,
      testSession(project.id, null, { id: ACTING_SESSION, cwd: project.path }),
    );
  }
  return createAgentCommandServiceBase({
    ...options,
    sessionEngine: options.sessionEngine ?? createDesktopSessionEngine(options.db),
    verifySessionToken: options.verifySessionToken ?? DOOR_TOKENS.verify,
  });
}

let ctx: TestDb;

afterEach(() => ctx.cleanup());

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
      ctx: { cwd: "/outside", env: ACTING_ENV },
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

  it("previews every independent write with zero durable or external side effects, then real calls mutate once", async () => {
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
    insertTicket(
      ctx.db,
      testTicket("project-one", {
        id: "ticket-one",
        ticketNumber: 1,
        title: "Before",
        status: "todo",
      }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );

    let idSequence = 0;
    const newId = vi.fn(() => `durable-id-${++idSequence}`);
    const notify = vi.fn();
    const onMutation = vi.fn();
    const interruptTicketSessions = vi.fn(() => [] as string[]);
    const doctorRepair = vi.fn(async () => ({
      path: "/managed/bin:/usr/bin",
      provenance: "adopted" as const,
      added: ["/managed/bin"],
      interactiveProvenance: "already-complete" as const,
      interactiveAdded: [],
    }));
    const doctorFacts = vi.fn(async () => ({
      binDir: "/managed/bin",
      wrappers: {},
      refused: [],
      shellInitDir: null,
      shellInitPresent: false,
      shimPath: "/managed/bin/volli",
      liveSessionIds: [],
      reporting: [],
      skillConflicts: [],
    }));
    const engine = createDesktopSessionEngine(ctx.db);
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      sessionEngine: engine,
      now: () => 100,
      newId,
      notify,
      onMutation,
      interruptTicketSessions,
      doctorRepair,
      doctorFacts,
    });
    const execute = (cmd: AgentRequest["cmd"], args: Record<string, unknown>, inSession = false) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: {
          cwd: "/repo/volli",
          env: inSession ? asSession(sessionId, { ticket: "VC-1" }) : ACTING_ENV,
        },
      });

    const before = Buffer.from(ctx.db.serialize());
    const previews = await Promise.all([
      execute("ticket.create", { title: "Preview create", dryRun: true }),
      execute("ticket.update", { id: "VC-1", title: "After", dryRun: true }),
      execute("ticket.move", { id: "VC-1", to: "doing", dryRun: true }),
      execute("ticket.comment", { id: "VC-1", message: "Preview comment", dryRun: true }),
      execute("session.done", { reason: "Preview done", dryRun: true }, true),
      execute("session.blocked", { reason: "Preview blocked", dryRun: true }, true),
      execute("session.link", { id: "native-conversation", dryRun: true }, true),
      execute("notify", { title: "Preview", message: "Hello", dryRun: true }),
      execute("doctor", { fix: true, dryRun: true }),
    ]);

    for (const response of previews) {
      expect(response).toMatchObject({
        ok: true,
        data: { v: 1, kind: "mutation-plan", dryRun: true },
      });
    }
    expect(JSON.stringify(previews)).not.toContain("project-one");
    expect(JSON.stringify(previews)).not.toContain("ticket-one");
    expect(JSON.stringify(previews)).not.toContain(sessionId);
    expect(Buffer.from(ctx.db.serialize())).toEqual(before);
    expect(newId).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(onMutation).not.toHaveBeenCalled();
    expect(interruptTicketSessions).not.toHaveBeenCalled();
    expect(doctorRepair).not.toHaveBeenCalled();
    expect(doctorFacts).not.toHaveBeenCalled();

    // The same validated paths still perform their one intended mutation when
    // dryRun is absent. Existing behavior tests cover each output in detail;
    // this tracer proves preview did not fork a second execution meaning.
    await execute("ticket.create", { title: "Real create" });
    await execute("ticket.update", { id: "VC-1", title: "After" });
    await execute("ticket.move", { id: "VC-1", to: "doing" });
    await execute("ticket.comment", { id: "VC-1", message: "Real comment" });
    await execute("session.done", { reason: "Real done" }, true);
    await execute("session.blocked", { reason: "Real blocked" }, true);
    await execute("session.link", { id: "native-conversation" }, true);
    await execute("notify", { title: "Real", message: "Hello" });
    await execute("doctor", {
      fix: true,
      pathEntries: ["/managed/bin", "/usr/bin"],
      zdotDir: null,
      resolved: {},
      volliPath: "/managed/bin/volli",
    });

    expect(listTicketsByProject(ctx.db, "project-one")).toHaveLength(2);
    expect(getTicket(ctx.db, "ticket-one")).toMatchObject({ title: "After", status: "doing" });
    expect(listComments(ctx.db, "ticket-one")).toHaveLength(1);
    // Twice: the `notify` verb itself, plus the Doing-entry guardrail. Since
    // VC-163 every socket move is made by an authenticated Session rather than
    // by an unattributable "user", and a Session moving work into Doing is
    // exactly what that guardrail exists to make visible.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(doctorRepair).toHaveBeenCalledTimes(1);
    expect(doctorFacts).toHaveBeenCalledTimes(1);
    expect(interruptTicketSessions).not.toHaveBeenCalled();
    expect(newId).toHaveBeenCalledTimes(3);
    expect(onMutation).toHaveBeenCalledTimes(6);
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
        ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
        ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
      data: { comment: { ticket: "VC-1", body: "In progress", actor: "session" } },
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
          env: session ? asSession(session, { ticket: "VC-1" }) : ACTING_ENV,
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
          // Two DIFFERENT Sessions, which is the subject: the feed cites the
          // one that made each write. Since VC-163 neither can be "user" —
          // a socket caller is an authenticated Session or it writes nothing.
          {
            actor: "session",
            actorContext: { session: "5eeded00", ticket: null },
            payload: { kind: "created" },
          },
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

  it("records a typed verdict, keeps the latest per kind, and never moves the board", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const onMutation = vi.fn();
    const notify = vi.fn();
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
      onMutation,
      notify,
    });
    const request = (cmd: AgentRequest["cmd"], args: Record<string, unknown>, session?: string) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: {
          cwd: "/repo/volli",
          env: session ? asSession(session, { ticket: "VC-1" }) : ACTING_ENV,
        },
      });

    await request("ticket.create", { title: "Ship CLI" });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );

    const failed = await request(
      "ticket.signal",
      { id: "VC-1", kind: "review", verdict: "fail", detail: "Missing tests" },
      sessionId,
    );
    const passed = await request(
      "ticket.signal",
      { id: "VC-1", kind: "review", verdict: "pass" },
      sessionId,
    );
    await request("ticket.signal", { id: "VC-1", kind: "budget", verdict: "blocked" }, sessionId);
    const shown = await request("ticket.show", { id: "VC-1", events: 0, comments: 0 });

    expect(failed).toMatchObject({
      ok: true,
      data: {
        signal: {
          ticket: "VC-1",
          kind: "review",
          verdict: "fail",
          detail: "Missing tests",
          session: "abcdef12",
        },
      },
    });
    // No detail is null rather than "", so absence has one spelling.
    expect(passed).toMatchObject({ ok: true, data: { signal: { detail: null } } });
    // Latest per kind, in the order those surviving signals happened — and the
    // superseded `fail` is gone from the answer without being gone from history.
    expect(shown).toMatchObject({
      ok: true,
      data: {
        ticket: { id: "VC-1", status: "backlog" },
        signals: [
          { ticket: "VC-1", kind: "review", verdict: "pass" },
          { ticket: "VC-1", kind: "budget", verdict: "blocked" },
        ],
        events: [],
        comments: [],
      },
    });
    // Orthogonal by design (VC-85): the ticket sits where it sat, and nobody
    // was notified that a machine wrote a row.
    expect(notify).not.toHaveBeenCalled();
    // Full ids never cross the socket, here as everywhere else.
    expect(JSON.stringify({ failed, passed, shown })).not.toContain(sessionId);
    expect(JSON.stringify({ failed, passed, shown })).not.toContain("ticket-one");
    // The renderer is told, because a signal changes what a ticket surface shows.
    expect(onMutation).toHaveBeenCalledWith({
      ticketId: "ticket-one",
      projectId: "project-one",
      kind: "ticket",
    });

    const events = await request("ticket.events", { id: "VC-1", limit: 10 });
    expect(events).toMatchObject({
      ok: true,
      data: {
        events: [
          { payload: { kind: "created" } },
          {
            actor: "session",
            actorContext: { session: "abcdef12", ticket: "VC-1" },
            payload: {
              kind: "signaled",
              signalKind: "review",
              verdict: "fail",
              detail: "Missing tests",
            },
          },
          { payload: { kind: "signaled", signalKind: "review", verdict: "pass", detail: null } },
          { payload: { kind: "signaled", signalKind: "budget", verdict: "blocked" } },
        ],
      },
    });
  });

  it("refuses a signal with no session, an invented kind, or a verdict nobody defined", async () => {
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
    const request = (args: Record<string, unknown>, env: AgentRequest["ctx"]["env"] = {}) =>
      service.execute({
        v: 1,
        cmd: "ticket.signal",
        args,
        ctx: { cwd: "/repo/volli", env },
      });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );
    // Even an explicit project-policy grant cannot manufacture a signer. The
    // generic coordination gate admits this caller so ticket.signal's stronger
    // invariant is the check under test.
    updateProjectAuthorityPolicy(
      ctx.db,
      "project-one",
      { actors: { unauthenticated: { coordinationVerbs: ["ticket.signal"] } } },
      101,
    );

    // A verdict is worth what its signer is. No token — whether the caller
    // supplies no Session id or forges a real one — reaches the write.
    for (const env of [{}, { session: sessionId }]) {
      expect(await request({ id: "VC-1", kind: "review", verdict: "pass" }, env)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN_ACTOR", reason: expect.stringContaining("authenticated") },
      });
    }
    const authenticated = asSession(sessionId);
    // Both refusals name the whole vocabulary: a fixed list is only cheap to
    // live with if being wrong teaches you the right words.
    expect(
      await request({ id: "VC-1", kind: "vibes", verdict: "pass" }, authenticated),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        reason: expect.stringContaining("validate, implement, review, merge, human-gate, budget"),
      },
    });
    expect(
      await request({ id: "VC-1", kind: "review", verdict: "probably" }, authenticated),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", reason: expect.stringContaining("pass, fail, blocked") },
    });
    expect(
      await request({ id: "VC-1", kind: "review", verdict: "pass", detail: 7 }, authenticated),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", reason: "The signal detail must be text." },
    });
    expect(
      await request({ id: "VC-404", kind: "review", verdict: "pass" }, authenticated),
    ).toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });

    insertProject(
      ctx.db,
      testProject({ id: "other-project", path: "/repo/other", ticketPrefix: "OT" }),
    );
    insertTicket(ctx.db, testTicket("other-project", { id: "other-ticket", ticketNumber: 1 }));
    expect(
      await request({ id: "OT-1", kind: "review", verdict: "pass" }, authenticated),
    ).toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });

    // Nothing was written by any of them, including the cross-project target.
    expect(listLatestSignals(ctx.db, "ticket-one")).toEqual([]);
    expect(listLatestSignals(ctx.db, "other-ticket")).toEqual([]);
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
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
        ctx: {
          cwd: "/repo/volli",
          env: session ? asSession(session, { ticket: "VC-2" }) : ACTING_ENV,
        },
      });
    // VC-1 is the ticket being moved; VC-2 is the driving session's own ticket.
    await exec("ticket.create", { title: "Worked ticket", status: "todo" });
    await exec("ticket.create", { title: "Orchestrator ticket", status: "doing" });
    const orchestrator = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-2", { id: orchestrator, cwd: "/repo/volli" }),
    );

    // The guardrail is about entering DOING, not about who moved: a move
    // anywhere else is silent whoever made it. (Since VC-163 there is no
    // "user-attributed CLI move" to contrast with — an unauthenticated caller
    // cannot move a Ticket at all, which `socket-honesty.test.ts` proves.)
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
        service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
      return { exec, interruptedTickets };
    }

    it("interrupts live terminals without adding planner history on a doing→todo move", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1", "s2"]);
      await exec("ticket.create", { title: "T", status: "doing" });

      const moved = await exec("ticket.move", { id: "VC-1", to: "todo" });

      expect((moved as { ok: boolean }).ok).toBe(true);
      expect(interruptedTickets).toEqual(["ticket-1"]);
    });

    it("interrupts on a needs_review→done move", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "needs_review" });

      await exec("ticket.move", { id: "VC-1", to: "done" });

      expect(interruptedTickets).toEqual(["ticket-1"]);
    });

    it("does not interrupt a doing→needs_review move (still active)", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "doing" });

      await exec("ticket.move", { id: "VC-1", to: "needs_review" });

      expect(interruptedTickets).toEqual([]);
    });

    it("does not interrupt a todo→backlog move (never active)", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt(["s1"]);
      await exec("ticket.create", { title: "T", status: "todo" });

      await exec("ticket.move", { id: "VC-1", to: "backlog" });

      expect(interruptedTickets).toEqual([]);
    });

    it("records nothing when the interrupt finds no live agent sessions", async () => {
      const { exec, interruptedTickets } = serviceWithInterrupt([]);
      await exec("ticket.create", { title: "T", status: "doing" });

      await exec("ticket.move", { id: "VC-1", to: "todo" });

      expect(interruptedTickets).toEqual(["ticket-1"]);
    });

    it("keeps a committed move successful when its asynchronous interrupt rejects", async () => {
      const { exec } = serviceWithInterrupt([]);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await exec("ticket.create", { title: "T", status: "doing" });
        const service = createAgentCommandService({
          db: ctx.db,
          appVersion: "1.2.3",
          interruptTicketSessions: async () => {
            throw new Error("pty unavailable");
          },
        });

        const moved = await service.execute({
          v: 1,
          cmd: "ticket.move",
          args: { id: "VC-1", to: "todo" },
          ctx: { cwd: "/repo/volli", env: ACTING_ENV },
        });

        expect(moved).toMatchObject({ ok: true, data: { ticket: { status: "todo" } } });
      } finally {
        consoleError.mockRestore();
      }
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
        env: asSession(sessionId, { ticket: "VC-1", socket: "/tmp/volli.sock" }),
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
        previewContract: MUTATION_PLAN_CONTRACT,
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
        previewContract: MUTATION_PLAN_CONTRACT,
      },
    });
  });

  it("reads Role-aware help data from the Session's frozen Agent Tool Surface without backfilling", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );
    const engine = createDesktopSessionEngine(ctx.db);
    const provenance = {
      source: { kind: "system" as const, id: "test", detail: null },
      venue: { id: "local", kind: "local" as const },
    };
    await engine.getOrRecordSessionInput({
      sessionId,
      input: { kind: "tool-surface", tools: ["read", "edit", "ask_user"] },
      provenance,
    });
    const beforeEvents = await engine.listEvents({ sessionId });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      sessionEngine: engine,
    });

    const response = await service.execute({
      v: 1,
      cmd: "identify",
      args: { agentSurface: true },
      ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        agentSurface: { role: "ticket", tools: ["read", "edit", "ask_user"] },
      },
    });
    expect(await engine.listEvents({ sessionId })).toEqual(beforeEvents);

    // Reading the frozen list folds the whole Session ledger, and identify
    // already folds it once. Only role-aware help wants it, so only role-aware
    // help asks — the command agents are told to run first does not pay.
    expect(
      await service.execute({
        v: 1,
        cmd: "identify",
        args: {},
        ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
      }),
    ).not.toHaveProperty("data.agentSurface");
  });

  // The `--dry-run` preflight asks whether this build understands a preview at
  // all. An ordinary identify resolves a Project and Session first, so a
  // context-shaped probe made `volli notify --dry-run` fail with
  // PROJECT_REQUIRED from any unregistered directory while plain `volli notify`
  // worked — the confident-but-irrelevant refusal this ticket exists to remove.
  it("answers the preview-capability probe without resolving project or session context", async () => {
    ctx = openTestDb();
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.2.3" });
    const probe = (env: Record<string, string>) =>
      service.execute({
        v: 1,
        cmd: "identify",
        args: { capabilities: true },
        ctx: { cwd: "/somewhere/unregistered", env },
      });

    const capabilities = {
      v: 1,
      ok: true,
      data: { appVersion: "1.2.3", previewContract: MUTATION_PLAN_CONTRACT },
    };
    // No registered project for this cwd, and a session id that resolves to
    // nothing: both refuse a context identify, neither is the probe's question.
    expect(await probe({})).toEqual(capabilities);
    expect(await probe({ session: "00000000-0000-0000-0000-000000000000" })).toEqual(capabilities);

    // The same request without the probe argument is exactly the refusal a
    // preview used to inherit.
    expect(
      await service.execute({
        v: 1,
        cmd: "identify",
        args: {},
        // Anonymous on purpose: this is the refusal a preview used to inherit,
        // and it must be the CONTEXT refusal rather than an admission one.
        ctx: { cwd: "/somewhere/unregistered", env: {} },
      }),
    ).toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  // The bundled parser refuses this, but the socket is a public door and a
  // registry-projected tool builds its own arguments. Silently ignoring dryRun
  // on the way to a real write is the one outcome a preview cannot allow.
  //
  // `session.harness` is the subject because it is a socket-projected WRITE
  // that declares no `--dry-run` option — which is the whole condition under
  // test. The refusal is registry-generic and names no verb, so any such verb
  // proves it; this one used to be `ticket.archive`, until VC-163 took that
  // verb off the socket altogether.
  it("refuses a preview for a verb that declares none instead of writing anyway", async () => {
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });

    expect(await execute("session.harness", { id: "claude-code", dryRun: true })).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        reason: expect.stringContaining("session.harness declares no side-effect preview"),
        next: expect.stringContaining("volli help session harness"),
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });

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
        comments: [
          { ticket: "VC-1", body: "Public progress", actor: "session", session: "5eeded00" },
        ],
      },
    });
    expect(JSON.stringify({ list, show })).not.toMatch(
      /ticket-internal|[0-9a-f]{8}-[0-9a-f-]{27}/i,
    );
  });

  it("reads a zero ticket.show count as none, and a nonsense one as the default", async () => {
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
    await execute("ticket.create", {
      title: "Ship CLI",
      body: "A long static body never needed by a poll.",
    });
    for (const priority of ["high", "low", "medium", "high", "low", "medium"] as const) {
      await execute("ticket.update", {
        id: "VC-1",
        priority,
        addLabels: [],
        removeLabels: [],
      });
    }

    await execute("ticket.comment", { id: "VC-1", message: "Prose" });

    // VC-85: `events: 0` is the cheapest poll a read verb can answer, and it
    // has to mean NONE. `slice(-0)` is `slice(0)` — the whole history — so the
    // zero path is the one that must be read before it is sliced.
    const quiet = await execute("ticket.show", { id: "VC-1", events: 0, comments: 0 });
    // A negative or fractional count is not an answer at all; those still fall
    // back to the command's default rather than slicing from the wrong end.
    const nonsense = await execute("ticket.show", { id: "VC-1", events: -3, comments: 1.5 });

    expect(quiet).toMatchObject({
      ok: true,
      data: {
        ticket: { id: "VC-1", status: "backlog", title: "Ship CLI" },
        events: [],
        comments: [],
      },
    });
    if (quiet.ok) {
      const data = quiet.data as { ticket: Record<string, unknown> };
      expect(data.ticket).not.toHaveProperty("body");
      expect(data.ticket).not.toHaveProperty("worktreePath");
    }
    const commentsOnly = await execute("ticket.show", {
      id: "VC-1",
      events: 0,
      commentsOnly: true,
    });
    expect(commentsOnly.ok).toBe(true);
    if (commentsOnly.ok) {
      const data = commentsOnly.data as { ticket: Record<string, unknown>; comments: unknown[] };
      expect(data.ticket).not.toHaveProperty("body");
      expect(data.comments).toHaveLength(1);
    }
    expect(nonsense.ok).toBe(true);
    if (nonsense.ok) {
      const data = nonsense.data as { events: unknown[]; comments: unknown[] };
      expect(data.events).toHaveLength(5);
      expect(data.comments).toHaveLength(1);
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
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
      error: makeAgentError(
        "BODY_MATCH_FAILED",
        'Body edit expected exactly one match for "Old section".',
      ),
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
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

  // VC-163 took archiving off every agent surface — it is app-only curation, a
  // person deciding a Ticket has stopped being live work. What is proved here
  // is that the CAPABILITY is untouched and only the door is gone: the app's
  // own `archiveTicketCommand` still archives, and the board still reflects it.
  // That the socket no longer names the verb is pinned in `verb-registry.test`,
  // where the projection lives; here it could only be asserted by writing a
  // command this door's types no longer admit.
  it("still archives through the app's own command, with no socket door left", async () => {
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
    await execute("ticket.create", { title: "Ship CLI" });

    archiveTicketCommand(ctx.db, "ticket-one", { now: 100, actor: { kind: "user" } });

    expect(await execute("board", {})).toMatchObject({
      data: { columns: { backlog: [] } },
    });
    // Reversible, and still reachable by explicit id from the read verbs.
    expect(listArchivedTicketsByProject(ctx.db, "project-one")).toMatchObject([
      { id: "ticket-one", archivedAt: 100 },
    ]);
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Board coordination goes through the bundled `volli` CLI. Run `volli help` when you need its reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI\n\nFollow the implementation contract.",
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "You are working in an isolated git worktree at `/Users/x/.volli/worktrees/project-one/VC-1` " +
          "on branch `volli/VC-1-ship-cli` (branched from `main`). All work happens in the current " +
          "directory. The main checkout at `/repo/volli` is reference-only — never modify it.\n\n" +
          "Board coordination goes through the bundled `volli` CLI. Run `volli help` when you need its reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI\n\nFollow the implementation contract.",
      },
    });
  });

  it("names the Main checkout as a no-worktree Ticket's execution root", async () => {
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
      args: { title: "Ship CLI", body: "Follow the implementation contract.", usesWorktree: false },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(brief).toMatchObject({
      ok: true,
      data: {
        prompt: expect.stringContaining(
          "This Ticket intentionally runs in the Main checkout at `/repo/volli`. All work happens in this directory.",
        ),
      },
    });
    if (!brief.ok) throw new Error("expected a Ticket Brief");
    expect((brief.data as { prompt: string }).prompt).not.toContain(
      "worktree has not materialized",
    );
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    const blobsRootDir = blobsRoot(mkdtempSync(join(tmpdir(), "volli-blobs-")));
    importBlob(
      ctx.db,
      blobsRootDir,
      {
        fileName: "spec.png",
        bytes: Buffer.from("spec bytes"),
        label: "homepage mock",
        owner: { ticketId: "ticket-one" },
      },
      100,
    );
    importBlob(
      ctx.db,
      blobsRootDir,
      {
        fileName: "design.pdf",
        bytes: Buffer.from("design bytes"),
        label: "design doc",
        owner: { ticketId: "ticket-one" },
      },
      200,
    );

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Board coordination goes through the bundled `volli` CLI. Run `volli help` when you need its reference (and the volli skill, when installed, for norms).\n\n" +
          "VC-1: Ship CLI\n\nFollow the implementation contract.\n\n" +
          "## Attachments\n\n" +
          "Read each attached file before starting — they are part of the ticket's spec:\n" +
          "- `.volli/attachments/spec.png` — homepage mock\n" +
          "- `.volli/attachments/design.pdf` — design doc",
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    const brief = await service.execute({
      v: 1,
      cmd: "ticket.brief",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(brief).toEqual({
      v: 1,
      ok: true,
      data: {
        prompt:
          "Board coordination goes through the bundled `volli` CLI. Run `volli help` when you need its reference (and the volli skill, when installed, for norms).\n\nVC-1: Ship CLI",
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
      // No session env: the point is that `--project` alone resolves, so a
      // session rung sitting underneath it would decide nothing here.
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
      // No session env: the point is that `--project` alone resolves, so a
      // session rung sitting underneath it would decide nothing here.
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
    const base = { cwd: "/repo/alpha", env: ACTING_ENV } as const;

    const create = await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { project: "AL", title: "X", priority: "urgent" },
      ctx: base,
    });
    expect(create).toEqual({
      v: 1,
      ok: false,
      error: makeAgentError(
        "INVALID_REQUEST",
        'Invalid priority "urgent" (valid: low, medium, high)',
      ),
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
      const base = { cwd: "/repo/alpha", env: ACTING_ENV } as const;
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
        error: makeAgentError(
          "INVALID_REQUEST",
          'Unknown harness "aider" — no harness by that name is registered (built in: claude-code, codex, cursor, opencode)',
          "Register that harness through the app or use one of the built-in ids named in the refusal.",
        ),
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
      service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
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
            // A Session that never called a model through Volli: null cost and
            // an unavailable basis, never `0` — unmeasured is not free.
            costUsd: null,
            costBasis: "unavailable",
            costCoverage: "unavailable",
            tokens: 0,
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    // `arrayContaining`, because the caller's own Session is on this list too:
    // since VC-163 a socket writer must BE a Session, so the fixture that
    // authenticates these tests is itself a row here. The subject is the
    // harness this Session reports, not the length of the list.
    expect(sessions).toMatchObject({
      ok: true,
      data: {
        sessions: expect.arrayContaining([expect.objectContaining({ harness: "claude-code" })]),
      },
    });
  });

  // The snapshot every other session verb addresses stays terminal-only, but
  // session.list now surfaces structured chat rows too (VC-13 decision 4):
  // `session start` must never start a session its own caller cannot see.
  it("widens session.list with chat rows while the addressable snapshot stays terminal-only", async () => {
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
      testSession("project-one", null, { id: sessionId, title: "Terminal", createdAt: 900 }),
    );
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 900 });
    const structured = await sessionEngine.createSession({
      commandId: "structured-create",
      projectId: "project-one",
      ticketId: null,
      title: "Structured OpenCode Session",
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
      sessionEngine,
    });

    const sessions = await service.execute({
      v: 1,
      cmd: "session.list",
      args: {},
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    // Identity resolution is engine-backed (VC-51): a structured Session
    // exports VOLLI_SESSION too, so `identify` answers for it even though the
    // terminal snapshot (resume/rename) never contains it. (`session peek`
    // reads BOTH halves — VC-79 — and is exercised on its own below.)
    const identify = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: asSession(structured.session.id) },
    });

    expect(sessions).toMatchObject({
      ok: true,
      data: {
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: "abcdef12", title: "Terminal" }),
          expect.objectContaining({
            id: structured.session.id.slice(0, 8),
            kind: "chat",
            ticket: null,
            title: "Structured OpenCode Session",
            ageMs: 100,
          }),
        ]),
      },
    });
    expect(JSON.stringify(sessions)).not.toContain(structured.session.id);
    // A ticketless structured Session identifies against its project root: it
    // has no PTY cwd and no worktree, and that is the directory it runs in.
    expect(identify).toMatchObject({
      ok: true,
      data: {
        session: structured.session.id.slice(0, 8),
        ticket: null,
        worktreePath: "/repo/volli",
      },
    });
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
      ctx: { cwd: "/outside", env: ACTING_ENV },
    });

    const mismatch = await service.execute({
      v: 1,
      cmd: "session.list",
      args: { ticket: "AL-1", project: "/repo/beta" },
      ctx: { cwd: "/outside", env: ACTING_ENV },
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
    insertSession(
      ctx.db,
      testSession("project-one", null, { id: sessionId, title: "Project chat" }),
    );
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    const notified = await service.execute({
      v: 1,
      cmd: "notify",
      args: { title: "Agent", message: "Needs input" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    const byUuid = await service.execute({
      v: 1,
      cmd: "session.peek",
      args: { id: sessionId, lines: 2 },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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

  // VC-79. The orchestration paradigm runs on chat Sessions, and a peek that
  // answered only for terminals left a long-running one indistinguishable from
  // a hung one: its only liveness signal was the eventual ticket comment.
  describe("session.peek over a chat session", () => {
    const PROVENANCE = {
      source: { kind: "adapter" as const, id: "pi", detail: null },
      venue: { id: "local" as const, kind: "local" as const },
    };
    const PEEK_AT = 100_000;

    /**
     * A structured Session with an open Pi attachment, one started turn, and
     * whatever transcript the caller asked for — the shape a chat has while an
     * agent is working in it.
     */
    async function chatSession(input: { messages: readonly UIMessage[] }): Promise<{
      service: ReturnType<typeof createAgentCommandService>;
      sessionEngine: SessionEngine;
      sessionId: string;
      shortId: string;
    }> {
      ctx = openTestDb();
      insertProject(
        ctx.db,
        testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
      );
      const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 1_000 });
      const created = await sessionEngine.createSession({
        commandId: "chat-create",
        projectId: "project-one",
        ticketId: null,
        title: "Review VC-53",
        provenance: PROVENANCE,
      });
      const sessionId = created.session.id;
      await sessionEngine.observe({
        id: "chat-attach",
        kind: "attachment.opened",
        sessionId,
        occurredAt: 1_000,
        provenance: PROVENANCE,
        attachment: {
          id: "attachment-1",
          sessionId,
          adapterId: "pi",
          venue: { id: "local", kind: "local" },
          continuity: "fresh",
          native: { id: "pi-1", detail: null },
          authority: null,
        },
      });
      await sessionEngine.observe({
        id: "chat-turn",
        kind: "turn.started",
        sessionId,
        attachmentId: "attachment-1",
        occurredAt: 2_000,
        provenance: PROVENANCE,
        turnId: "turn-1",
      });
      for (const [index, message] of input.messages.entries()) {
        await sessionEngine.observe({
          id: `chat-transcript-${index}`,
          kind: "transcript.referenced",
          sessionId,
          attachmentId: "attachment-1",
          occurredAt: messageAt(index),
          provenance: PROVENANCE,
          turnId: "turn-1",
          reference: await artifacts.write({
            version: 1,
            threadId: "thread-1",
            branchId: "branch-1",
            attemptId: "attempt-1",
            turnId: "turn-1",
            message,
          }),
        });
      }
      return {
        sessionEngine,
        sessionId,
        shortId: sessionId.slice(0, 8),
        service: createAgentCommandService({
          db: ctx.db,
          appVersion: "1.2.3",
          now: () => PEEK_AT,
          sessionEngine,
          readTranscriptArtifact: (reference) => artifacts.read(reference),
        }),
      };
    }

    it("answers what it is doing, when it last moved, and its transcript tail", async () => {
      const { service, sessionId, shortId } = await chatSession({
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "Review VC-53" }] },
          {
            id: "m2",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "volli.activity",
                toolCallId: "call-1",
                state: "output-available",
                input: {},
                output: {},
                toolMetadata: {
                  [ACTIVITY_METADATA_KEY]: {
                    kind: "run-command",
                    nativeToolName: "bash",
                    subject: { label: "pnpm test", path: null, lineRange: null },
                    outcome: null,
                    startedAt: null,
                    endedAt: null,
                  },
                },
              },
            ],
          },
          {
            id: "m3",
            role: "assistant",
            parts: [
              { type: "reasoning", text: "weighing the options", state: "done" },
              { type: "text", text: "Gates are green.", state: "done" },
            ],
          },
        ],
      });

      const peek = await service.execute({
        v: 1,
        cmd: "session.peek",
        args: { id: shortId, lines: 2 },
        ctx: { cwd: "/repo/volli", env: ACTING_ENV },
      });

      expect(peek).toMatchObject({
        ok: true,
        data: {
          session: shortId,
          // An open turn under a live attachment: the agent is working, which
          // is the same word the app's own sidebar row uses.
          status: "working",
          waitingOn: null,
          turns: 1,
          turnDepth: 3,
          messages: 3,
          unreadable: 0,
          transcript: [
            { role: "assistant", text: "", tools: ["bash"] },
            // Reasoning stays out of a peek; the words and the tools are what
            // answer "what is it doing".
            { role: "assistant", text: "Gates are green.", tools: [] },
          ],
        },
      });
      if (!peek.ok) throw new Error("expected a peek");
      const data = peek.data as { lastActivityAgeMs: number; transcript: { ageMs: number }[] };
      // Ages against the caller's own clock are the liveness signal, and the
      // last thing that happened here is the newest message.
      expect(data.lastActivityAgeMs).toBe(PEEK_AT - messageAt(2));
      expect(data.transcript.map((entry) => entry.ageMs)).toEqual([
        PEEK_AT - messageAt(1),
        PEEK_AT - messageAt(2),
      ]);
      // Short ids are the only public handles, on this half of the verb too.
      expect(JSON.stringify(peek)).not.toContain(sessionId);
    });

    it("caps an unasked tail and names what a human is blocking", async () => {
      const { service, sessionEngine, sessionId, shortId } = await chatSession({
        messages: Array.from({ length: 14 }, (_, index) => ({
          id: `m${index}`,
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: `line ${index}` }],
        })),
      });
      await sessionEngine.observe({
        id: "chat-attention",
        kind: "attention.raised",
        sessionId,
        attachmentId: "attachment-1",
        occurredAt: 30_000,
        provenance: PROVENANCE,
        attention: {
          id: "attention-1",
          kind: "permission_required",
          attachmentId: "attachment-1",
          detail: null,
          diagnostic: null,
        },
      });

      const peek = await service.execute({
        v: 1,
        cmd: "session.peek",
        args: { id: shortId },
        ctx: { cwd: "/repo/volli", env: ACTING_ENV },
      });

      expect(peek).toMatchObject({
        ok: true,
        // Waiting outranks working: a peek that said "working" would hide the
        // one thing the caller could act on.
        data: {
          status: "waiting",
          waitingOn: "permission",
          messages: 14,
          turnDepth: 14,
          lastActivityAgeMs: PEEK_AT - 30_000,
        },
      });
      if (!peek.ok) throw new Error("expected a peek");
      const { transcript } = peek.data as { transcript: { text: string }[] };
      // Cheap by default: the last CHAT_PEEK_ENTRIES messages, no more.
      expect(transcript).toHaveLength(CHAT_PEEK_ENTRIES);
      expect(transcript.at(0)?.text).toBe("line 2");
      expect(transcript.at(-1)?.text).toBe("line 13");
    });

    it("refuses an unknown handle and answers counts alone with no artifact store", async () => {
      const { shortId, sessionId } = await chatSession({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      });
      const storeless = createAgentCommandService({
        db: ctx.db,
        appVersion: "1.2.3",
        sessionEngine: createDesktopSessionEngine(ctx.db),
      });
      const peek = async (id: unknown) =>
        storeless.execute({
          v: 1,
          cmd: "session.peek",
          args: { id },
          ctx: { cwd: "/repo/volli", env: ACTING_ENV },
        });

      // A handle nothing answers to, a full UUID, and a malformed one: the
      // structured half refuses exactly the way the terminal half does.
      expect(await peek("nosuchid")).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
      });
      expect(await peek(sessionId)).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
      });
      expect(await peek(7)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      // No store to read: the activity counts are still true, and nothing is
      // reported as unreadable, because nothing looked.
      expect(await peek(shortId)).toMatchObject({
        ok: true,
        data: { messages: 1, unreadable: 0, transcript: [] },
      });
    });
  });

  it("records lifecycle signals in the Session ledger without changing planner history", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    let timestamp = 100;
    const mutations: Array<{ ticketId?: string; projectId?: string; kind?: string }> = [];
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => timestamp++,
      newId: () => "ticket-one",
      onMutation: (change) => mutations.push(change),
    });
    await service.execute({
      v: 1,
      cmd: "ticket.create",
      args: { title: "Ship CLI" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    mutations.length = 0;
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );

    const blocked = await service.execute({
      v: 1,
      cmd: "session.blocked",
      args: { reason: "Waiting for credentials" },
      ctx: { cwd: "/repo/volli", env: asSession(sessionId, { ticket: "VC-1" }) },
    });
    const events = await service.execute({
      v: 1,
      cmd: "ticket.events",
      args: { id: "VC-1", limit: 10 },
      ctx: { cwd: "/repo/volli", env: asSession(sessionId, { ticket: "VC-1" }) },
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
      data: { events: [{ payload: { kind: "created" } }] },
    });
    expect((events as { data: { events: unknown[] } }).data.events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(sessionId);
    expect(
      (await createDesktopSessionEngine(ctx.db).getSession({ sessionId }))?.signal,
    ).toMatchObject({
      signal: "blocked",
      reason: "Waiting for credentials",
    });
    expect(mutations).toEqual([
      { ticketId: "ticket-one", projectId: "project-one", kind: "session" },
    ]);
  });

  it("does not invalidate readers when a session signal cannot be durably recorded", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", "ticket-one", { id: sessionId }));
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const mutations: Array<{ ticketId?: string; projectId?: string; kind?: string }> = [];
    const submit = sessionEngine.submit.bind(sessionEngine);
    sessionEngine.submit = async () => {
      throw new Error("disk full");
    };
    const service = createAgentCommandService({
      db: ctx.db,
      sessionEngine,
      appVersion: "1.2.3",
      onMutation: (change) => mutations.push(change),
    });

    await expect(
      service.execute({
        v: 1,
        cmd: "session.done",
        args: {},
        ctx: { cwd: "/repo/volli", env: asSession(sessionId, { ticket: "VC-1" }) },
      }),
    ).rejects.toThrow("disk full");
    expect(mutations).toEqual([]);
    sessionEngine.submit = submit;
  });

  it("does not claim a signal was recorded when its durable receipt is rejected", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", null, { id: sessionId }));
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    await sessionEngine.submit({
      commandId: "archive-before-signal",
      sessionId,
      intent: { kind: "session.archive" },
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const mutations: unknown[] = [];
    const service = createAgentCommandService({
      db: ctx.db,
      sessionEngine,
      appVersion: "1.2.3",
      onMutation: (change) => mutations.push(change),
    });

    const response = await service.execute({
      v: 1,
      cmd: "session.done",
      args: {},
      ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "MUTATION_FAILED" } });
    expect(mutations).toEqual([]);
  });

  it("does not list every project session for a hook addressed by VOLLI_SESSION", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    insertSession(ctx.db, testSession("project-one", null, { id: sessionId }));
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const listed = vi.spyOn(sessionEngine, "listSessions");
    const service = createAgentCommandService({ db: ctx.db, sessionEngine, appVersion: "1.2.3" });

    const response = await service.execute({
      v: 1,
      cmd: "hook",
      args: { harness: "claude-code", event: "turn.started" },
      ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
    });

    expect(response).toMatchObject({ ok: true, data: { session: "abcdef12" } });
    expect(listed).not.toHaveBeenCalled();
  });

  it("records Project-Session signals in the ledger and requires session context", async () => {
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
      ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
    });
    // Anonymous: refused at the door rather than for missing context, because
    // since VC-163 those are the same condition (see `session.link`).
    const missing = await service.execute({
      v: 1,
      cmd: "session.done",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(done).toEqual({
      v: 1,
      ok: true,
      data: { session: "abcdef12", signal: "done", reason: null, recorded: true },
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
  });

  it("accepts a lifecycle signal from a structured session with no terminal attachment (VC-51)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    // A structured (chat) Session: created through the engine, never given a
    // terminal attachment — exactly what `volli session start` produces.
    const created = await sessionEngine.createSession({
      commandId: "create-structured",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const sessionId = created.session.id;
    const mutations: Array<{ ticketId?: string; projectId?: string; kind?: string }> = [];
    const service = createAgentCommandService({
      db: ctx.db,
      sessionEngine,
      appVersion: "1.2.3",
      onMutation: (change) => mutations.push(change),
    });

    const done = await service.execute({
      v: 1,
      cmd: "session.done",
      args: { reason: "Implementation finished" },
      ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
    });

    expect(done).toMatchObject({
      ok: true,
      data: { signal: "done", reason: "Implementation finished", recorded: true },
    });
    expect((await sessionEngine.getSession({ sessionId }))?.signal).toMatchObject({
      signal: "done",
      reason: "Implementation finished",
    });
    expect(mutations).toEqual([
      { ticketId: "ticket-one", projectId: "project-one", kind: "session" },
    ]);
  });

  it("attributes a socket write from a structured session to the session, not the user (VC-51)", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const created = await sessionEngine.createSession({
      commandId: "create-structured",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const service = createAgentCommandService({
      db: ctx.db,
      sessionEngine,
      appVersion: "1.2.3",
    });

    const comment = await service.execute({
      v: 1,
      cmd: "ticket.comment",
      args: { id: "VC-1", message: "Findings recorded." },
      ctx: { cwd: "/repo/volli", env: asSession(created.session.id) },
    });
    const identified = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/outside", env: asSession(created.session.id) },
    });

    // Before VC-51 this failed SESSION_NOT_FOUND against the terminal-only
    // snapshot, and a chat session's comment attributed as "user" with no
    // session at all.
    expect(comment).toMatchObject({
      ok: true,
      data: { comment: { actor: "session" } },
    });
    expect(
      (comment as { data: { comment: { session: string | null } } }).data.comment.session,
    ).not.toBeNull();
    expect(identified).toMatchObject({
      ok: true,
      data: { ticket: "VC-1", project: { prefix: "VC" } },
    });
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
          ctx: { cwd: "/repo/volli", env: session ? asSession(session) : {} },
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

    it("preserves independent native fields when a wrapper announce races a session link", async () => {
      linkService();
      const sessionEngine = createDesktopSessionEngine(ctx.db);
      const observe = sessionEngine.observe.bind(sessionEngine);
      let delayFirstNativeWrite = true;
      sessionEngine.observe = async (observation) => {
        if (delayFirstNativeWrite && observation.kind === "attachment.native_referenced") {
          delayFirstNativeWrite = false;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        return observe(observation);
      };
      const service = createAgentCommandService({
        db: ctx.db,
        sessionEngine,
        appVersion: "1.2.3",
      });
      const link = (id: string) =>
        service.execute({
          v: 1,
          cmd: "session.link",
          args: { id },
          ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
        });
      const announce = service.execute({
        v: 1,
        cmd: "session.harness",
        args: { id: "claude-code" },
        ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
      });

      const [linked, announced] = await Promise.all([link("native-seed"), announce]);

      expect(linked).toMatchObject({ ok: true });
      expect(announced).toMatchObject({ ok: true });
      expect(getSession(ctx.db, sessionId)).toMatchObject({
        activeHarnessId: "claude-code",
        harnessSessionId: "native-seed",
      });
    });

    // Since VC-163 "no VOLLI_SESSION" and "not an authenticated Session" are
    // the same condition — a token cannot be held by anything that is not a
    // Session — so the admission gate answers first, and answers with more than
    // the old CONTEXT_REQUIRED did: it names what the caller must BE, not just
    // which variable is missing.
    it("refuses a caller that is not an authenticated Session", async () => {
      const { link } = linkService();
      const noContext = await link("some-uuid", null);
      expect(noContext).toMatchObject({
        ok: false,
        error: {
          code: "FORBIDDEN_ACTOR",
          reason: expect.stringContaining("not an authenticated Volli Session"),
          next: expect.stringContaining("from inside a Volli Session"),
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
          ctx: { cwd: "/repo/volli", env: session ? asSession(session) : {} },
        });
      const mint = (id: unknown, session: string | null = sessionId) =>
        service.execute({
          v: 1,
          cmd: "session.harness",
          args: { id, mint: true },
          ctx: { cwd: "/repo/volli", env: session ? asSession(session) : {} },
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
      // The first announce makes the effective launch harness explicit in the
      // terminal-native reference even though its semantic identity agrees.
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBe("claude-code");
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

    it("computes concurrent harness changes from each serialized native update", async () => {
      const { announce, notices } = announceService("claude-code");

      const [toCodex, backToClaude] = await Promise.all([
        announce("codex"),
        announce("claude-code"),
      ]);

      expect(toCodex).toMatchObject({ ok: true, data: { changed: true } });
      expect(backToClaude).toMatchObject({ ok: true, data: { changed: true } });
      expect(getSession(ctx.db, sessionId)?.activeHarnessId).toBe("claude-code");
      expect(notices).toEqual([
        expect.objectContaining({ harnessId: "codex", changed: true }),
        expect.objectContaining({ harnessId: "claude-code", changed: true }),
      ]);
    });

    it("refuses a caller that is not an authenticated Session", async () => {
      const { announce } = announceService();
      expect(await announce("claude-code", null)).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN_ACTOR" },
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

    it("does not report a minted id when its native write loses the live attachment", async () => {
      announceService("cursor");
      const sessionEngine = createDesktopSessionEngine(ctx.db);
      const observe = sessionEngine.observe.bind(sessionEngine);
      let closeAfterHarnessWrite = true;
      sessionEngine.observe = async (observation) => {
        const event = await observe(observation);
        if (closeAfterHarnessWrite && observation.kind === "attachment.native_referenced") {
          closeAfterHarnessWrite = false;
          await observe({
            id: "close-before-mint",
            kind: "attachment.closed",
            sessionId,
            attachmentId: observation.attachmentId,
            occurredAt: 5000,
            provenance: {
              source: { kind: "system", id: "test", detail: null },
              venue: { id: "local", kind: "local" },
            },
            outcome: "interrupted",
          });
        }
        return event;
      };
      const service = createAgentCommandService({
        db: ctx.db,
        sessionEngine,
        appVersion: "1.2.3",
      });

      const response = await service.execute({
        v: 1,
        cmd: "session.harness",
        args: { id: "cursor", mint: true },
        ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
      });

      expect(response).toMatchObject({ ok: false, error: { code: "SESSION_ENDED" } });
      expect(getSession(ctx.db, sessionId)?.harnessSessionId).toBeNull();
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
          ctx: { cwd: "/repo/volli", env: asSession(sessionId) },
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
          ctx: { cwd: "/repo/volli", env: session ? asSession(session) : {} },
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

    // The hot path is admitted like every other coordination verb (VC-92 §3
    // lists `hook` there, "session-actor by construction"). An anonymous
    // caller is refused at the door; an authenticated one naming a Session
    // Volli has no record of still gets the addressing refusal it always did.
    it("needs an authenticated Session, and refuses a session that is not ours", async () => {
      const { hook } = hookService();

      await expect(
        hook({ harness: "claude-code", event: "turn.started" }, null),
      ).resolves.toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
      ctx: { cwd: "/wt/VC-1", env: ACTING_ENV },
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
      ctx: { cwd: "/wt/VC-1/packages/shared", env: ACTING_ENV },
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
        ctx: { cwd: physicalCwd, env: ACTING_ENV },
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
      // No session env: the point is that `--project` alone resolves, so a
      // session rung sitting underneath it would decide nothing here.
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    const unknown = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-99" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });

    const noWorktree = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(noWorktree).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(noWorktree).toMatchObject({ ok: false });
    if (!noWorktree.ok) expect(noWorktree.error.message).toContain("no worktree");

    // Cwd sits in no worktree and no id was given → a teaching CONTEXT error.
    const noContext = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: {},
      ctx: { cwd: "/elsewhere", env: ACTING_ENV },
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
      ctx: { cwd: "/wt/VC-1", env: ACTING_ENV },
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
      ctx: { cwd: "/wt/VC-1", env: ACTING_ENV },
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
      ctx: { cwd: "/wt/VC-1", env: ACTING_ENV },
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
    // Archived through the app's own command: VC-163 left no socket door for it.
    archiveTicketCommand(ctx.db, "ticket-one", { now: 100, actor: { kind: "user" } });

    // Read-only worktree verbs serve an archived ticket by explicit id —
    // retention deliberately retains worktrees past archive (decision #76).
    const status = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      // No session env: the point is that `--project` alone resolves, so a
      // session rung sitting underneath it would decide nothing here.
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(status).toMatchObject({ ok: true, data: { ticket: "VC-1", worktreePath: "/wt/VC-1" } });

    // Every other command still refuses the same archived ticket outright.
    const show = await service.execute({
      v: 1,
      cmd: "ticket.show",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
      // No session env: the point is that `--project` alone resolves, so a
      // session rung sitting underneath it would decide nothing here.
      ctx: { cwd: "/somewhere/else", env: {} },
    });
    expect(res).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (!res.ok) {
      expect(res.error.message).toContain("worktree folder is missing");
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(bare).toMatchObject({ ok: false, error: { code: "CONTEXT_REQUIRED" } });
  });

  // ---- worktree.sync (VC-185, VC-89 slice 2) ------------------------------

  /** Every git subcommand that reaches a remote. The sync verb may run none. */
  const NETWORK_SUBCOMMANDS = ["fetch", "pull", "push", "ls-remote", "clone"];

  /** A project + one seeded VC-1 worktree, with git scripted by the caller. */
  const syncScenario = async (
    handler: (args: readonly string[], cwd: string) => string,
  ): Promise<{
    service: ReturnType<typeof createAgentCommandService>;
    calls: { args: readonly string[]; cwd: string }[];
  }> => {
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
    const { git, calls } = scriptedGit(handler);
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      newId: () => "ticket-one",
      git,
      worktreeExists: () => true,
    });
    await seedWorktreeTicket(service);
    return { service, calls };
  };

  it("merges the base into a ticket's branch and reports what moved", async () => {
    let head = "aaaaaaa";
    const { service } = await syncScenario((args) => {
      if (args[0] === "rev-parse" && args[3] === "MERGE_HEAD") throw new Error("no merge");
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return `${head}\n`;
      if (args[0] === "merge") {
        head = "ddddddd";
        return "";
      }
      if (args[0] === "rev-list") return "2\n";
      if (args[0] === "diff") return "3\t1\tsrc/a.ts\n";
      return "";
    });

    const res = await service.execute({
      v: 1,
      cmd: "worktree.sync",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
        mergedRef: "origin/main",
        status: "merged",
        commits: 2,
        files: [{ path: "src/a.ts", insertions: 3, deletions: 1, untracked: false }],
        insertions: 3,
        deletions: 1,
        totalFiles: 1,
        omittedFiles: 0,
        conflicts: [],
      },
    });
  });

  it("reports a conflicted sync per path and leaves the worktree conflicted", async () => {
    const { service, calls } = await syncScenario((args) => {
      if (args[0] === "rev-parse" && args[3] === "MERGE_HEAD") throw new Error("no merge");
      if (args[0] === "rev-parse" && args[1] === "--verify") return "bbbbbbb\n";
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") throw new Error("Automatic merge failed");
      if (args[0] === "diff" && args.includes("--diff-filter=U")) {
        return "packages/shared/src/x.ts\napps/desktop/src/y.tsx\n";
      }
      return "";
    });

    const res = await service.execute({
      v: 1,
      cmd: "worktree.sync",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    // A conflict is an OUTCOME the caller acts on, not a door refusal: the
    // per-path list is the whole answer, and an error object has nowhere to
    // carry it.
    expect(res).toMatchObject({
      ok: true,
      data: {
        ticket: "VC-1",
        status: "conflicted",
        conflicts: ["packages/shared/src/x.ts", "apps/desktop/src/y.tsx"],
      },
    });
    // Left conflicted for the session to resolve — nothing cleans up behind it.
    expect(calls.some((call) => call.args.includes("--abort"))).toBe(false);
  });

  it("returns without waiting on anything, in either outcome", async () => {
    // The hard constraint VC-92 pinned: sync must not block on gates or CI. A
    // verb that waits is a watch/wake tool (VC-85), and the way a local git
    // verb starts waiting is by reaching a remote — which is also credential
    // custody, and therefore not on this door at all.
    for (const conflicted of [false, true]) {
      const { service, calls } = await syncScenario((args) => {
        if (args[0] === "rev-parse" && args[3] === "MERGE_HEAD") throw new Error("no merge");
        if (args[0] === "rev-parse") return "aaaaaaa\n";
        if (args[0] === "merge" && conflicted) throw new Error("Automatic merge failed");
        if (args[0] === "diff" && args.includes("--diff-filter=U")) return "src/x.ts\n";
        return "";
      });

      const res = await service.execute({
        v: 1,
        cmd: "worktree.sync",
        args: { id: "VC-1" },
        ctx: { cwd: "/repo/volli", env: ACTING_ENV },
      });

      expect(res.ok).toBe(true);
      for (const call of calls) expect(NETWORK_SUBCOMMANDS).not.toContain(call.args[0]);
    }
  });

  it("aborts a merge left in flight, and refuses to abort when there is none", async () => {
    let inFlight = true;
    const { service, calls } = await syncScenario((args) => {
      if (args[0] === "rev-parse" && args[3] === "MERGE_HEAD") {
        if (!inFlight) throw new Error("no merge");
        return "cccccccc\n";
      }
      if (args[0] === "rev-parse") return "aaaaaaa\n";
      if (args[0] === "merge") {
        inFlight = false;
        return "";
      }
      return "";
    });

    const aborted = await service.execute({
      v: 1,
      cmd: "worktree.sync",
      args: { id: "VC-1", abort: true },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(aborted).toMatchObject({ ok: true, data: { ticket: "VC-1", status: "aborted" } });
    expect(calls.some((call) => call.args[1] === "--abort")).toBe(true);

    const again = await service.execute({
      v: 1,
      cmd: "worktree.sync",
      args: { id: "VC-1", abort: true },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(again).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (!again.ok) expect(again.error.reason).toContain("no merge in progress");
  });

  it("refuses an unauthenticated sync with a teaching error, never UNSUPPORTED_COMMAND", async () => {
    // Coordination tier (VC-92's audit): sync mutates the session's own
    // worktree, so it wants an authenticated session actor per VC-163 — and the
    // refusal has to teach, because "no such command" would send an agent off
    // to do the merge by hand.
    const { service, calls } = await syncScenario(() => "");

    const res = await service.execute({
      v: 1,
      cmd: "worktree.sync",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("FORBIDDEN_ACTOR");
    expect(res.error.reason).toContain("worktree.sync");
    expect(res.error.reason).toContain("coordination-tier");
    expect(res.error.next).toContain("Volli Session");
    // Refused at the door: no git ran on the way to the refusal.
    expect(calls).toEqual([]);
  });

  // ---- conflicts, the file-collision radar (VC-185, VC-89 slice 3) ---------

  /**
   * A project with `count` ticket worktrees, each answering its own numstat
   * keyed by the cwd git was invoked in.
   */
  const radarScenario = (
    touched: Readonly<Record<string, readonly string[]>>,
  ): ReturnType<typeof createAgentCommandService> => {
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
    for (const [index, [display, paths]] of Object.entries(touched).entries()) {
      const number = Number.parseInt(display.split("-")[1]!, 10);
      insertTicket(
        ctx.db,
        testTicket("project-one", {
          id: `ticket-${number}`,
          ticketNumber: number,
          title: `Ticket ${display}`,
          order: index,
          worktreePath: `/wt/${display}`,
          branch: `volli/${display}-work`,
          baseBranch: "main",
        }),
      );
      void paths;
    }
    const { git } = scriptedGit((args, cwd) => {
      if (args[0] === "rev-parse" && args[1] === "--verify") throw new Error("no origin ref");
      if (args[0] === "diff") {
        const display = cwd.slice("/wt/".length);
        return (touched[display] ?? []).map((path) => `1\t0\t${path}`).join("\n");
      }
      return "";
    });
    return createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      git,
      worktreeExists: () => true,
    });
  };

  it("prints an overlap matrix across active worktrees, for any caller", async () => {
    const service = radarScenario({
      "VC-65": ["src/chat-plane.tsx", "src/only-65.ts"],
      "VC-68": ["src/chat-plane.tsx"],
      "VC-70": ["src/elsewhere.ts"],
    });

    // Read tier: no session env at all, and it answers.
    const res = await service.execute({
      v: 1,
      cmd: "conflicts",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(res).toMatchObject({
      ok: true,
      data: {
        scanned: 3,
        overlaps: [{ path: "src/chat-plane.tsx", tickets: ["VC-65", "VC-68"] }],
        pairs: [{ tickets: ["VC-65", "VC-68"], paths: ["src/chat-plane.tsx"] }],
      },
    });
    if (!res.ok) return;
    const data = res.data as { worktrees: { ticket: string; files: number }[] };
    expect(data.worktrees).toEqual([
      { ticket: "VC-65", branch: "volli/VC-65-work", baseBranch: "main", files: 2 },
      { ticket: "VC-68", branch: "volli/VC-68-work", baseBranch: "main", files: 1 },
      { ticket: "VC-70", branch: "volli/VC-70-work", baseBranch: "main", files: 1 },
    ]);
  });

  it("renders the empty case as an answer, not as an absence", async () => {
    const service = radarScenario({ "VC-1": ["a.ts"], "VC-2": ["b.ts"] });

    const res = await service.execute({
      v: 1,
      cmd: "conflicts",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(res).toMatchObject({
      ok: true,
      data: { scanned: 2, overlaps: [], pairs: [], skipped: [] },
    });
  });

  it("names the worktrees it could not read instead of dropping them silently", async () => {
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
    // One ticket with no worktree at all, one whose diff cannot be computed.
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-1", ticketNumber: 1, title: "No worktree" }),
    );
    insertTicket(
      ctx.db,
      testTicket("project-one", {
        id: "ticket-2",
        ticketNumber: 2,
        title: "Broken",
        worktreePath: "/wt/VC-2",
        branch: "volli/VC-2-work",
        baseBranch: "main",
      }),
    );
    const { git } = scriptedGit((args) => {
      if (args[0] === "diff") throw new Error("fatal: bad revision");
      throw new Error("no origin ref");
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      now: () => 100,
      git,
      worktreeExists: () => true,
    });

    const res = await service.execute({
      v: 1,
      cmd: "conflicts",
      args: {},
      ctx: { cwd: "/repo/volli", env: {} },
    });

    expect(res).toMatchObject({ ok: true, data: { scanned: 0, overlaps: [], pairs: [] } });
    if (!res.ok) return;
    const data = res.data as { skipped: { ticket: string }[] };
    // A ticket with no worktree is not a fault and is simply not scanned; one
    // whose diff broke is named, because a radar that silently drops a worktree
    // reports "no collisions" for a collision it never looked at.
    expect(data.skipped.map((entry) => entry.ticket)).toEqual(["VC-2"]);
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
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
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    const prompt = (brief.data as { prompt: string }).prompt;
    expect(prompt).toContain("/wt/VC-1");
    expect(prompt).toContain("volli/VC-1-ship");
    expect(prompt).toContain("`main`");
  });
});

describe("identify env block (VC-94)", () => {
  const report = {
    path: "/profile/bin:/opt/homebrew/bin:/usr/bin",
    provenance: "adopted" as const,
    interactiveProvenance: "already-complete" as const,
    tools: {
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
      node: "/opt/homebrew/bin/node",
      npm: "/opt/homebrew/bin/npm",
      pnpm: "/opt/homebrew/bin/pnpm",
      yarn: null,
      bun: null,
    },
    requiredTools: ["git", "node", "pnpm"] as const,
    dependencies: "installed" as const,
  };

  it("carries the env block on every identify answer, session and ticketless alike", async () => {
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
    const askedCwds: string[] = [];
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 100,
      sessionEnv: async (cwd) => {
        askedCwds.push(cwd);
        return report;
      },
    });

    const inSession = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: { socket: "/tmp/volli.sock" } },
    });
    expect(inSession).toMatchObject({ ok: true, data: { env: report, ticket: null } });

    // The env seam is asked about the CALLER's cwd — the agent drives its own
    // directory through bash, so where it stands is only knowable at ask time.
    expect(askedCwds).toEqual(["/repo/volli"]);
  });

  it("omits the env block rather than inventing one when main has no env facts", async () => {
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
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.2.3", now: () => 100 });

    const response = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(response).toMatchObject({ ok: true });
    if (!response.ok) throw new Error("expected ok");
    expect(response.data).not.toHaveProperty("env");
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
      service.execute({ v: 1, cmd: "doctor", args, ctx: { cwd: "/repo", env: ACTING_ENV } });
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

  // VC-157: the caller names what its workspace implies, and only those
  // absences may be faults. Main cannot see that workspace, so it takes the
  // list — and takes an unreadable one as "nothing", the direction that costs
  // a fault rather than inventing one.
  it("faults only the tools the caller's workspace said it needs", async () => {
    const yarnWorkspace = {
      ...observation,
      resolved: { claude: "/ud/bin/claude", git: "/usr/bin/git", node: null, pnpm: null },
      requiredTools: ["git", "node", "yarn"],
    };

    expect((await checkFrom(yarnWorkspace, "tool-node")).status).toBe("fail");
    const pnpm = await checkFrom(yarnWorkspace, "tool-pnpm");
    expect(pnpm.status).toBe("ok");
    expect(pnpm.detail).toContain("nothing here asks for it");
  });

  it("drops unknown or malformed requirement names instead of faulting on them", async () => {
    const noJs = {
      ...observation,
      resolved: { claude: "/ud/bin/claude", git: null, gh: null },
      requiredTools: ["git", "cargo", 7],
    };
    expect((await checkFrom(noJs, "tool-git")).status).toBe("fail");
    expect((await checkFrom(noJs, "tool-gh")).status).toBe("ok");

    const unreadable = { ...observation, resolved: { git: null }, requiredTools: "git" };
    expect((await checkFrom(unreadable, "tool-git")).status).toBe("ok");
  });

  // "No project implies gh" is enforced at BOTH ends, so a caller that names
  // it — an older `volli`, or one from somewhere else entirely — cannot talk
  // main into reviving the launch-wide fault VC-157 retired.
  it("refuses a wire payload that claims gh is required", async () => {
    const claimsGh = {
      ...observation,
      resolved: { claude: "/ud/bin/claude", git: "/usr/bin/git", gh: null },
      requiredTools: ["git", "gh"],
    };

    const gh = await checkFrom(claimsGh, "tool-gh");
    expect(gh.status).toBe("ok");
    expect(gh.title).toBe("`gh` is not required by this project");
    expect((await checkFrom(claimsGh, "tool-git")).status).toBe("ok");
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
      ctx: { cwd: "/repo", env: ACTING_ENV },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
  });

  it("repairs before re-checking, so --fix reports the state it produced", async () => {
    const order: string[] = [];
    const pathRepair = {
      path: "/ud/bin:/opt/homebrew/bin:/Users/x/.bun/bin:/usr/bin",
      provenance: "adopted" as const,
      added: ["/opt/homebrew/bin"],
      interactiveProvenance: "adopted" as const,
      interactiveAdded: ["/Users/x/.bun/bin"],
    };
    const doctor = doctorService({
      doctorRepair: async () => {
        order.push("repair");
        return pathRepair;
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

    const response = await doctor({ ...observation, fix: true });
    expect(order).toEqual(["repair", "facts"]);
    expect(response).toMatchObject({ ok: true, data: { pathRepair } });
  });

  it("does not repair unless asked", async () => {
    let repaired = false;
    await doctorService({
      doctorRepair: async () => {
        repaired = true;
        return {
          path: "/ud/bin",
          provenance: "already-complete",
          added: [],
          interactiveProvenance: "already-complete",
          interactiveAdded: [],
        };
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

describe("prompt.baseline", () => {
  const INDEX_RESOURCE = {
    name: "skills index",
    text: "- svg (.agents/skills/svg/SKILL.md): draws vectors",
  };

  function baselineService(
    options: Partial<AgentCommandServiceOptions> = {},
  ): (args: Record<string, unknown>) => Promise<AgentResponse> {
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.0.0",
      skillsIndex: async () => INDEX_RESOURCE,
      ...options,
    });
    return (args) =>
      service.execute({
        v: 1,
        cmd: "prompt.baseline",
        args,
        ctx: { cwd: "/outside", env: ACTING_ENV },
      });
  }

  it("refuses without the index port rather than pricing a prompt it knows is incomplete", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo/volli", ticketPrefix: "VC" }));
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.0.0" });
    const response = await service.execute({
      v: 1,
      cmd: "prompt.baseline",
      args: { project: "/repo/volli" },
      ctx: { cwd: "/outside", env: ACTING_ENV },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "APP_UNREACHABLE" } });
  });

  it("prices a fresh project chat: every composed layer, the index, the Brief, and an honest total", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "p1", name: "Volli Code", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    const asked: string[] = [];
    const response = await baselineService({
      skillsIndex: async (projectId) => {
        asked.push(projectId);
        return INDEX_RESOURCE;
      },
    })({ project: "/repo/volli" });

    expect(asked).toEqual(["p1"]);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("expected success");
    const data = response.data as Record<string, unknown>;
    expect(data["project"]).toEqual({ name: "Volli Code", prefix: "VC" });
    expect(data["role"]).toBe("project");
    expect(data["workspace"]).toBe("/repo/volli");
    expect(data["charsPerToken"]).toBe(4);
    const sections = data["sections"] as {
      id: string;
      chars: number;
      tokens: number;
      cacheClass: string;
      placement: string;
    }[];
    expect(sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "resources-header",
      "resource:skills index",
      "brief",
      // The Role bundle block the first message carries (VC-162).
      "reminder:session-tools",
    ]);
    for (const section of sections) {
      expect(section.chars).toBeGreaterThan(0);
      expect(section.tokens).toBe(Math.ceil(section.chars / 4));
      // What it costs and how often it is bought again, at the door a reader
      // actually reads (VC-164) — never one without the other.
      expect(["role-static", "project-static", "session-static", "per-turn"]).toContain(
        section.cacheClass,
      );
      expect(["prefix", "message"]).toContain(section.placement);
    }
    const system = data["system"] as { chars: number; tokens: number };
    const brief = data["brief"] as { chars: number; tokens: number };
    const total = data["total"] as { chars: number; tokens: number };
    // An unwritable path is no package workspace, so it earns no reminder: a
    // measured zero rather than a missing measurement.
    expect(data["reminder"]).toEqual({ chars: 0, tokens: 0 });
    // The bundle block, unlike the reminder, is sent to every Session — so it
    // is never a measured zero and always rides the total.
    const toolSurface = data["toolSurface"] as { chars: number; tokens: number };
    expect(toolSurface.chars).toBeGreaterThan(0);
    expect(total.chars).toBe(system.chars + brief.chars + toolSurface.chars);
    expect(total.tokens).toBe(system.tokens + brief.tokens + toolSurface.tokens);
    // The Brief priced is the project Brief a real ticketless start composes.
    expect(brief.chars).toBeGreaterThan(
      composeProjectBrief({ project: { path: "/repo/volli" } }).length,
    );
    expect(data["excluded"]).toBe(
      "tool definitions, the user's first message, and provider overhead",
    );
  });

  it("a null index is a real, smaller baseline — no resources section at all", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo/volli", ticketPrefix: "VC" }));
    const response = await baselineService({ skillsIndex: async () => null })({
      project: "/repo/volli",
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("expected success");
    const sections = (response.data as Record<string, unknown>)["sections"] as { id: string }[];
    expect(sections.map((section) => section.id)).toEqual([
      "operating",
      "role",
      "authority",
      "workspace",
      "brief",
      "reminder:session-tools",
    ]);
  });

  it("--ticket prices a Ticket Session in its stamped worktree, Brief included", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo/volli", ticketPrefix: "VC" }));
    insertTicket(
      ctx.db,
      testTicket("p1", {
        id: "t1",
        ticketNumber: 12,
        title: "Ship CLI",
        worktreePath: "/worktrees/VC-12-ship-cli",
        branch: "volli/VC-12-ship-cli",
      }),
    );
    const response = await baselineService()({ ticket: "VC-12" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error("expected success");
    const data = response.data as Record<string, unknown>;
    expect(data["role"]).toBe("ticket");
    expect(data["workspace"]).toBe("/worktrees/VC-12-ship-cli");
    const sections = (data["sections"] as { id: string }[]).map((section) => section.id);
    expect(sections).toContain("resource:skills index");
    expect(sections).toContain("brief");
  });

  it("prices the Turn Reminder a fresh checkout earns, cache class and all", async () => {
    // A real fresh checkout on disk: a manifest and a lockfile, no
    // `node_modules`, and a repository boundary so the ancestor walk stops where
    // a real one would. The environment fact left the system prompt (VC-164)
    // but is still delivered, so the breakdown has to find it.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "volli-baseline-")));
    try {
      mkdirSync(join(base, ".git"));
      writeFileSync(join(base, "package.json"), "{}");
      writeFileSync(join(base, "pnpm-lock.yaml"), "");
      ctx = openTestDb();
      insertProject(ctx.db, testProject({ id: "p1", path: base, ticketPrefix: "VC" }));
      const response = await baselineService()({ project: base });
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("expected success");
      const data = response.data as Record<string, unknown>;
      const sections = data["sections"] as { id: string; cacheClass: string; placement: string }[];
      const reminder = sections.find((section) => section.id === "reminder:workspace-environment");
      expect(reminder).toMatchObject({ cacheClass: "session-static", placement: "message" });
      const measured = data["reminder"] as { chars: number; tokens: number };
      expect(measured.chars).toBeGreaterThan(0);
      const system = data["system"] as { chars: number };
      const brief = data["brief"] as { chars: number };
      const toolSurface = data["toolSurface"] as { chars: number };
      const total = data["total"] as { chars: number };
      expect(total.chars).toBe(system.chars + brief.chars + measured.chars + toolSurface.chars);
      // No prompt layer went with it: the reminder is bytes the prompt shed.
      expect(sections.map((section) => section.id)).not.toContain("environment");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses an unknown ticket the way every ticket verb does", async () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "p1", path: "/repo/volli", ticketPrefix: "VC" }));
    const response = await baselineService()({ ticket: "VC-99" });
    expect(response).toMatchObject({ ok: false, error: { code: "TICKET_NOT_FOUND" } });
  });
});

describe("composeProjectBrief", () => {
  it("names the ticketless Session, its project root, and the one CLI instruction", () => {
    expect(composeProjectBrief({ project: { path: "/code/volli" } })).toMatchInlineSnapshot(`
        "This is a project-scoped chat Session with no Ticket. Your working directory is the project root at /code/volli.

        Board coordination goes through the bundled \`volli\` CLI. Run \`volli help\` when you need its reference (and the volli skill, when installed, for norms)."
      `);
  });

  it("is deterministic for one project", () => {
    const project = { path: "/code/volli" };
    expect(composeProjectBrief({ project })).toBe(composeProjectBrief({ project }));
  });
});

describe("model.list", () => {
  /**
   * The door under test with the seam faked out: `model.list` owns the bounded
   * read, the signed-in filter, and the default report; the snapshot itself is
   * `inspectPiModelAccess`'s contract, tested beside it in agent-runtime.
   */
  function modelListHarness(
    overrides: {
      snapshot?: ModelAccessSnapshot;
      inspect?: AgentCommandServiceOptions["inspectModelAccess"];
      withoutSeam?: boolean;
      timeoutMs?: number;
    } = {},
  ) {
    ctx = openTestDb();
    const snapshot: ModelAccessSnapshot = overrides.snapshot ?? {
      observedAt: 900,
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          state: "available",
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
          signIn: [],
          hasStoredCredential: true,
        },
        {
          id: "openai-codex",
          label: "OpenAI Codex",
          state: "authentication-required",
          accountLabel: null,
          billingSource: "unknown",
          recovery: { kind: "sign-in" },
          signIn: [],
          hasStoredCredential: false,
        },
      ],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus-5",
          label: "Claude Opus 5",
          state: "available",
          reasoningLevels: ["low", "medium", "high"],
          acceptsImageInput: true,
        },
        {
          providerId: "anthropic",
          modelId: "claude-legacy",
          label: "Claude Legacy",
          state: "unavailable",
          reasoningLevels: ["off"],
          acceptsImageInput: true,
        },
        {
          providerId: "openai-codex",
          modelId: "gpt-5.6-terra",
          label: "Terra",
          state: "authentication-required",
          reasoningLevels: ["medium", "high", "xhigh"],
          acceptsImageInput: true,
        },
      ],
    };
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
      ...(overrides.withoutSeam
        ? {}
        : { inspectModelAccess: overrides.inspect ?? (async () => snapshot) }),
      ...(overrides.timeoutMs !== undefined ? { modelAccessTimeoutMs: overrides.timeoutMs } : {}),
    });
    const execute = (args: Record<string, unknown> = {}) =>
      service.execute({ v: 1, cmd: "model.list", args, ctx: { cwd: "/outside", env: ACTING_ENV } });
    return { execute };
  }

  it("lists the signed-in slice by default, with copyable ids and an honest omission count", async () => {
    const harness = modelListHarness();

    const response = await harness.execute();

    expect(response).toEqual({
      v: 1,
      ok: true,
      data: {
        observedAt: 900,
        default: null,
        providers: [
          {
            id: "anthropic",
            label: "Anthropic",
            state: "available",
            models: [
              {
                model: "anthropic/claude-opus-5",
                label: "Claude Opus 5",
                state: "available",
                reasoning: ["low", "medium", "high"],
              },
            ],
            // claude-legacy is unavailable, so the default view withholds it
            // — and says so, the same honesty the provider rollup has.
            omittedModels: 1,
          },
        ],
        omittedProviders: 1,
      },
    });
  });

  it("never leaks credential-adjacent snapshot fields, filtered or not", async () => {
    const harness = modelListHarness();

    for (const args of [{}, { all: true }]) {
      const rendered = JSON.stringify(await harness.execute(args));
      // The provider rows drop everything but identity/state/catalog — the
      // credential-adjacent fields (stored-credential flags, billing, sign-in
      // methods) stay behind the app's own surfaces.
      expect(rendered).not.toContain("hasStoredCredential");
      expect(rendered).not.toContain("billingSource");
      expect(rendered).not.toContain("signIn");
      expect(rendered).not.toContain("accountLabel");
    }
  });

  it("shows the whole registered catalog behind --all", async () => {
    const harness = modelListHarness();

    const response = await harness.execute({ all: true });

    expect(response).toMatchObject({
      ok: true,
      data: {
        omittedProviders: 0,
        providers: [
          {
            id: "anthropic",
            omittedModels: 0,
            models: [
              { model: "anthropic/claude-opus-5" },
              { model: "anthropic/claude-legacy", state: "unavailable" },
            ],
          },
          {
            id: "openai-codex",
            state: "authentication-required",
            omittedModels: 0,
            models: [
              {
                model: "openai-codex/gpt-5.6-terra",
                state: "authentication-required",
                reasoning: ["medium", "high", "xhigh"],
              },
            ],
          },
        ],
      },
    });
  });

  it("reports the configured app default alongside the catalog", async () => {
    // Only the project default is configured, and `session start` starts a
    // Ticket Session — so what it reports is the ticket purpose resolving to
    // the project default it inherits (VC-53), not a second stored value.
    const harness = modelListHarness();
    writeModelAccessDefault(
      ctx.db,
      "global",
      { providerId: "anthropic", modelId: "claude-opus-5", reasoningLevel: "medium" },
      500,
    );

    const response = await harness.execute();

    expect(response).toMatchObject({
      ok: true,
      data: { default: { model: "anthropic/claude-opus-5", reasoning: "medium" } },
    });
  });

  it("reports the Ticket default once one is chosen, not the project default", async () => {
    // `volli session start` is a Ticket Session, so the model it will run is
    // the execution default — reporting the orchestration one would name a
    // model this command is never going to use.
    const harness = modelListHarness();
    writeModelAccessDefault(
      ctx.db,
      "global",
      { providerId: "anthropic", modelId: "claude-opus-5", reasoningLevel: "medium" },
      500,
    );
    writeModelAccessDefault(
      ctx.db,
      "ticket",
      { providerId: "openai-codex", modelId: "gpt-5.6-terra", reasoningLevel: "high" },
      501,
    );

    const response = await harness.execute();

    expect(response).toMatchObject({
      ok: true,
      data: { default: { model: "openai-codex/gpt-5.6-terra", reasoning: "high" } },
    });
  });

  it("answers APP_UNREACHABLE when the Pi runtime never came up this launch", async () => {
    const harness = modelListHarness({ withoutSeam: true });
    expect(await harness.execute()).toMatchObject({
      ok: false,
      error: { code: "APP_UNREACHABLE" },
    });
  });

  it("bounds a hung provider probe: aborts the inspect and answers TIMEOUT (VC-61 direction)", async () => {
    let observedSignal: AbortSignal | undefined;
    const harness = modelListHarness({
      timeoutMs: 20,
      // A probe that ignores its signal entirely — the race, not the abort, is
      // what must keep the verb from hanging.
      inspect: ({ signal }) => {
        observedSignal = signal;
        return new Promise<never>(() => {});
      },
    });

    const response = await harness.execute();

    expect(response).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("names an inspect that fails outright before the bound", async () => {
    const harness = modelListHarness({
      inspect: async () => {
        throw new Error("provider store unreadable");
      },
    });

    expect(await harness.execute()).toMatchObject({
      ok: false,
      error: { code: "MUTATION_FAILED", message: "provider store unreadable" },
    });
  });
});

/**
 * What the socket still answers ABOUT a Session it did not start (VC-163).
 *
 * `session.start` left this door entirely: it is control tier now, a named tool
 * in the `project` Role's bundle, and the application act it shares with that
 * tool is tested in `session-runtime/start-session.test.ts`. These two are what
 * remained here, because neither was ever about starting one — they are a read
 * of a Session's public handle and a read of the Session list.
 */
describe("reads over a session the socket did not start", () => {
  const startedSessionId = "abcdef12-3456-7890-abcd-ef1234567890";

  it("shortens the session id a session_started event cites in the public feed", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
    });
    recordTicketEvent(
      ctx.db,
      "ticket-one",
      { kind: "session_started", sessionId: startedSessionId },
      900,
      { kind: "user" },
    );

    const events = await service.execute({
      v: 1,
      cmd: "ticket.events",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(events).toMatchObject({
      ok: true,
      data: { events: [{ payload: { kind: "session_started", session: "abcdef12" } }] },
    });
    expect(JSON.stringify(events)).not.toContain(startedSessionId);
  });

  it("lists a chat session, scoped to its ticket", async () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "project-one", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("project-one", { id: "ticket-one", ticketNumber: 1 }));
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now: () => 900 });
    const structured = await sessionEngine.createSession({
      commandId: "structured-create",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: {
        source: { kind: "user", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now: () => 1_000,
      sessionEngine,
    });

    const listed = await service.execute({
      v: 1,
      cmd: "session.list",
      args: { ticket: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    expect(listed).toMatchObject({
      ok: true,
      data: {
        sessions: [
          {
            id: structured.session.id.slice(0, 8),
            kind: "chat",
            ticket: "VC-1",
            title: "Chat",
            ageMs: 100,
          },
        ],
      },
    });
  });
});

describe("worktree scope, told honestly to the agent (VC-98)", () => {
  function projectFixture(): void {
    insertProject(
      ctx.db,
      testProject({
        id: "project-one",
        name: "Volli Code",
        path: "/repo/volli",
        ticketPrefix: "VC",
      }),
    );
  }

  it("tells a worktree-scoped ticket that one is coming, not to move the board", async () => {
    ctx = openTestDb();
    projectFixture();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, usesWorktree: true }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.0.0", git });

    const res = await service.execute({
      v: 1,
      cmd: "worktree.status",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    // The old sentence ("Move it to Doing to create one") sent agents to do
    // something that has never materialized a worktree; VC-81's agent moved
    // the ticket, saw nothing appear, and carried on in the main checkout.
    expect(res).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    if (res.ok) throw new Error("expected a refusal");
    expect(res.error.message).toBe(
      "Ticket VC-1 has no worktree yet. One is created when a session starts for it.",
    );
    expect(res.error.message).not.toContain("Doing");
  });

  it("tells a main-checkout ticket that no worktree is coming at all", async () => {
    ctx = openTestDb();
    projectFixture();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, usesWorktree: false }),
    );
    const { git } = scriptedGit(() => "");
    const service = createAgentCommandService({ db: ctx.db, appVersion: "1.0.0", git });

    const res = await service.execute({
      v: 1,
      cmd: "worktree.diff",
      args: { id: "VC-1" },
      ctx: { cwd: "/repo/volli", env: ACTING_ENV },
    });

    if (res.ok) throw new Error("expected a refusal");
    expect(res.error.message).toBe(
      "Ticket VC-1 runs in the project's main checkout, so it has no worktree.",
    );
  });

  it("warns a session working outside its ticket's worktree", async () => {
    ctx = openTestDb();
    projectFixture();
    insertTicket(
      ctx.db,
      testTicket("project-one", {
        id: "ticket-one",
        ticketNumber: 1,
        usesWorktree: true,
        worktreePath: "/wt/VC-1",
      }),
    );
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const created = await sessionEngine.createSession({
      commandId: "create-structured",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const service = createAgentCommandService({ db: ctx.db, sessionEngine, appVersion: "1.0.0" });

    // The VC-81 shape: a Session that attached before the worktree existed, so
    // it is still bound to the main checkout while the ticket claims isolation.
    const res = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: asSession(created.session.id) },
    });

    expect(res).toMatchObject({
      ok: true,
      data: {
        warning:
          "You are working in /repo/volli, which is outside VC-1's worktree at /wt/VC-1. Move your work there before continuing.",
      },
    });
  });

  it("stops warning once the agent has moved into the worktree", async () => {
    ctx = openTestDb();
    projectFixture();
    insertTicket(
      ctx.db,
      testTicket("project-one", {
        id: "ticket-one",
        ticketNumber: 1,
        usesWorktree: true,
        worktreePath: "/wt/VC-1",
      }),
    );
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const created = await sessionEngine.createSession({
      commandId: "create-structured",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const service = createAgentCommandService({ db: ctx.db, sessionEngine, appVersion: "1.0.0" });

    // Recomputed from the caller's cwd every time rather than stored, so an
    // agent that migrates its own work clears the warning by doing so — there
    // is no flag left behind to go stale, and nothing here can track a cwd the
    // agent drives through bash.
    const res = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/wt/VC-1/packages/shared", env: asSession(created.session.id) },
    });

    if (!res.ok) throw new Error("expected identify to succeed");
    expect(res.data).not.toHaveProperty("warning");
  });

  it("never warns a ticket that has no worktree to be outside of", async () => {
    ctx = openTestDb();
    projectFixture();
    insertTicket(
      ctx.db,
      testTicket("project-one", { id: "ticket-one", ticketNumber: 1, usesWorktree: false }),
    );
    const sessionEngine = createDesktopSessionEngine(ctx.db);
    const created = await sessionEngine.createSession({
      commandId: "create-structured",
      projectId: "project-one",
      ticketId: "ticket-one",
      title: null,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const service = createAgentCommandService({ db: ctx.db, sessionEngine, appVersion: "1.0.0" });

    const res = await service.execute({
      v: 1,
      cmd: "identify",
      args: {},
      ctx: { cwd: "/repo/volli", env: asSession(created.session.id) },
    });

    if (!res.ok) throw new Error("expected identify to succeed");
    expect(res.data).not.toHaveProperty("warning");
  });
});

/**
 * `volli cost` — the read-tier rollup (VC-87).
 *
 * The cases below are the sentences the verb must never print, not a tour of
 * its options: an unmeasured Session read as free, a deleted Ticket's bill
 * silently rehomed, an upgraded profile's short history read as its whole
 * history, and a window whose lower bound was pinned by the wrong clock.
 */
/** One metered operation, priced by a catalogue like most real ones are. */
function metered(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    cause: "assistant",
    providerId: "anthropic",
    modelId: "claude-opus-4-1",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    costUsd: 0.25,
    costBasis: "catalog-estimate",
    ...over,
  };
}

describe("volli cost", () => {
  const provenance = {
    source: { kind: "system" as const, id: "test", detail: null },
    venue: { id: "local", kind: "local" as const },
  };

  async function seeded(now: () => number = () => 10_000) {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "p1", name: "Volli Code", path: "/repo/volli", ticketPrefix: "VC" }),
    );
    insertTicket(ctx.db, testTicket("p1", { id: "t1", ticketNumber: 1, usesWorktree: false }));
    const sessionEngine = createDesktopSessionEngine(ctx.db, { now });
    const service = createAgentCommandService({
      db: ctx.db,
      appVersion: "1.2.3",
      now,
      sessionEngine,
    });
    const execute = (args: Record<string, unknown>) =>
      service.execute({ v: 1, cmd: "cost", args, ctx: { cwd: "/repo/volli", env: ACTING_ENV } });
    return { sessionEngine, execute };
  }

  async function meteredSession(
    sessionEngine: SessionEngine,
    options: { commandId: string; ticketId: string | null },
  ): Promise<string> {
    const created = await sessionEngine.createSession({
      commandId: options.commandId,
      projectId: "p1",
      ticketId: options.ticketId,
      title: options.commandId,
      provenance,
    });
    return created.session.id;
  }

  async function record(
    sessionEngine: SessionEngine,
    sessionId: string,
    id: string,
    occurredAt: number,
    usage: SessionUsage,
  ): Promise<void> {
    await sessionEngine.observe({
      id,
      kind: "usage.recorded",
      sessionId,
      occurredAt,
      provenance,
      attachmentId: null,
      turnId: null,
      usage,
    });
  }

  it("reports a project's spend with its token classes kept apart", async () => {
    const { sessionEngine, execute } = await seeded();
    const sessionId = await meteredSession(sessionEngine, { commandId: "s1", ticketId: "t1" });
    await record(sessionEngine, sessionId, "u1", 1_000, metered({ costUsd: 0.25 }));
    await record(sessionEngine, sessionId, "u2", 2_000, metered({ costUsd: 0.75 }));

    const result = await execute({});

    expect(result).toMatchObject({
      ok: true,
      data: {
        scope: "project Volli Code",
        since: null,
        costUsd: 1,
        costBasis: "catalog-estimate",
        costCoverage: "complete",
        // Non-overlapping: 200 uncached input, 800 cache read, 20 output.
        inputTokens: 200,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        outputTokens: 20,
        totalTokens: 1_020,
        cachedInputShare: 0.8,
        requestCount: 2,
        pricedRequestCount: 2,
        meteredSessionCount: 1,
        coverage: "complete",
        groups: [],
      },
    });
  });

  it("keeps an unpriced operation's cost null rather than reporting it as free", async () => {
    const { sessionEngine, execute } = await seeded();
    const sessionId = await meteredSession(sessionEngine, { commandId: "s1", ticketId: null });
    await record(
      sessionEngine,
      sessionId,
      "u1",
      1_000,
      metered({ costUsd: null, costBasis: "unavailable" }),
    );

    const result = await execute({});

    expect(result).toMatchObject({
      ok: true,
      data: { costUsd: null, costCoverage: "unavailable", requestCount: 1, pricedRequestCount: 0 },
    });
  });

  it("scopes to a ticket by display id and breaks it down by session", async () => {
    const { sessionEngine, execute } = await seeded();
    const onTicket = await meteredSession(sessionEngine, { commandId: "s1", ticketId: "t1" });
    const elsewhere = await meteredSession(sessionEngine, { commandId: "s2", ticketId: null });
    await record(sessionEngine, onTicket, "u1", 1_000, metered({ costUsd: 2 }));
    await record(sessionEngine, elsewhere, "u2", 1_000, metered({ costUsd: 9 }));

    const result = await execute({ ticket: "VC-1", groupBy: "session" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        scope: "ticket VC-1",
        costUsd: 2,
        groups: [
          {
            groupBy: "session",
            key: onTicket.slice(0, 8),
            label: onTicket.slice(0, 8),
            costUsd: 2,
          },
        ],
      },
    });
    // The full UUID is never a public handle, on this door like every other.
    expect(JSON.stringify(result)).not.toContain(onTicket);
  });

  it("labels a by-ticket group with its display id, and unticketed spend as null", async () => {
    const { sessionEngine, execute } = await seeded();
    const onTicket = await meteredSession(sessionEngine, { commandId: "s1", ticketId: "t1" });
    const projectSession = await meteredSession(sessionEngine, { commandId: "s2", ticketId: null });
    await record(sessionEngine, onTicket, "u1", 1_000, metered({ costUsd: 5 }));
    await record(sessionEngine, projectSession, "u2", 1_000, metered({ costUsd: 1 }));

    const result = await execute({ groupBy: "ticket" });

    expect(result).toMatchObject({
      ok: true,
      data: {
        groups: [
          { key: "VC-1", label: "VC-1", costUsd: 5 },
          // A real group, not an absence: dropping it would make the rows add
          // up to less than the total above them.
          { key: null, label: null, costUsd: 1 },
        ],
      },
    });
  });

  it("resolves --since against the handler's clock, not the caller's", async () => {
    const { sessionEngine, execute } = await seeded(() => 10_000);
    const sessionId = await meteredSession(sessionEngine, { commandId: "s1", ticketId: null });
    await record(sessionEngine, sessionId, "old", 1_000, metered({ costUsd: 7 }));
    await record(sessionEngine, sessionId, "new", 9_000, metered({ costUsd: 3 }));

    // A 2-second look-back against now = 10_000 keeps only the 9_000 operation.
    const relative = await execute({ since: { kind: "duration", ms: 2_000 } });
    const absolute = await execute({ since: { kind: "instant", epochMs: 500 } });

    expect(relative).toMatchObject({ ok: true, data: { since: 8_000, costUsd: 3 } });
    expect(absolute).toMatchObject({ ok: true, data: { since: 500, costUsd: 10 } });
  });

  it("refuses a malformed since and an unknown grouping rather than guessing", async () => {
    const { execute } = await seeded();

    await expect(execute({ since: "last tuesday" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(execute({ groupBy: "provider" })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("refuses two scopes rather than silently picking one", async () => {
    const { execute } = await seeded();

    await expect(execute({ ticket: "VC-1", allProjects: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("keeps a deleted Ticket's spend on that Ticket", async () => {
    const { sessionEngine, execute } = await seeded();
    const sessionId = await meteredSession(sessionEngine, { commandId: "s1", ticketId: "t1" });
    await record(sessionEngine, sessionId, "u1", 1_000, metered({ costUsd: 4 }));

    ctx.db.prepare("DELETE FROM tickets WHERE id = ?").run("t1");

    // The money is still counted — attribution is frozen in the fact — and it
    // is named as spend on something gone rather than as unticketed spend or
    // as an internal id no caller could use.
    const result = await execute({ groupBy: "ticket" });
    expect(result).toMatchObject({
      ok: true,
      data: { costUsd: 4, groups: [{ key: null, label: "(deleted ticket)", costUsd: 4 }] },
    });
    expect(JSON.stringify(result)).not.toContain("t1");
  });

  it("says partial when the window reaches behind what this profile has metered", async () => {
    const { execute } = await seeded();
    ctx.db.prepare("UPDATE session_usage_coverage SET metered_from = 5_000 WHERE id = 1").run();

    const lifetime = await execute({});
    const recent = await execute({ since: { kind: "instant", epochMs: 6_000 } });

    expect(lifetime).toMatchObject({
      ok: true,
      data: { coverage: "partial", meteredFrom: 5_000 },
    });
    expect(recent).toMatchObject({ ok: true, data: { coverage: "complete", meteredFrom: 5_000 } });
  });
});

/**
 * The agent door feeds the ticket wake bus (VC-85 slice C).
 *
 * The half that matters most for orchestration: a delegated Session's verdict
 * is exactly what an orchestrator parked on `ticket.await` is waiting for, and
 * it arrives through this door.
 */
describe("the ticket wake bus", () => {
  const unsubscribes: Array<() => void> = [];

  afterEach(() => {
    for (const off of unsubscribes.splice(0)) off();
  });

  it("wakes on every committed ticket fact the socket writes", async () => {
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
    const sessionId = "abcdef12-3456-7890-abcd-ef1234567890";
    const request = (cmd: AgentRequest["cmd"], args: Record<string, unknown>, session?: string) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: {
          cwd: "/repo/volli",
          env: session ? asSession(session, { ticket: "VC-1" }) : ACTING_ENV,
        },
      });

    const seen: TicketWake[] = [];
    unsubscribes.push(subscribeTicketWake((wake) => seen.push(wake)));

    await request("ticket.create", { title: "Ship CLI" });
    insertSession(
      ctx.db,
      testSession("project-one", "ticket-one", { id: sessionId, cwd: "/repo/volli" }),
    );
    await request("ticket.move", { id: "VC-1", to: "doing" }, sessionId);
    await request("ticket.comment", { id: "VC-1", message: "Working" }, sessionId);
    await request("ticket.signal", { id: "VC-1", kind: "review", verdict: "pass" }, sessionId);
    // A read wakes nobody, and neither does a move to the column it is in.
    await request("ticket.show", { id: "VC-1" });
    await request("ticket.move", { id: "VC-1", to: "doing" }, sessionId);

    expect(seen.map((wake) => wake.event.payload.kind)).toEqual([
      "created",
      "status_changed",
      "commented",
      "signaled",
    ]);
    expect(seen.every((wake) => wake.projectId === "project-one")).toBe(true);
    // The verdict travels whole, so a waiter can decide without a second read.
    expect(seen[3]?.event.payload).toMatchObject({
      kind: "signaled",
      signalKind: "review",
      verdict: "pass",
    });
  });
});
