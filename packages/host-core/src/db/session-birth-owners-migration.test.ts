import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createSessionEngine } from "@volli/session-engine";
import type { SessionLedger } from "@volli/shared";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { localProductRow, localSessionRow, sessionBirthOwnerCompatible } from "./local-product";
import { insertProject } from "./projects-repo";
import { SESSION_BIRTH_OWNERS_MIGRATION } from "./session-birth-owners-migration";
import { openTestDb, testProject } from "./test-helpers";
import type { TestDb } from "./test-helpers";

let ctx: TestDb;
const extra: Database.Database[] = [];

afterEach(() => {
  for (const db of extra.splice(0)) db.close();
  ctx.cleanup();
});

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

/**
 * One Session per shape a birth can take, written the way the engine writes
 * it and then bent by raw SQL the way only an older or broken writer could.
 */
async function roster(): Promise<Record<string, string>> {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "project" }));
  let id = 0;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(ctx.db),
    clock: { now: () => 100 + id },
    ids: { next: (kind) => `${kind}-${++id}` },
  });
  const create = async (name: string, ownerUserId?: string) =>
    (
      await engine.createSession({
        commandId: `create-${name}`,
        projectId: "project",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        requestedSessionId: name,
        ...(ownerUserId === undefined ? {} : { ownerUserId }),
        provenance,
      })
    ).session.id;
  const rewriteOwner = (sessionId: string, json: string) =>
    ctx.db
      .prepare(
        `UPDATE session_events SET payload = json_set(payload, '$.session.ownerUserId', json(?))
          WHERE session_id = ? AND json_extract(payload, '$.kind') = 'session.created'`,
      )
      .run(json, sessionId);
  const ids = {
    local: await create("local"),
    ownedA: await create("owned-a", "a"),
    ownedB: await create("owned-b", "b"),
    jsonNull: await create("json-null", "a"),
    numeric: await create("numeric", "a"),
    empty: await create("empty", "a"),
    twice: await create("twice", "a"),
    bare: "bare",
  };
  rewriteOwner(ids.jsonNull, "null");
  rewriteOwner(ids.numeric, "7");
  rewriteOwner(ids.empty, '""');
  // A second birth appended by a raw writer.
  ctx.db
    .prepare(
      `INSERT INTO session_events (id, session_id, sequence, occurred_at, recorded_at,
                                   provenance_id, attachment_id, command_id, payload)
       SELECT id || ':again', session_id,
              (SELECT MAX(sequence) + 1 FROM session_events WHERE session_id = ?),
              occurred_at, recorded_at, provenance_id, NULL, NULL, payload
         FROM session_events
        WHERE session_id = ? AND json_extract(payload, '$.kind') = 'session.created'`,
    )
    .run(ids.twice, ids.twice);
  // A row with no birth at all, as an older build's legacy import left it.
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, project_id, ticket_id, role, title, created_at)
       VALUES ('bare', 'project', NULL, 'project', 'bare', 1)`,
    )
    .run();
  return ids;
}

const cache = (db: Database.Database = ctx.db) =>
  Object.fromEntries(
    (
      db
        .prepare("SELECT session_id, owner_user_id FROM session_birth_owners ORDER BY session_id")
        .all() as { session_id: string; owner_user_id: string | null }[]
    ).map((row) => [row.session_id, row.owner_user_id]),
  );

const owners = (ledger: SessionLedger) =>
  ledger.transaction((tx) =>
    tx.listSessions({ projectId: "project", scope: "all" }).map((session) => ({
      id: session.id,
      ownerUserId: session.ownerUserId,
    })),
  );

describe("session_birth_owners (migration 069, VC-1097)", () => {
  it("holds exactly the births it can vouch for, kept by triggers for any writer", async () => {
    const ids = await roster();
    // A JSON null, a number, an empty owner, a second birth and no birth are
    // all left to the birth fact.
    expect(cache()).toEqual({ [ids.local]: null, [ids.ownedA]: "a", [ids.ownedB]: "b" });

    // Deleting a Session drops its entry with it.
    ctx.db.prepare("DELETE FROM sessions WHERE id = ?").run(ids.ownedB);
    expect(cache()).toEqual({ [ids.local]: null, [ids.ownedA]: "a" });
    // Rewriting a birth event's order row drops it back to unknown.
    ctx.db
      .prepare(
        "UPDATE session_event_sequence SET kind = 'session.created' WHERE session_id = ? AND kind = 'session.created'",
      )
      .run(ids.ownedA);
    expect(cache()).toEqual({ [ids.local]: null });
  });

  it("backfills a database that predates it to what the triggers keep", async () => {
    await roster();
    const kept = cache();
    ctx.db.exec(`DROP TRIGGER session_birth_owner_recorded;
      DROP TRIGGER session_birth_owner_order_updated;
      DROP TRIGGER session_birth_owner_order_deleted;
      DROP TRIGGER session_birth_owner_event_rewritten;
      DROP TABLE session_birth_owners;`);
    ctx.db.exec(SESSION_BIRTH_OWNERS_MIGRATION);
    expect(cache()).toEqual(kept);
    // Re-offering the migration is a no-op.
    ctx.db.exec(SESSION_BIRTH_OWNERS_MIGRATION);
    expect(cache()).toEqual(kept);
  });

  it("answers every scope predicate exactly as the birth fact does", async () => {
    await roster();
    const scopes: [string, string, Record<string, string | null>][] = [
      ["local", localSessionRow("s.id"), {}],
      ["owner a", sessionBirthOwnerCompatible("s.id", "@scopeOwner"), { scopeOwner: "a" }],
      ["owner b", sessionBirthOwnerCompatible("s.id", "@scopeOwner"), { scopeOwner: "b" }],
      ["owner null", sessionBirthOwnerCompatible("s.id", "@scopeOwner"), { scopeOwner: null }],
      ["any owner", sessionBirthOwnerCompatible("s.id"), {}],
    ];
    const visible = () =>
      Object.fromEntries(
        scopes.map(([name, predicate, bindings]) => [
          name,
          (
            ctx.db
              .prepare(`SELECT s.id FROM sessions s WHERE ${predicate} ORDER BY s.id`)
              .all(bindings) as { id: string }[]
          ).map((row) => row.id),
        ]),
      );
    const cached = visible();
    expect(cached.local).toEqual(["bare", "local"]);
    // Both of `twice`'s births name `a`.
    expect(cached["owner a"]).toEqual(["bare", "local", "owned-a", "twice"]);
    expect(cached["owner b"]).toEqual(["bare", "local", "owned-b"]);
    // The exporter's fact-only form agrees with the cached local form.
    expect(
      (
        ctx.db
          .prepare(`SELECT id FROM sessions WHERE ${localProductRow("sessions", "session")}`)
          .all() as { id: string }[]
      )
        .map((row) => row.id)
        .toSorted(),
    ).toEqual(cached.local);
    ctx.db.exec("DELETE FROM session_birth_owners");
    expect(visible()).toEqual(cached);
  });

  it("decodes base rows from the cache, and from the birth fact where it has no row", async () => {
    const ids = await roster();
    // A second connection has no birth memo: what it reads comes from SQL.
    const fresh = () => {
      const db = new Database(ctx.dbPath);
      extra.push(db);
      return createSqliteSessionLedger(db, { predicate: (id) => `${id} IN ('owned-a', 'local')` });
    };
    const expected = [
      { id: ids.ownedA, ownerUserId: "a" },
      { id: "local", ownerUserId: undefined },
    ];
    expect(await owners(fresh())).toEqual(expected);
    // Proved by changing the cache beneath it, which production never does:
    // the read answers from the cache without opening the birth event.
    ctx.db
      .prepare("UPDATE session_birth_owners SET owner_user_id = 'cached' WHERE session_id = ?")
      .run(ids.ownedA);
    expect(await owners(fresh())).toEqual([{ id: "owned-a", ownerUserId: "cached" }, expected[1]]);
    expect((await fresh().transaction((tx) => tx.getSession(ids.ownedA)))?.ownerUserId).toBe(
      "cached",
    );
    // With no row, the birth fact answers, as before the cache existed.
    ctx.db.exec("DELETE FROM session_birth_owners");
    expect(await owners(fresh())).toEqual(expected);
    // And on a database below 069, which has no cache at all.
    ctx.db.exec(`DROP TRIGGER session_birth_owner_recorded;
      DROP TRIGGER session_birth_owner_order_updated;
      DROP TRIGGER session_birth_owner_order_deleted;
      DROP TRIGGER session_birth_owner_event_rewritten;
      DROP TABLE session_birth_owners;`);
    expect(await owners(fresh())).toEqual(expected);
  });
});
