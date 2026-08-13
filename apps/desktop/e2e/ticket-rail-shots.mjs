/**
 * Visual proof for the Calm Stack ticket rail.
 *
 * Covers the states the plan asks a shot to answer for: each of the three
 * pages, the repository card on its own, a live session, dark and light, and
 * reduced motion. The failure and empty states are the two it deliberately
 * leaves alone — a real read has to be made to fail to reach them, which is a
 * fixture's job, not a screenshot's.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/ticket-rail-shots.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const SHOT_DIR = "/tmp/vc108-shots";
const PAGES = ["now", "changes", "files"];

/**
 * This ticket's detail, with the rail on screen — from wherever a reload left us.
 *
 * Repeatable rather than inline because reaching a light appearance means a
 * reload, and the two reloads this smoke does land in different places: the
 * open ticket is persisted per workspace, so once one has been opened a reload
 * restores it and there is no board card left to double-click. Waiting for
 * whichever of the two actually came back is the only way to be right in both.
 */
async function openTicketRail(page, displayId) {
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );
  const rail = page.locator("aside");
  const railTab = page.getByTestId("ticket-rail-tab-now");
  const card = page.locator("article").filter({
    has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
  });
  const landing = await waitUntil("board card or restored detail", async () => {
    if ((await railTab.count()) === 1) return "detail";
    if ((await card.count()) === 1) return "board";
    return null;
  });
  if (landing === "board") {
    await card.dblclick();
    await waitUntil("detail", async () => (await page.getByRole("tablist").count()) >= 1);
  }
  await waitUntil("rail visible", async () => (await rail.count()) === 1);
  return rail;
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-rail-shots-");
const { attempt, summarize } = createRunner();

await fs.mkdir(SHOT_DIR, { recursive: true });

