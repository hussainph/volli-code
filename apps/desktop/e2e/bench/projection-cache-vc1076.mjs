#!/usr/bin/env node
/**
 * VC-1076: what the Session projection cache costs on a REAL profile's
 * database — first listing after launch, one runtime fact on a large Session,
 * and the activity watch's flush over many active Sessions.
 *
 * It never touches the live profile. Point it at a COPY (a clone of
 * `volli.db` + `-wal`); the bench writes to that copy (checkpoints, and the
 * facts the per-fact arm appends), so make a fresh clone per run:
 *
 *   cp -c volli.db /tmp/x/work.db && cp -c volli.db-wal /tmp/x/work.db-wal
 *   node --expose-gc apps/desktop/e2e/bench/projection-cache-vc1076.mjs --db /tmp/x/work.db
 *
 * The number that matters most is each arm's worst block — the longest stretch
 * the host could not run a timer, answer IPC or paint — not its total.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate } from "node:timers";

import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..", "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const DB_PATH = argument("db", null);
if (DB_PATH === null) throw new Error("--db <path to a COPY of volli.db> is required");
const FACTS = Number(argument("facts", "200"));
const ACTIVE = Number(argument("active", "20"));
const BACKFILL = argument("backfill", "off") === "on";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Total and worst event-loop block of one async operation. */
async function measure(operation) {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await wait(20);
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - startedAt;
  await wait(20);
  delay.disable();
  return { value, elapsedMs: round(elapsedMs), worstBlockMs: round(Number(delay.max) / 1e6) };
}
const round = (value) => Math.round(value * 10) / 10;

const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});

