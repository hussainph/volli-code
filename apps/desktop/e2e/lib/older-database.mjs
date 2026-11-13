/**
 * A closed database at an older schema, for a smoke that needs a launch to
 * upgrade (VC-1208): host-core's own migrations, stopped short of the head,
 * run under plain Node on host-core's TypeScript sources. Smoke data only.
 *
 *   node apps/desktop/e2e/lib/older-database.mjs write <dbPath> <behind>
 *   node apps/desktop/e2e/lib/older-database.mjs read <dbPath>
 *
 * `write` prints `{ fromVersion, head }`; `read` prints `{ version, probe }`.
 */
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

await import("../../../../packages/host-core/src/secrets/test-support/ts-hooks.mjs");
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
const { default: Database } = await import("better-sqlite3");
const { migrate, SCHEMA_HEAD } =
  await import("../../../../packages/host-core/src/db/migrations.ts");

const [command, dbPath, behind] = process.argv.slice(2);
if (command === "write") {
  const fromVersion = SCHEMA_HEAD - Number(behind);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db, dbPath, { toVersion: fromVersion });
  db.prepare(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('smoke-probe', 'kept', 1)",
  ).run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(JSON.stringify({ fromVersion, head: SCHEMA_HEAD }));
} else if (command === "read") {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const version = db.pragma("user_version", { simple: true });
  const probe = db.prepare("SELECT value FROM app_state WHERE key = 'smoke-probe'").get();
  db.close();
  console.log(JSON.stringify({ version, probe: probe?.value ?? null }));
} else {
  console.error("usage: older-database.mjs write <dbPath> <behind> | read <dbPath>");
  process.exit(2);
}
