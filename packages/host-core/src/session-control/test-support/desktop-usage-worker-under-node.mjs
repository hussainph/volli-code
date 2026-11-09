// Config-level deployment check: load the desktop's configured source entry,
// not a parallel call to serveUsageReportWorker. No build or Electron launch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { basename } from "node:path";
await import("../../secrets/test-support/ts-hooks.mjs");
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
const desktop = new URL("../../../../../apps/desktop/", import.meta.url);
const config = readFileSync(new URL("vite.config.ts", desktop), "utf8");
const main = readFileSync(new URL("src/main/index.ts", desktop), "utf8");
const entry = /"usage-report-worker":\s*"([^"]+)"/.exec(config)?.[1];
const launch = /usageReportWorker:\s*join\(__dirname,\s*"([^"]+)"\)/.exec(main)?.[1];
assert.ok(entry, "Vite must bundle a usage-report-worker entry");
assert.ok(launch, "desktop must configure its usage report worker");
assert.match(config, /outExtensions:\s*\(\)\s*=>\s*\(\{\s*js:\s*"\.cjs"\s*\}\)/);
assert.equal(
  launch,
  `${basename(entry, ".ts")}.cjs`,
  "launch filename must match the bundled entry",
);
await import(new URL(entry, desktop).href);
