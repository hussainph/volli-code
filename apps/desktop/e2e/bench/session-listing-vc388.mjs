#!/usr/bin/env node
/**
 * VC-388: what a project's roster costs to list, and what the two caches are
 * worth.
 *
 * Unlike `session-rpc-sqlite-bench.mjs`, this one needs no existing database:
 * the roster is built through the production engine, so every event, receipt
 * and checkpoint row takes the same path the app writes.
 *
 * The number that matters is not the total. It is `eventLoopMaxMs` — the
 * longest single stretch the host could not run a timer, answer IPC or paint.
 * A listing that takes longer overall but never blocks for more than a frame
 * is the better one, which is the whole trade this ticket is about.
 *
 *   node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs
 *   node --expose-gc apps/desktop/e2e/bench/session-listing-vc388.mjs --sessions 120 --events 200
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { createServer } from "vite";
import helpers from "./session-rpc/helpers.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..", "..");

const SESSION_COUNT = helpers.parsePositiveInteger("sessions", 60);
const EVENTS_PER_SESSION = helpers.parsePositiveInteger("events", 150);
const REPEATS = helpers.parsePositiveInteger("repeats", 5);
const PROJECT_ID = "project-bench";

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const mb = (bytes) => bytes / 1024 / 1024;

/**
 * Runs `operation` while watching the event loop, so a fold that never yields
 * and a fold that yields sixty times can be told apart by something other than
 * their totals.
 */
async function measure(operation) {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await wait(20);
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - startedAt;
  const heapDeltaMb = mb(process.memoryUsage().heapUsed - heapBefore);
  await wait(20);
  delay.disable();
  return { value, elapsedMs, eventLoopMaxMs: Number(delay.max) / 1e6, heapDeltaMb };
}

async function repeat(count, operation) {
  const elapsed = [];
  let worstLoopMs = 0;
  for (let index = 0; index < count; index += 1) {
    const run = await measure(operation);
    elapsed.push(run.elapsedMs);
    worstLoopMs = Math.max(worstLoopMs, run.eventLoopMaxMs);
  }
  return { ...helpers.distribution(elapsed), eventLoopMaxMs: worstLoopMs };
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "volli-vc388-"));
const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});

