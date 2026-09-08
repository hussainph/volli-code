/**
 * Candidate fixes for VC-278, measured.
 *
 * `browser-headless-capture-probe.mjs` established the fault: a WebContentsView
 * that has NEVER been added to a window's contentView cannot be captured — not
 * by CDP, not by `capturePage()` — regardless of the wake hold, the page's
 * weight, or how long anyone waits. This probe asks which repairs actually
 * work, under the constraint that an agent's page must NOT appear on screen
 * (VC-238: "only a person can reveal one").
 *
 * Run:
 *   node apps/desktop/e2e/browser-headless-capture-fixes.mjs
 *
 * MANUALLY-RUN (needs a display); NOT wired into `vp test`.
 */
import { createServer } from "node:http";

import { app, BrowserWindow, WebContentsView } from "electron";

const BOUND_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>fix probe</title>
<body style="margin:0;background:#204;color:#fff;font:16px system-ui">
<h1>capture me</h1><p>second line</p>`;

async function servePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

async function cdpShot(view, params = { format: "png" }) {
  const wire = view.webContents.debugger;
  const startedAt = Date.now();
  try {
    if (!wire.isAttached()) wire.attach("1.3");
    const enabled = await Promise.race([
      wire.sendCommand("Page.enable").then(() => "ok"),
      sleep(BOUND_MS).then(() => "timeout"),
    ]);
    if (enabled === "timeout")
      return { ms: Date.now() - startedAt, outcome: "TIMEOUT Page.enable" };
    const answered = await Promise.race([
      wire.sendCommand("Page.captureScreenshot", params),
      sleep(BOUND_MS).then(() => "timeout"),
    ]);
    if (answered === "timeout") {
      return { ms: Date.now() - startedAt, outcome: "TIMEOUT captureScreenshot" };
    }
    const kb = Buffer.from(answered.data ?? "", "base64").byteLength / 1024;
    return { ms: Date.now() - startedAt, outcome: `${kb.toFixed(0)}KB` };
  } catch (error) {
    return { ms: Date.now() - startedAt, outcome: `failed: ${error.message}` };
  }
}

async function pageShot(view) {
  const startedAt = Date.now();
  try {
    const image = await Promise.race([
      view.webContents.capturePage(),
      sleep(BOUND_MS).then(() => "timeout"),
    ]);
    if (image === "timeout") return { ms: Date.now() - startedAt, outcome: "TIMEOUT capturePage" };
    const size = image.getSize();
    if (size.width === 0 || size.height === 0) {
      return { ms: Date.now() - startedAt, outcome: "empty 0x0" };
    }
    return { ms: Date.now() - startedAt, outcome: `${size.width}x${size.height}` };
  } catch (error) {
    return { ms: Date.now() - startedAt, outcome: `failed: ${error.message}` };
  }
}

/** Exactly what BrowserTabHost.open builds: sandboxed, sized, NOT attached. */
function makeTab() {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBounds({ x: 0, y: 0, width: 880, height: 560 });
  view.webContents.setAudioMuted(true);
  return view;
}

app.whenReady().then(main);
process.on("unhandledRejection", (error) => {
  console.error(`probe failed: ${error?.stack ?? error}`);
  process.exit(1);
});
setTimeout(() => {
  console.error("probe exceeded its 300s ceiling.");
  process.exit(2);
}, 300_000).unref();

async function main() {
  const url = await servePage();
  const appWindow = new BrowserWindow({ width: 900, height: 600, show: false });
  await appWindow.webContents.loadURL(url);
  appWindow.show();
  await sleep(500);

  const load = async (view) => {
    await view.webContents.loadURL(url);
  };

  const rows = [];
  const record = (label, shot, note = "") => {
    rows.push(
      `${label.padEnd(56)}${String(shot.ms).padStart(7)}ms   ${shot.outcome.padEnd(26)}${note}`,
    );
    console.log(`  ${label} -> ${shot.ms}ms ${shot.outcome}`);
  };

  console.log("measuring candidate fixes...");

  // H. captureBeyondViewport — a different capture path inside Chromium.
  {
    const view = makeTab();
    await load(view);
    view.webContents.setBackgroundThrottling(false);
    record(
      "H. never attached + captureBeyondViewport:true",
      await cdpShot(view, { format: "png", captureBeyondViewport: true }),
    );
    view.webContents.close();
  }

  // I. A never-shown BrowserWindow used purely as a capture stage.
  //    The agent's page is attached to a window the person never sees.
  {
    const stage = new BrowserWindow({ width: 900, height: 600, show: false });
    const view = makeTab();
    stage.contentView.addChildView(view);
    await load(view);
    await sleep(300);
    record("I. attached to a never-shown window (show:false)", await cdpShot(view));
    record("   I'. ...capturePage() on the same", await pageShot(view));
    stage.contentView.removeChildView(view);
    view.webContents.close();
    stage.destroy();
  }

  // J. "Priming": attach to the real window, then detach at once, never shown
  //    to the person for a full frame. Does one attach fix the tab for good?
  {
    const view = makeTab();
    appWindow.contentView.addChildView(view);
    appWindow.contentView.removeChildView(view);
    await load(view);
    view.webContents.setBackgroundThrottling(false);
    await sleep(300);
    record("J. attach+detach immediately (prime), then capture", await cdpShot(view));
    view.webContents.close();
  }

  // K. A stage window parked outside every display, then actually shown.
  {
    const stage = new BrowserWindow({
      width: 900,
      height: 600,
      show: false,
      x: -4000,
      y: -4000,
      skipTaskbar: true,
    });
    const view = makeTab();
    stage.contentView.addChildView(view);
    await load(view);
    stage.showInactive();
    await sleep(500);
    record("K. offscreen stage window, showInactive()", await cdpShot(view));
    stage.contentView.removeChildView(view);
    view.webContents.close();
    stage.destroy();
  }

  // L. Screencast: ask Chromium to stream frames, which forces production.
  {
    const view = makeTab();
    await load(view);
    view.webContents.setBackgroundThrottling(false);
    const wire = view.webContents.debugger;
    if (!wire.isAttached()) wire.attach("1.3");
    await wire.sendCommand("Page.enable");
    const startedAt = Date.now();
    let outcome = "no frame in 8s";
    try {
      const framed = new Promise((resolve) => {
        wire.on("message", (_e, method, params) => {
          if (method === "Page.screencastFrame") resolve(params?.data ?? "");
        });
      });
      await wire.sendCommand("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const data = await Promise.race([framed, sleep(8_000).then(() => null)]);
      if (typeof data === "string") {
        outcome = `${(Buffer.from(data, "base64").byteLength / 1024).toFixed(0)}KB via screencast`;
      }
      await wire.sendCommand("Page.stopScreencast").catch(() => undefined);
    } catch (error) {
      outcome = `failed: ${error.message}`;
    }
    record("L. never attached + Page.startScreencast", {
      ms: Date.now() - startedAt,
      outcome,
    });
    view.webContents.close();
  }

  // M. Control: the stage-window fix, then DETACHED again — does capture
  //    survive once the tab has been attached to a never-shown window?
  {
    const stage = new BrowserWindow({ width: 900, height: 600, show: false });
    const view = makeTab();
    stage.contentView.addChildView(view);
    await load(view);
    await sleep(300);
    stage.contentView.removeChildView(view);
    view.webContents.setBackgroundThrottling(false);
    await sleep(300);
    record("M. staged once, then detached + hold", await cdpShot(view));
    view.webContents.close();
    stage.destroy();
  }

  console.log(`
VC-278 — candidate fixes
Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${process.arch}

${"candidate".padEnd(56)}${"time".padStart(9)}   outcome
${"-".repeat(56 + 9 + 3 + 26)}
${rows.join("\n")}
`);
  app.quit();
}
