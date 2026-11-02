#!/usr/bin/env electron
/**
 * VC-1082 agent-browser main-thread benchmark.
 *
 * A manual, self-contained Electron benchmark. It does not boot Volli; it runs
 * the same native mechanisms one agent browser step runs on Electron main, on
 * a tab staged in a never-shown BaseWindow exactly as the tab host stages a
 * Session's tab, and reports how long each one holds the main event loop:
 *
 *   preview   capturePage() + nativeImage.toJPEG (the old transcript preview)
 *             vs Page.captureScreenshot {format: jpeg} (encoded off main)
 *   ax        Accessibility.getFullAXTree in one answer vs the controller's
 *             piecewise read (getRootAXNode + rounds of getChildAXNodes over
 *             what the prints walk), which pages past 5,000 DOM nodes now take
 *   picture   writeFileSync of one screenshot vs fs.promises
 *   trace     a full-trace rewrite (writeFileSync + renameSync) vs fs.promises
 *
 * "Blocked" is the longest event-loop block seen while the operation ran,
 * sampled by a 1 ms interval — what a person sees as a frozen app — next to
 * the wall time the operation took. Each arm runs `--runs` times; the report
 * prints the median and max.
 *
 * Run (needs a display; about 20 seconds):
 *   apps/desktop/node_modules/.bin/electron apps/desktop/e2e/browser-agent-step-bench.mjs
 *   ... --rows 6000 --runs 9
 *   apps/desktop/node_modules/.bin/electron --force-device-scale-factor=2 apps/desktop/e2e/browser-agent-step-bench.mjs --offscreen
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { app, BaseWindow, BrowserWindow, WebContentsView, screen } from "electron";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};
const ROWS = arg("rows", 4_000);
const RUNS = arg("runs", 7);
const VIEWPORT = { x: 0, y: 0, width: 1_280, height: 800 };
const JPEG_QUALITY = 80;
/**
 * Offscreen rendering, for a Mac whose display is asleep (no compositor frames
 * reach a staged view then). Pair it with `--force-device-scale-factor=2` before
 * the script path to keep Retina-sized frames.
 */
const OFFSCREEN = process.argv.includes("--offscreen");

/** A heavy page: a long table of linked, buttoned rows — a big AX tree, not a deep one. */
const heavyPage = (rows) => `<!doctype html><meta charset="utf-8"><title>heavy</title>
<body style="margin:0;font:14px system-ui"><h1>Heavy page</h1><table><tbody>${Array.from(
  { length: rows },
  (_, index) =>
    `<tr><td><a href="#r${index}">Row ${index}</a></td><td>Some cell text for row ${index}</td>` +
    `<td><button>Edit ${index}</button></td><td><input aria-label="Value ${index}" value="${index}"></td>` +
    `<td><span style="color:hsl(${index % 360} 70% 40%)">${"lorem ipsum ".repeat(4)}</span></td></tr>`,
).join("")}</tbody></table>`;

/**
 * The piecewise read, as `BrowserTabController` runs it (cdp-controller.ts,
 * with `axTreeGaps` from snapshot-format.ts): a replica, because this bench
 * runs plain Electron with no TypeScript. Keep the walk rules in step.
 */
const SILENT = new Set([
  "rootwebarea",
  "generic",
  "genericcontainer",
  "none",
  "presentation",
  "inlinetextbox",
  "linebreak",
]);
const TEXT = new Set(["statictext", "text"]);
function gaps(byId, rootId) {
  const found = [];
  const visited = new Set();
  let remaining = 20_000;
  const walk = (node, depth) => {
    if (visited.has(node.nodeId) || remaining === 0 || depth > 128) return;
    visited.add(node.nodeId);
    remaining -= 1;
    const role =
      typeof node.role?.value === "string"
        ? node.role.value.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
        : "";
    if (!(node.ignored === true || SILENT.has(role) || role === "" || !TEXT.has(role))) return;
    let gap = false;
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child === undefined) gap = true;
      else walk(child, depth + 1);
    }
    if (gap) found.push(node.nodeId);
  };
  walk(byId.get(rootId), 0);
  return found;
}
async function readInPieces(send) {
  const root = (await send("Accessibility.getRootAXNode")).node;
  const byId = new Map([[root.nodeId, root]]);
  const asked = new Set();
  for (;;) {
    const todo = gaps(byId, root.nodeId)
      .filter((id) => !asked.has(id))
      .slice(0, 128);
    if (todo.length === 0) return byId;
    const answers = await Promise.all(
      todo.map((id) => (asked.add(id), send("Accessibility.getChildAXNodes", { id }))),
    );
    for (const answer of answers)
      for (const node of answer.nodes) if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  }
}

/** Runs `work` while sampling the loop; answers wall time and the longest block. */
async function measure(work) {
  let last = performance.now();
  let blocked = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    blocked = Math.max(blocked, now - last);
    last = now;
  }, 1);
  const startedAt = performance.now();
  last = startedAt;
  await work();
  const wall = performance.now() - startedAt;
  // One more turn so a block at the very end is seen by the sampler.
  await new Promise((resolve) => setTimeout(resolve, 2));
  clearInterval(sampler);
  blocked = Math.max(blocked, performance.now() - last - 2);
  return { wall, blocked };
}

