/**
 * Browser Tab wakefulness bench: measures what a wake hold actually costs and
 * actually buys (VC-252).
 *
 * VC-252 shipped `BrowserTabHost.holdAwake`, a refcounted lease that calls
 * `webContents.setBackgroundThrottling(false)` so a Session can keep driving a
 * Browser Tab after the person switches to another project. The ticket also
 * asked for "a performance pass to ensure that ... our ability to manage
 * background tasks isn't hampering the UX for parallel work". This is that
 * pass. It answers four questions with numbers rather than argument:
 *
 *   A. Is a detached Browser Tab actually throttled? (the bug)
 *   B. Does a hold restore it to foreground pace? (the fix)
 *   C. Does one tab's hold lift throttling for OTHER tabs in the same window?
 *      Electron documents `backgroundThrottling: false` as affecting every
 *      WebContents in the host BrowserWindow (28.0.0 breaking change). If that
 *      holds here, the lease is window-wide and its cost is not per-tab.
 *   D. What does an idle held tab cost in CPU, and what does the hold buy for
 *      the ticket's headline symptom — a screenshot of a tab nobody is
 *      looking at?
 *
 * It models the host's MECHANISM rather than importing the host: one
 * BrowserWindow, WebContentsViews added to and removed from `contentView`, and
 * `setBackgroundThrottling` toggled exactly where `holdAwake` toggles it. That
 * is the whole of what Chromium sees, and it needs no built app or database.
 *
 * Run:
 *   node apps/desktop/e2e/browser-throttle-bench.mjs
 *
 * MANUALLY-RUN (needs a display); NOT wired into `vp test`. Keep the bench
 * window un-minimized and un-covered while it runs — macOS reports a fully
 * occluded window as hidden, which throttles the baseline and flattens every
 * comparison into noise. The bench prints an occlusion warning if it sees it.
 */
import { createServer } from "node:http";

import { app, BrowserWindow, WebContentsView } from "electron";

