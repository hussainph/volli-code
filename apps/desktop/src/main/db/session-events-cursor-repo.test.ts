import { afterEach, describe, expect, it } from "vite-plus/test";

import { internSessionEventProvenance } from "./session-event-provenance";
import { insertProject } from "./projects-repo";
import {
  currentSessionEventCursor,
  currentSessionEventSequence,
  cursorBeforeSessionCommand,
  cursorBeforeSessionEvents,
  decodeSessionEventCursor,
  encodeSessionEventCursor,
  firstMatchingSessionEventAfter,
  listSessionEventsAfter,
} from "./session-events-cursor-repo";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb | undefined;

afterEach(() => {
  // The pure cursor suite opens no database at all, so this is `undefined`
  // there rather than a fixture nobody used.
  ctx?.cleanup();
  ctx = undefined;
});

/** The open fixture. Every suite that reads it has called {@link setup} first. */
function db(): TestDb["db"] {
  if (ctx === undefined) throw new Error("setup() was not called");
  return ctx.db;
}

const PROVENANCE = JSON.stringify({
  source: { kind: "user", id: "u", detail: null },
  venue: { id: "local", kind: "local" },
});

/** Per-Session `sequence` counters, so a test only says what kind it appended. */
const nextSequence = new Map<string, number>();

function setup(sessionIds: readonly string[]): void {
  ctx = openTestDb();
  nextSequence.clear();
  const project = testProject();
  insertProject(db(), project);
  for (const sessionId of sessionIds) {
    db()
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?, ?, NULL, ?, 1)",
      )
      .run(sessionId, project.id, sessionId);
  }
}

/** Append one durable Session Event the way the ledger does — insert only; the trigger sequences it. */
function append(sessionId: string, payload: Record<string, unknown>, occurredAt = 1): string {
  const sequence = (nextSequence.get(sessionId) ?? 0) + 1;
  nextSequence.set(sessionId, sequence);
  const id = `${sessionId}-e${sequence}`;
  db()
    .prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      id,
      sessionId,
      sequence,
      occurredAt,
      occurredAt,
      internSessionEventProvenance(db(), PROVENANCE),
      JSON.stringify(payload),
    );
  return id;
}

const TURN_KINDS = ["turn.completed", "turn.interrupted"];

