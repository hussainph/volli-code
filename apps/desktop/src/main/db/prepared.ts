/**
 * A per-db-handle prepared-statement cache. better-sqlite3 does not cache
 * prepared statements — every `db.prepare(sql)` re-parses and re-plans the SQL
 * — so the repos' hot paths (the per-row UPDATE inside a board-move
 * transaction, `recordTicketEvent` in every ticket mutation, the per-label
 * lookups inside set-labels) memoize statements by SQL text, per handle.
 *
 * The WeakMap key (rather than a module-level Map) means a second db handle
 * (e.g. in tests, or a `VOLLI_DB_PATH` reopen) gets its own cache and can't
 * collide with — or leak past — another handle's lifetime; a closed handle's
 * cache is collected with it.
 */
import type Database from "better-sqlite3";

const stmtCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepared<Params extends unknown[] = unknown[], Row = unknown>(
  db: Database.Database,
  sql: string,
): Database.Statement<Params, Row> {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare<Params, Row>(sql) as Database.Statement;
    cache.set(sql, stmt);
  }
  return stmt as Database.Statement<Params, Row>;
}
