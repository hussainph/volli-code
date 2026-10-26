import { afterEach, describe, expect, it } from "vite-plus/test";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { sqliteDrainCursorStore, sqliteJobJournalStore } from "./sqlite-stores";
import type { JobJournalEntry } from "./inbox";

let opened: TestDb | null = null;
afterEach(() => {
  opened?.cleanup();
  opened = null;
});

function db() {
  opened = openTestDb();
  return opened.db;
}

function completedJob(jobId: string): JobJournalEntry {
  return {
    jobId,
    kind: "session.command",
    lease: { bootId: "boot", attempt: 1 },
    state: "done",
    outcome: { status: "done", result: null },
    receivedAt: 1,
  };
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

  it("isolates journal replay, reads, updates and acknowledgements by account owner", () => {
    const handle = db();
    const a = sqliteJobJournalStore(handle, "a");
    const b = sqliteJobJournalStore(handle, "b");
    const legacy = sqliteJobJournalStore(handle);
    a.save(completedJob("a-job"));
    b.save(completedJob("b-job"));
    legacy.save(completedJob("old-job"));
    expect(a.get("b-job")).toBeNull();
    expect(a.get("old-job")).toBeNull();
    expect(b.get("a-job")).toBeNull();
    expect(a.unreported().map((row) => row.jobId)).toEqual(["a-job"]);
    expect(b.unreported().map((row) => row.jobId)).toEqual(["b-job"]);
    expect(sqliteJobJournalStore(handle, "a").unreported()).toEqual([completedJob("a-job")]);

    expect(() =>
      b.save({
        ...completedJob("a-job"),
        state: "failed",
        outcome: { status: "failed", code: "stolen", detail: null, retryable: false },
      }),
    ).toThrow("another runner owner");
    b.remove("a-job", 1);
    a.remove("b-job", 1);
    expect(a.get("a-job")).toEqual(completedJob("a-job"));
    expect(b.get("b-job")).toEqual(completedJob("b-job"));
    // An older unscoped writer cannot take an account-owned job either.
    expect(() =>
      legacy.save({ ...completedJob("a-job"), lease: { bootId: "legacy", attempt: 2 } }),
    ).toThrow("another runner owner");
    expect(a.get("a-job")?.lease).toEqual({ bootId: "boot", attempt: 1 });
    a.save({ ...completedJob("a-job"), lease: { bootId: "restart", attempt: 2 } });
    a.remove("a-job", 1);
    expect(a.get("a-job")?.lease.attempt).toBe(2);
    a.remove("a-job", 2);
    expect(a.unreported()).toEqual([]);
    expect(b.unreported()).toEqual([completedJob("b-job")]);
    expect(legacy.get("old-job")).toEqual(completedJob("old-job"));
  });

  it("filters foreign and pre-owner journal rows before decoding their outcomes", () => {
    const handle = db();
    // Deliberate on-disk corruption: only the fixture bypasses json_valid.
    handle.pragma("ignore_check_constraints = ON");
    try {
      handle
        .prepare(`INSERT INTO job_journal
        (job_id,kind,lease_boot_id,lease_attempt,state,outcome_json,received_at,owner_user_id)
        VALUES (?, 'session.command', 'boot', 1, 'done', '{', 1, ?)`)
        .run("foreign", "a");
      handle
        .prepare(`INSERT INTO job_journal
        (job_id,kind,lease_boot_id,lease_attempt,state,outcome_json,received_at)
        VALUES ('legacy', 'session.command', 'boot', 1, 'done', '{', 2)`)
        .run();
    } finally {
      handle.pragma("ignore_check_constraints = OFF");
    }
    const b = sqliteJobJournalStore(handle, "b");
    expect(b.get("foreign")).toBeNull();
    expect(b.get("legacy")).toBeNull();
    expect(b.unreported()).toEqual([]);
    b.remove("foreign", 1);
    b.remove("legacy", 1);
    expect(handle.prepare("SELECT COUNT(*) AS n FROM job_journal").get()).toEqual({ n: 2 });
    expect(() => sqliteJobJournalStore(handle, "a").unreported()).toThrow(SyntaxError);
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
