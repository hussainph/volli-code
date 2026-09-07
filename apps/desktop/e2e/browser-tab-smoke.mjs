/**
 * Acceptance smoke for the Browser Tab stack (VC-110), against the BUILT app.
 *
 * A scratch-HOME Volli opens a loopback fixture through the real New Browser
 * Tab control. The fixture reports its own privilege findings through its title
 * because remote bytes do not belong in the app renderer: the pushed chrome
 * state must prove there is no `window.api`, no Node global, and no usable
 * denied `window.open`. The smoke then exercises managed HTTP popup handling,
 * address/history/reload chrome, in-pane DevTools, a Session's hold on the tab
 * with its cursor drawn over the plane (VC-239), tab destruction, and clean
 * app/server teardown. It starts no Session and takes no model turn, so it costs
 * $0 and needs no provider credentials: the hold step builds the same Browser
 * port the adapter builds, through main's `VOLLI_BROWSER_PROBE` seam, in two
 * invented Sessions' names.
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

/**
 * Open a Browser Tab the way a person does: the strip's one "+" pill, its caret
 * half, then the Browser row.
 *
 * Nothing is stubbed here on purpose. The previous shape of this smoke replaced
 * `window.prompt` with its own function, which is why it stayed green while the
 * shipped button did nothing at all — Electron defines `window.prompt` as
 * `throw new Error("prompt() is not supported.")`. A smoke that substitutes the
 * one API the product got wrong is testing itself.
 */
async function openBrowserTabFromMenu(page) {
  await page.getByRole("button", { name: "Other things to open", exact: true }).click();
  await page.getByRole("menuitem", { name: "Browser", exact: true }).click();
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

async function remoteViewAttached(app, targetUrl) {
  return app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    return (
      window?.contentView.children.some((view) => {
        const child = view;
        return (
          "webContents" in child &&
          !child.webContents.isDestroyed() &&
          child.webContents.getURL() === url
        );
      }) ?? false
    );
  }, targetUrl);
}

async function dockedDevToolsState(app, targetUrl) {
  return app.evaluate(({ BrowserWindow, webContents }, url) => {
    const all = webContents.getAllWebContents().filter((candidate) => !candidate.isDestroyed());
    const inspected = all.find((candidate) => candidate.getURL() === url);
    const tools = all.find((candidate) => candidate.getURL().startsWith("devtools://"));
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    const children =
      window?.contentView.children.flatMap((view) => {
        const child = view;
        return "webContents" in child
          ? [{ id: child.webContents.id, bounds: child.getBounds() }]
          : [];
      }) ?? [];
    const inspectedView = children.find((child) => child.id === inspected?.id);
    const toolsView = children.find((child) => child.id === tools?.id);
    return {
      docked:
        inspectedView !== undefined &&
        toolsView !== undefined &&
        toolsView.bounds.y >= inspectedView.bounds.y + inspectedView.bounds.height,
      inspectedView,
      toolsView,
    };
  }, targetUrl);
}

/** The chrome's holder pill (VC-239), or nothing for a free tab. */
const holderPill = (page) => page.locator('[data-slot="browser-holder-pill"]');
const holderDots = (page) => page.locator('[data-slot="browser-holder-dot"]');

/**
 * The Session cursor overlay's view in the app window: a child whose page is
 * the app's own cursor entry, sitting inside the fixture tab's plane. Null when
 * no cursor is drawn — which is what a free tab and a hidden plane must show.
 */
async function cursorViewOver(app, targetUrl) {
  return app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    const children =
      window?.contentView.children.flatMap((view) => {
        const child = view;
        return "webContents" in child && !child.webContents.isDestroyed()
          ? [{ url: child.webContents.getURL(), bounds: child.getBounds() }]
          : [];
      }) ?? [];
    const page = children.find((child) => child.url === url);
    const cursor = children.find((child) => child.url.endsWith("/cursor.html"));
    if (page === undefined || cursor === undefined) return null;
    const inside =
      cursor.bounds.x >= page.bounds.x - 16 &&
      cursor.bounds.y >= page.bounds.y - 16 &&
      cursor.bounds.x <= page.bounds.x + page.bounds.width &&
      cursor.bounds.y <= page.bounds.y + page.bounds.height &&
      cursor.bounds.width < page.bounds.width / 2 &&
      cursor.bounds.height < page.bounds.height / 2;
    return { inside, cursor: cursor.bounds, page: page.bounds, order: children.map((c) => c.url) };
  }, targetUrl);
}

