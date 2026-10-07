import { afterEach, describe, expect, it } from "vite-plus/test";
import { emptySessionFollowUpState } from "@volli/session-engine";
import { createTestSessionEngine } from "../testing/session-engine";
import { insertProject } from "./projects-repo";
import { createSqliteSessionFollowUpLedger } from "./session-follow-up-repo";
import { SESSION_FOLLOW_UP_MIGRATION } from "./session-follow-up-migration";
import { MIGRATIONS, migrate } from "./migrations";
import { readMinReaderVersion } from "./schema-compatibility";
import { openRawDb, openTestDb, testProject, type TestDb } from "./test-helpers";

let fixture: TestDb | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});
async function setup() {
  fixture = openTestDb();
  const db = fixture.db;
  insertProject(db, testProject({ id: "project" }));
  let sequence = 0;
  const engine = createTestSessionEngine(db, { now: () => 100, nextId: () => `id-${++sequence}` });
  const created = await engine.createSession({
    commandId: "create",
    projectId: "project",
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: null,
    provenance: {
      source: { kind: "system", id: "test", detail: null },
      venue: { id: "local", kind: "local" },
    },
  });
  return {
    db,
    engine,
    sessionId: created.session.id,
    ledger: createSqliteSessionFollowUpLedger(db),
  };
}