const projectDir = await makeGitRepo(scratch, "rail-proj-");
let app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("app surface", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  await seedProjects(page, [
    { id: "rail-proj", name: "Rail Shots", path: projectDir, prefix: "RS" },
  ]);

  const ticket = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(boot.error);
    const project = boot.data.projects[0];
    if (!project) throw new Error("no project");
    const created = await window.api.tickets.create({
      projectId: project.id,
      status: "todo",
      title: "Calm Stack rail visual proof",
      // Body refs feed the Files page's Referenced section, and one deliberately
      // long path proves the narrow-rail truncation in the shots below.
      body: "Read @docs/plan.md, @src/a-very-long-referenced-path-that-must-truncate.tsx, and @src/third.ts.",
      priority: "medium",
    });
    if (!created.ok) throw new Error(created.error);
    return { displayId: `${project.ticketPrefix}-${created.ticket.ticketNumber}` };
  });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const aside = await openTicketRail(page, ticket.displayId);

  await startTerminalSession(aside);
  await waitUntil(
    "session tab",
    async () => (await page.getByRole("tab", { name: "Session 1", exact: true }).count()) === 1,
  ).catch(() => null);

  for (const railPage of PAGES) {
    await attempt(railPage, `screenshot rail-${railPage}.png`, async () => {
      await aside.getByTestId(`ticket-rail-tab-${railPage}`).click();
      await waitUntil(`${railPage} selected`, async () => {
        return (
          (await aside.getByTestId(`ticket-rail-tab-${railPage}`).getAttribute("aria-selected")) ===
          "true"
        );
      });
      await page.waitForTimeout(300);
      const path = join(SHOT_DIR, `rail-${railPage}.png`);
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });
  }

  // The repository card only exists on Now, so the page shot above carries it
  // small. This one frames the element itself, where the branch pair's
  // truncation and the action row's balance are actually legible.
  await attempt("repository", "screenshot rail-repository-summary.png", async () => {
    await aside.getByTestId("ticket-rail-tab-now").click();
    const card = aside.getByTestId("ticket-repository-summary");
    await waitUntil("repository card visible", async () => (await card.count()) === 1);
    const path = join(SHOT_DIR, "rail-repository-summary.png");
    await card.screenshot({ path });
    const stat = await fs.stat(path);
    return { ok: stat.size > 1000, detail: path };
  });

  await attempt("live", "screenshot rail-live-session.png", async () => {
    const sessionTab = page.getByRole("tab", { name: "Session 1", exact: true });
    if ((await sessionTab.count()) === 1) await sessionTab.click();
    await aside.getByTestId("ticket-rail-tab-now").click();
    await page.waitForTimeout(400);
    const path = join(SHOT_DIR, "rail-live-session.png");
    await page.screenshot({ path, fullPage: false });
    const stat = await fs.stat(path);
    return { ok: stat.size > 1000, detail: path };
  });

  // Reduced motion is a live media query, so the rail follows it without a
  // reload. A picture cannot show an absent transition, though, so this reads
  // the tab's computed transition on both sides of the flip and only then
  // frames it: if the two agree, the `motion-reduce:` variants are not landing.
  // The tab is the right probe — its width transition IS the header's motion.
  await attempt("reduced-motion", "screenshot rail-reduced-motion.png", async () => {
    const tab = aside.getByTestId("ticket-rail-tab-changes");
    await waitUntil("tab present", async () => (await tab.count()) === 1);
    const readTransition = () =>
      tab.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.transitionProperty} ${style.transitionDuration}`;
      });
    const normal = await readTransition();
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      // Poll, do not snapshot. The rail drops its transition through
      // `useReducedMotion()`, which is a React hook over the media query — so
      // the class only leaves after a re-render, and reading the computed style
      // in the same tick as `emulateMedia` reads the OLD value every time. This
      // check failed on exactly that, and the 300ms it did wait was spent after
      // the read rather than before it, which is the same as not waiting.
      let reduced = normal;
      let flipped = await waitUntil("rail tab drops its transition", async () => {
        reduced = await readTransition();
        return reduced !== normal;
      }).catch(() => false);
      // If the query landed but nothing moved, force one re-render before
      // concluding. `useReducedMotion()` is a hook, so a preference toggled
      // AFTER mount only reaches the DOM when React renders again — and that
      // distinguishes "the rail ignores the preference", which is a real
      // accessibility defect, from "the hook does not re-subscribe live", which
      // is a much smaller one that never touches a user who had the setting on
      // before the app started.
      let neededRerender = false;
      if (flipped === false) {
        await aside.getByTestId("ticket-rail-tab-files").click();
        await aside.getByTestId("ticket-rail-tab-changes").click();
        flipped = await waitUntil("rail tab drops its transition after a render", async () => {
          reduced = await readTransition();
          return reduced !== normal;
        }).catch(() => false);
        neededRerender = flipped !== false;
      }
      // Report WHY, not just that. The rail reads the preference through
      // `useReducedMotion()`, so a stuck transition has two very different
      // causes: the page never saw the media query flip (emulation did not
      // reach this renderer, and the check is measuring the harness), or it saw
      // it and the component ignored it (a real accessibility regression).
      // Without this, the two are indistinguishable and the check is a puzzle.
      const sawQuery = await page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      const path = join(SHOT_DIR, "rail-reduced-motion.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return {
        ok: stat.size > 1000 && sawQuery && flipped !== false && reduced !== normal,
        detail:
          `${path} pageSawReduceQuery=${sawQuery} neededRerender=${neededRerender} ` +
          `normal=[${normal}] reduced=[${reduced}]` +
          (sawQuery ? "" : " — the renderer never saw the query; emulation did not reach it"),
      };
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
  });

  // Light is a durable appearance, not a media query. Nothing in the renderer
  // reads `prefers-color-scheme` — it stamps the mode class itself and
  // re-stamps it on every repaint — so a page-level emulation would say nothing
  // and a hand-set class would be painted over. Write the row Settings writes,
  // then boot into it, which is why the rail has to be walked to a second time.
  await attempt("light", "screenshot rail-light.png", async () => {
    const written = await page.evaluate(() => window.api.theme.setGlobalAppearance("light"));
    if (!written.ok) return { ok: false, detail: written.error };
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("light stamped", () =>
      page.evaluate(() => document.documentElement.classList.contains("light")),
    );
    const lightRail = await openTicketRail(page, ticket.displayId);
    await lightRail.getByTestId("ticket-rail-tab-now").click();
    await page.waitForTimeout(400);
    const path = join(SHOT_DIR, "rail-light.png");
    await page.screenshot({ path, fullPage: false });
    const stat = await fs.stat(path);
    return { ok: stat.size > 1000, detail: path };
  });
} finally {
  await app.close().catch(() => {});
  await cleanup();
}

process.exit(summarize());