let db;
try {
  const { openVolliDb } = await vite.ssrLoadModule("/packages/host-core/src/db/index.ts");
  const sessionControl = await vite.ssrLoadModule(
    "/packages/host-core/src/session-control/index.ts",
  );
  const { createSqliteSessionLedger } = await vite.ssrLoadModule(
    "/packages/host-core/src/session-control/sqlite-ledger.ts",
  );
  const { createHostSessionEngine } = await vite.ssrLoadModule(
    "/packages/host-core/src/sessions/engine.ts",
  );
  const backfillModule = BACKFILL
    ? await vite.ssrLoadModule("/packages/host-core/src/session-control/checkpoint-backfill.ts")
    : null;

  db = openVolliDb(DB_PATH);
  let ledger = createSqliteSessionLedger(db);
  /** A relaunch: a new connection, so nothing memoized on the old one survives. */
  const reopen = () => {
    db.close();
    db = openVolliDb(DB_PATH);
    ledger = createSqliteSessionLedger(db);
  };
  let next = 0;
  const engineFor = () =>
    createHostSessionEngine(ledger, {
      nextId: () => `vc1076-bench-${++next}`,
      onProjectionCheckpointFailure: () => {},
    });

  const project = db
    .prepare(
      "SELECT project_id AS id, COUNT(*) AS count FROM sessions GROUP BY project_id ORDER BY count DESC LIMIT 1",
    )
    .get();
  const query = { projectId: project.id, scope: "all" };
  const checkpointCensus = () =>
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions s WHERE NOT EXISTS
              (SELECT 1 FROM session_projection_checkpoints c WHERE c.session_id = s.id)) AS missing,
           (SELECT COUNT(*) FROM session_projection_checkpoints WHERE schema_version <> 4) AS stale`,
      )
      .get();
  const report = { project: { sessions: project.count }, before: checkpointCensus() };

  // ── Roster statement on its own ────────────────────────────────────────
  report.rosterQuery = await measure(() =>
    ledger.transaction((transaction) => transaction.listSessions(query).length),
  );

  if (backfillModule !== null) {
    report.backfill = await measure(() =>
      backfillModule.backfillProjectionCheckpoints({
        db,
        engine: engineFor(),
        yieldToHost: () => new Promise((done) => setImmediate(done)),
      }),
    );
    report.afterBackfill = checkpointCensus();
  }

  // ── The first listing after launch: fold + rows, fresh engine ──────────
  // The fold and the rows step are timed apart as well as together: the fold
  // yields between chunks, the rows step is whatever it is.
  const listing = async (engine) => {
    const foldStartedAt = performance.now();
    const sessions = await engine.listSessions(query);
    const foldMs = performance.now() - foldStartedAt;
    const rowsStartedAt = performance.now();
    const rows = await sessionControl.sessionListingRowsForRoster(db, sessions, new Set());
    return {
      rows: rows.length,
      foldMs: round(foldMs),
      rowsMs: round(performance.now() - rowsStartedAt),
    };
  };
  report.firstListing = await measure(() => listing(engineFor()));
  report.afterFirstListing = checkpointCensus();
  // A relaunch: a new connection and a fresh engine, over what the first
  // listing persisted.
  reopen();
  report.relaunchListing = await measure(() => listing(engineFor()));
  const warmEngine = engineFor();
  await listing(warmEngine);
  report.warmListing = await measure(() => listing(warmEngine));

  // ── One runtime fact on the Session with the largest checkpoint ────────
  const large = db
    .prepare(
      `SELECT session_id AS id, LENGTH(checkpoint) AS bytes FROM session_projection_checkpoints
        WHERE schema_version = 4 ORDER BY LENGTH(checkpoint) DESC LIMIT 1`,
    )
    .get();
  const factEngine = engineFor();
  const provenance = {
    source: { kind: "adapter", id: "pi", detail: null },
    venue: { id: "local", kind: "local" },
  };
  const observe = (engine, sessionId, index) =>
    engine.observe({
      kind: "adapter.observed",
      id: `vc1076-bench-fact-${sessionId}-${index}-${next++}`,
      sessionId,
      occurredAt: Date.now(),
      provenance,
      attachmentId: null,
      name: "vc1076.bench",
      native: null,
    });
  await observe(factEngine, large.id, -1);
  const perFact = [];
  for (let index = 0; index < FACTS; index += 1) {
    const startedAt = performance.now();
    await observe(factEngine, large.id, index);
    perFact.push(performance.now() - startedAt);
  }
  perFact.sort((a, b) => a - b);
  report.perFact = {
    checkpointBytes: large.bytes,
    facts: FACTS,
    medianMs: round(perFact[Math.floor(perFact.length / 2)] * 100) / 100,
    p95Ms: round(perFact[Math.floor(perFact.length * 0.95)] * 100) / 100,
    maxMs: round(perFact.at(-1) * 100) / 100,
  };

  // ── The activity watch flushing many dirty Sessions at once ────────────
  const active = db
    .prepare(
      `SELECT c.session_id AS id FROM session_projection_checkpoints c
        WHERE c.schema_version = 4 ORDER BY LENGTH(c.checkpoint) DESC LIMIT ?`,
    )
    .all(ACTIVE)
    .map((row) => row.id);
  const watchEngine = engineFor();
  // The live wiring: the wake bus around the engine that writes, so the
  // watch folds through the same engine the facts went through.
  let listener = null;
  const watch = sessionControl.watchSessionActivity(
    { engine: watchEngine, subscribe: (wake) => ((listener = wake), () => {}) },
    { publish: () => {}, listOpenNativeBindings: () => [], coalesceMs: 60_000 },
  );
  const flushOnce = async (label) => {
    for (const [index, sessionId] of active.entries()) {
      const event = await observe(watchEngine, sessionId, index);
      listener({ event });
    }
    report[label] = await measure(() => watch.flush());
  };
  await flushOnce("activityFlushFirst");
  await flushOnce("activityFlushWarm");
  watch.stop();
  report.activeSessions = active.length;

  console.log(JSON.stringify(report, null, 2));
} finally {
  db?.close();
  await vite.close();
}
