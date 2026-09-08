/**
 * Acceptance smoke for VC-278, against the BUILT app: a Browser Tab nobody has
 * ever shown can still be screenshotted and clicked.
 *
 * A Session-created tab is born headless and stays that way unless a person
 * reveals it. Before the off-screen stage, that meant its `WebContentsView` had
 * no parent window and therefore no compositor surface, and Chromium answered
 * that state almost silently:
 *
 *   Page.captureScreenshot   never answered (the controller's 15s bound fired)
 *   capturePage()            a 0x0 image, stored as a zero-byte picture
 *   click / hover            reached nothing, while `act` reported success
 *   snapshot                 worked perfectly, which is what hid all of it
 *
 * So this drives the REAL port — the one the adapter builds, through main's
 * `VOLLI_BROWSER_PROBE` seam — against a tab it opens itself and never shows,
 * and asserts the three that used to fail. A regression here is silent in every
 * other test: the snapshot keeps passing while the tab goes blind and numb.
 *
 * It starts no Session and takes no model turn, so it costs $0 and needs no
 * provider credentials.
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/browser-headless-capture-smoke.mjs
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = {
  id: "browser-headless-capture-project",
  name: "Headless Capture Smoke",
  prefix: "HC",
};

/**
 * A page with a button that records its own clicks in the title, and enough
 * colour that a blank capture is obvious in the byte count.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head>
<body style="margin:0;background:#1d4ed8;color:#fff;font:16px system-ui">
<h1>Headless capture fixture</h1>
<button id="go" style="width:240px;height:64px;font-size:18px"
        onclick="document.title='CLICKED'">Press me</button>
</body></html>`;

async function startFixtureServer() {
  const server = http.createServer((_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Opens a tab through the real port and drives every door VC-278 touched,
 * without ever showing it. Returns plain data: a BrowserRefusal does not
 * survive Playwright's error serialisation with its `rule` intact.
 */
async function driveHeadlessTab(app, url, projectId) {
  return app.evaluate(
    async (_electron, { url: target, projectId: scope }) => {
      const probe = globalThis.volliBrowserProbe;
      if (probe === undefined) throw new Error("VOLLI_BROWSER_PROBE door is not open");
      const port = probe.port({ projectId: scope, ticketId: null }, "smoke-session-vc278");
      const signal = new AbortController().signal;
      const out = {};
      try {
        // No tabId: the port opens its own tab, owned and headless from birth.
        const opened = await port.navigate({ navigation: { kind: "url", url: target }, signal });
        out.tabId = opened.tabId;
        out.url = opened.url;
        // The transcript frame for the navigation. Null here is the old bug:
        // an empty capture that the host now declines rather than stores.
        out.navigationPicture = opened.picture;

        const host = globalThis.volliBrowserHost;
        out.presentation = host
          ?.list({ projectId: scope })
          .find((tab) => tab.tabId === opened.tabId)?.presentation;

        // 1. The screenshot: the ticket's headline symptom, timed.
        const startedAt = Date.now();
        const shot = await port.screenshot({ tabId: opened.tabId, signal });
        out.screenshotMs = Date.now() - startedAt;
        out.screenshotBytes = Buffer.from(shot.base64Png, "base64").byteLength;
        out.screenshotSize = `${shot.width}x${shot.height}`;

        // 2. The click: silently a no-op before the stage existed.
        const snap = await port.snapshot({ tabId: opened.tabId, signal });
        const ref = /button[^\n]*\[ref=(e\d+)\]/.exec(snap.snapshotText)?.[1];
        out.buttonRef = ref ?? null;
        if (ref !== undefined) {
          await port.act({
            tabId: opened.tabId,
            generation: snap.generation,
            kind: "click",
            ref,
            signal,
          });
          const after = await port.snapshot({ tabId: opened.tabId, signal });
          out.titleAfterClick = after.title;
        }
        port.dispose();
      } catch (error) {
        out.error = String(error?.message ?? error);
      }
      return out;
    },
    { url, projectId },
  );
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-headless-capture-");
const scratchHome = join(scratch, "home");
const { must, summarize } = createRunner();
const fixture = await startFixtureServer();

let app = null;
let code = 1;

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "headless-capture-");
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: scratchHome,
      VOLLI_BROWSER_PROBE: "1",
      VOLLI_SMOKE_BROWSER_HOST: "1",
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await waitUntil("app ready", async () => true);

  const result = await driveHeadlessTab(app, `${fixture.origin}/`, PROJECT.id);

  await must(
    1,
    "a tab nobody showed is screenshotted, with real pixels and well inside the bound",
    async () => {
      const detail = `presentation=${result.presentation} ${result.screenshotMs}ms ${result.screenshotBytes}B ${result.screenshotSize}${result.error === undefined ? "" : ` error=${result.error}`}`;
      const ok =
        result.error === undefined &&
        // Still nobody's tab to look at: the fix must not have shown it.
        result.presentation === "headless" &&
        // The old failure was the 15s bound firing. Anything near it is a
        // regression even if it eventually answers.
        typeof result.screenshotMs === "number" &&
        result.screenshotMs < 5_000 &&
        // A blank or empty frame would still "succeed" without this.
        result.screenshotBytes > 2_000;
      return { ok, detail };
    },
  );

  await must(2, "a click on a tab nobody showed actually reaches the page", async () => {
    // The page writes its own title on click. Before the stage, the act
    // reported success and the title never changed — which is why this asserts
    // the PAGE's own account of the click, not the port's.
    const ok = result.buttonRef !== null && result.titleAfterClick === "CLICKED";
    return {
      ok,
      detail: `ref=${result.buttonRef} title=${JSON.stringify(result.titleAfterClick)}`,
    };
  });

  await must(3, "the navigation's transcript picture is a real frame, not zero bytes", async () => {
    // `capturePicture` declines rather than storing emptiness now, so a null
    // here means the capture came back empty — the silent half of VC-278.
    if (result.navigationPicture === null || result.navigationPicture === undefined) {
      return { ok: false, detail: "navigate stored no picture: the capture came back empty" };
    }
    const chars = await app.evaluate(
      (_electron, id) => globalThis.volliBrowserHost?.pictureOf(id)?.length ?? 0,
      result.navigationPicture,
    );
    return { ok: chars > 2_000, detail: `picture ${result.navigationPicture} · ${chars} chars` };
  });

  code = summarize();
}

try {
  await main();
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  await fixture.close();
  await cleanup();
  process.exit(code);
}
