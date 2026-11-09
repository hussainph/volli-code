#!/usr/bin/env node
/**
 * VC-848: what one resident listing row weighs, field by field, on a REAL
 * profile's database — and what the listing fold cache holds per Session.
 *
 * The listing fold cache keeps one frozen row per listed Session for as long
 * as the host runs. This lists every project's whole roster through one
 * engine, as a host that has visited every project would, then reports:
 *
 *  - `heap`: the retained heap of that engine (its cache) per listed Session,
 *    measured as the heap delta of building it, after a full GC;
 *  - `rowFieldsPerSession`: for each top-level field of the rows it returned,
 *    the heap a copy of that field alone retains, and its JSON size;
 *  - `historyArrays`: how many commands and receipts each Session's full
 *    projection (`getSession`) carries.
 *
 * Listings write checkpoints back (VC-1076), so point it at a COPY of the
 * profile (`volli.db` + `-wal`), never the live one:
 *
 *   cp -c volli.db /tmp/x/work.db && cp -c volli.db-wal /tmp/x/work.db-wal
 *   node --expose-gc apps/desktop/e2e/bench/listing-row-weight-vc848.mjs --db /tmp/x/work.db
 *
 * Run it twice on the same copy and read the second run: the first one pays
 * the checkpoint write-back, and its heap includes nothing that run does not.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..", "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const DB_PATH = argument("db", null);
if (DB_PATH === null) throw new Error("--db <path to a COPY of volli.db> is required");
if (typeof global.gc !== "function") throw new Error("run with node --expose-gc");

/** Heap still reachable after a full collection, in bytes. */
const settledHeap = () => {
  for (let pass = 0; pass < 4; pass += 1) global.gc();
  return process.memoryUsage().heapUsed;
};
const kb = (bytes) => Math.round(bytes / 102.4) / 10;

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
  const { createSqliteSessionLedger } = await vite.ssrLoadModule(
    "/packages/host-core/src/session-control/sqlite-ledger.ts",
  );
  const { createHostSessionEngine } = await vite.ssrLoadModule(
    "/packages/host-core/src/sessions/engine.ts",
  );

  db = openVolliDb(DB_PATH);
  const ledger = createSqliteSessionLedger(db);
  const projects = db
    .prepare("SELECT project_id AS id FROM sessions GROUP BY project_id ORDER BY COUNT(*) DESC")
    .all()
    .map((row) => row.id);

  let next = 0;
  const listEverything = async (engine) => {
    const rows = [];
    for (const projectId of projects) {
      rows.push(...(await engine.listSessions({ projectId, scope: "all" })));
    }
    return rows;
  };

  const newEngine = () =>
    createHostSessionEngine(ledger, {
      nextId: () => `vc848-${++next}`,
      onProjectionCheckpointFailure: () => {},
    });

  // Warm what is not the cache: the connection's birth-payload memo, the
  // statement cache, the module graph, and any checkpoint write-back. The
  // warm engine stays referenced on purpose: a dropped engine was measured to
  // stay reachable until the NEXT listing ran, so it would be released during
  // the measured listing and cancel out of its delta.
  const warm = newEngine();
  await listEverything(warm);

  // ── The resident cache: one engine that has listed every roster ────────
  const before = settledHeap();
  const engine = newEngine();
  const listedAt = performance.now();
  let rows = await listEverything(engine);
  // A fresh engine over persisted checkpoints: every row is a cache miss.
  const coldListingMs = Math.round(performance.now() - listedAt);
  const resident = settledHeap() - before;
  const count = rows.length;

  // ── Each field on its own ──────────────────────────────────────────────
  // A structured clone of one field across every row: the heap that field
  // alone retains, measured the same way as the whole.
  const fieldNames = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const fields = {};
  for (const name of fieldNames) {
    const start = settledHeap();
    let held = rows.map((row) => (name in row ? structuredClone(row[name]) : undefined));
    const heap = settledHeap() - start;
    let json = 0;
    for (const value of held) json += value === undefined ? 0 : JSON.stringify(value).length;
    held = null;
    fields[name] = {
      heapKB: kb(heap / count),
      jsonKB: kb(json / count),
      heapTotalMB: kb(heap / 1024),
    };
  }
  const ordered = Object.fromEntries(
    Object.entries(fields).toSorted(([, a], [, b]) => b.heapTotalMB - a.heapTotalMB),
  );

  // How long the history arrays a full projection carries are, from each
  // Session's own read (a listing row may not carry them).
  const full = [];
  for (const row of rows) full.push(await engine.getSession({ sessionId: row.session.id }));
  const lengths = (name) => {
    const sizes = full
      .map((projection) => projection?.[name]?.length ?? 0)
      .toSorted((a, b) => a - b);
    return {
      mean: Math.round((sizes.reduce((sum, n) => sum + n, 0) / count) * 10) / 10,
      p50: sizes[Math.floor(count / 2)],
      p99: sizes[Math.floor(count * 0.99)],
      max: sizes.at(-1),
    };
  };
  const arrays = { commands: lengths("commands"), receipts: lengths("receipts") };
  full.length = 0;
  rows = null;

  const report = {
    projects: projects.length,
    sessions: count,
    residentHeap: { totalMB: kb(resident / 1024), perSessionKB: kb(resident / count) },
    coldListingMs,
    historyArrays: arrays,
    rowFieldsPerSession: ordered,
  };
  console.log(JSON.stringify(report, null, 2));
  // Both engines stay reachable until every measurement above has been taken.
  if (warm === engine) console.log("unreachable");
} finally {
  db?.close();
  await vite.close();
}