describe("the opaque Session Event cursor", () => {
  it("round-trips every sequence it encodes, and refuses everything else", () => {
    expect(decodeSessionEventCursor(encodeSessionEventCursor(0))).toBe(0);
    expect(decodeSessionEventCursor(encodeSessionEventCursor(1))).toBe(1);
    expect(decodeSessionEventCursor(encodeSessionEventCursor(41))).toBe(41);
    expect(decodeSessionEventCursor(encodeSessionEventCursor(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(decodeSessionEventCursor("7")).toBeNull();
    expect(decodeSessionEventCursor("session-event-v1:")).toBeNull();
    expect(decodeSessionEventCursor("session-event-v1:0x1")).toBeNull();
    expect(decodeSessionEventCursor("session-event-v1:01")).toBeNull();
    expect(decodeSessionEventCursor(7)).toBeNull();
    expect(decodeSessionEventCursor(undefined)).toBeNull();
  });

  it("refuses a Ticket cursor, so a cursor handed to the wrong tool is never read as a position", () => {
    // Both encodings are base36 behind a prefix; the prefix is what stops
    // `ticket_await`'s cursor being read as a place in the Session ledger.
    expect(decodeSessionEventCursor("ticket-event-v1:5")).toBeNull();
  });

  it("never encodes a sequence that is not a real position", () => {
    expect(() => encodeSessionEventCursor(-1)).toThrow("Invalid Session Event sequence: -1");
    expect(() => encodeSessionEventCursor(1.5)).toThrow("Invalid Session Event sequence: 1.5");
  });
});

describe("currentSessionEventCursor", () => {
  it("starts at zero on a ledger nothing has been appended to", () => {
    setup(["s-one"]);
    expect(currentSessionEventSequence(db())).toBe(0);
    expect(decodeSessionEventCursor(currentSessionEventCursor(db()))).toBe(0);
  });

  it("does not move backwards when the newest event is deleted", () => {
    setup(["s-one"]);
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t1" });
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t2" });
    const before = currentSessionEventSequence(db());

    db().prepare("DELETE FROM session_events WHERE id = 's-one-e2'").run();

    // AUTOINCREMENT's own mark, not MAX(sequence): a cursor that moved back
    // would replay every fact above it as if it were new.
    expect(currentSessionEventSequence(db())).toBe(before);
  });
});

describe("dispatch cursors", () => {
  it("points before a Session's first event, including after an idempotent replay", () => {
    setup(["s-one", "s-two"]);
    append("s-two", { kind: "session.archived" });
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t1" });

    const cursor = cursorBeforeSessionEvents(db(), "s-one");
    expect(cursor).toBe("session-event-v1:1");
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, cursor!)).toMatchObject({
      event: { payload: { kind: "turn.completed" } },
    });
    expect(cursorBeforeSessionEvents(db(), "missing")).toBeUndefined();
  });

  it("points before a Command even when the turn ends before its receipt is read", () => {
    setup(["s-one"]);
    db()
      .prepare(
        "INSERT INTO session_commands (id, session_id, created_at, intent, route) VALUES ('c-1', 's-one', 1, ?, NULL)",
      )
      .run(JSON.stringify({ kind: "session.archive" }));
    db()
      .prepare(
        `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('command-event', 's-one', 1, 1, 1, ?, NULL, 'c-1', ?)`,
      )
      .run(
        internSessionEventProvenance(db(), PROVENANCE),
        JSON.stringify({ kind: "session.archived" }),
      );
    nextSequence.set("s-one", 1);
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t1" });

    const cursor = cursorBeforeSessionCommand(db(), "s-one", "c-1");
    expect(cursor).toBe("session-event-v1:0");
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, cursor!)).toMatchObject({
      event: { payload: { kind: "turn.completed" } },
    });
    expect(cursorBeforeSessionCommand(db(), "s-one", "missing")).toBeUndefined();
  });
});

