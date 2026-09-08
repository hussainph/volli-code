/**
 * Does the VC-278 fix return the RIGHT picture, not just a picture?
 *
 * `captureBeyondViewport: true` un-wedges capture on a never-attached
 * WebContentsView, but the flag also changes what Chromium frames: without a
 * clip it can render the whole scrollable document rather than the viewport
 * the controller reports as `width`/`height`. A screenshot tool that says
 * "660x251" and hands back a 4000px-tall image is a new bug, so this measures
 * the shape and the content, on a page deliberately taller and wider than its
 * viewport.
 *
 * It also checks the frame is not simply blank: a capture that answers quickly
 * with a white rectangle would pass every timing test and still be useless.
 *
 * Run:
 *   node apps/desktop/e2e/browser-headless-capture-shape.mjs
 *
 * MANUALLY-RUN (needs a display); NOT wired into `vp test`.
 */
import { createServer } from "node:http";

import { app, BrowserWindow, WebContentsView, nativeImage } from "electron";

const BOUND_MS = 15_000;
const VIEWPORT = { x: 0, y: 0, width: 660, height: 251 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Taller and wider than the viewport, and vividly coloured so blankness shows. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>tall</title>
<body style="margin:0;background:#0a0;font:16px system-ui;width:1600px">
<div style="height:120px;background:#f0f">top band</div>
${Array.from({ length: 60 }, (_, i) => `<p style="color:#fff">row ${i}</p>`).join("")}
<div style="height:120px;background:#00f">bottom band</div>`;

async function servePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

/** Distinct colours in the decoded bitmap — 1 means a flat, blank frame. */
function colourCount(pngBase64) {
  const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, "base64"));
  const size = image.getSize();
  if (size.width === 0) return { size, colours: 0 };
  const bitmap = image.toBitmap();
  const seen = new Set();
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 97) {
    seen.add(`${bitmap[i]},${bitmap[i + 1]},${bitmap[i + 2]}`);
    if (seen.size > 40) break;
  }
  return { size, colours: seen.size };
}

async function shot(view, params) {
  const wire = view.webContents.debugger;
  const startedAt = Date.now();
  if (!wire.isAttached()) wire.attach("1.3");
  await wire.sendCommand("Page.enable");
  const answered = await Promise.race([
    wire.sendCommand("Page.captureScreenshot", params),
    sleep(BOUND_MS).then(() => null),
  ]);
  if (answered === null) return { ms: Date.now() - startedAt, note: "TIMEOUT" };
  const { size, colours } = colourCount(answered.data ?? "");
  return {
    ms: Date.now() - startedAt,
    note: `${size.width}x${size.height}px · ${colours} colours · ${(Buffer.from(answered.data, "base64").byteLength / 1024).toFixed(0)}KB`,
  };
}

/** What the controller reports as width/height beside the pixels. */
async function reportedViewport(view) {
  const wire = view.webContents.debugger;
  const metrics = await wire.sendCommand("Page.getLayoutMetrics");
  const vp = metrics.cssVisualViewport ?? {};
  return `${Math.round(vp.clientWidth ?? 0)}x${Math.round(vp.clientHeight ?? 0)}`;
}

app.whenReady().then(main);
process.on("unhandledRejection", (error) => {
  console.error(`probe failed: ${error?.stack ?? error}`);
  process.exit(1);
});
setTimeout(() => process.exit(2), 180_000).unref();

async function main() {
  const url = await servePage();
  const rows = [];
  const record = (label, result, reported) => {
    rows.push(
      `${label.padEnd(46)}${String(result.ms).padStart(6)}ms  reports ${reported.padEnd(9)} -> ${result.note}`,
    );
    console.log(`  ${label} -> ${result.ms}ms reports ${reported} got ${result.note}`);
  };

  function makeTab() {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    view.setBounds(VIEWPORT);
    return view;
  }

  // Baseline: an ATTACHED tab captured the way the controller does today.
  const window = new BrowserWindow({ width: 900, height: 600, show: false });
  await window.webContents.loadURL(url);
  window.show();
  const attached = makeTab();
  window.contentView.addChildView(attached);
  await attached.webContents.loadURL(url);
  await sleep(400);
  record(
    "attached, today's params (the truth)",
    await shot(attached, { format: "png" }),
    await reportedViewport(attached),
  );

  // Fix H, as a drop-in.
  const beyond = makeTab();
  await beyond.webContents.loadURL(url);
  beyond.webContents.setBackgroundThrottling(false);
  await sleep(300);
  record(
    "never attached + captureBeyondViewport",
    await shot(beyond, { format: "png", captureBeyondViewport: true }),
    await reportedViewport(beyond),
  );

  // Fix H, clipped to the viewport it reports.
  const clipped = makeTab();
  await clipped.webContents.loadURL(url);
  clipped.webContents.setBackgroundThrottling(false);
  await sleep(300);
  record(
    "never attached + beyondViewport + clip",
    await shot(clipped, {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 },
    }),
    await reportedViewport(clipped),
  );

  // Fix I: a never-shown stage window, today's params unchanged.
  const stage = new BrowserWindow({ width: 900, height: 600, show: false });
  const staged = makeTab();
  stage.contentView.addChildView(staged);
  await staged.webContents.loadURL(url);
  await sleep(400);
  record(
    "staged in hidden window, today's params",
    await shot(staged, { format: "png" }),
    await reportedViewport(staged),
  );

  console.log(`
VC-278 — does the fix return the right picture?
Electron ${process.versions.electron} · Chromium ${process.versions.chrome}
View bounds ${VIEWPORT.width}x${VIEWPORT.height}; page is 1600px wide and far taller.
"colours" samples the decoded bitmap: 1 means a blank frame.

${rows.join("\n")}
`);
  app.quit();
}
