/**
 * The chat-window bench page in headless Chromium, no Electron (VC-1145).
 *
 * Two workloads on the real `ChatPlane`, each on a fresh page load:
 *
 * - `type`: 150 keys at 60 ms into the composer of a 2,000-turn chat beside
 *   an 8,000-node ballast. Key-to-paint (the page's own probe) and
 *   key-to-present (Chromium's EventLatency, which includes compositing).
 * - `stream`: a prose reply streaming into the end of a 2,000-turn chat at
 *   30 words/s for 8 s while the reader follows it. Frame times and long tasks.
 *
 * With `--trace`, each run also reports exclusive main-thread milliseconds per
 * phase inside the measured window (script, style, layout, prePaint, paint,
 * composite preparation), viz draw time and render passes per frame.
 *
 * Headless numbers are not the app's: chrome-headless-shell composites on the
 * GPU here (`--use-angle=metal`), but no app shell, canvas or real window is
 * drawn. Confirm a decisive result in the guarded app (`chat-window-bench.mjs`).
 *
 *   node apps/desktop/e2e/bench/chat-window/headless.mjs build <outDir>
 *   node apps/desktop/e2e/bench/chat-window/headless.mjs <type|stream> <outDir>[,<outDir>…] \
 *     [--runs 3] [--materials on,backdrop-off] [--trace] [--json <file>]
 *
 * Several builds (e.g. one per revision, each built from its own checkout)
 * and materials arms alternate within each round. Report medians and ranges;
 * on a shared machine one run proves nothing.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromiumPath } from "../../../scripts/lab-browser.mjs";

const SETTINGS = {
  turns: 2000,
  ballast: 8000,
  keys: 150,
  keyIntervalMs: 60,
  streamMs: 8000,
  tokenRate: 30,
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
};

const [command, target, ...rest] = process.argv.slice(2);
if (command === "build") {
  if (!target) throw new Error("build needs an output directory");
  const { build } = await import("vite");
  await build({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    mode: "production",
    logLevel: "warn",
    build: { outDir: resolve(target), emptyOutDir: true },
  });
  console.log(`built ${resolve(target)}`);
  process.exit(0);
}
if (!["type", "stream"].includes(command) || !target)
  throw new Error("usage: headless.mjs <type|stream> <outDir>[,<outDir>…] [options]");

const option = (name, fallback) => {
  const at = rest.indexOf(name);
  return at < 0 ? fallback : rest[at + 1];
};
const builds = target.split(",").map((dir) => resolve(dir));
const runs = Number(option("--runs", 3));
const arms = option("--materials", "on").split(",");
const tracing = rest.includes("--trace");

// One static server for every build: /<index>/… serves builds[index].
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (request, response) => {
  const [, index, ...path] = decodeURIComponent(new URL(request.url, "http://x").pathname).split(
    "/",
  );
  const root = builds[Number(index)];
  const file = root === undefined ? null : join(root, ...path);
  if (file === null || relative(root, file).startsWith(`..${sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
});

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing",
  "v8.execute",
  "toplevel",
  "cc",
  "viz",
  "gpu",
  "benchmark",
];

const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
};

/** Main-thread phase of a trace event, or null for one that is not counted. */
function phase(name) {
  if (name === "UpdateLayoutTree" || name === "RecalculateStyles") return "style";
  if (name === "Layout") return "layout";
  if (name === "PrePaint") return "prePaint";
  if (name === "Paint" || name === "PaintImage") return "paint";
  if (["Layerize", "CompositeLayers", "Commit", "UpdateLayer"].includes(name)) return "composite";
  if (
    [
      "FunctionCall",
      "EvaluateScript",
      "RunMicrotasks",
      "EventDispatch",
      "V8.Execute",
      "TimerFire",
      "FireAnimationFrame",
    ].includes(name)
  )
    return "script";
  return null;
}

/** Exclusive phase time between the page's chat-bench marks; nested events never double count. */
function summarise(events) {
  const start = events.find((event) => event.name === "chat-bench:start");
  const end = events.find((event) => event.name === "chat-bench:end");
  if (!start || !end) throw new Error("trace has no measured window");
  const { pid, tid } = start;
  const totals = { script: 0, style: 0, layout: 0, prePaint: 0, paint: 0, composite: 0 };
  const edges = [];
  for (const event of events) {
    if (event.pid !== pid || event.tid !== tid || event.ph !== "X" || !(event.dur > 0)) continue;
    if (phase(event.name) === null) continue;
    const left = Math.max(start.ts, event.ts);
    const right = Math.min(end.ts, event.ts + event.dur);
    if (right > left)
      edges.push({ ts: left, event, open: true }, { ts: right, event, open: false });
  }
  edges.sort((a, b) => a.ts - b.ts || Number(a.open) - Number(b.open));
  const active = new Set();
  let prior = start.ts;
  for (const edge of edges) {
    let inner = null;
    for (const event of active) if (inner === null || event.ts > inner.ts) inner = event;
    if (inner) totals[phase(inner.name)] += (edge.ts - prior) / 1000;
    if (edge.open) active.add(edge.event);
    else active.delete(edge.event);
    prior = edge.ts;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 10) / 10;
  const within = (event) => event.ts >= start.ts && event.ts <= end.ts;
  const draws = events.filter(
    (event) => event.name === "DirectRenderer::DrawFrame" && within(event),
  );
  const passes = events.filter(
    (event) => event.name === "DirectRenderer::DrawRenderPass" && within(event),
  ).length;
  const opened = new Map();
  const keyToPresent = [];
  for (const event of events) {
    if (event.name !== "EventLatency") continue;
    const id = `${event.pid}:${event.id2?.local ?? event.id}`;
    if (event.ph === "b") opened.set(id, event);
    if (event.ph !== "e" || !opened.has(id)) continue;
    const begin = opened.get(id);
    opened.delete(id);
    if (within(begin) && begin.args?.event_latency?.event_type === "KEY_PRESSED")
      keyToPresent.push((event.ts - begin.ts) / 1000);
  }
  return {
    windowMs: Math.round((end.ts - start.ts) / 1000),
    ...totals,
    vizDrawMs: Math.round(draws.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000),
    renderPassesPerFrame: draws.length === 0 ? null : Math.round((passes / draws.length) * 10) / 10,
    keyToPresentMs: { median: quantile(keyToPresent, 0.5), p95: quantile(keyToPresent, 0.95) },
  };
}

