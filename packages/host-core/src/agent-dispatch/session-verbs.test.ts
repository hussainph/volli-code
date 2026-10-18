import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { requestAgent } from "../../../cli/src/client";
import { runCli } from "../../../cli/src/run";
import { startAgentSocket } from "../agent-socket";
import type {
  AgentCommand,
  AgentResponse,
  SessionAttention,
  SessionAttentionKind,
  SessionInteraction,
  SessionLedger,
  SessionLedgerTransaction,
  SessionOrigin,
  SessionRole,
} from "@volli/shared";
import { SESSION_LISTING_CACHE_LIMIT, type StoredSessionFollowUp } from "@volli/session-engine";
import { createAgentCommandService } from "../agent-commands";
import { testHostHandlers } from "../testing/host-handlers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { recordSessionResumedOnce, recordTicketEvent } from "../db/events-repo";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "../db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import { createHostSessionEngine } from "../sessions/engine";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { insertSession } from "../session-control/test-support";
import { pendingSessionQuestions } from "./pending-session-questions";
import {
  consumeFollowUpCleanClose,
  createSqliteSessionFollowUpLedger,
  FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
  stampFollowUpCleanClose,
} from "../db/session-follow-up-repo";

let db: TestDb;
afterEach(() => db?.cleanup());
const DAY = 86400000;
const provenance = {
  source: { kind: "user" as const, id: "test", detail: null },
  venue: { id: "local" as const, kind: "local" as const },
};
const questionProvenance = {
  source: { kind: "adapter" as const, id: "pi", detail: null },
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
    handlers: testHostHandlers({ db: db.db }),
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
  return { engine, read, create, active, ids, service };
}

