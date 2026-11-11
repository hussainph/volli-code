/**
 * Acceptance smoke for headless agent Browser Tabs (VC-238, driven from the
 * Activity Island since VC-268), against the BUILT app:
 * headless → open beside chat → close/Undo → show and group → hide → close.
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
 *   2. Open beside chat opens it in the chat's tab group, the chat's pane split
 *      with the browser on its right (VC-614) — never a miniature preview; the
 *      person's tab stays where it was in the same group;
 *   3. Close hides it without changing its page or owner, and Undo restores it;
 *   4. Show tab SELECTS it — full width while it is ordinary, never pulled into
 *      a group. A tab-edge drop onto the person's tab groups the two browsers,
 *      attaching both native views together, and Show tab then shows that
 *      group. Hide to Island, in the browser's own chrome (VC-1118), takes it
 *      back out of the strip and its group, headless with its page and owner,
 *      and the Island offers Open beside chat again, which brings it back;
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
  sleep,
  tabStrip,
  waitUntil,
} from "./lib/smoke-kit.mjs";
import { readChipRows, selectStripTab } from "./lib/strip-tabs.mjs";

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

// The TOP strip holds ordinary tabs and one chip per group (VC-1052). A chip
// draws ONE tab — main's direct group tab, labeled from the group — and
// carries its front's `data-strip-tab-id` (plus the front's
// `data-pair-target-id` where edge drops aim at it); the member tabs are only
// rows of its popover (`data-tab-id`). A shown group's panes also draw strips
// of their own, so every probe here is scoped to the top strip.
const browserStripTabs = (page) => tabStrip(page, HOME_TAB_STRIP).getByTestId("home-browser-tab");
/**
 * A chat's top-strip tab: an ordinary tab, or a chip whose front it is.
 * Identity survives auto-title and SessionGlyph names.
 */
const chatStripTab = (page, sessionId) =>
  tabStrip(page, HOME_TAB_STRIP)
    .locator(`[data-strip-tab-id="chat:${sessionId}"]`)
    .getByRole("tab");
const groupChips = (page) =>
  tabStrip(page, HOME_TAB_STRIP).locator('[data-slot="grouped-tab-chip"]');
const activeGroup = (page) =>
  tabStrip(page, HOME_TAB_STRIP).locator('[data-slot="grouped-tab-chip"][data-active="true"]');

/** The shown group's members, from its chip's popover rows (`[]` with none shown). */
async function activeGroupRows(page) {
  if ((await activeGroup(page).count()) === 0) return [];
  return readChipRows(page, activeGroup(page).first());
}

/**
 * How many Browser Tabs the top strip HOLDS: its ordinary browser tabs, plus
 * every group's browser members (popover rows `browser:<id>`), whichever
 * member a chip happens to front.
 */
async function stripBrowserCount(page) {
  const ordinary = await browserStripTabs(page).evaluateAll(
    (tabs) => tabs.filter((tab) => tab.closest('[data-slot="grouped-tab-chip"]') === null).length,
  );
  let grouped = 0;
  for (const groupId of await groupChips(page).evaluateAll((chips) =>
    chips.map((chip) => chip.getAttribute("data-group-id")),
  )) {
    const rows = await readChipRows(
      page,
      groupChips(page).and(page.locator(`[data-group-id="${groupId}"]`)),
    );
    grouped += rows.filter((row) => row.id?.startsWith("browser:")).length;
  }
  return ordinary + grouped;
}

/**
 * Whether the shown group is the chat's, three panes wide (three pane fronts),
 * with the chat still the front of its pane and the agent's browser a member.
 */
async function besideChat(page, sessionId, agentTabId) {
  const rows = await activeGroupRows(page);
  return (
    rows.filter((row) => row.front).length === 3 &&
    rows.some((row) => row.id === `chat:${sessionId}` && row.front) &&
    rows.some((row) => row.id === `browser:${agentTabId}`)
  );
}

/** Select the owning chat's tab: on the strip, or from its group chip's popover. */
const selectChat = (page, sessionId) =>
  selectStripTab(
    page,
    { tab: chatStripTab(page, sessionId), id: `chat:${sessionId}` },
    { strip: tabStrip(page, HOME_TAB_STRIP) },
  );
