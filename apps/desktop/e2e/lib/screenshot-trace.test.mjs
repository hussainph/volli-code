import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO } from "./smoke-kit.mjs";
import {
  collectMainDiagnostics,
  collectPageDiagnostics,
  screenshotWithTrace,
} from "./screenshot-trace.mjs";

const SENTINEL = new Error("page.screenshot: Timeout 5000ms exceeded");
const OPTIONS = { path: "evidence.png", timeout: 5000 };

/** Tracked child 100 with a renderer (101) and a GPU helper (102) below it. */
const PS_OUTPUT = [
  "    1     0  0.0  Ss   /sbin/launchd",
  "  100     1  0.4  Ss   /Applications/Electron.app/Contents/MacOS/Electron",
  "  101   100 12.5  S    /Applications/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)",
  "  102   101  3.0  S    /Applications/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)",
  // Same "Electron" name, unrelated tree: a global name match would grab this.
  "  900     1  9.9  R    /Applications/OtherElectron.app/Contents/MacOS/Electron",
].join("\n");

const ELECTRON_STUB = {
  app: {
    getAppMetrics: () => [
      { pid: 100, type: "browser", cpu: { percentCPUUsage: 1.5 } },
      { pid: 101, type: "Renderer", name: "Volli", cpu: { percentCPUUsage: 40.2 } },
    ],
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        id: 1,
        isDestroyed: () => false,
        isVisible: () => true,
        isMinimized: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
      },
      { id: 2, isDestroyed: () => true },
    ],
  },
  webContents: {
    getAllWebContents: () => [
      {
        id: 101,
        isDestroyed: () => false,
        getType: () => "window",
        isLoading: () => false,
        isCrashed: () => false,
        getURL: () => "file:///build/index.html",
      },
      {
        id: 102,
        isDestroyed: () => false,
        getType: () => "webview",
        isLoading: () => true,
        isCrashed: () => true,
        getURL: () => "about:blank",
      },
      {
        id: 103,
        isDestroyed: () => false,
        getType: () => {
          throw new Error("host object gone");
        },
      },
    ],
  },
};

function unexpected(label) {
  return () => {
    throw new Error(`unexpected ${label}`);
  };
}

/** A database-recovery-shaped run whose page always rejects with SENTINEL. */
function failingRun({
  pageEvaluate = unexpected("page probe"),
  mainEvaluate = unexpected("main probe"),
} = {}) {
  const screenshotOptions = [];
  return {
    screenshotOptions,
    run: {
      app: { evaluate: mainEvaluate },
      child: { pid: 100 },
      page: {
        screenshot: async (options) => {
          screenshotOptions.push(options);
          throw SENTINEL;
        },
        evaluate: pageEvaluate,
      },
    },
  };
}

function stubRendererGlobals(t, { fireRaf = true } = {}) {
  const previousDocument = globalThis.document;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    readyState: "complete",
    visibilityState: "visible",
    fonts: { status: "loaded" },
    title: "Volli",
    querySelectorAll: () => [
      { textContent: " Board " },
      { textContent: "" },
      { textContent: "Sessions" },
    ],
    body: { innerText: "  Board\n\nSessions  " },
  };
  globalThis.requestAnimationFrame = fireRaf ? (callback) => callback() : () => {};
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  });
}

async function scratchTrace(t) {
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "screenshot-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  return join(scratch, "trace.jsonl");
}

