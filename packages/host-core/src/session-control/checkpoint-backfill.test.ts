import { afterEach, describe, expect, it } from "vite-plus/test";
import { SESSION_PROJECTION_CHECKPOINT_VERSION } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import { BACKFILL_SLICE_MS, backfillProjectionCheckpoints } from "./checkpoint-backfill";

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
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    await engine.getSession({ sessionId: ids[0]! });
    await engine.getSession({ sessionId: ids[1]! });
    ctx.db
      .prepare("UPDATE session_projection_checkpoints SET schema_version = 1 WHERE session_id = ?")
      .run(ids[1]);

    const result = await backfillProjectionCheckpoints({
      db: ctx.db,
      engine,
      yieldToHost: immediate,
    });

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
      backfillProjectionCheckpoints({ db: ctx.db, engine, yieldToHost: immediate }),
    ).resolves.toEqual({ candidates: 0, refreshed: 0 });
  });

  it("hands the host a turn once a slice has run its budget", async () => {
    const { engine } = await seed(3);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    let clock = 0;
    let yields = 0;
    await backfillProjectionCheckpoints({
      db: ctx.db,
      // Every fold costs a whole slice on this clock.
      engine: {
        getSession: async (query) => {
          clock += BACKFILL_SLICE_MS;
          return engine.getSession(query);
        },
      },
      yieldToHost: async () => {
        yields += 1;
        await immediate();
      },
      now: () => clock,
    });
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it("stops between Sessions once aborted", async () => {
    const { engine } = await seed(4);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    const abort = new AbortController();
    let folds = 0;
    const result = await backfillProjectionCheckpoints({
      db: ctx.db,
      engine: {
        getSession: async (query) => {
          folds += 1;
          if (folds === 2) abort.abort();
          return engine.getSession(query);
        },
      },
      yieldToHost: immediate,
      signal: abort.signal,
    });
    expect(result).toEqual({ candidates: 2, refreshed: 2 });
    expect(checkpointRows()).toHaveLength(2);
  });

  it("moves past a Session it cannot fold", async () => {
    const { engine, ids } = await seed(3);
    ctx.db.prepare("DELETE FROM session_projection_checkpoints").run();
    const result = await backfillProjectionCheckpoints({
      db: ctx.db,
      engine: {
        getSession: async (query) => {
          if (query.sessionId === ids[1]) throw new Error("unfoldable");
          return engine.getSession(query);
        },
      },
      yieldToHost: immediate,
    });
    expect(result).toEqual({ candidates: 3, refreshed: 2 });
  });
});
