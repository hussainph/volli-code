#!/usr/bin/env node
/**
 * VC-355 SQLite/projection/router benchmark against an existing Volli DB copy.
 * The input is never written. A temporary copy takes the production migration
 * path before checkpoint measurements.
 *
 * Run with exposed GC for repeatable heap deltas:
 *   node --expose-gc apps/desktop/e2e/session-rpc-sqlite-bench.mjs --database /path/to/volli.db
 */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(here, "..");
const repository = resolve(appDirectory, "..", "..");
const require = createRequire(join(appDirectory, "package.json"));
const Database = require("better-sqlite3");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const databasePath = argument("database");
const transcriptPath = argument("transcripts");
if (!databasePath) throw new Error("--database /path/to/volli.db is required");

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const mb = (bytes) => bytes / 1024 / 1024;
function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}
function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
async function repeated(count, operation) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return distribution(values);
}
async function blocking(operation) {
  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  await wait(10);
  const startedAt = performance.now();
  const result = operation();
  const elapsedMs = performance.now() - startedAt;
  const memoryAfter = process.memoryUsage();
  await wait(10);
  delay.disable();
  return {
    ...result,
    elapsedMs,
    heapDeltaMb: mb(memoryAfter.heapUsed - memoryBefore.heapUsed),
    rssDeltaMb: mb(memoryAfter.rss - memoryBefore.rss),
    eventLoopMaxMs: Number(delay.max) / 1e6,
  };
}

const rawDb = new Database(databasePath, { readonly: true, fileMustExist: true });
const counts = {
  sessions: rawDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
  events: rawDb.prepare("SELECT COUNT(*) AS count FROM session_events").get().count,
  commands: rawDb.prepare("SELECT COUNT(*) AS count FROM session_commands").get().count,
};
const busiest = rawDb
  .prepare(
    `SELECT session_id AS sessionId, COUNT(*) AS count
       FROM session_events
      GROUP BY session_id
      ORDER BY count DESC
      LIMIT 1`,
  )
  .get();
const fullLogSql = `SELECT e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at,
                           p.provenance, e.attachment_id, e.command_id, e.payload
                      FROM session_events e
                      LEFT JOIN session_provenances p ON p.id = e.provenance_id
                     ORDER BY e.session_id, e.sequence`;
const decode = (row) => ({
  ...row,
  provenance: JSON.parse(row.provenance),
  payload: JSON.parse(row.payload),
});
const materialized = await blocking(() => {
  const rows = rawDb.prepare(fullLogSql).all();
  const decoded = rows.map(decode);
  return {
    rows: decoded.length,
    serializedMb: mb(
      rows.reduce((bytes, row) => bytes + row.payload.length + row.provenance.length, 0),
    ),
  };
});
global.gc?.();
const iterated = await blocking(() => {
  const decoded = [];
  let serializedBytes = 0;
  for (const row of rawDb.prepare(fullLogSql).iterate()) {
    serializedBytes += row.payload.length + row.provenance.length;
    decoded.push(decode(row));
  }
  return { rows: decoded.length, serializedMb: mb(serializedBytes) };
});

rawDb.pragma("cache_size = -64000");
rawDb.pragma("mmap_size = 268435456");
rawDb.pragma("temp_store = MEMORY");
const sessionStatement = rawDb.prepare(
  `SELECT e.id, e.session_id, e.sequence, e.occurred_at, e.recorded_at,
          p.provenance, e.attachment_id, e.command_id, e.payload
     FROM session_events e
     LEFT JOIN session_provenances p ON p.id = e.provenance_id
    WHERE e.session_id = ?
    ORDER BY e.sequence`,
);
for (let index = 0; index < 20; index += 1) sessionStatement.all(busiest.sessionId);
const busiestRead = await repeated(100, () => sessionStatement.all(busiest.sessionId));
const latestSequenceStatement = rawDb.prepare(
  "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM session_events WHERE session_id = ?",
);
const latestSequence = await repeated(500, () => latestSequenceStatement.get(busiest.sessionId));
rawDb.close();

