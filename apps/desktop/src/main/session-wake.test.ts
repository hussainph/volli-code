import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CompleteModelSelectionResult,
  CreateSessionResult,
  SessionEngine,
  SubmitSessionCommandResult,
} from "@volli/session-engine";
import type { SessionEvent, SessionInput } from "@volli/shared";

import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { createSessionWakeBus, type SessionWake } from "./session-wake";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const PROVENANCE = JSON.stringify({
  source: { kind: "user", id: "u", detail: null },
  venue: { id: "local", kind: "local" },
});

const unusedRead = (): never => {
  throw new Error("this test double answers no reads");
};

/**
 * A Session Engine that only writes.
 *
 * Every return value is a stub, and that is the point being tested: the bus
 * reads NOTHING a mutating method returns, because `submit` does not return
 * the `session.signaled` / `session.stopped` event it appends. What it reads
 * is migration 042's sidecar, after the call settles.
 */
function writingEngine(db: TestDb["db"]): {
  engine: SessionEngine;
  /** Appends one durable Session Event, as the ledger would inside a transaction. */
  append: (sessionId: string, payload: Record<string, unknown>) => void;
} {
  let appended = 0;
  const append = (sessionId: string, payload: Record<string, unknown>): void => {
    appended += 1;
    const sequence =
      ((
        db
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
          )
          .get(sessionId) as { sequence: number }
      ).sequence ?? 0) + 1;
    db.prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at, provenance, attachment_id, command_id, payload)
       VALUES (?, ?, ?, 1, 1, ?, NULL, NULL, ?)`,
    ).run(`e-${appended}`, sessionId, sequence, PROVENANCE, JSON.stringify(payload));
  };
  // One distinguishable durable fact per mutating method. Which fact is
  // arbitrary — what is being pinned is that each METHOD announces — so they
  // are the payload shapes that need no nested fixture.
  const engine: SessionEngine = {
    createSession: async () => {
      append("s-one", { kind: "session.archived" });
      return {} as CreateSessionResult;
    },
    getOrRecordSessionInput: async () => {
      append("s-one", { kind: "session.retitled", title: "input" });
      return {} as SessionInput;
    },
    observe: async () => {
      append("s-one", { kind: "turn.completed", attachmentId: "a-1", turnId: "t-1" });
      return {} as SessionEvent;
    },
    submit: async () => {
      append("s-one", { kind: "session.signaled", signal: "done", reason: null });
      return {} as SubmitSessionCommandResult;
    },
    completeModelSelection: async () => {
      append("s-one", { kind: "session.stopped", reason: null, by: { kind: "user" } });
      return {} as CompleteModelSelectionResult;
    },
    getSession: unusedRead,
    getBaseSession: unusedRead,
    listSessions: unusedRead,
    countSessions: unusedRead,
    listSessionStarts: unusedRead,
    listLatestTicketSignals: unusedRead,
    listEvents: unusedRead,
    reportUsage: unusedRead,
  };
  return { engine, append };
}

function setup(): {
  bus: ReturnType<typeof createSessionWakeBus>;
  append: (sessionId: string, payload: Record<string, unknown>) => void;
  wakes: SessionWake[];
  errors: unknown[];
} {
  ctx = openTestDb();
  const project = testProject();
  insertProject(ctx.db, project);
  for (const sessionId of ["s-one", "s-two"]) {
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES (?, ?, NULL, ?, 1)",
      )
      .run(sessionId, project.id, sessionId);
  }
  const errors: unknown[] = [];
  const { engine, append } = writingEngine(ctx.db);
  const bus = createSessionWakeBus(engine, {
    db: ctx.db,
    onError: (error) => errors.push(error),
  });
  const wakes: SessionWake[] = [];
  bus.subscribe((wake) => wakes.push(wake));
  return { bus, append, wakes, errors };
}

/** Every mutating method, called with an argument no double reads. */
const MUTATIONS: ReadonlyArray<[name: string, call: (engine: SessionEngine) => Promise<unknown>]> =
  [
    ["createSession", (engine) => engine.createSession({} as never)],
    ["getOrRecordSessionInput", (engine) => engine.getOrRecordSessionInput({} as never)],
    ["observe", (engine) => engine.observe({} as never)],
    ["submit", (engine) => engine.submit({} as never)],
    ["completeModelSelection", (engine) => engine.completeModelSelection({} as never)],
  ];

describe("the Session wake bus", () => {
  it("fans out after every mutating method, including the one whose event is never returned", async () => {
    const { bus, wakes } = setup();
    for (const [, call] of MUTATIONS) await call(bus.engine);

    // `submit`'s `session.signaled` is the load-bearing one: the engine
    // appends it and hands back only the command and receipt events.
    expect(wakes.map(({ event }) => event.payload.kind)).toEqual([
      "session.archived",
      "session.retitled",
      "turn.completed",
      "session.signaled",
      "session.stopped",
    ]);
  });

  it("carries the durable event and the cursor after it, not a hint to re-read", async () => {
    const { bus, wakes } = setup();
    await bus.engine.observe({} as never);

    const [only] = wakes;
    expect(only?.event.sessionId).toBe("s-one");
    expect(only?.event.payload).toEqual({
      kind: "turn.completed",
      attachmentId: "a-1",
      turnId: "t-1",
    });
    expect(only?.cursor).toBe("session-event-v1:1");
  });

  it("announces every event a single write appended, un-coalesced and in ledger order", async () => {
    const { bus, append, wakes } = setup();
    // One turn boundary writes several facts; a waiter must see each of them,
    // which is exactly what `activity-watch.ts`'s 60ms coalescing cannot do.
    const engine = bus.engine;
    await engine.observe({} as never);
    append("s-two", { kind: "turn.interrupted", attachmentId: "a-2", turnId: "t-2" });
    append("s-one", { kind: "session.stopped", reason: null, by: { kind: "watchdog" } });
    await engine.observe({} as never);

    expect(wakes.map(({ event }) => [event.sessionId, event.payload.kind])).toEqual([
      ["s-one", "turn.completed"],
      ["s-two", "turn.interrupted"],
      ["s-one", "session.stopped"],
      ["s-one", "turn.completed"],
    ]);
  });

  it("announces each committed event exactly once, even when two writes interleave", async () => {
    const { bus, wakes } = setup();
    // Two decorated calls overlapping at an await boundary: the mark lives on
    // the bus, so whichever drains first claims the rows.
    await Promise.all([bus.engine.observe({} as never), bus.engine.submit({} as never)]);

    expect(wakes.map(({ cursor }) => cursor)).toEqual(["session-event-v1:1", "session-event-v1:2"]);
  });

  it("replays nothing that was already durable when the process started", () => {
    ctx = openTestDb();
    const project = testProject();
    insertProject(ctx.db, project);
    ctx.db
      .prepare(
        "INSERT INTO sessions (id, project_id, ticket_id, title, created_at) VALUES ('s-one', ?, NULL, 'One', 1)",
      )
      .run(project.id);
    const { engine, append } = writingEngine(ctx.db);
    append("s-one", { kind: "turn.completed", attachmentId: "a-1", turnId: "t-1" });

    const bus = createSessionWakeBus(engine, { db: ctx.db });
    const wakes: SessionWake[] = [];
    bus.subscribe((wake) => wakes.push(wake));

    // A relaunch is not an event storm: the mark is seeded at construction.
    expect(wakes).toEqual([]);
  });

  it("announces what a failed write committed before it threw", async () => {
    const { bus, wakes } = setup();
    const engine = createSessionWakeBus(
      {
        ...bus.engine,
        observe: async () => {
          // A command that committed one transaction and then failed. The
          // fact is durably in the log whatever the caller was told.
          bus.engine.observe({} as never);
          throw new Error("the runtime went away");
        },
      },
      { db: ctx.db },
    );
    await expect(engine.engine.observe({} as never)).rejects.toThrow("the runtime went away");

    expect(wakes.map(({ event }) => event.payload.kind)).toEqual(["turn.completed"]);
  });

  it("does not let a throwing listener fail the write, or starve the next listener", async () => {
    const { bus, errors } = setup();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("a waiter blew up");
    });
    bus.subscribe(() => seen.push("after"));

    await expect(bus.engine.observe({} as never)).resolves.toBeDefined();
    expect(seen).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("a waiter blew up");
  });

  it("reports a failed drain and announces those events on the next write", async () => {
    const { bus, append, wakes, errors } = setup();
    append("s-one", { kind: "turn.completed", attachmentId: "a-1", turnId: "t-1" });
    // Corruption inside a known kind: loud on read, by CLAUDE.md's rule. A
    // drain that cannot answer must still not fail the write it followed.
    ctx.db
      .prepare(
        "UPDATE session_events SET payload = '{\"kind\":\"turn.completed\"}' WHERE id = 'e-1'",
      )
      .run();

    await expect(bus.engine.submit({} as never)).resolves.toBeDefined();
    expect(errors).toHaveLength(1);
    expect(wakes).toEqual([]);

    ctx.db
      .prepare("UPDATE session_events SET payload = ? WHERE id = 'e-1'")
      .run(JSON.stringify({ kind: "turn.completed", attachmentId: "a-1", turnId: "t-1" }));
    await bus.engine.observe({} as never);

    // The mark never moved, so the events the failed drain could not read are
    // announced by the next one rather than lost.
    expect(wakes.map(({ event }) => event.payload.kind)).toEqual([
      "turn.completed",
      "session.signaled",
      "turn.completed",
    ]);
  });

  it("stops delivering to a listener that unsubscribed", async () => {
    const { bus } = setup();
    const listener = vi.fn();
    const off = bus.subscribe(listener);
    await bus.engine.observe({} as never);
    off();
    await bus.engine.observe({} as never);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("forwards every read method to the engine it wrapped", () => {
    ctx = openTestDb();
    const reads = {
      getSession: vi.fn(),
      getBaseSession: vi.fn(),
      listSessions: vi.fn(),
      countSessions: vi.fn(),
      listSessionStarts: vi.fn(),
      listLatestTicketSignals: vi.fn(),
      listEvents: vi.fn(),
      reportUsage: vi.fn(),
    };
    const { engine } = writingEngine(ctx.db);
    const bus = createSessionWakeBus({ ...engine, ...reads } as SessionEngine, { db: ctx.db });

    // Forwarded by hand rather than spread, so a new engine method is a
    // compile error here instead of a silently missing forward.
    void bus.engine.getSession({ sessionId: "s" });
    void bus.engine.getBaseSession({ sessionId: "s" });
    void bus.engine.listSessions({} as never);
    void bus.engine.countSessions({} as never);
    void bus.engine.listSessionStarts({} as never);
    void bus.engine.listLatestTicketSignals({} as never);
    void bus.engine.listEvents({} as never);
    void bus.engine.reportUsage({} as never);
    for (const read of Object.values(reads)) expect(read).toHaveBeenCalledTimes(1);
  });
});
