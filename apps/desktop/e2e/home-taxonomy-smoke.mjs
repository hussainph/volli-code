/**
 * Acceptance smoke for the tabbed Home (VC-54), against the BUILT app.
 *
 * Home is the ticket workspace's grammar one scope up: a permanent Board tab
 * that cannot be closed, with the project's own Sessions opening beside it, and
 * a ticket that TAKES HOME OVER rather than nesting under its strip. Every
 * check below is one line of that acceptance list, and each is the kind of
 * thing only a real window can answer — visibility, takeover, keep-alive across
 * a switch, and what survives a relaunch.
 *
 * Deliberately NOT a Pi smoke: it uses TERMINAL Sessions throughout, so it needs
 * no model provider, no `~/.pi/agent/auth.json` and no network. The one thing a
 * terminal cannot show is chat restoration, and the persistence check therefore
 * asserts the honest half — a terminal tab does NOT come back (a PTY dies with
 * the app, exactly as for a Ticket) and Home falls back to the Board tab.
 * `pi-project-chat-smoke.mjs` owns the chat-restore half.
 *
 *   1. A fresh profile lands on Home with the Board tab in front, the board
 *      showing, and NO auto-opened Session anywhere (VC-54 scope 2).
 *   2. The Sessions nav item is gone, and Files retired with it (VC-122): the
 *      nav is Home / Configure, nothing else.
 *   3. "+ New Session" opens a Project Session tab beside the Board, and the
 *      Board tab is not closable.
 *   3a. The Home rail's Files page lists and live-watches the Main checkout;
 *       click/double-click preview and pin a Home File tab, whose close returns
 *       to the previously visited Session tab.
 *   3b. Opening a file from a nested folder LEAVES THE NAVIGATOR IN THAT
 *       FOLDER. The rail is rendered from one position in the tree; from two it
 *       would remount on the Session→File switch and reset itself to the
 *       project root, so the click would undo its own browse.
 *   4. Selecting the Board tab returns to the board with the Session tab still
 *      on the strip — and the terminal under it is never unmounted.
 *   5. Opening a ticket HIDES the Home strip; leaving the ticket restores it,
 *      with the Session tab still there.
 *   6. Relaunch: the terminal tab is gone with its PTY and Home falls back to
 *      the permanent Board tab, rather than to a stranded empty surface.
 *
 * A check that used to sit here ("switching to Files and back keeps the same
 * live terminal mounted") retired with VC-122's primary-nav removal: it
 * proved Home's flat navigator and the (now-gone) primary sidebar tree shared
 * one ref-counted directory watch without one's cleanup silencing the
 * other's. With the tree gone, a main-checkout root watch has exactly one
 * consumer left — this rail's own Files page — so there is no second
 * consumer left to prove survives. Check 3a's live-root-listing assertion
 * already covers what remains true: the panel's own watch fires while it is
 * mounted.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/home-taxonomy-smoke.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  tabStrip,
  waitUntil,
  HOME_TAB_STRIP,
} from "./lib/smoke-kit.mjs";

const PROJECT = { id: "home-taxonomy-project", name: "Home Taxonomy", prefix: "HT" };
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-home-taxonomy-");

let checks = 0;
let failures = 0;

async function attempt(n, label, run) {
  checks += 1;
  try {
    const { ok, detail } = await run();
    if (ok) {
      console.log(`PASS ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
      return;
    }
    failures += 1;
    console.error(`FAIL ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${n}. ${label} — threw: ${error?.message ?? error}`);
  }
}

const strip = (page) => tabStrip(page, HOME_TAB_STRIP);
const stripTabLabels = (page) =>
  strip(page)
    .getByRole("tab")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label")));
const boardVisible = async (page) =>
  (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0;
/** Every live restty canvas in the window — the keep-alive probe. */
const terminalCanvasCount = (page) =>
  page.evaluate(() => document.querySelectorAll("[data-terminal-pane-id]").length);

