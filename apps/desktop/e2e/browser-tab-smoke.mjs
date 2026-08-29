/**
 * Acceptance smoke for the Browser Tab stack (VC-110), against the BUILT app.
 *
 * A scratch-HOME Volli opens a loopback fixture through the real New Browser
 * Tab control. The fixture reports its own privilege findings through its title
 * because remote bytes do not belong in the app renderer: the pushed chrome
 * state must prove there is no `window.api`, no Node global, and no usable
 * denied `window.open`. The smoke then exercises managed HTTP popup handling,
 * address/history/reload chrome, detached DevTools, tab destruction, and clean
 * app/server teardown. It starts no Session and takes no model turn, so it costs
 * $0 and needs no provider credentials.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/browser-tab-smoke.mjs
 */
import http from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  createRunner,
  HOME_TAB_STRIP,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  tabStrip,
  waitForChildExit,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = {
  id: "browser-tab-smoke-project",
  name: "Browser Tab Smoke",
  prefix: "BT",
};
const ISOLATION = "api:undefined;node:undefined;open:false";
const START_TITLE = `Fixture Start | ${ISOLATION}`;
const POPUP_TITLE = "Fixture Popup";

/**
 * The fixture is intentionally owned by this process: no external network,
 * server binary, credentials, or project dependency can influence the proof.
 * `Connection: close` also makes the final socket assertion meaningful rather
 * than an HTTP keep-alive timing test.
 */
async function startFixtureServer() {
  const hits = new Map();
  const sockets = new Set();
  let origin = null;
  let stopped = false;

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
    const path = requestUrl.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "close");
    response.setHeader("Content-Type", "text/html; charset=utf-8");

    if (path === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (path === "/popup") {
      response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${POPUP_TITLE}</title></head>
  <body><h1>Managed popup fixture</h1></body>
</html>`);
      return;
    }

    if (path === "/start" || path === "/second") {
      const rootTitle =
        path === "/start" ? "Fixture Start" : `Fixture Second visit:${hits.get(path)}`;
      const popupLink =
        path === "/second"
          ? `<a id="popup-link" href="${origin}/popup" target="_blank">Open managed popup</a>`
          : "";
      response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${rootTitle}</title></head>
  <body>
    <h1>${rootTitle}</h1>
    ${popupLink}
    <script>
      (() => {
        const rootTitle = ${JSON.stringify(rootTitle)};
        const isolation = [
          "api:" + typeof window.api,
          "node:" + typeof process,
          "open:" + String(Boolean(window.open("about:blank", "_blank"))),
        ].join(";");
        document.title = rootTitle + " | " + isolation;

        const link = document.getElementById("popup-link");
        if (link !== null) {
          link.addEventListener("click", (event) => {
            event.preventDefault();
            const opened = window.open(link.href, link.target);
            document.title = rootTitle + " | " + isolation + ";popup:" + String(Boolean(opened));
          });
        }
      })();
    </script>
  </body>
</html>`);
      return;
    }

    response.statusCode = 404;
    response.end("<!doctype html><title>Fixture Not Found</title><h1>Not found</h1>");
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind an IPv4 loopback port");
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    hits: (path) => hits.get(path) ?? 0,
    openSockets: () => sockets.size,
    async stop({ force = false } = {}) {
      if (stopped) return;
      stopped = true;
      server.closeIdleConnections?.();
      if (force) server.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

const strip = (page) => tabStrip(page, HOME_TAB_STRIP);
const browserTabs = (page) => strip(page).getByTestId("home-browser-tab");
const browserPane = (page) => page.locator("[data-browser-plane]").locator("..");
const addressBar = (page) =>
  browserPane(page).getByRole("textbox", { name: "Address", exact: true });
const chromeButton = (page, name) => browserPane(page).getByRole("button", { name, exact: true });

async function browserTabLabels(page) {
  return browserTabs(page).evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute("aria-label") ?? ""),
  );
}

