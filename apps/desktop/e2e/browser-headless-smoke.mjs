/**
 * Acceptance smoke for headless agent Browser Tabs (VC-238), against the BUILT
 * app: headless → show → hide → open as tab → hide → close.
 *
 * A Session-owned tab is born headless — in no strip, attached to no window —
 * and the only place a person sees it is the chat that owns it. This smoke
 * opens one the way the Browser port does (through the host, behind the
 * `VOLLI_SMOKE_BROWSER_HOST` door, because a $0 smoke cannot take a model
 * turn), then drives every presentation from the person's side:
 *
 *   1. the tab is in the chat's chip and in NO strip, and no native view is attached;
 *   2. Show pins it above the composer, attached BESIDE the person's own tab in the
 *      other pane of a split — two native views on screen together;
 *   3. Hide returns it to headless; nothing the agent sees changed;
 *   4. Open as tab promotes it into the strip with the Session mark, and Hide
 *      takes it back out;
 *   5. Close removes it everywhere; a second Session's tab was never listed.
 *
 * MANUALLY-RUN or CI (needs a display + the built app); not part of `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/browser-headless-smoke.mjs
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
  seedDefaultModel,
  seedProjects,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "browser-headless-smoke-project", name: "Headless Smoke", prefix: "HB" };

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const title = path === "/agent" ? "Agent Fixture" : "Person Fixture";
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><button id="go">Go</button></body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Page-wide, on purpose: under a split each pane draws its own strip, and the
// question every check asks is about the surface as a whole.
const browserStripTabs = (page) => page.getByTestId("home-browser-tab");
const chip = (page) => page.locator("[data-browser-tabs-chip]");
const preview = (page) => page.locator("[data-browser-preview]");
const focusedEmptyRow = (page, label) =>
  page.locator(
    `[data-slot="split-view-pane"][data-focused="true"] [data-slot="pane-empty-row"][aria-label="${label}"]`,
  );

/** The host's own view of the registry, through the smoke door. */
async function hostTabs(app) {
  return app.evaluate(() => {
    const host = globalThis.volliBrowserHost;
    if (host === undefined) throw new Error("VOLLI_SMOKE_BROWSER_HOST door is not open");
    return host.list({ projectId: "browser-headless-smoke-project" });
  });
}

/** The URLs of every remote WebContentsView the window currently holds. */
async function attachedViews(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    return (
      window?.contentView.children.flatMap((view) =>
        "webContents" in view && !view.webContents.isDestroyed() ? [view.webContents.getURL()] : [],
      ) ?? []
    );
  });
}

