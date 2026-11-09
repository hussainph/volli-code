/** Synthetic ChatPlane measurement INSIDE an already guarded instance.
 * Not a launcher and not a real-app UX proof: its renderer uses the bench's
 * refusing bridge and deterministic transcript fixtures, no product setters.
 */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { measureChatWindow } from "../../bench/chat-window/measure.mjs";
import { readBenchCadence } from "../../bench/chat-window/production.mjs";
import { benchSettings } from "../../bench/chat-window/settings.mjs";
import { tracePhases } from "../../bench/chat-window/trace-summary.mjs";

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

async function serveBench(dist) {
  const root = await realpath(dist);
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      const path = await realpath(join(root, name === "/" ? "index.html" : name));
      if (!path.startsWith(root + sep)) throw new Error("outside bench");
      res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

export async function guardedChatWindowBench({
  app,
  spec,
  layout,
  repo,
  settings,
  doctor,
  expire,
}) {
  if (
    spec.model !== "fake" ||
    spec.fixture !== "empty" ||
    spec.cloud ||
    spec.deployment ||
    spec.remoteAcceptance
  )
    throw new Error("chat-window-bench requires an empty, local, fake-model instance");
  const recipe = benchSettings(settings);
  const guard = await doctor();
  if (!guard.ok) throw new Error(`bench guard failed: ${guard.problems.join("; ")}`);
  const dist = join(repo, "apps/desktop/e2e/bench/chat-window/dist");
  const benchCadence = await readBenchCadence(dist, recipe.diagramSampleMs);
  const server = await serveBench(dist);
  let windowId, cdp, timer;
  const trace = { active: false, files: [] };
  const traced =
    recipe.phases || [recipe.draftTrace, recipe.revealTrace, recipe.streamTrace].some(Boolean);
  // The timer belongs to the supervisor, not the possibly wedged renderer/main.
  // Expiry invokes the SAME bounded close/identity cleanup as stop.
  timer = setTimeout(() => void expire("chat-window-bench exceeded 300s"), 300_000);
  try {
    const pageEvent = app.waitForEvent("window", { timeout: 15_000 });
    windowId = await app.evaluate(({ BrowserWindow }, url) => {
      if (process.env.VOLLI_HARNESS !== "1" || process.env.VOLLI_QUIET_WINDOWS !== "1")
        throw new Error("bench requires guarded quiet process");
      const window = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        focusable: false,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      window.setIgnoreMouseEvents(true);
      if (process.platform === "darwin") window.setAlwaysOnTop(true, "normal", -1);
      window.showInactive();
      void window.loadURL(url);
      return window.id;
    }, `http://127.0.0.1:${server.address().port}/`);
    const page = await pageEvent;
    await page.waitForLoadState("load");
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const evaluate = (expression) => page.evaluate(expression);
    const measuredPid = await app.evaluate(
      ({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.getOSProcessId(),
      windowId,
    );
    const tracePath = join(layout.evidence, "chat-window-trace.json");
    const tracing = {
      async startRecording() {
        if (trace.active) return;
        await app.evaluate(({ contentTracing }) =>
          contentTracing.startRecording({
            included_categories: [
              "devtools.timeline",
              "blink.user_timing",
              "disabled-by-default-devtools.timeline",
              "cc",
              "gpu",
              "viz",
            ],
          }),
        );
        trace.active = true;
      },
      async stopRecording() {
        if (!trace.active) return tracePath;
        const file = await app.evaluate(
          ({ contentTracing }, path) => contentTracing.stopRecording(path),
          tracePath,
        );
        trace.active = false;
        trace.files.push(file);
        return file;
      },
    };
    // One trace for all stream samples; the page marks only the active frame
    // loop, excluding calibration, setup and settlement. Draft/reveal mark the
    // trusted input window in measure.mjs.
    if (traced) await tracing.startRecording();
    const normalized = { ...recipe, draftTrace: null, revealTrace: null, streamTrace: null };
    const report = await measureChatWindow({
      settings: normalized,
      rendererRssMb: () =>
        app.evaluate(({ app: electronApp }, pid) => {
          const metric = electronApp.getAppMetrics().find((entry) => entry.pid === pid);
          return metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
        }, measuredPid),
      contents: {
        async executeJavaScript(expression) {
          if (expression === "window.chatBench.collect()")
            await cdp.send("HeapProfiler.collectGarbage");
          return evaluate(expression);
        },
        debugger: { sendCommand: (name, params) => cdp.send(name, params) },
        // Trusted synthetic input only; never native focus or OS input.
        sendInputEvents: (batch) =>
          app.evaluate(
            ({ BrowserWindow }, { id, events }) => {
              const contents = BrowserWindow.fromId(id).webContents;
              for (const event of events) contents.sendInputEvent(event);
            },
            { id: windowId, events: batch },
          ),
        sendInputEvent: (input) =>
          app.evaluate(
            ({ BrowserWindow }, { id, event }) => {
              BrowserWindow.fromId(id).webContents.sendInputEvent(event);
            },
            { id: windowId, event: input },
          ),
      },
    });
    if (traced) {
      const file = await tracing.stopRecording();
      report[`${recipe.arm === "transcript" ? "stream" : recipe.arm}Trace`] = file;
      if (!report.failure)
        report.phases = tracePhases(
          JSON.parse(await readFile(file, "utf8")),
          measuredPid,
          ["stream", "transcript"].includes(recipe.arm) ? recipe.streamSamples : 1,
        );
    }
    report.errors.push(...errors);
    report.runtime = await app.evaluate(() => ({ ...process.versions }));
    report.quietWindow = await app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      return { focusable: window.isFocusable(), focused: window.isFocused() };
    }, windowId);
    if (report.quietWindow.focusable || report.quietWindow.focused)
      throw new Error("bench native quiet-window violation");
    report.guard = guard;
    report.benchCadence = benchCadence;
    report.measuredRendererPid = measuredPid;
    return report;
  } finally {
    if (trace.active)
      await app.evaluate(({ contentTracing }) => contentTracing.stopRecording()).catch(() => {});
    await cdp?.detach().catch(() => {});
    if (windowId)
      await app
        .evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), windowId)
        .catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(timer);
  }
}
