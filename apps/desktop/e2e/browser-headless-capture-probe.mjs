/**
 * Manual VC-278 diagnostic: prove that a never-parented WebContentsView has no
 * screenshot surface, and that a never-shown BaseWindow supplies one.
 *
 * This is one compact evidence probe, not an automated product test. The built
 * app acceptance path lives in `browser-headless-capture-smoke.mjs`.
 *
 * Run (needs a display and takes about 35 seconds):
 *   apps/desktop/node_modules/.bin/electron apps/desktop/e2e/browser-headless-capture-probe.mjs
 */
import { createServer } from "node:http";

import { app, BaseWindow, BrowserWindow, WebContentsView, nativeImage } from "electron";

const BOUND_MS = 15_000;
const VIEWPORT = { x: 0, y: 0, width: 660, height: 251 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LIGHT = `<!doctype html><meta charset="utf-8"><title>light</title>
<body style="margin:0;background:#123;color:#eee"><h1>light page</h1>`;
const HEAVY = `<!doctype html><meta charset="utf-8"><title>heavy</title>
<body style="margin:0;background:#312;color:#eee"><h1>heavy page</h1><main id="rows"></main>
<script type="module">
  const text = await fetch("/chunk").then((response) => response.text());
  const root = document.getElementById("rows");
  for (let index = 0; index < 500; index += 1) {
    const row = document.createElement("div");
    row.style.background = index % 2 ? "#075985" : "#6d28d9";
    row.textContent = text + " " + index;
    root.appendChild(row);
  }
</script>`;

async function startServer() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/chunk") {
      await sleep(1_200);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("compiled row");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(path === "/heavy" ? HEAVY : LIGHT);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeTab() {
  const view = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  view.setBounds(VIEWPORT);
  view.webContents.setBackgroundThrottling(false);
  return view;
}

function frameOf(base64Png) {
  const image = nativeImage.createFromBuffer(Buffer.from(base64Png, "base64"));
  const size = image.getSize();
  const colours = new Set();
  const bitmap = image.toBitmap();
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4 * 193) {
    colours.add(`${bitmap[offset]},${bitmap[offset + 1]},${bitmap[offset + 2]}`);
    if (colours.size > 32) break;
  }
  return { width: size.width, height: size.height, colours: colours.size };
}

async function cdpScreenshot(view) {
  const wire = view.webContents.debugger;
  const startedAt = Date.now();
  try {
    if (!wire.isAttached()) wire.attach("1.3");
    await wire.sendCommand("Page.enable");
    const result = await Promise.race([
      wire.sendCommand("Page.captureScreenshot", { format: "png" }),
      sleep(BOUND_MS).then(() => null),
    ]);
    if (result === null) return { kind: "timeout", ms: Date.now() - startedAt };
    const frame = frameOf(result.data ?? "");
    return {
      kind: frame.width > 0 && frame.height > 0 ? "captured" : "empty",
      ms: Date.now() - startedAt,
      frame,
    };
  } catch (error) {
    return { kind: "failed", ms: Date.now() - startedAt, error: String(error?.message ?? error) };
  }
}

async function electronScreenshot(view) {
  const image = await view.webContents.capturePage();
  const size = image.getSize();
  return image.isEmpty() || size.width === 0 || size.height === 0
    ? { kind: "empty", frame: size }
    : { kind: "captured", frame: size };
}

function closeView(parent, view) {
  parent?.contentView.removeChildView(view);
  view.webContents.close({ waitForBeforeUnload: false });
}

app.whenReady().then(async () => {
  const fixture = await startServer();
  const visibleWindow = new BrowserWindow({ width: 900, height: 600, show: true });
  await visibleWindow.webContents.loadURL(`${fixture.base}/`);
  const rows = [];
  let failures = 0;

  const check = async (label, expected, run) => {
    const result = await run();
    const ok = expected(result);
    rows.push({ label, ok, result });
    if (!ok) failures += 1;
    console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}: ${JSON.stringify(result)}`);
  };

  await check(
    "never-parented heavy page times out",
    (result) => result.kind === "timeout",
    async () => {
      const view = makeTab();
      await view.webContents.loadURL(`${fixture.base}/heavy`);
      const result = await cdpScreenshot(view);
      closeView(null, view);
      return result;
    },
  );

  await check(
    "never-parented light page also times out",
    (result) => result.kind === "timeout",
    async () => {
      const view = makeTab();
      await view.webContents.loadURL(`${fixture.base}/`);
      const result = await cdpScreenshot(view);
      closeView(null, view);
      return result;
    },
  );

  await check(
    "never-parented capturePage is empty",
    (result) => result.kind === "empty",
    async () => {
      const view = makeTab();
      await view.webContents.loadURL(`${fixture.base}/`);
      const result = await electronScreenshot(view);
      closeView(null, view);
      return result;
    },
  );

  await check(
    "a shown window supplies real pixels",
    (result) => result.kind === "captured" && result.frame.colours > 1,
    async () => {
      const view = makeTab();
      visibleWindow.contentView.addChildView(view);
      await view.webContents.loadURL(`${fixture.base}/heavy`);
      const result = await cdpScreenshot(view);
      closeView(visibleWindow, view);
      return result;
    },
  );

  const stage = new BaseWindow({ width: 900, height: 600, show: false });
  await check(
    "a never-shown BaseWindow stage supplies real pixels",
    (result) => result.kind === "captured" && result.frame.colours > 1,
    async () => {
      const view = makeTab();
      stage.contentView.addChildView(view);
      await view.webContents.loadURL(`${fixture.base}/heavy`);
      const result = await cdpScreenshot(view);
      closeView(stage, view);
      return result;
    },
  );

  await check(
    "stacked Headless tabs capture independently",
    (result) => result.every((one) => one.kind === "captured" && one.frame.colours > 1),
    async () => {
      const first = makeTab();
      const second = makeTab();
      stage.contentView.addChildView(first);
      stage.contentView.addChildView(second);
      await Promise.all([
        first.webContents.loadURL(`${fixture.base}/`),
        second.webContents.loadURL(`${fixture.base}/heavy`),
      ]);
      const result = await Promise.all([cdpScreenshot(first), cdpScreenshot(second)]);
      closeView(stage, first);
      closeView(stage, second);
      return result;
    },
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  stage.destroy();
  visibleWindow.destroy();
  await fixture.close();
  app.exit(failures === 0 ? 0 : 1);
});

process.on("unhandledRejection", (error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
setTimeout(() => {
  console.error("probe exceeded its 120s ceiling");
  process.exit(2);
}, 120_000).unref();
