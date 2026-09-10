/**
 * Chat-transcript memory bench (VC-338) — NOT wired into `vp test`.
 *
 * Question under test: what does one long Session's chat plane cost the
 * renderer, in document size and in resident memory, and what does a surface
 * that mounts ten of them cost?
 *
 * It is the real `ChatPlane` (see `bench/chat-window/main.tsx`) in a real
 * Electron renderer, with fixture transcripts in one real chat-sessions store.
 * The shape it reproduces is the app's: every open Session keeps its slice
 * whether or not it is in front, and what varies is how many planes are
 * MOUNTED.
 *
 * Run:
 *   node apps/desktop/e2e/chat-window-bench.mjs [--sessions 10] [--turns 2000]
 *
 * The before/after in the PR is this script run twice over the same fixtures,
 * with the transcript components checked out from `main` for the "before" arm:
 *
 *   git checkout origin/main -- apps/desktop/src/renderer/src/components/chat \
 *     apps/desktop/src/renderer/src/components/ui/ai-elements/conversation.tsx
 *   node apps/desktop/e2e/chat-window-bench.mjs --label before
 *   git checkout HEAD -- apps/desktop/src/renderer/src/components
 *   node apps/desktop/e2e/chat-window-bench.mjs --label after
 *
 * Numbers from one machine under one load are comparable to each other and to
 * nothing else; run both arms back to back.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = join(HERE, "bench", "chat-window");
const APP = join(HERE, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const SESSIONS = flag("sessions", "10");
const TURNS = flag("turns", "2000");
const LABEL = flag("label", "run");

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "inherit"], ...options });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

const electron = (await import(join(APP, "node_modules", "electron", "index.js"))).default;

// Vite's Node API rather than its CLI: `vite` has no linked bin in this
// workspace (the app builds through `vp`), and a bench that shells out to a
// binary that may not be there fails for a reason that has nothing to do with
// what it measures.
console.log(`building the bench page (${BENCH})`);
const { build } = await import("vite");
await build({ configFile: join(BENCH, "vite.config.ts") });

console.log(`\nrunning: ${SESSIONS} sessions x ${TURNS} turns`);
const output = await run(
  electron,
  [
    join(BENCH, "electron-main.cjs"),
    "--dist",
    join(BENCH, "dist"),
    "--sessions",
    SESSIONS,
    "--turns",
    TURNS,
    "--label",
    LABEL,
  ],
  { cwd: APP, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } },
);

const match = /__BENCH__(?<json>.*)__BENCH__/s.exec(output);
if (match?.groups?.json === undefined) {
  console.error("the bench printed no report");
  process.exitCode = 1;
} else {
  const report = JSON.parse(match.groups.json);
  console.log(`\n=== ${report.label}: ${report.sessions} sessions x ${report.turns} turns ===`);
  console.log(
    ["step", "DOM nodes", "renderer RSS MB", "spread", "JS heap MB"].join("\t"),
    "\n" +
      report.steps
        .map((step) =>
          [step.step, step.nodes, step.rendererRssMb, step.rssSpreadMb, step.jsHeapMb].join("\t"),
        )
        .join("\n"),
  );
  console.log("\nchecks:", JSON.stringify(report.checks, null, 2));
  if (report.errors?.length > 0) console.log("console errors:", report.errors.slice(0, 5));
  if (report.failure !== undefined) {
    console.error("\nbench failed:", report.failure);
    process.exitCode = 1;
  }
}
