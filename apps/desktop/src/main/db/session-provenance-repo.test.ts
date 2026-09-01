import { afterEach, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";

import { recordAutomationRun } from "./automations-repo";
import { recordSessionStartedOnce, recordTicketEvent } from "./events-repo";
import { insertProject } from "./projects-repo";
import { readSessionProvenance } from "./session-provenance-repo";
import { openTestDb, testProject, testTicket } from "./test-helpers";
import type { TestDb } from "./test-helpers";
import { insertTicket } from "./tickets-repo";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const MODEL = { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" };

interface Fixture {
  db: Database.Database;
  projectId: string;
  ticketId: string;
  session(id: string, title: string | null, ticketId?: string | null): string;
}

function fixture(): Fixture {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  return {
    db: ctx.db,
    projectId: project.id,
    ticketId: ticket.id,
    session(id, title, ticketId = ticket.id) {
      ctx.db
        .prepare(
          "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?,?,?,?,?)",
        )
        .run(id, project.id, ticketId, title, 1_000);
      return id;
    },
  };
}

describe("readSessionProvenance", () => {
  it("marks a Run's Session with the Automation that produced it", () => {
    const f = fixture();
    f.session("session-run", "Nightly sweep");
    recordAutomationRun(
      f.db,
      {
        automationId: "automation-1",
        automationName: "Nightly sweep",
        ticketId: f.ticketId,
        sessionId: "session-run",
        model: MODEL,
      },
      2_000,
    );

    expect(readSessionProvenance(f.db, { sessionId: "session-run", ticketId: f.ticketId })).toEqual(
      {
        kind: "automation",
        automationName: "Nightly sweep",
      },
    );
  });

  // The name snapshot is what survives a record delete (`AutomationRun.automationName`).
  // An Unbound Run never had one, and the mark says so rather than inventing it.
  it("marks an Unbound Run with no name", () => {
    const f = fixture();
    f.session("session-unbound", null);
    recordAutomationRun(
      f.db,
      {
        automationId: null,
        automationName: null,
        ticketId: f.ticketId,
        sessionId: "session-unbound",
        model: MODEL,
      },
      2_000,
    );

    expect(
      readSessionProvenance(f.db, { sessionId: "session-unbound", ticketId: f.ticketId }),
    ).toEqual({ kind: "automation", automationName: null });
  });

  // The Run is asked FIRST because it is the only record that can carry a name:
  // a Run writes a `session_started` event too, with the `automation` actor and
  // no room for which Automation ran.
  it("prefers the Run record over the launch event, which cannot name an Automation", () => {
    const f = fixture();
    f.session("session-run", null);
    recordAutomationRun(
      f.db,
      {
        automationId: "automation-1",
        automationName: "Nightly sweep",
        ticketId: f.ticketId,
        sessionId: "session-run",
        model: MODEL,
      },
      2_000,
    );
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-run",
      now: 2_000,
      actor: { kind: "automation" },
    });

    expect(readSessionProvenance(f.db, { sessionId: "session-run", ticketId: f.ticketId })).toEqual(
      {
        kind: "automation",
        automationName: "Nightly sweep",
      },
    );
  });

  it("names the parent Session a `session.start` opened this one from", () => {
    const f = fixture();
    f.session("session-parent", "Orchestrator");
    f.session("session-child", null);
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-child",
      now: 2_000,
      actor: { kind: "session", sessionId: "session-parent", ticketId: f.ticketId },
    });

    expect(
      readSessionProvenance(f.db, { sessionId: "session-child", ticketId: f.ticketId }),
    ).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
  });

  it("still marks the child when the parent Session row is gone", () => {
    const f = fixture();
    f.session("session-child", null);
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-child",
      now: 2_000,
      actor: { kind: "session", sessionId: "session-vanished", ticketId: f.ticketId },
    });

    expect(
      readSessionProvenance(f.db, { sessionId: "session-child", ticketId: f.ticketId }),
    ).toEqual({
      kind: "session",
      parentSessionId: "session-vanished",
      parentTitle: null,
    });
  });

  it("leaves a Session a person started completely unmarked", () => {
    const f = fixture();
    f.session("session-human", "Plan the migration");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-human",
      now: 2_000,
      actor: { kind: "user" },
    });

    expect(
      readSessionProvenance(f.db, { sessionId: "session-human", ticketId: f.ticketId }),
    ).toEqual({ kind: "user" });
  });

  it("reads a Project Session a person started as person-started", () => {
    const f = fixture();
    f.session("session-project", "Project chat", null);
    f.db
      .prepare(
        `INSERT INTO session_commands (id, session_id, created_at, intent, route)
         VALUES ('project-person:create', 'session-project', 1000, ?, NULL)`,
      )
      .run(
        JSON.stringify({
          kind: "session.create",
          projectId: f.projectId,
          ticketId: null,
          title: "Project chat",
        }),
      );

    expect(readSessionProvenance(f.db, { sessionId: "session-project", ticketId: null })).toEqual({
      kind: "user",
    });
  });

  it("reads a Session with no launch event at all as person-started", () => {
    const f = fixture();
    f.session("session-legacy", "Older than the event");

    expect(
      readSessionProvenance(f.db, { sessionId: "session-legacy", ticketId: f.ticketId }),
    ).toEqual({ kind: "user" });
  });

  // ── THE PRE-RUN WINDOW ───────────────────────────────────────────────────
  // A Run creates its Session, and its `session_started` event, one durable
  // step BEFORE `automation_runs` is written. A crash in between (or a startup
  // recovery that never finishes) leaves exactly this state, and reading the
  // Run record alone answers `user` for it: no bolt, and no Run-scoped live
  // ring on the board, for a Session no person opened.
  it("marks a Run's Session from its launch event when the Run record is missing", () => {
    const f = fixture();
    f.session("session-run", "Nightly sweep");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-run",
      now: 2_000,
      // Exactly what `run.ts` passes, stored by `serializeActor` as the bare
      // token `automation` because it carries no context.
      actor: { kind: "automation" },
    });

    expect(readSessionProvenance(f.db, { sessionId: "session-run", ticketId: f.ticketId })).toEqual(
      { kind: "automation", automationName: null },
    );
  });

  // Project Sessions have no Ticket timeline. The accepted Run therefore
  // records its Session-create command id before mint; after a process death,
  // that marker and the minted command are the two durable halves that meet.
  it("marks a scheduled Project Run between Session mint and Run insert", () => {
    const f = fixture();
    const plan = {
      sessionOperationId: "scheduled-session",
      ticketId: null,
      projectId: f.projectId,
    };
    f.db
      .prepare("INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)")
      .run("scheduled-run", JSON.stringify({ kind: "automation.run", plan }), 1_500);
    f.db
      .prepare(
        `INSERT INTO automation_command_receipts
           (id, command_id, status, result, recorded_at)
         VALUES (?, ?, 'accepted', ?, ?)`,
      )
      .run(
        "scheduled-run-accepted",
        "scheduled-run",
        JSON.stringify({ kind: "automation.run.accepted", plan }),
        1_500,
      );
    // Pre-mint: this relation is durable while no Session row exists yet.
    f.db
      .prepare(
        `INSERT INTO automation_session_mint_intents
           (session_create_command_id, automation_command_id, recorded_at)
         VALUES (?, ?, ?)`,
      )
      .run("scheduled-session:create", "scheduled-run", 1_500);

    f.session("session-project-run", "Nightly sweep", null);
    f.db
      .prepare(
        `INSERT INTO session_commands (id, session_id, created_at, intent, route)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(
        "scheduled-session:create",
        "session-project-run",
        2_000,
        JSON.stringify({
          kind: "session.create",
          projectId: f.projectId,
          ticketId: null,
          title: "Nightly sweep",
        }),
      );

    expect(f.db.prepare("SELECT COUNT(*) AS n FROM automation_runs").get()).toEqual({ n: 0 });
    expect(
      readSessionProvenance(f.db, { sessionId: "session-project-run", ticketId: null }),
    ).toEqual({ kind: "automation", automationName: null });
  });

  // The other spelling of the same actor: a session-driven Automation stores
  // its context, so the token is JSON. Both must reach the same party — the
  // `sessionId` inside it names the Session that ASKED, not a parent Session,
  // and must never be read through into the `session` arm.
  it("marks a session-driven Automation's launch as an Automation, not a parent", () => {
    const f = fixture();
    f.session("session-run", null);
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-run",
      now: 2_000,
      actor: { kind: "automation", sessionId: "session-asker", ticketId: f.ticketId },
    });

    expect(readSessionProvenance(f.db, { sessionId: "session-run", ticketId: f.ticketId })).toEqual(
      { kind: "automation", automationName: null },
    );
  });

  // The actors that name NOBODY answer alike, and none of them may be read
  // through into a parent id: an `unauthenticated` caller, and a stored token
  // this build cannot read at all.
  it("draws no mark from an actor that names no party", () => {
    const f = fixture();
    for (const [sessionId, actor] of [
      ["session-b", "unauthenticated"],
      ["session-c", "{not json"],
      ["session-e", JSON.stringify({ kind: "session" })],
      ["session-f", JSON.stringify(["session-parent"])],
      ["session-g", "{}"],
    ] as const) {
      // Written straight to the column: `serializeActor` cannot spell a
      // malformed token, and unreadable history is exactly what this branch is
      // for — a build that stops recognising a stored actor must fall back to
      // "no mark", never to a wrong one.
      f.db
        .prepare(
          `INSERT INTO ticket_events (id, ticket_id, kind, actor, payload, created_at)
           VALUES (?, ?, 'session_started', ?, ?, 2000)`,
        )
        .run(
          `event-${sessionId}`,
          f.ticketId,
          actor,
          JSON.stringify({ kind: "session_started", sessionId }),
        );

      expect(readSessionProvenance(f.db, { sessionId, ticketId: f.ticketId })).toEqual({
        kind: "user",
      });
    }
  });

  // A launch event belongs to the Ticket it was recorded on, and the read is
  // scoped by that Ticket for the index it buys. Pinned so a later "optimisation"
  // that drops the payload comparison cannot start handing one Session's parent
  // to the Session that started next on the same Ticket.
  it("does not confuse two Sessions that started on the same Ticket", () => {
    const f = fixture();
    f.session("session-parent", "Orchestrator");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-first",
      now: 2_000,
      actor: { kind: "session", sessionId: "session-parent", ticketId: f.ticketId },
    });
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-second",
      now: 3_000,
      actor: { kind: "user" },
    });
    // A neighbouring event of another kind, so the `kind` filter is exercised
    // rather than assumed.
    recordTicketEvent(f.db, f.ticketId, { kind: "archived" }, 4_000, { kind: "user" });

    expect(
      readSessionProvenance(f.db, { sessionId: "session-second", ticketId: f.ticketId }),
    ).toEqual({ kind: "user" });
  });
});