let db;
try {
  const [{ openVolliDb }, { insertProject }, { createSqliteSessionLedger }, engineModule] =
    await Promise.all([
      vite.ssrLoadModule("/apps/desktop/src/main/db/index.ts"),
      vite.ssrLoadModule("/apps/desktop/src/main/db/projects-repo.ts"),
      vite.ssrLoadModule("/apps/desktop/src/main/session-control/sqlite-ledger.ts"),
      vite.ssrLoadModule("/packages/session-engine/src/index.ts"),
    ]);

  db = openVolliDb(join(temporaryDirectory, "volli.db"));
  insertProject(db, {
    id: PROJECT_ID,
    name: "Bench",
    path: "/tmp/bench",
    ticketPrefix: "BN",
    baseBranch: "main",
    setupCommand: null,
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  const ledger = createSqliteSessionLedger(db);
  let sequence = 0;
  const provenance = {
    source: { kind: "user", id: "bench", detail: null },
    venue: { id: "local", kind: "local" },
  };
  const engineFor = (overrides = {}) =>
    engineModule.createSessionEngine({
      ledger,
      clock: { now: () => 1_000 },
      ids: { next: (kind) => `bench-${kind}-${++sequence}` },
      ...overrides,
    });

  // ── Build the roster through the production write path ──────────────────
  const engine = engineFor();
  const sessionIds = [];
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const created = await engine.createSession({
      commandId: `bench-create-${index}`,
      projectId: PROJECT_ID,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: `Bench Session ${index}`,
      provenance,
    });
    sessionIds.push(created.session.id);
    for (let event = 0; event < EVENTS_PER_SESSION; event += 1) {
      await engine.submit({
        commandId: `bench-retitle-${index}-${event}`,
        sessionId: created.session.id,
        intent: { kind: "session.retitle", title: `Bench Session ${index} rev ${event}` },
        provenance,
      });
    }
  }

  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM session_events").get().count;
  const checkpointStorage = () =>
    db
      .prepare(
        "SELECT COUNT(*) AS rows, COALESCE(MAX(LENGTH(checkpoint)), 0) AS maxBytes FROM session_projection_checkpoints",
      )
      .get();

  const query = { projectId: PROJECT_ID, scope: "all" };

  // ── Arm 0: no checkpoint row at all ─────────────────────────────────────
  // `submit` does not refresh the projection checkpoint (only `observe`
  // does), so the roster above starts with none. That is the unbounded fold:
  // the whole log per Session, which is what a Session that has never closed
  // an attachment actually costs.
  const uncheckpointed = await repeat(REPEATS, () => engineFor().listSessions(query));

  // Seed the rebuildable cache exactly as a durable runtime boundary would,
  // so every arm below measures the ≤CHECKPOINT_REFRESH_EVENTS tail the
  // ticket describes rather than a full-log fold.
  const sharedModule = await vite.ssrLoadModule("/packages/shared/src/index.ts");
  const beforeSeeding = checkpointStorage();
  await ledger.transaction((transaction) => {
    for (const session of transaction.listSessions(query)) {
      transaction.saveProjectionCheckpoint(
        sharedModule.createSessionProjectionCheckpoint(
          session,
          transaction.listEvents({ sessionId: session.id }),
        ),
      );
    }
  });
  const afterSeeding = checkpointStorage();

  // ── Arm 1: the shipped listing, cold then warm ──────────────────────────
  const cold = await measure(() => engineFor().listSessions(query));
  const warm = await repeat(REPEATS, () => engine.listSessions(query));

  // ── Arm 2: the same listing with the fold cache defeated ────────────────
  // A fresh engine per call has an empty memo, so this is the cost of the
  // chunked/yielding listing without option 2's cache.
  const uncached = await repeat(REPEATS, () => engineFor().listSessions(query));

  // ── Arm 3: the pre-VC-388 shape, for the block it used to cause ─────────
  const singleTransaction = await repeat(REPEATS, () =>
    ledger.transaction((transaction) => {
      const rows = transaction.listSessions(query);
      return rows.map((session) => {
        const checkpoint = transaction.getProjectionCheckpoint(session.id);
        const tail = transaction.listProjectionEvents({
          sessionId: session.id,
          ...(checkpoint ? { afterSequence: checkpoint.throughSequence } : {}),
        });
        return { session, tail: tail.length, checkpoint: checkpoint !== null };
      });
    }),
  );

  // ── Arm 4: chunk size × yield primitive ──────────────────────────────
  // Reimplements the loop rather than importing the constant, so each pairing
  // is measured on the same ledger through the same transaction verb.
  //
  // The primitive is a dimension and not a detail: Node clamps `setTimeout(0)`
  // to a millisecond, so a fine chunk pays that clamp once per chunk, while
  // `setImmediate` runs in the check phase with no floor at all. A sweep that
  // only measured one of them would pick a chunk size for the wrong reason.
  const primitives = {
    setImmediate: () => new Promise((done) => setImmediate(done)),
    setTimeout0: () => new Promise((done) => setTimeout(done, 0)),
  };
  const sweep = [];
  for (const [primitive, yieldToHost] of Object.entries(primitives)) {
    for (const chunk of [1, 2, 4, 8, 16, 32, SESSION_COUNT]) {
      const run = await repeat(REPEATS, async () => {
        const rows = await ledger.transaction((transaction) => transaction.listSessions(query));
        const out = [];
        for (let from = 0; from < rows.length; from += chunk) {
          if (from > 0) await yieldToHost();
          const slice = rows.slice(from, from + chunk);
          out.push(
            ...(await ledger.transaction((transaction) =>
              slice.map((session) => {
                const checkpoint = transaction.getProjectionCheckpoint(session.id);
                const tail = transaction.listProjectionEvents({
                  sessionId: session.id,
                  ...(checkpoint ? { afterSequence: checkpoint.throughSequence } : {}),
                });
                return { session, tail: tail.length };
              }),
            )),
          );
        }
        return out;
      });
      sweep.push({ primitive, chunk, ...run });
    }
  }

  // ── Arm 5: what one cached listing row weighs ───────────────────────────
  global.gc?.();
  const heapBeforeHold = process.memoryUsage().heapUsed;
  const held = await engineFor().listSessions(query);
  global.gc?.();
  const heldHeapMb = mb(process.memoryUsage().heapUsed - heapBeforeHold);

  // ── Arm 6: what one RUNTIME history entry weighs (audit item D4) ────────
  // The runtime keeps more than the engine's listing cache does: the fold AND
  // the events it was folded from. That is the entry `PROJECTION_CACHE_LIMIT`
  // bounds, so it is the one to divide a memory budget by.
  global.gc?.();
  const heapBeforeHistories = process.memoryUsage().heapUsed;
  const histories = await ledger.transaction((transaction) =>
    transaction.listSessions(query).map((session) => {
      const events = transaction.listEvents({ sessionId: session.id });
      const checkpoint = sharedModule.createSessionProjectionCheckpoint(session, events);
      return { projection: checkpoint.projection, events, checkpoint };
    }),
  );
  global.gc?.();
  const historiesHeapMb = mb(process.memoryUsage().heapUsed - heapBeforeHistories);

  console.log(
    JSON.stringify(
      {
        fixture: {
          sessions: SESSION_COUNT,
          eventsPerSession: EVENTS_PER_SESSION,
          totalEvents: eventCount,
          eventsPerSessionActual: eventCount / SESSION_COUNT,
          // `submit` never refreshes a checkpoint, so the roster genuinely
          // starts with none; the seeded count is what every arm after the
          // uncheckpointed one measures against.
          checkpointRowsBeforeSeeding: beforeSeeding.rows,
          checkpointRowsAfterSeeding: afterSeeding.rows,
          largestCheckpointBytes: afterSeeding.maxBytes,
        },
        listing: {
          uncheckpointed,
          coldMs: cold.elapsedMs,
          coldEventLoopMaxMs: cold.eventLoopMaxMs,
          warmCached: warm,
          warmUncached: uncached,
          singleTransaction,
        },
        chunkSweep: sweep,
        listingCacheEntry: {
          rows: held.length,
          heldHeapMb,
          perRowKb: (heldHeapMb * 1024) / held.length,
        },
        runtimeHistoryEntry: {
          rows: histories.length,
          heldHeapMb: historiesHeapMb,
          perRowKb: (historiesHeapMb * 1024) / histories.length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  db?.close();
  await vite.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
