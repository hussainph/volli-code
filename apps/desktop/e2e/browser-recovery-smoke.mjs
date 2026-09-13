/**
 * VC-351 fault-injection acceptance test against the built production Browser
 * port. Real Chromium, local fixture, isolated HOME/profile; no model turn or
 * default browser. Run after pnpm build and pnpm ensure:electron:
 *   node apps/desktop/e2e/browser-recovery-smoke.mjs
 *
 * Automatic preview failures are injected at capturePage (not at the port),
 * so the same boundary used by Sessions must contain rejection/hang/abort.
 * Also repeats real keyboard, pointer and screenshot work across native view
 * states. Every failed assertion is reported; cleanup is bounded.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  assertProfileIsolated,
  closeAppBounded,
  evidenceDir,
  launch,
  makeScratch,
} from "./lib/smoke-kit.mjs";

const scratchRun = await makeScratch("volli-browser-recovery-");
const { scratch, userDataDir, dbPath } = scratchRun;
const home = join(scratch, "home");
await fs.mkdir(home, { recursive: true });
const server = http.createServer((_request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Recovery fixture</title>
    <h1>Recovery fixture</h1><button id="go">Count 0</button>
    <form><input aria-label="Text"><button>Submit</button></form>
    <select aria-label="Choice"><option value="one">One</option><option value="two">Two</option></select>
    <script>
      let count = 0;
      document.querySelector('select').onchange = e => { document.title = 'Choice:' + e.target.value; };
      document.querySelector('input').onkeydown = e => { if (e.shiftKey) console.log('shift-key:' + e.key); };
      document.querySelector('#go').onclick = e => e.target.textContent = 'Count ' + ++count;
      document.querySelector('form').onsubmit = e => {
        e.preventDefault(); document.title = 'Text:' + document.querySelector('input').value;
      };
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
let app;
let outcomes = [];
let success = false;
let failureEvidence;
let interrupted = false;

async function saveFailureEvidence(screenshot = true) {
  failureEvidence ??= await evidenceDir("browser-recovery");
  await fs.mkdir(failureEvidence, { recursive: true });
  await fs.writeFile(join(failureEvidence, "results.json"), JSON.stringify(outcomes, null, 2));
  if (screenshot && app) {
    await (
      await app.firstWindow()
    )
      .screenshot({ path: join(failureEvidence, "failure.png") })
      .catch(() => undefined);
  }
  console.error(`Evidence: ${failureEvidence}`);
}

async function closeFixture() {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function interrupt() {
  if (interrupted) return;
  interrupted = true;
  try {
    await saveFailureEvidence(false).catch((error) =>
      console.error("Could not save recovery smoke evidence:", error),
    );
    if (app) await closeAppBounded(app);
  } finally {
    await closeFixture();
    await scratchRun.cleanup();
    process.exit(1);
  }
}
const onInterrupt = () => void interrupt();
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);

try {
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: home,
      VOLLI_BROWSER_PROBE: "1",
      VOLLI_SMOKE_BROWSER_HOST: "1",
    },
  });
  await assertProfileIsolated(app, userDataDir);
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  outcomes = await app.evaluate(async ({ BrowserWindow, nativeImage }, url) => {
    const host = globalThis.volliBrowserHost;
    const port = globalThis.volliBrowserProbe.port(
      { projectId: "recovery", ticketId: null },
      "recovery-session",
    );
    const signal = new AbortController().signal;
    const results = [];
    const check = async (label, run) => {
      const start = Date.now();
      try {
        await run();
        results.push({ label, ok: true, ms: Date.now() - start });
      } catch (error) {
        results.push({
          label,
          ok: false,
          error: String(error?.message ?? error),
          ms: Date.now() - start,
        });
      }
    };
    // This callback is serialized into Electron; it cannot capture outer helpers.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const must = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const first = await port.navigate({ navigation: { kind: "url", url }, signal });
    const tabId = first.tabId;
    const contents = host.webContentsOf(tabId);
    const originalCapture = contents.capturePage.bind(contents);
    const window = BrowserWindow.getAllWindows()[0];
    const snapshot = () => port.snapshot({ tabId, signal });
    const act = async (kind, name, extra = {}) => {
      const snap = await snapshot();
      const line =
        name === null
          ? null
          : snap.snapshotText.split("\n").find((candidate) => candidate.includes(`"${name}"`));
      const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
      if (name !== null) must(ref !== undefined, `Missing ref for ${name}: ${snap.snapshotText}`);
      return port.act({
        tabId,
        generation: snap.generation,
        kind,
        ...(ref ? { ref } : {}),
        ...extra,
        signal,
      });
    };
    try {
      for (const state of ["headless", "shown", "hidden-again", "minimized", "window-hidden"]) {
        await check(`${state}: input replacement, select, click, pixels`, async () => {
          if (state === "shown") {
            host.setPresentation(tabId, "preview");
            host.show(tabId);
          }
          if (state === "hidden-again") host.setPresentation(tabId, "headless");
          if (state === "minimized") {
            window.show();
            host.setPresentation(tabId, "preview");
            host.show(tabId);
            window.minimize();
          }
          if (state === "window-hidden") {
            window.restore();
            host.setPresentation(tabId, "preview");
            host.show(tabId);
            window.hide();
          }
          await port.navigate({ tabId, navigation: { kind: "url", url }, signal });
          for (const key of ["Control+a", "Meta+a"]) {
            await act("type", "Text", { text: "old text" });
            await act("press", null, { key });
            await act("type", "Text", { text: key });
            const submitted = await act("press", null, { key: "Enter" });
            must(
              submitted.title === `Text:${key}`,
              `${key} did not replace input: ${submitted.title}`,
            );
          }
          await act("press", null, { key: "Control+a" });
          await act("press", null, { key: "Shift+a" });
          const shifted = await act("press", null, { key: "Enter" });
          await act("press", null, { key: "Control+a" });
          await act("press", null, { key: "Shift+1" });
          const shiftedSymbol = await act("press", null, { key: "Enter" });
          const record = await port.console({ tabId, signal });
          must(
            shifted.title === "Text:A" &&
              shiftedSymbol.title === "Text:!" &&
              record.messages.some((message) => message.text === "shift-key:A") &&
              record.messages.some((message) => message.text === "shift-key:!"),
            "Shifted key events and inserted text disagree",
          );
          const selected = await act("select", "Choice", { text: "two" });
          must(selected.title === "Choice:two", `Select did not change value: ${selected.title}`);
          const clicked = await act("click", "Count 0");
          must(clicked.snapshotText.includes('"Count 1"'), "Click did not reach page");
          const shot = await port.screenshot({ tabId, signal });
          const image = nativeImage.createFromBuffer(Buffer.from(shot.base64Png, "base64"));
          const size = image.getSize();
          must(
            !image.isEmpty() && shot.width === size.width && shot.height === size.height,
            `Screenshot dimensions disagree: ${shot.width}x${shot.height} vs ${JSON.stringify(size)}`,
          );
          must(host.pictureOf(shot.picture)?.length > 100, "Screenshot was not kept");
        });
      }
      window.show();
      // Use a fresh never-driven tab for preview fault injection. The main
      // matrix intentionally leaves recent person-interaction stamps behind,
      // and privacy must decline captures during that quiet window.
      const faultFirst = await port.navigate({ navigation: { kind: "url", url }, signal });
      const faultTabId = faultFirst.tabId;
      const faultContents = host.webContentsOf(faultTabId);
      const faultOriginalCapture = faultContents.capturePage.bind(faultContents);
      const faultAct = async (kind, name, extra = {}) => {
        const snap = await port.snapshot({ tabId: faultTabId, signal });
        const line = snap.snapshotText
          .split("\n")
          .find((candidate) => candidate.includes(`"${name}"`));
        const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
        must(ref !== undefined, `Missing ref for ${name}: ${snap.snapshotText}`);
        return port.act({
          tabId: faultTabId,
          generation: snap.generation,
          kind,
          ref,
          ...extra,
          signal,
        });
      };
      await check("rejected preview does not erase navigation or click", async () => {
        faultContents.capturePage = () => Promise.reject(new Error("UnknownVizError (injected)"));
        try {
          const nav = await port.navigate({
            tabId: faultTabId,
            navigation: { kind: "url", url },
            signal,
          });
          must(
            nav.picture === null && nav.snapshotText.includes('"Count 0"'),
            "Navigation lost its result",
          );
          const clicked = await faultAct("click", "Count 0");
          must(
            clicked.picture === null && clicked.snapshotText.includes('"Count 1"'),
            "Click lost its result",
          );
        } finally {
          faultContents.capturePage = faultOriginalCapture;
        }
      });
      await check("stuck preview is bounded; next navigation recovers", async () => {
        faultContents.capturePage = () => new Promise(() => {});
        try {
          const start = Date.now();
          const nav = await port.navigate({
            tabId: faultTabId,
            navigation: { kind: "url", url },
            signal,
          });
          must(nav.picture === null && Date.now() - start < 5000, "Preview wedged navigation");
        } finally {
          faultContents.capturePage = faultOriginalCapture;
        }
        const nav = await port.navigate({
          tabId: faultTabId,
          navigation: { kind: "url", url },
          signal,
        });
        must(nav.picture !== null, "Preview did not recover");
      });
      await check("withdrawal during preview cancels promptly", async () => {
        const abort = new AbortController();
        faultContents.capturePage = () => {
          abort.abort(new Error("withdrawn during preview"));
          return faultOriginalCapture();
        };
        try {
          const start = Date.now();
          let error;
          try {
            await port.navigate({
              tabId: faultTabId,
              navigation: { kind: "url", url },
              signal: abort.signal,
            });
          } catch (caught) {
            error = caught;
          }
          must(
            error?.message === "withdrawn during preview" && Date.now() - start < 5000,
            "Cancellation lost",
          );
        } finally {
          faultContents.capturePage = faultOriginalCapture;
        }
      });
      await check("concurrent same-tab snapshots have distinct refs", async () => {
        const snapshots = await Promise.all(Array.from({ length: 12 }, snapshot));
        const refs = snapshots.map((snap) => snap.snapshotText.match(/\[ref=(e\d+)\]/)?.[1]);
        must(new Set(refs).size === 12 && refs.every(Boolean), "Concurrent snapshots reused refs");
      });
      await check("explicit screenshot errors remain failures", async () => {
        const send = contents.debugger.sendCommand.bind(contents.debugger);
        contents.debugger.sendCommand = (method, params) =>
          method === "Page.captureScreenshot"
            ? Promise.reject(new Error("explicit screenshot failed (injected)"))
            : send(method, params);
        try {
          let error;
          try {
            await port.screenshot({ tabId, signal });
          } catch (caught) {
            error = caught;
          }
          must(
            error?.message.includes("explicit screenshot failed"),
            "Explicit screenshot failure was hidden",
          );
        } finally {
          contents.debugger.sendCommand = send;
        }
      });
    } finally {
      contents.capturePage = originalCapture;
      port.dispose();
      host.closeAll();
    }
    return results;
  }, fixtureUrl);
  for (const result of outcomes)
    console.log(
      `${result.ok ? "PASS" : "FAIL"} ${result.label} (${result.ms}ms)${result.error ? `: ${result.error}` : ""}`,
    );
  assert(
    outcomes.every((result) => result.ok),
    "Browser recovery checks failed",
  );
  success = true;
} finally {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
  if (!success) {
    await saveFailureEvidence().catch((error) =>
      console.error("Could not save recovery smoke evidence:", error),
    );
  }
  if (app) await closeAppBounded(app);
  await closeFixture();
  await scratchRun.cleanup();
  process.exitCode = success ? 0 : 1;
}