describe("firstMatchingSessionEventAfter", () => {
  it("orders facts across Sessions, which per-Session sequences cannot", () => {
    setup(["s-one", "s-two"]);
    // Both Sessions' first event carries `sequence = 1`; only the side table
    // knows s-two's was committed second.
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t1" });
    append("s-two", { kind: "turn.completed", attachmentId: "b", turnId: "t2" });

    const start = encodeSessionEventCursor(0);
    const first = firstMatchingSessionEventAfter(db(), ["s-one", "s-two"], TURN_KINDS, start);
    expect(first?.event.sessionId).toBe("s-one");
    const second = firstMatchingSessionEventAfter(
      db(),
      ["s-one", "s-two"],
      TURN_KINDS,
      first!.cursor,
    );
    expect(second?.event.sessionId).toBe("s-two");
    expect(
      firstMatchingSessionEventAfter(db(), ["s-one", "s-two"], TURN_KINDS, second!.cursor),
    ).toBeUndefined();
  });

  it("matches on the handle set and the kind set together", () => {
    setup(["s-one", "s-two"]);
    append("s-one", { kind: "session.archived" });
    append("s-two", { kind: "turn.completed", attachmentId: "b", turnId: "t2" });
    append("s-one", { kind: "session.signaled", signal: "done", reason: "shipped" });
    const start = encodeSessionEventCursor(0);

    // Right kind, wrong Session.
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, start)).toBeUndefined();
    // Right Session, wrong kind.
    expect(
      firstMatchingSessionEventAfter(db(), ["s-two"], ["session.signaled"], start),
    ).toBeUndefined();

    const match = firstMatchingSessionEventAfter(db(), ["s-one"], ["session.signaled"], start);
    expect(match?.event.payload).toEqual({
      kind: "session.signaled",
      signal: "done",
      reason: "shipped",
    });
  });

  it("replays an event committed between two calls, which is the lossless promise", () => {
    setup(["s-one"]);
    const cursor = currentSessionEventCursor(db());
    // Nothing yet: this is the empty bounded query that makes a waiter park.
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, cursor)).toBeUndefined();

    append("s-one", { kind: "turn.interrupted", attachmentId: "a", turnId: "t1" });

    const replayed = firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, cursor);
    expect(replayed?.event.payload.kind).toBe("turn.interrupted");
  });

  it("answers nothing for an empty watch set, an empty kind set, or a cursor it did not mint", () => {
    setup(["s-one"]);
    append("s-one", { kind: "turn.completed", attachmentId: "a", turnId: "t1" });
    const start = encodeSessionEventCursor(0);
    expect(firstMatchingSessionEventAfter(db(), [], TURN_KINDS, start)).toBeUndefined();
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], [], start)).toBeUndefined();
    expect(firstMatchingSessionEventAfter(db(), ["s-one"], TURN_KINDS, "nonsense")).toBeUndefined();
  });

  it("carries the whole durable envelope, decoded through the shared codec", () => {
    setup(["s-one"]);
    db()
      .prepare(
        `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('e-1', 's-one', 1, 700, 800, ?, NULL, NULL, ?)`,
      )
      .run(
        internSessionEventProvenance(db(), PROVENANCE),
        JSON.stringify({ kind: "session.stopped", reason: "outage", by: { kind: "user" } }),
      );

    const match = firstMatchingSessionEventAfter(
      db(),
      ["s-one"],
      ["session.stopped"],
      encodeSessionEventCursor(0),
    );
    expect(match?.event).toMatchObject({
      id: "e-1",
      sessionId: "s-one",
      sequence: 1,
      occurredAt: 700,
      recordedAt: 800,
      payload: { kind: "session.stopped", reason: "outage", by: { kind: "user" } },
    });
    // Absent rather than null, exactly as the ledger writes it.
    expect(match?.event.attachmentId).toBeUndefined();
    expect(match?.event.commandId).toBeUndefined();
  });
});

describe("listSessionEventsAfter", () => {
  it("returns every Session's events above a mark, in commit order", () => {
    setup(["s-one", "s-two"]);
    append("s-one", { kind: "session.archived" });
    const mark = currentSessionEventSequence(db());
    append("s-two", { kind: "turn.completed", attachmentId: "b", turnId: "t1" });
    append("s-one", { kind: "session.stopped", reason: null, by: { kind: "watchdog" } });

    const events = listSessionEventsAfter(db(), mark);
    expect(events.map(({ event }) => [event.sessionId, event.payload.kind])).toEqual([
      ["s-two", "turn.completed"],
      ["s-one", "session.stopped"],
    ]);
    // Each carries the cursor that follows it, which is what the bus fans out.
    expect(events.map(({ cursor }) => decodeSessionEventCursor(cursor))).toEqual([2, 3]);
  });

  it("is empty when a mutation appended nothing", () => {
    setup(["s-one"]);
    append("s-one", { kind: "session.archived" });
    expect(listSessionEventsAfter(db(), currentSessionEventSequence(db()))).toEqual([]);
  });

  it("carries an attachment and command id when the event has them", () => {
    setup(["s-one"]);
    db()
      .prepare(
        "INSERT INTO session_commands (id, session_id, created_at, intent, route) VALUES ('c-1', 's-one', 1, ?, NULL)",
      )
      .run(JSON.stringify({ kind: "session.archive" }));
    db()
      .prepare(
        `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance_id, attachment_id, command_id, payload)
         VALUES ('e-1', 's-one', 1, 1, 1, ?, NULL, 'c-1', ?)`,
      )
      .run(
        internSessionEventProvenance(db(), PROVENANCE),
        JSON.stringify({ kind: "session.archived" }),
      );

    const [only] = listSessionEventsAfter(db(), 0);
    expect(only?.event.commandId).toBe("c-1");
  });
});