/**
 * One Session's write on the fixture tab through a real Browser port built in
 * main — the port the adapter builds, in an invented Session's name. Answers
 * the refusal's rule rather than throwing it, because a BrowserRefusal does
 * not survive Playwright's error serialisation with its `rule` intact.
 */
async function sessionWrite(app, which, targetUrl) {
  return app.evaluate(
    async (_electron, { port: portName, url, projectId }) => {
      const probe = globalThis.volliBrowserProbe;
      globalThis.volliBrowserProbePorts ??= {
        a: probe.port({ projectId, ticketId: null }, "smoke-session-alpha"),
        b: probe.port({ projectId, ticketId: null }, "smoke-session-beta"),
      };
      const port = globalThis.volliBrowserProbePorts[portName];
      const signal = new AbortController().signal;
      try {
        const listing = await port.tabs({ signal });
        const tab = listing.tabs.find((candidate) => candidate.url === url);
        if (tab === undefined) return { rule: "no-such-tab", heldBy: null };
        const snap = await port.snapshot({ tabId: tab.tabId, signal });
        const ref = /\[ref=(e\d+)\]/.exec(snap.snapshotText)?.[1];
        if (ref === undefined) return { rule: "no-ref", heldBy: tab.heldBy };
        // A hover, not a click: the fixture's one link opens a managed popup,
        // and this step is about the hold and the cursor, not another tab.
        await port.act({
          tabId: tab.tabId,
          generation: snap.generation,
          kind: "hover",
          ref,
          signal,
        });
        const after = await port.tabs({ signal });
        return {
          rule: null,
          heldBy: after.tabs.find((candidate) => candidate.tabId === tab.tabId)?.heldBy ?? null,
        };
      } catch (error) {
        return { rule: error?.rule ?? "error", message: String(error?.message ?? error) };
      }
    },
    { port: which, url: targetUrl, projectId: PROJECT.id },
  );
}

const endSessionTurn = (app, which) =>
  app.evaluate((_electron, portName) => {
    globalThis.volliBrowserProbePorts?.[portName]?.turnEnded();
  }, which);

