import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentCommand, AgentResponse, SessionOrigin, SessionRole } from "@volli/shared";
import { createAgentCommandService } from "../agent-commands";
import { insertProject } from "@volli/host-core/db/projects-repo";
import { insertTicket } from "@volli/host-core/db/tickets-repo";
import { recordSessionResumedOnce, recordTicketEvent } from "@volli/host-core/db/events-repo";
import {
  openTestDb,
  testProject,
  testSession,
  testTicket,
  type TestDb,
} from "@volli/host-core/db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import { insertSession } from "@volli/host-core/session-control/test-support";

let db: TestDb;
afterEach(() => db?.cleanup());
const DAY = 86400000;
const provenance = {
  source: { kind: "user" as const, id: "test", detail: null },
  venue: { id: "local" as const, kind: "local" as const },
};
function data(response: AgentResponse): Record<string, unknown> {
  expect(response.ok).toBe(true);
  if (!response.ok) throw new Error(response.error.message);
  return response.data as Record<string, unknown>;
}
function fixture(observeTerminal = false) {
  db = openTestDb();
  insertProject(
    db.db,
    testProject({ id: "p", name: "Volli", path: "/repo/volli", ticketPrefix: "VC" }),
  );
  insertProject(
    db.db,
    testProject({ id: "other", name: "Other", path: "/repo/other", ticketPrefix: "OTHER" }),
  );
  insertTicket(db.db, testTicket("p", { id: "ticket", ticketNumber: 12 }));
  let clock = 1;
  let nextId = 0;
  const engine = createTestSessionEngine(db.db, {
    now: () => clock,
    nextId: () => `${(++nextId).toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
  });
  const service = createAgentCommandService({
    busyWorktreeSites: async () => [],
    db: db.db,
    appVersion: "test",
    sessionEngine: engine,
    now: () => 10 * DAY,
    ...(observeTerminal
      ? { observeSession: () => ({ status: "working" as const, output: "$ " }) }
      : {}),
  });
  const read = (cmd: AgentCommand, args: Record<string, unknown> = {}) =>
    service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
  const create = async (
    title: string,
    at: number,
    extra: {
      role?: SessionRole;
      parentSessionId?: string;
      ticketId?: string;
      projectId?: string;
    } = {},
  ) => {
    clock = Math.round(at);
    return (
      await engine.createSession({
        commandId: `create-${title}`,
        projectId: extra.projectId ?? "p",
        ticketId: extra.ticketId ?? null,
        role: extra.role ?? (extra.ticketId ? "ticket" : "project"),
        parentSessionId: extra.parentSessionId ?? null,
        title,
        provenance,
      })
    ).session.id;
  };
  const active = async (id: string, at: number, waiting = false) => {
    await engine.observe({
      id: `attach-${id}`,
      kind: "attachment.opened",
      sessionId: id,
      occurredAt: at,
      provenance,
      attachment: {
        id: `attachment-${id}`,
        sessionId: id,
        adapterId: "pi",
        venue: { id: "local", kind: "local" },
        continuity: "fresh",
        native: { id: "test", detail: null },
        authority: null,
      },
    });
    await engine.observe({
      id: `turn-${id}`,
      kind: "turn.started",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: at,
      provenance,
      turnId: `turn-${id}`,
    });
    if (waiting)
      await engine.observe({
        id: `attention-${id}`,
        kind: "attention.raised",
        sessionId: id,
        attachmentId: `attachment-${id}`,
        occurredAt: at,
        provenance,
        attention: {
          id: `attention-${id}`,
          kind: "permission_required",
          attachmentId: `attachment-${id}`,
          detail: null,
          diagnostic: null,
        },
      });
  };
  const ids = (response: AgentResponse) =>
    (data(response)["sessions"] as { id: string }[]).map((s) => s.id);
  return { engine, read, create, active, ids };
}

describe("session roster and detail", () => {
  it("defaults to active plus 24h activity, sorts by latest activity, and composes all/state/since/scope", async () => {
    const { read, create, active, ids } = fixture();
    const old = await create("old", DAY);
    const recent = await create("recent", 9.5 * DAY);
    const boundary = await create("boundary", 9 * DAY);
    const working = await create("working", DAY);
    await active(working, 2 * DAY);
    const waiting = await create("waiting", DAY);
    await active(waiting, 2.5 * DAY, true);
    await create("other", 9.8 * DAY, { projectId: "other" });
    const ticket = await create("ticket", 8 * DAY, { ticketId: "ticket" });
    insertSession(
      db.db,
      testSession("p", null, {
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        createdAt: DAY,
        lastActivityAt: DAY,
      }),
    );
    insertSession(db.db, {
      ...testSession("p", null, { id: "bbbbbbbb-0000-4000-8000-000000000001", createdAt: DAY }),
      endedAt: 2 * DAY,
    });
    const defaultRows = await read("session.list");
    expect(ids(defaultRows)).toEqual([
      recent.slice(0, 8),
      boundary.slice(0, 8),
      waiting.slice(0, 8),
      working.slice(0, 8),
      "aaaaaaaa",
    ]);
    expect(data(defaultRows)["hidden"]).toBe(3);
    expect(ids(await read("session.list", { all: true }))).toHaveLength(8);
    expect(ids(await read("session.list", { state: ["idle"] }))).toEqual([
      recent.slice(0, 8),
      boundary.slice(0, 8),
    ]);
    expect(ids(await read("session.list", { all: true, state: ["idle", "exited"] }))).toEqual([
      recent.slice(0, 8),
      boundary.slice(0, 8),
      ticket.slice(0, 8),
      "bbbbbbbb",
      old.slice(0, 8),
    ]);
    expect(
      ids(
        await read("session.list", { since: { kind: "duration", ms: 3 * DAY }, state: ["idle"] }),
      ),
    ).toContain(ticket.slice(0, 8));
    expect(
      ids(
        await read("session.list", {
          since: { kind: "instant", epochMs: 9.75 * DAY },
          state: ["idle"],
        }),
      ),
    ).toEqual([]);
    expect(
      ids(
        await read("session.list", {
          ticket: "VC-12",
          all: true,
          state: ["idle"],
          since: { kind: "duration", ms: DAY },
        }),
      ),
    ).toEqual([ticket.slice(0, 8)]);
    expect(ids(await read("session.list", { project: "Other" }))).toHaveLength(1);
    expect(await read("session.list", { project: "Other", ticket: "VC-12" })).toMatchObject({
      ok: false,
      error: { code: "CONTEXT_MISMATCH" },
    });
    for (const args of [
      { state: ["parked"] },
      { state: [] },
      { state: "idle" },
      { since: "7d" },
      { since: { kind: "duration", ms: -1 } },
    ]) {
      expect(await read("session.list", args)).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
  });

  it("computes pending delegated children before filtering and shares them with peek/show", async () => {
    const { read, create, active } = fixture();
    // Older than the default window, but active through its children.
    const parent = await create("parent", DAY, { ticketId: "ticket" });
    const late = await create("late", 2 * DAY, {
      role: "subagent",
      parentSessionId: parent,
      ticketId: "ticket",
    });
    const early = await create("early", DAY, {
      role: "subagent",
      parentSessionId: parent,
      ticketId: "ticket",
    });
    await active(late, 2 * DAY, true);
    await active(early, 2 * DAY);
    await create("idle child", DAY, {
      role: "subagent",
      parentSessionId: parent,
      ticketId: "ticket",
    });
    const started = await create("started", DAY, { ticketId: "ticket" });
    await active(started, 2 * DAY);
    recordTicketEvent(db.db, "ticket", { kind: "session_started", sessionId: started }, DAY, {
      kind: "session",
      sessionId: parent,
      ticketId: "ticket",
    });
    const handle = parent.slice(0, 8);
    expect(data(await read("session.list"))["sessions"]).toContainEqual(
      expect.objectContaining({ id: handle }),
    );
    expect(data(await read("session.list", { state: ["idle"], ticket: "VC-12" }))).toMatchObject({
      sessions: [{ id: handle, pendingSubagents: [early.slice(0, 8), late.slice(0, 8)] }],
      hidden: 1,
    });
    expect(data(await read("session.peek", { id: handle }))).toMatchObject({
      status: "idle",
      pendingSubagents: [early.slice(0, 8), late.slice(0, 8)],
    });
    expect(data(await read("session.show", { id: handle }))).toMatchObject({
      id: handle,
      role: "ticket",
      ticket: "VC-12",
      project: "Volli",
      startedBy: { kind: "user" },
      parentSession: null,
      pendingSubagents: [early.slice(0, 8), late.slice(0, 8)],
      children: expect.arrayContaining([
        { id: early.slice(0, 8), title: "early", role: "subagent", status: "working" },
        { id: started.slice(0, 8), title: "started", role: "ticket", status: "working" },
      ]),
      model: null,
      costUsd: null,
      tokens: 0,
    });
    expect(data(await read("session.show", { id: early.slice(0, 8) }))).toMatchObject({
      parentSession: { id: handle, title: "parent" },
      status: "working",
    });
    expect(data(await read("session.show", { id: started.slice(0, 8) }))).toMatchObject({
      startedBy: { kind: "session", parentSessionId: handle, parentTitle: "parent" },
    });
    const json = JSON.stringify(data(await read("session.show", { id: handle })));
    expect(json).not.toContain(parent);
    expect(json).not.toContain(early);
    const event = data(await read("ticket.events", { id: "VC-12" }))["events"] as {
      payload: unknown;
    }[];
    expect(event).toContainEqual(
      expect.objectContaining({
        payload: { kind: "session_started", session: started.slice(0, 8) },
      }),
    );
    const malformed = "abcdef12-not-a-minted-id";
    recordTicketEvent(db.db, "ticket", { kind: "session_started", sessionId: malformed }, 2 * DAY);
    expect(data(await read("ticket.events", { id: "VC-12" }))["events"]).toContainEqual(
      expect.objectContaining({ payload: { kind: "session_started", session: malformed } }),
    );
  });

  it("retains ancient interrupted Sessions, hides ancient stopped ones, and shares state reasons/model/usage", async () => {
    const { engine, read, create, active, ids } = fixture();
    const interrupted = await create("interrupted", DAY);
    await engine.submit({
      commandId: "model",
      sessionId: interrupted,
      intent: {
        kind: "model.select",
        selection: { providerId: "anthropic", modelId: "haiku-4.5", reasoningLevel: "low" },
        tier: "fast",
      },
      provenance,
    });
    await active(interrupted, 2 * DAY);
    await engine.observe({
      id: "interrupted-attention",
      kind: "attention.raised",
      sessionId: interrupted,
      attachmentId: `attachment-${interrupted}`,
      occurredAt: 2 * DAY,
      provenance,
      attention: {
        id: "interrupted-attention",
        kind: "adapter_unrecoverable",
        attachmentId: `attachment-${interrupted}`,
        detail: null,
        diagnostic: null,
        resetsAt: null,
      },
    });
    await engine.observe({
      id: "interrupted-end",
      kind: "turn.interrupted",
      sessionId: interrupted,
      attachmentId: `attachment-${interrupted}`,
      occurredAt: 3 * DAY,
      provenance,
      turnId: `turn-${interrupted}`,
    });
    const stopped = await create("stopped", DAY);
    await engine.submit({
      commandId: "stop",
      sessionId: stopped,
      intent: { kind: "session.stop", reason: "Done", by: { kind: "user" } },
      provenance,
    });
    expect(ids(await read("session.list"))).toEqual([interrupted.slice(0, 8)]);
    expect(ids(await read("session.list", { all: true, state: ["stopped"] }))).toEqual([
      stopped.slice(0, 8),
    ]);
    const shown = data(await read("session.show", { id: interrupted.slice(0, 8) }));
    expect(shown).toMatchObject({
      status: "interrupted",
      interruptedReason: "stopped-by-runtime",
      model: "anthropic/haiku-4.5",
      reasoning: "low",
      tier: "fast",
      pendingSubagents: [],
    });
    const listed = (data(await read("session.list"))["sessions"] as Record<string, unknown>[])[0]!;
    const peeked = data(await read("session.peek", { id: interrupted.slice(0, 8) }));
    for (const field of [
      "status",
      "waitingOn",
      "interruptedReason",
      "pendingSubagents",
      "lastActivityAgeMs",
    ])
      expect(shown[field]).toEqual(peeked[field]);
    for (const field of [
      "model",
      "reasoning",
      "tier",
      "costUsd",
      "costBasis",
      "costCoverage",
      "tokens",
    ])
      expect(shown[field]).toEqual(listed[field]);
  });

  it("answers terminal metadata without needing a live observation and refuses like peek", async () => {
    const { read } = fixture();
    const id = "abcdef12-0000-4000-8000-000000000001";
    insertSession(db.db, {
      ...testSession("p", "ticket", { id, title: "Terminal", createdAt: DAY }),
      endedAt: 3 * DAY,
    });
    expect(data(await read("session.show", { id: "abcdef12" }))).toMatchObject({
      id: "abcdef12",
      title: "Terminal",
      status: "exited",
      ticket: "VC-12",
      project: "Volli",
      harness: "claude-code",
      ageMs: 9 * DAY,
      lastActivityAgeMs: 7 * DAY,
    });
    expect(await read("session.show", { id })).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
    });
    expect(await read("session.show", { id: "missing" })).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
    });
    expect(await read("session.show", {})).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    insertSession(db.db, testSession("p", null, { id: "abcdef12-0000-4000-8000-000000000002" }));
    expect(await read("session.show", { id: "abcdef12" })).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_CONTEXT" },
    });
  });
});

describe("who started and who resumed a Session", () => {
  const RUN = "3f2a1b2c-0000-4000-8000-00000000aaaa";
  const sessionRow = (response: AgentResponse, handle: string) =>
    (data(response)["sessions"] as Record<string, unknown>[]).find((row) => row["id"] === handle);

  /** One turn the way the runtime records it: the door's command, then the turn it opened. */
  async function turn(
    f: ReturnType<typeof fixture>,
    sessionId: string,
    turnId: string,
    origin: SessionOrigin | null,
  ) {
    await f.engine.submit({
      commandId: `message-${turnId}`,
      sessionId,
      intent: {
        kind: "message.submit",
        reference: { id: `reference-${turnId}`, mediaType: null, digest: null },
      },
      provenance: {
        source: {
          kind: "user",
          id: "test",
          detail: origin === null ? null : { sessionOrigin: origin },
        },
        venue: { id: "local", kind: "local" },
      },
    });
    const projection = (await f.engine.getSession({ sessionId }))!;
    await f.engine.observe({
      id: `turn-${turnId}`,
      kind: "turn.started",
      sessionId,
      attachmentId: projection.attachments.find((attachment) => attachment.status === "open")!.id,
      occurredAt: 9 * DAY,
      provenance,
      turnId,
    });
  }
  let attachmentNumber = 0;
  async function attach(
    f: ReturnType<typeof fixture>,
    sessionId: string,
    origin: SessionOrigin | null = null,
    attachmentId = `${(++attachmentNumber).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    adapterId = "pi",
  ) {
    const projection = (await f.engine.getSession({ sessionId }))!;
    const previous = projection.attachments.find((attachment) => attachment.status === "open");
    if (previous !== undefined) {
      await f.engine.observe({
        id: `close-${previous.id}`,
        sessionId,
        kind: "attachment.closed",
        occurredAt: 8 * DAY,
        provenance,
        attachmentId: previous.id,
        outcome: "interrupted",
      });
    }
    const commandId = `open-${attachmentId}`;
    await f.engine.submit({
      commandId,
      sessionId,
      intent: {
        kind: "executor.start",
        adapterId,
        continuity: previous === undefined ? "fresh" : "context_replay",
      },
      provenance: {
        ...provenance,
        source: {
          ...provenance.source,
          detail: origin === null ? null : { sessionOrigin: origin },
        },
      },
    });
    await f.engine.observe({
      id: `attach-${attachmentId}`,
      commandId,
      kind: "attachment.opened",
      sessionId,
      occurredAt: 9 * DAY,
      provenance,
      attachment: {
        id: attachmentId,
        sessionId,
        adapterId,
        venue: { id: "local", kind: "local" },
        continuity: previous === undefined ? "fresh" : "context_replay",
        native:
          adapterId === "terminal" ? (previous?.native ?? null) : { id: "test", detail: null },
        authority: null,
      },
    });
    return attachmentId;
  }
  let stops = 0;
  async function stop(f: ReturnType<typeof fixture>, sessionId: string) {
    await f.engine.submit({
      commandId: `stop-${sessionId}-${++stops}`,
      sessionId,
      intent: { kind: "session.stop", reason: null, by: { kind: "user" } },
      provenance,
    });
  }

  it("names an Automation's Run, a parent Session and a person on the list, peek and show", async () => {
    const f = fixture();
    const person = await f.create("person", 9.5 * DAY);
    const run = await f.create("run", 9.5 * DAY, { ticketId: "ticket" });
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_started",
        sessionId: run,
        origin: { kind: "automation", automationRunId: RUN, automationName: "Review" },
      },
      DAY,
      { kind: "automation" },
    );
    const parent = await f.create("Planner", 9.5 * DAY, { ticketId: "ticket" });
    const child = await f.create("child", 9.5 * DAY, { ticketId: "ticket" });
    recordTicketEvent(
      db.db,
      "ticket",
      { kind: "session_started", sessionId: child, origin: { kind: "session", sessionId: parent } },
      DAY,
      { kind: "session", sessionId: parent, ticketId: "ticket" },
    );

    const listed = await f.read("session.list");
    const automation = { kind: "automation", automationName: "Review", automationRunId: RUN };
    expect(sessionRow(listed, person.slice(0, 8))).toMatchObject({
      startedBy: { kind: "user" },
      latestTurn: null,
    });
    expect(sessionRow(listed, run.slice(0, 8))).toMatchObject({ startedBy: automation });
    // A list row stays compact: the parent's handle, not its title once per child.
    expect(sessionRow(listed, child.slice(0, 8))?.["startedBy"]).toEqual({
      kind: "session",
      parentSessionId: parent.slice(0, 8),
    });

    expect(data(await f.read("session.peek", { id: run.slice(0, 8) }))["startedBy"]).toEqual(
      automation,
    );
    expect(data(await f.read("session.show", { id: run.slice(0, 8) }))["startedBy"]).toEqual(
      automation,
    );
    expect(data(await f.read("session.show", { id: child.slice(0, 8) }))["startedBy"]).toEqual({
      kind: "session",
      parentSessionId: parent.slice(0, 8),
      parentTitle: "Planner",
    });
    // Terminal rows expose the same birth attribution as chat rows.
    const terminal = "abcdef12-0000-4000-8000-000000000001";
    insertSession(db.db, testSession("p", null, { id: terminal, createdAt: 9.5 * DAY }));
    expect(sessionRow(await f.read("session.list"), "abcdef12")).toHaveProperty("startedBy", {
      kind: "user",
    });
    expect(JSON.stringify(await f.read("session.list"))).not.toContain(parent);
  });

  it("separates a Session never resumed, one resumed by someone, and a turn no door attributed", async () => {
    const f = fixture();
    const parent = await f.create("Planner", 9.5 * DAY);
    const stopped = await f.create("stopped then resumed", 9.5 * DAY, { ticketId: "ticket" });
    const first = "11111111-0000-4000-8000-000000000001";
    const second = "22222222-0000-4000-8000-000000000002";
    const third = "33333333-0000-4000-8000-000000000003";
    const fourth = "44444444-0000-4000-8000-000000000004";
    await attach(f, stopped);
    await turn(f, stopped, first, { kind: "user" });
    await stop(f, stopped);
    await attach(f, stopped, { kind: "session", sessionId: parent }, second);
    await turn(f, stopped, second, { kind: "session", sessionId: parent });
    await stop(f, stopped);
    await attach(f, stopped, null, third);
    await turn(f, stopped, third, null);
    await stop(f, stopped);
    await attach(f, stopped, { kind: "volli", reason: "scheduled-resume" }, fourth);
    await turn(f, stopped, fourth, { kind: "volli", reason: "scheduled-resume" });

    const plain = await f.create("plain", 9.5 * DAY);
    await attach(f, plain);
    await turn(f, plain, "55555555-0000-4000-8000-000000000005", { kind: "user" });
    const fresh = await f.create("no turn yet", 9.5 * DAY);

    const listed = await f.read("session.list");
    expect(sessionRow(listed, stopped.slice(0, 8))?.["latestTurn"]).toEqual({
      origin: { kind: "volli", reason: "scheduled-resume" },
      resumedAfterStop: true,
    });
    expect(sessionRow(listed, plain.slice(0, 8))?.["latestTurn"]).toEqual({
      origin: { kind: "user" },
      resumedAfterStop: false,
    });
    expect(sessionRow(listed, fresh.slice(0, 8))?.["latestTurn"]).toBeNull();
    expect(data(await f.read("session.peek", { id: stopped.slice(0, 8) }))["latestTurn"]).toEqual({
      origin: { kind: "volli", reason: "scheduled-resume" },
      resumedAfterStop: true,
    });

    const shown = data(await f.read("session.show", { id: stopped.slice(0, 8) }));
    expect(shown["latestTurn"]).toEqual({
      origin: { kind: "volli", reason: "scheduled-resume" },
      resumedAfterStop: true,
    });
    // Oldest first and uncapped; the first turn was a start, not a resume. A
    // Session id travels as its public handle, a legacy turn as unknown.
    expect(shown["resumptions"]).toEqual([
      { attachment: "22222222", origin: { kind: "session", sessionId: parent.slice(0, 8) } },
      { attachment: "33333333", origin: null },
      { attachment: "44444444", origin: { kind: "volli", reason: "scheduled-resume" } },
    ]);
    expect(data(await f.read("session.show", { id: plain.slice(0, 8) }))).toMatchObject({
      latestTurn: { origin: { kind: "user" }, resumedAfterStop: false },
      resumptions: [],
    });
    expect(data(await f.read("session.show", { id: fresh.slice(0, 8) }))).toMatchObject({
      latestTurn: null,
      resumptions: [],
    });
    for (const full of [parent, stopped, first, second, third, fourth]) {
      for (const cmd of ["session.list", "session.show", "session.peek"] as const) {
        const args = cmd === "session.list" ? {} : { id: stopped.slice(0, 8) };
        expect(JSON.stringify(await f.read(cmd, args))).not.toContain(full);
      }
    }
  });

  it("attributes a chat reattachment before any turn and keeps the next sender separate", async () => {
    const f = fixture();
    const parent = await f.create("Planner", 9 * DAY);
    const child = await f.create("recovering", 9 * DAY, { ticketId: "ticket" });
    await attach(f, child, { kind: "session", sessionId: parent });
    await attach(f, child, { kind: "user" });
    const handle = child.slice(0, 8);
    for (const command of ["session.show", "session.peek"] as const) {
      expect(data(await f.read(command, { id: handle }))).toMatchObject({
        latestTurn: null,
        latestAttachment: { origin: { kind: "user" }, reattached: true },
      });
    }
    expect(sessionRow(await f.read("session.list"), handle)).toMatchObject({
      latestAttachment: { origin: { kind: "user" }, reattached: true },
    });
    await turn(f, child, "sender-turn", { kind: "session", sessionId: parent });
    expect(data(await f.read("session.peek", { id: handle }))).toMatchObject({
      latestTurn: {
        origin: { kind: "session", sessionId: parent.slice(0, 8) },
        resumedAfterStop: false,
      },
      latestAttachment: { origin: { kind: "user" }, reattached: true },
    });
  });

  it("exposes terminal birth and reattachment origins on list, peek, show and Ticket history", async () => {
    const f = fixture(true);
    const id = "abcdef12-0000-4000-8000-000000000001";
    insertSession(db.db, testSession("p", "ticket", { id, title: "Terminal", createdAt: DAY }));
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_started",
        sessionId: id,
        origin: { kind: "automation", automationRunId: RUN, automationName: "Review" },
      },
      DAY,
      { kind: "automation" },
    );
    const attachment = await attach(
      f,
      id,
      { kind: "user" },
      "87654321-0000-4000-8000-000000000001",
      "terminal",
    );
    const expected = {
      startedBy: { kind: "automation", automationRunId: RUN, automationName: "Review" },
      latestAttachment: { origin: { kind: "user" }, reattached: true },
      latestTurn: null,
    };
    expect(sessionRow(await f.read("session.list"), "abcdef12")).toMatchObject(expected);
    expect(data(await f.read("session.peek", { id: "abcdef12" }))).toMatchObject({
      ...expected,
      output: "$ ",
    });
    expect(data(await f.read("session.show", { id: "abcdef12" }))).toMatchObject({
      ...expected,
      resumptions: [{ attachment: "87654321", origin: { kind: "user" } }],
    });
    expect(recordSessionResumedOnce(db.db, (await f.engine.getSession({ sessionId: id }))!)).toBe(
      true,
    );
    expect(data(await f.read("ticket.events", { id: "VC-12" }))["events"]).toContainEqual(
      expect.objectContaining({
        payload: {
          kind: "session_resumed",
          session: "abcdef12",
          attachment: "87654321",
          origin: { kind: "user" },
        },
      }),
    );
    expect(JSON.stringify(await f.read("session.show", { id: "abcdef12" }))).not.toContain(
      attachment,
    );
  });

  it("carries the origin on ticket events under public handles, and never trusts a stored shape", async () => {
    const f = fixture();
    const parent = await f.create("Planner", 9.5 * DAY);
    const started = await f.create("started", 9.5 * DAY, { ticketId: "ticket" });
    const resumed = await f.create("resumed", 9.5 * DAY, { ticketId: "ticket" });
    await attach(f, resumed);
    await turn(f, resumed, "11111111-0000-4000-8000-000000000001", { kind: "user" });
    await stop(f, resumed);
    await attach(
      f,
      resumed,
      { kind: "session", sessionId: parent },
      "22222222-0000-4000-8000-000000000002",
    );
    await turn(f, resumed, "22222222-0000-4000-8000-000000000002", {
      kind: "session",
      sessionId: parent,
    });
    await stop(f, resumed);
    await attach(f, resumed, null, "33333333-0000-4000-8000-000000000003");
    await turn(f, resumed, "33333333-0000-4000-8000-000000000003", null);
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_started",
        sessionId: started,
        origin: { kind: "session", sessionId: parent },
      },
      DAY,
      { kind: "session", sessionId: parent, ticketId: "ticket" },
    );
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_started",
        sessionId: resumed,
        origin: { kind: "automation", automationRunId: RUN, automationName: "Review" },
      },
      DAY,
      { kind: "automation" },
    );
    // A stored origin this build cannot read is dropped from the wire rather
    // than passed through under the same key.
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_started",
        sessionId: parent,
        origin: { kind: "future-door" } as unknown as SessionOrigin,
      },
      2 * DAY,
    );
    const projection = await f.engine.getSession({ sessionId: resumed });
    expect(recordSessionResumedOnce(db.db, projection!)).toBe(true);
    recordTicketEvent(
      db.db,
      "ticket",
      {
        kind: "session_resumed",
        sessionId: "not-a-session-id",
        attachmentId: "legacy-attachment",
        origin: { kind: "future-door" } as unknown as SessionOrigin,
      },
      4 * DAY,
    );

    const events = (
      data(await f.read("ticket.events", { id: "VC-12", limit: 20 }))["events"] as {
        payload: Record<string, unknown>;
      }[]
    ).map((event) => event.payload);
    expect(events).toContainEqual({
      kind: "session_started",
      session: started.slice(0, 8),
      origin: { kind: "session", sessionId: parent.slice(0, 8) },
    });
    expect(events).toContainEqual({
      kind: "session_started",
      session: resumed.slice(0, 8),
      origin: { kind: "automation", automationRunId: RUN, automationName: "Review" },
    });
    expect(events).toContainEqual({ kind: "session_started", session: parent.slice(0, 8) });
    expect(events).toContainEqual({
      kind: "session_resumed",
      session: resumed.slice(0, 8),
      attachment: "22222222",
      origin: { kind: "session", sessionId: parent.slice(0, 8) },
    });
    expect(events).toContainEqual({
      kind: "session_resumed",
      session: resumed.slice(0, 8),
      attachment: "33333333",
      origin: null,
    });
    expect(events).toContainEqual({
      kind: "session_resumed",
      session: "not-a-session-id",
      attachment: "legacy-a",
      origin: null,
    });
    const wire = JSON.stringify(await f.read("ticket.events", { id: "VC-12", limit: 20 }));
    for (const full of [parent, started, resumed]) expect(wire).not.toContain(full);
    expect(wire).not.toContain("22222222-0000");
  });
});
