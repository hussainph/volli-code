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
 *
 * `--arm draft` (VC-1079) asks a different question: what does one keystroke in
 * an empty Draft cost, with long transcripts and a sidebar-sized document
 * beside it? The keys are sent through Chromium's trusted input path
 * (`webContents.sendInputEvent`) and the page reports React's synchronous work
 * per keystroke, key-to-paint latency and long tasks:
 *
 *   node apps/desktop/e2e/chat-window-bench.mjs --arm draft --sessions 2 \
 *     --draft-ballast 8000 --draft-cpu-throttle 4 --draft-key-interval 80
 *
 * `--draft-planes` (transcripts beside the Draft), `--draft-keys`, and
 * `--draft-trace <file>` (a Chromium trace of the typing window, for
 * attributing style, layout and paint) are its other knobs.
 *
 * `--arm reveal` (VC-1100) presses a pane's next chat with the others kept
 * mounted behind `<Activity mode="hidden">` (VC-1080), through the same trusted
 * input path, and reports React's commit per press, click-to-paint latency and
 * — with `--reveal-trace <file>` — the renderer main thread's style, layout,
 * paint and script time across the presses:
 *
 *   node apps/desktop/e2e/chat-window-bench.mjs --arm reveal --sessions 2 \
 *     --turns 2000 --reveal-switches 30 --reveal-trace /tmp/reveal.json
 *
 * `--reveal-planes`, `--reveal-interval`, `--reveal-ballast` and
 * `--reveal-cpu-throttle` are its other knobs. The run also checks a revealed
 * chat's reader lands where they left it (`checks.revealRestore`).
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
// `--arm draft` (VC-1079): type into an empty Draft beside a realistic document
// instead of the transcript steps. Its own knobs pass through unchanged.
const PASSTHROUGH = [
  "arm",
  "draft-planes",
  "draft-ballast",
  "draft-keys",
  "draft-key-interval",
  "draft-trace",
  "draft-cpu-throttle",
  "reveal-planes",
  "reveal-switches",
  "reveal-interval",
  "reveal-ballast",
  "reveal-trace",
  "reveal-cpu-throttle",
]
  .filter((name) => args.includes(`--${name}`))
  .flatMap((name) => [`--${name}`, flag(name, "")]);

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

/** One probe series as the line the report prints: count, mean and spread. */
function stats(values) {
  if (!Array.isArray(values) || values.length === 0) return "none";
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return `n=${sorted.length} mean=${mean.toFixed(2)} p50=${at(0.5).toFixed(2)} p95=${at(0.95).toFixed(2)} max=${sorted.at(-1).toFixed(2)}`;
}

/**
 * A Chromium trace as renderer main-thread milliseconds per lifecycle phase.
 * The main thread is the busiest `CrRendererMain`; `forced*` is the share of
 * style/layout that script asked for synchronously (nested inside a call)
 * rather than the frame's own pass.
 */
const round = (value) => Math.round(value * 10) / 10;

