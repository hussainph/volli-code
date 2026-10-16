/**
 * Acceptance smoke for headless agent Browser Tabs (VC-238, driven from the
 * Activity Island since VC-268), against the BUILT app:
 * headless → open beside chat → close/Undo → show existing pair → close.
 *
 * A Session-owned tab is born headless — in no strip, attached to no window —
 * and the only place a person sees it is the chat that owns it: the island
 * above its composer. This smoke opens one the way the Browser port does
 * (through the host, behind the `VOLLI_SMOKE_BROWSER_HOST` door). The owning
 * chat is promoted with one real Send — its turn fails on the placeholder key
 * below, which is fine: this smoke never needs an answer, only the durable
 * id — then drives every presentation from the person's side:
 *
 *   1. the island's tabs cluster counts it, it is in NO strip, and no native
 *      view is attached;
 *   2. Open beside chat reveals a grouped chat/browser pair, never a miniature
 *      preview; the person's tab remains available in the area strip;
 *   3. Close hides it without changing its page or owner, and Undo restores it;
 *   4. Show tab focuses the existing pair. An explicit browser/browser pair
 *      attaches both native views together, then the chat's row restores its
 *      own pair. The compatibility hide bridge still preserves agent state;
 *   5. Close removes the row immediately, destroys the tab after five seconds,
 *      and leaves the other Session's tab and the person's tab alone.
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

// One area strip holds both ordinary tabs and grouped pair members.
const browserStripTabs = (page) => page.getByTestId("home-browser-tab");
/** Tabs live in the area strip, not inside pair panes. Identity survives auto-title and SessionGlyph names. */
const chatStripTab = (page, sessionId) =>
  tabStrip(page, HOME_TAB_STRIP)
    .locator(`[data-pair-target-id="chat:${sessionId}"]`)
    .getByRole("tab");
const activePair = (page) => page.locator('[data-slot="grouped-tab-chip"][data-active="true"]');
const island = (page) => page.locator("[data-activity-island]");
const tabsCluster = (page) => page.locator('[data-island-cluster="tabs"]');
const tabsCount = (page) => tabsCluster(page).locator("[data-island-count]");
/** The tabs card is a Radix portal, so it is found page-wide, never under the pill. */
const tabsCard = (page) => page.locator('[data-island-card="tabs"]');
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

/** Pins the island's tabs card open and hands back the one row it lists. */
async function pinTabsCard(page, tabId) {
  await tabsCluster(page).click();
  const row = tabsCard(page).locator(`[data-island-row="${tabId}"]`);
  await waitUntil("the tab's row in the pinned card", async () =>
    (await row.count()) === 1 ? true : null,
  );
  return row;
}

/** The title-first row and its one reveal control share the same action. */
async function showBeside(page, tabId, label) {
  const row = await pinTabsCard(page, tabId);
  await waitUntil(
    "the fixture title in the Island row",
    async () => (await row.getAttribute("aria-label")) === `${label}: Agent Fixture`,
  );
  const titleFirst = await row.textContent();
  const accessible = await row.getAttribute("aria-label");
  if (!titleFirst?.includes("Agent Fixture") || accessible !== `${label}: Agent Fixture`) {
    throw new Error(`unexpected Island row: ${JSON.stringify({ titleFirst, accessible })}`);
  }
  const reveal = row.locator("..").getByRole("button", { name: label, exact: true });
  if ((await reveal.count()) !== 1) throw new Error("Island row must have one reveal action");
  // Cover both advertised targets: Open beside chat's control and Show tab's
  // title-first row activation, rather than relying on a decorative label.
  if (label === "Show tab") await row.click();
  else await reveal.click();
  await page.keyboard.press("Escape");
}

/** Close hides immediately, offers Undo, and destroys only after that window. */
async function closeFromCard(page, tabId) {
  const row = await pinTabsCard(page, tabId);
  await row.hover();
  await row.locator("..").getByRole("button", { name: "Close tab", exact: true }).click();
  await page.keyboard.press("Escape");
}

