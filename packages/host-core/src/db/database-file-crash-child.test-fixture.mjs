// Child process for database-file.test.ts: runs publishRollbackPoint on a
// real database and SIGKILLs itself just before its Nth disk-changing step.
// argv: <dbPath> <version> <killIndex>
//    or: --restore <dbPath> <sourcePath> <schemaVersion> <step>
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

const args = process.argv.slice(2);
const server = await createServer({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
});
const { publishRollbackPoint, restoreDatabaseFile } = await server.ssrLoadModule(
  "/src/db/database-file.ts",
);
function kill(step) {
  process.stdout.write(`SIGKILL before ${step}\n`);
  process.kill(process.pid, "SIGKILL");
}
if (args[0] === "--restore") {
  const [, dbPath, sourcePath, schemaVersion, killStep] = args;
  restoreDatabaseFile({
    dbPath,
    sourcePath,
    schemaVersion: Number(schemaVersion),
    faults(step) {
      if (step === killStep) kill(step);
    },
  });
} else {
  const [dbPath, version, killIndex] = args;
  const db = new Database(dbPath);
  let seen = 0;
  publishRollbackPoint(db, dbPath, Number(version), {
    faults(step) {
      if (seen++ === Number(killIndex)) kill(step);
    },
  });
  db.close();
}
process.stdout.write("completed without reaching the kill point\n");
await server.close();
