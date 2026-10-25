import { afterEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { sqliteDrainCursorStore, sqliteJobJournalStore } from "./sqlite-stores";

let opened: TestDb | null = null;
afterEach(() => {
  opened?.cleanup();
  opened = null;
});

function db() {
  opened = openTestDb();
  return opened.db;
}

describe("the runner-local stores (migration 65)", () => {
  it("keeps drain cursors, faults included, across reads", () => {
    const store = sqliteDrainCursorStore(db(), () => 42);
    expect(store.get("s1")).toBeNull();
    store.save({
      sessionId: "s1",
      ownerUserId: "u",
      generation: 1,
      acceptedThrough: 0,
      blocked: null,
    });
    store.save({
      sessionId: "s1",
      ownerUserId: "u",
      generation: 2,
      acceptedThrough: 7,
      blocked: null,
    });
    store.save({
      sessionId: "s0",
      ownerUserId: "u",
      generation: 1,
      acceptedThrough: 3,
      blocked: { code: "fenced", message: "moved", at: 9 },
    });
    expect(store.get("s1")).toEqual({
      sessionId: "s1",
      ownerUserId: "u",
      generation: 2,
      acceptedThrough: 7,
      blocked: null,
    });
    expect(store.list().map((cursor) => [cursor.sessionId, cursor.blocked?.code ?? null])).toEqual([
      ["s0", "fenced"],
      ["s1", null],
    ]);
    expect(store.get("s0")?.blocked).toEqual({ code: "fenced", message: "moved", at: 9 });
  });

  it("refuses a negative cursor", () => {
    const store = sqliteDrainCursorStore(db());
    expect(() =>
      store.save({
        sessionId: "s1",
        ownerUserId: "u",
        generation: 1,
        acceptedThrough: -1,
        blocked: null,
      }),
    ).toThrow(/CHECK/);
  });

  it("reads a fault row a hand edit left without its message or time", () => {
    const handle = db();
    handle
      .prepare(
        "INSERT INTO session_drain_cursors (session_id, owner_user_id, claim_generation, accepted_through, blocked_code, updated_at) VALUES ('s', 'u', 1, 0, 'conflict', 0)",
      )
      .run();
    expect(sqliteDrainCursorStore(handle).get("s")?.blocked).toEqual({
      code: "conflict",
      message: "conflict",
      at: 0,
    });
  });

  it("journals job outcomes until they are reported", () => {
    const journal = sqliteJobJournalStore(db());
    const lease = { bootId: "boot", attempt: 1 };
    journal.save({
      jobId: "j1",
      kind: "workingCopy.refresh",
      lease,
      state: "running",
      outcome: null,
      receivedAt: 1,
    });
    journal.save({
      jobId: "j2",
      kind: "workingCopy.trim",
      lease,
      state: "done",
      outcome: { status: "done", result: { n: 1 } },
      receivedAt: 2,
    });
    expect(journal.get("j1")?.outcome).toBeNull();
    expect(journal.unreported().map((entry) => entry.jobId)).toEqual(["j2"]);
    journal.save({
      jobId: "j1",
      kind: "workingCopy.refresh",
      lease: { bootId: "boot", attempt: 2 },
      state: "failed",
      outcome: { status: "failed", code: "x", detail: null, retryable: true },
      receivedAt: 1,
    });
    expect(journal.get("j1")).toMatchObject({
      state: "failed",
      lease: { attempt: 2 },
      outcome: { code: "x" },
    });
    expect(journal.unreported().map((entry) => entry.jobId)).toEqual(["j1", "j2"]);
    journal.remove("j2", 2);
    expect(journal.get("j2")).not.toBeNull();
    journal.remove("j2", 1);
    expect(journal.get("j2")).toBeNull();
    expect(journal.unreported()).toHaveLength(1);
  });
});