async function loadingSettled(page, title) {
  const tab = strip(page).getByRole("tab", { name: title, exact: true });
  const reload = chromeButton(page, "Reload");
  return (
    (await tab.locator('[data-slot="status-dot"][data-state="working"]').count()) === 0 &&
    (await reload.locator('[aria-label="Loading"]').count()) === 0
  );
}

async function answerNextPrompt(page, value, action) {
  await page.evaluate((answer) => {
    const original = window.prompt;
    window.volliBrowserSmokePrompt = null;
    window.prompt = (message, defaultValue) => {
      window.prompt = original;
      window.volliBrowserSmokePrompt = { message, defaultValue };
      return answer;
    };
  }, value);
  await action();
  return page.evaluate(() => window.volliBrowserSmokePrompt);
}

/**
 * Click one fixture link through the same private CDP transport family the
 * Browser tool uses. The smoke reads only the link's accessible name and box;
 * the isolation verdict still comes exclusively from the fixture-authored
 * title pushed into renderer chrome, never from evaluating a remote global.
 */
async function clickRemoteLink(app, targetUrl, accessibleName) {
  return app.evaluate(
    async ({ webContents }, input) => {
      const contents = webContents
        .getAllWebContents()
        .find((candidate) => !candidate.isDestroyed() && candidate.getURL() === input.targetUrl);
      if (contents === undefined) throw new Error(`no remote WebContents at ${input.targetUrl}`);

      const wire = contents.debugger;
      const attachedHere = !wire.isAttached();
      if (attachedHere) wire.attach("1.3");
      try {
        await wire.sendCommand("Accessibility.enable");
        await wire.sendCommand("DOM.enable");
        const tree = await wire.sendCommand("Accessibility.getFullAXTree");
        const node = tree.nodes?.find(
          (candidate) =>
            candidate.role?.value === "link" && candidate.name?.value === input.accessibleName,
        );
        const backendNodeId = node?.backendDOMNodeId;
        if (typeof backendNodeId !== "number") {
          throw new Error(`no accessible link named ${JSON.stringify(input.accessibleName)}`);
        }
        await wire.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId });
        const box = await wire.sendCommand("DOM.getBoxModel", { backendNodeId });
        const quad = box.model?.content;
        if (!Array.isArray(quad) || quad.length < 8) {
          throw new Error("fixture popup link has no actionable box");
        }
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        await wire.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await wire.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        return { backendNodeId, x, y };
      } finally {
        if (attachedHere && wire.isAttached()) wire.detach();
      }
    },
    { targetUrl, accessibleName },
  );
}

async function osWindowCount(app) {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length,
  );
}

async function remoteDevToolsOpened(app, targetUrl) {
  return app.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .some(
          (candidate) =>
            !candidate.isDestroyed() && candidate.getURL() === url && candidate.isDevToolsOpened(),
        ),
    targetUrl,
  );
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-browser-tab-smoke-");
const scratchHome = join(scratch, "home");
const { must, summarize } = createRunner();
const fixture = await startFixtureServer();
const startUrl = `${fixture.origin}/start`;
const secondUrl = `${fixture.origin}/second`;
const popupUrl = `${fixture.origin}/popup`;