const temporaryDirectory = await mkdtemp(join(tmpdir(), "volli-vc355-"));
const migratedPath = join(temporaryDirectory, basename(databasePath));
await copyFile(databasePath, migratedPath);
const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});
let productionDb;
let runtime;
try {
  const [
    { openVolliDb },
    { createSqliteSessionLedger },
    engineModule,
    transcriptModule,
    sharedModule,
  ] = await Promise.all([
    vite.ssrLoadModule("/apps/desktop/src/main/db/index.ts"),
    vite.ssrLoadModule("/apps/desktop/src/main/session-control/sqlite-ledger.ts"),
    vite.ssrLoadModule("/packages/session-engine/src/index.ts"),
    vite.ssrLoadModule("/apps/desktop/src/main/session-runtime/transcript-artifacts.ts"),
    vite.ssrLoadModule("/packages/shared/src/index.ts"),
  ]);
  productionDb = openVolliDb(migratedPath);
  const ledger = createSqliteSessionLedger(productionDb);
  let id = 0;
  const engine = engineModule.createSessionEngine({
    ledger,
    clock: { now: () => Date.now() },
    ids: { next: (kind) => `bench-${kind}-${++id}` },
  });
  const projectIds = productionDb
    .prepare("SELECT DISTINCT project_id AS projectId FROM sessions ORDER BY project_id")
    .all()
    .map((row) => row.projectId);
  const listAllSessions = async () => {
    let listed = 0;
    for (const projectId of projectIds) {
      listed += (await engine.listSessions({ projectId, scope: "all" })).length;
    }
    return listed;
  };
  productionDb.exec("DELETE FROM session_projection_checkpoints");
  const listingColdStartedAt = performance.now();
  const listedCold = await listAllSessions();
  const listingColdMs = performance.now() - listingColdStartedAt;
  // Projection reads are deliberately side-effect free. Seed the rebuildable
  // cache explicitly, as a runtime durable boundary would in production.
  await ledger.transaction((transaction) => {
    for (const projectId of projectIds) {
      for (const session of transaction.listSessions({ projectId, scope: "all" })) {
        transaction.saveProjectionCheckpoint(
          sharedModule.createSessionProjectionCheckpoint(
            session,
            transaction.listEvents({ sessionId: session.id }),
          ),
        );
      }
    }
  });
  const listingCheckpointMs = await repeated(5, listAllSessions);
  const checkpointStorage = productionDb
    .prepare(
      `SELECT COUNT(*) AS rows,
              COALESCE(SUM(LENGTH(checkpoint)), 0) AS bytes,
              COALESCE(MAX(LENGTH(checkpoint)), 0) AS maxBytes
         FROM session_projection_checkpoints`,
    )
    .get();

  const makeRuntime = () =>
    engineModule.createSessionRuntime({
      engine,
      executor: {
        id: "bench",
        durableIdNamespace: "bench",
        adapterVersion: "1",
        runtime: { path: "/bench", version: "1", fingerprint: "bench" },
        attach: async () => {
          throw new Error("benchmark projection never attaches");
        },
      },
      artifacts: transcriptPath
        ? transcriptModule.createFileTranscriptArtifactStore(transcriptPath)
        : engineModule.createInMemoryTranscriptArtifactStore(),
      locations: {
        resolve: async () => ({ directory: "/bench", venue: { id: "bench", kind: "local" } }),
        prepare: async () => ({ directory: "/bench", venue: { id: "bench", kind: "local" } }),
        reaffirm: async () => undefined,
      },
      clock: { now: () => Date.now() },
      ids: { next: (kind) => `bench-runtime-${kind}-${++id}` },
    });

  const checkpointDelete = productionDb.prepare(
    "DELETE FROM session_projection_checkpoints WHERE session_id = ?",
  );
  const coldFullFoldSamples = [];
  for (let index = 0; index < 15; index += 1) {
    checkpointDelete.run(busiest.sessionId);
    runtime = makeRuntime();
    const startedAt = performance.now();
    await runtime.projection({ sessionId: busiest.sessionId });
    coldFullFoldSamples.push(performance.now() - startedAt);
    await runtime.close();
  }
  runtime = makeRuntime();
  await runtime.projection({ sessionId: busiest.sessionId });
  await runtime.close();
  const coldCheckpointSamples = [];
  for (let index = 0; index < 50; index += 1) {
    runtime = makeRuntime();
    const startedAt = performance.now();
    await runtime.projection({ sessionId: busiest.sessionId });
    coldCheckpointSamples.push(performance.now() - startedAt);
    await runtime.close();
  }

  const handlerRuntime = makeRuntime();
  await handlerRuntime.projection({ sessionId: busiest.sessionId });
  const handlerMs = await repeated(200, () =>
    handlerRuntime.projection({ sessionId: busiest.sessionId }),
  );
  const rpcModule = await vite.ssrLoadModule("/packages/session-rpc/src/index.ts");
  const caller = rpcModule.createSessionRouter().createCaller({
    runtime: handlerRuntime,
    diagnostics: new rpcModule.RpcDiagnosticLog({ capacity: 1_000 }),
    transport: "electron-ipc",
  });
  const routerMs = await repeated(200, () =>
    caller.session.projection({ sessionId: busiest.sessionId }),
  );
  let snapshot = null;
  if (transcriptPath) {
    let responseBytes = 0;
    const snapshotMs = await repeated(10, async () => {
      const response = await caller.session.snapshot({ sessionId: busiest.sessionId });
      responseBytes = Buffer.byteLength(JSON.stringify(response));
    });
    snapshot = { responseBytes, latencyMs: snapshotMs };
  }
  await handlerRuntime.close();

  const report = {
    input: { counts, busiest: { eventCount: busiest.count } },
    sqlite: {
      materializedAll: materialized,
      iteratedDecode: iterated,
      busiestSessionReadMs: busiestRead,
      latestSequenceMs: latestSequence,
    },
    projection: {
      allSessionListing: {
        sessions: listedCold,
        coldFullFoldMs: listingColdMs,
        checkpointMs: listingCheckpointMs,
        storage: checkpointStorage,
      },
      coldFullFoldMs: distribution(coldFullFoldSamples),
      coldCheckpointMs: distribution(coldCheckpointSamples),
      warmHandlerMs: handlerMs,
    },
    rpc: {
      routerValidationHandlerMs: routerMs,
      longSessionSnapshot: snapshot,
      routerValidationOverheadMs: {
        p50: Math.max(0, routerMs.p50 - handlerMs.p50),
        p95: Math.max(0, routerMs.p95 - handlerMs.p95),
      },
      note: "SessionRouterJsonSafety is a compile-time proof; this measures actual tRPC dispatch and Zod parsing.",
    },
  };
  console.log(`__SESSION_RPC_SQLITE_BENCH__${JSON.stringify(report)}__SESSION_RPC_SQLITE_BENCH__`);
} finally {
  await runtime?.close().catch(() => undefined);
  productionDb?.close();
  await vite.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
