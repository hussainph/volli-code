// Real shipped worker protocol, loading TypeScript sources as the host bundler
// does. Transform mode also supports the ledger's parameter properties.
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
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
const { serveUsageReportWorker } = await import("../usage-report-worker.ts");
serveUsageReportWorker();
