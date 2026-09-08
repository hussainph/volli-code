/**
 * Headless-tab capture probe (VC-278): why `Page.captureScreenshot` times out
 * on a Browser Tab nobody has ever shown.
 *
 * `browser-throttle-bench.mjs` (VC-252) measured a tab that was ATTACHED to the
 * window once and then detached. That is the "person switched workspace" shape,
 * and for it the wake hold works: ~100ms screenshots. But a Session-created tab
 * is born `headless` — `BrowserTabHost.open` never calls `addChildView` — so in
 * production the view is detached SINCE BIRTH and stays that way unless a person
 * reveals it. The bench never measured that combination with a hold, and it is
 * the only shape agent screenshots actually run in.
 *
 * This probe models the production sequence exactly, including its ORDER:
 * `open()` fires `loadURL` and returns, and the port applies the wake hold
 * afterwards, while that first navigation is still in flight
 * (`agent-port.ts` → `snapshotOf` → `keepAwake`).
 *
 * It also asks the question the fix depends on: does Electron's own
 * `webContents.capturePage()` — the path `capturePicture` already uses for the
 * transcript frame — answer on a tab whose CDP capture has wedged?
 *
 * Run:
 *   node apps/desktop/e2e/browser-headless-capture-probe.mjs
 *
 * MANUALLY-RUN (needs a display); NOT wired into `vp test`.
 */
import { createServer } from "node:http";

import { app, BrowserWindow, WebContentsView } from "electron";

/** Matches CDP_COMMAND_TIMEOUT_MS in src/main/browser/cdp-controller.ts. */
const BOUND_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two pages: a trivial one, and one whose module graph lands in pieces after
 * the document load — the dev-server shape VC-278 was noticed on.
 */
const LIGHT = `<!doctype html><meta charset="utf-8"><title>light</title>
<body style="margin:0;background:#123;color:#eee;font:14px system-ui"><h1>light</h1>`;

const HEAVY = `<!doctype html><meta charset="utf-8"><title>heavy</title>
<body style="margin:0;background:#312;color:#eee;font:14px system-ui">
<div id="root">booting</div>
<script type="module">
  // Stand-in for Vite compiling a scratch's graph on demand: the document has
  // loaded, isLoading() is false, and the page is still becoming itself.
  const chunk = await fetch("/chunk").then((r) => r.text());
  document.getElementById("root").textContent = chunk;
  for (let i = 0; i < 400; i += 1) {
    const d = document.createElement("div");
    d.textContent = "row " + i;
    document.body.appendChild(d);
  }
</script>`;

