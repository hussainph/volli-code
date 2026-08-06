/**
 * Visual proof for the VC-108 icon-mode ticket rail.
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
      priority: "medium",
    });
    if (!created.ok) throw new Error(created.error);
    return { displayId: `${project.ticketPrefix}-${created.ticket.ticketNumber}` };
  });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  const card = page.locator("article").filter({
    has: page.locator("span.font-mono", { hasText: new RegExp(`^${ticket.displayId}$`) }),
  });
  await waitUntil("card", async () => (await card.count()) === 1);
  await card.dblclick();
  await waitUntil("detail", async () => (await page.getByRole("tablist").count()) >= 1);

  const aside = page.locator("aside");
  await waitUntil("rail visible", async () => (await aside.count()) === 1);

  // "New session" is a menu since the chat surface landed (PR #179):
  // Terminal / Chat. These shots want the terminal kind.
  await aside.getByRole("button", { name: "New session" }).click();
  await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
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
} finally {
  await app.close().catch(() => {});
  await cleanup();
}

process.exit(summarize());
