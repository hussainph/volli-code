import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_RUNNER, createSessionProjectionCheckpoint } from "@volli/shared";
import type { SessionEngine } from "@volli/session-engine";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createHostSessionEngine } from "../sessions/engine";
import { createFactDrain } from "../cloud-runner/drain";
import { seedMovedSessionCursors, sqliteDrainCursorStore } from "../cloud-runner/sqlite-stores";
import { sqliteDrainLedger } from "../session-control/sqlite-ledger";
import { createCloudSessionOwner, createLocalSessionEngine, SessionOwnerError } from "./owner";
import { localSessionRow } from "../db/local-product";

let ctx: TestDb | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  ctx?.cleanup();
  ctx = undefined;
});
const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: LOCAL_RUNNER,
};

function setup() {
  ctx = openTestDb();
  const { db } = ctx;
  insertProject(db, testProject({ id: "p" }));
  insertTicket(db, testTicket("p", { id: "t" }));
  let sequence = 0;
  const wake = createSessionWakeBus(
    createHostSessionEngine(createSqliteSessionLedger(db), {
      nextId: () => `id-${++sequence}`,
      now: () => ++sequence,
    }),
    { db },
  );
  const cursors = sqliteDrainCursorStore(db);
  const owner = (ownerUserId: string) => {
    const drain = createFactDrain({
      ownerUserId,
      cursors,
      ledger: { listEvents: () => [], latestEventSequence: () => 0 },
      accept: vi.fn(),
    });
    return createCloudSessionOwner({ db, engine: wake.engine, ownerUserId, adopt: drain.adopt });
  };
  const a = owner("a");
  const b = owner("b");
  const local = createLocalSessionEngine({ db, engine: wake.engine });
  const create = (engine: SessionEngine, commandId: string) =>
    engine.createSession({
      commandId,
      projectId: "p",
      ticketId: "t",
      role: "ticket",
      parentSessionId: null,
      title: commandId,
      provenance,
    });
  return { db, raw: wake.engine, wake, cursors, a, b, local, create };
}

async function recordOutcome(
  engine: SessionEngine,
  sessionId: string,
  costUsd: number,
): Promise<void> {
  await engine.submit({
    commandId: `outcome-${sessionId}`,
    sessionId,
    intent: { kind: "session.signal", signal: "done", reason: sessionId },
    provenance,
  });
  await engine.observe({
    id: `metered-${sessionId}`,
    kind: "usage.recorded",
    sessionId,
    occurredAt: 100,
    attachmentId: null,
    turnId: null,
    provenance,
    usage: {
      cause: "utility",
      providerId: "test",
      modelId: "test",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd,
      costBasis: "provider-reported",
    },
  });
}