async function readEntries(path) {
  return (await fs.readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function assertExactRejection(error) {
  assert.equal(error, SENTINEL);
  assert.equal(error.message, "page.screenshot: Timeout 5000ms exceeded");
  return true;
}

test("the renderer probe answers with live page state and a fired frame pump", async (t) => {
  stubRendererGlobals(t);
  const probe = await collectPageDiagnostics();
  assert.deepEqual(probe, {
    readyState: "complete",
    visibilityState: "visible",
    fontsStatus: "loaded",
    title: "Volli",
    headings: ["Board", "Sessions"],
    bodyText: "Board Sessions",
    rafFired: true,
    rafElapsedMs: probe.rafElapsedMs,
    rafBudgetMs: 1000,
  });
  assert.ok(Number.isInteger(probe.rafElapsedMs));
});

test("the renderer probe distinguishes a stalled frame pump from dead page JS", async (t) => {
  stubRendererGlobals(t, { fireRaf: false });
  // Only the page probe's own budget timer runs here, so a fire-now stub keeps
  // the test off the real 1s wait; no screenshot deadline exists on this path.
  t.mock.method(globalThis, "setTimeout", (callback) => callback());
  const probe = await collectPageDiagnostics();
  assert.equal(probe.rafFired, false);
  assert.equal(probe.rafElapsedMs, null);
  assert.ok(probe.bodyText.length > 0);
});

test("the main probe maps metrics, windows and contents, guarding destroyed hosts", () => {
  const probe = collectMainDiagnostics(ELECTRON_STUB);
  assert.equal(probe.pid, process.pid);
  assert.deepEqual(probe.metrics, [
    { pid: 100, type: "browser", name: null, cpuPercent: 1.5 },
    { pid: 101, type: "Renderer", name: "Volli", cpuPercent: 40.2 },
  ]);
  assert.deepEqual(probe.windows, [
    {
      id: 1,
      destroyed: false,
      visible: true,
      minimized: false,
      bounds: { x: 0, y: 0, width: 1280, height: 800 },
    },
    { id: 2, destroyed: true, visible: null, minimized: null, bounds: null },
  ]);
  assert.deepEqual(probe.contents, [
    {
      id: 101,
      type: "window",
      destroyed: false,
      loading: false,
      crashed: false,
      url: "file:///build/index.html",
    },
    {
      id: 102,
      type: "webview",
      destroyed: false,
      loading: true,
      crashed: true,
      url: "about:blank",
    },
    { id: 103, probeError: "host object gone" },
  ]);
});

test("a successful screenshot runs no probes and writes no trace, even with a path", async (t) => {
  t.mock.method(console, "error", () => {});
  const tracePath = await scratchTrace(t);
  const options = { timeout: 1234 };
  const screenshotOptions = [];
  let diagnosticCalls = 0;
  const count = () => {
    diagnosticCalls += 1;
  };
  const result = await screenshotWithTrace(
    {
      app: { evaluate: count },
      child: { pid: 100 },
      page: {
        screenshot: async (passed) => {
          screenshotOptions.push(passed);
          return "png-bytes";
        },
        evaluate: count,
      },
    },
    options,
    tracePath,
    { runPs: count, runSample: count },
  );
  assert.equal(result, "png-bytes");
  assert.deepEqual(screenshotOptions, [options]);
  assert.equal(diagnosticCalls, 0);
  assert.equal(console.error.mock.callCount(), 0);
  await assert.rejects(fs.access(tracePath), /ENOENT/);
});

test("a failed screenshot with no trace path rethrows the exact error and probes nothing", async (t) => {
  t.mock.method(console, "error", () => {});
  const { run } = failingRun();
  run.child = { pid: 100 };
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, null, {
      runPs: unexpected("ps"),
      runSample: unexpected("sample"),
    }),
    (error) => assertExactRejection(error),
  );
});

test("a failed screenshot records live probes, the tracked tree and the exact rejection", async (t) => {
  stubRendererGlobals(t);
  const tracePath = await scratchTrace(t);
  const { run, screenshotOptions } = failingRun({
    // Playwright would serialize collectPageDiagnostics into the renderer; the
    // fake runs the real collector here against stubbed globals.
    pageEvaluate: (fn) => fn(),
    mainEvaluate: (fn) => fn(ELECTRON_STUB),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, { runPs: async () => ({ stdout: PS_OUTPUT }) }),
    (error) => assertExactRejection(error),
  );
  assert.deepEqual(screenshotOptions, [OPTIONS]);
  const entries = await readEntries(tracePath);
  assert.equal(entries[0].stage, "screenshot-failed");
  assert.equal(entries[0].error, SENTINEL.message);
  assert.deepEqual(entries[0].options, OPTIONS);

  const page = entries.find(({ stage }) => stage === "screenshot-page-probe");
  assert.equal(page.rafFired, true);
  assert.equal(page.readyState, "complete");
  assert.equal(page.fontsStatus, "loaded");
  assert.deepEqual(page.headings, ["Board", "Sessions"]);
  assert.equal(page.bodyText, "Board Sessions");

  const main = entries.find(({ stage }) => stage === "screenshot-main-probe");
  assert.equal(main.pid, process.pid);
  assert.equal(main.windows[0].visible, true);
  assert.equal(main.contents[1].crashed, true);
  assert.equal(main.contents[2].probeError, "host object gone");

  const snapshot = entries.find(({ stage }) => stage === "screenshot-process-snapshot");
  assert.equal(snapshot.root.pid, 100);
  assert.equal(snapshot.root.ppid, 1);
  assert.equal(snapshot.root.cpuPercent, 0.4);
  assert.equal(snapshot.root.stat, "Ss");
  assert.match(snapshot.root.command, /Electron$/);
  assert.deepEqual(
    snapshot.descendants.map(({ pid }) => pid),
    [101, 102],
  );
  assert.ok(snapshot.descendants.every(({ command }) => !command.includes("OtherElectron")));

  assert.ok(entries.every(({ stage }) => !stage.includes("sample")));
});

test("a hanging page probe hits its deadline without delaying or masking the rejection", async (t) => {
  stubRendererGlobals(t);
  const tracePath = await scratchTrace(t);
  const { run } = failingRun({
    pageEvaluate: () => new Promise(() => {}),
    mainEvaluate: (fn) => fn(ELECTRON_STUB),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      pageProbeTimeoutMs: 10,
      runPs: async () => ({ stdout: PS_OUTPUT }),
    }),
    (error) => assertExactRejection(error),
  );
  const entries = await readEntries(tracePath);
  const pageFailure = entries.find(({ stage }) => stage === "screenshot-page-probe-failed");
  assert.match(pageFailure.error, /screenshot page probe deadline expired/);
  assert.ok(entries.some(({ stage }) => stage === "screenshot-main-probe"));
  assert.ok(entries.some(({ stage }) => stage === "screenshot-process-snapshot"));
});