/** How many shown panes draw a strip of their own. */
const paneStrips = (page) =>
  page
    .locator('[data-slot="split-view-pane"] [data-slot="tab-strip"]')
    .filter({ visible: true })
    .count();
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
  // A row can remain mounted during the popover's exit. Open the glance,
  // then use its explicit pin control and observe the pin receipt before
  // moving off the cluster toward the row's hover-only actions.
  await tabsCluster(page).hover();
  const card = page.locator('[data-island-card="tabs"][data-state="open"]');
  await card.waitFor({ state: "visible" });
  const pin = card.locator("[data-island-pin]");
  if ((await pin.getAttribute("aria-pressed")) !== "true") await pin.click();
  const row = card.locator(`[data-island-row="${tabId}"]`);
  await waitUntil("the tab's row in the pinned, open card", async () =>
    (await pin.getAttribute("aria-pressed")) === "true" && (await row.isVisible()) ? true : null,
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
  await page.mouse.move(0, 0);
  await waitUntil(
    "the reveal card to leave the screen",
    async () => (await tabsCard(page).filter({ visible: true }).count()) === 0,
  );
}

/** Keep the failing transition's evidence, before another action changes it. */
async function waitForReveal(label, page, app, predicate) {
  try {
    return await waitUntil(label, predicate);
  } catch (error) {
    const renderer = await page.evaluate(() => ({
      activeGroups: Array.from(
        document.querySelectorAll('[data-slot="grouped-tab-chip"][data-active="true"]'),
        (node) => node.getAttribute("data-group-id"),
      ),
      selectedTabs: Array.from(
        document.querySelectorAll('[data-strip-tab-id]:has([role="tab"][aria-selected="true"])'),
        (node) => node.getAttribute("data-strip-tab-id"),
      ),
      panes: Array.from(document.querySelectorAll('[data-slot="split-view-pane"]'), (node) => ({
        id: node.getAttribute("data-pane-id"),
        focused: node.getAttribute("data-focused"),
      })),
      focus: document.activeElement?.outerHTML.slice(0, 500),
      overlays: Array.from(
        document.querySelectorAll(
          '[data-slot="hover-card-content"], [data-slot="popover-content"], [role="dialog"], [role="menu"], [role="tooltip"]',
        ),
      )
        .filter((node) => node.checkVisibility())
        .map((node) => ({
          slot: node.getAttribute("data-slot"),
          state: node.getAttribute("data-state"),
          bounds: node.getBoundingClientRect().toJSON(),
        })),
    }));
    throw new Error(
      `${error.message}; renderer=${JSON.stringify(renderer)}; attached=${JSON.stringify(await attachedViews(app))}`,
      { cause: error },
    );
  }
}

/** The reveal the tab's Island row offers right now, read from a pinned card. */
async function islandRevealLabel(page, tabId) {
  const row = await pinTabsCard(page, tabId);
  const label = await row.getAttribute("aria-label");
  await page.keyboard.press("Escape");
  return label;
}

/** Close hides immediately, offers Undo, and destroys only after that window. */
async function closeFromCard(page, tabId) {
  const row = await pinTabsCard(page, tabId);
  await row.hover();
  await row.locator("..").getByRole("button", { name: "Close tab", exact: true }).click();
  await page.keyboard.press("Escape");
}

/** The agent browser's tab in its group pane's own strip. */
const agentPaneTab = (page) =>
  page
    .locator('[data-slot="split-view-pane"] > [data-slot="tab-strip"]')
    .getByTestId("home-browser-tab")
    .filter({ has: page.locator('[data-browser-tab-mark="session"]') })
    .first();

/** Drag a pane strip's tab up onto the top strip, past its tabs: it leaves its group. */
async function ungroupByDrag(page, paneTab) {
  await paneTab.scrollIntoViewIfNeeded();
  const from = await paneTab.boundingBox();
  const bar = await page.locator('[data-slot="split-view-tab-bar"]').first().boundingBox();
  if (from === null || bar === null) throw new Error("no bounds to drag a tab out of its group");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, {
      steps: 4,
    });
    await page.mouse.move(bar.x + bar.width * 0.6, bar.y + bar.height / 2, { steps: 12 });
    await page.mouse.move(bar.x + bar.width * 0.6, bar.y + bar.height / 2, { steps: 2 });
  } finally {
    await page.mouse.up();
  }
  await waitUntil(
    "the dragged tab to leave its group",
    async () => (await page.locator('[data-slot="split-view-pane"][data-pane-id]').count()) === 1,
    { timeout: 6000 },
  );
  await dragSettled(page);
}

/**
 * Select the owning chat's top-strip tab, so its pane — and the Island above
 * its composer, the only place a headless tab is reached from — is on screen.
 */
async function showOwningChat(page, sessionId) {
  await selectChat(page, sessionId);
  await waitUntil("the chat's Island", async () =>
    (await tabsCluster(page).count()) === 1 ? true : null,
  );
}

