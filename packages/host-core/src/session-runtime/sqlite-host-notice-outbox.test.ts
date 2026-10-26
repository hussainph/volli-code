import { afterEach, describe, expect, it } from "vite-plus/test";
import { sessionHostNoticeMetadata } from "@volli/shared";
import type { HostNotice } from "@volli/session-engine";
import { createTestSessionEngine } from "../testing/session-engine";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import {
  createSqliteHostNoticeOutbox,
  readSqliteHostNotice,
  scopeSqliteHostNoticeOutbox,
} from "./sqlite-host-notice-outbox";

let fixture: TestDb | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});
const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: { id: "local", kind: "local" as const },
};
const metadata = sessionHostNoticeMetadata({
  kind: "background-shell",
  event: "exited",
  shellId: "shell",
  label: "test",
  code: 0,
  signal: null,
  runtimeMs: 100,
  byPerson: false,
});
function notice(sessionId: string, id: string): HostNotice {
  return {
    sessionId,
    commandId: id,
    messageId: `${id}:message`,
    label: "test",
    text: "original nonce and sanitized text",
    metadata,
  };
}
async function setup() {
  fixture = openTestDb();
  const { db } = fixture;
  insertProject(db, testProject({ id: "project" }));
  let sequence = 0;
  const engine = createTestSessionEngine(db, { nextId: () => `id-${++sequence}`, now: () => 100 });
  const create = (commandId: string) =>
    engine.createSession({
      commandId,
      projectId: "project",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      provenance,
    });
  const a = await create("a");
  const b = await create("b");
  const raw = createSqliteHostNoticeOutbox(db, createSqliteSessionLedger(db));
  const scoped = scopeSqliteHostNoticeOutbox(db, raw, (id) => id === a.session.id);
  return {
    db,
    raw,
    scoped,
    a: notice(a.session.id, "a-notice"),
    b: notice(b.session.id, "b-notice"),
  };
}

describe("launch-scoped durable host notices", () => {
  it("reads one id as absent, pending with its first payload, or settled, and refuses another Session's id", async () => {
    const f = await setup();
    expect(readSqliteHostNotice(f.db, f.a.commandId, f.a.sessionId)).toEqual({ state: "absent" });
    await f.raw.put(f.a);
    expect(readSqliteHostNotice(f.db, f.a.commandId, f.a.sessionId)).toEqual({
      state: "pending",
      notice: f.a,
    });
    expect(() => readSqliteHostNotice(f.db, f.a.commandId, f.b.sessionId)).toThrow(
      "belongs to a different Session",
    );
    await f.raw.settle(f.a.commandId, { status: "dropped", reason: "reader-stopped" });
    expect(readSqliteHostNotice(f.db, f.a.commandId, f.a.sessionId)).toEqual({ state: "settled" });
  });

  it("filters foreign candidate ids before decoding and preserves the original owned payload", async () => {
    const f = await setup();
    await f.raw.put(f.b);
    await f.raw.put(f.a);
    // Simulate disk corruption, which bypasses the schema's JSON CHECK.
    f.db.pragma("ignore_check_constraints = ON");
    f.db
      .prepare("UPDATE host_notice_outbox SET notice = '{' WHERE command_id = ?")
      .run(f.b.commandId);
    f.db.pragma("ignore_check_constraints = OFF");
    expect(await f.scoped.pending()).toEqual([f.a]);
    await expect(f.raw.pending()).rejects.toThrow();
    expect(
      f.db
        .prepare("SELECT notice, receipt FROM host_notice_outbox WHERE command_id = ?")
        .get(f.b.commandId),
    ).toEqual({ notice: "{", receipt: null });
  });

  it("rejects foreign puts and settlements without changing another owner's data", async () => {
    const f = await setup();
    await expect(f.scoped.put(f.b)).rejects.toThrow("outside this launch");
    expect(await f.raw.pending()).toEqual([]);
    await f.raw.put(f.b);
    const before = f.db
      .prepare("SELECT * FROM host_notice_outbox WHERE command_id = ?")
      .get(f.b.commandId);
    await expect(f.scoped.settle(f.b.commandId, { status: "accepted" })).rejects.toThrow(
      "outside this launch",
    );
    expect(
      f.db.prepare("SELECT * FROM host_notice_outbox WHERE command_id = ?").get(f.b.commandId),
    ).toEqual(before);
    expect(await f.scoped.put(f.a)).toEqual(f.a);
    await f.scoped.settle(f.a.commandId, { status: "accepted" });
    expect(await f.scoped.pending()).toEqual([]);
    expect(await f.scoped.put(f.a)).toBeNull();
    expect(await f.raw.pending()).toEqual([f.b]);
  });

  it("refuses an owned row whose payload names another Session", async () => {
    const f = await setup();
    await f.raw.put(f.a);
    f.db
      .prepare("UPDATE host_notice_outbox SET notice = ? WHERE command_id = ?")
      .run(JSON.stringify(f.b), f.a.commandId);
    await expect(f.scoped.pending()).rejects.toThrow("different Session");
  });
});