async function servePages() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/chunk") {
      // The compile delay, on the critical path of first paint.
      await sleep(1_200);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("compiled");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(path === "/heavy" ? HEAVY : LIGHT);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}` };
}

/** One CDP screenshot, bounded exactly as the controller bounds it. */
async function cdpShot(view) {
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
      wire.sendCommand("Page.captureScreenshot", { format: "png" }),
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

/** Electron's own capture — the door `capturePicture` already uses. */
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
    const kb = image.toPNG().byteLength / 1024;
    return {
      ms: Date.now() - startedAt,
      outcome: `${size.width}x${size.height} ${kb.toFixed(0)}KB`,
    };
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

const hold = (view) => view.webContents.setBackgroundThrottling(false);

/** The port's `waitForLoad`: did-stop-loading, or 10s. */
function waitForLoad(view) {
  return new Promise((resolve) => {
    const contents = view.webContents;
    if (!contents.isLoading()) return resolve();
    const done = () => {
      clearTimeout(timer);
      contents.removeListener("did-stop-loading", done);
      resolve();
    };
    const timer = setTimeout(done, 10_000);
    contents.on("did-stop-loading", done);
  });
}

app.whenReady().then(main);

process.on("unhandledRejection", (error) => {
  console.error(`probe failed: ${error?.stack ?? error}`);
  process.exit(1);
});
setTimeout(() => {
  console.error("probe exceeded its own 300s ceiling; something is wedged.");
  process.exit(2);
}, 300_000).unref();

async function main() {
  const { base } = await servePages();
  const window = new BrowserWindow({ width: 900, height: 600, show: false });
  await window.webContents.loadURL(`${base}/`);
  window.show();
  window.setAlwaysOnTop(true, "screen-saver");
  await sleep(500);

  /** `loadURL` fired and NOT awaited, the way `open()` fires it. */
  const startLoad = (view, path) => {
    void view.webContents.loadURL(`${base}${path}`).catch(() => undefined);
  };
  const rows = [];
  const record = (label, shot) => {
    rows.push(`${label.padEnd(58)}${String(shot.ms).padStart(7)}ms   ${shot.outcome}`);
    console.log(`  ${label} -> ${shot.ms}ms ${shot.outcome}`);
  };

  console.log("running scenarios (each may sit on the 15s bound)...");

  // A. Never attached, never held — the plain headless tab.
  {
    const view = makeTab();
    startLoad(view, "/heavy");
    await waitForLoad(view);
    record("A. never attached, no hold (heavy)", await cdpShot(view));
    view.webContents.close();
  }

  // B. PRODUCTION ORDER: load fired, then the hold, then wait, then capture.
  {
    const view = makeTab();
    startLoad(view, "/heavy");
    hold(view); // keepAwake lands while the first navigation is in flight
    await waitForLoad(view);
    const cdp = await cdpShot(view);
    record("B. never attached, hold DURING nav (production order)", cdp);
    // Same wedged tab, other door: does Electron's own capture answer?
    record("   B'. ...same tab, webContents.capturePage()", await pageShot(view));
    // And does re-applying the hold rescue it?
    view.webContents.setBackgroundThrottling(true);
    hold(view);
    await sleep(300);
    record("   B''. ...after re-toggling the hold", await cdpShot(view));
    view.webContents.close();
  }

  // C. Hold applied BEFORE the navigation starts.
  {
    const view = makeTab();
    hold(view);
    await sleep(200);
    startLoad(view, "/heavy");
    await waitForLoad(view);
    record("C. never attached, hold BEFORE nav", await cdpShot(view));
    view.webContents.close();
  }

  // D. Hold applied AFTER the load settled.
  {
    const view = makeTab();
    startLoad(view, "/heavy");
    await waitForLoad(view);
    await sleep(300);
    hold(view);
    await sleep(300);
    record("D. never attached, hold AFTER load settled", await cdpShot(view));
    view.webContents.close();
  }

  // E. The VC-252 bench shape: attached once, then detached, then held.
  {
    const view = makeTab();
    window.contentView.addChildView(view);
    startLoad(view, "/heavy");
    await waitForLoad(view);
    await sleep(500);
    window.contentView.removeChildView(view);
    hold(view);
    await sleep(300);
    record("E. attached once -> detached + hold (VC-252 bench shape)", await cdpShot(view));
    view.webContents.close();
  }

  // F. Production order on a LIGHT page — is heaviness required?
  {
    const view = makeTab();
    startLoad(view, "/");
    hold(view);
    await waitForLoad(view);
    record("F. never attached, hold DURING nav (light page)", await cdpShot(view));
    view.webContents.close();
  }

  // G. Second navigation on a tab already wedged by the first.
  {
    const view = makeTab();
    startLoad(view, "/heavy");
    hold(view);
    await waitForLoad(view);
    const first = await cdpShot(view);
    record("G. first capture after first nav", first);
    startLoad(view, "/");
    await waitForLoad(view);
    record("   G'. ...capture after a SECOND navigation", await cdpShot(view));
    view.webContents.close();
  }

  console.log(`
VC-278 — headless Browser Tab capture probe
Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${process.arch}
CDP bound ${BOUND_MS}ms (matches CDP_COMMAND_TIMEOUT_MS)

${"scenario".padEnd(58)}${"time".padStart(9)}   outcome
${"-".repeat(58 + 9 + 3 + 24)}
${rows.join("\n")}
`);

  app.quit();
}
