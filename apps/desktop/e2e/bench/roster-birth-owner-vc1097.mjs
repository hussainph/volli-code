#!/usr/bin/env node
/**
 * VC-1097: the cold first roster read on a REAL profile's database — the
 * frozen-local membership read (`localSessionRow` scope, the signed-out
 * listing's transaction) and the unscoped base-row read the engine folds
 * from — on a fresh connection AND a cold OS file cache.
 *
 * It never touches the live profile. Point it at a checkpointed COPY:
 *
 *   cp -c volli.db /tmp/x/base.db && cp -c volli.db-wal /tmp/x/base.db-wal
 *   sqlite3 /tmp/x/base.db 'PRAGMA wal_checkpoint(TRUNCATE)'
 *   node apps/desktop/e2e/bench/roster-birth-owner-vc1097.mjs --db /tmp/x/base.db
 *
 * Every arm reads its own APFS clone of `--db` (`cp -c`): a new file is a new
 * vnode, so the OS has none of its pages cached even though the blocks are
 * shared. That is what a first read after launch sees once the file has fallen
 * out of the page cache, without `purge` (root) or touching the base copy.
 *
 * `--migrate` first runs this build's migrations above the copy's
 * `user_version` (timed; the backfill is the cost a person pays once), then
 * re-clones the migrated file so the read arms start cold again. Without it the
 * copy must already be at this build's head.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createRequire } from "node:module";

import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..", "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const BASE = argument("db", null);
if (BASE === null) throw new Error("--db <path to a checkpointed COPY of volli.db> is required");
const MIGRATE = process.argv.includes("--migrate");

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value) => Math.round(value * 10) / 10;

/** Total and worst event-loop block of one async operation. */
async function measure(operation) {
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

/** A cold clone of `source`: shared blocks, a vnode the OS has never cached. */
function coldClone(source, name) {
  const target = resolve(dirname(BASE), `${name}.db`);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${target}${suffix}`, { force: true });
  execFileSync("cp", ["-c", source, target]);
  return target;
}
const remove = (path) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
};

const require = createRequire(resolve(repository, "packages/host-core/package.json"));
const Database = require("better-sqlite3");
/** The host's own connection pragmas (`database-file.ts`). */
function open(path) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  return db;
}

const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});
const opened = [];
try {
  const { createSqliteSessionLedger } = await vite.ssrLoadModule(
    "/packages/host-core/src/session-control/sqlite-ledger.ts",
  );
  const { localSessionRow } = await vite.ssrLoadModule(
    "/packages/host-core/src/db/local-product.ts",
  );
  const { MIGRATIONS, SCHEMA_HEAD } = await vite.ssrLoadModule(
    "/packages/host-core/src/db/migrations.ts",
  );
  const report = { schemaHead: SCHEMA_HEAD };

  let source = BASE;
  if (MIGRATE) {
    const work = coldClone(BASE, "vc1097-migrate");
    opened.push(work);
    const db = open(work);
    const from = db.pragma("user_version", { simple: true });
    const pending = MIGRATIONS.filter((migration) => migration.version > from);
    report.migration = {
      from,
      to: SCHEMA_HEAD,
      ...(await measure(() => {
        db.transaction(() => {
          for (const migration of pending) {
            if (migration.apply !== undefined) migration.apply(db);
            else db.exec(migration.sql);
          }
          db.pragma(`user_version = ${SCHEMA_HEAD}`);
        })();
        return pending.map((migration) => migration.version);
      })),
    };
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    source = work;
  }

  const probe = open(coldClone(source, "vc1097-probe"));
  const project = probe
    .prepare(
      "SELECT project_id AS id, COUNT(*) AS count FROM sessions GROUP BY project_id ORDER BY count DESC LIMIT 1",
    )
    .get();
  report.sessions = probe.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  report.project = project;
  report.userVersion = probe.pragma("user_version", { simple: true });
  probe.close();
  remove(resolve(dirname(BASE), "vc1097-probe.db"));
  const query = { projectId: project.id, scope: "all" };

  /** One cold arm: a fresh clone, a new connection, the read, then the same read warm. */
  const arm = async (name, read) => {
    const path = coldClone(source, `vc1097-${name}`);
    const db = open(path);
    try {
      const cold = await measure(() => read(db));
      const warm = await measure(() => read(db));
      return { cold, warm: { elapsedMs: warm.elapsedMs } };
    } finally {
      db.close();
      remove(path);
    }
  };

  // The signed-out listing's membership transaction (`createLocalSessionEngine`).
  report.localRoster = await arm("local", (db) =>
    createSqliteSessionLedger(db, { predicate: localSessionRow }).transaction(
      (transaction) => transaction.listSessions(query).length,
    ),
  );
  // The engine's own unscoped base-row read of the same roster.
  report.baseRoster = await arm("base", (db) =>
    createSqliteSessionLedger(db).transaction(
      (transaction) => transaction.listSessions(query).length,
    ),
  );

  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const path of opened) remove(path);
  await vite.close();
}
