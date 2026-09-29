#!/usr/bin/env electron
/**
 * VC-363 Browser Tab resize benchmark.
 *
 * A manual, self-contained Electron benchmark. It deliberately does not boot
 * Volli: Chromium sees the same important mechanism instead — a visible
 * BrowserWindow renderer observes a CSS sidebar-width transition and places a
 * real WebContentsView through asynchronous renderer -> main IPC.
 *
 * Run (needs a visible, unobscured desktop):
 *   apps/desktop/node_modules/.bin/electron apps/desktop/e2e/browser-resize-bench.mjs --arm idle --json /tmp/vc363-idle.json
 *   apps/desktop/node_modules/.bin/electron apps/desktop/e2e/browser-resize-bench.mjs --arm loaded --load-note "8 concurrent Volli Sessions working" --json /tmp/vc363-loaded.json
 *
 * `--arm loaded` does not create load. VC-353 owns the shared concurrent-session
 * load generator; start it first (or record the live Session load), then pass an
 * exact `--load-note`. The benchmark refuses an unlabeled loaded run rather than
 * pretending to manufacture or verify representative background load.
 *
 * Full matrix defaults: modes uncoalesced,raf-latest,endpoint-snap; tabs 1,4,8;
 * weights static,animating,video,heavy-spa; two 200ms transitions per cell. Results
 * are JSON at --json (or stdout for --json -); the concise human report is
 * always stderr. Useful practical variants:
 *   ... --quick --arm loaded --json /tmp/vc363-loaded-quick.json
 *   ... --tabs 8 --weights heavy-spa --modes raf-latest --transitions 5 --arm idle --json /tmp/vc363-focus.json
 *   ... --help
 *
 * `firstPaintMs` is navigation start to the fixture's first requestAnimationFrame
 * proxy, not a browser paint-timing entry. “Warm” means a second navigation in an initialized WebContents,
 * not an HTTP-cache claim: every fixture is a local data: URL.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";

import { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain } from "electron";

const execFile = promisify(execFileCallback);
const PRELOAD = fileURLToPath(new URL("./bench/browser-resize-preload.cjs", import.meta.url));
const VIEWPORT = { x: 0, y: 0, width: 1_120, height: 700 };
const DEFAULTS = {
  arm: "idle",
  tabs: [1, 4, 8],
  weights: ["static", "animating", "video", "heavy-spa"],
  modes: ["uncoalesced", "raf-latest", "endpoint-snap"],
  transitions: 2,
  durationMs: 200,
  cpuMs: 750,
  boundsSamples: 80,
  cdpTimeoutMs: 15_000,
  loadNote: null,
  json: "-",
};
const VALID_WEIGHTS = new Set(DEFAULTS.weights);
const VALID_MODES = new Set(DEFAULTS.modes);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(code = 0) {
  const text = `VC-363 Browser Tab resize benchmark

Usage:
  apps/desktop/node_modules/.bin/electron apps/desktop/e2e/browser-resize-bench.mjs [options]

Options:
  --arm idle|loaded                 Metadata only; loaded does not start load.
  --tabs 1,4,8                      Tab-count matrix (default: 1,4,8).
  --weights static,animating,video,heavy-spa
  --modes uncoalesced,raf-latest,endpoint-snap
                                     Bounds delivery modes (default: all three).
  --transitions N                   Repetitions per matrix cell (default: 2).
  --duration-ms N                   Sidebar CSS transition duration (default: 200).
  --cpu-ms N                        Idle CPU sampling window (default: 750).
  --bounds-samples N                Isolated setBounds samples (default: 80).
  --cdp-timeout-ms N                Per snapshot/screenshot/act bound (default: 15000).
  --load-note TEXT                  Required for loaded: exact external load condition.
  --json PATH|-                     JSON destination; - writes JSON to stdout (default).
  --quick                           1/4 tabs, static/heavy-spa, one transition, 300ms CPU.
  --help

Keep the window visible and unobscured. Human summary is stderr, so stdout is
safe to redirect when --json - is used. The default full matrix is intentional;
--quick is a preflight, not a replacement for the published idle/loaded runs.`;
  console.error(text);
  process.exit(code);
}

function positive(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number`);
  return Math.round(number);
}

function csv(value, flag) {
  const items = String(value).split(",").filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} needs at least one value`);
  return items;
}

function parseArgs(argv) {
  const explicit = new Set();
  const options = { ...DEFAULTS, tabs: null, weights: null, modes: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") usage();
    if (flag === "--quick") {
      options.quick = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    index += 1;
    explicit.add(flag);
    switch (flag) {
      case "--arm":
        if (value !== "idle" && value !== "loaded") throw new Error("--arm must be idle or loaded");
        options.arm = value;
        break;
      case "--tabs":
        options.tabs = csv(value, flag).map((item) => positive(item, flag));
        break;
      case "--weights":
        options.weights = csv(value, flag);
        break;
      case "--modes":
        options.modes = csv(value, flag);
        break;
      case "--transitions":
        options.transitions = positive(value, flag);
        break;
      case "--duration-ms":
        options.durationMs = positive(value, flag);
        break;
      case "--cpu-ms":
        options.cpuMs = positive(value, flag);
        break;
      case "--bounds-samples":
        options.boundsSamples = positive(value, flag);
        break;
      case "--cdp-timeout-ms":
        options.cdpTimeoutMs = positive(value, flag);
        break;
      case "--load-note":
        options.loadNote = value.trim();
        break;
      case "--json":
        options.json = value;
        break;
      default:
        throw new Error(`unknown option ${flag}; use --help`);
    }
  }
  const quick = options.quick === true;
  options.tabs ??= quick ? [1, 4] : DEFAULTS.tabs;
  options.weights ??= quick ? ["static", "heavy-spa"] : DEFAULTS.weights;
  options.modes ??= DEFAULTS.modes;
  if (quick && !explicit.has("--transitions")) options.transitions = 1;
  if (quick && !explicit.has("--cpu-ms")) options.cpuMs = 300;
  for (const weight of options.weights)
    if (!VALID_WEIGHTS.has(weight)) throw new Error(`unknown weight ${weight}`);
  for (const mode of options.modes)
    if (!VALID_MODES.has(mode)) throw new Error(`unknown mode ${mode}`);
  options.tabs = [...new Set(options.tabs)].toSorted((a, b) => a - b);
  options.weights = [...new Set(options.weights)];
  options.modes = [...new Set(options.modes)];
  if (options.arm === "loaded" && !options.loadNote) {
    throw new Error("--arm loaded requires --load-note so an unloaded run cannot be mislabeled");
  }
  return options;
}

async function loadWithin(contents, url, label, timeoutMs = 15_000) {
  let timer = null;
  try {
    await Promise.race([
      contents.loadURL(url),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not load within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function percentile(values, point) {
  if (values.length === 0) return null;
  const ordered = values.toSorted((a, b) => a - b);
  const at = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * point) - 1));
  return ordered[at];
}

function stats(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0)
    return { count: 0, mean: null, min: null, p50: null, p95: null, max: null };
  return {
    count: finite.length,
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    min: Math.min(...finite),
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  };
}

function rounded(value, digits = 2) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function compactStats(values) {
  const value = stats(values);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]));
}

function dataPage(weight) {
  const animation = weight === "animating" || weight === "video";
  const heavy = weight === "heavy-spa";
  const video = weight === "video";
  const body = heavy
    ? `<main id="app"><h1>heavy SPA local data URL</h1><button id="bench-action">Act</button><canvas id="canvas" width="720" height="360"></canvas></main>`
    : `<main><h1>${weight} local data URL</h1><button id="bench-action">Act</button><canvas id="canvas" width="720" height="360"></canvas>${video ? '<video id="video" muted autoplay playsinline></video>' : ""}</main>`;
  const script = `
    const bridge = globalThis.vc363Bench;
    const weight = ${JSON.stringify(weight)};
    const reportPaint = () => bridge?.emit({ kind: "first-paint", token: location.hash.slice(1), now: performance.now() });
    requestAnimationFrame(reportPaint);
    const button = document.getElementById("bench-action");
    button?.addEventListener("click", () => { button.textContent = "Acted"; });
    const canvas = document.getElementById("canvas");
    const context = canvas?.getContext("2d");
    let heavyCards = [];
    let frame = 0;
    function draw(now) {
      frame += 1;
      if (context) {
        context.fillStyle = "hsl(" + (frame % 360) + " 70% 42%)";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#fff";
        context.fillText(weight + " frame " + frame, 24, 32);
      }
      ${
        heavy
          ? `
        let measured = 0;
        for (let index = frame % 11; index < heavyCards.length; index += 37) {
          const card = heavyCards[index];
          card.style.paddingLeft = ((frame + index) % 9 + 8) + "px";
          measured += card.getBoundingClientRect().height;
        }
        document.body.dataset.liveLayout = String(measured);
      `
          : ""
      }
      ${animation || heavy ? "requestAnimationFrame(draw);" : ""}
    }
    ${animation || heavy ? "requestAnimationFrame(draw);" : ""}
    ${
      video
        ? `
      // Start media only after the document's load event so loadURL latency is
      // not held open by a synthetic MediaStream whose duration is infinite.
      window.addEventListener("load", () => {
        const video = document.getElementById("video");
        try {
          video.srcObject = canvas.captureStream(30);
          video.play().catch(() => {});
        } catch { video.dataset.fallback = "canvas"; }
      });
    `
        : ""
    }
    ${
      heavy
        ? `
      const app = document.getElementById("app");
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 1800; index += 1) {
        const card = document.createElement("article");
        card.className = "card";
        card.textContent = "SPA card " + index + " — local benchmark state";
        fragment.appendChild(card);
      }
      app.appendChild(fragment);
      heavyCards = Array.from(app.querySelectorAll(".card"));
      requestAnimationFrame(() => {
        let total = 0;
        for (let index = 0; index < heavyCards.length; index += 23) total += heavyCards[index].getBoundingClientRect().height;
        document.body.dataset.layout = String(total);
      });
    `
        : ""
    }
  `;
  const html = `<!doctype html><meta charset="utf-8"><title>VC-363 ${weight}</title>
    <style>body{margin:0;background:#0d1424;color:#e5eefc;font:14px system-ui}main{padding:24px}.card{display:inline-block;width:180px;margin:4px;padding:12px;background:#162444;border-radius:8px}canvas{display:block;margin-top:16px}video{display:block;width:360px;margin-top:12px;background:#000}</style>
    <body>${body}<script>${script}</script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const SHELL_PAGE = `<!doctype html><meta charset="utf-8"><title>VC-363 resize bench</title>
<style>
  html,body,#root{width:100%;height:100%;margin:0;overflow:hidden;background:#111827}
  #root{display:flex} #sidebar{width:0;background:#18243a;transition:width var(--duration) ease-in-out;flex:none}
  #root.open #sidebar{width:280px} #anchor{flex:1;min-width:0;background:#0b1220}
</style><div id="root"><aside id="sidebar"></aside><main id="anchor"></main></div>
<script>
  const bridge = globalThis.vc363Bench;
  const root = document.getElementById("root");
  const anchor = document.getElementById("anchor");
  let open = false;
  window.__vc363Transition = ({ id, mode, durationMs }) => {
    root.style.setProperty("--duration", durationMs + "ms");
    const frames = [];
    const roundTrips = [];
    const requests = [];
    let active = false;
    let latest = null;
    let rafPending = false;
    let boundsReads = 0;
    const readBounds = () => {
      boundsReads += 1;
      return anchor.getBoundingClientRect();
    };
    const send = (rect) => {
      const started = performance.now();
      const request = bridge.setBounds({ id, bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } })
        .then(() => roundTrips.push(performance.now() - started));
      requests.push(request);
    };
    const observer = new ResizeObserver(() => {
      if (!active || mode === "endpoint-snap") return;
      if (mode === "uncoalesced") { send(readBounds()); return; }
      latest = readBounds;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; if (latest !== null) send(latest()); });
    });
    observer.observe(anchor);
    const started = performance.now();
    const frame = (now) => {
      frames.push(now);
      if (now - started < durationMs + 80) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    requestAnimationFrame(() => {
      active = true;
      if (mode === "endpoint-snap") {
        // Structural lower bound for VC-359: no native geometry changes during
        // flight, then one exact settled report. The Browser-specific instant
        // endpoint/no-reflow presentation is exercised by VC-359, not here.
        setTimeout(() => {
          root.style.setProperty("--duration", "0ms");
          open = !open;
          root.classList.toggle("open", open);
          send(readBounds());
        }, durationMs);
      } else {
        open = !open;
        root.classList.toggle("open", open);
      }
      setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(async () => {
        await Promise.allSettled(requests);
        observer.disconnect();
        bridge.emit({ kind: "transition-complete", id, frames, roundTrips, boundsReads });
      })), durationMs + 60);
    });
  };
</script>`;

async function gitSha() {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitDirty() {
  try {
    const { stdout } = await execFile("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
    });
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

async function macVersion() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFile("sw_vers", ["-productVersion"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function appMetric() {
  const metrics = app.getAppMetrics();
  return {
    processCount: metrics.length,
    workingSetKb: metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0),
    privateMemoryKb: metrics.reduce((sum, metric) => sum + (metric.memory?.privateBytes ?? 0), 0),
  };
}

async function cpuSample(ms) {
  app.getAppMetrics();
  await sleep(ms);
  return app.getAppMetrics().reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0), 0);
}

function sameRectangle(left, right) {
  return (
    left?.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function makeTab() {
  return new WebContentsView({
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
}

const parents = new WeakMap();
const nativeBounds = new WeakMap();

function attachView(view, visible) {
  const parent = visible ? benchWindow : stageWindow;
  parent.contentView.addChildView(view);
  parents.set(view, parent);
  view.setBounds(VIEWPORT);
  nativeBounds.set(view, { ...VIEWPORT });
}

function closeView(view) {
  if (view.webContents.isDestroyed()) return;
  const parent = parents.get(view);
  try {
    parent?.contentView.removeChildView(view);
  } catch {}
  parents.delete(view);
  nativeBounds.delete(view);
  view.webContents.close({ waitForBeforeUnload: false });
}

function collectTransition(run) {
  const intervals = [];
  for (let index = 1; index < run.frames.length; index += 1)
    intervals.push(run.frames[index] - run.frames[index - 1]);
  const droppedFrames = intervals.reduce(
    (total, interval) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1),
    0,
  );
  return {
    frameIntervalsMs: compactStats(intervals),
    rendererFrames: run.frames.length,
    droppedFrames,
    setBoundsCalls: run.setBoundsMs.length,
    boundsReads: run.boundsReads,
    setBoundsMainMs: compactStats(run.setBoundsMs),
    ipcRoundTripMs: compactStats(run.roundTrips),
  };
}

function aggregateTransitions(runs) {
  const intervals = runs.flatMap((run) => run.intervals);
  const bounds = runs.flatMap((run) => run.setBoundsMs);
  const roundTrips = runs.flatMap((run) => run.roundTrips);
  return {
    repetitions: runs.length,
    frameIntervalsMs: compactStats(intervals),
    rendererFrames: runs.reduce((sum, run) => sum + run.frames.length, 0),
    droppedFrames: runs.reduce((sum, run) => sum + run.droppedFrames, 0),
    setBoundsCalls: runs.reduce((sum, run) => sum + run.setBoundsMs.length, 0),
    setBoundsCallsPerTransition: rounded(
      runs.reduce((sum, run) => sum + run.setBoundsMs.length, 0) / runs.length,
    ),
    boundsReadsPerTransition: rounded(
      runs.reduce((sum, run) => sum + run.boundsReads, 0) / runs.length,
    ),
    setBoundsMainMs: compactStats(bounds),
    ipcRoundTripMs: compactStats(roundTrips),
    individual: runs.map(collectTransition),
  };
}

function timeoutResult(label, timeoutMs) {
  return {
    operation: label,
    outcome: "timeout",
    timeoutMs,
    timedOutAt15s: timeoutMs === 15_000,
    ms: timeoutMs,
  };
}

const TIMED_OUT = Symbol("timed-out");

async function timed(label, timeoutMs, operation) {
  const started = performance.now();
  let timer = null;
  try {
    const result = await Promise.race([
      operation(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (result === TIMED_OUT) return timeoutResult(label, timeoutMs);
    return {
      operation: label,
      outcome: "ok",
      ms: rounded(performance.now() - started),
      timedOutAt15s: false,
      ...(result === undefined ? {} : { detail: result }),
    };
  } catch (error) {
    return {
      operation: label,
      outcome: "error",
      ms: rounded(performance.now() - started),
      timedOutAt15s: false,
      error: String(error?.message ?? error),
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function agentToolLatency(view, timeoutMs) {
  const wire = view.webContents.debugger;
  const attachedHere = !wire.isAttached();
  try {
    if (attachedHere) wire.attach("1.3");
    const readiness = await timed("readiness", timeoutMs, async () => {
      await wire.sendCommand("Accessibility.enable");
      await wire.sendCommand("DOM.enable");
      await wire.sendCommand("Page.enable");
    });
    if (readiness.outcome !== "ok") {
      return {
        operations: { readiness },
        any15sTimeout: readiness.timedOutAt15s,
      };
    }
    const initialTree = await wire.sendCommand("Accessibility.getFullAXTree");
    const actionNode = initialTree.nodes?.find(
      (node) => node.role?.value === "button" && node.name?.value === "Act",
    );
    const backendNodeId = actionNode?.backendDOMNodeId;
    if (!Number.isInteger(backendNodeId)) throw new Error("benchmark action button was not found");

    // Act first: a timed-out screenshot can leave its underlying CDP command
    // pending even after this benchmark's clock rejects it. Measuring action
    // before that event keeps the independent latency sample honest. The CDP
    // sequence matches BrowserTabController's ref-based click path.
    const snapshotResult = async () => {
      const answer = await wire.sendCommand("Accessibility.getFullAXTree");
      const tree = answer.nodes ?? [];
      return {
        nodes: tree.length,
        formattedChars: JSON.stringify(tree).length,
      };
    };
    const captureResultPicture = async () => {
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) return { bytes: 0, empty: true };
      return { bytes: image.toJPEG(60).byteLength, empty: false };
    };
    const act = await timed("act", timeoutMs, async () => {
      await wire.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const box = await wire.sendCommand("DOM.getBoxModel", { backendNodeId });
      const quad = box.model?.content;
      if (!Array.isArray(quad) || quad.length < 8)
        throw new Error("benchmark action has no box model");
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await wire.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await wire.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      // AgentBrowserPort.act then waits for possible navigation, snapshots the
      // changed page, and captures the person's result frame. The local click
      // cannot navigate, so no grace wait is included in this deterministic arm.
      const postActSnapshot = await snapshotResult();
      const picture = await captureResultPicture();
      return {
        inputDispatched: true,
        pageObservedAct: await view.webContents.executeJavaScript(
          'document.getElementById("bench-action")?.textContent === "Acted"',
          true,
        ),
        postActSnapshot,
        picture,
      };
    });
    const snapshot = await timed("snapshot", timeoutMs, snapshotResult);
    const screenshot = await timed("screenshot", timeoutMs, async () => {
      const answer = await wire.sendCommand("Page.captureScreenshot", { format: "png" });
      const png = Buffer.from(answer.data ?? "", "base64");
      if (png.length === 0) throw new Error("benchmark screenshot produced no pixels");
      const metrics = await wire.sendCommand("Page.getLayoutMetrics");
      return {
        bytes: png.byteLength,
        width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
        height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
      };
    });
    const operations = { readiness, snapshot, screenshot, act };
    return {
      operations,
      any15sTimeout: Object.values(operations).some((item) => item.timedOutAt15s),
    };
  } catch (error) {
    return { operations: {}, any15sTimeout: false, setupError: String(error?.message ?? error) };
  } finally {
    if (attachedHere && wire.isAttached()) wire.detach();
  }
}

const options = parseArgs(process.argv.slice(2));
let benchWindow = null;
let stageWindow = null;
let sequence = 0;
const transitionRuns = new Map();
const paintWaiters = new Map();

ipcMain.handle("vc363:set-bounds", (event, input) => {
  const run = transitionRuns.get(input?.id);
  if (run === undefined || event.sender.id !== benchWindow?.webContents.id) return { ok: false };
  if (sameRectangle(nativeBounds.get(run.view), input.bounds)) return { ok: true, deduped: true };
  const started = performance.now();
  run.view.setBounds(input.bounds);
  nativeBounds.set(run.view, { ...input.bounds });
  run.setBoundsMs.push(performance.now() - started);
  return { ok: true, deduped: false };
});
ipcMain.on("vc363:message", (event, message) => {
  if (message?.kind === "transition-complete") {
    const run = transitionRuns.get(message.id);
    if (run !== undefined && event.sender.id === benchWindow?.webContents.id) {
      run.frames = Array.isArray(message.frames) ? message.frames : [];
      run.roundTrips = Array.isArray(message.roundTrips) ? message.roundTrips : [];
      run.boundsReads = Number.isFinite(message.boundsReads) ? message.boundsReads : 0;
      run.resolve(run);
    }
    return;
  }
  if (message?.kind === "first-paint") {
    const waiter = paintWaiters.get(event.sender.id);
    if (waiter !== undefined) {
      paintWaiters.delete(event.sender.id);
      waiter.resolve(performance.now() - waiter.started);
    }
  }
});

async function waitForPaint(contents, url) {
  const started = performance.now();
  let timer = null;
  const painted = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      paintWaiters.delete(contents.id);
      reject(new Error("first-paint proxy did not arrive within 15s"));
    }, 15_000);
    paintWaiters.set(contents.id, {
      started,
      resolve: (elapsed) => {
        if (timer !== null) clearTimeout(timer);
        resolve(rounded(elapsed));
      },
    });
  });
  const loaded = contents.loadURL(url);
  try {
    const firstPaintMs = await Promise.race([
      painted,
      loaded.then(
        () => new Promise(() => undefined),
        (error) => Promise.reject(error),
      ),
    ]);
    // Do not let the next warm navigation replace a document whose first frame
    // arrived but whose load event has not yet completed.
    await loaded;
    return firstPaintMs;
  } finally {
    paintWaiters.delete(contents.id);
    if (timer !== null) clearTimeout(timer);
  }
}

async function runTransition(view, mode) {
  const id = `transition-${++sequence}`;
  const run = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      transitionRuns.delete(id);
      reject(new Error(`transition ${id} did not complete`));
    }, options.durationMs + 8_000);
    transitionRuns.set(id, {
      view,
      setBoundsMs: [],
      frames: [],
      roundTrips: [],
      resolve: (value) => {
        clearTimeout(timer);
        transitionRuns.delete(id);
        resolve(value);
      },
    });
    void benchWindow.webContents
      .executeJavaScript(
        `window.__vc363Transition(${JSON.stringify({ id, mode, durationMs: options.durationMs })})`,
        true,
      )
      .catch((error) => {
        clearTimeout(timer);
        transitionRuns.delete(id);
        reject(error);
      });
  });
  const intervals = [];
  for (let index = 1; index < run.frames.length; index += 1)
    intervals.push(run.frames[index] - run.frames[index - 1]);
  return {
    ...run,
    intervals,
    droppedFrames: intervals.reduce(
      (total, interval) => total + Math.max(0, Math.round(interval / (1000 / 60)) - 1),
      0,
    ),
  };
}

async function openTabs(count, weight) {
  const tabs = [];
  for (let index = 0; index < count; index += 1) {
    const view = makeTab();
    // The active tab is on the visible window; every standing tab is stacked
    // in a never-shown BaseWindow, matching BrowserTabHost's VC-278 stage.
    attachView(view, index === 0);
    view.webContents.setAudioMuted(true);
    tabs.push(view);
  }
  await Promise.all(
    tabs.map((view, index) =>
      loadWithin(view.webContents, dataPage(weight), `${weight} tab ${index + 1}`),
    ),
  );
  await sleep(120);
  return tabs;
}

async function standingCost() {
  const views = [];
  const snapshots = [];
  const baseline = appMetric();
  for (const count of DEFAULTS.tabs) {
    while (views.length < count) {
      const view = makeTab();
      attachView(view, views.length === 0);
      await loadWithin(view.webContents, dataPage("static"), `standing tab ${views.length + 1}`);
      views.push(view);
    }
    await sleep(150);
    const memory = appMetric();
    const idleCpuPercent = await cpuSample(options.cpuMs);
    const previous = snapshots.at(-1)?.memory ?? baseline;
    const previousCount = snapshots.at(-1)?.tabs ?? 0;
    snapshots.push({
      tabs: count,
      memory,
      idleCpuPercent: rounded(idleCpuPercent),
      incrementalMemoryKb: memory.workingSetKb - previous.workingSetKb,
      incrementalMemoryKbPerNewTab: rounded(
        (memory.workingSetKb - previous.workingSetKb) / (count - previousCount),
      ),
      incrementalIdleCpuPercent: rounded(idleCpuPercent - (snapshots.at(-1)?.idleCpuPercent ?? 0)),
    });
  }
  for (const view of views) closeView(view);
  return { fixtureWeight: "static", baseline, samples: snapshots };
}

async function navigationFirstPaint() {
  const results = [];
  for (const weight of options.weights) {
    const view = makeTab();
    attachView(view, true);
    try {
      const url = dataPage(weight);
      const coldFirstPaintMs = await waitForPaint(view.webContents, url);
      const warmFirstPaintMs = await waitForPaint(view.webContents, url);
      results.push({
        weight,
        coldFirstPaintMs,
        warmFirstPaintMs,
        proxy: "navigation start to fixture's first requestAnimationFrame",
      });
    } catch (error) {
      results.push({
        weight,
        error: String(error?.message ?? error),
        proxy: "navigation start to fixture's first requestAnimationFrame",
      });
    } finally {
      closeView(view);
    }
  }
  return results;
}

async function isolatedBoundsLatency() {
  const view = makeTab();
  attachView(view, true);
  await loadWithin(view.webContents, dataPage("static"), "isolated bounds tab");
  const samples = [];
  for (let index = 0; index < options.boundsSamples; index += 1) {
    const started = performance.now();
    view.setBounds({
      x: index % 2,
      y: 0,
      width: VIEWPORT.width - (index % 2),
      height: VIEWPORT.height,
    });
    samples.push(performance.now() - started);
  }
  closeView(view);
  return {
    samplesMs: compactStats(samples),
    individualMs: samples.map((sample) => rounded(sample, 4)),
  };
}

function summary(result) {
  const lines = [
    "VC-363 Browser Tab resize benchmark",
    `arm=${result.metadata.arm} sha=${result.metadata.gitSha ?? "unknown"} Electron=${result.metadata.electron} macOS=${result.metadata.macos ?? result.metadata.os.release}`,
    `matrix=${result.matrix.length} cells; ${result.options.durationMs}ms sidebar transition; ${result.options.transitions} repetition(s)/cell`,
    "",
    "mode              tabs weight       calls/transition  reads/transition  dropped  frame p95  IPC p95",
  ];
  for (const cell of result.matrix) {
    const metric = cell.resize;
    lines.push(
      `${cell.mode.padEnd(17)} ${String(cell.tabs).padStart(4)} ${cell.weight.padEnd(12)} ${String(metric.setBoundsCallsPerTransition).padStart(16)} ${String(metric.boundsReadsPerTransition).padStart(17)} ${String(metric.droppedFrames).padStart(8)} ${String(rounded(metric.frameIntervalsMs.p95)).padStart(10)} ${String(rounded(metric.ipcRoundTripMs.p95)).padStart(8)}`,
    );
  }
  lines.push(
    "",
    `isolated setBounds main p50/p95: ${rounded(result.isolatedSetBoundsLatency.samplesMs.p50, 4)}ms / ${rounded(result.isolatedSetBoundsLatency.samplesMs.p95, 4)}ms`,
  );
  lines.push(`any CDP 15s timeout: ${result.agentTools.any15sTimeout ? "YES" : "no"}`);
  lines.push(`JSON: ${result.jsonDestination}`);
  return lines.join("\n");
}

app.whenReady().then(async () => {
  const startedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    benchmark: "vc363-browser-resize",
    startedAt,
    options,
    metadata: {
      arm: options.arm,
      gitSha: await gitSha(),
      gitDirty: await gitDirty(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      macos: await macVersion(),
      os: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        version: os.version?.() ?? null,
      },
      device: {
        hostname: os.hostname(),
        cpuModel: os.cpus()[0]?.model ?? null,
        cpuCount: os.cpus().length,
        memoryGb: rounded(os.totalmem() / 1024 ** 3),
      },
      load: {
        condition: options.loadNote ?? "no controlled background load",
        loadAverage: os.loadavg().map((value) => rounded(value)),
        generator: options.arm === "loaded" ? "external; not started by this benchmark" : "none",
      },
    },
    notes: [
      "Uses a real BrowserWindow for the active tab plus a never-shown BaseWindow stage for standing tabs, matching BrowserTabHost; all page fixtures are data: URLs.",
      "The shell uses a real ResizeObserver over a CSS sidebar-width transition. Bounds IPC has invoke/reply semantics matching the Browser plane gateway.",
      "raf-latest sends only the latest observed rect in requestAnimationFrame. endpoint-snap is the one-report structural floor expected from VC-359's Browser-specific instant endpoint/no-reflow path; this harness does not boot that app presentation.",
      "Agent tool latency is sampled once per page weight at the largest requested tab count; tab-count variation belongs to the resize matrix and standing-cost samples.",
      "Tool samples approximate post-load AgentBrowserPort work with controller-shaped CDP, post-act snapshot/capture, and screenshot decode. Ref formatting, navigation-grace waits, picture-store writes, and policy/hold bookkeeping are excluded.",
    ],
    isolatedSetBoundsLatency: null,
    navigation: [],
    standingCost: null,
    matrix: [],
    agentTools: { samples: [], any15sTimeout: false },
  };
  try {
    benchWindow = new BrowserWindow({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      show: true,
      title: "VC-363 Browser Tab resize benchmark",
      alwaysOnTop: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    benchWindow.setAlwaysOnTop(true, "screen-saver");
    await loadWithin(
      benchWindow.webContents,
      `data:text/html;charset=utf-8,${encodeURIComponent(SHELL_PAGE)}`,
      "benchmark shell",
    );
    stageWindow = new BaseWindow({ width: VIEWPORT.width, height: VIEWPORT.height, show: false });
    await sleep(350);

    // Take the standing-cost baseline before navigation probes have created
    // disposable renderer processes; that makes the first-tab delta useful.
    result.standingCost = await standingCost();
    result.isolatedSetBoundsLatency = await isolatedBoundsLatency();
    result.navigation = await navigationFirstPaint();

    const toolTabCount = Math.max(...options.tabs);
    for (const tabs of options.tabs) {
      for (const weight of options.weights) {
        console.error(`VC-363 matrix tabs=${tabs} weight=${weight}`);
        const views = await openTabs(tabs, weight);
        try {
          for (const mode of options.modes) {
            const runs = [];
            for (let repeat = 0; repeat < options.transitions; repeat += 1)
              runs.push(await runTransition(views[0], mode));
            result.matrix.push({ tabs, weight, mode, resize: aggregateTransitions(runs) });
          }
          if (tabs === toolTabCount) {
            const tools = await agentToolLatency(views[0], options.cdpTimeoutMs);
            result.agentTools.samples.push({ tabs, weight, ...tools });
            result.agentTools.any15sTimeout ||= tools.any15sTimeout;
          }
        } finally {
          for (const view of views) closeView(view);
        }
      }
    }
    result.finishedAt = new Date().toISOString();
    result.status = "ok";
  } catch (error) {
    result.finishedAt = new Date().toISOString();
    result.status = "failed";
    result.error = String(error?.stack ?? error);
  } finally {
    // Do not destroy the last BrowserWindow yet: macOS can quit the Electron
    // app on window-all-closed before the asynchronous JSON write below runs.
  }

  result.jsonDestination = options.json === "-" ? "stdout" : options.json;
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.json === "-") {
    console.error(summary(result));
    process.stdout.write(json);
  } else {
    await mkdir(dirname(options.json), { recursive: true });
    await writeFile(options.json, json);
    console.error(summary(result));
  }
  if (stageWindow !== null && !stageWindow.isDestroyed()) stageWindow.destroy();
  if (benchWindow !== null && !benchWindow.isDestroyed()) benchWindow.destroy();
  app.exit(result.status === "ok" ? 0 : 1);
});

process.on("unhandledRejection", (error) => {
  console.error(`VC-363 benchmark unhandled rejection: ${error?.stack ?? error}`);
  app.exit(1);
});
setTimeout(() => {
  console.error("VC-363 benchmark exceeded its 12 minute ceiling");
  app.exit(2);
}, 12 * 60_000).unref();