async function traceSummary(file) {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents;
  const busy = new Map();
  const mains = new Set();
  for (const event of events) {
    const thread = `${event.pid}:${event.tid}`;
    if (event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain") {
      mains.add(thread);
    }
    if (event.ph === "X") busy.set(thread, (busy.get(thread) ?? 0) + (event.dur ?? 0));
  }
  const main = [...mains].toSorted((a, b) => (busy.get(b) ?? 0) - (busy.get(a) ?? 0))[0];
  const complete = events
    .filter((event) => `${event.pid}:${event.tid}` === main && event.ph === "X")
    .toSorted((a, b) => a.ts - b.ts || b.dur - a.dur);
  const phases = ["FunctionCall", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize"];
  const totals = Object.fromEntries(phases.map((name) => [name, 0]));
  const forced = { UpdateLayoutTree: 0, Layout: 0 };
  let styleElements = 0;
  const stack = [];
  for (const event of complete) {
    while (stack.length > 0 && stack.at(-1).ts + stack.at(-1).dur <= event.ts) stack.pop();
    const inScript = stack.some((open) => open.name === "FunctionCall");
    if (event.name in totals && !(event.name === "FunctionCall" && inScript)) {
      totals[event.name] += event.dur / 1000;
    }
    if (event.name in forced && inScript) forced[event.name] += event.dur / 1000;
    if (event.name === "UpdateLayoutTree") styleElements += event.args?.elementCount ?? 0;
    stack.push(event);
  }
  return {
    ...Object.fromEntries(Object.entries(totals).map(([name, ms]) => [name, round(ms)])),
    forcedStyle: round(forced.UpdateLayoutTree),
    forcedLayout: round(forced.Layout),
    styleElements,
  };
}

const electron = (await import(join(APP, "node_modules", "electron", "index.js"))).default;

/*
 * A measurement harness may not be built in development mode, and saying so out
 * loud is not paranoia here (VC-357).
 *
 * Vite's `createServer` sets `process.env.NODE_ENV = "development"` for the
 * WHOLE process, and `bench/performance/fixture.mjs` starts one to load the
 * production database modules as TypeScript. When `run.mjs` generates or
 * verifies a fixture and then spawns this bench, that value rides into the
 * child's environment and the build below resolves React's `development`
 * export condition instead of `production`.
 *
 * What that cost, measured: a 3.4 MB bundle instead of 3.1 MB, and a layout
 * different enough that the growing code fence fell outside the scroller the
 * reader was moving inside. Streamdown defers offscreen code with
 * `content-visibility`, so the probe then streamed into a transcript with no
 * mounted code block at all and reported ZERO dropped frames for it — a clean
 * bill of health for a measurement that measured nothing. `run.mjs`'s
 * per-sample live-fence contract is what refused it.
 *
 * Pinned unconditionally rather than inside the build branch: the `--skip-build`
 * path hands this same environment to Electron, and one answer for both is
 * easier to keep true than two.
 */
process.env.NODE_ENV = "production";

// Vite's Node API rather than its CLI: `vite` has no linked bin in this
// workspace (the app builds through `vp`), and a bench that shells out to a
// binary that may not be there fails for a reason that has nothing to do with
// what it measures.
if (!SKIP_BUILD) {
  console.log(`building the bench page (${BENCH})`);
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
    ...PASSTHROUGH,
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
  if (report.draftTyping !== undefined) {
    const typing = report.draftTyping;
    console.log(
      `\ndraft typing (${typing.typedCharacters} chars, ${typing.nodes} DOM nodes, empty state ${typing.emptyStateMounted ? "mounted" : "ABSENT"}):`,
    );
    console.log(`  input handler ms   ${stats(typing.handlerMs)}`);
    console.log(`  key->paint ms      ${stats(typing.latencyMs)}`);
    const longTotal = (typing.longTasksMs ?? []).reduce((sum, value) => sum + value, 0);
    console.log(
      `  long tasks         ${typing.longTasksMs?.length ?? 0} (${longTotal.toFixed(0)} ms total)`,
    );
  }
  if (report.revealSwitch !== undefined) {
    const reveal = report.revealSwitch;
    console.log(`\nchat switch, kept views revealed (${reveal.nodes} DOM nodes):`);
    console.log(`  click handler ms   ${stats(reveal.handlerMs)}`);
    console.log(`  click->paint ms    ${stats(reveal.latencyMs)}`);
    const longTotal = (reveal.longTasksMs ?? []).reduce((sum, value) => sum + value, 0);
    console.log(
      `  long tasks         ${reveal.longTasksMs?.length ?? 0} (${longTotal.toFixed(0)} ms total)`,
    );
    if (report.revealTrace !== undefined) {
      const summary = await traceSummary(report.revealTrace);
      const presses = reveal.handlerMs?.length || 1;
      console.log(`  main thread, ms per press (trace ${report.revealTrace}):`);
      for (const [name, ms] of Object.entries(summary)) {
        const value =
          name === "styleElements" ? Math.round(ms / presses) : (ms / presses).toFixed(1);
        console.log(`    ${name.padEnd(18)} ${value}`);
      }
    }
  }
  if (report.errors?.length > 0) console.log("console errors:", report.errors.slice(0, 5));
  if (report.failure !== undefined) {
    console.error("\nbench failed:", report.failure);
    process.exitCode = 1;
  }
}
