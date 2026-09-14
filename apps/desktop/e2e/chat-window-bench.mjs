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
import { readFile, readdir } from "node:fs/promises";
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
const STREAM_SAMPLES = flag("stream-samples", "8");
const STREAM_STEPS = flag("stream-steps", "120");
const STREAM_TOKEN_RATE = flag("stream-token-rate", "30");
const SKIP_BUILD = args.includes("--skip-build");

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
if (!SKIP_BUILD) {
  console.log(`building the bench page (${BENCH})`);
  // Vite reads an inherited NODE_ENV in preference to the build mode, and a
  // caller that touched a Vite dev server first exports `development`. A bench
  // page is only worth building the way the app ships, so say so here instead
  // of depending on who spawned this process.
  process.env.NODE_ENV = "production";
  const { build } = await import("vite");
  await build({ configFile: join(BENCH, "vite.config.ts"), mode: "production", logLevel: "warn" });
}

/**
 * A benchmark that measures a development React build measures nothing the
 * product ships. This happened: React's dual-build entry is a `require` behind
 * `process.env.NODE_ENV`, the bench bundled both halves and ran the debug one,
 * and its profiling instrumentation was inside every frame this bench times.
 * The build now pins production explicitly — and this refuses to measure
 * anything until the emitted bundle proves it, because the failure mode is a
 * plausible-looking number rather than a crash.
 */
async function assertProductionReact(distDir) {
  const assets = join(distDir, "assets");
  const entries = await readdir(assets).catch(() => []);
  const bundles = entries.filter((name) => name.startsWith("index-") && name.endsWith(".js"));
  if (bundles.length === 0) throw new Error(`no bench bundle found in ${assets}`);
  // String literals survive minification; identifiers do not. The first two
  // exist only in react-dom's development build; `jsxDEV)(` is the minified
  // shape of a development JSX call, which carries per-element source metadata
  // and, against production React, does not even run.
  const developmentOnly = [
    "Consider memoization",
    "Each child in a list should have a unique",
    "jsxDEV)(",
  ];
  for (const bundle of bundles) {
    const source = await readFile(join(assets, bundle), "utf8");
    const found = developmentOnly.filter((marker) => source.includes(marker));
    if (found.length > 0) {
      throw new Error(
        `${bundle} was built for development (${found.join(", ")}); the bench must measure the build the app ships`,
      );
    }
  }
}

await assertProductionReact(join(BENCH, "dist"));

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
    "--stream-samples",
    STREAM_SAMPLES,
    "--stream-steps",
    STREAM_STEPS,
    "--stream-token-rate",
    STREAM_TOKEN_RATE,
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
  if (report.streamingSamples?.length > 0) {
    const latencies = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.latencyMs.toFixed(1) : "failed",
    );
    const dropped = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.droppedFrames : "failed",
    );
    const longTasks = report.streamingSamples.map((sample) =>
      sample.ok === true ? sample.longTasksMs.length : "failed",
    );
    console.log(
      `stream+scroll (${STREAM_TOKEN_RATE} tokens/s): latency ms [${latencies.join(", ")}], ` +
        `dropped [${dropped.join(", ")}], long tasks [${longTasks.join(", ")}]`,
    );
  }
  if (report.errors?.length > 0) console.log("console errors:", report.errors.slice(0, 5));
  if (report.failure !== undefined) {
    console.error("\nbench failed:", report.failure);
    process.exitCode = 1;
  }
}
