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
const { app, BrowserWindow } = require("electron");
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

  const report = { label: LABEL, sessions: SESSIONS, turns: TURNS, steps: [], checks: {}, errors };
  try {
    await contents.loadURL(`http://127.0.0.1:${port}/index.html`);
    await run("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    // The first seconds of a renderer's life are its noisiest: fonts, the first
    // compositor frame, the module graph's own allocations. Let them finish
    // before anything is called a baseline.
    await sleep(2500);

    report.steps.push(await sample("empty"));
    await run(`window.chatBench.seed(${SESSIONS}, ${TURNS})`);
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

    await run(`window.chatBench.show(${SESSIONS})`);
    report.steps.push(await sample(`${SESSIONS} planes`));

    await run("window.chatBench.show(1)");
    report.steps.push(await sample("back to 1 plane"));
  } catch (error) {
    report.failure = String(error && error.stack ? error.stack : error);
  }

  process.stdout.write(`\n__BENCH__${JSON.stringify(report)}__BENCH__\n`);
  server.close();
  app.exit(report.failure === undefined ? 0 : 1);
});
