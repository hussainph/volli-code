#!/usr/bin/env node
/**
 * Renderer ↔ preload ↔ main Session-edge transport benchmark (VC-355).
 *
 * This isolates Electron transport and structured-clone cost from tRPC, the
 * Session handler, and SQLite. The production link's optional performance
 * observer supplies procedure counts, router time, push-handler time, and
 * pre-ack backlog when the full interaction harness drives the app.
 *
 * Run:
 *   node apps/desktop/e2e/session-rpc-bench.mjs [--repetitions 300] [--frames 20000]
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(here, "..");
const benchDirectory = join(here, "bench", "session-rpc");
const electron = (await import(join(appDirectory, "node_modules", "electron", "index.js"))).default;

const child = spawn(
  electron,
  [join(benchDirectory, "electron-main.cjs"), ...process.argv.slice(2)],
  {
    cwd: appDirectory,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
child.stdout.on("data", (chunk) => {
  output += String(chunk);
});
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
if (exitCode !== 0) throw new Error(`Electron Session RPC benchmark exited ${exitCode}`);
const match = /__SESSION_RPC_BENCH__(?<json>.*)__SESSION_RPC_BENCH__/s.exec(output);
if (!match?.groups?.json) throw new Error("Electron Session RPC benchmark printed no report");
const report = JSON.parse(match.groups.json);

console.log("payload bytes\tp50 ms\tp95 ms\tclone in p50\tclone out p50");
for (const row of report.payloadCurve) {
  console.log(
    [
      row.payloadBytes,
      row.totalMs.p50.toFixed(3),
      row.totalMs.p95.toFixed(3),
      row.cloneInMs.p50.toFixed(3),
      row.cloneOutMs.p50.toFixed(3),
    ].join("\t"),
  );
}
console.log(
  `push: ${report.push.frames} frames, ${report.push.framesPerSecond.toFixed(0)} frames/s, ` +
    `renderer handler p50 ${report.push.rendererHandlerMs.p50.toFixed(4)} ms, ` +
    `main event-loop max ${report.push.main.eventLoopMaxMs.toFixed(3)} ms`,
);
console.log(`\n__SESSION_RPC_BENCH__${JSON.stringify(report)}__SESSION_RPC_BENCH__`);
