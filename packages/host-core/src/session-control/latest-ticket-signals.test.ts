import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LatestSessionSignal } from "@volli/shared";
import { MIGRATIONS } from "../db/migrations";
import { insertProject } from "../db/projects-repo";
import { internSessionEventProvenance } from "../db/session-event-provenance";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { withTransaction } from "../db/transaction-gate";
import { createSqliteSessionLedger } from "./sqlite-ledger";

// The canary.5/canary.7 query, retained as an independent equivalence and cost
// baseline. In particular, Session sequence and host acceptance order are NOT
// interchangeable when a raw importer appends out of Session sequence order.
const REFERENCE = `WITH latest_session_signals AS (
  SELECT s.ticket_id, s.id AS session_id,
         json_extract(e.payload, '$.signal') AS signal,
         json_extract(e.payload, '$.reason') AS reason,
         e.occurred_at, es.sequence AS accepted_sequence,
         ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY e.sequence DESC) AS session_rank
    FROM sessions s
    JOIN session_event_sequence es ON es.session_id = s.id AND es.kind = 'session.signaled'
    JOIN session_events e ON e.id = es.event_id
   WHERE s.project_id = @projectId AND s.ticket_id IS NOT NULL
     AND json_extract(e.payload, '$.kind') = 'session.signaled'
     AND json_extract(e.payload, '$.signal') IN ('done', 'blocked')
), latest_ticket_signals AS (
  SELECT ticket_id, session_id, signal, reason, occurred_at,
         ROW_NUMBER() OVER (PARTITION BY ticket_id ORDER BY accepted_sequence DESC) AS ticket_rank
    FROM latest_session_signals WHERE session_rank = 1
)
SELECT ticket_id AS ticketId, session_id AS sessionId, signal, reason, occurred_at AS createdAt
  FROM latest_ticket_signals WHERE ticket_rank = 1 ORDER BY ticket_id COLLATE BINARY ASC`;

let ctx: TestDb;
let provenanceId: number;