async function startTerminalTab(page) {
  const before = await strip(page).getByRole("tab").count();
  await page.getByRole("button", { name: "Other things to open", exact: true }).first().click();
  await page.getByRole("menuitem", { name: /^Terminal/ }).click();
  await waitUntil(
    "a Project Session terminal tab to appear",
    async () => (await strip(page).getByRole("tab").count()) > before,
    { timeout: 20000 },
  );
}

try {
  const projectPath = await makeGitRepo(scratch, "home-taxonomy-");
  const app = await launch({ dbPath, userDataDir });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await seedProjects(page, [{ ...PROJECT, path: projectPath }]);

  // One ticket, seeded through the preload bridge the way every other smoke
  // does it, so check 5 has a card to open. Seeded BEFORE anything else
  // because the board store hydrates at boot: a ticket created later needs a
  // reload to appear, and a reload would take the live terminal checks 4–6 are
  // about with it.
  const seeded = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return { ok: false, error: `bootstrap: ${boot.error}` };
    const project = boot.data.projects[0];
    if (!project) return { ok: false, error: "no project after import" };
    const res = await window.api.tickets.create({
      projectId: project.id,
      status: "todo",
      title: "Takeover check",
      priority: "medium",
    });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  });
  if (!seeded.ok) throw new Error(`ticket seed failed: ${seeded.error}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await attempt(
    1,
    "a fresh profile lands on Home's Board tab with nothing auto-opened",
    async () => {
      await waitUntil("Home's strip to mount", async () => (await strip(page).count()) > 0);
      const labels = await stripTabLabels(page);
      const active = await strip(page)
        .locator('[role="tab"][aria-selected="true"]')
        .getAttribute("aria-label");
      const board = await boardVisible(page);
      // The whole point of scope 2: no Session is ever created that nobody asked
      // for, so the strip holds the Board tab and nothing else.
      return {
        ok: labels.length === 1 && labels[0] === "Board" && active === "Board" && board,
        detail: `tabs=${JSON.stringify(labels)} active=${active} board=${board}`,
      };
    },
  );

  await attempt(2, "the nav is Home / Configure — Sessions and Files are both gone", async () => {
    const sessions = await page.getByRole("button", { name: "Sessions", exact: true }).count();
    const files = await page.getByRole("button", { name: "Files", exact: true }).count();
    const home = await page.getByRole("button", { name: "Home", exact: true }).count();
    const configure = await page.getByRole("button", { name: "Configure", exact: true }).count();
    const board = await page.getByRole("button", { name: "Board", exact: true }).count();
    return {
      ok: sessions === 0 && files === 0 && home === 1 && configure === 1 && board === 0,
      detail: `sessionsNav=${sessions} filesNav=${files} homeNav=${home} configureNav=${configure} boardNav=${board}`,
    };
  });

  await attempt(
    3,
    "+ New Session opens a Project Session tab; the Board tab cannot be closed",
    async () => {
      await startTerminalTab(page);
      const labels = await stripTabLabels(page);
      const boardTab = strip(page).getByRole("tab", { name: "Board" });
      const boardClose = await boardTab.getByTestId("tab-close").count();
      const board = await boardVisible(page);
      return {
        ok: labels.length === 2 && labels[0] === "Board" && boardClose === 0 && !board,
        detail: `tabs=${JSON.stringify(labels)} boardClose=${boardClose} boardShown=${board}`,
      };
    },
  );

  await attempt(
    "3a",
    "the Home rail browses live Project Files; preview/pin tabs close back to the previous Session",
    async () => {
      const terminalTab = strip(page).getByRole("tab").filter({ hasNotText: "Board" }).first();
      const terminalLabel = await terminalTab.getAttribute("aria-label");
      const panesBefore = await terminalCanvasCount(page);

      await page.getByTestId("home-rail-tab-files").click();
      const filesPanel = page.getByTestId("home-files-panel");
      await waitUntil("Home Project Files panel", async () => (await filesPanel.count()) === 1);
      const readme = filesPanel.locator('[data-testid="ticket-files-row"][data-path="README.md"]');
      await waitUntil("README in Home Files", async () => (await readme.count()) === 1);

      // The panel's current level is under a real non-recursive dir watch. A
      // file appearing on disk has to arrive without a manual refresh.
      await fs.writeFile(join(projectPath, "appeared.md"), "# appeared\n", "utf8");
      const appeared = filesPanel.locator(
        '[data-testid="ticket-files-row"][data-path="appeared.md"]',
      );
      await waitUntil("live root listing update", async () => (await appeared.count()) === 1, {
        timeout: 15000,
      });

      await readme.click();
      const fileTab = page.locator('[data-testid="home-file-tab"][data-rel-path="README.md"]');
      await waitUntil(
        "README Home preview tab",
        async () =>
          (await fileTab.count()) === 1 &&
          (await fileTab.getAttribute("data-preview")) === "true" &&
          (await fileTab.getAttribute("aria-selected")) === "true",
      );

      await readme.dblclick();
      await waitUntil(
        "README Home tab pinned",
        async () => (await fileTab.getAttribute("data-preview")) !== "true",
      );
      if (process.env.VOLLI_SMOKE_SCREENSHOT) {
        await page.screenshot({ path: process.env.VOLLI_SMOKE_SCREENSHOT, fullPage: true });
      }

      await fileTab.getByTestId("tab-close").click();
      await waitUntil("README Home tab closed", async () => (await fileTab.count()) === 0);
      const activeAfterClose = await strip(page)
        .locator('[role="tab"][aria-selected="true"]')
        .getAttribute("aria-label");
      const panesAfter = await terminalCanvasCount(page);

      return {
        ok:
          terminalLabel !== null &&
          activeAfterClose === terminalLabel &&
          panesBefore > 0 &&
          panesAfter === panesBefore,
        detail: `return=${activeAfterClose} expected=${terminalLabel} panes=${panesBefore}→${panesAfter}`,
      };
    },
  );

  await attempt(
    "3b",
    "opening a file from a nested folder leaves the Home navigator standing in it",
    async () => {
      await fs.mkdir(join(projectPath, "docs"), { recursive: true });
      await fs.writeFile(join(projectPath, "docs", "guide.md"), "# guide\n", "utf8");

      await page.getByTestId("home-rail-tab-files").click();
      const filesPanel = page.getByTestId("home-files-panel");
      const docsRow = filesPanel.locator('[data-testid="ticket-files-row"][data-path="docs"]');
      await waitUntil("docs folder in Home Files", async () => (await docsRow.count()) === 1, {
        timeout: 15000,
      });

      // Walk INTO the folder: the header's mono line becomes the way back out.
      await docsRow.click();
      const upOut = filesPanel.getByTestId("home-files-up");
      await waitUntil(
        "navigator inside docs/",
        async () => (await upOut.getAttribute("aria-label")) === "Leave docs",
      );

      const guideRow = filesPanel.locator(
        '[data-testid="ticket-files-row"][data-path="docs/guide.md"]',
      );
      await waitUntil("guide.md listed in docs/", async () => (await guideRow.count()) === 1);

      // The regression this guards: opening the file switches the Home tab from
      // a Session to a File, and the rail must survive that switch intact.
      await guideRow.click();
      const guideTab = page.locator('[data-testid="home-file-tab"][data-rel-path="docs/guide.md"]');
      await waitUntil(
        "guide.md Home preview tab",
        async () =>
          (await guideTab.count()) === 1 &&
          (await guideTab.getAttribute("aria-selected")) === "true",
      );

      const stillInside = await upOut.getAttribute("aria-label");
      const siblingStillListed = await guideRow.count();

      await guideTab.getByTestId("tab-close").click();
      await waitUntil("guide.md tab closed", async () => (await guideTab.count()) === 0);

      return {
        ok: stillInside === "Leave docs" && siblingStillListed === 1,
        detail: `navigatorAfterOpen=${stillInside ?? "reset to root"} siblingRows=${siblingStillListed}`,
      };
    },
  );

  await attempt(
    4,
    "the Board tab returns to the board with the Session tab still on the strip",
    async () => {
      const before = await terminalCanvasCount(page);
      await strip(page).getByRole("tab", { name: "Board" }).click();
      await waitUntil("the board to come back", () => boardVisible(page));
      const labels = await stripTabLabels(page);
      const after = await terminalCanvasCount(page);
      // The keep-alive contract: switching tabs flips visibility, never mounting.
      return {
        ok: labels.length === 2 && before > 0 && after === before,
        detail: `tabs=${JSON.stringify(labels)} panes ${before}→${after}`,
      };
    },
  );

  await attempt(
    5,
    "opening a ticket hides the Home strip; leaving it restores the strip and its tabs",
    async () => {
      await page.locator("article").first().dblclick();
      await waitUntil(
        "the ticket workspace to open",
        async () => (await tabStrip(page, "Ticket tabs").count()) > 0,
        { timeout: 20000 },
      );
      // THE decision this ticket turns on: one tab strip on screen, never two.
      const stripHidden = (await strip(page).count()) === 0;

      // Escape leaves the ticket, which is Home's board again — and the strip
      // with it, still carrying the Session tab opened before the ticket.
      await page.keyboard.press("Escape");
      await waitUntil("the board to come back", () => boardVisible(page));
      await waitUntil("Home's strip to come back", async () => (await strip(page).count()) > 0);
      const labels = await stripTabLabels(page);
      return {
        ok: stripHidden && labels.length === 2,
        detail: `stripHiddenInTicket=${stripHidden} tabsAfter=${JSON.stringify(labels)}`,
      };
    },
  );

  // Check 6 used to live here ("a nav round trip to Files unmounts no live
  // terminal") — see the module doc for why it retired with VC-122 rather
  // than being ported: the second watch consumer it cross-checked against is
  // gone.

  // `volli:workspace` writes through a debounced SQLite bridge. Observe the
  // empty File workspace durably before releasing this renderer; otherwise a
  // fast smoke can relaunch against the pinned value written just before Close.
  await waitUntil("closed Home File tab to persist", () =>
    page.evaluate(async (projectId) => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return false;
      const raw = boot.data.appState["volli:workspace"];
      if (typeof raw !== "string") return false;
      const parsed = JSON.parse(raw);
      const record = parsed?.state?.byProject?.[projectId];
      return record === undefined || record?.projectFiles?.tabs?.length === 0;
    }, PROJECT.id),
  );

  await app.close();

  const app2 = await launch({ dbPath, userDataDir });
  try {
    page = await app2.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(
      6,
      "relaunch: the dead terminal tab is gone and Home falls back to the Board tab",
      async () => {
        // This is the SECOND Electron boot of the run, and a cold second launch
        // on a CI runner does not mount Home inside waitUntil's 12s default —
        // it timed out here with last value false. Check 1 uses the default
        // because it runs against an already-warm first launch.
        await waitUntil("Home's strip to mount", async () => (await strip(page).count()) > 0, {
          timeout: 30_000,
        });
        const labels = await stripTabLabels(page);
        const active = await strip(page)
          .locator('[role="tab"][aria-selected="true"]')
          .getAttribute("aria-label");
        const board = await boardVisible(page);
        // Terminals deliberately do NOT restore (VC-54 scope 4): a PTY dies with
        // the app, exactly as for a Ticket workspace. What must not happen is a
        // stranded empty surface — the sanitizer falls back to the Board tab.
        return {
          ok: labels.length === 1 && labels[0] === "Board" && active === "Board" && board,
          detail: `tabs=${JSON.stringify(labels)} active=${active} board=${board}`,
        };
      },
    );
  } finally {
    await app2.close();
  }
} finally {
  await cleanup();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
