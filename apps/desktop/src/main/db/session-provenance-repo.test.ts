import { afterEach, describe, expect, it } from "vite-plus/test";
import type Database from "better-sqlite3";

import { recordAutomationRun } from "./automations-repo";
import { recordSessionStartedOnce, recordTicketEvent } from "./events-repo";
import { insertProject } from "./projects-repo";
import { readSessionProvenance, readSessionProvenances } from "./session-provenance-repo";
import type { SessionProvenanceQuery } from "./session-provenance-repo";
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

  it("reads a Board Session a person started as person-started", () => {
    const f = fixture();
    f.session("session-project", "Board chat", null);
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
          role: "project",
          title: "Board chat",
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

  // Board Sessions have no Ticket timeline. The accepted Run therefore
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
          role: "project",
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

/**
 * The roster shape of the same question (VC-392).
 *
 * The rule these tests hold is not "the batch is fast": it is that the batch
 * and the single reader answer the same Session identically, because the fetch
 * (`volli:session-list`) asks for a whole roster and the push channel
 * (`activity-watch.ts`) asks for one Session at a time, and a Session that
 * changed provenance as it moved between the two would flicker a Run's bolt.
 */
/** What the listing hands in: each Session with the Ticket that scopes it. */
function queriesOf(f: {
  db: Database.Database;
  sessionIds: readonly string[];
}): SessionProvenanceQuery[] {
  return f.sessionIds.map((sessionId) => ({
    sessionId,
    ticketId: (
      f.db.prepare("SELECT ticket_id FROM sessions WHERE id = ?").get(sessionId) as {
        ticket_id: string | null;
      }
    ).ticket_id,
  }));
}

/**
 * Appends one `session.retitled` fact to a Session's own ledger, which is where
 * a rename lives — `sessions.title` is written once at mint and never again.
 */
function retitle(db: Database.Database, sessionId: string, title: string | null, at: number): void {
  db.prepare("INSERT OR IGNORE INTO session_provenances (id, provenance) VALUES (1, ?)").run(
    JSON.stringify({ source: { kind: "user", id: "test", detail: null } }),
  );
  db.prepare(
    `INSERT INTO session_events
       (id, session_id, sequence, occurred_at, recorded_at, provenance_id, payload)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    `event-${sessionId}-${at}`,
    sessionId,
    at,
    at,
    at,
    JSON.stringify({ kind: "session.retitled", title }),
  );
}

/**
 * Counts the statements one call EXECUTES, rather than the ones it prepares.
 *
 * `prepared` memoizes per handle, so a second call prepares nothing and a
 * counter that wrapped `db.prepare` per measurement would see zero. The wrap
 * is therefore installed once per handle and left in place; each measurement
 * only swaps the sink the wrapped statements report into.
 */
const statementSinks = new WeakMap<Database.Database, { active: string[] | null }>();

function countingStatements(db: Database.Database, run: () => void): number {
  let sink = statementSinks.get(db);
  if (sink === undefined) {
    const state: { active: string[] | null } = { active: null };
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      for (const method of ["get", "all", "iterate", "run"] as const) {
        const real = statement[method].bind(statement) as (...args: unknown[]) => unknown;
        Object.defineProperty(statement, method, {
          configurable: true,
          value: (...args: unknown[]) => {
            state.active?.push(sql);
            return real(...args);
          },
        });
      }
      return statement;
    }) as typeof db.prepare;
    sink = state;
    statementSinks.set(db, state);
  }
  const executed: string[] = [];
  sink.active = executed;
  try {
    run();
  } finally {
    sink.active = null;
  }
  return executed.length;
}

describe("readSessionProvenances", () => {
  /** Every source the reader can answer from, in one project. */
  function roster(): Fixture & { secondTicketId: string; sessionIds: string[] } {
    const f = fixture();
    const secondTicket = testTicket(f.projectId);
    insertTicket(ctx.db, secondTicket);

    f.session("session-parent", "Orchestrator");
    // 1. a completed Run, the only source that can carry a name
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
      3_000,
    );
    // 2. a Run caught between Session mint and its Run row
    f.session("session-premint", "Scheduled sweep", null);
    f.db
      .prepare("INSERT INTO automation_commands (id, intent, created_at) VALUES (?, ?, ?)")
      .run("premint-run", JSON.stringify({ kind: "automation.run" }), 1_500);
    f.db
      .prepare(
        `INSERT INTO automation_session_mint_intents
           (session_create_command_id, automation_command_id, recorded_at)
         VALUES (?, ?, ?)`,
      )
      .run("premint:create", "premint-run", 1_500);
    f.db
      .prepare(
        `INSERT INTO session_commands (id, session_id, created_at, intent, route)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run("premint:create", "session-premint", 2_000, JSON.stringify({ kind: "session.create" }));
    // 3. a launch by a parent Session, and one by a parent that is gone
    f.session("session-child", "Delegated");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-child",
      now: 2_100,
      actor: { kind: "session", sessionId: "session-parent", ticketId: f.ticketId },
    });
    f.session("session-orphan", "Delegated by a deleted parent");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-orphan",
      now: 2_200,
      actor: { kind: "session", sessionId: "session-gone", ticketId: f.ticketId },
    });
    // 4. an Automation named only by its launch event
    f.session("session-launched", "Run with no row");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-launched",
      now: 2_300,
      actor: { kind: "automation" },
    });
    // 5. the resting case, twice: a person on a Ticket, and a Board Session
    f.session("session-person", "Opened by hand");
    recordSessionStartedOnce(f.db, {
      ticketId: f.ticketId,
      sessionId: "session-person",
      now: 2_400,
      actor: { kind: "user" },
    });
    f.session("session-board", "Board chat", null);
    // A Session on the OTHER Ticket, so the batch has more than one Ticket to
    // scope by.
    f.session("session-elsewhere", "Second ticket", secondTicket.id);
    recordSessionStartedOnce(f.db, {
      ticketId: secondTicket.id,
      sessionId: "session-elsewhere",
      now: 2_500,
      actor: { kind: "session", sessionId: "session-parent", ticketId: secondTicket.id },
    });
    return {
      ...f,
      secondTicketId: secondTicket.id,
      sessionIds: [
        "session-parent",
        "session-run",
        "session-premint",
        "session-child",
        "session-orphan",
        "session-launched",
        "session-person",
        "session-board",
        "session-elsewhere",
      ],
    };
  }

  // THE constraint this ticket is not allowed to break.
  it("answers a roster exactly as the per-Session reader answers each row", () => {
    const f = roster();
    const queries = queriesOf(f);

    const batched = readSessionProvenances(f.db, queries);

    for (const query of queries) {
      expect(batched(query.sessionId)).toEqual(readSessionProvenance(f.db, query));
    }
    // And the answers are the ones the sources say, not merely two agreeing
    // readers of the same mistake.
    expect(batched("session-run")).toEqual({
      kind: "automation",
      automationName: "Nightly sweep",
    });
    expect(batched("session-premint")).toEqual({ kind: "automation", automationName: null });
    expect(batched("session-launched")).toEqual({ kind: "automation", automationName: null });
    expect(batched("session-child")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
    expect(batched("session-orphan")).toEqual({
      kind: "session",
      parentSessionId: "session-gone",
      parentTitle: null,
    });
    expect(batched("session-elsewhere")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
    expect(batched("session-person")).toEqual({ kind: "user" });
    expect(batched("session-board")).toEqual({ kind: "user" });
    expect(batched("session-parent")).toEqual({ kind: "user" });
  });

  // The reason the roster read stays scoped by Ticket rather than matching on
  // the payload alone: a launch event names a Session, and it speaks for that
  // Session only ON THE TICKET IT WAS RECORDED ON.
  //
  // Two things have to be true at once for this to bite, and both are set up
  // here. The Session has NO launch event of its own, so nothing correct can
  // shadow the wrong one; and the roster ALSO holds a Session on the other
  // Ticket, so that Ticket's events are inside the batch's reach. Without the
  // second half the scope check is never reached and the test proves nothing.
  it("ignores a launch event recorded on a Ticket the Session is not on", () => {
    const f = roster();
    f.session("session-moved", "No launch event of its own");
    recordSessionStartedOnce(f.db, {
      ticketId: f.secondTicketId,
      sessionId: "session-moved",
      now: 2_600,
      actor: { kind: "session", sessionId: "session-parent", ticketId: f.secondTicketId },
    });
    const moved = { sessionId: "session-moved", ticketId: f.ticketId };
    const onSecondTicket = { sessionId: "session-elsewhere", ticketId: f.secondTicketId };

    const batched = readSessionProvenances(f.db, [moved, onSecondTicket]);

    expect(batched("session-moved")).toEqual({ kind: "user" });
    expect(batched("session-moved")).toEqual(readSessionProvenance(f.db, moved));
    // The Session that really is on the second Ticket still reads its event, so
    // the scope check rejects the wrong pairing rather than the whole Ticket.
    expect(batched("session-elsewhere")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
  });

  // History outlives the build that wrote it, so a launch event whose payload
  // this build cannot read must cost that one Session its mark and nothing
  // more. `json_extract` answers `null` there, which is why the column is read
  // as `unknown`; the narrowing that follows is what lets the Ticket-scope
  // check take a `string`, and `pnpm typecheck` is what holds it in place.
  // This test holds the half a type cannot: the row neither throws nor
  // disturbs the Sessions beside it.
  it("survives a launch event whose payload names no Session", () => {
    const f = roster();
    recordTicketEvent(f.db, f.ticketId, { kind: "session_started" } as never, 2_700);
    const queries = queriesOf(f);

    const batched = readSessionProvenances(f.db, queries);

    // The unreadable row neither throws nor swallows the Sessions beside it.
    expect(batched("session-child")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
    expect(batched("session-person")).toEqual({ kind: "user" });
    for (const query of queries) {
      expect(batched(query.sessionId)).toEqual(readSessionProvenance(f.db, query));
    }
  });

  // Two launch events for one Session on one Ticket. The question is who
  // STARTED it, so the earliest is the answer — and it is the answer whichever
  // order SQLite returns the rows in, because the batch ranks them rather than
  // taking the first one it sees.
  it("takes the earliest launch event when a Ticket carries more than one", () => {
    const f = roster();
    f.session("session-twice", "Launched twice over");
    recordTicketEvent(
      f.db,
      f.ticketId,
      { kind: "session_started", sessionId: "session-twice" } as never,
      2_800,
      { kind: "session", sessionId: "session-parent", ticketId: f.ticketId },
    );
    recordTicketEvent(
      f.db,
      f.ticketId,
      { kind: "session_started", sessionId: "session-twice" } as never,
      2_900,
      { kind: "automation" },
    );
    const query = { sessionId: "session-twice", ticketId: f.ticketId };

    expect(readSessionProvenances(f.db, [query])("session-twice")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
    expect(readSessionProvenances(f.db, [query])("session-twice")).toEqual(
      readSessionProvenance(f.db, query),
    );
  });

  // `automation_runs.session_id` carries no UNIQUE constraint, so a Session can
  // hold more than one Run row. The earliest names the Run that started it.
  it("takes the earliest Run when a Session carries more than one row", () => {
    const f = roster();
    recordAutomationRun(
      f.db,
      {
        automationId: "automation-2",
        automationName: "A later sweep",
        ticketId: f.ticketId,
        sessionId: "session-run",
        model: MODEL,
      },
      4_000,
    );
    const query = { sessionId: "session-run", ticketId: f.ticketId };

    expect(readSessionProvenances(f.db, [query])("session-run")).toEqual({
      kind: "automation",
      automationName: "Nightly sweep",
    });
    expect(readSessionProvenances(f.db, [query])("session-run")).toEqual(
      readSessionProvenance(f.db, query),
    );
  });

  // `sessions.title` is the fold's seed, written once at mint. A rename is a
  // `session.retitled` fact on the parent's own ledger, so a parent read from
  // the row alone kept the name it was born with while the same listing drew
  // that parent under its current one.
  it("names a parent Session by its current title, not the one it was minted with", () => {
    const f = roster();
    retitle(f.db, "session-parent", "Renamed orchestrator", 1);
    const query = { sessionId: "session-child", ticketId: f.ticketId };

    expect(readSessionProvenances(f.db, [query])("session-child")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Renamed orchestrator",
    });
    expect(readSessionProvenances(f.db, [query])("session-child")).toEqual(
      readSessionProvenance(f.db, query),
    );
  });

  it("takes a parent's last rename, including a rename back to no title", () => {
    const f = roster();
    retitle(f.db, "session-parent", "Renamed once", 1);
    retitle(f.db, "session-parent", null, 2);
    const query = { sessionId: "session-child", ticketId: f.ticketId };

    // `null` is a real projected title, so it must beat the minted one rather
    // than fall back to it.
    expect(readSessionProvenances(f.db, [query])("session-child")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: null,
    });
  });

  it("answers a Session it can find nothing about, and one it was never asked about", () => {
    const f = roster();

    expect(readSessionProvenances(f.db, [{ sessionId: "ghost", ticketId: null }])("ghost")).toEqual(
      { kind: "user" },
    );
    // An empty roster asks nothing and still answers, because the answer for a
    // Session nobody asked about is the resting one.
    expect(readSessionProvenances(f.db, [])("session-run")).toEqual({ kind: "user" });
  });

  it("answers a repeated Session once", () => {
    const f = roster();
    const query = { sessionId: "session-child", ticketId: f.ticketId };

    expect(
      countingStatements(f.db, () => readSessionProvenances(f.db, [query, query, query])),
    ).toBe(countingStatements(f.db, () => readSessionProvenances(f.db, [query])));
    expect(readSessionProvenances(f.db, [query, query, query])("session-child")).toEqual({
      kind: "session",
      parentSessionId: "session-parent",
      parentTitle: "Orchestrator",
    });
  });

  // The point of the batch, pinned as the property rather than as a magic
  // number: the statement count is bounded by the number of durable sources,
  // so it does not move when the roster grows. "One query per Session, after a
  // fold that deliberately yields" is exactly the block VC-392 was filed
  // about, and it would come back invisibly.
  it("reads a roster of any size in the same bounded number of queries", () => {
    const f = roster();
    const small = queriesOf(f);
    // Forty more Sessions, every one of them needing the Ticket lookup.
    const largeIds: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `session-bulk-${index}`;
      f.session(id, `Bulk ${index}`);
      recordSessionStartedOnce(f.db, {
        ticketId: f.ticketId,
        sessionId: id,
        now: 5_000 + index,
        actor: { kind: "session", sessionId: "session-parent", ticketId: f.ticketId },
      });
      largeIds.push(id);
    }
    const large = queriesOf({ db: f.db, sessionIds: [...f.sessionIds, ...largeIds] });

    const batchedSmall = countingStatements(f.db, () => readSessionProvenances(f.db, small));
    const batchedLarge = countingStatements(f.db, () => readSessionProvenances(f.db, large));
    const perSessionLarge = countingStatements(f.db, () => {
      for (const query of large) readSessionProvenance(f.db, query);
    });

    // Five sources, five statements — and 49 Sessions cost exactly what 9 do.
    expect(batchedLarge).toBe(batchedSmall);
    expect(batchedLarge).toBeLessThanOrEqual(5);
    // Where a per-row listing pays per row. Asserted against the roster size
    // rather than a constant, so the gap cannot be closed by shrinking the
    // fixture.
    expect(perSessionLarge).toBeGreaterThanOrEqual(large.length);
    // And the answers do not change with the roster size.
    const batched = readSessionProvenances(f.db, large);
    for (const query of large) {
      expect(batched(query.sessionId)).toEqual(readSessionProvenance(f.db, query));
    }
  });
});