beforeEach(() => {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "project" }));
  provenanceId = internSessionEventProvenance(
    ctx.db,
    JSON.stringify({
      source: { kind: "system", id: "test", detail: null },
      venue: { kind: "local", id: "local" },
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

function ticket(id: string, projectId = "project") {
  insertTicket(ctx.db, testTicket(projectId, { id, usesWorktree: false }));
}
function session(id: string, ticketId: string | null, projectId = "project") {
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, role, title, created_at)
       VALUES (?, ?, ?, ?, 'fixture', 1)`,
    )
    .run(id, projectId, ticketId, ticketId === null ? "project" : "ticket");
}
function append(sessionId: string, sequence: number, signal: string, occurredAt = sequence) {
  ctx.db
    .prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, recorded_at, provenance_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${sessionId}:${sequence}`,
      sessionId,
      sequence,
      occurredAt,
      occurredAt,
      provenanceId,
      JSON.stringify({ kind: "session.signaled", signal, reason: null }),
    );
}
function read() {
  return createSqliteSessionLedger(ctx.db).transaction((tx) =>
    tx.listLatestTicketSignals({ projectId: "project" }),
  );
}
function reference(): LatestSessionSignal[] {
  return withTransaction(ctx.db, () =>
    ctx.db.prepare<[Record<string, string>], LatestSessionSignal>(REFERENCE).all({
      projectId: "project",
    }),
  );
}

describe("latest ticket signal seeks (VC-1146)", () => {
  it("preserves both orders, invalid-signal fallback, scope and old-reader results across the index upgrade", async () => {
    // Model the pre-070 schema. The new reader also works on this database.
    ctx.db.exec("DROP INDEX session_events_latest_signal");
    ticket("ticket-a");
    ticket("Ticket-b");
    session("a", "ticket-a");
    session("b", "ticket-a");
    session("c", "Ticket-b");
    session("loose", null);
    insertProject(ctx.db, testProject({ id: "other" }));
    ticket("elsewhere", "other");
    session("elsewhere", "elsewhere", "other");
    append("a", 10, "done", 100);
    append("b", 1, "blocked", 100); // Same clock; accepted later wins.
    append("a", 5, "blocked", 200); // Later accept, but NOT a's latest Session sequence.
    append("a", 11, "unexpected"); // Skip it, retaining a's sequence 10.
    append("c", 1, "done", 500);
    append("c", 2, "blocked", 50); // A clock moving backwards still wins.
    append("loose", 1, "done");
    append("elsewhere", 1, "done");
    const expected = [
      { ticketId: "Ticket-b", sessionId: "c", signal: "blocked", reason: null, createdAt: 50 },
      { ticketId: "ticket-a", sessionId: "b", signal: "blocked", reason: null, createdAt: 100 },
    ];
    expect(reference()).toEqual(expected);
    expect(await read()).toEqual(expected);
    const migration = MIGRATIONS.find(({ version }) => version === 70)!;
    expect(migration.raisesMinReader).not.toBe(true);
    ctx.db.exec(migration.sql);
    expect(await read()).toEqual(expected);
    expect(reference()).toEqual(expected); // An older reader on the indexed database.

    const scoped = createSqliteSessionLedger(ctx.db, {
      predicate: (column) => `${column} = @scopeSession`,
      bindings: { scopeSession: "a" },
    });
    expect(
      await scoped.transaction((tx) => tx.listLatestTicketSignals({ projectId: "project" })),
    ).toEqual([
      { ticketId: "ticket-a", sessionId: "a", signal: "done", reason: null, createdAt: 100 },
    ]);
  });

  it("tracks inserts, payload repairs and deletes without stale cached outcomes", async () => {
    ticket("ticket");
    session("s", "ticket");
    append("s", 1, "done");
    append("s", 2, "unexpected");
    expect(await read()).toEqual(reference());
    expect((await read())[0]?.signal).toBe("done");
    ctx.db
      .prepare("UPDATE session_events SET payload = ? WHERE id = 's:2'")
      .run(JSON.stringify({ kind: "session.signaled", signal: "blocked", reason: "repaired" }));
    expect(await read()).toEqual(reference());
    expect((await read())[0]).toMatchObject({ signal: "blocked", reason: "repaired" });
    ctx.db
      .prepare("UPDATE session_events SET payload = ? WHERE id = 's:2'")
      .run(JSON.stringify({ kind: "session.retitled", title: "not a signal" }));
    expect((await read())[0]?.signal).toBe("done");
    append("s", 3, "blocked");
    expect((await read())[0]?.signal).toBe("blocked");
    ctx.db.prepare("DELETE FROM session_events WHERE id = 's:3'").run();
    expect((await read())[0]?.signal).toBe("done");
    ctx.db.prepare("DELETE FROM sessions WHERE id = 's'").run();
    expect(await read()).toEqual([]);
  });

  it(
    "seeks one indexed candidate per Session on a large profile, with identical results",
    { timeout: 30_000 },
    async () => {
      const ticketCount = 2_000;
      const sessionsPerTicket = 3;
      const eventsPerSession = 24;
      const insertSession = ctx.db.prepare(
        `INSERT INTO sessions (id, project_id, ticket_id, role, title, created_at)
       VALUES (?, 'project', ?, 'ticket', 'fixture', 1)`,
      );
      const insertEvent = ctx.db.prepare(
        `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, recorded_at, provenance_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const payloads = Array.from({ length: eventsPerSession }, (_, index) =>
        JSON.stringify(
          index % 2 === 0
            ? { kind: "session.retitled", title: "unrelated history" }
            : {
                kind: "session.signaled",
                signal: index % 4 === 1 ? "done" : "blocked",
                reason: `signal ${index}`,
              },
        ),
      );
      withTransaction(ctx.db, () => {
        for (let t = 0; t < ticketCount; t += 1) {
          const ticketId = `ticket-${t}`;
          ticket(ticketId);
          for (let s = 0; s < sessionsPerTicket; s += 1) {
            const sessionId = `${ticketId}:s${s}`;
            insertSession.run(sessionId, ticketId);
            for (let e = 0; e < eventsPerSession; e += 1) {
              insertEvent.run(
                `${sessionId}:${e}`,
                sessionId,
                e + 1,
                e,
                e,
                provenanceId,
                payloads[e],
              );
            }
          }
        }
      });
      // Exercise the planner both with and without statistics. Capture the actual
      // production statement, not a second copy of the optimized query.
      const prepare = vi.spyOn(ctx.db, "prepare");
      const first = await read();
      const sql = prepare.mock.calls.find(([statement]) =>
        statement.includes("WITH latest_ticket_signals AS"),
      )![0];
      prepare.mockRestore();
      expect(first).toHaveLength(ticketCount);
      for (const analyze of [false, true]) {
        if (analyze) ctx.db.exec("ANALYZE");
        const plan = ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ projectId: "project" }) as {
          detail: string;
        }[];
        expect(plan.map(({ detail }) => detail).join("\n")).toContain(
          "SEARCH candidate USING INDEX session_events_latest_signal (session_id=?)",
        );
        expect(await read()).toEqual(reference());
      }

      // Informational timings, not a wall-clock assertion on shared CI hardware.
      // The plan assertion above guards the bounded lookup without timing flakes.
      const beforeMs: number[] = [];
      const afterMs: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        let start = performance.now();
        const before = reference();
        beforeMs.push(performance.now() - start);
        start = performance.now();
        const after = await read();
        afterMs.push(performance.now() - start);
        expect(after).toEqual(before);
      }
      console.info("latest-ticket-signals benchmark", {
        tickets: ticketCount,
        sessions: ticketCount * sessionsPerTicket,
        events: ticketCount * sessionsPerTicket * eventsPerSession,
        beforeMs,
        afterMs,
      });
    },
  );
});