/** Presses a chip-menu action for the one tab the chip lists, and closes the menu. */
async function chipAction(page, name) {
  await chip(page).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page.keyboard.press("Escape");
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-browser-headless-");
const scratchHome = join(scratch, "home");
const { must, summarize } = createRunner();
const fixture = await startFixtureServer();
const agentUrl = `${fixture.origin}/agent`;
const personUrl = `${fixture.origin}/person`;

let app = null;
let code = 1;

async function main() {
  await fs.mkdir(scratchHome, { recursive: true });
  const projectPath = await makeGitRepo(scratch, "headless-project-");
  app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: scratchHome,
      VOLLI_SMOKE_BROWSER_HOST: "1",
      // A chat Session needs a default model, and a default must be AVAILABLE,
      // which for an API-key provider means a key in the environment. This
      // one is not a key: no turn is ever taken, so nothing is ever sent with
      // it. It exists so `session.create` has a model to record.
      ANTHROPIC_API_KEY: "volli-smoke-placeholder-never-sent",
    },
  });
  await assertProfileIsolated(app, userDataDir);

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await seedDefaultModel(page);
  await waitUntil("Home tab strip", async () =>
    (await tabStrip(page, HOME_TAB_STRIP).count()) === 1 ? true : null,
  );

  // The person's own tab, through the real bridge, front in the first pane.
  await page.evaluate(
    ({ projectId, url }) => window.api.browser.open({ projectId, url }),
    { projectId: PROJECT.id, url: personUrl },
  );
  await waitUntil("the person's strip tab", async () => (await browserStripTabs(page).count()) === 1);
  await browserStripTabs(page).first().click();
  await waitUntil("the person's plane", async () => (await attachedViews(app)).includes(personUrl), {
    timeout: 20000,
  });

  // A second pane with a chat in it: a chat Session exists before any executor
  // attaches, so this costs no model turn — and its id is what the agent tab is
  // owned by. The split is what lets the chat and the person's tab share the
  // screen, which is the multi-attach proof below.
  await page.keyboard.press("Shift+Meta+\\");
  await waitUntil("the empty pane", async () =>
    (await focusedEmptyRow(page, "New chat").count()) === 1 ? true : null,
  );
  await focusedEmptyRow(page, "New chat").click();
  const sessionId = await waitUntil("the chat Session id", async () => {
    const result = await page.evaluate(
      (projectId) => window.api.sessions.list({ projectId }),
      PROJECT.id,
    );
    const chat = result.ok ? result.sessions.find((row) => row.kind === "chat") : undefined;
    return chat?.record.sessionId ?? null;
  });
  const chatTabLabel = await waitUntil("the chat tab", async () => {
    const label = await page
      .locator('[data-slot="split-view-pane"][data-focused="true"] [role="tab"][aria-selected="true"]')
      .getAttribute("aria-label")
      .catch(() => null);
    return label === null || label === "" ? null : label;
  });

  await must(
    1,
    "an agent tab is born headless: counted by the chat's chip, in no strip, attached nowhere",
    async () => {
      const opened = await app.evaluate(
        (_electron, input) => {
          const host = globalThis.volliBrowserHost;
          return [
            host.open({ ...input, ownerSessionId: input.owner }),
            host.open({ ...input, ownerSessionId: "another-session" }),
          ].map((tab) => ({ tabId: tab.tabId, presentation: tab.presentation }));
        },
        { url: agentUrl, projectId: PROJECT.id, ticketId: null, createdBy: "session", owner: sessionId },
      );
      await waitUntil("the chat's tab chip", async () =>
        (await chip(page).getAttribute("data-browser-tabs-chip")) === "1" ? true : null,
      );
      const stripCount = await browserStripTabs(page).count();
      const attached = await attachedViews(app);
      return {
        ok:
          opened.every((tab) => tab.presentation === "headless") &&
          stripCount === 1 &&
          !attached.includes(agentUrl),
        detail: `opened=${JSON.stringify(opened)} strip=${stripCount} attached=${JSON.stringify(attached)}`,
      };
    },
  );

  await must(
    2,
    "Show pins the tab above the composer, attached beside the person's own tab in the other pane",
    async () => {
      await chipAction(page, "Show");
      // Both planes, because the chip's popover is an overlay: while it was
      // open every native view stood down onto frozen pixels, and the person's
      // pane comes back only once it has closed.
      const state = await waitUntil(
        "the preview to be pinned and attached beside the person's pane",
        async () => {
          const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
          const attached = await attachedViews(app);
          return mine?.presentation === "preview" &&
            attached.includes(agentUrl) &&
            attached.includes(personUrl)
            ? { mine, attached }
            : null;
        },
        { timeout: 20000 },
      );
      return {
        ok:
          (await preview(page).count()) === 1 &&
          state.attached.includes(agentUrl) &&
          state.attached.includes(personUrl) &&
          (await browserStripTabs(page).count()) === 1,
        detail: `attached=${JSON.stringify(state.attached)} strip=${await browserStripTabs(page).count()}`,
      };
    },
  );

  await must(3, "Hide returns it to headless without touching what the agent sees", async () => {
    const before = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
    await preview(page).getByRole("button", { name: "Hide", exact: true }).click();
    const after = await waitUntil("the tab to leave the screen", async () => {
      const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
      const attached = await attachedViews(app);
      return mine?.presentation === "headless" && !attached.includes(agentUrl) ? mine : null;
    });
    const attached = await attachedViews(app);
    return {
      ok:
        after.generation === before.generation &&
        after.url === before.url &&
        after.ownerSessionId === before.ownerSessionId &&
        attached.includes(personUrl) &&
        (await preview(page).count()) === 0,
      detail: `before=${JSON.stringify(before)} after=${JSON.stringify(after)} attached=${JSON.stringify(attached)}`,
    };
  });

  await must(4, "Open as tab puts it in the strip with the Session mark, and Hide takes it out again", async () => {
    await chipAction(page, "Show");
    await waitUntil("the preview", async () => ((await preview(page).count()) === 1 ? true : null));
    await preview(page).getByRole("button", { name: "Open as tab", exact: true }).click();
    await waitUntil("two strip tabs", async () => (await browserStripTabs(page).count()) === 2);
    const marks = await browserStripTabs(page).evaluateAll((tabs) =>
      tabs.map((tab) =>
        tab.querySelector("[data-browser-tab-mark]")?.getAttribute("data-browser-tab-mark"),
      ),
    );
    // The promoted tab took the chat's pane; bring the chat back to reach its chip.
    await page.locator(`[role="tab"][aria-label="${chatTabLabel}"]`).first().click();
    await waitUntil("the chat's chip again", async () =>
      (await chip(page).count()) === 1 ? true : null,
    );
    await chipAction(page, "Hide");
    await waitUntil("one strip tab", async () => (await browserStripTabs(page).count()) === 1);
    const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
    return {
      ok: marks.toSorted().join(",") === "session,user" && mine?.presentation === "headless",
      detail: `marks=${JSON.stringify(marks)} presentation=${mine?.presentation}`,
    };
  });

  await must(
    5,
    "Close removes it from the chat and the host; the other Session's tab and the person's stand",
    async () => {
      await chipAction(page, "Close");
      await waitUntil("the chip to disappear", async () =>
        (await chip(page).count()) === 0 ? true : null,
      );
      const tabs = await hostTabs(app);
      const errorToasts = await page.getByText(/Could not (show|hide|open|close) Browser Tab/i).count();
      return {
        ok:
          tabs.filter((tab) => tab.ownerSessionId === sessionId).length === 0 &&
          tabs.some((tab) => tab.ownerSessionId === "another-session") &&
          tabs.some((tab) => tab.createdBy === "user") &&
          errorToasts === 0 &&
          pageErrors.length === 0,
        detail: `tabs=${JSON.stringify(tabs.map((tab) => [tab.createdBy, tab.ownerSessionId, tab.presentation]))} errorToasts=${errorToasts} pageErrors=${JSON.stringify(pageErrors)}`,
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
  await fixture.stop().catch(() => {});
  await cleanup();
}
process.exit(code);