/**
 * A drag's tail. dnd-kit's pointer sensor stops every `click` for 50ms after a
 * drag ends (so the release is not also a click), and its ghost flies home
 * over 150ms: a click the smoke sends sooner is eaten, which a hand never is.
 */
async function dragSettled(page) {
  await waitUntil("the drag ghost to land", async () =>
    (await page.getByTestId("tab-drag-ghost").count()) === 0 ? true : null,
  );
  await sleep(100);
}

/** Whether the focused pane's front tab is the agent's (Session-marked) browser. */
function focusedPaneFrontsAgent(page) {
  return page.evaluate(
    () =>
      document.querySelector(
        '[data-slot="split-view-pane"][data-focused="true"] > [data-slot="tab-strip"] [data-testid="home-browser-tab"][aria-selected="true"] [data-browser-tab-mark="session"]',
      ) !== null,
  );
}

/** Exercise the real top-strip tab-edge grouping gesture; no store or layout injection. */
async function groupBrowsers(page, agentTab, personTab) {
  await agentTab.scrollIntoViewIfNeeded();
  const from = await agentTab.boundingBox();
  if (from === null) throw new Error("browser source tab has no bounds");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, {
      steps: 4,
    });
    // Activation can scroll an overflowing strip. Aim at its current visible
    // wrapper, not a pre-drag child rectangle displaced by that scroll.
    await personTab.scrollIntoViewIfNeeded();
    const to = await personTab.evaluate((tab) => {
      const box = tab.closest("[data-pair-target-id]")?.getBoundingClientRect();
      return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
    });
    if (to === null) throw new Error("browser group target has no bounds");
    await page.mouse.move(to.x + to.width * 0.9, to.y + to.height / 2, { steps: 12 });
    await waitUntil("browser tab's right-edge grouping preview", () =>
      personTab.evaluate(
        (tab) =>
          tab.closest("[data-pair-target-id]")?.getAttribute("data-pair-drop-edge") === "right",
      ),
    ).catch(async (error) => {
      const geometry = await personTab.evaluate((tab) => ({
        child: tab.getBoundingClientRect().toJSON(),
        wrapper: tab.closest("[data-pair-target-id]")?.getBoundingClientRect().toJSON(),
        transform: getComputedStyle(tab).transform,
        scrollLeft: tab.closest('[data-slot="tab-scroll"]')?.scrollLeft,
      }));
      throw new Error(
        `${error.message}; target=${JSON.stringify(to)} actual=${JSON.stringify(geometry)}`,
      );
    });
  } finally {
    await page.mouse.up();
  }
  // A group now has a hover inventory. Leave the trigger after dropping:
  // an open inventory correctly fences native Browser planes underneath it.
  await page.mouse.move(0, 0);
  await dragSettled(page);
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
  // reachable beside a browser/chat group, not just on a developer display.
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
  await selectStripTab(page, { tab: browserStripTabs(page) });
  await waitUntil(
    "the person's plane",
    async () => (await attachedViews(app)).includes(personUrl),
    {
      timeout: 20000,
    },
  );

  // A group of the person's tab over a chat. Since VC-358 a New chat is a
  // provisional Draft, not a Session — so Send one message to promote it:
  // promotion mints the durable row (and its id, which is what the agent tab
  // is owned by) before the turn runs, and the turn itself fails on the
  // placeholder key, which nothing below depends on. The group is what lets
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
  // The chat tab is up once the group's chip fronts it: its pane is the focused
  // one, and a shown chip fronts its focused member. Its name is deliberately
  // not captured: the Session is named from its first message moments from
  // now, so a label read here can still be the fallback "Chat" by the time the
  // tab is clicked below.
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
      // The person's tab is in the group (behind the chat the chip fronts); the
      // agent's must be in no strip at all.
      const stripCount = await stripBrowserCount(page);
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
    "Open beside chat splits the owning chat's pane in its group, with no miniature preview",
    async () => {
      const groupId = await activeGroup(page).getAttribute("data-group-id");
      await showBeside(page, agentTabId, "Open beside chat");
      const state = await waitUntil(
        "the browser to attach beside its owning chat",
        async () => {
          const mine = (await hostTabs(app)).find((tab) => tab.ownerSessionId === sessionId);
          const attached = await attachedViews(app);
          return mine?.presentation === "tab" &&
            attached.includes(agentUrl) &&
            attached.includes(personUrl) &&
            (await besideChat(page, sessionId, agentTabId))
            ? { mine, attached }
            : null;
        },
        { timeout: 20000 },
      );
      // The chat and the browser beside it share a row: the browser on its right.
      const beside = await page.evaluate(() => {
        const cells = Array.from(
          document.querySelectorAll('[data-slot="split-view-pane"][data-pane-id]'),
        );
        const holding = (mark) =>
          cells.find((cell) =>
            cell.querySelector(
              `:scope > [data-slot="tab-strip"] [data-browser-tab-mark="${mark}"]`,
            ),
          );
        const agent = holding("session");
        const person = holding("user");
        const chat = cells.find((cell) => cell !== agent && cell !== person);
        if (!agent || !chat) return false;
        const a = agent.getBoundingClientRect();
        const c = chat.getBoundingClientRect();
        return a.x > c.x && Math.abs(a.y - c.y) < 2;
      });
      return {
        ok:
          (await preview(page).count()) === 0 &&
          state.mine.ownerSessionId === sessionId &&
          (await activeGroup(page).getAttribute("data-group-id")) === groupId &&
          (await stripBrowserCount(page)) === 2 &&
          (await paneStrips(page)) === 3 &&
          beside,
        detail: `attached=${JSON.stringify(state.attached)} owner=${state.mine.ownerSessionId} strip=${await stripBrowserCount(page)} paneStrips=${await paneStrips(page)} beside=${beside}`,
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
          (await stripBrowserCount(page)) === 2 &&
          (await hostTabs(app)).some((tab) => tab.createdBy === "user" && tab.url === personUrl) &&
          (await preview(page).count()) === 0,
        detail: `before=${JSON.stringify(before)} hidden=${JSON.stringify(after)} restored=${JSON.stringify(restored)}`,
      };
    },
  );

  await must(
    4,
    "Show tab selects without grouping; a tab-edge drop groups both browsers; Show tab then shows that group; Hide to Island takes it out of the strip and group, and Open beside chat brings it back",
    async () => {
      await selectChat(page, sessionId);
      const groupId = await activeGroup(page).getAttribute("data-group-id");
      // Close and Undo kept the tab in its pane beside the chat: Show tab shows
      // that group, with the browser's pane in focus.
      await showBeside(page, agentTabId, "Show tab");
      const grouped = await waitForReveal(
        "Show tab to show the browser's group",
        page,
        app,
        async () =>
          (await activeGroup(page).getAttribute("data-group-id")) === groupId &&
          (await attachedViews(app)).includes(agentUrl),
      );
      // Dragged from its pane's strip up to the top strip, it leaves the group;
      // Show tab now SELECTS it full width and never pulls it back in. The
      // Island lives above its chat's composer, so the chat — chosen from its
      // group chip's popover — is what brings it back on screen to ask from.
      await ungroupByDrag(page, agentPaneTab(page));
      await showOwningChat(page, sessionId);
      await showBeside(page, agentTabId, "Show tab");
      // Selection and native attachment are different receipts. A correctly
      // selected Browser may still be yielding its native plane to an overlay;
      // do not collapse both into selected=false and then destroy the evidence
      // by carrying on with the next drag.
      const ordinarySelected = async () =>
        (await activeGroup(page).count()) === 0 &&
        (await page.locator('[data-slot="split-view-pane"][data-pane-id]').count()) === 1 &&
        (await browserStripTabs(page)
          .filter({ has: page.locator('[data-browser-tab-mark="session"]') })
          .getAttribute("aria-selected")) === "true";
      const selected = await waitForReveal(
        "Show tab to select the ordinary browser full width",
        page,
        app,
        ordinarySelected,
      );
      await waitForReveal(
        "the selected ordinary browser's native plane to attach",
        page,
        app,
        async () => (await ordinarySelected()) && (await attachedViews(app)).includes(agentUrl),
      );
      // The person's browser is folded into its group's chip while the agent
      // tab is full width. Its popover rows — real rows, not hidden tab DOM —
      // prove it still belongs to that group before the edge drop.
      const targetGroup = page.locator(
        `[data-slot="grouped-tab-chip"][data-group-id="${groupId}"]`,
      );
      const memberIds = (await readChipRows(page, targetGroup)).map((row) => row.id);
      const person = (await hostTabs(app)).find((tab) => tab.createdBy === "user");
      if (!person || !memberIds.includes(`browser:${person.tabId}`))
        throw new Error(`person's browser missing from group: ${JSON.stringify(memberIds)}`);
      const marks = (await hostTabs(app))
        .filter((tab) => tab.presentation === "tab")
        .map((tab) => (tab.createdBy === "session" ? "session" : "user"));
      const agentTab = browserStripTabs(page).filter({
        has: page.locator('[data-browser-tab-mark="session"]'),
      });
      const personTab = targetGroup;
      await groupBrowsers(page, agentTab, personTab);
      const both = await waitUntil("both native browser planes in one group", async () => {
        const attached = await attachedViews(app);
        return attached.includes(agentUrl) &&
          attached.includes(personUrl) &&
          (await activeGroup(page).getAttribute("data-group-id")) === groupId &&
          (await activeGroupRows(page)).filter((row) => row.id?.startsWith("browser:")).length === 2
          ? attached
          : null;
      }).catch(async (error) => {
        throw new Error(
          `${error.message}; attached=${JSON.stringify(await attachedViews(app))}; host=${JSON.stringify(await hostTabs(app))}; groups=${JSON.stringify(await page.locator('[data-slot="grouped-tab-chip"]').evaluateAll((chips) => chips.map((chip) => ({ id: chip.getAttribute("data-group-id"), active: chip.getAttribute("data-active"), target: chip.getAttribute("data-pair-target-id") }))))}; strips=${await browserStripTabs(page).count()}`,
        );
      });
      // Focus back on the chat, then Show tab: a grouped tab shows its group,
      // with the browser's pane in focus.
      await showOwningChat(page, sessionId);
      await showBeside(page, agentTabId, "Show tab");
      const reusedGroupId = await waitUntil("Show tab to show the browser's group", async () =>
        (await focusedPaneFrontsAgent(page))
          ? activeGroup(page)
              .getAttribute("data-group-id")
              .catch(() => null)
          : null,
      );
      const before = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
      const panesBefore = await page.locator('[data-slot="split-view-pane"][data-pane-id]').count();
      // The way back (VC-1118): the agent's own chrome, and only the agent's —
      // the person's browser beside it offers no such control.
      const hide = page.getByRole("button", { name: "Hide to Island", exact: true });
      const hideControls = await hide.count();
      await hide.click();
      const mine = await waitUntil(
        "the tab to leave the strip and its group and return headless",
        async () => {
          const found = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
          const attached = await attachedViews(app);
          return found?.presentation === "headless" &&
            (await stripBrowserCount(page)) === 1 &&
            (await page.locator('[data-slot="split-view-pane"][data-pane-id]').count()) ===
              panesBefore - 1 &&
            !attached.includes(agentUrl) &&
            attached.includes(personUrl)
            ? found
            : null;
        },
      ).catch(async (error) => {
        throw new Error(
          `${error.message}; attached=${JSON.stringify(await attachedViews(app))}; host=${JSON.stringify(await hostTabs(app))}; strips=${await stripBrowserCount(page)}; panes=${await page.locator('[data-slot="split-view-pane"][data-pane-id]').count()}; overlays=${await page.locator('[data-slot="hover-card-content"], [data-slot="dropdown-menu-content"]').evaluateAll((elements) => elements.map((e) => e.outerHTML.slice(0, 300)))}`,
        );
      });
      // The group it left is still the one on screen, chat and all, so the
      // Island above the chat lists the tab again with its first reveal.
      const offered = await islandRevealLabel(page, agentTabId);
      await showBeside(page, agentTabId, "Open beside chat");
      const back = await waitUntil(
        "Open beside chat to bring the hidden tab back beside its chat",
        async () => {
          const found = (await hostTabs(app)).find((tab) => tab.tabId === agentTabId);
          return found?.presentation === "tab" &&
            (await attachedViews(app)).includes(agentUrl) &&
            (await stripBrowserCount(page)) === 2 &&
            (await activeGroupRows(page)).some((row) => row.id === `chat:${sessionId}`)
            ? found
            : null;
        },
        { timeout: 20000 },
      );
      return {
        ok:
          grouped !== false &&
          selected !== false &&
          groupId !== null &&
          groupId === reusedGroupId &&
          marks.toSorted().join(",") === "session,user" &&
          hideControls === 1 &&
          mine.ownerSessionId === sessionId &&
          mine.generation === before.generation &&
          mine.url === before.url &&
          offered === "Open beside chat: Agent Fixture" &&
          back.ownerSessionId === sessionId &&
          back.generation === before.generation &&
          (await preview(page).count()) === 0,
        detail: `grouped=${grouped} selected=${selected} marks=${JSON.stringify(marks)} reusedGroup=${groupId === reusedGroupId} both=${JSON.stringify(both)} hideControls=${hideControls} presentation=${mine.presentation} offered=${JSON.stringify(offered)} back=${back.presentation}`,
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
