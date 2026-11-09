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
 * Diagram cadence probe (renderer only, invented source; no product launch):
 *   vp env exec --node 24.22.2 node apps/desktop/e2e/chat-window-bench.mjs \
 *     --sessions 1 --turns 1600 --stream-only --stream-content diagram \
 *     --stream-samples 5 --diagram-sample-ms 100 --label sampled
 * Repeat with --diagram-sample-ms 0 for every-update. This read-only build
 * transform changes only the benchmark bundle, never the production adapter.
 *
 * Numbers from one machine under one load are comparable to each other and to
 * nothing else; run both arms back to back.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

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
const STREAM_CONTENT = flag("stream-content", "code");
const STREAM_ONLY = args.includes("--stream-only");
const DIAGRAM_SAMPLE_MS = flag("diagram-sample-ms", null);
if (!["code", "diagram"].includes(STREAM_CONTENT)) {
  throw new Error("--stream-content must be code or diagram");
}
if (
  DIAGRAM_SAMPLE_MS !== null &&
  (STREAM_CONTENT !== "diagram" || !["0", "100"].includes(DIAGRAM_SAMPLE_MS) || SKIP_BUILD)
) {
  throw new Error("--diagram-sample-ms requires diagram content, 0 or 100, and a fresh build");
}

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

/** Refuse plausible-looking numbers from an empty, hidden or static probe. */
export function validateDiagramProbe(report, expectedSamples) {
  if (
    report.failure !== undefined ||
    !Array.isArray(report.streamingSamples) ||
    report.streamingSamples.length !== expectedSamples ||
    !Array.isArray(report.errors) ||
    report.errors.length > 0 ||
    !Array.isArray(report.errorDetails) ||
    report.errorDetails.length > 0
  ) {
    throw new Error("diagram probe has missing samples or renderer errors");
  }
  for (const sample of report.streamingSamples) {
    if (
      sample.ok !== true ||
      sample.streamContent !== "diagram" ||
      sample.codeFenceOpened !== true ||
      sample.codeFenceClosed !== true ||
      sample.streamedWhileWorking !== true ||
      sample.streamedWhileTurnActive !== true ||
      !(sample.liveDiagramSvgs > 0) ||
      !(sample.visibleDiagramFrames > 1) ||
      !(sample.distinctVisibleDiagramSources > 1) ||
      sample.maxDiagramLabels !== 18 ||
      sample.settledDiagramSvgs !== 1 ||
      sample.settledDiagramLabels !== 18 ||
      !(sample.scrollDistancePx > 0) ||
      !(sample.refreshIntervalMs > 0)
    ) {
      throw new Error("diagram probe missed its visible/changing/complete SVG contract");
    }
  }
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

async function main() {
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
    let cadenceTransformed = false;
    await build({
      configFile: join(BENCH, "vite.config.ts"),
      mode: "production",
      logLevel: "warn",
      // Read-only instrumentation, scoped to this benchmark's build. Refuse a
      // stale match rather than claiming to compare an unchanged adapter.
      plugins:
        DIAGRAM_SAMPLE_MS === null
          ? []
          : [
              {
                name: "bench-only-diagram-cadence",
                enforce: "pre",
                transform(source, id) {
                  if (!id.endsWith("/components/ui/ai-elements/pele-diagram.tsx")) return;
                  const constant = "const SAMPLE_MS = 100;";
                  if (source.split(constant).length !== 2) {
                    throw new Error(
                      "diagram sampling constant changed; update the benchmark probe",
                    );
                  }
                  cadenceTransformed = true;
                  return source.replace(constant, `const SAMPLE_MS = ${DIAGRAM_SAMPLE_MS};`);
                },
              },
            ],
    });
    if (DIAGRAM_SAMPLE_MS !== null && !cadenceTransformed) {
      throw new Error("diagram cadence transform did not run; refusing a vacuous comparison");
    }
  }

  await assertProductionReact(join(BENCH, "dist"));

  console.log(`\nrunning: ${SESSIONS} sessions x ${TURNS} turns`);
  const scratch = join(APP, "..", "..", ".scratch");
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, "chat-window-profile-"));
  let output;
  try {
    output = await run(
      electron,
      [
        join(BENCH, "electron-main.cjs"),
        "--user-data-dir",
        profile,
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
        "--stream-content",
        STREAM_CONTENT,
        ...(STREAM_ONLY ? ["--stream-only"] : []),
      ],
      { cwd: APP, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } },
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }

  const match = /__BENCH__(?<json>.*)__BENCH__/s.exec(output);
  if (match?.groups?.json === undefined) {
    console.error("the bench printed no report");
    process.exitCode = 1;
  } else {
    const report = JSON.parse(match.groups.json);
    if (DIAGRAM_SAMPLE_MS !== null)
      console.log(`benchmark-only diagram sampling: ${DIAGRAM_SAMPLE_MS} ms`);
    if (STREAM_CONTENT === "diagram") {
      try {
        validateDiagramProbe(report, Number(STREAM_SAMPLES));
      } catch (error) {
        console.error("invalid diagram probe:", error.message);
        process.exitCode = 1;
      }
    }
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
    if (STREAM_CONTENT === "diagram") {
      console.log(
        "diagram evidence:",
        JSON.stringify(
          report.streamingSamples.map((sample) => ({
            ok: sample.ok,
            why: sample.why,
            svgs: sample.liveDiagramSvgs,
            visibleFrames: sample.visibleDiagramFrames,
            distinctSources: sample.distinctVisibleDiagramSources,
            maxOutputs: sample.maxDiagramLabels,
            settledSvgs: sample.settledDiagramSvgs,
            settledOutputs: sample.settledDiagramLabels,
            scrollDistancePx: sample.scrollDistancePx,
          })),
        ),
      );
    }
    if (report.errors?.length > 0) console.log("console errors:", report.errors.slice(0, 5));
    if (report.failure !== undefined) {
      console.error("\nbench failed:", report.failure);
      process.exitCode = 1;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
