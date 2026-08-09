/**
 * Visual proof for the VC-108 icon-mode ticket rail.
 *
 * Covers the states the plan asks a shot to answer for: normal, narrow (the
 * icon-mode rail), long content (the deliberately untruncatable Sources path),
 * dark and light, and reduced motion. The failure and empty states are the two
 * it deliberately leaves alone — they are settled by
 * `ticket-environment-inspector.test.tsx`, where a fixture can produce them
 * exactly rather than by arranging for a real read to fail.
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
  waitUntil,
} from "./lib/smoke-kit.mjs";

const SHOT_DIR = "/tmp/vc108-shots";
const MODES = ["sessions", "files", "changes", "properties"];

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
  const railMode = page.getByTestId("ticket-rail-mode-sessions");
  const card = page.locator("article").filter({
    has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
  });
  const landing = await waitUntil("board card or restored detail", async () => {
    if ((await railMode.count()) === 1) return "detail";
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
      title: "Icon-mode rail visual proof",
      // Body refs are the Inspector's only Sources feed, and one deliberately
      // long path proves the narrow-rail truncation in the shots below.
      body: "Read @docs/plan.md, @src/a-very-long-inspector-reference-that-must-truncate.tsx, and @src/third.ts.",
      priority: "medium",
    });
    if (!created.ok) throw new Error(created.error);
    return { displayId: `${project.ticketPrefix}-${created.ticket.ticketNumber}` };
  });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const aside = await openTicketRail(page, ticket.displayId);

  await aside.getByRole("button", { name: "New terminal", exact: true }).click();
  await waitUntil(
    "session tab",
    async () => (await page.getByRole("tab", { name: "Session 1", exact: true }).count()) === 1,
  ).catch(() => null);

  for (const mode of MODES) {
    await attempt(mode, `screenshot rail-${mode}.png`, async () => {
      await aside.getByTestId(`ticket-rail-mode-${mode}`).click();
      await waitUntil(`${mode} pressed`, async () => {
        return (
          (await aside.getByTestId(`ticket-rail-mode-${mode}`).getAttribute("aria-pressed")) ===
          "true"
        );
      });
      await page.waitForTimeout(300);
      const path = join(SHOT_DIR, `rail-${mode}.png`);
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return { ok: stat.size > 1000, detail: path };
    });
  }

  // The Inspector is pinned above every mode, so the shots above already carry
  // it. This one frames the element itself, where truncation and the Sources
  // rows are actually legible.
  await attempt("inspector", "screenshot rail-environment-inspector.png", async () => {
    const inspector = aside.getByTestId("ticket-environment-inspector");
    await waitUntil("inspector visible", async () => (await inspector.count()) === 1);
    const path = join(SHOT_DIR, "rail-environment-inspector.png");
    await inspector.screenshot({ path });
    const stat = await fs.stat(path);
    return { ok: stat.size > 1000, detail: path };
  });

  await attempt("live", "screenshot rail-live-session.png", async () => {
    const sessionTab = page.getByRole("tab", { name: "Session 1", exact: true });
    if ((await sessionTab.count()) === 1) await sessionTab.click();
    await aside.getByTestId("ticket-rail-mode-sessions").click();
    await page.waitForTimeout(400);
    const path = join(SHOT_DIR, "rail-live-session.png");
    await page.screenshot({ path, fullPage: false });
    const stat = await fs.stat(path);
    return { ok: stat.size > 1000, detail: path };
  });

  // Reduced motion is a live media query, so the rail follows it without a
  // reload. A picture cannot show an absent transition, though, so this reads
  // the row's computed transition on both sides of the flip and only then
  // frames it: if the two agree, the `motion-reduce:` variants are not landing.
  await attempt("reduced-motion", "screenshot rail-reduced-motion.png", async () => {
    await aside.getByTestId("ticket-rail-mode-sessions").click();
    const source = aside.getByTestId("ticket-environment-source").first();
    await waitUntil(
      "source row",
      async () => (await aside.getByTestId("ticket-environment-source").count()) >= 1,
    );
    const readTransition = () =>
      source.evaluate((node) => {
        const style = getComputedStyle(node);
        return `${style.transitionProperty} ${style.transitionDuration}`;
      });
    const normal = await readTransition();
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      const reduced = await readTransition();
      await page.waitForTimeout(300);
      const path = join(SHOT_DIR, "rail-reduced-motion.png");
      await page.screenshot({ path, fullPage: false });
      const stat = await fs.stat(path);
      return {
        ok: stat.size > 1000 && reduced !== normal,
        detail: `${path} normal=[${normal}] reduced=[${reduced}]`,
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
    await lightRail.getByTestId("ticket-rail-mode-sessions").click();
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