const disposeSessionPorts = (app) =>
  app.evaluate(() => {
    for (const port of Object.values(globalThis.volliBrowserProbePorts ?? {})) port.dispose();
    delete globalThis.volliBrowserProbePorts;
  });

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
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { HOME: scratchHome, VOLLI_BROWSER_PROBE: "1" },
  });
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
    "the + menu opens a blank tab whose address bar reaches the loopback fixture",
    async () => {
      await openBrowserTabFromMenu(page);

      // A blank tab lands first: named "New Tab", addressed with nothing, and
      // already holding the caret so the next keystroke is the destination.
      const blank = await waitUntil("the blank Browser Tab", async () => {
        const labels = await browserTabLabels(page);
        const address = await addressBar(page)
          .inputValue()
          .catch(() => null);
        return labels.length === 1 && labels[0] === "New Tab" && address === ""
          ? { labels, address }
          : null;
      });
      // The caret must be IN the field, not merely near it: the menu declines
      // to restore focus to its trigger for this row precisely so the pane's
      // own focus survives, and an earlier build of this feature failed here
      // with the "+" button still focused over an empty address bar.
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

      await addressBar(page).fill(startUrl);
      await addressBar(page).press("Enter");
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
        ok: focused === "Address" && labels.length === 1 && labels[0] === START_TITLE,
        detail: `blank=${JSON.stringify(blank)} focused=${focused} tabs=${JSON.stringify(labels)} address=${await addressBar(page).inputValue()}`,
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

  await must("2b", "overlays swap the Browser plane for pixels captured as they open", async () => {
    const trigger = page.getByRole("button", {
      name: "Toggle navigation sidebar",
      exact: true,
    });
    const shell = page.locator("[data-volli-shell]");
    if ((await shell.getAttribute("data-volli-shell")) === "framed") await trigger.click();
    await waitUntil(
      "the Browser plane to settle after unpinning the sidebar",
      async () =>
        (await shell.getAttribute("data-volli-shell")) === "ephemeral" &&
        (await remoteViewAttached(app, startUrl)),
    );
    // Nothing is photographed speculatively: the stand-in is taken WHEN an
    // overlay opens, so it is the frame the person was actually looking at.
    if ((await page.locator("[data-browser-plane-snapshot]").count()) !== 0) {
      throw new Error("expected no stand-in pixels before the first overlay");
    }
    await page.mouse.move(700, 70);
    await trigger.hover();
    await waitUntil(
      "the floating sidebar to take the renderer overlay tier",
      async () =>
        (await page.locator("[data-native-plane-overlay]").count()) === 1 &&
        (await page.locator('[data-browser-plane-snapshot="page"]').count()) === 1 &&
        !(await remoteViewAttached(app, startUrl)),
    );
    await page.mouse.move(700, 70);
    await waitUntil(
      "the floating sidebar to leave before restoring the Browser plane",
      async () =>
        (await page.locator("[data-native-plane-overlay]").count()) === 0 &&
        // The pixels STAY, covered by the reattached native view: there is no
        // frame in which neither the page nor its stand-in is painted.
        (await page.locator('[data-browser-plane-snapshot="page"]').count()) === 1 &&
        (await remoteViewAttached(app, startUrl)),
    );
    await trigger.click();
    await waitUntil(
      "pinning the sidebar to preserve the restored Browser plane",
      async () =>
        (await shell.getAttribute("data-volli-shell")) === "framed" &&
        (await remoteViewAttached(app, startUrl)),
    );

    // Exercise a real Radix menu too: this is the everyday overlay path the
    // ticket reported, whereas the floating sidebar uses the explicit marker.
    await page.getByRole("button", { name: "Other things to open", exact: true }).click();
    await waitUntil(
      "the new-session menu to freeze the Browser plane over its last pixels",
      async () =>
        (await page.getByRole("menu").count()) === 1 &&
        (await page.locator('[data-browser-plane-snapshot="page"]').count()) === 1 &&
        !(await remoteViewAttached(app, startUrl)),
    );
    await page.keyboard.press("Escape");
    await waitUntil(
      "closing the menu to restore the live Browser plane",
      async () =>
        (await page.getByRole("menu").count()) === 0 &&
        (await page.locator('[data-browser-plane-snapshot="page"]').count()) === 1 &&
        (await remoteViewAttached(app, startUrl)),
    );

    return {
      ok: true,
      detail:
        "no pixels until an overlay asks; floating/menu each capture then detach; both restore",
    };
  });

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
          // Back stays REACHABLE here, where it used to go dead: a tab now
          // begins on the blank start page, so that page is one more step
          // behind the first real destination — the same history a real
          // browser's new tab leaves behind it.
          (await chromeButton(page, "Back").isEnabled()) &&
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
    "DevTools toggles inside the active Browser pane without opening another window",
    async () => {
      const windowsBefore = await osWindowCount(app);
      const before = await dockedDevToolsState(app, secondUrl);
      await chromeButton(page, "Toggle DevTools").click();
      const dock = await waitUntil("docked DevTools for the fixture tab", async () => {
        const state = await dockedDevToolsState(app, secondUrl);
        return state.docked ? state : null;
      }).catch(() => null);
      await chromeButton(page, "Toggle DevTools").click();
      const closed = await waitUntil("DevTools to leave the Browser pane", async () => {
        const state = await dockedDevToolsState(app, secondUrl);
        return !state.docked && state.toolsView === undefined ? state : null;
      }).catch(() => null);
      const windowsAfter = await osWindowCount(app);
      const browserAlert = await page.getByRole("alert").count();
      const toastError = await page.getByText(/Could not toggle DevTools/i).count();
      return {
        ok:
          dock !== null &&
          closed !== null &&
          JSON.stringify(closed.inspectedView?.bounds) ===
            JSON.stringify(before.inspectedView?.bounds) &&
          windowsAfter === windowsBefore &&
          browserAlert === 0 &&
          toastError === 0 &&
          pageErrors.length === 0,
        detail: `devtools=${dock === null ? "not-docked" : JSON.stringify(dock)} closed=${JSON.stringify(closed)} windows=${windowsBefore}→${windowsAfter} alerts=${browserAlert} errorToasts=${toastError} pageErrors=${JSON.stringify(pageErrors)}`,
      };
    },
  );

  await must(
    8,
    "a Session's write takes the tab's hold and draws its cursor over the plane; a second Session is refused",
    async () => {
      const pillBefore = await holderPill(page).count();
      const cursorBefore = await cursorViewOver(app, secondUrl);

      const alpha = await sessionWrite(app, "a", secondUrl);
      const pill = await waitUntil("the holder pill for the Session", async () =>
        (await holderPill(page).getAttribute("data-holder")) === "session" ? true : null,
      ).catch(() => false);
      const takeOverOffered = await page
        .getByRole("button", { name: "Take over", exact: true })
        .count();
      const dots = await holderDots(page).count();
      const cursor = await waitUntil("the cursor view over the plane", async () => {
        const view = await cursorViewOver(app, secondUrl);
        return view?.inside === true ? view : null;
      }).catch(() => null);
      // The label is pinned for a moment when a hold begins, and the view is
      // sized to the drawing: wider than the arrow alone while the label shows,
      // which is the page's size report reaching main.
      const labelSized = await waitUntil(
        "the cursor view to grow around its pinned label",
        async () => {
          const view = await cursorViewOver(app, secondUrl);
          return view !== null && view.cursor.width > 60 ? view.cursor : null;
        },
        // What this waits on is a renderer BOOT: the overlay's page is built
        // lazily by the first draw, and only once it is listening can it be
        // told to show the label and report the size that proves it. A dev Mac
        // does that inside the label's own pin and a loaded CI runner takes
        // seconds, so the old 1.5s bound failed on CI for every branch. The
        // pin now runs from when the page can first draw (cursor-overlay.ts),
        // which makes the label certain; this bound only has to outlast a slow
        // boot.
        { timeout: 15000 },
      ).catch(() => null);

      const beta = await sessionWrite(app, "b", secondUrl);

      return {
        ok:
          pillBefore === 0 &&
          cursorBefore === null &&
          alpha.rule === null &&
          alpha.heldBy?.kind === "session" &&
          alpha.heldBy?.self === true &&
          pill === true &&
          takeOverOffered === 1 &&
          dots === 1 &&
          cursor !== null &&
          labelSized !== null &&
          // The cursor sits ABOVE the page: added to the window after it.
          cursor.order.indexOf(secondUrl) <
            cursor.order.findIndex((u) => u.endsWith("/cursor.html")) &&
          beta.rule === "browser.tab-held" &&
          pageErrors.length === 0,
        detail: `alpha=${JSON.stringify(alpha)} beta=${JSON.stringify(beta)} pill=${pill} takeOver=${takeOverOffered} dots=${dots} cursor=${JSON.stringify(cursor)} labelSized=${JSON.stringify(labelSized)} pageErrors=${JSON.stringify(pageErrors)}`,
      };
    },
  );

  await must(
    9,
    "the person takes over, the Session is refused until hand-back, and the turn's end frees the tab",
    async () => {
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      const yours = await waitUntil("the pill to say Yours", async () =>
        (await holderPill(page).getAttribute("data-holder")) === "person" ? true : null,
      ).catch(() => false);
      const cursorGone = await waitUntil("the cursor to leave the plane", async () =>
        (await cursorViewOver(app, secondUrl)) === null ? true : null,
      ).catch(() => false);
      const refusedByPerson = await sessionWrite(app, "a", secondUrl);

      await page.getByRole("button", { name: "Hand back", exact: true }).click();
      const freed = await waitUntil("the pill to leave the chrome", async () =>
        (await holderPill(page).count()) === 0 ? true : null,
      ).catch(() => false);
      const again = await sessionWrite(app, "a", secondUrl);
      const heldAgain = await waitUntil("the Session's hold to return", async () =>
        (await holderPill(page).getAttribute("data-holder")) === "session" ? true : null,
      ).catch(() => false);

      await endSessionTurn(app, "a");
      const endedWithTurn = await waitUntil("the hold to end with the turn", async () =>
        (await holderPill(page).count()) === 0 && (await holderDots(page).count()) === 0
          ? true
          : null,
      ).catch(() => false);
      const cursorAfterTurn = await waitUntil("the cursor to fade with the turn", async () =>
        (await cursorViewOver(app, secondUrl)) === null ? true : null,
      ).catch(() => false);
      await disposeSessionPorts(app);

      return {
        ok:
          yours === true &&
          cursorGone === true &&
          refusedByPerson.rule === "browser.person-has-tab" &&
          freed === true &&
          again.rule === null &&
          heldAgain === true &&
          endedWithTurn === true &&
          cursorAfterTurn === true &&
          pageErrors.length === 0,
        detail: `yours=${yours} cursorGone=${cursorGone} refused=${JSON.stringify(refusedByPerson)} freed=${freed} again=${JSON.stringify(again)} heldAgain=${heldAgain} endedWithTurn=${endedWithTurn} cursorAfterTurn=${cursorAfterTurn} pageErrors=${JSON.stringify(pageErrors)}`,
      };
    },
  );

  await must(
    10,
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