/** Exercise the real tab-edge pairing gesture; no store or layout injection. */
async function pairBrowsers(page, agentTab, personTab) {
  const from = await agentTab.boundingBox();
  const to = await personTab.boundingBox();
  if (from === null || to === null) throw new Error("browser pair tabs have no bounds");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, {
      steps: 4,
    });
    await page.mouse.move(to.x + to.width * 0.9, to.y + to.height / 2, { steps: 12 });
    await waitUntil("browser tab's right-edge pairing preview", () =>
      personTab.evaluate(
        (tab) =>
          tab.closest("[data-pair-target-id]")?.getAttribute("data-pair-drop-edge") === "right",
      ),
    );
  } finally {
    await page.mouse.up();
  }
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
      // one is not a key: the owning chat below is promoted with one real
      // Send, whose turn fails on it — no answer is ever needed, only the
      // durable Session the first Send mints, so nothing billable ever runs.
      ANTHROPIC_API_KEY: "volli-smoke-placeholder-never-sent",
    },
  });
  await assertProfileIsolated(app, userDataDir);

  const page = await app.firstWindow();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  // Keep the short-window collision regression: Island controls must remain
  // reachable with a full browser/chat pair, not just on a developer display.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    window?.setSize(1000, 700);
  });
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
  await seedDefaultModel(page);
  await waitUntil("Home tab strip", async () =>
    (await tabStrip(page, HOME_TAB_STRIP).count()) === 1 ? true : null,
  );

  // The person's own tab, through the real bridge, front in the first pane.
  await page.evaluate(({ projectId, url }) => window.api.browser.open({ projectId, url }), {
    projectId: PROJECT.id,
    url: personUrl,
  });
  await waitUntil(
    "the person's strip tab",
    async () => (await browserStripTabs(page).count()) === 1,
  );
  await browserStripTabs(page).first().click();
  await waitUntil(
    "the person's plane",
    async () => (await attachedViews(app)).includes(personUrl),
    {
      timeout: 20000,
    },
  );

  // A second pane with a chat in it. Since VC-358 a New chat is a
  // provisional Draft, not a Session — so Send one message to promote it:
  // promotion mints the durable row (and its id, which is what the agent tab
  // is owned by) before the turn runs, and the turn itself fails on the
  // placeholder key, which nothing below depends on. The split is what lets
  // the chat and the person's tab share the screen, which is the
  // multi-attach proof below.
  await page.keyboard.press("Shift+Meta+\\");
  await waitUntil("the empty pane", async () =>
    (await focusedEmptyRow(page, "New chat").count()) === 1 ? true : null,
  );
  await focusedEmptyRow(page, "New chat").click();
  const composer = page.getByPlaceholder("Ask, plan, or implement…").first();
  await composer.click();
  await composer.fill("own the agent tab");
  await page.keyboard.press("Enter");
  const sessionId = await waitUntil("the chat Session id", async () => {
    const result = await page.evaluate(
      (projectId) => window.api.sessions.list({ projectId }),
      PROJECT.id,
    );
    const chat = result.ok ? result.sessions.find((row) => row.kind === "chat") : undefined;
    return chat?.record.sessionId ?? null;
  });
  // The chat tab is up once the focused pane's strip holds one. Its name is
  // deliberately not captured: the Session is named from its first message
  // moments from now, so a label read here can still be the fallback "Chat"
  // by the time the tab is clicked below.
  await waitUntil("the chat tab", async () =>
    (await chatStripTab(page, sessionId).count()) === 1 ? true : null,
  );

  let agentTabId = null;
  await must(
    1,
    "an agent tab is born headless: counted by the island's tabs cluster, in no strip, attached nowhere",
    async () => {
      const opened = await app.evaluate(
        (_electron, input) => {
          const host = globalThis.volliBrowserHost;
          return [
            host.open({ ...input, ownerSessionId: input.owner }),
            host.open({ ...input, ownerSessionId: "another-session" }),
          ].map((tab) => ({ tabId: tab.tabId, presentation: tab.presentation }));
        },
        {
          url: agentUrl,
          projectId: PROJECT.id,
          ticketId: null,
          createdBy: "session",
          owner: sessionId,
        },
      );
      agentTabId = opened[0].tabId;
      await waitUntil("the island's tabs cluster", async () =>
        (await tabsCount(page)
          .getAttribute("data-island-count")
          .catch(() => null)) === "1"
          ? true
          : null,
      );
      const stripCount = await browserStripTabs(page).count();
      const attached = await attachedViews(app);
      return {
        ok:
          opened.every((tab) => tab.presentation === "headless") &&
          stripCount === 1 &&
          (await preview(page).count()) === 0 &&
          !attached.includes(agentUrl),
        detail: `opened=${JSON.stringify(opened)} strip=${stripCount} attached=${JSON.stringify(attached)}`,
      };
    },
  );

  await must(
    2,
    "Open beside chat reveals the owner/browser pair in the area strip, with no miniature preview",
    async () => {
      await showBeside(page, agentTabId, "Open beside chat");
      const state = await waitUntil(
        "the browser to attach beside its owning chat",
        async () => {
          const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
          const attached = await attachedViews(app);
          return mine?.presentation === "tab" &&
            attached.includes(agentUrl) &&
            (await activePair(page).getByRole("tab").count()) === 2 &&
            (await activePair(page)
              .locator(`[data-pair-target-id="chat:${sessionId}"]`)
              .count()) === 1
            ? { mine, attached }
            : null;
        },
        { timeout: 20000 },
      );
      return {
        ok:
          (await preview(page).count()) === 0 &&
          state.mine.ownerSessionId === sessionId &&
          (await browserStripTabs(page).count()) === 2 &&
          (await page.locator('[data-slot="split-view-pane"] [role="tablist"]').count()) === 0,
        detail: `attached=${JSON.stringify(state.attached)} owner=${state.mine.ownerSessionId} strip=${await browserStripTabs(page).count()}`,
      };
    },
  );

  await must(
    3,
    "Close hides without changing the agent's page; Undo restores the shown owner",
    async () => {
      const before = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
      await closeFromCard(page, agentTabId);
      const after = await waitUntil("the tab to leave the screen", async () => {
        const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
        const attached = await attachedViews(app);
        return mine?.presentation === "headless" && !attached.includes(agentUrl) ? mine : null;
      });
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      const restored = await waitUntil("Undo to restore the same shown tab", async () => {
        const mine = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
        return mine?.presentation === "tab" && (await attachedViews(app)).includes(agentUrl)
          ? mine
          : null;
      });
      return {
        ok:
          after.generation === before.generation &&
          after.url === before.url &&
          after.ownerSessionId === before.ownerSessionId &&
          restored.generation === before.generation &&
          restored.url === before.url &&
          restored.ownerSessionId === sessionId &&
          (await browserStripTabs(page).count()) === 2 &&
          (await hostTabs(app)).some((tab) => tab.createdBy === "user" && tab.url === personUrl) &&
          (await preview(page).count()) === 0,
        detail: `before=${JSON.stringify(before)} hidden=${JSON.stringify(after)} restored=${JSON.stringify(restored)}`,
      };
    },
  );

  await must(
    4,
    "Show tab reuses its marked pair; explicit browser/browser pairing attaches both planes; hiding keeps ownership",
    async () => {
      await chatStripTab(page, sessionId).click();
      const pairId = await activePair(page).getAttribute("data-pair-id");
      await showBeside(page, agentTabId, "Show tab");
      const reusedPairId = await activePair(page).getAttribute("data-pair-id");
      const marks = await browserStripTabs(page).evaluateAll((tabs) =>
        tabs.map((tab) =>
          tab.querySelector("[data-browser-tab-mark]")?.getAttribute("data-browser-tab-mark"),
        ),
      );
      const agentTab = browserStripTabs(page).filter({
        has: page.locator('[data-browser-tab-mark="session"]'),
      });
      const personTab = browserStripTabs(page).filter({
        has: page.locator('[data-browser-tab-mark="user"]'),
      });
      await pairBrowsers(page, agentTab, personTab);
      const both = await waitUntil("both native browser planes in the explicit pair", async () => {
        const attached = await attachedViews(app);
        return attached.includes(agentUrl) &&
          attached.includes(personUrl) &&
          (await activePair(page).getByTestId("home-browser-tab").count()) === 2
          ? attached
          : null;
      });
      await activePair(page).getByRole("button", { name: "Unpair tabs", exact: true }).click();
      await chatStripTab(page, sessionId).click();
      // Show respects an existing pair. Once explicitly unpaired, it pairs the
      // already-shown browser with its owner again rather than duplicating it.
      await showBeside(page, agentTabId, "Show tab");
      await waitUntil(
        "the restored owning pair",
        async () =>
          (await activePair(page).locator(`[data-pair-target-id="chat:${sessionId}"]`).count()) ===
          1,
      );
      const before = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
      // Hide is no longer a miniature-preview control. Retain its compatibility
      // bridge assertion separately from the person's reversible Close journey.
      const hidden = await page.evaluate(
        (tabId) => window.api.browser.setPresentation({ tabId, presentation: "headless" }),
        agentTabId,
      );
      if (!hidden.ok) throw new Error(hidden.error);
      const mine = await waitUntil("the tab to leave the strip and return headless", async () => {
        const found = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
        return found?.presentation === "headless" &&
          (await browserStripTabs(page).count()) === 1 &&
          !(await attachedViews(app)).includes(agentUrl)
          ? found
          : null;
      });
      return {
        ok:
          pairId !== null &&
          pairId === reusedPairId &&
          marks.toSorted().join(",") === "session,user" &&
          mine.ownerSessionId === sessionId &&
          mine.generation === before.generation &&
          mine.url === before.url &&
          (await preview(page).count()) === 0,
        detail: `marks=${JSON.stringify(marks)} reusedPair=${pairId === reusedPairId} both=${JSON.stringify(both)} presentation=${mine.presentation}`,
      };
    },
  );

  await must(
    5,
    "Close from the card removes it from the chat and the host, and the island with it; the other Session's tab and the person's stand",
    async () => {
      await closeFromCard(page, agentTabId);
      await waitUntil("the island to disappear", async () =>
        (await island(page).count()) === 0 ? true : null,
      );
      // The row disappears immediately; destruction waits for the five-second
      // Undo deadline. Poll the host, not an arbitrary sleep or the row alone.
      const tabs = await waitUntil(
        "the closed tab to be destroyed after Undo expires",
        async () => {
          const current = await hostTabs(app);
          return current.some((tab) => tab.tabId === agentTabId) ? null : current;
        },
        { timeout: 10000 },
      );
      const errorToasts = await page
        .getByText(/Could not (show|hide|open|close|restore) Browser Tab/i)
        .count();
      const cardsLeft = await tabsCard(page).count();
      return {
        ok:
          tabs.filter((tab) => tab.ownerSessionId === sessionId).length === 0 &&
          tabs.some((tab) => tab.ownerSessionId === "another-session") &&
          tabs.some((tab) => tab.createdBy === "user") &&
          cardsLeft === 0 &&
          errorToasts === 0 &&
          pageErrors.length === 0,
        detail: `tabs=${JSON.stringify(tabs.map((tab) => [tab.createdBy, tab.ownerSessionId, tab.presentation]))} cards=${cardsLeft} errorToasts=${errorToasts} pageErrors=${JSON.stringify(pageErrors)}`,
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
