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
 *   2. The Sessions nav item is gone; the nav is Home / Files / Configure.
 *   3. "+ New Session" opens a Project Session tab beside the Board, and the
 *      Board tab is not closable.
 *   4. Selecting the Board tab returns to the board with the Session tab still
 *      on the strip — and the terminal under it is never unmounted.
 *   5. Opening a ticket HIDES the Home strip; leaving the ticket restores it,
 *      with the Session tab still there.
 *   6. Switching to Files and back keeps the same live terminal mounted (the
 *      keep-alive seam CLAUDE.md protects).
 *   7. Relaunch: the terminal tab is gone with its PTY and Home falls back to
 *      the permanent Board tab, rather than to a stranded empty surface.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/home-taxonomy-smoke.mjs
 */
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
  await page.getByRole("button", { name: "Other session kinds", exact: true }).first().click();
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

  await attempt(2, "the nav is Home / Files / Configure — the Sessions page is gone", async () => {
    const sessions = await page.getByRole("button", { name: "Sessions", exact: true }).count();
    const home = await page.getByRole("button", { name: "Home", exact: true }).count();
    const board = await page.getByRole("button", { name: "Board", exact: true }).count();
    return {
      ok: sessions === 0 && home === 1 && board === 0,
      detail: `sessionsNav=${sessions} homeNav=${home} boardNav=${board}`,
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

  await attempt(6, "a nav round trip to Files unmounts no live terminal", async () => {
    const before = await terminalCanvasCount(page);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const duringFiles = await terminalCanvasCount(page);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await waitUntil("Home's strip to come back", async () => (await strip(page).count()) > 0);
    const after = await terminalCanvasCount(page);
    return {
      ok: before > 0 && duringFiles === before && after === before,
      detail: `panes ${before} → files:${duringFiles} → ${after}`,
    };
  });

  await app.close();

  const app2 = await launch({ dbPath, userDataDir });
  try {
    page = await app2.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await attempt(
      7,
      "relaunch: the dead terminal tab is gone and Home falls back to the Board tab",
      async () => {
        await waitUntil("Home's strip to mount", async () => (await strip(page).count()) > 0);
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
