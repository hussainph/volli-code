import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Worker } from "node:worker_threads";
import { createSessionEngine, type ReportSessionUsageQuery } from "@volli/session-engine";
import { SESSION_USAGE_GROUPINGS, reportSessionUsage, type SessionUsageScope } from "@volli/shared";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { withTransaction } from "../db/transaction-gate";
import { createSqliteSessionLedger } from "./sqlite-ledger";
import { installSqliteUsageWorker } from "./usage-reports";
import { serveUsageReportWorker } from "./usage-report-worker";

const ENTRY = new URL("./test-support/usage-worker-under-node.mjs", import.meta.url);
let ctx: TestDb;
let stop: (() => Promise<void>) | undefined;
let ids: string[];

beforeEach(async () => {
  ctx = openTestDb();
  ctx.db.pragma("journal_mode = WAL");
  let sequence = 0;
  const engine = createSessionEngine({
    ledger: createSqliteSessionLedger(ctx.db),
    ids: { next: (kind) => `${kind}-${++sequence}` },
    clock: { now: () => 100 },
  });
  ids = [];
  for (const projectId of ["p0", "p1"]) {
    insertProject(ctx.db, testProject({ id: projectId }));
    const { session } = await engine.createSession({
      commandId: `create-${projectId}`,
      projectId,
      ticketId: null,
      parentSessionId: null,
      role: "project",
      title: projectId,
      provenance: {
        source: { kind: "system", id: "test", detail: null },
        venue: { id: "local", kind: "local" },
      },
    });
    ids.push(session.id);
  }
  withTransaction(ctx.db, () => {
    const insert = ctx.db.prepare(`INSERT INTO session_usage
      (event_id, session_id, project_id, ticket_id, occurred_at, cause, provider_id, model_id,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_basis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 120; i++) {
      insert.run(
        `event-${i}`,
        ids[i % 2],
        `p${i % 2}`,
        i % 3 === 0 ? null : `t${i % 2}`,
        // Include equal-cost groups, equal timestamps, UTC day boundaries,
        // absent measurements, zero cost, mixed bases, and micro-dollar rounding.
        Math.floor(i / 3) * 86_400_000,
        ["assistant", "utility", "decision", "compaction"][i % 4],
        `provider${i % 2}`,
        `model${i % 4}`,
        i % 3 === 0 ? null : i,
        i % 5 === 0 ? null : 0,
        i % 3 === 0 ? null : i * 10,
        i % 3 === 0 ? null : 0,
        i % 5 === 0 ? null : i % 3 === 0 ? 0 : 0.0000005,
        i % 5 === 0 ? "unavailable" : i % 2 === 0 ? "provider-reported" : "catalog-estimate",
      );
    }
  });
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  ctx.cleanup();
  vi.restoreAllMocks();
});

function expected(query: ReportSessionUsageQuery) {
  return createSqliteSessionLedger(ctx.db).transaction((tx) =>
    reportSessionUsage(tx.listUsage(query), { ...query, meteredFrom: tx.usageMeteredFrom() }),
  );
}

describe("off-thread usage reports", () => {
  it("loads the configured desktop worker source and matches its bundled launch filename", async () => {
    stop = installSqliteUsageWorker(
      ctx.db,
      new URL("./test-support/desktop-usage-worker-under-node.mjs", import.meta.url),
    );
    const query = { scope: { kind: "all" } as const, groupBy: "model" as const };
    expect(await createSqliteSessionLedger(ctx.db).reportUsage(query)).toEqual(
      await expected(query),
    );
  });

  it("matches the existing report exactly for every scope, grouping and half-open window", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(ctx.db),
      ids: { next: () => "unused" },
      clock: { now: () => 0 },
    });
    const scopes: SessionUsageScope[] = [
      { kind: "all" },
      { kind: "project", projectId: "p0" },
      { kind: "ticket", ticketId: "t1" },
      { kind: "session", sessionId: ids[0]! },
      { kind: "session", sessionId: "empty" },
    ];
    for (const scope of scopes) {
      for (const groupBy of [undefined, ...SESSION_USAGE_GROUPINGS]) {
        for (const window of [{}, { since: 86_400_000, until: 3 * 86_400_000 }]) {
          const query = { scope, groupBy, ...window };
          expect(await engine.reportUsage(query)).toEqual(await expected(query));
        }
      }
    }
  }, 15_000);

  it("keeps predicates/bindings per reader and never reads usage rows on the calling thread", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const ledger = createSqliteSessionLedger(ctx.db, {
      predicate: (id) => `${id} = @scopeSession`,
      bindings: { scopeSession: ids[0]! },
    });
    const query = { scope: { kind: "all" } as const, groupBy: "session" as const };
    const baseline = await expected({ ...query, scope: { kind: "session", sessionId: ids[0]! } });
    const prepare = vi.spyOn(ctx.db, "prepare");
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    const first = ledger.reportUsage(query);
    const second = createSqliteSessionLedger(ctx.db).reportUsage(query);
    // Both scopes queue on the same worker, not separate scanning threads.
    expect(posted.mock.contexts[0]).toBe(posted.mock.contexts[1]);
    let answered = false;
    void first.then(() => {
      answered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    expect(await first).toEqual(baseline);
    expect((await second).total.requestCount).toBe(120);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("sees committed appends/deletes and reads coverage from the same snapshot", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const ledger = createSqliteSessionLedger(ctx.db);
    const query = { scope: { kind: "all" } as const, since: 1000 };
    const before = await ledger.reportUsage(query);
    withTransaction(ctx.db, () => {
      ctx.db.prepare("DELETE FROM session_usage WHERE event_id = ?").run("event-119");
      ctx.db
        .prepare(`INSERT INTO session_usage SELECT 'appended', session_id, project_id, ticket_id,
        occurred_at, cause, provider_id, model_id, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, 1.25, cost_basis
        FROM session_usage WHERE event_id = 'event-118'`)
        .run();
      ctx.db.prepare("UPDATE session_usage_coverage SET metered_from = 2000").run();
    });
    const after = await ledger.reportUsage(query);
    expect(after).toEqual(await expected(query));
    expect(after.total.requestCount).toBe(before.total.requestCount);
    expect(after.total.knownCostUsd).not.toBe(before.total.knownCostUsd);
    expect(after.history).toEqual({ meteredFrom: 2000, complete: false });
  });

  it("uses the local snapshot for an enclosed read, including uncommitted rows", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const ledger = createSqliteSessionLedger(ctx.db);
    const pending = withTransaction(ctx.db, () => {
      ctx.db.prepare("DELETE FROM session_usage").run();
      // Box the promise: no transaction is held across its await.
      return { report: ledger.reportUsage({ scope: { kind: "all" } }) };
    });
    expect((await pending.report).total.requestCount).toBe(0);
  });

  it("surfaces codec errors without killing the reusable reader", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const ledger = createSqliteSessionLedger(ctx.db);
    ctx.db.prepare("UPDATE session_usage SET cause = 'corrupt' WHERE event_id = 'event-1'").run();
    await expect(ledger.reportUsage({ scope: { kind: "all" } })).rejects.toThrow();
    ctx.db.prepare("UPDATE session_usage SET cause = 'assistant' WHERE event_id = 'event-1'").run();
    expect((await ledger.reportUsage({ scope: { kind: "all" } })).total.requestCount).toBe(120);
  });

  it("rejects pending reads when the host closes and permits a later installation", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const ledger = createSqliteSessionLedger(ctx.db);
    const request = ledger.reportUsage({ scope: { kind: "all" } });
    const rejected = expect(request).rejects.toThrow("closed");
    await stop();
    await rejected;
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    expect((await ledger.reportUsage({ scope: { kind: "all" } })).total.requestCount).toBe(120);
  });

  it("closes the read connection gracefully before the writer checkpoints", async () => {
    stop = installSqliteUsageWorker(ctx.db, ENTRY);
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const posted = vi.spyOn(Worker.prototype, "postMessage");
    await createSqliteSessionLedger(ctx.db).reportUsage({ scope: { kind: "all" } });
    await stop();
    expect(posted).toHaveBeenLastCalledWith({ type: "close" }, []);
    expect(terminate).not.toHaveBeenCalled();
    expect(ctx.db.pragma("wal_checkpoint(TRUNCATE)")).toEqual([
      { busy: 0, log: 0, checkpointed: 0 },
    ]);
  });

  it("rejects a worker startup failure, not a hanging report", async () => {
    stop = installSqliteUsageWorker(ctx.db, new URL("./missing-worker.mjs", import.meta.url));
    await expect(
      createSqliteSessionLedger(ctx.db).reportUsage({ scope: { kind: "all" } }),
    ).rejects.toThrow();
  });

  it("refuses to serve on the calling thread", () => {
    expect(() => serveUsageReportWorker()).toThrow("inside a worker thread");
  });
});
