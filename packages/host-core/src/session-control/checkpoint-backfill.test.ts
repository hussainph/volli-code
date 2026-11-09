import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSessionProjectionCheckpoint,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
} from "@volli/shared";
import type { SessionObservation } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import {
  BACKFILL_FOLD_PAGE,
  BACKFILL_SLICE_MS,
  backfillProjectionCheckpoints,
} from "./checkpoint-backfill";
import { createSqliteSessionLedger } from "./sqlite-ledger";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

const provenance = {
  source: { kind: "system" as const, id: "desktop", detail: null },
  venue: { id: "local", kind: "local" as const },
};

async function seed(count: number) {
  ctx = openTestDb();
  const project = testProject({ id: "project" });
  insertProject(ctx.db, project);
  const engine = createTestSessionEngine(ctx.db, { onProjectionCheckpointFailure: () => {} });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await engine.createSession({
      commandId: `create-${index}`,
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: `Session ${index}`,
      provenance,
    });
    ids.push(created.session.id);
  }
  return { engine, ids, projectId: project.id };
}

function checkpointRows(): { session_id: string; schema_version: number }[] {
  return ctx.db
    .prepare("SELECT session_id, schema_version FROM session_projection_checkpoints")
    .all() as { session_id: string; schema_version: number }[];
}

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("backfillProjectionCheckpoints (VC-1076)", () => {
  it("writes a current checkpoint for every Session missing one or holding another version", async () => {
    const { engine, ids, projectId } = await seed(5);
    const expected = await engine.listSessions({ projectId, scope: "all" });
    // Start from what a long-lived profile has: some rows absent, some
    // written by an older build at a version this build refuses.
    ctx.db
      .prepare("DELETE FROM session_projection_checkpoints WHERE session_id NOT IN (?, ?)")
      .run(ids[0], ids[1]);
    ctx.db
      .prepare("UPDATE session_projection_checkpoints SET schema_version = 1 WHERE session_id = ?")
      .run(ids[1]);

    const result = await backfillProjectionCheckpoints({ db: ctx.db, yieldToHost: immediate });

    expect(result).toEqual({ candidates: 4, refreshed: 4 });
    expect(checkpointRows().toSorted((a, b) => a.session_id.localeCompare(b.session_id))).toEqual(
      ids
        .toSorted()
        .map((id) => ({ session_id: id, schema_version: SESSION_PROJECTION_CHECKPOINT_VERSION })),
    );
    // A fresh engine (a relaunch) reads the same listing from the backfilled rows.
    const relaunched = createTestSessionEngine(ctx.db);
    expect(await relaunched.listSessions({ projectId, scope: "all" })).toEqual(expected);

    // Nothing left to do: a second launch's pass finds no candidates.
    await expect(
      backfillProjectionCheckpoints({ db: ctx.db, yieldToHost: immediate }),
    ).resolves.toEqual({ candidates: 0, refreshed: 0 });
  });

  it("hands the host a turn once a slice has run its budget", async () => {
    await seed(3);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    let clock = 0;
    let yields = 0;
    await backfillProjectionCheckpoints({
      db: ctx.db,
      yieldToHost: async () => {
        yields += 1;
        await immediate();
      },
      // Every reading of the clock is a whole slice later than the last.
      now: () => (clock += BACKFILL_SLICE_MS),
    });
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it("stops between Sessions once aborted, and yields on a macrotask by default", async () => {
    await seed(4);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    const abort = new AbortController();
    let clock = 0;
    let reads = 0;
    const result = await backfillProjectionCheckpoints({
      db: ctx.db,
      signal: abort.signal,
      now: () => {
        reads += 1;
        // The turn taken after the second Session aborts the pass.
        if (reads === 5) abort.abort();
        return (clock += BACKFILL_SLICE_MS);
      },
    });
    expect(result).toEqual({ candidates: 2, refreshed: 2 });
    expect(checkpointRows()).toHaveLength(2);
  });

  it("folds a long log a page at a time, yielding between pages, to the whole-log answer (VC-1098)", async () => {
    const { engine, ids } = await seed(1);
    const sessionId = ids[0]!;
    const fact = (index: number): SessionObservation => ({
      kind: "adapter.observed",
      id: `fact-${index}`,
      sessionId,
      occurredAt: 1_000 + index,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: null },
        venue: { id: "local", kind: "local" },
      },
      attachmentId: null,
      name: "vc1098.test",
      native: null,
    });
    const facts = BACKFILL_FOLD_PAGE * 2 + 17;
    for (let index = 0; index < facts; index += 1) await engine.observe(fact(index));
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();

    let clock = 0;
    let yields = 0;
    const result = await backfillProjectionCheckpoints({
      db: ctx.db,
      yieldToHost: async () => {
        yields += 1;
        // A fact recorded while the pass is between pages is folded by the
        // next page, not lost behind a cursor the pass already moved past.
        if (yields === 1) await engine.observe(fact(facts));
        await immediate();
      },
      now: () => (clock += BACKFILL_SLICE_MS),
    });

    expect(result).toEqual({ candidates: 1, refreshed: 1 });
    // One turn between each pair of pages, then the slice's own turn.
    expect(yields).toBeGreaterThanOrEqual(3);
    const ledger = createSqliteSessionLedger(ctx.db);
    const [stored, whole] = await ledger.transaction((transaction) => {
      const session = transaction.getSession(sessionId)!;
      return [
        transaction.getProjectionCheckpoint(sessionId),
        createSessionProjectionCheckpoint(session, transaction.listProjectionEvents({ sessionId })),
      ] as const;
    });
    expect(stored?.throughSequence).toBe(
      await ledger.transaction((transaction) => transaction.latestEventSequence(sessionId)),
    );
    expect(stored).toEqual(whole);
  });

  it("moves past a Session it cannot fold", async () => {
    const { ids } = await seed(3);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    // A malformed field inside a known kind is corruption, and fails loudly.
    ctx.db
      .prepare(
        `UPDATE session_events SET payload = '{"kind":"session.created"}'
          WHERE session_id = ? AND json_extract(payload, '$.kind') = 'session.created'`,
      )
      .run(ids[1]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await backfillProjectionCheckpoints({ db: ctx.db, yieldToHost: immediate });
      expect(result).toEqual({ candidates: 3, refreshed: 2 });
      expect(JSON.stringify(warn.mock.calls)).toContain(ids[1]);
    } finally {
      warn.mockRestore();
    }
  });
});