let app = null;
let code = 1;

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "browser-project-");
  app = await launch({ dbPath, userDataDir, extraEnv: { HOME: scratchHome } });
  await assertProfileIsolated(app, userDataDir);

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await waitUntil("Home tab strip", async () => ((await strip(page).count()) === 1 ? true : null));

  await must(
    1,
    "New Browser Tab opens the loopback fixture with live URL/title chrome and settled loading",
    async () => {
      const prompt = await answerNextPrompt(page, startUrl, () =>
        page.getByRole("button", { name: "New Browser Tab", exact: true }).click(),
      );
      await waitUntil(
        "the fixture Browser Tab to settle",
        async () => {
          const labels = await browserTabLabels(page);
          const address = await addressBar(page)
            .inputValue()
            .catch(() => "");
          const active = await strip(page)
            .getByRole("tab", { name: START_TITLE, exact: true })
            .getAttribute("aria-selected")
            .catch(() => null);
          return labels.length === 1 &&
            labels[0] === START_TITLE &&
            address === startUrl &&
            active === "true" &&
            (await loadingSettled(page, START_TITLE))
            ? { labels, address, active }
            : null;
        },
        { timeout: 20000 },
      );
      const labels = await browserTabLabels(page);
      return {
        ok:
          prompt?.message === "Open Browser Tab" &&
          prompt?.defaultValue === "http://localhost:3000" &&
          labels.length === 1 &&
          labels[0] === START_TITLE,
        detail: `prompt=${JSON.stringify(prompt)} tabs=${JSON.stringify(labels)} address=${await addressBar(page).inputValue()}`,
      };
    },
  );

  await must(
    2,
    "the remote fixture reports no preload API, Node global, or usable popup",
    async () => {
      const label = await browserTabs(page).first().getAttribute("aria-label");
      const chromeTitle = await page.getByTitle(START_TITLE, { exact: true }).count();
      return {
        ok: label === START_TITLE && chromeTitle >= 1,
        detail: `title=${JSON.stringify(label)} chromeCopies=${chromeTitle}`,
      };
    },
  );

  await must(
    3,
    "address navigation updates the URL/title and enables Back only after loading settles",
    async () => {
      await addressBar(page).fill(secondUrl);
      await addressBar(page).press("Enter");
      const title = await waitUntil(
        "the second fixture URL and history state",
        async () => {
          const labels = await browserTabLabels(page);
          const candidate = labels.find((label) => label.startsWith("Fixture Second visit:"));
          if (
            candidate !== undefined &&
            candidate.includes(ISOLATION) &&
            (await addressBar(page).inputValue()) === secondUrl &&
            (await chromeButton(page, "Back").isEnabled()) &&
            !(await chromeButton(page, "Forward").isEnabled()) &&
            (await loadingSettled(page, candidate))
          ) {
            return candidate;
          }
          return null;
        },
        { timeout: 20000 },
      );
      return {
        ok: title.includes(ISOLATION),
        detail: `title=${JSON.stringify(title)} back=enabled forward=disabled`,
      };
    },
  );

  await must(
    4,
    "Back and Forward flip reachability from pushed Chromium history state",
    async () => {
      await chromeButton(page, "Back").click();
      await waitUntil(
        "Back to return to the start fixture",
        async () =>
          (await addressBar(page).inputValue()) === startUrl &&
          !(await chromeButton(page, "Back").isEnabled()) &&
          (await chromeButton(page, "Forward").isEnabled()) &&
          (await loadingSettled(page, START_TITLE)),
        { timeout: 20000 },
      );

      await chromeButton(page, "Forward").click();
      const forwardTitle = await waitUntil(
        "Forward to return to the second fixture",
        async () => {
          const labels = await browserTabLabels(page);
          const candidate = labels.find((label) => label.startsWith("Fixture Second visit:"));
          return candidate !== undefined &&
            candidate.includes(ISOLATION) &&
            (await addressBar(page).inputValue()) === secondUrl &&
            (await chromeButton(page, "Back").isEnabled()) &&
            !(await chromeButton(page, "Forward").isEnabled()) &&
            (await loadingSettled(page, candidate))
            ? candidate
            : null;
        },
        { timeout: 20000 },
      );
      return {
        ok: forwardTitle.includes(ISOLATION),
        detail: `title=${JSON.stringify(forwardTitle)} back=enabled forward=disabled`,
      };
    },
  );

  await must(5, "Reload requests the fixture again and returns to settled chrome", async () => {
    const before = fixture.hits("/second");
    await chromeButton(page, "Reload").click();
    const title = await waitUntil(
      "Reload to hit and settle the second fixture again",
      async () => {
        const labels = await browserTabLabels(page);
        const candidate = labels.find((label) => label.startsWith("Fixture Second visit:"));
        return fixture.hits("/second") > before &&
          candidate !== undefined &&
          candidate.includes(ISOLATION) &&
          (await addressBar(page).inputValue()) === secondUrl &&
          (await loadingSettled(page, candidate))
          ? candidate
          : null;
      },
      { timeout: 20000 },
    );
    const after = fixture.hits("/second");
    return {
      ok: after > before && title.includes(ISOLATION),
      detail: `secondRequests=${before}→${after} title=${JSON.stringify(title)}`,
    };
  });

  await must(
    6,
    "a target=_blank HTTP popup returns null, creates a managed product tab, and opens no OS window",
    async () => {
      const parentTitle = (await browserTabLabels(page)).find(
        (label) => label.startsWith("Fixture Second visit:") && label.includes(ISOLATION),
      );
      if (parentTitle === undefined) throw new Error("active second-fixture tab has no title");
      const expectedParentTitle = `${parentTitle};popup:false`;
      const windowsBefore = await osWindowCount(app);
      const click = await clickRemoteLink(app, secondUrl, "Open managed popup");
      await waitUntil(
        "managed popup tab and parent null receipt",
        async () => {
          const labels = await browserTabLabels(page);
          return labels.includes(expectedParentTitle) && labels.includes(POPUP_TITLE)
            ? labels
            : null;
        },
        { timeout: 20000 },
      );
      const windowsAfter = await osWindowCount(app);

      await strip(page).getByRole("tab", { name: POPUP_TITLE, exact: true }).click();
      await waitUntil(
        "managed popup tab to become the active Browser plane",
        async () =>
          (await addressBar(page).inputValue()) === popupUrl &&
          (await loadingSettled(page, POPUP_TITLE)),
      );
      await strip(page).getByRole("tab", { name: expectedParentTitle, exact: true }).click();
      await waitUntil(
        "parent Browser Tab to return",
        async () => (await addressBar(page).inputValue()) === secondUrl,
      );

      return {
        ok: windowsBefore === 1 && windowsAfter === windowsBefore,
        detail: `windows=${windowsBefore}→${windowsAfter} clickRef=${click.backendNodeId} tabs=${JSON.stringify(await browserTabLabels(page))}`,
      };
    },
  );

  await must(
    7,
    "Open DevTools opens for the active tab without surfacing a renderer error",
    async () => {
      await chromeButton(page, "Open DevTools").click();
      await waitUntil("detached DevTools for the fixture tab", () =>
        remoteDevToolsOpened(app, secondUrl),
      );
      const browserAlert = await page.getByRole("alert").count();
      const toastError = await page.getByText(/Could not open DevTools/i).count();
      return {
        ok: browserAlert === 0 && toastError === 0 && pageErrors.length === 0,
        detail: `devtools=open alerts=${browserAlert} errorToasts=${toastError} pageErrors=${JSON.stringify(pageErrors)}`,
      };
    },
  );

  await must(
    8,
    "closing both Browser Tabs quits cleanly and leaves no fixture-server socket",
    async () => {
      await strip(page)
        .getByRole("tab", { name: POPUP_TITLE, exact: true })
        .getByTestId("tab-close")
        .click();
      await waitUntil("managed popup tab to close", async () =>
        (await browserTabs(page).count()) === 1 ? true : null,
      );
      const remaining = browserTabs(page).first();
      await remaining.getByTestId("tab-close").click();
      await waitUntil("all Browser Tabs to close", async () =>
        (await browserTabs(page).count()) === 0 ? true : null,
      );

      const child = app.process();
      await app.close();
      app = null;
      const exit = await waitForChildExit(child, "clean Browser Tab smoke app exit", {
        timeout: 15000,
      });
      await waitUntil(
        "fixture HTTP sockets to drain",
        () => (fixture.openSockets() === 0 ? true : null),
        { timeout: 8000 },
      );
      await fixture.stop();

      return {
        ok: exit.code === 0 && exit.signal === null && fixture.openSockets() === 0,
        detail: `exit=${exit.code} signal=${exit.signal ?? "none"} sockets=${fixture.openSockets()}`,
      };
    },
  );

  return summarize();
}

try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  if (app !== null) await app.close().catch(() => {});
  await fixture.stop({ force: true }).catch(() => {});
  await cleanup();
}
process.exit(code);