const median = (values) => values[Math.floor(values.length / 2)];

async function arm(name, work) {
  const samples = [];
  await work(); // warm-up
  for (let run = 0; run < RUNS; run += 1) samples.push(await measure(work));
  const pick = (key) => samples.map((sample) => sample[key]).toSorted((a, b) => a - b);
  const row = {
    name,
    wallMedian: median(pick("wall")),
    blockedMedian: median(pick("blocked")),
    blockedMax: pick("blocked").at(-1),
  };
  process.stderr.write(
    `${name.padEnd(44)} wall ${row.wallMedian.toFixed(1).padStart(7)} ms   ` +
      `main blocked median ${row.blockedMedian.toFixed(1).padStart(6)} ms, max ${row.blockedMax.toFixed(1).padStart(6)} ms\n`,
  );
  return row;
}

app.whenReady().then(async () => {
  // The app's own window: the stage gets its compositor surface beside one.
  const appWindow = new BrowserWindow({ width: 400, height: 300, show: true });
  await appWindow.loadURL("about:blank");
  const stage = new BaseWindow({ show: false, width: VIEWPORT.width, height: VIEWPORT.height });
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: OFFSCREEN,
    },
  });
  stage.contentView.addChildView(view);
  view.setBounds(VIEWPORT);
  view.webContents.setBackgroundThrottling(false);
  const page = heavyPage(ROWS);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
  process.stderr.write("page loaded\n");
  const wire = view.webContents.debugger;
  wire.attach("1.3");
  await wire.sendCommand("Accessibility.enable");
  await wire.sendCommand("Page.enable");
  // The tab host waits for a rendered frame before its first read; so does this.
  await wire.sendCommand("Runtime.evaluate", {
    expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
    awaitPromise: true,
  });
  process.stderr.write("rendered\n");

  const full = await wire.sendCommand("Accessibility.getFullAXTree");
  const send = (method, params) => wire.sendCommand(method, params);
  const pieces = await readInPieces(send);
  const counters = await wire.sendCommand("Memory.getDOMCounters");
  const sample = await view.webContents.capturePage();
  const jpeg = sample.toJPEG(JPEG_QUALITY);
  process.stderr.write(
    `scale ${screen.getPrimaryDisplay().scaleFactor}x, frame ${sample.getSize().width}x${sample.getSize().height} ` +
      `(${(sample.toBitmap().length / 4 / 1e6).toFixed(1)} MP) -> ` +
      `${(jpeg.length / 1024).toFixed(0)} KB jpeg; ` +
      `${ROWS} rows -> ${full.nodes.length} AX nodes (${(JSON.stringify(full).length / 1e6).toFixed(1)} MB), ` +
      `${counters.nodes} DOM nodes; piecewise read holds ${pieces.size}\n\n`,
  );

  const dir = mkdtempSync(join(tmpdir(), "vc1082-bench-"));
  const trace = {
    traceId: "00000000-0000-4000-8000-000000000000",
    steps: Array.from({ length: 150 }, (_, index) => ({
      index,
      action: "act",
      target: `button "Edit ${index}"`,
      url: `https://example.com/some/long/path/${index}?with=query`,
      title: "A page title",
      generation: index,
      at: Date.now(),
      outcome: "ok",
      rule: null,
      error: null,
      pictureId: "00000000-0000-4000-8000-000000000001",
    })),
  };
  let file = 0;

  const rows = [
    await arm("preview: capturePage + toJPEG (before)", async () => {
      const image = await view.webContents.capturePage();
      image.toJPEG(JPEG_QUALITY);
    }),
    await arm("preview: Page.captureScreenshot jpeg (alt)", async () => {
      const shot = await wire.sendCommand("Page.captureScreenshot", {
        format: "jpeg",
        quality: JPEG_QUALITY,
      });
      Buffer.from(shot.data, "base64");
    }),
    await arm("ax: getFullAXTree (before)", () => wire.sendCommand("Accessibility.getFullAXTree")),
    await arm("ax: piecewise read (after)", () => readInPieces(send)),
    await arm("picture: writeFileSync x2 (before)", async () => {
      file += 1;
      writeFileSync(join(dir, `${file}.jpg`), jpeg);
      writeFileSync(join(dir, `${file}.json`), JSON.stringify({ id: file }));
    }),
    await arm("picture: fs.promises x2 (after)", async () => {
      file += 1;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${file}.jpg`), jpeg);
      await writeFile(join(dir, `${file}.json`), JSON.stringify({ id: file }));
    }),
    await arm("trace: 150-step rewrite sync (before)", async () => {
      writeFileSync(join(dir, "trace.json.tmp"), JSON.stringify(trace));
      renameSync(join(dir, "trace.json.tmp"), join(dir, "trace.json"));
    }),
    await arm("trace: 150-step rewrite async (after)", async () => {
      await writeFile(join(dir, "trace.json.tmp"), JSON.stringify(trace));
      await rename(join(dir, "trace.json.tmp"), join(dir, "trace.json"));
    }),
  ];
  process.stdout.write(`${JSON.stringify({ rows: ROWS, runs: RUNS, results: rows })}\n`);
  rmSync(dir, { recursive: true, force: true });
  wire.detach();
  server.close();
  stage.destroy();
  appWindow.destroy();
  app.quit();
});