async function trace(cdp) {
  const events = [];
  cdp.on("Tracing.dataCollected", (batch) => events.push(...batch.value));
  const complete = new Promise((done) => cdp.once("Tracing.tracingComplete", done));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: { includedCategories: CATEGORIES, excludedCategories: ["*"] },
  });
  return async () => {
    await cdp.send("Tracing.end");
    await complete;
    return summarise(events);
  };
}

async function measure(index, arm) {
  const context = await browser.newContext({
    viewport: { width: SETTINGS.width, height: SETTINGS.height },
    deviceScaleFactor: SETTINGS.deviceScaleFactor,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/${index}/index.html`);
  await page.waitForFunction(() => window.chatBench !== undefined);
  await page.waitForTimeout(1500);
  const cdp = await context.newCDPSession(page);
  await page.evaluate((name) => window.chatBench.materialsArm(name), arm);
  await page.evaluate((turns) => window.chatBench.seed(1, turns), SETTINGS.turns);
  const result = { build: builds[index], materials: arm, errors };
  let stop = null;
  if (command === "type") {
    await page.evaluate((ballast) => window.chatBench.showSession(0, ballast), SETTINGS.ballast);
    await page.focus('[data-bench-plane="bench-session-0"] textarea');
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => window.chatBench.startTypingIn(0))))
      throw new Error("no composer");
    if (tracing) stop = await trace(cdp);
    await page.evaluate(() => performance.mark("chat-bench:start"));
    for (let key = 0; key < SETTINGS.keys; key += 1) {
      const text = key % 6 === 5 ? " " : String.fromCharCode(97 + (key % 26));
      const code = text === " " ? "Space" : `Key${text.toUpperCase()}`;
      const windowsVirtualKeyCode = text.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: text,
        text,
        code,
        windowsVirtualKeyCode,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: text,
        code,
        windowsVirtualKeyCode,
      });
      await new Promise((done) => setTimeout(done, SETTINGS.keyIntervalMs));
    }
    const typed = await page.evaluate(() => window.chatBench.stopTyping());
    await page.evaluate(() => performance.mark("chat-bench:end"));
    const characters = await page.evaluate(() => window.chatBench.draftLength(0));
    if (characters !== SETTINGS.keys)
      throw new Error(`typed ${characters} of ${SETTINGS.keys} keys`);
    result.keyToPaintMs = {
      median: quantile(typed.latencyMs, 0.5),
      p95: quantile(typed.latencyMs, 0.95),
      max: quantile(typed.latencyMs, 1),
    };
    result.longTasks = typed.longTasksMs.length;
  } else {
    await page.evaluate(() => window.chatBench.show(1));
    if (tracing) stop = await trace(cdp);
    const streamed = await page.evaluate(
      ([ms, rate]) => window.chatBench.streamFollow(0, ms, rate),
      [SETTINGS.streamMs, SETTINGS.tokenRate],
    );
    if (!streamed.ok) throw new Error(`stream failed: ${JSON.stringify(streamed)}`);
    const frames = streamed.frameTimesMs;
    result.frameMs = {
      median: quantile(frames, 0.5),
      p95: quantile(frames, 0.95),
      max: quantile(frames, 1),
      over50: frames.filter((value) => value > 50).length,
    };
    result.longTasks = streamed.longTasksMs.length;
    result.updates = streamed.updates;
    result.endDistancePx = Math.round(streamed.endDistancePx);
  }
  if (stop) result.phases = await stop();
  result.uncaught = (await page.evaluate(() => window.chatBench.uncaught())).length;
  await context.close();
  return result;
}

const swap = () => execFileSync("sysctl", ["-n", "vm.swapusage"]).toString().trim();
const report = { command, settings: SETTINGS, runs, arms, swapBefore: swap(), samples: [] };
try {
  for (let round = 0; round < runs; round += 1) {
    const order = builds.map((_build, index) => index);
    for (const index of round % 2 === 0 ? order : order.toReversed())
      for (const arm of round % 2 === 0 ? arms : arms.toReversed()) {
        const sample = { round, ...(await measure(index, arm)) };
        report.samples.push(sample);
        console.log(JSON.stringify(sample));
      }
  }
} finally {
  await browser.close();
  server.close();
}
report.swapAfter = swap();
console.log(`swap before: ${report.swapBefore}\nswap after:  ${report.swapAfter}`);
const json = option("--json", null);
if (json) await writeFile(json, JSON.stringify(report, null, 1));
