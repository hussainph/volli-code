/**
 * The bench's Electron host (VC-338): a window, a static server, and the
 * measurements the renderer cannot take about itself.
 *
 * RSS has to be read from the main process — `app.getAppMetrics()` reports the
 * renderer's working set, and nothing inside the page can see it. So this file
 * owns the sequence: seed the stores, mount N planes, sample, and print one JSON
 * document on stdout for `chat-window-bench.mjs` to report.
 *
 * Short-lived by construction: it quits as soon as it has its numbers. Nothing
 * here is a dev server and nothing stays resident.
 */
const { app, BrowserWindow, contentTracing } = require("electron");
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const { extname, join, normalize, resolve } = require("node:path");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const DIST = resolve(flag("dist", join(__dirname, "dist")));
const SESSIONS = Number(flag("sessions", "10"));
const TURNS = Number(flag("turns", "2000"));
const LABEL = flag("label", "run");
const STREAM_SAMPLES = Number(flag("stream-samples", "8"));
const STREAM_STEPS = Number(flag("stream-steps", "120"));
const STREAM_TOKEN_RATE = Number(flag("stream-token-rate", "30"));
// The draft-typing arm (VC-1079): `--arm draft` replaces the transcript steps.
const ARM = flag("arm", "transcript");
const DRAFT_PLANES = Number(flag("draft-planes", "2"));
const DRAFT_BALLAST = Number(flag("draft-ballast", "8000"));
const DRAFT_KEYS = Number(flag("draft-keys", "150"));
const DRAFT_KEY_INTERVAL_MS = Number(flag("draft-key-interval", "60"));
// Optional: a Chromium trace of the typing window only, for attributing the
// per-keystroke cost (style recalc, layout, paint, script) — `--draft-trace <file>`.
const DRAFT_TRACE = flag("draft-trace", null);
// Optional: Chromium's CPU throttling for the typing window, standing in for a
// machine whose cores are busy with other work — `--draft-cpu-throttle 4`.
const DRAFT_CPU_THROTTLE = Number(flag("draft-cpu-throttle", "1"));
// The chat-switch arm (VC-1100): `--arm reveal` presses a pane's next chat with
// the others kept mounted behind `<Activity mode="hidden">` (VC-1080).
const REVEAL_PLANES = Number(flag("reveal-planes", "2"));
const REVEAL_SWITCHES = Number(flag("reveal-switches", "30"));
const REVEAL_INTERVAL_MS = Number(flag("reveal-interval", "400"));
const REVEAL_BALLAST = Number(flag("reveal-ballast", "0"));
const REVEAL_TRACE = flag("reveal-trace", null);
const REVEAL_CPU_THROTTLE = Number(flag("reveal-cpu-throttle", "1"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** The built bundle, served from localhost so the page's module scripts load. */
function serve() {
  return new Promise((done) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const path = join(DIST, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      try {
        const body = await readFile(path);
        response.writeHead(200, {
          "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
        });
        response.end(body);
      } catch {
        response.writeHead(404).end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

/** The renderer's working set, in MB, as Electron's own process metrics report it. */
function rendererRssMb(pid) {
  const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
  return metric === undefined ? null : Math.round(metric.memory.workingSetSize / 1024);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// --expose-gc so the page can collect before a sample: an RSS reading taken
// before the previous step's garbage is gone is a reading about the garbage.
app.commandLine.appendSwitch("js-flags", "--expose-gc");

app.whenReady().then(async () => {
  const server = await serve();
  const { port } = server.address();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { backgroundThrottling: false, sandbox: true },
  });
  const contents = window.webContents;
  const errors = [];
  contents.on("console-message", (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });

  const run = async (expression) => contents.executeJavaScript(expression, true);

  /**
   * One step's numbers. RSS is the MEDIAN of three readings a third of a second
   * apart, because a single one is worth ±30MB: the working set moves while
   * Chromium finishes rasterizing, trims caches and answers the collect() above.
   * DOM node count needs none of that — it is exact.
   */
  const sample = async (step) => {
    await run("window.chatBench.collect()");
    await sleep(600);
    const readings = [];
    for (let index = 0; index < 3; index += 1) {
      readings.push(rendererRssMb(contents.getOSProcessId()));
      await sleep(320);
    }
    readings.sort((a, b) => a - b);
    return {
      step,
      nodes: await run("window.chatBench.nodes()"),
      rendererRssMb: readings[1],
      rssSpreadMb: readings[2] - readings[0],
      jsHeapMb: Math.round((await run("performance.memory?.usedJSHeapSize ?? 0")) / 1_048_576),
    };
  };

  const report = {
    label: LABEL,
    sessions: SESSIONS,
    turns: TURNS,
    steps: [],
    checks: {},
    streamingSamples: [],
    errors,
  };
  /** The VC-338 steps: mount, scroll, stream, and many planes at once. */
  async function transcriptArm() {
    // Every Session's transcript is in the store and no plane is drawn: the
    // floor every later step is measured against.
    report.steps.push(await sample("seeded, no plane"));

    await run("window.chatBench.show(1)");
    report.steps.push(await sample("1 plane"));

    report.checks.firstTurn = await run("window.chatBench.reachFirst(0, 200)");
    report.checks.tail = await run("window.chatBench.tailProbe(0)");
    // Back to a fresh mount of the same plane so the scroll probes above cannot
    // leave revealed pages in the steps that follow.
    await run("window.chatBench.show(0)");
    await run(`window.chatBench.show(1)`);
    report.steps.push(await sample("1 plane, after scrolling"));

    // VC-353's simultaneous stream+scroll interaction. Repeated inside one
    // production renderer so p50/p95 and variance describe the interaction,
    // not Electron process startup.
    for (let index = 0; index < STREAM_SAMPLES; index += 1) {
      const streamingSample = await run(
        `window.chatBench.streamAndScroll(0, ${STREAM_STEPS}, ${STREAM_TOKEN_RATE})`,
      );
      report.streamingSamples.push({
        ...streamingSample,
        rendererRssMb: rendererRssMb(contents.getOSProcessId()),
      });
    }

    await run(`window.chatBench.show(${SESSIONS})`);
    report.steps.push(await sample(`${SESSIONS} planes`));

    await run("window.chatBench.show(1)");
    report.steps.push(await sample("back to 1 plane"));
  }

  /**
   * Type into an empty Draft beside `DRAFT_PLANES` long transcripts and a
   * `DRAFT_BALLAST`-node stand-in for the sidebar and board, through Chromium's
   * trusted input path. Lower-case letters with a space every sixth key, at a
   * fixed cadence a fast typist reaches; the renderer probe does the timing.
   */
  async function draftArm() {
    const shown = await run(`window.chatBench.showDraft(${DRAFT_PLANES}, ${DRAFT_BALLAST})`);
    report.steps.push({ step: "draft shown", nodes: shown.nodes });
    window.focus();
    contents.focus();
    if (DRAFT_CPU_THROTTLE > 1) {
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
        rate: DRAFT_CPU_THROTTLE,
      });
      await sleep(500);
    }
    if (!(await run("window.chatBench.startTyping()"))) throw new Error("no draft textarea");
    if (DRAFT_TRACE !== null) {
      await contentTracing.startRecording({
        included_categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.invalidationTracking",
        ],
      });
    }
    for (let index = 0; index < DRAFT_KEYS; index += 1) {
      const key = index % 6 === 5 ? " " : String.fromCharCode(97 + (index % 26));
      const keyCode = key === " " ? "Space" : key;
      contents.sendInputEvent({ type: "keyDown", keyCode });
      contents.sendInputEvent({ type: "char", keyCode: key });
      contents.sendInputEvent({ type: "keyUp", keyCode });
      await sleep(DRAFT_KEY_INTERVAL_MS);
    }
    report.draftTyping = await run("window.chatBench.stopTyping()");
    if (DRAFT_TRACE !== null) report.draftTrace = await contentTracing.stopRecording(DRAFT_TRACE);
  }

  /**
   * Press the cell's "Next chat" button through Chromium's trusted input path,
   * `REVEAL_SWITCHES` times, each press revealing a kept chat that was drawn
   * before. Before the timed presses: every plane is shown once (a kept view
   * is one the reader has seen), and the reader of the first plane scrolls up,
   * so the check after the run can prove a revealed view still lands where its
   * reader left it rather than at the bottom.
   */
  async function revealArm() {
    const shown = await run(`window.chatBench.showReveal(${REVEAL_PLANES}, ${REVEAL_BALLAST})`);
    report.steps.push({ step: "reveal cell shown", nodes: shown.nodes });
    window.focus();
    contents.focus();
    const rect = await run(
      "(() => { const r = document.querySelector('[data-bench-switch]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
    );
    const press = async () => {
      contents.sendInputEvent({
        type: "mouseDown",
        x: rect.x,
        y: rect.y,
        button: "left",
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: "mouseUp",
        x: rect.x,
        y: rect.y,
        button: "left",
        clickCount: 1,
      });
      await sleep(REVEAL_INTERVAL_MS);
    };
    // Every plane drawn once, then back to the first.
    for (let index = 0; index < REVEAL_PLANES; index += 1) await press();
    const pinned = await run("window.chatBench.revealState()");
    // A real wheel, not a `scrollTop` write: the bottom lock only lets go for
    // a reader's own gesture, and only a reader's position is restored.
    for (let index = 0; index < 15; index += 1) {
      contents.sendInputEvent({ type: "mouseWheel", x: rect.x, y: 450, deltaX: 0, deltaY: 100 });
      await sleep(16);
    }
    await sleep(REVEAL_INTERVAL_MS);
    const scrolled = await run("window.chatBench.revealState()");
    for (let index = 0; index < REVEAL_PLANES; index += 1) await press();
    report.checks.revealRestore = {
      pinnedBefore: pinned,
      scrolledBefore: scrolled,
      afterRoundTrip: await run("window.chatBench.revealState()"),
    };
    // Back to the bottom so every timed reveal is the pinned common case.
    for (let index = 0; index < 60; index += 1) {
      contents.sendInputEvent({ type: "mouseWheel", x: rect.x, y: 450, deltaX: 0, deltaY: -200 });
      await sleep(16);
    }
    await sleep(REVEAL_INTERVAL_MS);
    if (REVEAL_CPU_THROTTLE > 1) {
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
        rate: REVEAL_CPU_THROTTLE,
      });
      await sleep(500);
    }
    if (!(await run("window.chatBench.startReveal()"))) throw new Error("no reveal switch");
    if (REVEAL_TRACE !== null) {
      await contentTracing.startRecording({
        included_categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"],
      });
    }
    for (let index = 0; index < REVEAL_SWITCHES; index += 1) await press();
    report.revealSwitch = await run("window.chatBench.stopReveal()");
    if (REVEAL_TRACE !== null)
      report.revealTrace = await contentTracing.stopRecording(REVEAL_TRACE);
    report.checks.revealPinned = await run("window.chatBench.revealState()");
  }

  try {
    await contents.loadURL(`http://127.0.0.1:${port}/index.html`);
    await run("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    // The first seconds of a renderer's life are its noisiest: fonts, the first
    // compositor frame, the module graph's own allocations. Let them finish
    // before anything is called a baseline.
    await sleep(2500);

    report.steps.push(await sample("empty"));
    await run(`window.chatBench.seed(${SESSIONS}, ${TURNS})`);
    if (ARM === "draft") await draftArm();
    else if (ARM === "reveal") await revealArm();
    else await transcriptArm();
  } catch (error) {
    report.failure = String(error && error.stack ? error.stack : error);
  }

  // Console text alone names the error and not its origin. The harness fails a
  // run on any renderer error, so carry the stacks out with the report.
  try {
    report.errorDetails = await run("window.chatBench.uncaught()");
  } catch {
    report.errorDetails = [];
  }

  process.stdout.write(`\n__BENCH__${JSON.stringify(report)}__BENCH__\n`);
  server.close();
  app.exit(report.failure === undefined ? 0 : 1);
});
