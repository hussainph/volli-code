#!/usr/bin/env node
/** INSTALLER TEST FIXTURE. No backend, model, Session or online claim is made here. */
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: { "data-dir": { type: "string" }, "config-dir": { type: "string" } },
});
const dataDir = values["data-dir"];
const configDir = values["config-dir"];
if (!dataDir || !configDir || process.getuid() === 0)
  throw new Error("Fixture needs explicit paths and a nonroot service uid.");
const version = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../MANIFEST.json"), "utf8"),
).version;
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lock = new Database(join(dataDir, "runner.lock"));
lock.pragma("busy_timeout = 0");
lock.exec("CREATE TABLE IF NOT EXISTS runner_instance (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE");
const socketPath = join(dataDir, "volli.sock");
rmSync(socketPath, { force: true });
const startedAt = new Date().toISOString();
let canWriteRelease = true;
try {
  accessSync(resolve(import.meta.dirname, ".."), constants.W_OK);
} catch {
  canWriteRelease = false;
}
const status = (state) => {
  const target = join(dataDir, "runner-status.json");
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({
      v: 1,
      state,
      pid: process.pid,
      version,
      startedAt,
      updatedAt: new Date().toISOString(),
      dataDir,
      socketPath,
      link: null,
      backend: null,
      update: null,
      credentials: null,
      fixture: {
        runtime: "installer-only-unlinked",
        uid: process.getuid(),
        service: process.env.VOLLI_RUNNER_SERVICE === "1",
        proxyConfigured:
          process.env.HTTPS_PROXY === "http://fixture-user:fixture-password@127.0.0.1:9",
        canWriteRelease,
      },
    }),
    { mode: 0o600 },
  );
  renameSync(temp, target);
};
// This must succeed inside ProtectSystem=full: token/key rotation needs writable config.
writeFileSync(join(configDir, "installer-config-probe"), "service uid can write config\n", {
  mode: 0o600,
});
if (!process.env.VOLLI_SECRET_KEY_FILE)
  throw new Error("Unit did not name its external secrets key.");
try {
  writeFileSync(process.env.VOLLI_SECRET_KEY_FILE, `${randomBytes(32).toString("base64")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const server = createServer((socket) => socket.end());
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  status("unlinked");
  console.log("INSTALLER TEST FIXTURE: active and status reachable; not online, no cloud work.");
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    server.close(() => {
      status("stopped");
      lock.close();
      rmSync(socketPath, { force: true });
      process.exit(0);
    }),
  );
