import { afterEach, describe, expect, it } from "vite-plus/test";
import { emptySessionFollowUpState } from "@volli/session-engine";
import { createTestSessionEngine } from "../testing/session-engine";
import { insertProject } from "./projects-repo";
import { createSqliteSessionFollowUpLedger } from "./session-follow-up-repo";
import { SESSION_FOLLOW_UP_MIGRATION } from "./session-follow-up-migration";
import { SESSION_FOLLOW_UP_IDENTITIES_MIGRATION } from "./session-follow-up-identities-migration";
import { MIGRATIONS, migrate } from "./migrations";
import { readMinReaderVersion } from "./schema-compatibility";
import { openRawDb, openTestDb, testProject, type TestDb } from "./test-helpers";
import { readPreviousFollowUpState } from "./fixtures/follow-up-reader-v0-2-2-canary-1";

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

  // Rollback and the synchronous-work refusal are the shared contract's
  // (session-follow-up-repo.contract.test.ts). Storing nothing for a state no
  // writer changed, and leaving no transaction open, are this adapter's own.
  it("writes no row for an unchanged state and leaves no transaction open after a failure", async () => {
    const f = await setup();
    expect(await f.ledger.transaction(f.sessionId, (state) => state.revision)).toBe(0);
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual([]);
    await expect(
      f.ledger.transaction(f.sessionId, (state) => {
        state.revision = 1;
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect(f.db.prepare("SELECT * FROM session_follow_up_queue").all()).toEqual([]);
    expect(f.db.inTransaction).toBe(false);
  });

  it("uses deferred snapshot reads while another connection holds the writer lock, with no writes", async () => {
    const f = await setup();
    f.db.pragma("journal_mode = WAL");
    const encoded = JSON.stringify({ ...emptySessionFollowUpState(), revision: 1 });
    f.db
      .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
      .run(f.sessionId, encoded, 0);
    const before = f.db.prepare("SELECT total_changes() AS changes").get();
    const second = openRawDb(fixture!.dbPath);
    try {
      second.exec("BEGIN IMMEDIATE");
      const read = await f.ledger.transaction(
        f.sessionId,
        (state) => {
          state.revision = 99;
          return state.revision;
        },
        { mode: "read" },
      );
      expect(read).toBe(99);
      expect(await f.ledger.pendingSessionIds()).toEqual([]);
      expect(f.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      expect(f.db.prepare("SELECT state FROM session_follow_up_queue").get()).toEqual({
        state: encoded,
      });
      expect(f.db.inTransaction).toBe(false);
    } finally {
      second.exec("ROLLBACK");
      second.close();
    }
  });

  it("reads legacy release history without rewriting it, but writes the N−1-required empty record", async () => {
    const f = await setup();
    const legacy = {
      ...emptySessionFollowUpState(),
      revision: 1,
      releases: { old: { command: {}, receipt: {} } },
    };
    f.db
      .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
      .run(f.sessionId, JSON.stringify(legacy), 0);
    expect(
      await f.ledger.transaction(f.sessionId, (state) => Object.keys(state.releases), {
        mode: "read",
      }),
    ).toEqual(["old"]);
    await f.ledger.transaction(f.sessionId, (state) => {
      state.revision += 1;
      state.entries.push({
        id: "kept",
        commandId: "pending",
        deliveryCommandId: "delivery-pending",
        state: "queued",
        message: { id: "kept", role: "user", parts: [] },
      });
      const old = Date.now() - 8 * 24 * 60 * 60_000;
      for (let i = 0; i < 70; i++) {
        const id = `settled-${i}`;
        state.commands[id] = {
          signature: id,
          result: {
            sessionId: f.sessionId,
            command: {
              id,
              sessionId: f.sessionId,
              createdAt: old + i,
              route: null,
              intent: { kind: "message.cancel", messageId: id },
            },
            receipt: {
              id,
              commandId: id,
              status: "accepted",
              acceptedAt: old + i,
              recordedAt: old + i,
              sequence: 0,
              result: { kind: "message.submitted", sessionId: f.sessionId },
            },
            throughSequence: 0,
            refusal: null,
          },
        };
      }
    });
    const stored = JSON.parse(
      (f.db.prepare("SELECT state FROM session_follow_up_queue").get() as { state: string }).state,
    );
    // The previous reader requires a record here, not an omitted field/null.
    expect(Object.hasOwn(stored, "releases")).toBe(true);
    expect(stored.releases).toEqual({});
    expect(Object.keys(stored.commands)).toHaveLength(64);
    expect(stored.entries).toMatchObject([{ id: "kept", state: "queued" }]);
    expect(readPreviousFollowUpState(JSON.stringify(stored))).toEqual(stored);
    expect(() =>
      readPreviousFollowUpState(JSON.stringify({ ...stored, releases: undefined })),
    ).toThrow("unsupported");
    expect(
      await createSqliteSessionFollowUpLedger(f.db).transaction(f.sessionId, (state) => state, {
        mode: "read",
      }),
    ).toEqual(stored);
  });

  it("adds an N−1-safe identity index and atomically backfills older queue replies before pruning", async () => {
    const f = await setup();
    f.db.exec("DROP TABLE session_follow_up_identities");
    f.db.pragma("user_version = 66");
    f.db.prepare("DELETE FROM migration_history WHERE version = 67").run();
    const floor = readMinReaderVersion(f.db);
    const history = await f.engine.getSession({ sessionId: f.sessionId });
    const legacy = emptySessionFollowUpState();
    legacy.revision = 1;
    const old = Date.now() - 8 * 24 * 60 * 60_000;
    for (let i = 0; i < 70; i++) {
      const id = `queue-${i}`;
      legacy.commands[id] = {
        signature: id,
        result: {
          sessionId: f.sessionId,
          command: {
            id,
            sessionId: f.sessionId,
            createdAt: old + i,
            route: null,
            intent: {
              kind: "message.queue",
              message: { id: `message-${i}`, role: "user", parts: [] },
            },
          },
          receipt: {
            id,
            commandId: id,
            status: "accepted",
            acceptedAt: old + i,
            recordedAt: old + i,
            sequence: 0,
            result: { kind: "message.submitted", sessionId: f.sessionId },
          },
          throughSequence: 0,
          refusal: null,
        },
      };
    }
    f.db
      .prepare("INSERT INTO session_follow_up_queue VALUES (?, ?, ?)")
      .run(f.sessionId, JSON.stringify(legacy), 0);
    expect(migrate(f.db, fixture!.dbPath)).toBe(true);
    expect(MIGRATIONS.find(({ version }) => version === 67)).toMatchObject({
      sql: SESSION_FOLLOW_UP_IDENTITIES_MIGRATION,
    });
    expect(MIGRATIONS.find(({ version }) => version === 67)?.raisesMinReader).toBeUndefined();
    expect(readMinReaderVersion(f.db)).toBe(floor);
    expect(f.db.prepare("SELECT * FROM session_follow_up_identities").all()).toEqual([]);
    await expect(
      f.ledger.transaction(f.sessionId, (state) => {
        state.revision++;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(f.db.prepare("SELECT * FROM session_follow_up_identities").all()).toEqual([]);
    expect(
      await f.ledger.transaction(f.sessionId, (state) => Object.keys(state.commands).length, {
        mode: "read",
      }),
    ).toBe(70);
    await f.ledger.transaction(f.sessionId, (state) => {
      state.revision++;
    });
    expect(
      await f.ledger.transaction(f.sessionId, (state) => Object.keys(state.commands).length, {
        mode: "read",
      }),
    ).toBe(70);
    expect(
      await f.ledger.transaction(f.sessionId, (state) => state.commands["queue-0"]?.signature, {
        mode: "read",
      }),
    ).not.toBe("queue-0");
    const second = openRawDb(fixture!.dbPath);
    try {
      const reopened = createSqliteSessionFollowUpLedger(second);
      expect(
        await reopened.transaction(
          f.sessionId,
          (_state, _proof, queued) => [queued?.("message-0"), queued?.("never-queued")],
          { mode: "read" },
        ),
      ).toEqual([true, false]);
    } finally {
      second.close();
    }
    expect(
      f.db.prepare("SELECT COUNT(*) AS count FROM session_follow_up_identities").get(),
    ).toEqual({ count: 70 });
    f.db.exec(SESSION_FOLLOW_UP_IDENTITIES_MIGRATION);
    expect(migrate(f.db, fixture!.dbPath)).toBe(false);
    expect(await f.engine.getSession({ sessionId: f.sessionId })).toEqual(history);
    f.db.prepare("DELETE FROM sessions WHERE id = ?").run(f.sessionId);
    expect(f.db.prepare("SELECT * FROM session_follow_up_identities").all()).toEqual([]);
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
  it.each(["error", "info"] as const)(
    "keeps %s diagnostics cheap and non-fatal without weakening withdrawal proof",
    async (level) => {
      const f = await setup();
      const claimed = {
        id: "message",
        commandId: "queued",
        deliveryCommandId: "delivery",
        state: "releasing" as const,
        message: { id: "message", role: "user" as const, parts: [] },
      };
      await f.ledger.transaction(f.sessionId, (state) => {
        state.entries = [claimed];
        state.revision = 1;
      });
      let evidenceReads = 0;
      const failing = new Proxy(f.db, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (sql.includes("session_events")) {
                evidenceReads++;
                throw new Error("evidence decoder unavailable");
              }
              return target.prepare(sql);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const ledger = createSqliteSessionFollowUpLedger(failing);
      const { installHostLog } = await import("../log/root");
      const records: unknown[] = [];
      const undo = installHostLog({ level, sink: { write: (record) => records.push(record) } });
      try {
        await expect(
          ledger.transaction(f.sessionId, (state) => {
            state.entries = [];
            state.revision++;
            return "committed";
          }),
        ).resolves.toBe("committed");
        expect(evidenceReads).toBe(0);
        expect(records).toMatchObject(level === "info" ? [{ msg: "follow-up withdrawn" }] : []);
        expect(
          await ledger.transaction(f.sessionId, (state) => state.entries, { mode: "read" }),
        ).toEqual([]);
        await ledger.transaction(f.sessionId, (state) => {
          state.entries = [claimed];
          state.revision++;
        });
        // Unlike diagnostics, a proof that authorizes a withdrawal must fail
        // closed. A decoder failure cannot authorize removal of a live claim.
        await expect(
          ledger.transaction(f.sessionId, (state, proof) => {
            if (!proof!("delivery")) state.entries = [];
          }),
        ).rejects.toThrow("evidence decoder unavailable");
        expect(
          await ledger.transaction(f.sessionId, (state) => state.entries.length, { mode: "read" }),
        ).toBe(1);
      } finally {
        undo();
      }
    },
  );

  it("does not reject a committed queue mutation when the diagnostic sink throws", async () => {
    const f = await setup();
    await f.ledger.transaction(f.sessionId, (state) => {
      state.entries = [
        {
          id: "message",
          commandId: "queued",
          deliveryCommandId: "delivery",
          state: "queued",
          message: { id: "message", role: "user", parts: [] },
        },
      ];
      state.revision = 1;
    });
    const { installHostLog } = await import("../log/root");
    const undo = installHostLog({
      level: "info",
      sink: {
        write: () => {
          throw new Error("sink unavailable");
        },
      },
    });
    try {
      await expect(
        f.ledger.transaction(f.sessionId, (state) => {
          state.entries = [];
          state.revision++;
          return "committed";
        }),
      ).resolves.toBe("committed");
      expect(
        await f.ledger.transaction(f.sessionId, (state) => state.entries, { mode: "read" }),
      ).toEqual([]);
    } finally {
      undo();
    }
  });

  it("logs committed removal dispositions from ephemeral transaction outcomes, never history reads", async () => {
    const f = await setup();
    await f.ledger.transaction(f.sessionId, (state) => {
      state.entries = ["delivered", "withdrawn"].map((id) => ({
        id,
        commandId: `queue-${id}`,
        deliveryCommandId: `delivery-${id}`,
        state: "queued" as const,
        message: { id, role: "user" as const, parts: [{ type: "text" as const, text: "private" }] },
      }));
      state.revision = 1;
    });
    const accepted = await f.engine.submit({
      commandId: "delivery-delivered",
      sessionId: f.sessionId,
      intent: { kind: "session.retitle", title: "Accepted" },
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
    });
    const { installHostLog } = await import("../log/root");
    const records: Record<string, unknown>[] = [];
    const undo = installHostLog({
      level: "info",
      sink: { write: (record) => records.push(record) },
    });
    try {
      await expect(
        f.ledger.transaction(f.sessionId, (state) => {
          state.entries = [];
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(records).toEqual([]);
      await f.ledger.transaction(f.sessionId, (state) => {
        state.entries = [];
        state.releases["delivery-delivered"] = {
          command: accepted.command,
          receipt: accepted.receipt!,
        };
        state.revision += 1;
      });
      expect(records.map(({ msg, messageId }) => [msg, messageId])).toEqual([
        ["follow-up delivered", "delivered"],
        ["follow-up withdrawn", "withdrawn"],
      ]);
      expect(
        await f.ledger.transaction(f.sessionId, (state) => state.releases, { mode: "read" }),
      ).toEqual({});
    } finally {
      undo();
    }
  });

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
          releases: {},
          entries: [
            entry("queued", "new"),
            entry("releasing", "claimed"),
            entry("queued", "returned"),
            entry("queued", "unchanged"),
          ],
        } as never,
        new Map([["d-delivered", { status: "accepted" } as never]]),
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

describe("launch-scoped follow-up storage", () => {
  it("enumerates only owned queues and rejects foreign queue reads/mutations before decoding", async () => {
    const f = await setup();
    const other = await f.engine.createSession({
      commandId: "other",
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
    for (const sessionId of [f.sessionId, other.session.id])
      await f.ledger.transaction(sessionId, (state) => {
        state.revision = 1;
        state.entries.push({
          id: sessionId,
          commandId: `queue-${sessionId}`,
          deliveryCommandId: `delivery-${sessionId}`,
          state: "queued",
          message: { id: sessionId, role: "user", parts: [{ type: "text", text: "queue" }] },
        });
      });
    const scoped = createSqliteSessionFollowUpLedger(f.db, (id) => id === f.sessionId);
    expect(await scoped.pendingSessionIds()).toEqual([f.sessionId]);
    f.db
      .prepare("UPDATE session_follow_up_queue SET state = '{}' WHERE session_id = ?")
      .run(other.session.id);
    let called = false;
    await expect(
      scoped.transaction(other.session.id, () => {
        called = true;
      }),
    ).rejects.toThrow("outside this launch");
    expect(called).toBe(false);
    expect(
      f.db
        .prepare("SELECT state FROM session_follow_up_queue WHERE session_id = ?")
        .get(other.session.id),
    ).toEqual({ state: "{}" });
    expect(await scoped.transaction(f.sessionId, (state) => state.entries.length)).toBe(1);
  });
});