describe("durable host follow-up storage", () => {
  it("persists pending payloads/claims across a second DB reader without changing event history", async () => {
    const f = await setup();
    const history = await f.engine.getSession({ sessionId: f.sessionId });
    await f.ledger.transaction(f.sessionId, (state) => {
      state.entries.push({
        id: "message",
        commandId: "queued",
        message: { id: "message", role: "user", parts: [{ type: "text", text: "Follow up" }] },
        state: "releasing",
        deliveryCommandId: "delivery",
      });
      state.entries.push({
        id: "message-2",
        commandId: "queued-2",
        message: {
          id: "message-2",
          role: "user",
          parts: [{ type: "text", text: "Another payload" }],
        },
        state: "queued",
        deliveryCommandId: "delivery-2",
      });
      state.revision = 1;
      state.releasedBoundary = "idle:turn";
    });
    const second = openRawDb(fixture!.dbPath);
    try {
      const reopened = createSqliteSessionFollowUpLedger(second);
      expect(await reopened.pendingSessionIds()).toEqual([f.sessionId]);
      expect(await reopened.transaction(f.sessionId, (state) => state.entries)).toMatchObject([
        {
          commandId: "queued",
          deliveryCommandId: "delivery",
          state: "releasing",
          message: { id: "message" },
        },
        {
          commandId: "queued-2",
          deliveryCommandId: "delivery-2",
          state: "queued",
          message: { id: "message-2" },
        },
      ]);
      expect(await reopened.transaction(f.sessionId, (state) => state.releasedBoundary)).toBe(
        "idle:turn",
      );
    } finally {
      second.close();
    }
    expect(await f.engine.getSession({ sessionId: f.sessionId })).toEqual(history);
  });

  it("rolls back failed work and refuses async transactions without partial writes", async () => {
    const f = await setup();
    expect(await f.ledger.transaction(f.sessionId, (state) => state.revision)).toBe(0);
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual([]);
    await expect(
      f.ledger.transaction(f.sessionId, (state) => {
        state.revision = 1;
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    await expect(
      f.ledger.transaction(f.sessionId, (() => Promise.resolve("not synchronous")) as never),
    ).rejects.toThrow("must be synchronous");
    expect(await f.ledger.transaction(f.sessionId, (state) => state.revision)).toBe(0);
    expect(f.db.inTransaction).toBe(false);
  });

  it("fails loudly on unsupported/corrupt state and cascades only with its Session", async () => {
    const f = await setup();
    f.db
      .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
      .run(f.sessionId, '{"version":99}', 0);
    await expect(f.ledger.transaction(f.sessionId, (state) => state)).rejects.toThrow(
      "unsupported",
    );
    f.db.prepare("UPDATE session_follow_up_queue SET state = ?").run("null");
    await expect(f.ledger.transaction(f.sessionId, (state) => state)).rejects.toThrow(
      "Invalid follow-up ledger state",
    );
    expect(() =>
      f.db.prepare("UPDATE session_follow_up_queue SET state = ?").run("bad-json"),
    ).toThrow();
    expect(() =>
      f.db.prepare("UPDATE session_follow_up_queue SET pending_count = -1").run(),
    ).toThrow();
    f.db.prepare("DELETE FROM sessions WHERE id = ?").run(f.sessionId);
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual([]);
  });

  it.each(["id", "commandId", "deliveryCommandId"] as const)(
    "rejects duplicate %s before recovery can settle either payload",
    async (field) => {
      const f = await setup();
      const state = emptySessionFollowUpState();
      state.revision = 1;
      state.entries = [1, 2].map((index) => ({
        id: `message-${index}`,
        commandId: `queued-${index}`,
        deliveryCommandId: `delivery-${index}`,
        // One claim only, so the duplicate check is the one that refuses.
        state: index === 1 ? "releasing" : "queued",
        message: {
          id: `message-${index}`,
          role: "user",
          parts: [{ type: "text", text: `Payload ${index}` }],
        },
      }));
      state.entries[1]![field] = state.entries[0]![field];
      // Keep the message/entry identity invariant valid to isolate the duplicate check.
      state.entries[1]!.message.id = state.entries[1]!.id;
      const encoded = JSON.stringify(state);
      f.db
        .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
        .run(f.sessionId, encoded, 2);
      let recoveryCalled = false;
      await expect(
        f.ledger.transaction(f.sessionId, (stored) => {
          recoveryCalled = true;
          stored.entries = [];
        }),
      ).rejects.toThrow(`Duplicate follow-up ledger ${field}`);
      expect(recoveryCalled).toBe(false);
      expect(
        f.db.prepare("SELECT state, pending_count FROM session_follow_up_queue").get(),
      ).toEqual({ state: encoded, pending_count: 2 });
      expect(f.db.inTransaction).toBe(false);
    },
  );

  it("rejects a second releasing claim before recovery can resume either one", async () => {
    const f = await setup();
    const state = emptySessionFollowUpState();
    state.revision = 1;
    state.entries = [1, 2].map((index) => ({
      id: `message-${index}`,
      commandId: `queued-${index}`,
      deliveryCommandId: `delivery-${index}`,
      state: "releasing" as const,
      message: {
        id: `message-${index}`,
        role: "user" as const,
        parts: [{ type: "text" as const, text: `Payload ${index}` }],
      },
    }));
    const encoded = JSON.stringify(state);
    f.db
      .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
      .run(f.sessionId, encoded, 2);
    let recoveryCalled = false;
    await expect(
      f.ledger.transaction(f.sessionId, (stored) => {
        recoveryCalled = true;
        stored.entries = [];
      }),
    ).rejects.toThrow("More than one releasing follow-up ledger entry");
    expect(recoveryCalled).toBe(false);
    expect(f.db.prepare("SELECT state, pending_count FROM session_follow_up_queue").get()).toEqual({
      state: encoded,
      pending_count: 2,
    });
    expect(f.db.inTransaction).toBe(false);
  });

  it("upgrades a v60 Session history without the new table and leaves the reader floor unchanged", async () => {
    const f = await setup();
    // This throwaway fixture models a pre-queue database, not a real profile.
    f.db.exec("DROP TABLE session_follow_up_queue");
    f.db.pragma("user_version = 60");
    f.db.prepare("DELETE FROM migration_history WHERE version = 61").run();
    const history = await f.engine.getSession({ sessionId: f.sessionId });
    const floor = readMinReaderVersion(f.db);
    expect(migrate(f.db, fixture!.dbPath)).toBe(true);
    expect(readMinReaderVersion(f.db)).toBe(floor);
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual([]);
    expect(await f.engine.getSession({ sessionId: f.sessionId })).toEqual(history);
  });

  it("migration 061 is expand-only and idempotent, preserving v60 Session histories and reader floor", async () => {
    const f = await setup();
    const migration = MIGRATIONS.find(({ version }) => version === 61)!;
    expect(migration.sql).toBe(SESSION_FOLLOW_UP_MIGRATION);
    expect(migration.raisesMinReader).toBeUndefined();
    const history = await f.engine.getSession({ sessionId: f.sessionId });
    const floor = readMinReaderVersion(f.db);
    await f.ledger.transaction(f.sessionId, (state) => {
      state.revision = 1;
    });
    const rows = f.db.prepare("SELECT * FROM session_follow_up_queue").all();
    f.db.pragma("user_version = 60");
    expect(migrate(f.db, fixture!.dbPath)).toBe(true);
    expect(readMinReaderVersion(f.db)).toBe(floor);
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual(rows);
    expect(await f.engine.getSession({ sessionId: f.sessionId })).toEqual(history);
    expect(f.db.pragma("foreign_key_check")).toEqual([]);
    expect(migrate(f.db, fixture!.dbPath)).toBe(false);
  });
});

function row(state: "queued" | "releasing", id: string) {
  return { state, commandId: `c-${id}`, deliveryCommandId: `d-${id}` };
}

function entry(state: "queued" | "releasing", id: string) {
  return {
    id,
    ...row(state, id),
    message: { id, role: "user", parts: [{ type: "text", text: "private words" }] },
  };
}

describe("queue transitions as log lines (VC-699)", () => {
  it("says what happened to each message and why, by identifiers only", async () => {
    const { installHostLog } = await import("../log/root");
    const { logQueueChanges } = await import("./session-follow-up-repo");
    const records: Record<string, unknown>[] = [];
    const undo = installHostLog({
      level: "info",
      sink: { write: (record) => records.push(record) },
    });
    try {
      logQueueChanges(
        "s-1",
        new Map([
          ["claimed", row("queued", "claimed")],
          ["returned", row("releasing", "returned")],
          ["delivered", row("releasing", "delivered")],
          ["withdrawn", row("queued", "withdrawn")],
          ["unchanged", row("queued", "unchanged")],
        ]),
        {
          version: 1,
          revision: 7,
          releasedBoundary: "idle:turn-1",
          commands: {},
          releases: { "d-delivered": { command: {}, receipt: { status: "accepted" } } },
          entries: [
            entry("queued", "new"),
            entry("releasing", "claimed"),
            entry("queued", "returned"),
            entry("queued", "unchanged"),
          ],
        } as never,
      );
    } finally {
      undo();
    }
    expect(records.map(({ msg, messageId, reason }) => [msg, messageId, reason])).toEqual([
      ["follow-up queued", "new", undefined],
      ["follow-up release claimed", "claimed", "idle-boundary"],
      ["follow-up claim returned", "returned", "not-sent"],
      ["follow-up delivered", "delivered", undefined],
      ["follow-up withdrawn", "withdrawn", "cancelled"],
    ]);
    expect(records[1]).toMatchObject({
      boundary: "idle:turn-1",
      revision: 7,
      pending: 4,
      sessionId: "s-1",
    });
    expect(records[3]).toMatchObject({ status: "accepted", deliveryCommandId: "d-delivered" });
    expect(JSON.stringify(records)).not.toContain("private words");
  });
});
