// Focused, read-only report benchmark. Run with the pinned Node runtime after
// installing dependencies:
// vp env exec --node 24.22.1 -- node packages/host-core/bench/usage-report.mjs <snapshot.db>
// The input must be a consistent SQLite backup, not a copy of a live WAL file.
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
await import("../src/secrets/test-support/ts-hooks.mjs");
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" }),
      shortCircuit: true,
    };
  },
});
const { createSqliteSessionLedger } = await import("../src/session-control/sqlite-ledger.ts");
const { installSqliteUsageWorker } = await import("../src/session-control/usage-reports.ts");
const { localSessionRow } = await import("../src/db/local-product.ts");
const path = process.argv[2];
if (!path) throw new Error("Usage: usage-report.mjs <snapshot.db> [--all-groups]");
const db = new Database(resolve(path), { readonly: true, fileMustExist: true });
const localOnly = !process.argv.includes("--unscoped");
const ownership = localOnly ? localSessionRow("session_usage.session_id") : "1 = 1";
const ledger = createSqliteSessionLedger(
  db,
  localOnly ? { predicate: localSessionRow } : undefined,
);
const largest = (column) =>
  db
    .prepare(`SELECT ${column} AS id FROM session_usage
  WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY count(*) DESC LIMIT 1`)
    .get()?.id;
const scopes = [
  { kind: "all" },
  { kind: "project", projectId: largest("project_id") ?? "absent" },
  { kind: "ticket", ticketId: largest("ticket_id") ?? "absent" },
  { kind: "session", sessionId: largest("session_id") ?? "absent" },
];
const { rows, latest } = db
  .prepare("SELECT count(*) AS rows, max(occurred_at) AS latest FROM session_usage")
  .get();
console.log(
  JSON.stringify({
    rows,
    localOnly,
    sqlite: db.prepare("SELECT sqlite_version() AS version").get().version,
  }),
);

// groupBy is not part of the SQL: all five groupings read the same rows and
// differ only in the pure JS fold. Show the exact query shape for every scope
// and window; do not print private project, ticket or Session identifiers.
for (const scope of scopes) {
  for (const since of [undefined, latest - 30 * 86_400_000]) {
    const column = scope.kind === "all" ? undefined : `${scope.kind}_id`;
    const value = scope.projectId ?? scope.ticketId ?? scope.sessionId;
    const where =
      (column ? ` AND ${column} = @target` : "") +
      (since === undefined ? "" : " AND occurred_at >= @since");
    const bindings = {
      ...(column ? { target: value } : {}),
      ...(since === undefined ? {} : { since }),
    };
    const sql = `SELECT session_id, project_id, ticket_id, occurred_at, cause, provider_id, model_id,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_basis
      FROM session_usage WHERE 1 = 1${where} AND ${ownership}
      ORDER BY occurred_at DESC, event_id COLLATE BINARY DESC`;
    console.log(
      JSON.stringify({
        scope: scope.kind,
        window: since === undefined ? "all" : "30d",
        plan: db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(bindings)
          .map((row) => row.detail),
      }),
    );
  }
}

async function measure(read) {
  await setImmediate();
  let previous = performance.now();
  let maxMainGapMs = 0;
  const timer = globalThis.setInterval(() => {
    const now = performance.now();
    maxMainGapMs = Math.max(maxMainGapMs, now - previous);
    previous = now;
  }, 5);
  await setTimeout(10);
  const start = performance.now();
  try {
    const report = await read();
    const wallMs = performance.now() - start;
    await setTimeout(10);
    return { report, wallMs: +wallMs.toFixed(2), maxMainGapMs: +maxMainGapMs.toFixed(2) };
  } finally {
    clearInterval(timer);
  }
}
const groupings = process.argv.includes("--all-groups")
  ? [undefined, "ticket", "session", "model", "day", "cause"]
  : ["model"];
const queries = scopes.flatMap((scope) =>
  groupings.map((groupBy) => ({
    scope,
    groupBy,
    since: scope.kind === "project" ? latest - 30 * 86_400_000 : undefined,
  })),
);
const timing = ({ wallMs, maxMainGapMs }) => ({ wallMs, maxMainGapMs });
const before = [];
for (const query of queries) before.push(await measure(() => ledger.reportUsage(query)));
const stop = installSqliteUsageWorker(
  db,
  new URL("../src/session-control/test-support/usage-worker-under-node.mjs", import.meta.url),
);
try {
  const cold = await measure(() =>
    ledger.reportUsage({ scope: { kind: "session", sessionId: "absent" } }),
  );
  console.log(
    JSON.stringify({ workerStartup: { wallMs: cold.wallMs, maxMainGapMs: cold.maxMainGapMs } }),
  );
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const after = await measure(() => ledger.reportUsage(query));
    assert.deepEqual(after.report, before[i].report);

    console.log(
      JSON.stringify({
        scope: query.scope.kind,
        groupBy: query.groupBy ?? "none",
        requests: after.report.total.requestCount,
        before: timing(before[i]),
        after: timing(after),
        identical: true,
      }),
    );
  }
} finally {
  await stop();
  db.close();
}