/** Long enough that a ~1Hz throttled tick is unambiguous, short enough to sit through. */
const SAMPLE_MS = 2_000;
/** The page's own timer period; 10ms is ~100 ticks/s when nothing throttles it. */
const TIMER_PERIOD_MS = 10;
/** Idle tabs to hold open for the CPU scenarios — the parallel-work shape. */
const IDLE_TABS = 4;
/** Matches CDP_COMMAND_TIMEOUT_MS in src/main/browser/cdp-controller.ts. */
const SCREENSHOT_BOUND_MS = 15_000;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>bench</title>
<style>body{margin:0;background:#123;color:#eee;font:14px system-ui}</style>
<body>
<canvas id="c" width="240" height="120"></canvas>
<script>
  // Two independent clocks. Timers measure the scheduler; animation frames
  // measure the compositor. Background throttling hits them differently, and
  // a screenshot needs the second one.
  let ticks = 0, frames = 0;
  setInterval(() => { ticks += 1; }, ${TIMER_PERIOD_MS});
  const ctx = document.getElementById("c").getContext("2d");
  const loop = () => {
    frames += 1;
    // Paint something that changes, so frames are real compositor work.
    ctx.fillStyle = "hsl(" + (frames % 360) + ",70%,50%)";
    ctx.fillRect(0, 0, 240, 120);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__reset = () => { ticks = 0; frames = 0; };
  window.__read = () => JSON.stringify({ ticks, frames });
</script>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serves the counter page over http, because real Browser Tabs are http(s). */
async function servePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** Counts one tab's timer ticks and animation frames over the sample window. */
async function rateOf(tab) {
  const contents = tab.view.webContents;
  await contents.executeJavaScript("window.__reset()");
  const startedAt = Date.now();
  await sleep(SAMPLE_MS);
  const elapsed = (Date.now() - startedAt) / 1000;
  const read = JSON.parse(await contents.executeJavaScript("window.__read()"));
  return {
    ticksPerSecond: read.ticks / elapsed,
    framesPerSecond: read.frames / elapsed,
  };
}

/** Total CPU across every process this app owns, sampled over the same window. */
async function cpuOverSample() {
  app.getAppMetrics();
  await sleep(SAMPLE_MS);
  return app
    .getAppMetrics()
    .reduce((total, metric) => total + (metric.cpu?.percentCPUUsage ?? 0), 0);
}

/**
 * One CDP screenshot, bounded exactly as the controller bounds it. Returns how
 * long the engine took to answer, or how it failed — the ticket's headline
 * symptom, measured.
 */
async function screenshotMs(tab) {
  const wire = tab.view.webContents.debugger;
  const startedAt = Date.now();
  try {
    if (!wire.isAttached()) wire.attach("1.3");
    // `Page.enable` is a CDP command like any other and can hang on a starved
    // engine too. Bounding only the screenshot would let this line reach the
    // whole-bench watchdog instead of reporting a bounded result.
    const enabled = await Promise.race([
      wire.sendCommand("Page.enable").then(() => "enabled"),
      sleep(SCREENSHOT_BOUND_MS).then(() => "timeout"),
    ]);
    if (enabled === "timeout") {
      return { ms: Date.now() - startedAt, outcome: "TIMED OUT in Page.enable" };
    }
    const answered = await Promise.race([
      wire.sendCommand("Page.captureScreenshot", { format: "png" }),
      sleep(SCREENSHOT_BOUND_MS).then(() => "timeout"),
    ]);
    if (answered === "timeout") {
      return { ms: Date.now() - startedAt, outcome: "TIMED OUT in captureScreenshot" };
    }
    const bytes = Buffer.from(answered.data ?? "", "base64").byteLength;
    return { ms: Date.now() - startedAt, outcome: `${(bytes / 1024).toFixed(0)}KB` };
  } catch (error) {
    return { ms: Date.now() - startedAt, outcome: `failed: ${error.message}` };
  }
}

/** Exactly what BrowserTabHost.applyWakePolicy does at lease 1 and lease 0. */
const hold = (tab) => tab.view.webContents.setBackgroundThrottling(false);
const unhold = (tab) => tab.view.webContents.setBackgroundThrottling(true);
const ratio = (value, base) => (base === 0 ? "n/a" : `${(value / base).toFixed(2)}x`);

function row(label, rate, note = "") {
  const ticks = rate.ticksPerSecond.toFixed(1).padStart(7);
  const frames = rate.framesPerSecond.toFixed(1).padStart(7);
  return `${label.padEnd(46)}${ticks}${frames}   ${note}`;
}

// Electron's ESM main deadlocks on a top-level `await app.whenReady()` — the
// module never finishes evaluating, so the loop never turns and ready never
// lands. Everything below therefore hangs off the callback instead.
app.whenReady().then(main);

// A bench that hangs is worse than a bench that fails: it costs a person their
// attention and tells them nothing. Both doors below always end the process.
process.on("unhandledRejection", (error) => {
  console.error(`bench failed: ${error?.stack ?? error}`);
  process.exit(1);
});
setTimeout(() => {
  console.error("bench exceeded its own 180s ceiling; something is wedged.");
  process.exit(2);
}, 180_000).unref();

async function main() {
  const page = await servePage();
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    title: "VC-252 throttle bench",
    alwaysOnTop: true,
    webPreferences: { backgroundThrottling: true },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  // The window's OWN renderer runs the same counters. It is the app's UI in
  // this model: always "displayed by" the window, which is the exact wording
  // of Electron's 28.0.0 note about backgroundThrottling reaching every
  // WebContents in the host window. Scenario G puts that to the test.
  await window.webContents.loadURL(page.url);

  /** Builds one tab the way BrowserTabHost builds one: sandboxed, off-window. */
  async function openTab(index) {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    view.setBounds({ x: 0, y: 0, width: 880, height: 560 });
    await view.webContents.loadURL(page.url);
    view.webContents.setAudioMuted(true);
    return { index, view };
  }

  const attach = (tab) => window.contentView.addChildView(tab.view);
  const detach = (tab) => window.contentView.removeChildView(tab.view);

  const driven = await openTab(0);
  const bystander = await openTab(1);
  const idle = [];
  for (let n = 0; n < IDLE_TABS; n += 1) idle.push(await openTab(2 + n));

  window.show();
  await sleep(1_000);

  const lines = [];
  const note = [];

  // ---- A. Baseline: the tab the person is looking at. ---------------------
  attach(driven);
  await sleep(500);
  const attachedRate = await rateOf(driven);
  lines.push(row("attached + visible (what a person sees)", attachedRate, "baseline"));
  if (attachedRate.framesPerSecond < 20) {
    note.push(
      "! The visible baseline is under 20fps. The bench window is probably covered or\n" +
        "  minimised, so macOS reports it occluded. Numbers below are not trustworthy.",
    );
  }

  // ---- B. The bug: detached, no hold. -------------------------------------
  detach(driven);
  await sleep(500);
  const detachedRate = await rateOf(driven);
  lines.push(row("detached, no hold (the VC-252 bug)", detachedRate, "the stall"));

  // ---- C. The fix: detached, holding itself awake. ------------------------
  hold(driven);
  await sleep(500);
  const heldRate = await rateOf(driven);
  lines.push(row("detached + own hold (the VC-252 fix)", heldRate, "the fix"));

  // ---- D. Blast radius: a DIFFERENT detached tab, holding nothing. --------
  // `bystander` was never attached and never held. If its rate tracks the held
  // tab rather than the throttled one, the lease is window-wide.
  const bystanderWhileHeld = await rateOf(bystander);
  lines.push(row("other detached tab, no hold of its own", bystanderWhileHeld, "<- blast radius"));

  unhold(driven);
  await sleep(500);
  const bystanderAfterRelease = await rateOf(bystander);
  lines.push(row("...the same tab once the hold is released", bystanderAfterRelease, "control"));

  // ---- E. Idle CPU, with and without one hold. ----------------------------
  const cpuIdle = await cpuOverSample();
  hold(driven);
  await sleep(500);
  const cpuHeld = await cpuOverSample();
  unhold(driven);

  // ---- F. The headline symptom: screenshotting an unwatched tab. ----------
  // A tab that has NEVER been held, so no residue of an earlier scenario can
  // explain the result. It is detached from birth, exactly like a tab opened
  // by a Session in a project the person is not looking at.
  const virgin = await openTab(99);
  const shotVirgin = await screenshotMs(virgin);
  await sleep(500);
  const shotThrottled = await screenshotMs(driven);
  hold(driven);
  await sleep(500);
  const shotHeld = await screenshotMs(driven);
  unhold(driven);

  // ---- G. The real blast radius: the window's own renderer, minimised. ----
  // A minimised window is hidden, so its own page throttles. If a hold on a
  // DETACHED tab lifts that too, the lease is window-wide and the whole app
  // stops sleeping whenever any Session drives a tab.
  window.minimize();
  await sleep(1_000);
  const ownMinimised = await rateOf({ view: { webContents: window.webContents } });
  hold(driven);
  await sleep(1_000);
  const ownMinimisedHeld = await rateOf({ view: { webContents: window.webContents } });
  unhold(driven);
  window.restore();
  await sleep(500);

  /** Five times the throttled floor is well clear of sampling jitter. */
  const windowWide = ownMinimisedHeld.ticksPerSecond > ownMinimised.ticksPerSecond * 5;

  console.log(`
VC-252 — Browser Tab wakefulness bench
Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${process.arch}
Sample ${SAMPLE_MS}ms per scenario · page timer ${TIMER_PERIOD_MS}ms (~${1000 / TIMER_PERIOD_MS}/s unthrottled)

${"scenario".padEnd(46)}${"ticks/s".padStart(7)}${"frames/s".padStart(7)}
${"-".repeat(46 + 14)}
${lines.join("\n")}

Timer pace vs the visible baseline
  detached, no hold                 ${ratio(detachedRate.ticksPerSecond, attachedRate.ticksPerSecond)}
  detached + hold                   ${ratio(heldRate.ticksPerSecond, attachedRate.ticksPerSecond)}
  bystander while another tab holds ${ratio(bystanderWhileHeld.ticksPerSecond, attachedRate.ticksPerSecond)}
  bystander after release           ${ratio(bystanderAfterRelease.ticksPerSecond, attachedRate.ticksPerSecond)}

Idle CPU, ${IDLE_TABS + 2} tabs open, none driven (total across all app processes)
  no holds                          ${cpuIdle.toFixed(1)}%
  one tab held awake                ${cpuHeld.toFixed(1)}%
  delta                             ${(cpuHeld - cpuIdle >= 0 ? "+" : "") + (cpuHeld - cpuIdle).toFixed(1)}%

Page.captureScreenshot on a detached tab (bound ${SCREENSHOT_BOUND_MS}ms)
  never-held tab, detached at birth  ${shotVirgin.ms}ms  ${shotVirgin.outcome}
  no hold                            ${shotThrottled.ms}ms  ${shotThrottled.outcome}
  with hold                          ${shotHeld.ms}ms  ${shotHeld.outcome}

Window's OWN renderer while the window is minimised (ticks/s)
  no hold anywhere                   ${ownMinimised.ticksPerSecond.toFixed(1)}
  while a detached tab is held       ${ownMinimisedHeld.ticksPerSecond.toFixed(1)}
  -> lease is ${windowWide ? "WINDOW-WIDE (the whole app stops sleeping)" : "PER-TAB (the window keeps sleeping)"}
${note.length > 0 ? `\n${note.join("\n")}` : ""}`);

  page.close();
  for (const tab of [driven, bystander, virgin, ...idle]) tab.view.webContents.close();
  window.destroy();
  app.quit();
}
