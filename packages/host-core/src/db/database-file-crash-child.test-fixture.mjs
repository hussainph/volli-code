// Child process for database-file.test.ts: runs publishRollbackPoint on a
// real database and SIGKILLs itself just before its Nth disk-changing step.
// argv: <dbPath> <version> <killIndex>
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

const [dbPath, version, killIndex] = process.argv.slice(2);
const server = await createServer({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
});
const { publishRollbackPoint } = await server.ssrLoadModule("/src/db/database-file.ts");
const db = new Database(dbPath);
let seen = 0;
publishRollbackPoint(db, dbPath, Number(version), {
  faults(step) {
    if (seen++ !== Number(killIndex)) return;
    process.stdout.write(`SIGKILL before ${step}\n`);
    process.kill(process.pid, "SIGKILL");
  },
});
process.stdout.write("completed without reaching the kill point\n");
db.close();
await server.close();