test("rejecting probes are recorded and the exact rejection still surfaces", async (t) => {
  t.mock.method(console, "error", () => {});
  const tracePath = await scratchTrace(t);
  const { run } = failingRun({
    pageEvaluate: async () => {
      throw new Error("page probe refused");
    },
    mainEvaluate: async () => {
      throw new Error("main probe refused");
    },
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      runPs: async () => {
        throw new Error("process inspection failed");
      },
    }),
    (error) => assertExactRejection(error),
  );
  const entries = await readEntries(tracePath);
  assert.deepEqual(
    entries
      .filter(({ stage }) => stage.endsWith("-probe-failed") || stage.endsWith("snapshot-failed"))
      .map(({ error }) => error),
    ["page probe refused", "main probe refused", "process inspection failed"],
  );
});

test("an explicit sample flag samples exactly the tracked main and descendants on darwin", async (t) => {
  const tracePath = await scratchTrace(t);
  const samples = [];
  const { run } = failingRun({
    pageEvaluate: async () => ({ rafFired: true }),
    mainEvaluate: async () => ({ pid: 1 }),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      sample: true,
      platform: "darwin",
      runPs: async () => ({ stdout: PS_OUTPUT }),
      runSample: async (file, args, commandOptions) => {
        samples.push({ file, args, commandOptions });
      },
    }),
    (error) => assertExactRejection(error),
  );
  assert.deepEqual(
    samples.map(({ args }) => Number(args[0])),
    [100, 101, 102],
  );
  for (const { args, commandOptions, file } of samples) {
    const pid = Number(args[0]);
    assert.equal(file, "/usr/bin/sample");
    assert.deepEqual(args.slice(1), ["2", "-file", `${tracePath}.${pid}.sample.txt`]);
    assert.equal(commandOptions.timeout, 60000);
  }
});

test("sampling command failures are logged per pid and never mask the rejection", async (t) => {
  const tracePath = await scratchTrace(t);
  const { run } = failingRun({
    pageEvaluate: async () => ({ rafFired: true }),
    mainEvaluate: async () => ({ pid: 1 }),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      sample: true,
      platform: "darwin",
      runPs: async () => ({ stdout: PS_OUTPUT }),
      runSample: async () => {
        throw new Error("sample refused");
      },
    }),
    (error) => assertExactRejection(error),
  );
  const entries = await readEntries(tracePath);
  assert.deepEqual(
    entries.filter(({ stage }) => stage === "sample-failed").map(({ sampledPid }) => sampledPid),
    [100, 101, 102],
  );
  assert.ok(
    entries
      .filter(({ stage }) => stage === "sample-failed")
      .every(({ error }) => error === "sample refused"),
  );
});

test("sampling is skipped off darwin and never masks the rejection", async (t) => {
  const tracePath = await scratchTrace(t);
  const { run } = failingRun({
    pageEvaluate: async () => ({ rafFired: true }),
    mainEvaluate: async () => ({ pid: 1 }),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      sample: true,
      platform: "linux",
      runPs: async () => ({ stdout: PS_OUTPUT }),
      runSample: unexpected("sample"),
    }),
    (error) => assertExactRejection(error),
  );
  const entries = await readEntries(tracePath);
  const skipped = entries.find(({ stage }) => stage === "screenshot-sample-skipped");
  assert.equal(skipped.platform, "linux");
});

test("a missing tracked child pid records the snapshot failure and samples nothing", async (t) => {
  const tracePath = await scratchTrace(t);
  const run = failingRun({ pageEvaluate: async () => ({}), mainEvaluate: async () => ({}) }).run;
  delete run.child;
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, {
      sample: true,
      platform: "darwin",
      runPs: unexpected("ps"),
      runSample: unexpected("sample"),
    }),
    (error) => assertExactRejection(error),
  );
  const entries = await readEntries(tracePath);
  assert.equal(
    entries.find(({ stage }) => stage === "screenshot-process-snapshot-failed").error,
    "tracked child pid unavailable",
  );
  assert.equal(
    entries.find(({ stage }) => stage === "sample-failed").error,
    "tracked process snapshot unavailable",
  );
});

test("a failing trace write is swallowed and the exact rejection still surfaces", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  await fs.mkdir(join(REPO, ".tmp"), { recursive: true });
  const scratch = await fs.mkdtemp(join(REPO, ".tmp", "screenshot-trace-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const tracePath = join(scratch, "missing", "trace.jsonl");
  const { run } = failingRun({
    pageEvaluate: async () => ({ rafFired: true }),
    mainEvaluate: async () => ({ pid: 1 }),
  });
  await assert.rejects(
    screenshotWithTrace(run, OPTIONS, tracePath, { runPs: async () => ({ stdout: PS_OUTPUT }) }),
    (error) => assertExactRejection(error),
  );
  assert.equal(errors.length, 4);
  assert.ok(errors.every((message) => message.includes("Shutdown diagnostic unavailable")));
});