describe("Session owner views", () => {
  it("commits the birth owner and S2 cursor together, before the host's post-commit wake", async () => {
    const f = setup();
    const observed: unknown[] = [];
    f.wake.subscribe(({ event }) => {
      if (event.payload.kind === "session.created")
        observed.push({
          owner: event.payload.session.ownerUserId,
          cursor: f.cursors.get(event.sessionId),
          venue: event.provenance.venue,
        });
    });
    const created = await f.create(f.a.engine, "birth");
    expect(observed).toEqual([
      {
        owner: "a",
        cursor: expect.objectContaining({ ownerUserId: "a", acceptedThrough: 0 }),
        venue: LOCAL_RUNNER,
      },
    ]);
    expect((await f.raw.getBaseSession({ sessionId: created.session.id }))?.ownerUserId).toBe("a");
    expect((await f.create(f.a.engine, "birth")).session).toEqual(created.session);
    expect(f.cursors.list()).toHaveLength(1);
  });

  it("rolls back the entire birth if cursor adoption fails", async () => {
    const f = setup();
    const owner = createCloudSessionOwner({
      db: f.db,
      engine: f.raw,
      ownerUserId: "a",
      adopt: () => {
        throw new Error("disk");
      },
    });
    const wakes = vi.fn();
    f.wake.subscribe(wakes);
    await expect(f.create(owner.engine, "failed")).rejects.toThrow("disk");
    expect(f.db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT COUNT(*) n FROM session_events").get()).toEqual({ n: 0 });
    expect(f.cursors.list()).toEqual([]);
    expect(wakes).not.toHaveBeenCalled();
  });

  it("requires an actual persisted cursor and rejects cross-account replay", async () => {
    const f = setup();
    const owner = createCloudSessionOwner({
      db: f.db,
      engine: f.raw,
      ownerUserId: "a",
      adopt: () => {},
    });
    await expect(f.create(owner.engine, "missing-cursor")).rejects.toThrow("did not persist");
    const created = await f.create(f.a.engine, "a-birth");
    await expect(f.create(f.b.engine, "a-birth")).rejects.toMatchObject({
      code: "not_your_runner",
      retryable: false,
    });
    await expect(
      f.b.engine.createSession({
        commandId: "steal",
        projectId: "p",
        ticketId: "t",
        role: "ticket",
        parentSessionId: null,
        requestedSessionId: created.session.id,
        title: null,
        provenance,
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
  });

  it("inherits an owner's stamp and cursor for delegated children, refusing another owner's parent", async () => {
    const f = setup();
    const parent = await f.create(f.a.engine, "parent");
    const request = {
      commandId: "child",
      projectId: "p",
      ticketId: "t",
      role: "subagent" as const,
      parentSessionId: parent.session.id,
      title: "child",
      provenance,
    };
    const child = await f.a.engine.createSession(request);
    expect(child.session.ownerUserId).toBe("a");
    expect(f.cursors.get(child.session.id)?.ownerUserId).toBe("a");
    await expect(
      f.b.engine.createSession({ ...request, commandId: "foreign-child" }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    await expect(
      f.a.engine.createSession({ ...request, commandId: "other-stamp", ownerUserId: "b" }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
  });

  it("scopes every listing, count, base read, history and metadata read to current-owner cursors", async () => {
    const f = setup();
    const local = await f.create(f.local, "local");
    const a = await f.create(f.a.engine, "a");
    const b = await f.create(f.b.engine, "b");
    for (const [engine, session] of [
      [f.local, local.session],
      [f.a.engine, a.session],
      [f.b.engine, b.session],
    ] as const) {
      expect(
        (await engine.listSessions({ projectId: "p", scope: "all" })).map((p) => p.session.id),
      ).toEqual([session.id]);
      expect(await engine.countSessions({ projectId: "p", scope: "ticket", ticketId: "t" })).toBe(
        1,
      );
      expect(await engine.listSessionStarts({ sinceMs: 0 })).toEqual([session.createdAt]);
      expect(await engine.getBaseSession({ sessionId: session.id })).toEqual(session);
    }
    const hidden = { sessionId: b.session.id };
    expect(await f.a.engine.getSession(hidden)).toBeNull();
    expect(await f.a.engine.getBaseSession(hidden)).toBeNull();
    expect(await f.a.engine.listEvents(hidden)).toEqual([]);
    expect(await f.a.engine.latestEventSequence(hidden)).toBe(0);
    expect(await f.a.engine.getProjectionCheckpoint(hidden)).toBeNull();
    expect(await f.local.getSession({ sessionId: a.session.id })).toBeNull();
    expect(await f.raw.listSessions({ projectId: "p", scope: "all" })).toHaveLength(3);
    expect(f.a.projectIds()).toEqual(["p"]);
  });

  it("selects latest ticket signals and usage BEFORE aggregating, not after", async () => {
    const f = setup();
    const a = await f.create(f.a.engine, "a");
    const b = await f.create(f.b.engine, "b");
    for (const [engine, session, cost] of [
      [f.a.engine, a.session, 1],
      [f.b.engine, b.session, 2],
    ] as const) {
      await engine.submit({
        commandId: `signal-${session.id}`,
        sessionId: session.id,
        intent: { kind: "session.signal", signal: "done", reason: session.id },
        provenance,
      });
      await engine.observe({
        id: `usage-${session.id}`,
        kind: "usage.recorded",
        sessionId: session.id,
        occurredAt: 100,
        attachmentId: null,
        turnId: null,
        provenance,
        usage: {
          cause: "utility",
          providerId: "test",
          modelId: "test",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costUsd: cost,
          costBasis: "provider-reported",
        },
      });
    }
    expect((await f.a.engine.listLatestTicketSignals({ projectId: "p" }))[0]?.sessionId).toBe(
      a.session.id,
    );
    const report = await f.a.engine.reportUsage({ scope: { kind: "all" } });
    const theirs = await f.b.engine.reportUsage({ scope: { kind: "all" } });
    expect(report.total.knownCostUsd).toBe(1);
    expect(theirs.total.knownCostUsd).toBe(2);
    expect((await f.local.reportUsage({ scope: { kind: "all" } })).total.knownCostUsd).toBeNull();
  });

  it("narrows attached Sessions by owner while preserving the frozen local venue", async () => {
    const f = setup();
    const a = await f.create(f.a.engine, "a");
    const b = await f.create(f.b.engine, "b");
    for (const [engine, session] of [
      [f.a.engine, a.session],
      [f.b.engine, b.session],
    ] as const) {
      const start = await engine.submit({
        commandId: `start-${session.id}`,
        sessionId: session.id,
        intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
        provenance,
      });
      await engine.observe({
        id: `open-${session.id}`,
        kind: "attachment.opened",
        sessionId: session.id,
        commandId: start.command.id,
        occurredAt: 100,
        provenance,
        attachment: {
          id: `attachment-${session.id}`,
          sessionId: session.id,
          adapterId: "terminal",
          venue: LOCAL_RUNNER,
          continuity: "fresh",
          native: { id: null, detail: null },
          authority: null,
        },
      });
    }
    expect((await f.a.engine.listAttachedSessions()).map((p) => p.session.id)).toEqual([
      a.session.id,
    ]);
    expect((await f.b.engine.listAttachedSessions()).map((p) => p.session.id)).toEqual([
      b.session.id,
    ]);
    expect(await f.local.listAttachedSessions()).toEqual([]);
    expect(
      f.db.prepare("SELECT DISTINCT venue_id, venue_kind FROM session_attachments").all(),
    ).toEqual([{ venue_id: "local", venue_kind: "local" }]);
  });

  it("guards all writer doors and checkpoint saves against a different owner", async () => {
    const f = setup();
    const foreign = await f.create(f.b.engine, "foreign");
    const sessionId = foreign.session.id;
    await expect(
      f.a.engine.submit({
        commandId: "stop",
        sessionId,
        provenance,
        intent: { kind: "session.archive" },
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    await expect(
      f.a.engine.getOrRecordSessionInput({
        sessionId,
        provenance,
        input: { kind: "prompt-resources", resources: [] },
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    await expect(
      f.a.engine.observe({
        id: "event",
        kind: "usage.recorded",
        sessionId,
        provenance,
        occurredAt: 1,
        attachmentId: null,
        turnId: null,
        usage: {} as never,
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    await expect(f.a.engine.recordToolRefresh({ sessionId } as never)).rejects.toBeInstanceOf(
      SessionOwnerError,
    );
    await expect(f.a.engine.completeModelSelection({ sessionId } as never)).rejects.toBeInstanceOf(
      SessionOwnerError,
    );
    const events = await f.raw.listEvents({ sessionId });
    await expect(
      f.a.engine.saveProjectionCheckpoint(
        createSessionProjectionCheckpoint(foreign.session, events),
      ),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    await expect(
      f.local.createSession({
        commandId: "cloud-stamp",
        projectId: "p",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        ownerUserId: "a",
        provenance,
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
  });
  it("refuses an asynchronous birth association before calling cursor adoption", async () => {
    const f = setup();
    const adopt = vi.fn();
    const owner = createCloudSessionOwner({
      db: f.db,
      engine: f.raw,
      ownerUserId: "a",
      adopt,
      onCreated: async () => {},
    });
    await expect(f.create(owner.engine, "async-association")).rejects.toThrow(
      "must be synchronous",
    );
    expect(adopt).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) n FROM sessions").get()).toEqual({ n: 0 });
  });

  it.each(["local", "cloud"] as const)(
    "uses indexed cursor predicates, not eager fleet ids, for %s reads and write guards",
    async (launch) => {
      const f = setup();
      const local = await f.create(f.local, "local-birth");
      const cloud = await f.create(f.a.engine, "cloud-birth");
      await f.create(f.b.engine, "foreign-birth");
      const engine = launch === "local" ? f.local : f.a.engine;
      const session = launch === "local" ? local.session : cloud.session;
      // Observe the first scoped read too: preparing an eager id-enumeration
      // statement once and then caching it would still regress every later call.
      const prepare = vi.spyOn(f.db, "prepare");
      expect(await engine.getBaseSession({ sessionId: session.id })).toEqual(session);
      await engine.getSession({ sessionId: session.id });
      await engine.submit({
        commandId: `retitle-${launch}`,
        sessionId: session.id,
        intent: { kind: "session.retitle", title: "updated" },
        provenance,
      });
      await engine.getOrRecordSessionInput({
        sessionId: session.id,
        input: { kind: "prompt-resources", resources: [] },
        provenance,
      });
      const queries = prepare.mock.calls.map(([sql]) => sql);
      expect(
        queries.filter(
          (sql) =>
            /^\s*SELECT\s+(?:session_id|id)\s+FROM\s+(?:session_drain_cursors|sessions)\s+WHERE/i.test(
              sql,
            ) && !/WHERE\s+(?:id|session_id)\s*=\s*[@?]/i.test(sql),
        ),
      ).toEqual([]);
      expect(queries.some((sql) => sql.includes("sessionScopeIds"))).toBe(false);
      const scopeQuery = queries.find(
        (sql) => sql.includes("@sessionId") && sql.includes("session_drain_cursors"),
      );
      expect(scopeQuery).toBeDefined();
      prepare.mockRestore();
      if (scopeQuery === undefined) throw new Error("The scoped Session read was not observed");
      const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${scopeQuery}`).all({
        sessionId: session.id,
        ...(launch === "cloud" ? { scopeOwner: "a" } : {}),
      }) as { detail: string }[];
      expect(
        plan.some(({ detail }) => /SEARCH session_drain_cursors.*session_id/.test(detail)),
      ).toBe(true);
      expect(plan.some(({ detail }) => /SCAN session_drain_cursors/.test(detail))).toBe(false);
    },
  );

  it("never reinterprets a restored stamped cloud birth as local when its cursor is absent", async () => {
    const f = setup();
    const local = await f.create(f.local, "genuine-local");
    const restored = await f.create(f.a.engine, "restored-cloud");
    await recordOutcome(f.raw, local.session.id, 1);
    await recordOutcome(f.raw, restored.session.id, 99);
    // Backups retain the ledger but deliberately omit this runner-local table.
    f.db.prepare("DELETE FROM session_drain_cursors WHERE session_id = ?").run(restored.session.id);
    const read = vi.spyOn(f.raw, "getSession");
    expect(f.a.owns(restored.session.id)).toBe(false);
    expect(
      f.db
        .prepare(`SELECT 1 FROM sessions WHERE id = ? AND ${localSessionRow("sessions.id")}`)
        .get(restored.session.id),
    ).toBeUndefined();
    expect(
      (await f.local.listSessions({ projectId: "p", scope: "all" })).map((p) => p.session.id),
    ).toEqual([local.session.id]);
    expect(await f.local.countSessions({ projectId: "p", scope: "all" })).toBe(1);
    expect(await f.local.listSessionStarts({ sinceMs: 0 })).toEqual([local.session.createdAt]);
    expect((await f.local.listLatestTicketSignals({ projectId: "p" }))[0]?.sessionId).toBe(
      local.session.id,
    );
    expect((await f.local.reportUsage({ scope: { kind: "all" } })).total.knownCostUsd).toBe(1);
    expect(await f.local.getBaseSession({ sessionId: restored.session.id })).toBeNull();
    await expect(
      f.local.submit({
        commandId: "restored-write",
        sessionId: restored.session.id,
        intent: { kind: "session.archive" },
        provenance,
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    expect(read).not.toHaveBeenCalledWith({ sessionId: restored.session.id });
    expect(f.a.projectIds()).toEqual([]);
  });

  it("excludes a foreign birth behind a current-owner cursor before folding or aggregation, but accepts unstamped imports", async () => {
    const f = setup();
    const own = await f.create(f.a.engine, "own");
    const imported = await f.create(f.raw, "unstamped-import");
    const foreign = await f.create(f.b.engine, "foreign-birth");
    f.cursors.save({
      sessionId: imported.session.id,
      ownerUserId: "a",
      generation: 1,
      acceptedThrough: 0,
      blocked: null,
    });
    f.cursors.save({ ...f.cursors.get(foreign.session.id)!, ownerUserId: "a" });
    await recordOutcome(f.raw, own.session.id, 1);
    await recordOutcome(f.raw, imported.session.id, 2);
    await recordOutcome(f.raw, foreign.session.id, 99);
    const read = vi.spyOn(f.raw, "getSession");
    expect(f.a.owns(own.session.id)).toBe(true);
    expect(f.a.owns(imported.session.id)).toBe(true);
    expect(f.a.owns(foreign.session.id)).toBe(false);
    expect(f.b.owns(foreign.session.id)).toBe(false);
    expect(
      (await f.a.engine.listSessions({ projectId: "p", scope: "all" })).map((p) => p.session.id),
    ).toEqual([imported.session.id, own.session.id]);
    expect(await f.a.engine.countSessions({ projectId: "p", scope: "all" })).toBe(2);
    expect(await f.a.engine.listSessionStarts({ sinceMs: 0 })).toEqual([
      own.session.createdAt,
      imported.session.createdAt,
    ]);
    expect((await f.a.engine.listLatestTicketSignals({ projectId: "p" }))[0]?.sessionId).toBe(
      imported.session.id,
    );
    expect((await f.a.engine.reportUsage({ scope: { kind: "all" } })).total.knownCostUsd).toBe(3);
    expect(await f.a.engine.getBaseSession({ sessionId: foreign.session.id })).toBeNull();
    expect(read).not.toHaveBeenCalledWith({ sessionId: foreign.session.id });
    await expect(
      f.a.engine.submit({
        commandId: "foreign-write",
        sessionId: foreign.session.id,
        intent: { kind: "session.archive" },
        provenance,
      }),
    ).rejects.toBeInstanceOf(SessionOwnerError);
    expect(await f.local.countSessions({ projectId: "p", scope: "all" })).toBe(0);
    expect(f.a.projectIds()).toEqual(["p"]);
  });
});

describe("a moved project's Sessions on this runner", () => {
  it("are the owner's once their cursors are seeded, and owe the backend nothing they had", async () => {
    const f = setup();
    // A Session from before the move: this Mac's local product, no cursor.
    const moved = await f.create(f.local, "moved");
    const sessionId = moved.session.id;
    await recordOutcome(f.local, sessionId, 0.25);
    const head = (await f.raw.listEvents({ sessionId })).at(-1)!.sequence;
    expect(f.a.owns(sessionId)).toBe(false);
    const isLocal = () =>
      f.db
        .prepare(`SELECT 1 FROM sessions WHERE id = ? AND ${localSessionRow("sessions.id")}`)
        .get(sessionId) !== undefined;
    expect(isLocal()).toBe(true);

    seedMovedSessionCursors(f.db, "a", [{ sessionId, acceptedThrough: head }]);
    expect(f.a.owns(sessionId)).toBe(true);
    expect(f.b.owns(sessionId)).toBe(false);
    expect(isLocal()).toBe(false);
    expect((await f.a.engine.getBaseSession({ sessionId }))?.id).toBe(sessionId);

    // The drain starts from the imported head: none of the history is resent.
    const accept = vi.fn();
    const drain = createFactDrain({
      ownerUserId: "a",
      cursors: f.cursors,
      ledger: sqliteDrainLedger(f.db),
      accept,
    });
    drain.start();
    drain.nudge(sessionId);
    await drain.idle();
    drain.stop();
    expect(accept).not.toHaveBeenCalled();
    expect(f.cursors.get(sessionId)).toMatchObject({ acceptedThrough: head, generation: 1 });
  });
});
