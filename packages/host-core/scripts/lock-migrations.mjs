#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "vite";
import {
  appendMissingMigrationLocks,
  LOCK_PATH,
  MIGRATIONS_PATH,
  migrationFingerprints,
} from "./migrations-lock.mjs";

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const { MIGRATIONS } = await server.ssrLoadModule(MIGRATIONS_PATH);
  const original = readFileSync(LOCK_PATH, "utf8");
  const next = appendMissingMigrationLocks(MIGRATIONS, migrationFingerprints(MIGRATIONS), original);
  if (next !== original) writeFileSync(LOCK_PATH, next);
  console.log(
    next === original ? "Migration lock is current" : "Appended missing migration lock entries",
  );
} finally {
  await server.close();
}