describe("session roster and detail", () => {
  it("reads every pending flat and multi-question prompt from the ledger, scrubbed and without tail truncation", async () => {
    const f = fixture();
    const id = await f.create("questions", DAY);
    await f.active(id, 2 * DAY);
    const attachmentId = `attachment-${id}`;
    const flat: SessionInteraction = {
      id: "ask-user:flat",
      attachmentId,
      kind: "question",
      title: "Which route?\nUse sk-route_private?",
      detail: "Keep this second line\nAuthorization: Bearer private-value",
      options: [
        { id: "yes", label: "Yes\nProceed", description: "token=option-private" },
        { id: "no", label: "No", description: null },
      ],
      multiple: false,
      native: { id: "native-private", detail: { token: "native-detail-private" } },
    };
    const multi: SessionInteraction = {
      ...flat,
      id: "ask-user:multi",
      title: "Questions",
      detail: null,
      // The flat fallback must not hide the second prompt or add a phantom one.
      options: [],
      prompts: [
        {
          id: "prompt:0",
          label: "Pick a region\nThen a zone",
          detail: null,
          options: [{ id: "west", label: "West", description: null }],
          multiple: false,
          custom: true,
        },
        {
          id: "prompt:1",
          label: `Select environments\n${"Full question text. ".repeat(20)}`,
          detail: "Use password=prompt-private\nKeep the rest",
          options: [
            { id: "dev", label: "Dev sk-dev_private", description: "Line one\nLine two" },
            { id: "prod", label: "Prod", description: null },
          ],
          multiple: true,
          custom: false,
        },
      ],
    };
    for (const interaction of [
      flat,
      multi,
      { ...flat, id: "permission", kind: "permission" as const },
      { ...flat, id: "cancelled" },
      { ...flat, id: "resolved" },
    ]) {
      await f.engine.observe({
        id: `opened-${interaction.id}`,
        kind: "interaction.opened",
        sessionId: id,
        attachmentId,
        occurredAt: 3 * DAY,
        provenance: questionProvenance,
        interaction,
      });
    }
    await f.engine.observe({
      id: "cancel-question",
      kind: "interaction.cancelled",
      sessionId: id,
      attachmentId,
      occurredAt: 4 * DAY,
      provenance: questionProvenance,
      interactionId: "cancelled",
      reason: "withdrawn",
    });
    await f.engine.observe({
      id: "resolve-question",
      kind: "interaction.resolved",
      sessionId: id,
      attachmentId,
      occurredAt: 4 * DAY,
      provenance: questionProvenance,
      interactionId: "resolved",
      resolution: { optionIds: ["yes"], response: null },
    });
    const expected = [
      {
        id: "ask-user:flat",
        title: "Which route?\nUse [redacted]?",
        detail: "Keep this second line\nAuthorization: Bearer [redacted]",
        prompts: [
          {
            id: "prompt:0",
            label: "Which route?\nUse [redacted]?",
            detail: "Keep this second line\nAuthorization: Bearer [redacted]",
            options: [
              { id: "yes", label: "Yes\nProceed", description: "token= [redacted]" },
              { id: "no", label: "No", description: null },
            ],
            multiple: false,
            custom: false,
          },
        ],
      },
      {
        id: "ask-user:multi",
        title: "Questions",
        detail: null,
        prompts: [
          multi.prompts![0],
          {
            ...multi.prompts![1],
            detail: "Use password= [redacted]\nKeep the rest",
            options: [
              { id: "dev", label: "Dev [redacted]", description: "Line one\nLine two" },
              { id: "prod", label: "Prod", description: null },
            ],
          },
        ],
      },
    ];
    // The actual socket codec and CLI runner must preserve all prompts, not
    // only the handler's in-process shape. No provider or app is launched.
    const socketPath = join(dirname(db.dbPath), "questions.sock");
    const socket = await startAgentSocket({
      socketPath,
      execute: (request) => f.service.execute(request),
    });
    try {
      for (const verb of ["session.show", "session.peek"] as const) {
        const shown = data(
          await requestAgent(
            socketPath,
            {
              v: 1,
              cmd: verb,
              args: { id: id.slice(0, 8), lines: 1 },
              ctx: { cwd: "/repo/volli", env: {} },
            },
            { timeoutMs: 2000 },
          ),
        );
        expect(shown["pendingQuestions"]).toEqual(expected);
        const stdout: string[] = [];
        const stderr: string[] = [];
        expect(
          await runCli(["session", verb === "session.show" ? "show" : "peek", id.slice(0, 8)], {
            env: { VOLLI_SOCKET: socketPath },
            cwd: "/repo/volli",
            stdout: (text) => stdout.push(text),
            stderr: (text) => stderr.push(text),
            request: (path, request) => requestAgent(path, request, { timeoutMs: 2000 }),
            readText: async () => {
              throw new Error("No file argument expected");
            },
            launch: async () => {
              throw new Error("No app launch expected");
            },
            observe: async () => ({}),
          }),
        ).toBe(0);
        expect(stderr).toEqual([]);
        const rendered = stdout.join("");
        for (const text of [
          "Which route?",
          "Yes",
          "Proceed",
          "Pick a region",
          "Then a zone",
          "Select environments",
          "Full question text. ".repeat(20).trim(),
          "Dev",
          "Prod",
          "Line one",
          "Line two",
        ]) {
          expect(rendered).toContain(text);
        }
        const json = JSON.stringify(shown["pendingQuestions"]);
        for (const secret of [
          "route_private",
          "private-value",
          "option-private",
          "prompt-private",
          "dev_private",
          "native-private",
          "native-detail-private",
          "attachmentId",
        ]) {
          expect(json).not.toContain(secret);
          expect(rendered).not.toContain(secret);
        }
      }
    } finally {
      await socket.close();
    }
  });

  it("keeps absent questions and an explicitly empty prompt list distinct", async () => {
    expect(pendingSessionQuestions(undefined)).toEqual([]);
    const f = fixture();
    const id = await f.create("no questions", DAY);
    for (const verb of ["session.show", "session.peek"] as const) {
      expect(data(await f.read(verb, { id: id.slice(0, 8) }))["pendingQuestions"]).toEqual([]);
    }
    await f.active(id, 2 * DAY);
    await f.engine.observe({
      id: "empty-question",
      kind: "interaction.opened",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: 3 * DAY,
      provenance: questionProvenance,
      interaction: {
        id: "ask-user:empty",
        attachmentId: `attachment-${id}`,
        kind: "question",
        title: "Empty card",
        detail: null,
        options: [],
        prompts: [],
        multiple: false,
        native: { id: null, detail: null },
      },
    });
    for (const verb of ["session.show", "session.peek"] as const) {
      expect(data(await f.read(verb, { id: id.slice(0, 8) }))["pendingQuestions"]).toEqual([
        { id: "ask-user:empty", title: "Empty card", detail: null, prompts: [] },
      ]);
    }
  });

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

// VC-663 (D4): the WebSocket's Session reads run these same handlers with the
// roster forced to the connection's Workspace.
describe("executeInWorkspace", () => {
  it("lists only that Workspace's Sessions, whatever project the caller names", async () => {
    const { create, service, ids } = fixture();
    const mine = await create("mine", 10 * DAY);
    await create("theirs", 10 * DAY, { projectId: "other" });
    for (const args of [{ all: true }, { all: true, project: "other" }]) {
      expect(ids(await service.executeInWorkspace("session.list", "p", args))).toEqual([
        mine.slice(0, 8),
      ]);
    }
  });

  it("answers another Workspace's Session exactly as an absent one, on every read", async () => {
    const { create, service } = fixture();
    const mine = (await create("mine", 10 * DAY)).slice(0, 8);
    const theirs = (await create("theirs", 10 * DAY, { projectId: "other" })).slice(0, 8);
    expect(data(await service.executeInWorkspace("session.show", "p", { id: mine }))["id"]).toBe(
      mine,
    );
    for (const verb of ["session.show", "session.peek", "session.answer"] as const) {
      const foreign = await service.executeInWorkspace(verb, "p", { id: theirs });
      const absent = await service.executeInWorkspace(verb, "p", { id: "ffffffff" });
      expect(foreign).toEqual({
        v: 1,
        ok: false,
        error: expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
      });
      expect(foreign.ok || absent.ok ? null : foreign.error.code).toBe(
        absent.ok ? null : absent.error.code,
      );
    }
  });

  it("refuses a Workspace this host does not have", async () => {
    const { service } = fixture();
    expect(await service.executeInWorkspace("session.list", "nowhere", {})).toMatchObject({
      ok: false,
      error: { code: "PROJECT_NOT_FOUND" },
    });
  });
});

// VC-800: `session list`, `peek` and `show` fold every project's roster through
// the engine's listing cache. When the rosters together outgrew the cache's
// fixed limit, every read cold-folded every Session. On a 4,051-Session profile
// that took longer than the CLI's 10 s bound.
describe("session reads over rosters larger than the fold cache's floor (VC-800)", () => {
  it(
    "re-folds only the Sessions whose log moved, on list, peek and show",
    { timeout: 60_000 },
    async () => {
      db = openTestDb();
      insertProject(db.db, testProject({ id: "p", name: "Volli", path: "/repo/volli" }));
      insertProject(db.db, testProject({ id: "other", name: "Other", path: "/repo/other" }));
      const stored = createSqliteSessionLedger(db.db);
      // `listProjectionEvents` is the fold's own read: a Session named here was
      // projected from its log, and one that is not was answered from the cache.
      const folded: string[] = [];
      const ledger: SessionLedger = {
        transaction: (work) =>
          stored.transaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(target, property) {
                  if (property === "listProjectionEvents") {
                    return (
                      query: Parameters<SessionLedgerTransaction["listProjectionEvents"]>[0],
                    ) => {
                      folded.push(query.sessionId);
                      return target.listProjectionEvents(query);
                    };
                  }
                  // Bound to the real transaction: it keeps private state.
                  const value: unknown = Reflect.get(target, property, target);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }),
            ),
          ),
      };
      let nextId = 0;
      const engine = createHostSessionEngine(ledger, {
        now: () => DAY,
        nextId: () => `${(++nextId).toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
      });
      const service = createAgentCommandService({
        handlers: testHostHandlers({ db: db.db }),
        db: db.db,
        appVersion: "test",
        sessionEngine: engine,
        now: () => 2 * DAY,
      });
      const read = (cmd: AgentCommand, args: Record<string, unknown> = {}) =>
        service.execute({ v: 1, cmd, args, ctx: { cwd: "/repo/volli", env: {} } });
      // Each project's roster is under the floor and their sum is over it,
      // which is what every `session` read folds: all of them at once.
      const rosters = { p: SESSION_LISTING_CACHE_LIMIT - 56, other: 100 };
      const sessionIds: string[] = [];
      for (const [projectId, count] of Object.entries(rosters)) {
        for (let index = 0; index < count; index += 1) {
          const created = await engine.createSession({
            commandId: `create-${projectId}-${index}`,
            projectId,
            ticketId: null,
            role: "project",
            parentSessionId: null,
            title: `${projectId} ${index}`,
            provenance,
          });
          if (projectId === "p") sessionIds.push(created.session.id);
        }
      }
      expect(rosters.p + rosters.other).toBeGreaterThan(SESSION_LISTING_CACHE_LIMIT);

      folded.length = 0;
      const first = data(await read("session.list", { all: true }));
      expect(first["sessions"]).toHaveLength(rosters.p);
      expect(folded).toHaveLength(rosters.p + rosters.other);

      folded.length = 0;
      expect(data(await read("session.list", { all: true }))).toEqual(first);
      expect(folded).toEqual([]);

      // One Session moves. Peek and show re-fold that one and nothing else.
      const named = sessionIds[7];
      await engine.submit({
        commandId: "retitle-named",
        sessionId: named,
        intent: { kind: "session.retitle", title: "Moved" },
        provenance,
      });
      folded.length = 0;
      expect(data(await read("session.peek", { id: named.slice(0, 8) }))).toMatchObject({
        session: named.slice(0, 8),
      });
      expect(data(await read("session.show", { id: named.slice(0, 8) }))).toMatchObject({
        id: named.slice(0, 8),
        title: "Moved",
      });
      expect(folded).toEqual([named]);
    },
  );
});

// VC-758: the runtime fixtures. Attachments and queued messages are written
// through the same engine and SQLite ledger the runtime uses.
const attachmentFor = (sessionId: string, attachmentId = `attachment-${sessionId}`) =>
  ({
    id: attachmentId,
    sessionId,
    adapterId: "pi",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: { id: "test", detail: null },
    authority: null,
  }) as const;
const message = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as StoredSessionFollowUp["message"];

// VC-758: `session peek` answers the runtime facts a reader needs to explain a
// quiet, stopped or ended chat. Each case writes through the real engine and
// SQLite ledger, and the queue is read through the same SQLite follow-up
// ledger the runtime drains. Nothing is hand-built in the projection.
describe("session peek runtime facts (VC-758)", () => {
  type Fixture = ReturnType<typeof fixture>;
  // The per-kind fields the Attention union requires; the copy is the host's own.
  const KIND_FIELDS: Partial<Record<SessionAttentionKind, Record<string, null>>> = {
    rate_limited: { retryAt: null },
    quota_exhausted: { resetAt: null },
    adapter_unrecoverable: { resetsAt: null },
  };
  const raise = (
    f: Fixture,
    id: string,
    kind: SessionAttentionKind,
    detail: string | null,
    key: string = kind,
  ) =>
    f.engine.observe({
      id: `raise-${key}-${id}`,
      kind: "attention.raised",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: 2 * DAY,
      provenance,
      attention: {
        id: `attention-${key}`,
        kind,
        attachmentId: `attachment-${id}`,
        detail,
        diagnostic: null,
        ...KIND_FIELDS[kind],
      } as SessionAttention,
    });
  const clear = (f: Fixture, id: string, key: string) =>
    f.engine.observe({
      id: `clear-${key}-${id}`,
      kind: "attention.cleared",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: 2 * DAY,
      provenance,
      attentionId: `attention-${key}`,
    });
  const signal = (f: Fixture, id: string, kind: "done" | "blocked", reason: string | null) =>
    f.engine.submit({
      commandId: `signal-${kind}-${id}`,
      sessionId: id,
      intent: { kind: "session.signal", signal: kind, reason },
      provenance,
    });
  const stop = (
    f: Fixture,
    id: string,
    reason: string | null,
    by: { kind: "user" } | { kind: "watchdog" } | { kind: "session"; sessionId: string },
  ) =>
    f.engine.submit({
      commandId: `stop-${id}`,
      sessionId: id,
      intent: { kind: "session.stop", reason, by },
      provenance,
    });
  const peek = async (f: Fixture, id: string, args: Record<string, unknown> = {}) =>
    data(await f.read("session.peek", { id: id.slice(0, 8), ...args }));
  const queued = (
    id: string,
    state: StoredSessionFollowUp["state"],
    extra: Partial<StoredSessionFollowUp> = {},
  ): StoredSessionFollowUp => ({
    id,
    commandId: `command-${id}`,
    deliveryCommandId: `delivery-${id}`,
    state,
    message: message(id, `text of ${id}`),
    ...extra,
  });
  const seedQueue = (sessionId: string, entries: StoredSessionFollowUp[]) =>
    createSqliteSessionFollowUpLedger(db.db).transaction(sessionId, (state) => {
      state.entries.push(...entries);
      state.revision += 1;
    });

  it.each([
    ["auth_required", "Sign-in required", "Open settings"],
    ["configuration_invalid", "Configuration invalid", "Open settings"],
    ["transport_retrying", "Reconnecting", null],
    ["adapter_disconnected", "Disconnected", "Retry"],
    ["rate_limited", "Rate limited", "Retry"],
    ["quota_exhausted", "Quota exhausted", null],
    ["context_limit_reached", "Context limit reached", null],
    ["partial_turn_interrupted", "Turn interrupted", null],
    ["adapter_unrecoverable", "Runtime stopped", "Retry"],
    ["input_required", "Waiting for an answer", null],
    ["permission_required", "Waiting for approval", null],
  ] as const)(
    "names the %s Attention in plain words, with its recovery when it has one",
    async (kind, copy, recovery) => {
      const f = fixture();
      const id = await f.create("attention", DAY);
      await f.active(id, 2 * DAY);
      await raise(f, id, kind, null);
      expect((await peek(f, id))["attention"]).toEqual({ message: copy, recovery, detail: null });
    },
  );

  it("redacts and bounds an Attention's detail, and drops the Attention once it is cleared", async () => {
    const f = fixture();
    const id = await f.create("detail", DAY);
    await f.active(id, 2 * DAY);
    await raise(
      f,
      id,
      "adapter_unrecoverable",
      `Authorization: Bearer sk-live-detail-secret ${"tail ".repeat(200)}`,
    );
    const shown = await peek(f, id);
    expect(shown["attention"]).toEqual({
      message: "Runtime stopped",
      recovery: "Retry",
      detail: `Authorization: Bearer [redacted] ${"tail ".repeat(200)}`.slice(0, 400),
    });
    expect(JSON.stringify(shown)).not.toContain("sk-live-detail-secret");
    await clear(f, id, "adapter_unrecoverable");
    expect((await peek(f, id))["attention"]).toBeNull();
  });

  it("shows the latest active Attention, and falls back to the one before it when that clears", async () => {
    const f = fixture();
    const id = await f.create("primary", DAY);
    await f.active(id, 2 * DAY);
    await raise(f, id, "transport_retrying", "first", "first");
    await raise(f, id, "adapter_unrecoverable", "second", "second");
    expect((await peek(f, id))["attention"]).toMatchObject({ message: "Runtime stopped" });
    await clear(f, id, "second");
    expect((await peek(f, id))["attention"]).toEqual({
      message: "Reconnecting",
      recovery: null,
      detail: "first",
    });
  });

  it("names a Session stopped by a session, redacting the reason and shortening that actor's id", async () => {
    const f = fixture();
    const operator = await f.create("operator", DAY);
    const id = await f.create("stopped", 2 * DAY);
    await f.active(id, 2 * DAY);
    await stop(f, id, "Stopping: token=stop-secret-value because the build broke", {
      kind: "session",
      sessionId: operator,
    });
    const shown = await peek(f, id);
    expect(shown["stopped"]).toEqual({
      at: 2 * DAY,
      reason: "Stopping: token= [redacted] because the build broke",
      by: { kind: "session", sessionId: operator.slice(0, 8) },
    });
    expect(JSON.stringify(shown)).not.toContain("stop-secret-value");
    expect(JSON.stringify(shown)).not.toContain(operator);
    // The stopped executor closes, then resumed work opens a fresh attachment,
    // and that ends the stop: the record stays in history, the state does not.
    await f.engine.observe({
      id: `closed-${id}`,
      kind: "attachment.closed",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: 3 * DAY,
      provenance,
      outcome: "interrupted",
    });
    await f.engine.observe({
      id: `resume-${id}`,
      kind: "attachment.opened",
      sessionId: id,
      occurredAt: 3 * DAY,
      provenance,
      attachment: attachmentFor(id, `resume-${id}`),
    });
    expect((await peek(f, id))["stopped"]).toBeNull();
  });

  it.each([
    ["the user", { kind: "user" } as const, null],
    ["the watchdog", { kind: "watchdog" } as const, "Silent for ten minutes"],
  ])("names a Session stopped by %s, with the reason it was given", async (_, by, reason) => {
    const f = fixture();
    const id = await f.create("stopped", 2 * DAY);
    await f.active(id, 2 * DAY);
    await stop(f, id, reason, by);
    expect((await peek(f, id))["stopped"]).toEqual({ at: 2 * DAY, reason, by });
  });

  it("answers the latest done or blocked signal with its reason and age", async () => {
    const f = fixture();
    const id = await f.create("signal", 2 * DAY);
    await f.active(id, 2 * DAY);
    await signal(f, id, "blocked", "Waiting on the schema decision");
    expect((await peek(f, id))["signal"]).toEqual({
      kind: "blocked",
      reason: "Waiting on the schema decision",
      at: 2 * DAY,
      ageMs: 8 * DAY,
    });
    await signal(f, id, "done", null);
    expect((await peek(f, id))["signal"]).toEqual({
      kind: "done",
      reason: null,
      at: 2 * DAY,
      ageMs: 8 * DAY,
    });
  });

  // The signal is the Session's own text, so it gets the same redaction and
  // 400-character bound as the Attention detail and the stop reason.
  it("redacts and bounds the signal reason the way the other peek prose is", async () => {
    const f = fixture();
    const id = await f.create("signal bounds", 2 * DAY);
    await f.active(id, 2 * DAY);
    await signal(f, id, "blocked", `Need token=signal-secret-value ${"x".repeat(600)}`);
    const shown = await peek(f, id);
    expect(shown["signal"]).toMatchObject({
      kind: "blocked",
      reason: `Need token= [redacted] ${"x".repeat(600)}`.slice(0, 400),
    });
    expect(JSON.stringify(shown)).not.toContain("signal-secret-value");
  });

  it.each(["completed", "interrupted", "failed"] as const)(
    "answers the last turn as %s, from the same fold the listing reads",
    async (outcome) => {
      const f = fixture();
      const id = await f.create("outcome", DAY);
      await f.active(id, 2 * DAY);
      if (outcome === "completed")
        await f.engine.observe({
          id: `turn-end-${id}`,
          kind: "turn.completed",
          sessionId: id,
          attachmentId: `attachment-${id}`,
          occurredAt: 2 * DAY,
          provenance,
          turnId: `turn-${id}`,
        });
      else if (outcome === "interrupted")
        await f.engine.observe({
          id: `turn-end-${id}`,
          kind: "turn.interrupted",
          sessionId: id,
          attachmentId: `attachment-${id}`,
          occurredAt: 2 * DAY,
          provenance,
          turnId: `turn-${id}`,
        });
      else
        // The executor ended while the turn was open: the turn failed, and
        // no Attention is raised, so the outcome is the only fact that says so.
        await f.engine.observe({
          id: `attachment-closed-${id}`,
          kind: "attachment.closed",
          sessionId: id,
          attachmentId: `attachment-${id}`,
          occurredAt: 2 * DAY,
          provenance,
          outcome: "failed",
        });
      const shown = await peek(f, id);
      expect(shown["lastTurnOutcome"]).toBe(outcome);
      expect(shown["attention"]).toBeNull();
    },
  );

  it("answers the follow-up queue from the SQLite ledger: each state, a steer, a refusal, bounded and redacted", async () => {
    const f = fixture();
    const id = await f.create("queue", DAY);
    await f.active(id, 2 * DAY);
    await seedQueue(id, [
      queued("queued", "queued", {
        message: message("queued", `Use token=queued-secret-value ${"y".repeat(500)}`),
      }),
      queued("sending", "releasing", { message: message("sending", "Sending now") }),
      queued("steer", "queued", {
        message: message("steer", "Steer after this step"),
        steer: { signature: "steer-signature", targetTurnId: `turn-${id}` },
      }),
      queued("refused", "queued", {
        message: message("refused", "Refused text"),
        refused: true,
        refusedDetail: "Queued delivery refused: rejected: token=refused-secret-value",
      }),
      queued("attachment", "queued", {
        message: {
          id: "attachment",
          role: "user",
          parts: [{ type: "file", mediaType: "image/png", url: "https://example.invalid/x.png" }],
        },
      }),
    ]);
    const shown = await peek(f, id);
    expect(shown["pendingMessageCount"]).toBe(5);
    expect(shown["pendingMessages"]).toEqual([
      {
        id: "queued",
        text: `Use token= [redacted] ${"y".repeat(500)}`.slice(0, 400),
        label: "Queued",
        detail: null,
      },
      { id: "sending", text: "Sending now", label: "Sending", detail: null },
      {
        id: "steer",
        text: "Steer after this step",
        label: "After the current step",
        detail: null,
      },
      {
        id: "refused",
        text: "Refused text",
        label: "Blocked",
        detail: "Queued delivery refused: rejected: token= [redacted]",
      },
      // A message with no text is named as an attachment, not as an empty line.
      { id: "attachment", text: "", label: "Queued", detail: null },
    ]);
    expect(JSON.stringify(shown)).not.toContain("queued-secret-value");
    expect(JSON.stringify(shown)).not.toContain("refused-secret-value");
    // `lines` bounds the rows shown; the count still says how many wait.
    const bounded = await peek(f, id, { lines: 2 });
    expect(bounded["pendingMessageCount"]).toBe(5);
    expect((bounded["pendingMessages"] as unknown[]).length).toBe(2);
  });

  it("shows a follow-up that boot held for an older Volli as Blocked, with the hold's reason", async () => {
    const f = fixture();
    const id = await f.create("held", DAY);
    await f.active(id, 2 * DAY);
    await seedQueue(id, [
      queued("claimed", "releasing", { message: message("claimed", "Resend this") }),
    ]);
    // Boot stamps the watermark at the last event; any later event makes it stale.
    stampFollowUpCleanClose(db.db, 2 * DAY);
    await signal(f, id, "blocked", null);
    expect(consumeFollowUpCleanClose(db.db)).toEqual([id]);
    expect((await peek(f, id))["pendingMessages"]).toEqual([
      {
        id: "claimed",
        text: "Resend this",
        label: "Blocked",
        detail: FOLLOW_UP_DOWNGRADE_HOLD_DETAIL,
      },
    ]);
  });

  it("prints every runtime fact through the socket and runCli, and keeps secrets out of text and JSON", async () => {
    const f = fixture();
    const id = await f.create("runtime facts", DAY);
    await f.active(id, 2 * DAY);
    await raise(f, id, "adapter_unrecoverable", "Authorization: Bearer e2e-detail-secret", "e2e");
    await seedQueue(id, [
      queued("held", "queued", {
        message: message("held", "Ship it token=e2e-queue-secret"),
        refused: true,
        refusedDetail: "Queued delivery refused: rejected: password=e2e-refusal-secret",
      }),
      queued("waiting", "queued", {
        message: message("waiting", "Use the steer"),
        steer: { signature: "steer-signature", targetTurnId: `turn-${id}` },
      }),
    ]);
    await stop(f, id, "Paused: token=e2e-stop-secret", { kind: "user" });
    await f.engine.observe({
      id: `attachment-closed-${id}`,
      kind: "attachment.closed",
      sessionId: id,
      attachmentId: `attachment-${id}`,
      occurredAt: 3 * DAY,
      provenance,
      outcome: "failed",
    });
    const socketPath = join(dirname(db.dbPath), "runtime-facts.sock");
    const socket = await startAgentSocket({
      socketPath,
      execute: (request) => f.service.execute(request),
    });
    const peekThrough = async (args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(["session", "peek", id.slice(0, 8), ...args], {
        env: { VOLLI_SOCKET: socketPath },
        cwd: "/repo/volli",
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
        request: (path, request) => requestAgent(path, request, { timeoutMs: 2000 }),
        readText: async () => {
          throw new Error("No file argument expected");
        },
        launch: async () => {
          throw new Error("No app launch expected");
        },
        observe: async () => ({}),
      });
      return { code, text: stdout.join(""), stderr: stderr.join("") };
    };
    try {
      const text = await peekThrough([]);
      expect(text.code).toBe(0);
      expect(text.stderr).toBe("");
      for (const line of [
        "Runtime stopped · Retry",
        "Stopped by user",
        "Paused: token= [redacted]",
        "Last turn failed",
        "2 messages waiting",
        "pending message 1: Blocked",
        "  | Queued delivery refused: rejected: password= [redacted]",
        "pending message 2: After the current step",
      ]) {
        expect(text.text).toContain(line);
      }
      for (const secret of [
        "e2e-detail-secret",
        "e2e-stop-secret",
        "e2e-queue-secret",
        "e2e-refusal-secret",
      ]) {
        expect(text.text).not.toContain(secret);
      }
      const json = await peekThrough(["--json"]);
      expect(json.code).toBe(0);
      expect(json.text).not.toContain("e2e-detail-secret");
      expect(json.text).not.toContain("e2e-refusal-secret");
      // `--json` prints the reply's data, the same object the text is rendered from.
      expect(JSON.parse(json.text)).toMatchObject({
        lastTurnOutcome: "failed",
        stopped: { by: { kind: "user" } },
        pendingMessageCount: 2,
        attention: { message: "Runtime stopped", recovery: "Retry" },
      });
    } finally {
      await socket.close();
    }
  });
});
